import * as fs from 'node:fs';
import { parseBusinessProblemSpec, readProblemDocument } from '../documents/problemDocuments';
import { Decision, DecisionStore, Proposer } from '../decisions/decisionStore';
import { ProposalContext, applyDecision, approvalBlockers, propose } from '../decisions/proposals';
import { CoverageEntry, CoverageProposal, CoverageStatus, specCoverage } from './coverage';
import { CoverageReport, MAX_QUESTIONS, PlanningOutcome, PlanningQuestion, PlanningRound, QuestionInput, ReportKind, answerQuestion, openQuestions, openRound, readPlanning, reportChange } from './planning';
import { layoutPath } from '../workspaceLayout';
import { WorkflowInstance, diffWorkflow, draftWorkflow, readWorkflow, sourceSystems, workflowFacts, writeWorkflow } from './instance';
import { WorkflowTemplate, loadTemplates, suggestTemplate } from './templates';
import { WorkflowStatus, syncWorkflow } from './runtime';
import { Actor, WorkflowEvent, actorFrom, appendEvent, readEvents } from './events';
import { STAGE_KINDS } from './stageKinds';

/**
 * What every surface calls for workflows (PA3a): the panel, `autode workflow`
 * and the MCP workflow tools. One implementation, so they report the same.
 */

export interface WorkflowScope {
  workspaceRoot: string;
  /** Where the bundled `workflows/` live: the extension's or the package's root. */
  resourcesRoot: string;
  problemId: string;
}

export function problemRootOf(scope: WorkflowScope): string {
  return layoutPath(scope.workspaceRoot, 'problems', scope.problemId);
}

export function templatesFor(scope: Pick<WorkflowScope, 'workspaceRoot' | 'resourcesRoot'>): { templates: WorkflowTemplate[]; errors: string[] } {
  return loadTemplates(scope.resourcesRoot, scope.workspaceRoot);
}

/** The template AutoDE suggests for this problem, from its specification and the estate. */
export function suggestFor(scope: WorkflowScope): { id: string; reason: string } | undefined {
  const root = problemRootOf(scope);
  const text = readProblemDocument(root, 'spec') ?? '';
  let specText = text;
  let legacyHint = '';
  try { const spec = parseBusinessProblemSpec(text); specText = [spec.problemStatement, ...spec.objectives, ...spec.scope.in, spec.domain ?? ''].join(' '); legacyHint = spec.implementationType === 'brownfield' ? ' modernization' : ''; } catch { /* no spec yet */ }
  return suggestTemplate(templatesFor(scope).templates, specText + legacyHint, workflowFacts(scope.workspaceRoot, root));
}

/**
 * The problem's workflow, creating the deterministic draft when there is none
 * (this also migrates problems from before PA3a: brownfield → modernization,
 * greenfield → greenfield). An approved workflow is never replaced here.
 */
export function ensureWorkflow(scope: WorkflowScope, templateId?: string, who?: Actor): WorkflowInstance {
  const root = problemRootOf(scope);
  if (!fs.existsSync(root)) throw new Error(`No business problem "${scope.problemId}".`);
  const current = readWorkflow(root);
  if (current && (current.status !== 'draft' || !templateId || current.template.id === templateId)) return current;
  return redraft(scope, templateId, who);
}

/** A fresh deterministic draft (status `draft`) from a template; refused when the workflow is approved — re-plan through a proposal. */
export function redraft(scope: WorkflowScope, templateId?: string, who?: Actor): WorkflowInstance {
  const root = problemRootOf(scope);
  const current = readWorkflow(root);
  if (current && current.status === 'approved') throw new Error('The workflow is approved; re-plan by proposing a revised workflow.');
  return draftFrom(scope, templateId, who);
}

/**
 * A deterministic draft, labelled with who did what: the engine's suggestion
 * (its rule), the person who chose a template, the engine as drafter. Recorded
 * in the workflow's history. Doesn't check whether a workflow is approved.
 */
/** The deterministic draft for a template (the suggested one by default), written nowhere: what the planner refines (v0.45.12). */
export function computeDraft(scope: WorkflowScope, templateId?: string): { workflow: WorkflowInstance; template: WorkflowTemplate; suggestion?: { id: string; reason: string } } {
  const root = problemRootOf(scope);
  const { templates, errors } = templatesFor(scope);
  const suggestion = suggestFor(scope);
  const id = templateId ?? suggestion?.id ?? 'greenfield';
  const template = templates.find((t) => t.id === id);
  if (!template) throw new Error(`No workflow template "${id}" (known: ${templates.map((t) => t.id).join(', ') || 'none'})${errors.length ? `; template errors: ${errors.join('; ')}` : ''}.`);
  return { workflow: draftWorkflow(template, scope.problemId, workflowFacts(scope.workspaceRoot, root), sourceSystems(scope.workspaceRoot)), template, suggestion };
}

export function draftFrom(scope: WorkflowScope, templateId?: string, who?: Actor): WorkflowInstance {
  const root = problemRootOf(scope);
  const { workflow: w, template, suggestion } = computeDraft(scope, templateId);
  const at = new Date().toISOString();
  w.provenance = {
    suggested: suggestion ? { template: suggestion.id, rule: suggestion.reason } : undefined,
    chosenBy: templateId && who ? who : undefined,
    draftedBy: { kind: 'engine', rule: `template ${template.id} v${template.version} with the facts of the spec and estate` }
  };
  if (suggestion) appendEvent(root, { at, type: 'suggested', actor: { kind: 'engine', rule: suggestion.reason }, channel: 'engine', template: suggestion.id });
  appendEvent(root, { at, type: 'drafted', actor: { kind: 'engine', rule: `template ${template.id}` }, channel: 'engine', template: template.id, reason: templateId && who ? `template chosen by ${who.kind === 'engine' ? 'the engine' : who.name}` : 'the suggested template' });
  writeWorkflow(root, w);
  return w;
}

export function statusFor(scope: WorkflowScope): WorkflowStatus {
  ensureWorkflow(scope);
  return syncWorkflow({ workspaceRoot: scope.workspaceRoot, problemRoot: problemRootOf(scope), problemId: scope.problemId })!;
}

function proposalContext(scope: WorkflowScope): ProposalContext {
  return { workspaceRoot: scope.workspaceRoot, problemRoot: problemRootOf(scope), problemId: scope.problemId, resourcesRoot: scope.resourcesRoot };
}

/** Proposes a workflow (the draft, or the planner's refinement) as a decision; the plan gate. */
export function proposeWorkflow(scope: WorkflowScope, w: WorkflowInstance, proposedBy: Proposer): Decision {
  const store = new DecisionStore(scope.workspaceRoot);
  // A newer proposal replaces an older pending one for the same problem.
  for (const d of store.list({ status: 'pending', kind: 'workflow' })) if (d.problemId === scope.problemId) store.withdraw(d.id, 'autode', 'replaced by a newer workflow proposal');
  const by = actorFrom(proposedBy.client, proposedBy.host);
  const proposal: WorkflowInstance = { ...w, status: 'proposed', provenance: { ...w.provenance, proposedBy: by } };
  const d = propose(store, proposalContext(scope), 'workflow', proposal, { proposedBy });
  const root = problemRootOf(scope);
  appendEvent(root, { at: new Date().toISOString(), type: 'proposed', actor: by, channel: proposedBy.host === 'mcp' ? 'tool' : proposedBy.host, decisionId: d.id, template: w.template.id });
  const current = readWorkflow(root);
  if (!current || current.status !== 'approved') writeWorkflow(root, proposal);
  return d;
}

/**
 * PLN1a: the coverage a person approves first when they approve the workflow on the same screen (panel or CLI):
 * complete but not approved yet. Its summary goes in the confirmation; it is recorded as its own decision, first.
 */
export function coverageToApproveFirst(scope: WorkflowScope): { summary: string } | undefined {
  const c = specCoverage(scope.workspaceRoot, scope.problemId);
  if (!c || !c.check.ok || (c.coverage.approvedBy && !c.pendingDecision)) return undefined;
  const n = (st: string) => c.coverage.entries.filter((e) => e.status === st).length;
  return { summary: `This approves the coverage first (what will be delivered): ${n('covered')} item(s) delivered by stages, ${n('manual')} done outside AutoDE, ${n('out-of-scope')} out of scope, ${n('gap')} gap(s).` };
}

/** A person approves a workflow decision through a channel that allows it (panel, CLI, file); the engine applies it. */
export async function approveWorkflow(scope: WorkflowScope, decisionId: string, by: string, channel: 'panel' | 'cli', note?: string): Promise<string> {
  const store = new DecisionStore(scope.workspaceRoot);
  if (store.get(decisionId).kind === 'workflow' && coverageToApproveFirst(scope)) await approveCoverageNow(scope, by, channel);
  store.resolve(decisionId, { decision: 'approved', by, channel, note });
  const r = await applyDecision(store, decisionId, proposalContext(scope));
  return r.message;
}

export { diffWorkflow };

/** PLN1b: the clarification rounds and the stages' reports, as every surface shows them. */
export function planningStatus(scope: WorkflowScope): { rounds: PlanningRound[]; open: PlanningQuestion[]; reports: CoverageReport[]; maxQuestions: number } {
  const p = readPlanning(problemRootOf(scope));
  return { rounds: p.rounds, open: openQuestions(p), reports: p.reports, maxQuestions: MAX_QUESTIONS };
}

const coverageItemIds = (scope: WorkflowScope): string[] => specCoverage(scope.workspaceRoot, scope.problemId)?.coverage.entries.map((e) => e.id) ?? [];

/** PLN1b: the planner asks what blocks coverage (a round of at most seven questions). */
export function askPlanningQuestions(scope: WorkflowScope, questions: readonly QuestionInput[], by: Actor, channel: string): PlanningRound {
  return openRound(problemRootOf(scope), { questions, knownItems: coverageItemIds(scope), by, channel });
}

/** PLN1b: a person's answer to a planning question; after the coverage was approved, it is also reported for re-planning. */
export async function answerPlanningQuestion(scope: WorkflowScope, question: string, input: { value?: string; outcome: PlanningOutcome }, by: Actor, channel: string): Promise<{ question: PlanningQuestion; report?: CoverageReport }> {
  const c = specCoverage(scope.workspaceRoot, scope.problemId);
  return answerQuestion(scope.workspaceRoot, problemRootOf(scope), { question, value: input.value, outcome: input.outcome, by, channel, coverageApproved: !!c?.coverage.approvedBy && !c.pendingDecision });
}

/** PLN1b: a stage reports what changes coverage. */
export function reportCoverageChange(scope: WorkflowScope, input: { stage: string; kind: ReportKind; items?: string[]; detail: string }, by: Actor, channel: string): CoverageReport {
  return reportChange(problemRootOf(scope), { ...input, knownItems: coverageItemIds(scope), by, channel });
}

export interface CoveragePlacement { item: string; status: Exclude<CoverageStatus, 'question'>; stages?: string[]; reason?: string }

/**
 * PLN1a: proposes the coverage (workflow-planning.md §3.5): the current coverage with these placements over it,
 * as a `coverage` decision a person approves before the workflow. Refused, item by item, when a check fails;
 * a newer proposal replaces an older pending one.
 */
export function proposeCoverage(scope: WorkflowScope, placements: readonly CoveragePlacement[], proposedBy: Proposer): Decision {
  const c = specCoverage(scope.workspaceRoot, scope.problemId);
  if (!c) throw new Error('No coverage yet: it needs the specification and a workflow (propose the workflow first).');
  const by = proposedBy.host === 'mcp' ? `agent: ${proposedBy.client ?? 'MCP client'}` : `person: ${proposedBy.client ?? 'unknown'}`;
  const unknown = placements.filter((p) => !c.coverage.entries.some((e) => e.id === p.item)).map((p) => p.item);
  if (unknown.length) throw new Error(`No coverage item ${unknown.join(', ')} (items: ${c.coverage.entries.map((e) => e.id).join(', ')}).`);
  const entries: CoverageEntry[] = c.coverage.entries.map((e) => {
    const p = placements.find((x) => x.item === e.id);
    return p ? { id: e.id, text: e.text, source: e.source, status: p.status, ...(p.stages?.length ? { stages: p.stages } : {}), ...(p.reason?.trim() ? { reason: p.reason.trim() } : {}), placedBy: by } : e;
  });
  const store = new DecisionStore(scope.workspaceRoot);
  for (const d of store.list({ status: 'pending', kind: 'coverage' })) if (d.problemId === scope.problemId) store.withdraw(d.id, 'autode', 'replaced by a newer coverage proposal');
  const payload: CoverageProposal = { problemId: scope.problemId, specId: c.coverage.specId, specVersion: c.coverage.specVersion, entries };
  const d = propose(store, proposalContext(scope), 'coverage', payload, { proposedBy });
  appendEvent(problemRootOf(scope), { at: new Date().toISOString(), type: 'proposed', actor: actorFrom(proposedBy.client, proposedBy.host), channel: proposedBy.host === 'mcp' ? 'tool' : proposedBy.host, decisionId: d.id, reason: 'the coverage of the specification' });
  return d;
}

/**
 * A person approves the coverage they see (panel or CLI): the pending proposal, or, when they placed the items
 * themselves, the coverage as it stands, proposed and approved in one step. Refused while a check fails.
 */
export async function approveCoverageNow(scope: WorkflowScope, by: string, channel: 'panel' | 'cli'): Promise<string> {
  const c = specCoverage(scope.workspaceRoot, scope.problemId);
  if (!c) throw new Error('No coverage yet: it needs the specification and a workflow.');
  if (c.coverage.approvedBy && !c.pendingDecision) return `The coverage is already approved (by ${c.coverage.approvedBy}).`;
  if (!c.check.ok) throw new Error(`The coverage can't be approved yet: ${c.check.errors.join(' ')}`);
  const store = new DecisionStore(scope.workspaceRoot);
  const id = c.pendingDecision ?? propose(store, proposalContext(scope), 'coverage', { problemId: scope.problemId, specId: c.coverage.specId, specVersion: c.coverage.specVersion, entries: c.coverage.entries } satisfies CoverageProposal, { proposedBy: { host: channel === 'panel' ? 'vscode' : 'cli', client: by } }).id;
  const blockers = approvalBlockers(store, id, { workspaceRoot: scope.workspaceRoot, problemRoot: problemRootOf(scope) });
  if (blockers.length) throw new Error(blockers.join(' '));
  store.resolve(id, { decision: 'approved', by, channel });
  const r = await applyDecision(store, id, proposalContext(scope));
  return r.applied ? `Coverage approved by ${by}. Next: approve the workflow.` : r.message;
}

/** The workflow's history, oldest first; with `stage`, that stage's events and the workflow-wide ones. */
export function historyFor(scope: WorkflowScope, stage?: string): WorkflowEvent[] {
  // Approvals made in documents or decisions are recorded when the runtime syncs; sync first so the history is current.
  if (readWorkflow(problemRootOf(scope))) syncWorkflow({ workspaceRoot: scope.workspaceRoot, problemRoot: problemRootOf(scope), problemId: scope.problemId });
  return readEvents(problemRootOf(scope), stage ? { stage, withWorkflow: false } : {});
}

export interface StageDetail {
  id: string;
  title: string;
  kind: string;
  doneWhen: string;
  roles: string[];
  ceiling: string;
  consumes: string[];
  produces: string[];
  gates: string[];
  record: Record<string, unknown>;
  decision?: { id: string; status: string; title: string; events: Array<{ at: string; type: string; actor: string; channel?: string; note?: string }> };
  history: WorkflowEvent[];
}

/** Everything a person needs to trace one stage: its kind's rules, its record, its gate decision's trail and its history. */
export function stageDetail(scope: WorkflowScope, id: string): StageDetail | undefined {
  const w = readWorkflow(problemRootOf(scope));
  const s = w?.stages.find((x) => x.id === id);
  if (!w || !s) return undefined;
  const k = STAGE_KINDS[s.kind];
  const history = historyFor(scope, id);
  const decisionId = s.record.decisionId ?? [...history].reverse().find((e) => e.decisionId)?.decisionId;
  let decision: StageDetail['decision'];
  if (decisionId) {
    try { const d = new DecisionStore(scope.workspaceRoot).get(decisionId); decision = { id: d.id, status: d.status, title: d.title, events: d.events }; } catch { /* gone */ }
  }
  return { id: s.id, title: s.title, kind: s.kind, doneWhen: k.doneWhen, roles: k.roles, ceiling: k.ceiling, consumes: s.consumes, produces: s.produces, gates: s.gates, record: s.record as unknown as Record<string, unknown>, decision, history };
}
