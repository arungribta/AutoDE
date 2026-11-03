import * as path from 'node:path';
import { EngineTool, ToolAnnotations } from './tools';
import { EngineToolError } from './errors';
import { explore } from './exploreTools';
import { PortError } from '../engine/skills/port';
import { ProposalValidationError } from '../engine/decisions/proposals';
import { OntologySource, shippedSources } from '../engine/ontology/onboard';
import { Choices, OntologyProposalError, WorkspaceGraph, alignmentCandidates, analyzeOntologySource, previewPack, proposeAlignment, proposeOntologyPack } from '../engine/ontology/service';
import { MATCH_TYPES, MatchType } from '../engine/ontology/pack';
import { findConcept, loadOntology } from '../engine/ontology/store';

/**
 * The ontology over MCP (ONT1; docs/specs/context-layer.md §6.8, §9): the same steps as the Knowledge Explorer
 * and `autode ontology`. Reading and analysing are read-only; a pack is imported only as a proposal a person
 * approves, and term and *represents* links are proposed facts a person confirms in the Context Inbox. An agent
 * onboards from a shipped pack or a file in the workspace; a Git source is staged by a person (CLI or VS Code).
 */

const read = (title: string): ToolAnnotations => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const propose = (title: string): ToolAnnotations => ({ title, readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const strings = { type: 'array', items: { type: 'string', minLength: 1 } };
const SOURCE = { type: 'object', additionalProperties: false, properties: { shipped: { type: 'string', description: 'A shipped pack (autode_ontology lists them), e.g. fibo-lending.' }, file: { type: 'string', description: 'A file or folder in the workspace: OWL or SKOS in Turtle or RDF/XML, or an AutoDE pack.' } } };
const CHOICES = {
  add: { ...strings, description: 'Concept ids to add to the proposed scope.' },
  remove: { ...strings, description: 'Concept ids to leave out.' },
  only: { ...strings, description: 'Exactly these concepts (and the ancestors they need), instead of the proposed scope.' },
  place: { type: 'object', additionalProperties: { type: 'string' }, description: 'Where an unplaced concept goes: { "<concept id>": "upper:Party" | "upper:Agreement" | … }.' },
  prefix: { type: 'string', pattern: '^[a-z][a-z0-9]*$', description: 'The prefix of the pack\'s concept ids (a file source; default from the standard).' },
  pack: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$', description: 'The pack id (a file source; default from its title).' }
};

function sourceOf(args: Record<string, unknown>, workspaceRoot: string, resourcesRoot?: string): OntologySource {
  const s = (args.source ?? {}) as { shipped?: string; file?: string };
  if (s.shipped) {
    if (!shippedSources(resourcesRoot).some((x) => x.id === s.shipped)) throw new EngineToolError('NOT_FOUND', `No shipped pack "${s.shipped}" (${shippedSources(resourcesRoot).map((x) => x.id).join(', ')}).`);
    return { kind: 'shipped', id: s.shipped };
  }
  if (s.file) {
    const full = path.resolve(workspaceRoot, s.file);
    if (!full.startsWith(path.resolve(workspaceRoot) + path.sep)) throw new EngineToolError('PERMISSION_DENIED', 'A file source is in the workspace; a person onboards anything else (autode ontology analyze, or the Knowledge Explorer).');
    return { kind: 'file', path: full };
  }
  throw new EngineToolError('VALIDATION_FAILED', 'Give source.shipped (a pack AutoDE ships) or source.file (a file or folder in the workspace).');
}

const choicesOf = (args: Record<string, unknown>): Choices => ({ ...(args.add ? { add: args.add as string[] } : {}), ...(args.remove ? { remove: args.remove as string[] } : {}), ...(args.only ? { only: args.only as string[] } : {}), ...(args.place ? { place: args.place as Record<string, string> } : {}) });
const optsOf = (args: Record<string, unknown>) => ({ ...(args.prefix ? { prefix: String(args.prefix) } : {}), ...(args.pack ? { id: String(args.pack) } : {}) });
const asToolError = (err: unknown): never => {
  if (err instanceof EngineToolError) throw err;
  if (err instanceof PortError || err instanceof OntologyProposalError) throw new EngineToolError('VALIDATION_FAILED', err.message);
  if (err instanceof ProposalValidationError) throw new EngineToolError('VALIDATION_FAILED', `The pack doesn't pass its checks: ${err.report.errors.join(' ')}`, { errors: err.report.errors });
  throw err;
};

export function ontologyTools(clientName: () => string | undefined): EngineTool[] {
  return [
    {
      name: 'autode_ontology',
      description: 'The ontology AutoDE uses for meaning: the packs (the upper layer of eight concepts — Party, Agreement, Product, Account, Transaction, Location, Event, Document — and the team\'s onboarded standards and extensions, each with its state and licence), the concepts in effect as a tree with how many terms and tables reach each, the glossary with each term\'s scope (enterprise, line of business, system, problem) and the concepts it means, and the shipped standards to onboard from.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: read('The ontology and glossary'),
      handler: async (_args, ws) => ({ ...(await explore(ws, { type: 'ontology' })).ontology as Record<string, unknown>, shipped: shippedSources(ws.options.resourcesRoot) })
    },
    {
      name: 'autode_get_concept_context',
      description: 'A concept\'s page (by id like fibo:Loan, label or synonym): its definition, source IRI and standard, where it sits under the upper layer, relations and attributes; the terms that mean it, most specific scope first; the tables that represent it and the columns bound to it through terms, per system; the logical tables and metrics that implement it; the facts about all of these, the rules that apply, knowledge articles about it, conflicts (a represents link its key columns disagree with) and gaps; and links waiting in the Context Inbox. Use it to explain what a concept is in this estate, with evidence.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['concept'], properties: { concept: { type: 'string', minLength: 1 } } },
      annotations: read('Read a concept\'s context'),
      handler: async (args, ws) => {
        const r = await explore(ws, { type: 'concept', id: String(args.concept) });
        if (!r.context) throw new EngineToolError('NOT_FOUND', String(r.error));
        return r.context as Record<string, unknown>;
      }
    },
    {
      name: 'autode_ontology_analyze',
      description: 'Onboarding a standard, steps 1–4, read-only: read a source (a shipped pack, or an OWL/SKOS file or folder in the workspace in Turtle or RDF/XML), and get its concepts, relations, modules, version and licence (a licence that doesn\'t allow redistribution keeps the pack in this workspace); the scope AutoDE proposes from this workspace\'s glossary, tables and columns (seed concepts, one hop out, and the ancestors they need); and where each unplaced concept goes under the upper layer. Adjust with add, remove, only and place, then call it again; with preview: true it also returns the pack those choices give. Propose it with autode_propose_ontology_pack.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['source'], properties: { source: SOURCE, ...CHOICES, preview: { type: 'boolean' } } },
      annotations: read('Analyse a standard to onboard'),
      handler: async (args, ws) => {
        try {
          const scope = { workspaceRoot: ws.options.workspaceRoot, resourcesRoot: ws.options.resourcesRoot };
          const src = sourceOf(args, scope.workspaceRoot, scope.resourcesRoot);
          const graph = (await ws.contextSources()).graph as WorkspaceGraph;
          const { analysis } = analyzeOntologySource(scope, src, graph, choicesOf(args), optsOf(args));
          if (!args.preview) return { analysis };
          const p = previewPack(scope, src, graph, choicesOf(args), optsOf(args));
          return { analysis, preview: { text: p.text, added: p.added, kept: p.kept, problems: p.problems, revision: p.revision } };
        } catch (err) { return asToolError(err); }
      }
    },
    {
      name: 'autode_propose_ontology_pack',
      description: 'Onboarding a standard, step 5: propose the pack the source and choices give (as autode_ontology_analyze shows it) as a workspace-level decision. Every business problem shares the ontology, so a person approves it (the AutoDE panel, autode decisions approve); approved, it is written to .autode/knowledge/ontology/ and its concepts are in effect. A pack the team already has grows: its concepts are kept, the new ones added. Then align the vocabulary (autode_ontology_align).',
      inputSchema: { type: 'object', additionalProperties: false, required: ['source', 'reason'], properties: { source: SOURCE, ...CHOICES, reason: { type: 'string', minLength: 10, description: 'Why: the business problem or the gap it serves.' } } },
      annotations: propose('Propose an ontology pack'),
      handler: async (args, ws) => {
        try {
          const scope = { workspaceRoot: ws.options.workspaceRoot, resourcesRoot: ws.options.resourcesRoot };
          const graph = (await ws.contextSources()).graph as WorkspaceGraph;
          const { decision, built } = proposeOntologyPack(scope, sourceOf(args, scope.workspaceRoot, scope.resourcesRoot), graph, choicesOf(args), { host: 'mcp', client: clientName() }, { ...optsOf(args), reason: String(args.reason) });
          return { decision: { id: decision.id, status: decision.status, title: decision.title, stakes: decision.stakes }, added: built.added, next: `A person approves it: in the AutoDE panel (Decisions), or autode decisions approve ${decision.id}. Tell the user.` };
        } catch (err) { return asToolError(err); }
      }
    },
    {
      name: 'autode_ontology_align',
      description: 'Aligning the vocabulary, read-only: for the concepts in effect, the glossary terms that mean one (exact: the term is a name of the concept; broader: the term says more, the concept is broader; related: the term is an attribute of it) and the tables whose name is a concept\'s name (represents). Deterministic, from names, synonyms and the customer\'s vocabulary; judge each before proposing it with autode_propose_concept_links. Links already known (confirmed or waiting) are left out.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: read('Align terms and tables to concepts'),
      handler: async (_args, ws) => {
        const src = await ws.contextSources();
        return alignmentCandidates({ workspaceRoot: ws.options.workspaceRoot, resourcesRoot: ws.options.resourcesRoot }, src.graph as WorkspaceGraph, src.assertions) as unknown as Record<string, unknown>;
      }
    },
    {
      name: 'autode_propose_concept_links',
      description: 'Propose meaning links as facts for the Context Inbox (a person confirms each; nothing uses them until then): a glossary term means a concept (with match exact, broader, narrower or related, as SKOS names them: broader means the concept is broader than the term), or a table or logical table represents a concept (the entity-level link estate merge uses to find the same entity across systems). Columns reach concepts through the terms bound to them, never directly. Give your reason: it is the link\'s evidence.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['links'], properties: { links: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['subject', 'concept', 'reason'], properties: { subject: { type: 'string', minLength: 1, description: 'A glossary term or a table / logical table (id, name or fqn).' }, concept: { type: 'string', minLength: 1 }, match: { enum: [...MATCH_TYPES] }, reason: { type: 'string', minLength: 5 } } } } } },
      annotations: propose('Propose concept links'),
      handler: async (args, ws) => {
        const scope = { workspaceRoot: ws.options.workspaceRoot, resourcesRoot: ws.options.resourcesRoot };
        const ontology = loadOntology(scope);
        const means: Array<{ term: string; label: string; concept: string; conceptLabel: string; match: MatchType; reason: string }> = [];
        const represents: Array<{ table: string; label: string; concept: string; conceptLabel: string; reason: string }> = [];
        const problems: string[] = [];
        for (const [i, l] of (args.links as Array<{ subject: string; concept: string; match?: MatchType; reason: string }>).entries()) {
          const c = findConcept(ontology, l.concept);
          if (!c) { problems.push(`links[${i}]: no concept "${l.concept}" in effect (autode_ontology).`); continue; }
          const a = (await explore(ws, { type: 'asset', id: l.subject })).context as { asset: { id: string; label: string; fqn?: string; assetType: string } } | undefined;
          if (!a) { problems.push(`links[${i}]: no term or table "${l.subject}" (autode_search_assets).`); continue; }
          if (a.asset.assetType === 'glossary_term') means.push({ term: a.asset.id, label: a.asset.label, concept: c.id, conceptLabel: c.label, match: l.match ?? 'exact', reason: l.reason });
          else if (['table', 'view', 'logical_table'].includes(a.asset.assetType)) represents.push({ table: a.asset.id, label: a.asset.fqn ?? a.asset.label, concept: c.id, conceptLabel: c.label, reason: l.reason });
          else problems.push(`links[${i}]: ${a.asset.label} is a ${a.asset.assetType}; a term means a concept, a table or logical table represents one (a column reaches one through its terms).`);
        }
        if (problems.length) throw new EngineToolError('VALIDATION_FAILED', problems.join(' '), { problems });
        const r = await proposeAlignment(scope, { means, represents }, `mcp:${clientName() ?? 'client'}`, ws.activeProblemId());
        return { proposed: r.recorded.map((a) => ({ id: a.id, statement: a.statement, status: a.status })), duplicates: r.duplicates, next: 'A person confirms them in the AutoDE Context Inbox. Tell the user.' };
      }
    }
  ];
}
