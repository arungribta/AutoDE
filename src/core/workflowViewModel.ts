import * as fs from 'node:fs';
import { stageRunner } from './agentExecutor';
import { documentApprovalProblems, stageDocumentFile } from '../engine/workflows/documentApproval';
import { stageReadiness } from '../engine/workflows/readiness';
import { Runbook, listRunbooks } from '../engine/runner/runbook';
import { readProblemDocument, parseBusinessProblemSpec } from '../engine/documents/problemDocuments';
import { DecisionStore } from '../engine/decisions/decisionStore';
import { readWorkflow, WorkflowInstance } from '../engine/workflows/instance';
import { actorLabel, readEvents } from '../engine/workflows/events';
import { StageView } from '../engine/workflows/runtime';
import { WorkflowScope, problemRootOf, statusFor, templatesFor } from '../engine/workflows/service';
import { STAGE_KINDS } from '../engine/workflows/stageKinds';

/**
 * What the Workflow tree, the Workflow editor tab and the status-bar item show
 * (v0.44.1). No VS Code import, so it is tested in plain Node. Every label
 * says who did it: the engine's rule, a person, or an agent.
 */

export interface StageModel extends StageView {
  /** Dependency depth: stages in the same column can run side by side. */
  level: number;
  after: string[];
  role?: string;
  tier?: string;
  ceiling: string;
  documentBacked: boolean;
  approvedBy?: string;
  approvedAt?: string;
  /** How the approval was given: panel, cli, file, elicitation, document. */
  approvedVia?: string;
  /** What a person can do here now. */
  actions: StageAction[];
  /** Who runs the stage here: its role template, or AutoDE's not-yet-migrated agents for its kind. */
  runner?: string;
  /** The label of `produce`: how this stage's document is made (document stages). */
  produceLabel?: string;
  /** The stage's document, workspace-relative, when it exists. */
  document?: string;
  /** What stops the document from being approved now. */
  blockers: string[];
  /** One line: what moves this stage forward. */
  guide: string;
  /** Runbooks proposed or approved for this stage (v0.45.6). */
  runbooks: Array<{ id: string; status: string }>;
  /** No AutoDE agent does this stage yet: a person does it and hands it in (SIMP-1). */
  manual: boolean;
}

export type StageAction = 'approve' | 'approve-document' | 'run' | 'produce' | 'open-document' | 'hand-in' | 'approve-again' | 'skip' | 'reopen';

/** How each document stage's document is made in VS Code. */
export const PRODUCE_LABEL: Record<string, string> = {
  'specify': 'Open the specification', 'target-context': 'Build the target context', 'source-assessment': 'Build the source context',
  'mapping': 'Add a mapping…', 'build': 'Generate the Pipeline Spec'
};
const DOC_NAME: Record<string, string> = { 'specify': 'specification', 'target-context': 'target context', 'source-assessment': 'source context', 'mapping': 'mapping', 'build': 'Pipeline Spec' };

/** The proposed workflow, for review before it is approved: every stage, and why the left-out ones are out. */
export interface ProposalModel { id: string; title: string; template: string; stages: Array<{ id: string; title: string; kind: string; inclusion: string; included: boolean; reason?: string; origin?: string; systems?: string[] }>; errors: string[] }

export interface WorkflowModel {
  problemId: string;
  statement: string;
  template: string;
  approved: boolean;
  provenance: string[];
  progress: { done: number; total: number };
  stages: StageModel[];
  next?: { id: string; title: string; status: string; why?: string };
  pendingWorkflowDecision?: { id: string; title: string };
  proposal?: ProposalModel;
  templates: Array<{ id: string; title: string }>;
}

const DOCUMENT_KINDS = ['specify', 'target-context', 'source-assessment', 'mapping', 'build'];

function levels(w: WorkflowInstance): Map<string, number> {
  const byId = new Map(w.stages.map((s) => [s.id, s]));
  const memo = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const s = byId.get(id);
    const d = s && s.after.length ? 1 + Math.max(...s.after.map((a) => depth(a.stage, seen))) : 0;
    memo.set(id, d);
    return d;
  };
  for (const s of w.stages) depth(s.id, new Set());
  return memo;
}

export function buildWorkflowModel(scope: WorkflowScope): WorkflowModel {
  const status = statusFor(scope);
  const root = problemRootOf(scope);
  const w = readWorkflow(root)!;
  let statement = '';
  try { statement = parseBusinessProblemSpec(readProblemDocument(root, 'spec') ?? '').problemStatement; } catch { /* none */ }
  const events = readEvents(root);
  const lv = levels(w);
  const approvals = new Map<string, { channel?: string }>();
  for (const e of events) if (e.type === 'approved' && e.stage) approvals.set(e.stage, { channel: e.channel });
  const prov: string[] = [];
  const p = w.provenance;
  if (p?.suggested) prov.push(`Suggested by the engine: ${p.suggested.template} (rule: ${p.suggested.rule})`);
  if (p?.chosenBy) prov.push(`Template chosen by ${actorLabel(p.chosenBy)}`);
  if (p?.draftedBy) prov.push(`Drafted by ${actorLabel(p.draftedBy)}`);
  if (p?.refinedBy) prov.push(`Refined by ${actorLabel(p.refinedBy)}`);
  if (p?.proposedBy) prov.push(`Proposed by ${actorLabel(p.proposedBy)}`);
  if (w.status === 'approved') prov.push(`Approved by ${w.approvedBy ?? 'unknown'}${w.approvedAt ? ` on ${w.approvedAt.slice(0, 16).replace('T', ' ')}` : ''}`);
  const decisions = new DecisionStore(scope.workspaceRoot);
  const stageRunbooks = new Map<string, Array<{ id: string; status: string }>>();
  for (const r of listRunbooks(root)) if (r.runbook.stage) stageRunbooks.set(r.runbook.stage, [...(stageRunbooks.get(r.runbook.stage) ?? []), { id: r.runbook.id, status: r.status }]);
  for (const d of decisions.list({ status: 'pending', kind: 'runbook' }).filter((x) => x.problemId === scope.problemId)) {
    const rb = decisions.proposal<Runbook>(d.id);
    if (rb.stage) stageRunbooks.set(rb.stage, [...(stageRunbooks.get(rb.stage) ?? []), { id: rb.id, status: 'waits for approval' }]);
  }
  const stages: StageModel[] = status.stages.map((v) => {
    const s = w.stages.find((x) => x.id === v.id)!;
    const documentBacked = DOCUMENT_KINDS.includes(s.kind);
    const actions: StageAction[] = [];
    const runner = s.included ? stageRunner(scope, s.id, s.kind) : undefined;
    const docFile = documentBacked ? stageDocumentFile(root, s.kind) : undefined;
    const hasDoc = !!docFile && fs.existsSync(docFile);
    const open = v.status === 'ready' || v.status === 'in-progress' || v.status === 'stale';
    // What the stage's work needs and doesn't have yet (no tables to map, no mappings to model): shown before Run agent, which refuses the same.
    const notReady = w.status === 'approved' && s.included && (v.status === 'ready' || v.status === 'in-progress') ? stageReadiness({ workspaceRoot: scope.workspaceRoot, problemRoot: root, kind: s.kind }) : [];
    const blockers = documentBacked && v.status === 'awaiting-approval' && !s.record.decisionId ? documentApprovalProblems(root, s.kind) : notReady;
    if (w.status === 'approved' && s.included && v.status !== 'skipped') {
      if (v.status === 'awaiting-approval' && s.record.decisionId) actions.push('approve');
      if (documentBacked && v.status === 'awaiting-approval' && !s.record.decisionId && !blockers.length) actions.push('approve-document');
      if (runner && !notReady.length && (open || (documentBacked && v.status === 'awaiting-approval'))) actions.push('run');
      if (documentBacked && v.status !== 'done') actions.push('produce');
      if (!documentBacked && (v.status === 'ready' || v.status === 'in-progress')) actions.push('hand-in');
      if (v.status === 'stale') actions.push('approve-again');
      if (v.status === 'done') actions.push('reopen');
      if (s.inclusion !== 'mandatory' && v.status !== 'done') actions.push('skip');
    }
    if (hasDoc) actions.push('open-document');
    const doc = DOC_NAME[s.kind];
    const guide = !s.included ? 'Not in this workflow.'
      : v.status === 'done' ? 'Done.'
      : v.status === 'skipped' ? `Skipped${v.why ? `: ${v.why}` : '.'}`
      : w.status !== 'approved' ? 'Waits for the workflow to be approved.'
      : v.status === 'pending' ? `Waits: ${v.why ?? 'its dependencies are not done'}.`
      : v.status === 'stale' ? 'Its inputs changed since it was approved: review the output, then approve it again.'
      : v.status === 'awaiting-approval' && s.record.decisionId ? 'Waits for your approval.'
      : notReady.length ? `Not ready yet: ${notReady.join(' ')}`
      : v.status === 'awaiting-approval' && documentBacked ? (blockers.length ? `The ${doc} can't be approved yet: ${blockers.join(' ')}` : `Review the ${doc} and approve it.`)
      : documentBacked ? `${PRODUCE_LABEL[s.kind]}${runner ? ` (or Run agent: ${runner})` : ''}, then approve the ${doc}.`
      : runner ? `Run agent (${runner}), or hand in what you produced${s.inclusion !== 'mandatory' ? ', or skip it with a reason' : ''}.`
      : `No AutoDE agent does this stage yet: hand in what you produced${s.inclusion !== 'mandatory' ? ', or skip it with a reason' : ''}.`;
    return {
      ...v, level: lv.get(v.id) ?? 0, after: s.after.map((a) => `${a.stage}${a.approved ? ' (approved)' : ''}`), role: s.agent?.role, tier: s.agent?.tier, ceiling: STAGE_KINDS[s.kind].ceiling,
      documentBacked, approvedBy: s.record.approvedBy, approvedAt: s.record.approvedAt, approvedVia: approvals.get(s.id)?.channel, actions, runner,
      produceLabel: documentBacked ? PRODUCE_LABEL[s.kind] : undefined, document: hasDoc ? relTo(scope.workspaceRoot, docFile!) : undefined, blockers,
      guide: stageRunbooks.get(s.id)?.some((r) => r.status !== 'ran') && v.status !== 'done' ? `Its runbook ${stageRunbooks.get(s.id)!.find((r) => r.status !== 'ran')!.id} is ${stageRunbooks.get(s.id)!.find((r) => r.status !== 'ran')!.status}: open it to approve and run it.` : guide,
      runbooks: stageRunbooks.get(s.id) ?? [],
      manual: s.included && !runner && !documentBacked && v.status !== 'done' && v.status !== 'skipped'
    };
  });
  const included = w.stages.filter((s) => s.included && s.record.status !== 'skipped');
  const store = new DecisionStore(scope.workspaceRoot);
  const pending = store.list({ status: 'pending', kind: 'workflow' }).find((d) => d.problemId === scope.problemId);
  let proposal: ProposalModel | undefined;
  if (pending) {
    try {
      const pw = store.proposal<WorkflowInstance>(pending.id);
      proposal = { id: pending.id, title: pending.title, template: `${pw.template.id} v${pw.template.version}`, errors: pending.validation?.errors ?? [],
        stages: pw.stages.map((x) => ({ id: x.id, title: x.title, kind: x.kind, inclusion: x.inclusion, included: x.included, reason: x.reason, origin: x.origin, systems: x.systems })) };
    } catch { /* an unreadable proposal: the decision file still shows it */ }
  }
  return {
    problemId: scope.problemId, statement, template: status.template, approved: status.approved, provenance: prov,
    progress: { done: included.filter((s) => s.record.status === 'done').length, total: included.length },
    stages, next: status.next ? { id: status.next.id, title: status.next.title, status: status.next.status, why: status.next.why } : undefined,
    pendingWorkflowDecision: pending ? { id: pending.id, title: pending.title } : undefined,
    proposal,
    templates: templatesFor(scope).templates.map((t) => ({ id: t.id, title: t.title }))
  };
}

const relTo = (root: string, file: string) => file.slice(root.length + 1).split(/[\\/]/).join('/');

/** The status-bar text: problem, progress, and what needs attention. */
export function statusBarText(m: WorkflowModel): string {
  const stale = m.stages.filter((s) => s.status === 'stale');
  const waiting = m.stages.filter((s) => s.status === 'awaiting-approval');
  const attention = !m.approved ? (m.pendingWorkflowDecision ? 'workflow awaits approval' : 'plan the workflow') : stale.length ? `${stale[0].title} stale` : waiting.length ? `${waiting.length} awaiting approval` : m.next ? `next: ${m.next.title}` : 'up to date';
  return `AutoDE: ${m.problemId} · ${m.progress.done}/${m.progress.total} · ${attention}`;
}

export const STATUS_ICON: Record<string, string> = { done: 'pass', ready: 'arrow-right', 'in-progress': 'sync', 'awaiting-approval': 'question', 'awaiting-check': 'question', pending: 'circle-outline', stale: 'warning', skipped: 'circle-slash' };
