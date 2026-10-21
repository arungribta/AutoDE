import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml } from '../context/Yaml';
import { computeRevision } from '../context/contextStore';
import { DecisionStore } from '../decisions/decisionStore';
import { STAGE_KINDS, StageKind } from './stageKinds';
import { StageStatus, WorkflowInstance, WorkflowStage, readWorkflow, writeWorkflow } from './instance';

/**
 * The workflow runtime (PA3a) — the hub. Deterministic: it decides what comes
 * next, which stages are blocked and why, and when a stage is stale. Stages
 * whose output is a document with its own approval (the specification, the
 * contexts, the mapping, the Pipeline Spec) take their state from that
 * document, so the panel, the CLI and MCP can't disagree; the other stages
 * are approved through `gate` decisions. Nothing here calls a model.
 */

/** Stage kinds whose output is a document that carries its own approval status. */
const DOCUMENT_STAGES: Partial<Record<StageKind, string[]>> = {
  'specify': ['spec', 'business-problem.yaml'],
  'target-context': ['context', 'target-context.yaml'],
  'source-assessment': ['context', 'source-context.yaml'],
  'mapping': ['context', 'mapping-context.yaml'],
  'build': ['spec', 'pipeline.yaml']
};

/** Artifact → the document holding it, for revisions (staleness). */
const DOCUMENT_ARTIFACTS: Record<string, string[]> = {
  'spec': ['spec', 'business-problem.yaml'],
  'target-context': ['context', 'target-context.yaml'],
  'source-context': ['context', 'source-context.yaml'],
  'mapping': ['context', 'mapping-context.yaml'],
  'pipeline-spec': ['spec', 'pipeline.yaml']
};

export interface RuntimeContext {
  workspaceRoot: string;
  problemRoot: string;
  problemId: string;
  now?: () => Date;
}

function readDoc(problemRoot: string, rel: string[]): { text: string; doc: Record<string, unknown> } | undefined {
  try {
    const text = fs.readFileSync(path.join(problemRoot, ...rel), 'utf8');
    const doc = parseYaml(text) as Record<string, unknown>;
    return doc && typeof doc === 'object' ? { text, doc } : undefined;
  } catch { return undefined; }
}

/** The document-backed stage's own state: missing, drafted, or approved. */
function documentState(problemRoot: string, kind: StageKind): 'missing' | 'drafted' | 'approved' {
  const rel = DOCUMENT_STAGES[kind];
  if (!rel) return 'missing';
  const d = readDoc(problemRoot, rel);
  if (!d) return 'missing';
  const status = String(d.doc.status ?? '');
  if (kind === 'specify') return status === 'approved' && d.doc.problemStatementApproved === true ? 'approved' : 'drafted';
  return status === 'approved' || status === 'not_applicable' ? 'approved' : 'drafted';
}

/** The current revision of an artifact a stage consumed: a document's content, or the gate decision that approved its producer. */
function artifactRevision(ctx: RuntimeContext, w: WorkflowInstance, artifact: string): string {
  const rel = DOCUMENT_ARTIFACTS[artifact];
  if (rel) { const d = readDoc(ctx.problemRoot, rel); return d ? computeRevision(d.text) : 'none'; }
  if (artifact === 'workflow') return w.decisionId ?? w.approvedAt ?? 'draft';
  const producer = w.stages.find((s) => s.included && s.produces.includes(artifact as never));
  return producer ? `${producer.id}@${producer.record.decisionId ?? producer.record.approvedAt ?? 'none'}` : 'external';
}

function inputsOf(ctx: RuntimeContext, w: WorkflowInstance, s: WorkflowStage): Record<string, string> {
  return Object.fromEntries(s.consumes.map((a) => [a, artifactRevision(ctx, w, a)]));
}

function gateApproved(ctx: RuntimeContext, decisionId: string | undefined): { approved: boolean; rejected: boolean; by?: string } {
  if (!decisionId) return { approved: false, rejected: false };
  try {
    const d = new DecisionStore(ctx.workspaceRoot).get(decisionId);
    return { approved: d.status === 'approved' || d.status === 'applied', rejected: d.status === 'rejected', by: d.resolution.by || undefined };
  } catch { return { approved: false, rejected: false }; }
}

const isDone = (s: WorkflowStage) => s.record.status === 'done';
const isDrafted = (s: WorkflowStage) => ['awaiting-check', 'awaiting-approval', 'done'].includes(s.record.status);

export interface StageView {
  id: string;
  title: string;
  kind: StageKind;
  status: StageStatus;
  inclusion: string;
  origin: string;
  /** Why it's pending, blocked, stale or skipped. */
  why?: string;
  agent?: WorkflowStage['agent'];
  tasks: WorkflowStage['tasks'];
  decisionId?: string;
}

export interface WorkflowStatus {
  problemId: string;
  template: string;
  approved: boolean;
  stages: StageView[];
  /** What to do now: the first stage that is ready, in progress, stale, or waiting for a person. */
  next?: StageView;
  warnings: string[];
}

/**
 * Brings the instance up to date with the documents and decisions (newly
 * approved stages record their inputs; changed inputs make a stage stale),
 * saves it when anything changed, and reports the status.
 */
export function syncWorkflow(ctx: RuntimeContext): WorkflowStatus | undefined {
  const w = readWorkflow(ctx.problemRoot);
  if (!w) return undefined;
  const before = JSON.stringify(w.stages.map((s) => s.record));
  const now = (ctx.now ?? (() => new Date()))().toISOString();
  const warnings: string[] = [];
  const byId = new Map(w.stages.map((s) => [s.id, s]));
  const approvedPlan = w.status === 'approved';
  for (const s of w.stages) {
    if (!s.included || s.record.status === 'skipped') continue;
    const r = s.record;
    // Approval, from the document or the gate decision; a stale stage needs its gate decision again.
    let approved = false;
    let approvedBy: string | undefined;
    if (s.kind === 'plan') approved = approvedPlan;
    else if (DOCUMENT_STAGES[s.kind] && r.status !== 'stale') {
      const st = documentState(ctx.problemRoot, s.kind);
      approved = st === 'approved';
      if (!approved && st === 'drafted' && r.status !== 'done') r.status = 'awaiting-approval';
      if (st === 'missing' && r.status === 'awaiting-approval') r.status = 'pending';
      if (!approved && r.status === 'done') { r.status = st === 'drafted' ? 'awaiting-approval' : 'pending'; r.approvedAt = undefined; }
    }
    if (r.decisionId && !approved) {
      const g = gateApproved(ctx, r.decisionId);
      if (g.approved) { approved = true; approvedBy = g.by; }
      else if (g.rejected) { r.status = 'in-progress'; r.reason = 'its approval was rejected'; r.decisionId = undefined; }
    }
    if (approved && r.status !== 'done') {
      r.status = 'done'; r.approvedAt = now; r.approvedBy = approvedBy ?? r.approvedBy; r.inputs = inputsOf(ctx, w, s); r.reason = undefined;
      continue;
    }
    if (r.status === 'done') {
      const current = inputsOf(ctx, w, s);
      const changed = Object.keys(current).filter((a) => r.inputs && r.inputs[a] !== undefined && r.inputs[a] !== current[a]);
      if (changed.length) { r.status = 'stale'; r.reason = `${changed.join(', ')} changed since it was approved`; r.decisionId = undefined; }
      continue;
    }
    if (['stale', 'awaiting-approval', 'awaiting-check', 'in-progress'].includes(r.status)) continue;
    // Pending or ready: are its dependencies met?
    const unmet = s.after.filter((d) => { const dep = byId.get(d.stage); return dep && dep.included && dep.record.status !== 'skipped' && !(d.approved ? isDone(dep) : isDrafted(dep)); });
    const needsPlan = s.kind !== 'specify' && s.kind !== 'plan' && !approvedPlan;
    r.status = unmet.length || needsPlan ? 'pending' : 'ready';
    r.reason = needsPlan ? 'the workflow is not approved yet' : unmet.length ? `waits for ${unmet.map((d) => `${d.stage}${d.approved ? ' (approved)' : ''}`).join(', ')}` : undefined;
  }
  if (JSON.stringify(w.stages.map((s) => s.record)) !== before) writeWorkflow(ctx.problemRoot, w);
  return statusOf(w, warnings);
}

function view(s: WorkflowStage): StageView {
  return { id: s.id, title: s.title, kind: s.kind, status: s.included ? s.record.status : 'skipped', inclusion: s.inclusion, origin: s.origin, why: s.included ? s.record.reason : s.reason ?? 'not in this workflow', agent: s.agent, tasks: s.tasks, decisionId: s.record.decisionId };
}

export function statusOf(w: WorkflowInstance, warnings: string[] = []): WorkflowStatus {
  const stages = w.stages.map(view);
  const order: StageStatus[] = ['stale', 'in-progress', 'ready', 'awaiting-approval', 'awaiting-check'];
  let next: StageView | undefined;
  for (const st of order) { next = stages.find((s) => s.status === st && w.stages.find((x) => x.id === s.id)?.included); if (next) break; }
  return { problemId: w.problemId, template: `${w.template.id} v${w.template.version}`, approved: w.status === 'approved', stages, next, warnings };
}

export class WorkflowError extends Error {
  public constructor(public readonly code: 'NOT_FOUND' | 'NOT_ALLOWED' | 'NOT_READY' | 'CHECK_FAILED', message: string) { super(message); this.name = 'WorkflowError'; }
}

function load(ctx: RuntimeContext): WorkflowInstance {
  syncWorkflow(ctx);
  const w = readWorkflow(ctx.problemRoot);
  if (!w) throw new WorkflowError('NOT_FOUND', 'This problem has no workflow yet: plan it (autode workflow draft, or the planning stage).');
  return w;
}

function stageOf(w: WorkflowInstance, id: string): WorkflowStage {
  const s = w.stages.find((x) => x.id === id);
  if (!s) throw new WorkflowError('NOT_FOUND', `No stage "${id}" (stages: ${w.stages.map((x) => x.id).join(', ')}).`);
  if (!s.included) throw new WorkflowError('NOT_ALLOWED', `${id} is not in this workflow${s.reason ? ` (${s.reason})` : ''}; re-plan to add it.`);
  return s;
}

/** Marks a stage in progress. Working ahead of its dependencies is allowed and recorded with a warning (gates block promotion, not work). */
export function startStage(ctx: RuntimeContext, id: string, by: string): { stage: StageView; warning?: string } {
  const w = load(ctx);
  const s = stageOf(w, id);
  if (s.record.status === 'done') throw new WorkflowError('NOT_ALLOWED', `${id} is done; re-open it to change it.`);
  const warning = s.record.status === 'pending' ? `${id} is being worked on ahead of its dependencies (${s.record.reason ?? 'not ready'}); it can't be approved until they are.` : undefined;
  s.record = { ...s.record, status: 'in-progress', startedAt: (ctx.now ?? (() => new Date()))().toISOString(), by };
  writeWorkflow(ctx.problemRoot, w);
  return { stage: view(s), warning };
}

/**
 * Hands in a stage whose output is not a self-approving document (or a stale
 * one): its check runs (the outputs exist), then a gate decision is created
 * for a person if the stage has an approve gate; otherwise it is done.
 */
export function completeStage(ctx: RuntimeContext, id: string, input: { outputs: string[]; summary: string; by: string; host?: string }): { stage: StageView; decisionId?: string; message: string } {
  const w = load(ctx);
  const s = stageOf(w, id);
  if (s.record.status === 'done') throw new WorkflowError('NOT_ALLOWED', `${id} is already done.`);
  const unmet = s.after.filter((d) => { const dep = w.stages.find((x) => x.id === d.stage); return dep && dep.included && dep.record.status !== 'skipped' && !(d.approved ? isDone(dep) : isDrafted(dep)); });
  if (unmet.length) throw new WorkflowError('NOT_READY', `${id} can't be handed in yet: it waits for ${unmet.map((d) => d.stage).join(', ')}.`);
  if (DOCUMENT_STAGES[s.kind] && s.record.status !== 'stale') {
    return { stage: view(s), message: `${id} completes when its document is approved: ${DOCUMENT_STAGES[s.kind]!.join('/')} (AutoDE panel, or the matching proposal and its decision).` };
  }
  const missing = input.outputs.filter((o) => !fs.existsSync(path.resolve(ctx.workspaceRoot, o)));
  // Named outputs must exist whatever the gates: an approver should never be shown a file that isn't there.
  if (missing.length) throw new WorkflowError('CHECK_FAILED', `${id}'s check failed: ${missing.join(', ')} not found.`);
  if (s.gates.includes('check') && !input.outputs.length && s.record.status !== 'stale') throw new WorkflowError('CHECK_FAILED', `${id}'s check failed: name the files it produced.`);
  const now = (ctx.now ?? (() => new Date()))().toISOString();
  s.record.outputs = input.outputs;
  s.record.completedAt = now;
  if (!s.gates.includes('approve')) {
    s.record = { ...s.record, status: 'done', approvedAt: now, inputs: inputsOf(ctx, w, s), reason: undefined };
    writeWorkflow(ctx.problemRoot, w);
    return { stage: view(s), message: `${id} is done (no approval gate).` };
  }
  const store = new DecisionStore(ctx.workspaceRoot);
  const kindSpec = STAGE_KINDS[s.kind];
  const d = store.create({
    kind: 'gate', title: `Approve stage ${s.title}${s.record.status === 'stale' ? ' again (inputs changed)' : ''}`, summary: input.summary,
    proposal: { problemId: ctx.problemId, stageId: s.id, kind: s.kind, outputs: input.outputs, summary: input.summary, doneWhen: kindSpec.doneWhen, reapproval: s.record.status === 'stale' },
    proposedBy: { host: input.host ?? 'cli', client: input.by }, validation: { ok: true, errors: [], warnings: [], checks: [`outputs exist: ${input.outputs.join(', ') || '(re-approval)'}`] },
    problemId: ctx.problemId, subject: { document: `workflow:${s.id}` }
  });
  s.record = { ...s.record, status: 'awaiting-approval', decisionId: d.id };
  writeWorkflow(ctx.problemRoot, w);
  return { stage: view(s), decisionId: d.id, message: `${id} waits for a person's approval: decision ${d.id}.` };
}

/** Skips a default, conditional or optional stage, with a reason. A mandatory stage can't be skipped. */
export function skipStage(ctx: RuntimeContext, id: string, reason: string, by: string): StageView {
  const w = load(ctx);
  const s = stageOf(w, id);
  if (s.inclusion === 'mandatory' || s.kind === 'specify' || s.kind === 'plan') throw new WorkflowError('NOT_ALLOWED', `${id} is mandatory and can't be skipped.`);
  if (!reason.trim()) throw new WorkflowError('NOT_ALLOWED', 'A skip needs a reason.');
  const dependents = w.stages.filter((x) => x.included && x.record.status !== 'skipped' && x.after.some((d) => d.stage === id) && x.consumes.some((a) => s.produces.includes(a)));
  if (dependents.length) throw new WorkflowError('NOT_ALLOWED', `${id} produces what ${dependents.map((x) => x.id).join(', ')} consume; re-plan instead.`);
  s.record = { ...s.record, status: 'skipped', reason: reason.trim(), by };
  writeWorkflow(ctx.problemRoot, w);
  return view(s);
}

/** Re-opens a done stage; everything downstream of it becomes stale (no loops in the language). */
export function reopenStage(ctx: RuntimeContext, id: string, by: string, reason: string): { stage: StageView; stale: string[] } {
  const w = load(ctx);
  const s = stageOf(w, id);
  if (s.record.status !== 'done' && s.record.status !== 'stale') throw new WorkflowError('NOT_ALLOWED', `${id} is ${s.record.status}, not done.`);
  s.record = { status: 'in-progress', startedAt: (ctx.now ?? (() => new Date()))().toISOString(), by, reason: `re-opened: ${reason}` };
  const stale: string[] = [];
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const x of w.stages) {
      if (!x.included || stale.includes(x.id) || x.id === id) continue;
      if (x.after.some((d) => d.stage === cur) && x.record.status === 'done') { x.record = { ...x.record, status: 'stale', reason: `${id} was re-opened`, decisionId: undefined }; stale.push(x.id); queue.push(x.id); }
    }
  }
  writeWorkflow(ctx.problemRoot, w);
  return { stage: view(s), stale };
}

/** What the hub hands to a spoke: the next assignment. */
export function nextAssignment(ctx: RuntimeContext): { stage: StageView; consumes: string[]; produces: string[]; doneWhen: string; instructions: string } | undefined {
  const status = syncWorkflow(ctx);
  if (!status?.next) return undefined;
  const w = readWorkflow(ctx.problemRoot)!;
  const s = w.stages.find((x) => x.id === status.next!.id)!;
  const kind = STAGE_KINDS[s.kind];
  const instructions = s.record.status === 'awaiting-approval'
    ? `Stage ${s.id} waits for a person's approval${s.record.decisionId ? ` (decision ${s.record.decisionId})` : ''}: tell the user how to approve it.`
    : s.record.status === 'stale'
      ? `Stage ${s.id} is stale (${s.record.reason}). Review its output against the changed inputs, update it, and hand it in again.`
      : `Do stage ${s.id} (${s.kind}) as role ${s.agent?.role ?? kind.roles[0]}${s.agent?.tier ? `, at most ${s.agent.tier}` : ''}: it produces ${s.produces.join(', ')}. Done when ${kind.doneWhen}.${s.agent?.brief ? `\n\n${s.agent.brief}` : ''}`;
  return { stage: view(s), consumes: s.consumes, produces: s.produces, doneWhen: kind.doneWhen, instructions };
}
