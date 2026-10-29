import { stageSkills } from '../skills/port';
import { BusinessProblemSpec, EntityMapping } from '../types';
import { PipelineSpec } from '../pipelineSpec/types';
import { validatePipelineSpec } from '../pipelineSpec/validator';
import { NewAssertion, AssertionLedger } from '../context/ledger';
import { validateAssertion } from '../context/assertionSchemas';
import { Evidence } from '../context/assertions';
import { computeRevision } from '../context/contextStore';
import { SchemaIndex } from '../grounding/sqlGrounding';
import { Runbook, RunbookRecord, approveRunbook, checkRunbook } from '../runner/runbook';
import { loadRunbookPolicy } from '../runner/policy';
import { loadConnectionsConfig } from '../platform/connectionsConfig';
import { ConnectionDraft, ConnectionEntry, saveConnection, validateConnectionDraft } from '../platform/connectionsConfig';
import { credentialNeeds, draftEntry } from '../platform/connectionSetup';
import { VocabularyProposal, mergeVocabularyFile } from '../context/vocabulary';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { WorkflowInstance, checkWorkflow, diffWorkflow, readWorkflow, writeWorkflow } from '../workflows/instance';
import { appendEvent } from '../workflows/events';
import { loadTemplates } from '../workflows/templates';

export interface VocabularyProposalPayload { entries: Array<Pick<VocabularyProposal, 'kind' | 'from' | 'to'>> }

/** A semantic model change (C5a): the whole file, shared (`<artifactDirectory>/semantic/<name>.yaml`) or a composite of the active problem. */
export interface SemanticModelPayload { scope: 'shared' | 'composite'; name: string; content: string }
/** A knowledge article an agent proposes (MM1): the whole article; the slug names its file. */
export interface ArticlePayload { slug: string; title: string; about: string[]; cites: string[]; body: string; domain?: string; tags?: string[] }
import { ArticleFile, articleRevision, approveArticle, checkArticle, readArticle, writeArticle } from '../knowledge/articles';
import { parseSemanticModel, semanticRevision } from '../semantic/model';
import { parseComposite, resolveComposite } from '../semantic/composite';
import { readComposite, readShared, resolveCompositeFile, semanticPaths, sharedLoader, writeShared } from '../semantic/store';
import { layoutPath } from '../workspaceLayout';
import {
  ProblemDocumentKind, parseBusinessProblemSpec, parsePipelineSpecDocument, readProblemDocument,
  writeBusinessProblemSpec, writeMappingUpsert, writePipelineSpec
} from '../documents/problemDocuments';
import { Decision, DecisionError, DecisionKind, DecisionStore, Proposer, ValidationReport } from './decisionStore';

/**
 * Proposals (docs/specs/mcp-engine.md §9.2 Phase PA1): validate what
 * an agent wants to change, turn it into a decision, and — only once a person
 * approved it — apply it with deterministic code. Shared by the MCP server's
 * proposal tools, the extension and (PA2) the CLI.
 */

/** What can be proposed. `mapping` and `platform_change` decisions were retired in v0.45.8 (SIMP-2): mappings are drafted into the mapping document, platform changes are runbooks; their old decision files still read. */
export type ProposalKind = Extract<DecisionKind, 'assertion' | 'spec_revision' | 'pipeline_spec' | 'connection' | 'vocabulary' | 'workflow' | 'runbook' | 'semantic_model' | 'article'>;

export interface ProposalContext {
  workspaceRoot: string;
  /** The active business problem's folder; needed by every kind but `assertion`. */
  problemRoot?: string;
  problemId?: string;
  /** The estate AutoDE knows, for grounding mapping proposals. */
  schemaIndex?: SchemaIndex;
  /** The connections a platform change may target. */
  connections?: readonly ConnectionEntry[];
  /** Where the bundled workflow templates live (the extension's or the package's root); for workflow proposals. */
  resourcesRoot?: string;
}

export type AssertionProposal = Pick<NewAssertion, 'kind' | 'subject' | 'predicate' | 'value' | 'statement' | 'evidence'> & { specId?: string };

export class ProposalValidationError extends Error {
  public constructor(public readonly report: ValidationReport) {
    super(`The proposal did not pass validation: ${report.errors.join('; ')}`);
    this.name = 'ProposalValidationError';
  }
}

function report(): ValidationReport { return { ok: true, errors: [], warnings: [], checks: [] }; }
function finish(r: ValidationReport): ValidationReport { r.ok = r.errors.length === 0; return r; }

const DOCUMENT_OF: Partial<Record<DecisionKind, ProblemDocumentKind>> = { spec_revision: 'spec', pipeline_spec: 'pipelineSpec', mapping: 'mappingContext' };

function needProblem(ctx: ProposalContext, r: ValidationReport): string | undefined {
  if (!ctx.problemRoot) r.errors.push('There is no active business problem in this workspace; open or start one in AutoDE first.');
  return ctx.problemRoot;
}

// ── Validation ───────────────────────────────────────────────────────────────

export function validateAssertionProposal(p: AssertionProposal): ValidationReport {
  const r = report();
  r.checks.push('assertion schema (kind, subject, predicate, value, statement, evidence)');
  r.errors.push(...validateAssertion(p as Parameters<typeof validateAssertion>[0]));
  return finish(r);
}

export function validateSpecRevision(spec: BusinessProblemSpec, ctx: ProposalContext): ValidationReport {
  const r = report();
  const root = needProblem(ctx, r);
  r.checks.push('required fields', 'list fields are lists of text', 'same specification id as the current one');
  if (!spec || typeof spec !== 'object') { r.errors.push('spec must be an object.'); return finish(r); }
  if (typeof spec.problemStatement !== 'string' || !spec.problemStatement.trim()) r.errors.push('problemStatement is required.');
  for (const key of ['objectives', 'successCriteria', 'constraints', 'assumptions'] as const) {
    const v = spec[key];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))) r.errors.push(`${key} must be a list of text.`);
  }
  if (!spec.objectives || spec.objectives.length === 0) r.errors.push('objectives must name at least one objective.');
  const scope = spec.scope as BusinessProblemSpec['scope'] | undefined;
  if (!scope || !Array.isArray(scope.in) || !Array.isArray(scope.out)) r.errors.push('scope needs in and out lists.');
  const currentText = root ? readProblemDocument(root, 'spec') : undefined;
  if (currentText !== undefined) {
    const current = parseBusinessProblemSpec(currentText);
    if (spec.id && spec.id !== current.id) r.errors.push(`spec.id "${spec.id}" is not the active specification "${current.id}".`);
  }
  return finish(r);
}

export function validatePipelineSpecProposal(spec: PipelineSpec, ctx: ProposalContext): ValidationReport {
  const r = report();
  needProblem(ctx, r);
  r.checks.push('Pipeline Spec schema and cross-references');
  const v = validatePipelineSpec(spec);
  if (!v.valid) r.errors.push(...v.errors);
  return finish(r);
}

function findTable(index: SchemaIndex, ref: string): { table?: SchemaIndex['tables'][number]; ambiguous?: boolean } {
  const lower = ref.toLowerCase();
  const exact = index.tables.filter((t) => t.fqn.toLowerCase() === lower);
  if (exact.length === 1) return { table: exact[0] };
  const byName = index.byName.get(lower.split('.').pop() ?? lower) ?? [];
  if (byName.length === 1) return { table: byName[0] };
  return { ambiguous: byName.length > 1 };
}

export function validateMappingProposal(m: EntityMapping, ctx: ProposalContext): ValidationReport {
  const r = report();
  needProblem(ctx, r);
  r.checks.push('required fields', 'no target column mapped twice', 'source table and columns exist in the estate', 'target columns exist when the target table is known');
  if (!m || typeof m !== 'object') { r.errors.push('mapping must be an object.'); return finish(r); }
  for (const key of ['id', 'sourceEntityId', 'targetName'] as const) if (typeof m[key] !== 'string' || !m[key]) r.errors.push(`${key} is required.`);
  if (!Array.isArray(m.columns) || m.columns.length === 0) { r.errors.push('columns must list at least one column mapping.'); return finish(r); }
  const seen = new Set<string>();
  for (const c of m.columns) {
    if (!c || typeof c.sourceColumn !== 'string' || !c.sourceColumn || typeof c.targetColumn !== 'string' || !c.targetColumn) { r.errors.push('each column needs sourceColumn and targetColumn.'); continue; }
    const t = c.targetColumn.toLowerCase();
    if (seen.has(t)) r.errors.push(`target column ${c.targetColumn} is mapped twice.`);
    seen.add(t);
  }
  const index = ctx.schemaIndex;
  if (!index || index.tables.length === 0) {
    r.warnings.push('AutoDE knows no tables yet (run Source Assessment or import a dictionary), so columns were not checked against the estate.');
    return finish(r);
  }
  const sourceRef = m.sourceFqn || m.sourceEntityId;
  const source = findTable(index, sourceRef);
  if (!source.table) r.errors.push(source.ambiguous ? `source table ${sourceRef} is ambiguous: give its fully qualified name.` : `source table ${sourceRef} is not in the estate AutoDE knows.`);
  else for (const c of m.columns) {
    if (c.sourceColumn && !source.table.columns.has(c.sourceColumn.toLowerCase()) && !c.transformExpression) r.errors.push(`source column ${source.table.fqn}.${c.sourceColumn} does not exist.`);
  }
  const target = findTable(index, m.targetName);
  if (target.table) {
    for (const c of m.columns) if (c.targetColumn && !target.table.columns.has(c.targetColumn.toLowerCase())) r.errors.push(`target column ${target.table.fqn}.${c.targetColumn} does not exist.`);
  } else {
    r.warnings.push(`target ${m.targetName} is not in the estate (a planned table?): its columns were not checked.`);
  }
  return finish(r);
}

/**
 * A connection (v0.43.1): the same checks as saving one from a settings card or
 * `autode connections add`. Which platforms agents may reach is a person's call,
 * so it is high stakes; it is tested once it is saved, not here.
 */
export function validateConnectionProposal(p: ConnectionDraft, ctx: ProposalContext): ValidationReport {
  const r = report();
  r.checks.push('supported platform and role', 'no secret in the files', 'known fields and credential source');
  if (!p || typeof p !== 'object') { r.errors.push('connection must be an object.'); return finish(r); }
  r.errors.push(...validateConnectionDraft({ ...p, fields: p.fields ?? {} }));
  if (r.errors.length) return finish(r);
  const entry = draftEntry({ ...p, fields: p.fields ?? {} });
  if ((ctx.connections ?? []).some((c) => c.id.toLowerCase() === entry.id.toLowerCase())) r.warnings.push(`${entry.id} exists: approving changes its settings.`);
  r.warnings.push(credentialNeeds(entry).summary);
  if (p.allowSampleDataInPrompts) r.warnings.push('It lets row values from this connection reach language models (allowSampleDataInPrompts).');
  return finish(r);
}

/** Vocabulary (v0.43.3): single words only, since retrieval matches words; low stakes. */
export function validateVocabularyProposal(p: VocabularyProposalPayload): ValidationReport {
  const r = report();
  r.checks.push('abbreviation or synonym', 'single words');
  if (!p || !Array.isArray(p.entries) || p.entries.length === 0) { r.errors.push('entries must list at least one abbreviation or synonym.'); return finish(r); }
  p.entries.forEach((e, i) => {
    if (e.kind !== 'abbreviation' && e.kind !== 'synonym') r.errors.push(`entries[${i}].kind must be abbreviation or synonym.`);
    for (const k of ['from', 'to'] as const) {
      const v = String(e[k] ?? '').trim();
      if (!v) r.errors.push(`entries[${i}].${k} is required.`);
      else if (e.kind === 'synonym' && /\s/.test(v)) r.errors.push(`entries[${i}].${k}: synonyms are single words (retrieval matches words).`);
    }
  });
  return finish(r);
}

/** A workflow (PA3a): the template's rules, item by item; the diff against the template is the reviewer's summary. */
export function validateWorkflowProposal(w: WorkflowInstance, ctx: ProposalContext): ValidationReport {
  const r = report();
  r.checks.push('mandatory stages and gates kept', 'reasons for stages left out or added', 'roles and tiers allowed by each stage kind', 'briefs carry context only, and skills fit their stage', 'dependencies known and acyclic', 'every consumed artifact has a producer');
  needProblem(ctx, r);
  if (!w || typeof w !== 'object' || !Array.isArray(w.stages)) { r.errors.push('workflow must be a workflow instance with stages.'); return finish(r); }
  if (ctx.problemId && w.problemId !== ctx.problemId) r.errors.push(`The workflow is for problem ${w.problemId}, not the active ${ctx.problemId}.`);
  const { templates, errors } = loadTemplates(ctx.resourcesRoot ?? ctx.workspaceRoot, ctx.workspaceRoot);
  r.warnings.push(...errors);
  const template = templates.find((t) => t.id === w.template?.id);
  if (!template) { r.errors.push(`No workflow template "${w.template?.id}" (known: ${templates.map((t) => t.id).join(', ') || 'none'}).`); return finish(r); }
  const skills = ctx.resourcesRoot ? stageSkills(ctx.resourcesRoot, ctx.workspaceRoot).map((k) => ({ id: k.id, stageKinds: k.meta.stageKinds })) : undefined;
  const c = checkWorkflow(w, template, { skills });
  r.errors.push(...c.errors);
  r.warnings.push(...c.warnings);
  const d = diffWorkflow(w, template);
  for (const x of d.dropped) r.warnings.push(`Left out: ${x.id} (${x.inclusion}) — ${x.reason ?? 'no reason'}.`);
  for (const x of d.included) r.warnings.push(`Included: ${x.id} (${x.inclusion})${x.reason ? ` — ${x.reason}` : ''}.`);
  const current = ctx.problemRoot ? readWorkflow(ctx.problemRoot) : undefined;
  if (current && current.status === 'approved' && current.template.id !== w.template.id) r.warnings.push(`It changes the template from ${current.template.id} to ${w.template.id}: the workflow restarts after the specification (owner's decision 2026-10-21).`);
  return finish(r);
}

// ── Proposing ────────────────────────────────────────────────────────────────

function subjectFor(kind: ProposalKind, ctx: ProposalContext, payload: unknown): Decision['subject'] {
  const doc = DOCUMENT_OF[kind];
  if (doc && ctx.problemRoot) {
    const text = readProblemDocument(ctx.problemRoot, doc);
    return { document: doc, revision: text === undefined ? 'none' : computeRevision(text) };
  }
  if (kind === 'connection') return { connectionId: draftEntry({ ...(payload as ConnectionDraft), fields: (payload as ConnectionDraft).fields ?? {} }).id };
  if (kind === 'semantic_model') { const s = payload as SemanticModelPayload; return { document: `semantic:${s.scope === 'shared' ? 'shared' : ctx.problemId}/${s.name}`, revision: semanticFileRevision(ctx, s) }; }
  if (kind === 'article') { const a = payload as ArticlePayload; return { document: `article:${a.slug}`, revision: readArticle(ctx.workspaceRoot, a.slug)?.revision ?? 'none' }; }
  return undefined;
}

function describe(kind: ProposalKind, payload: unknown): { title: string; summary: string } {
  switch (kind) {
    case 'assertion': { const a = payload as AssertionProposal; return { title: `Fact (${a.kind}): ${a.statement}`.slice(0, 160), summary: a.statement }; }
    case 'spec_revision': { const s = payload as BusinessProblemSpec; return { title: 'Revise the Business Problem Specification', summary: s.problemStatement }; }
    case 'pipeline_spec': { const s = payload as PipelineSpec; return { title: `Pipeline Spec: ${s.entities?.length ?? 0} entities`, summary: `Pipeline Spec derived from ${s.derivedFromBpsId ?? 'the active problem'} v${s.derivedFromBpsVersion ?? '?'}` }; }
    case 'workflow': { const w = payload as WorkflowInstance; const n = (w.stages ?? []).filter((s) => s.included).length; return { title: `Workflow: ${w.template?.id} with ${n} stages`, summary: (w.stages ?? []).filter((s) => s.included).map((s) => s.id).join(' → ') }; }
    case 'vocabulary': { const v = payload as VocabularyProposalPayload; return { title: `Vocabulary: ${v.entries.map((e) => e.kind === 'abbreviation' ? `${e.from.toUpperCase()}=${e.to}` : `${e.from}~${e.to}`).join(', ')}`.slice(0, 160), summary: `${v.entries.length} retrieval vocabulary entr${v.entries.length === 1 ? 'y' : 'ies'}.` }; }
    case 'runbook': { const r = payload as Runbook; return { title: `Runbook ${r.id}: ${r.title} (${r.steps?.length ?? 0} steps on ${r.connectionId})`.slice(0, 160), summary: r.reason ?? '' }; }
    case 'connection': { const c = payload as ConnectionDraft; const e = draftEntry({ ...c, fields: c.fields ?? {} }); return { title: `Connection ${e.id} (${c.platform}, ${c.role})`, summary: `${Object.entries(e.fields).map(([k, v]) => `${k}=${v}`).join(', ') || 'no settings'}; credentials ${c.credentials.resolver}${c.credentials.ref ? `:${c.credentials.ref}` : ''}.` }; }
    case 'semantic_model': { const s = payload as SemanticModelPayload; return { title: `${s.scope === 'shared' ? 'Shared semantic model' : 'Semantic composite'} ${s.name}`, summary: s.scope === 'shared' ? 'A workspace-level change: every problem that uses this model is affected.' : 'A composite of the active problem; it is resolved once applied.' }; }
    case 'article': { const a = payload as ArticlePayload; return { title: `Knowledge article: ${a.title}`.slice(0, 160), summary: `About ${a.about.join(', ')}; cites ${a.cites.length} fact(s). Approving it gives it to agents working on what it is about.` }; }
  }
}

/** The revision of the semantic file a proposal would replace (`none` when new). */
function semanticFileRevision(ctx: ProposalContext, s: SemanticModelPayload): string {
  if (s.scope === 'shared') return readShared(ctx.workspaceRoot, s.name)?.revision ?? 'none';
  const c = ctx.problemId ? readComposite(ctx.workspaceRoot, ctx.problemId, s.name) : undefined;
  return c && fs.existsSync(c.file) ? semanticRevision(fs.readFileSync(c.file, 'utf8')) : 'none';
}

/** A semantic model proposal: the Snowflake format (shared) or the composite format, and for a composite, that it resolves. */
export function validateSemanticModelProposal(s: SemanticModelPayload, ctx: ProposalContext): ValidationReport {
  const r = report();
  if (!s || (s.scope !== 'shared' && s.scope !== 'composite') || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(String(s.name ?? '')) || typeof s.content !== 'string') { r.errors.push('give scope (shared or composite), a name (letters, digits, _ and -) and the file content'); return finish(r); }
  if (s.scope === 'shared') {
    r.checks.push('the Snowflake semantic model format: known keys only, unique names, relationships between its tables');
    const p = parseSemanticModel(s.content);
    r.errors.push(...p.errors); r.warnings.push(...p.warnings);
    if (readShared(ctx.workspaceRoot, s.name)) r.warnings.push(`It replaces the shared model ${s.name}: every problem that uses it is affected, and their composites become stale.`);
  } else {
    needProblem(ctx, r);
    r.checks.push('the composite format', 'it resolves against the shared models: nothing missing, no collision, no redefinition of a shared expression, key or join');
    const p = parseComposite(s.content);
    r.errors.push(...p.errors);
    if (p.composite) r.errors.push(...resolveComposite(p.composite, sharedLoader(ctx.workspaceRoot)).errors);
  }
  return finish(r);
}

/** A runbook proposal: the engine's own checks (classification, allowlist, arguments, rollback, the environment's policy). */
export function validateRunbookProposal(rb: Runbook, ctx: ProposalContext): ValidationReport {
  const r = report();
  needProblem(ctx, r);
  r.checks.push('every step classified read, change or destructive by the engine', 'CLI commands on the allowlist, no credential or profile flags, paths inside the workspace', 'destructive steps have a rollback or a reason', "the step classes the connection's environment allows");
  const c = checkRunbook(rb, { workspaceRoot: ctx.workspaceRoot, connections: ctx.connections ?? loadConnectionsConfig(ctx.workspaceRoot).connections, policy: loadRunbookPolicy(ctx.workspaceRoot) });
  r.errors.push(...c.errors);
  r.warnings.push(...c.warnings, ...(c.ok ? [`Environment: ${c.environment.name} (${c.environment.approvers === 'any' ? 'any person approves' : c.environment.approvers.length ? `approvers: ${c.environment.approvers.join(', ')}` : 'no approvers configured yet'}${c.environment.secondApprover ? ', two approvals' : ''}). Steps: ${c.steps.map((s) => `${s.id} ${s.class}`).join(', ')}.`] : []));
  return finish(r);
}

export function validateProposal(kind: ProposalKind, payload: unknown, ctx: ProposalContext): ValidationReport {
  switch (kind) {
    case 'assertion': return validateAssertionProposal(payload as AssertionProposal);
    case 'spec_revision': return validateSpecRevision(payload as BusinessProblemSpec, ctx);
    case 'pipeline_spec': return validatePipelineSpecProposal(payload as PipelineSpec, ctx);
    case 'connection': return validateConnectionProposal(payload as ConnectionDraft, ctx);
    case 'vocabulary': return validateVocabularyProposal(payload as VocabularyProposalPayload);
    case 'workflow': return validateWorkflowProposal(payload as WorkflowInstance, ctx);
    case 'runbook': return validateRunbookProposal(payload as Runbook, ctx);
    case 'semantic_model': return validateSemanticModelProposal(payload as SemanticModelPayload, ctx);
    case 'article': return validateArticleProposal(payload as ArticlePayload, ctx);
  }
}

/** A knowledge article proposal: a valid name and front matter, every `[fact:…]` cited, every cited fact standing (§6.11). */
export function validateArticleProposal(a: ArticlePayload, ctx: ProposalContext): ValidationReport {
  const r = report();
  r.checks.push('a name (lower-case letters, digits, -), a title, and what it is about', 'every [fact:<id>] in the text is in cites, and every cited fact exists and still stands');
  if (!a || !/^[a-z0-9][a-z0-9-]*$/.test(String(a.slug ?? '')) || !String(a.title ?? '').trim() || !Array.isArray(a.about) || !a.about.length || typeof a.body !== 'string') { r.errors.push('give slug (lower-case letters, digits, -), title, about (asset, term or domain ids) and body'); return finish(r); }
  const ledger = new AssertionLedger(layoutPath(ctx.workspaceRoot, 'ledger'));
  ledger.loadSync();
  const c = checkArticle({ about: a.about, cites: a.cites ?? [], body: a.body }, ledger.assertions());
  r.errors.push(...c.errors, ...c.staleBecause.map((s) => `it would be stale at once: ${s}`));
  r.warnings.push(...c.warnings);
  if (readArticle(ctx.workspaceRoot, a.slug)) r.warnings.push(`It replaces the article ${a.slug}.`);
  return finish(r);
}

/** Validates and, if valid, records a pending decision. Nothing else is written. */
export function propose(store: DecisionStore, ctx: ProposalContext, kind: ProposalKind, payload: unknown, meta: { proposedBy: Proposer; evidence?: Decision['evidence'] }): Decision {
  const validation = validateProposal(kind, payload, ctx);
  if (!validation.ok) throw new ProposalValidationError(validation);
  const { title, summary } = describe(kind, payload);
  return store.create({ kind, title, summary, proposal: payload, proposedBy: meta.proposedBy, validation, evidence: meta.evidence, subject: subjectFor(kind, ctx, payload), problemId: ctx.problemId });
}

// ── Applying ─────────────────────────────────────────────────────────────────

export interface ApplyDeps {
  now?: () => Date;
}

export interface ApplyResult { decision: Decision; applied: boolean; message: string }

/**
 * Applies an approved decision. A decision whose document changed since it
 * was proposed is superseded instead — never applied to state its reviewer
 * didn't see.
 */
export async function applyDecision(store: DecisionStore, id: string, ctx: ProposalContext, deps: ApplyDeps = {}): Promise<ApplyResult> {
  const d = store.get(id);
  if (d.status !== 'approved') throw new DecisionError('NOT_APPROVED', `Decision ${id} is ${d.status}; only an approved decision is applied.`, { status: d.status });
  const kind = d.kind;
  // A stage gate (PA3a): the workflow runtime reads the decision itself; nothing else to write.
  if (d.kind === 'gate') { const done = store.markApplied(id, `Approved by ${d.resolution.by || 'unknown'}.`); return { decision: done, applied: true, message: `Approved: ${d.title}.` }; }
  const doc = DOCUMENT_OF[kind];
  if (doc) {
    if (!ctx.problemRoot) return { decision: d, applied: false, message: 'No active business problem; open it to apply this decision.' };
    const text = readProblemDocument(ctx.problemRoot, doc);
    const current = text === undefined ? 'none' : computeRevision(text);
    if (d.subject?.revision && d.subject.revision !== current) {
      const s = store.markSuperseded(id, `The ${doc} changed after the proposal was made; propose again against the current version.`);
      return { decision: s, applied: false, message: s.events[s.events.length - 1].note ?? '' };
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  const approver = d.resolution.by || 'unknown';
  try {
    if (kind === 'platform_change') {
      // Retired in v0.45.8 (SIMP-2): platform changes are runbooks, run by AutoDE's runner.
      const failed = store.markFailed(id, 'Single-statement platform changes were retired in v0.45.8: propose it as a runbook (autode_propose_runbook); the runner runs it once a person approves.');
      return { decision: failed, applied: false, message: failed.events[failed.events.length - 1].note ?? '' };
    }
    switch (kind) {
      case 'assertion': {
        const p = store.proposal<AssertionProposal>(id);
        const ledger = new AssertionLedger(layoutPath(ctx.workspaceRoot, 'ledger'));
        await ledger.load();
        const evidence: Evidence[] = p.evidence;
        await ledger.assert({ ...p, evidence, status: 'active', trust: 'confirmed', createdBy: `decision:${id}`, specId: p.specId }, id);
        break;
      }
      case 'spec_revision': {
        const p = store.proposal<BusinessProblemSpec>(id);
        const text = readProblemDocument(ctx.problemRoot!, 'spec');
        const current = text === undefined ? undefined : parseBusinessProblemSpec(text);
        const draft: BusinessProblemSpec = {
          ...p,
          id: current?.id ?? p.id,
          version: current ? (current.status === 'approved' ? current.version + 1 : current.version) : 1,
          status: 'draft',
          createdAt: current?.createdAt ?? now.toISOString(),
          updatedAt: now.toISOString(),
          approvedAt: undefined,
          approvedBy: undefined,
          // The business problem confirmation carries over only when the problem statement didn't change.
          problemStatementApproved: !!current && current.problemStatement === p.problemStatement && current.problemStatementApproved === true
        };
        writeBusinessProblemSpec(ctx.problemRoot!, draft);
        break;
      }
      case 'pipeline_spec': {
        const p = store.proposal<PipelineSpec>(id);
        const text = readProblemDocument(ctx.problemRoot!, 'pipelineSpec');
        const current = text === undefined ? undefined : parsePipelineSpecDocument(text);
        const draft: PipelineSpec = {
          ...p,
          version: current ? (current.status === 'approved' ? current.version + 1 : current.version) : (p.version ?? 1),
          status: 'draft',
          updatedAt: now.toISOString(),
          approvedAt: undefined,
          approvedBy: undefined
        } as PipelineSpec;
        writePipelineSpec(ctx.problemRoot!, draft);
        break;
      }
      case 'mapping':
        // Retired as a proposal kind (v0.45.8); a decision approved earlier still lands, as a draft in the mapping document.
        writeMappingUpsert(ctx.problemRoot!, store.proposal<EntityMapping>(id), now);
        break;
      case 'workflow': {
        const p = store.proposal<WorkflowInstance>(id);
        const root = ctx.problemRoot ?? layoutPath(ctx.workspaceRoot, 'problems', p.problemId);
        const current = readWorkflow(root);
        // Re-planning on the same template keeps the state of the stages both share; a new template restarts (owner, 2026-10-21).
        const keep = current && current.template.id === p.template.id ? new Map(current.stages.map((s) => [s.id, s.record])) : new Map();
        const next: WorkflowInstance = {
          ...p, status: 'approved', approvedAt: now.toISOString(), approvedBy: approver, decisionId: id,
          stages: p.stages.map((s) => ({ ...s, record: keep.get(s.id) ?? (s.kind === 'specify' ? s.record : { status: 'pending' }) }))
        };
        writeWorkflow(root, next);
        const resolved = [...d.events].reverse().find((e) => e.type === 'approved');
        appendEvent(root, { at: now.toISOString(), type: 'approved', actor: { kind: 'person', name: approver }, channel: resolved?.channel, decisionId: id, template: p.template.id, reason: keep.size ? 'the stages both workflows share keep their state' : current ? 'a new template restarts the workflow' : undefined });
        break;
      }
      case 'vocabulary': {
        const file = layoutPath(ctx.workspaceRoot, 'vocabulary');
        const entries = store.proposal<VocabularyProposalPayload>(id).entries.map((e) => ({ ...e, source: 'llm' as const, support: 0 }));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, mergeVocabularyFile(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined, entries));
        break;
      }
      case 'runbook': {
        if (!ctx.problemRoot || !ctx.problemId) return { decision: d, applied: false, message: 'No active business problem; open it to apply this runbook.' };
        const rb = store.proposal<Runbook>(id);
        const policy = loadRunbookPolicy(ctx.workspaceRoot);
        const check = checkRunbook(rb, { workspaceRoot: ctx.workspaceRoot, connections: ctx.connections ?? loadConnectionsConfig(ctx.workspaceRoot).connections, policy });
        if (!check.ok) { const failed = store.markFailed(id, `It no longer passes the checks: ${check.errors.join(' ')}`); return { decision: failed, applied: false, message: failed.events[failed.events.length - 1].note ?? '' }; }
        const channel = [...d.events].reverse().find((e) => e.type === 'approved')?.channel ?? 'file';
        const record: RunbookRecord = { runbook: rb, revision: check.revision, environment: check.environment.name, status: 'awaiting-approval', decisionId: id, problemId: ctx.problemId, approvals: [], steps: Object.fromEntries(rb.steps.map((s) => [s.id, { state: 'pending' as const }])), createdBy: d.proposedBy?.client ?? d.proposedBy?.host };
        const r = approveRunbook(ctx.problemRoot, record, approver, channel, policy, now);
        if (!r.record) { const failed = store.markFailed(id, r.problem ?? 'not approved'); return { decision: failed, applied: false, message: `${id}: ${r.problem}` }; }
        const done = store.markApplied(id, `Approved by ${approver} for ${record.environment}; ${r.record.status === 'approved' ? 'ready to run' : 'waiting for a second approver'}.`);
        return { decision: done, applied: true, message: r.record.status === 'approved' ? `Runbook ${rb.id} approved by ${approver} (${record.environment}): run it from its Runbook tab in VS Code.` : `Runbook ${rb.id}: first approval by ${approver}; ${record.environment} needs a second approver (the Runbook tab, or autode runbook approve ${rb.id}).` };
      }
      case 'article': {
        const a = store.proposal<ArticlePayload>(id);
        const current = readArticle(ctx.workspaceRoot, a.slug);
        if (d.subject?.revision && d.subject.revision !== (current?.revision ?? 'none')) {
          const sup = store.markSuperseded(id, `${a.slug} changed after the proposal was made; propose again against the current version.`);
          return { decision: sup, applied: false, message: sup.events[sup.events.length - 1].note ?? '' };
        }
        const channel = [...d.events].reverse().find((e) => e.type === 'approved')?.channel ?? 'file';
        const file: Omit<ArticleFile, 'status' | 'approved'> = { title: a.title, about: a.about, cites: a.cites ?? [], body: a.body, author: d.proposedBy?.client ?? d.proposedBy?.host ?? 'agent', ...(a.domain ? { domain: a.domain } : {}), ...(a.tags?.length ? { tags: a.tags } : {}) };
        writeArticle(ctx.workspaceRoot, a.slug, file, { overwrite: true });
        const ledger = new AssertionLedger(layoutPath(ctx.workspaceRoot, 'ledger'));
        ledger.loadSync();
        // The person who approved the decision approved this revision of the article.
        const ok = approveArticle(ctx.workspaceRoot, a.slug, { by: approver, channel, assertions: ledger.assertions(), at: now });
        if (!ok.ok) { const failed = store.markFailed(id, ok.message); return { decision: failed, applied: false, message: ok.message }; }
        const done = store.markApplied(id, `Written and approved by ${approver} (revision ${articleRevision(file)}).`);
        return { decision: done, applied: true, message: `Knowledge article ${a.slug} written and approved by ${approver}.` };
      }
      case 'semantic_model': {
        const s = store.proposal<SemanticModelPayload>(id);
        if (d.subject?.revision && d.subject.revision !== semanticFileRevision(ctx, s)) {
          const sup = store.markSuperseded(id, `${s.name} changed after the proposal was made; propose again against the current version.`);
          return { decision: sup, applied: false, message: sup.events[sup.events.length - 1].note ?? '' };
        }
        const channel = [...d.events].reverse().find((e) => e.type === 'approved')?.channel ?? 'file';
        if (s.scope === 'shared') {
          // The person who approved the decision approved this revision of the shared model.
          writeShared(ctx.workspaceRoot, s.name, s.content, { approved: { by: approver, at: now.toISOString(), channel } });
          const done = store.markApplied(id, `Written and approved by ${approver}.`);
          return { decision: done, applied: true, message: `Shared semantic model ${s.name} written and approved by ${approver}. Composites that use it are stale until resolved again.` };
        }
        if (!ctx.problemId) return { decision: d, applied: false, message: 'No active business problem; open it to apply this composite.' };
        const dir = semanticPaths(ctx.workspaceRoot).compositeDir(ctx.problemId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${s.name}.yaml`), s.content);
        const res = resolveCompositeFile(ctx.workspaceRoot, ctx.problemId, s.name);
        const done = store.markApplied(id, res.ok ? `Written and resolved (approved by ${approver}).` : `Written; it no longer resolves: ${res.errors.join('; ')}`);
        return { decision: done, applied: true, message: res.ok ? `Composite ${s.name} written and resolved: ${path.relative(ctx.workspaceRoot, res.resolvedFile)}. Approve it within the problem (autode semantic approve ${s.name}).` : `Composite ${s.name} written, but it doesn't resolve now: ${res.errors.join('; ')}` };
      }
      case 'connection': {
        const saved = saveConnection(ctx.workspaceRoot, store.proposal<ConnectionDraft>(id));
        const done = store.markApplied(id, `Approved by ${approver}; wrote ${saved.written.join(', ')}.`);
        return { decision: done, applied: true, message: `Applied ${id}: connection ${saved.id} saved (approved by ${approver}). Test it before use: autode connections test ${saved.id}, or autode_test_connection.` };
      }
      default:
        return { decision: d, applied: false, message: `Decision ${id} (${d.kind}) has nothing to apply.` };
    }
  } catch (err) {
    const failed = store.markFailed(id, err instanceof Error ? err.message : String(err));
    return { decision: failed, applied: false, message: `Applying ${id} failed: ${failed.events[failed.events.length - 1].note}` };
  }
  const done = store.markApplied(id, `Approved by ${approver}.`);
  return { decision: done, applied: true, message: `Applied ${id}: ${d.title} (approved by ${approver}).` };
}

/**
 * Picks up decisions resolved in their files and applies every approved one
 * this process can apply.
 * Call it before answering about decisions, and when decision files change.
 */
export async function processResolved(store: DecisionStore, ctx: ProposalContext, deps: ApplyDeps = {}): Promise<{ applied: ApplyResult[]; incomplete: string[] }> {
  const { incomplete } = store.syncFileResolutions();
  const applied: ApplyResult[] = [];
  for (const d of store.list({ status: 'approved' })) {
    if (d.problemId && ctx.problemId && d.problemId !== ctx.problemId) continue;
    applied.push(await applyDecision(store, d.id, ctx, deps));
  }
  return { applied, incomplete };
}
