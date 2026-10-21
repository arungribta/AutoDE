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
  actions: Array<'approve' | 'hand-in' | 'approve-again' | 'skip' | 'reopen'>;
}

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
  const stages: StageModel[] = status.stages.map((v) => {
    const s = w.stages.find((x) => x.id === v.id)!;
    const documentBacked = DOCUMENT_KINDS.includes(s.kind);
    const actions: StageModel['actions'] = [];
    if (w.status === 'approved' && s.included && v.status !== 'skipped') {
      if (v.status === 'awaiting-approval' && s.record.decisionId) actions.push('approve');
      if (!documentBacked && (v.status === 'ready' || v.status === 'in-progress')) actions.push('hand-in');
      if (v.status === 'stale') actions.push('approve-again');
      if (v.status === 'done') actions.push('reopen');
      if (s.inclusion !== 'mandatory' && v.status !== 'done') actions.push('skip');
    }
    return {
      ...v, level: lv.get(v.id) ?? 0, after: s.after.map((a) => `${a.stage}${a.approved ? ' (approved)' : ''}`), role: s.agent?.role, tier: s.agent?.tier, ceiling: STAGE_KINDS[s.kind].ceiling,
      documentBacked, approvedBy: s.record.approvedBy, approvedAt: s.record.approvedAt, approvedVia: approvals.get(s.id)?.channel, actions
    };
  });
  const included = w.stages.filter((s) => s.included && s.record.status !== 'skipped');
  const pending = new DecisionStore(scope.workspaceRoot).list({ status: 'pending', kind: 'workflow' }).find((d) => d.problemId === scope.problemId);
  return {
    problemId: scope.problemId, statement, template: status.template, approved: status.approved, provenance: prov,
    progress: { done: included.filter((s) => s.record.status === 'done').length, total: included.length },
    stages, next: status.next ? { id: status.next.id, title: status.next.title, status: status.next.status, why: status.next.why } : undefined,
    pendingWorkflowDecision: pending ? { id: pending.id, title: pending.title } : undefined,
    templates: templatesFor(scope).templates.map((t) => ({ id: t.id, title: t.title }))
  };
}

/** The status-bar text: problem, progress, and what needs attention. */
export function statusBarText(m: WorkflowModel): string {
  const stale = m.stages.filter((s) => s.status === 'stale');
  const waiting = m.stages.filter((s) => s.status === 'awaiting-approval');
  const attention = !m.approved ? (m.pendingWorkflowDecision ? 'workflow awaits approval' : 'plan the workflow') : stale.length ? `${stale[0].title} stale` : waiting.length ? `${waiting.length} awaiting approval` : m.next ? `next: ${m.next.title}` : 'up to date';
  return `AutoDE: ${m.problemId} · ${m.progress.done}/${m.progress.total} · ${attention}`;
}

export const STATUS_ICON: Record<string, string> = { done: 'pass', ready: 'arrow-right', 'in-progress': 'sync', 'awaiting-approval': 'question', 'awaiting-check': 'question', pending: 'circle-outline', stale: 'warning', skipped: 'circle-slash' };
