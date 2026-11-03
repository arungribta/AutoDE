import * as fs from 'node:fs';
import * as path from 'node:path';
import { AssertionLedger } from '../context/ledger';
import { Assertion } from '../context/assertions';
import { recordChatProposals } from '../context/chatExtraction';
import { BaseNode, GraphEdge, TableNode } from '../context/types';
import { buildVocabulary, parseVocabularyFile } from '../context/vocabulary';
import { Decision, DecisionStore, Proposer } from '../decisions/decisionStore';
import { propose } from '../decisions/proposals';
import { layoutPath } from '../workspaceLayout';
import { OntologyPayload } from './decision';
import { meaningLinks } from './links';
import { BuiltPack, OntologySource, PlacementRow, ReadSource, ScopeResult, TermCandidate, RepresentsCandidate, alignTerms, buildPack, meaningProposals, placementOf, proposeScope, readSource, representsCandidates, seedConcepts, workspaceSignals } from './onboard';
import { packRevision, stringifyPack } from './pack';
import { OntologyScope, loadOntology, readTeamPack } from './store';

/**
 * The onboarding and alignment steps as one service (ONT1; docs/specs/context-layer.md §6.8), behind the
 * Knowledge Explorer, `autode ontology` and the MCP tools, so every surface does the same thing. Analysis is
 * read-only; importing a pack is a decision a person approves; term and *represents* links are proposed facts a
 * person confirms in the Context Inbox.
 */

export interface WorkspaceGraph { nodes: readonly BaseNode[]; edges: readonly GraphEdge[] }

function vocabularyOf(workspaceRoot: string) {
  let text: string | undefined;
  try { text = fs.readFileSync(layoutPath(workspaceRoot, 'vocabulary'), 'utf8'); } catch { text = undefined; }
  return buildVocabulary(parseVocabularyFile(text));
}

export interface Analysis {
  source: { id: string; title: string; kind: string; ref: string; commit?: string; checksum?: string };
  standard?: { name: string; version: string; iri?: string };
  licence: { name: string; spdx?: string; redistribution: string; note?: string };
  /** `workspace`: the pack will stay in this workspace (its licence doesn't allow redistribution). */
  distribution: 'shareable' | 'workspace';
  counts: { concepts: number; relations: number; modules: number; deprecated: number };
  modules: Array<{ module: string; concepts: number }>;
  warnings: string[];
  /** Step 3: the proposed scope, from the workspace's glossary, tables and columns. */
  scope: ScopeResult;
  /** Step 4: where each chosen concept the source leaves unplaced goes. */
  placement: PlacementRow[];
  /** Every concept of the source (id, label, parent), to adjust the scope with. */
  concepts: Array<{ id: string; label: string; parent?: string; suggestedPlacement?: string; status?: string }>;
  /** The team pack this would grow, if there is one. */
  existing?: { file: string; state: string; concepts: number };
}

export interface Choices { add?: string[]; remove?: string[]; place?: Record<string, string>; only?: string[] }

function chosenIds(read: ReadSource, graph: WorkspaceGraph | undefined, workspaceRoot: string, c: Choices): ScopeResult {
  if (c.only?.length) return proposeScope(read.analysis, [], { add: c.only });
  const seeds = graph ? seedConcepts(read.analysis.concepts, workspaceSignals(graph), vocabularyOf(workspaceRoot)) : [];
  return proposeScope(read.analysis, seeds, { ...(c.add ? { add: c.add } : {}), ...(c.remove ? { remove: c.remove } : {}) });
}

/** Steps 1–4, read-only: what the source holds and what AutoDE proposes to take from it. */
export function analyzeOntologySource(scope: OntologyScope, src: OntologySource, graph: WorkspaceGraph | undefined, choices: Choices = {}, opts: { prefix?: string; id?: string } = {}): { analysis: Analysis; read: ReadSource } {
  const read = readSource(scope, src, opts);
  const sel = chosenIds(read, graph, scope.workspaceRoot, choices);
  const existing = readTeamPack(scope.workspaceRoot, read.id);
  const a = read.analysis;
  return {
    read,
    analysis: {
      source: { id: read.id, title: read.title, kind: read.source.kind, ref: read.source.ref, ...(read.source.commit ? { commit: read.source.commit } : {}), ...(read.source.checksum ? { checksum: read.source.checksum } : {}) },
      ...(read.standard ? { standard: { name: read.standard.name, version: read.standard.version, ...(read.standard.iri ? { iri: read.standard.iri } : {}) } } : {}),
      licence: a.licence, distribution: a.licence.redistribution === 'allowed' ? 'shareable' : 'workspace',
      counts: { concepts: a.concepts.length, relations: a.relations, modules: a.modules.length, deprecated: a.concepts.filter((c) => c.status === 'deprecated').length },
      modules: a.modules, warnings: a.warnings, scope: sel, placement: placementOf(read, [...sel.selected, ...sel.required], choices.place),
      concepts: a.concepts.map((c) => ({ id: c.id, label: c.label, ...(c.parent ? { parent: c.parent } : {}), ...(c.suggestedPlacement ? { suggestedPlacement: c.suggestedPlacement } : {}), ...(c.status ? { status: c.status } : {}) })),
      ...(existing ? { existing: { file: existing.file, state: existing.state, concepts: existing.pack?.concepts.length ?? 0 } } : {})
    }
  };
}

export class OntologyProposalError extends Error {
  public constructor(public readonly problems: string[]) { super(`The pack can't be proposed: ${problems.join(' ')}`); this.name = 'OntologyProposalError'; }
}

/** The pack the choices give (step 4), without proposing it: what a reviewer would see. */
export function previewPack(scope: OntologyScope, src: OntologySource, graph: WorkspaceGraph | undefined, choices: Choices = {}, opts: { prefix?: string; id?: string } = {}): BuiltPack & { revision: string } {
  const { read, analysis } = analyzeOntologySource(scope, src, graph, choices, opts);
  const built = buildPack(scope, read, [...analysis.scope.selected], choices.place);
  return { ...built, revision: packRevision(built.pack) };
}

/** Step 5: proposes the pack as a workspace-level decision. Nothing is written until a person approves it. */
export function proposeOntologyPack(scope: OntologyScope, src: OntologySource, graph: WorkspaceGraph | undefined, choices: Choices, proposer: Proposer, opts: { prefix?: string; id?: string; reason?: string } = {}): { decision: Decision; built: BuiltPack } {
  const built = previewPack(scope, src, graph, choices, opts);
  if (built.problems.length) throw new OntologyProposalError(built.problems);
  if (!built.added.length) throw new OntologyProposalError([`Nothing to add: the team pack ${built.pack.id} already has every chosen concept. Add concepts (--add) or choose others.`]);
  const payload: OntologyPayload = { id: built.pack.id, content: built.text, added: built.added, ...(opts.reason ? { reason: opts.reason } : {}) };
  const store = new DecisionStore(scope.workspaceRoot);
  // An earlier pending proposal for the same pack is superseded: the reviewer sees one.
  for (const d of store.list({ status: 'pending', kind: 'ontology' })) if (store.proposal<OntologyPayload>(d.id)?.id === payload.id) store.markSuperseded(d.id, 'A newer proposal of the same pack replaces it.');
  const decision = propose(store, { workspaceRoot: scope.workspaceRoot, resourcesRoot: scope.resourcesRoot }, 'ontology', payload, { proposedBy: proposer });
  return { decision, built };
}

export interface Alignment { means: TermCandidate[]; represents: RepresentsCandidate[]; terms: number; tables: number; concepts: number }

/** Step 4, for the ontology in effect: `means` links for the glossary and *represents* links for tables. Read-only. */
export function alignmentCandidates(scope: OntologyScope, graph: WorkspaceGraph, assertions: readonly Assertion[]): Alignment {
  const o = loadOntology(scope);
  const concepts = [...o.concepts.values()];
  const vocab = vocabularyOf(scope.workspaceRoot);
  const existing = meaningLinks(assertions, { includeProposed: true });
  const terms = graph.nodes.filter((n) => n.type === 'business_term').map((n) => ({ id: n.id, label: n.label }));
  const tables = graph.nodes.filter((n): n is TableNode => n.type === 'table');
  return { means: alignTerms(terms, concepts, vocab, existing), represents: representsCandidates(tables, concepts, vocab, existing), terms: terms.length, tables: tables.length, concepts: concepts.length };
}

/** Records the chosen candidates as proposed facts (the Context Inbox; a person confirms each). */
export async function proposeAlignment(scope: OntologyScope, chosen: { means?: readonly TermCandidate[]; represents?: readonly RepresentsCandidate[] }, by: string, specId?: string): Promise<{ recorded: Assertion[]; duplicates: string[] }> {
  const proposed = meaningProposals({ ...chosen, by, evidenceRef: 'ontology:alignment', ...(specId ? { specId } : {}) });
  if (!proposed.length) return { recorded: [], duplicates: [] };
  const ledger = new AssertionLedger(layoutPath(scope.workspaceRoot, 'ledger'));
  await ledger.load();
  const outcome = { proposed, dropped: [] as string[], duplicates: [] as string[] };
  const { recorded } = await recordChatProposals(ledger, outcome);
  return { recorded, duplicates: outcome.duplicates };
}

/**
 * Writes a team pack to a file for another workspace. Refused for a pack whose standard's licence doesn't allow
 * redistribution: it stays in this workspace (§6.8).
 */
export function exportPack(scope: OntologyScope, id: string, out: string): { file: string } {
  const l = readTeamPack(scope.workspaceRoot, id);
  if (!l?.pack) throw new OntologyProposalError([l ? `${l.file}: ${l.errors.join('; ')}` : `No team pack "${id}".`]);
  if (l.pack.distribution === 'workspace') throw new OntologyProposalError([`${id} stays in this workspace: its standard's licence (${l.pack.standard?.licence.name ?? 'not stated'}) doesn't allow redistribution. Each workspace onboards it from its own copy.`]);
  if (l.state !== 'approved') throw new OntologyProposalError([`${id} is ${l.state}: approve it before sharing it.`]);
  const rest = { ...l.pack };
  delete rest.approved;
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, stringifyPack({ ...rest, source: { kind: 'file', ref: `${id}.yaml`, checksum: packRevision(l.pack) } }));
  return { file: out };
}
