import { DecisionStore } from '../engine/decisions/decisionStore';
import { ConnectionEntry } from '../engine/platform/connectionsConfig';
import { RunbookPolicy, environmentOf } from '../engine/runner/policy';
import { Runbook, checkRunbook, listRunbooks, readRunbook, runLogFile, runnableProblem } from '../engine/runner/runbook';
import { readRunLog, verifyRunLog } from '../engine/runner/runLog';

/**
 * What the Runbook tab shows (v0.45.6), for a runbook waiting for approval (its
 * decision) or an approved one (its record): every step with the engine's
 * classification, what exactly runs, its dry run, rollback and state; the
 * environment's policy; who approved; whether it may run now; and the log.
 * No vscode import, so it is tested in plain Node.
 */

export interface RunbookStepModel { id: string; title: string; kind: string; class: string; expect: string; runs: string; dryRun?: string; rollback?: string; state: string; output?: string }
export interface RunbookModel {
  id: string; title: string; reason: string; explanation?: string; connectionId: string; stage?: string;
  environment: { name: string; approvers: string; secondApprover: boolean; unattended: boolean };
  status: string; pendingDecisionId?: string; approvals: Array<{ by: string; at: string; channel: string }>;
  runnable: boolean; whyNot?: string; nextStep?: string;
  steps: RunbookStepModel[]; errors: string[]; warnings: string[];
  log: Array<{ seq: number; at: string; step?: string; action: string; who: string; ok: boolean; command?: string }>; logIntact: boolean; logProblem?: string;
}

export interface RunbookListItem { id: string; title: string; status: string; environment: string; decisionId?: string }

export function listRunbookItems(workspaceRoot: string, problemRoot: string, problemId: string): RunbookListItem[] {
  const store = new DecisionStore(workspaceRoot);
  const pending = store.list({ status: 'pending', kind: 'runbook' }).filter((d) => d.problemId === problemId).map((d) => {
    const rb = store.proposal<Runbook>(d.id);
    return { id: rb.id, title: rb.title, status: 'waits for approval', environment: '', decisionId: d.id };
  });
  return [...pending, ...listRunbooks(problemRoot).map((r) => ({ id: r.runbook.id, title: r.runbook.title, status: r.status, environment: r.environment }))];
}

export function buildRunbookModel(input: { workspaceRoot: string; problemRoot: string; problemId: string; id: string; connections: readonly ConnectionEntry[]; policy: RunbookPolicy }): RunbookModel | undefined {
  const record = readRunbook(input.problemRoot, input.id);
  const store = new DecisionStore(input.workspaceRoot);
  const pending = record ? undefined : store.list({ status: 'pending', kind: 'runbook' }).filter((d) => d.problemId === input.problemId).find((d) => store.proposal<Runbook>(d.id).id === input.id);
  const rb = record?.runbook ?? (pending ? store.proposal<Runbook>(pending.id) : undefined);
  if (!rb) return undefined;
  const check = checkRunbook(rb, { workspaceRoot: input.workspaceRoot, connections: input.connections, policy: input.policy });
  const env = environmentOf(input.policy, rb.connectionId);
  const text = (r: { sql?: string; argv?: string[] }) => r.sql ?? (r.argv ?? []).join(' ');
  const steps = check.steps.map((s) => {
    const src = rb.steps.find((x) => x.id === s.id)!;
    const st = record?.steps[s.id];
    return {
      id: s.id, title: s.title, kind: s.kind, class: s.class, expect: src.expect, runs: text(s.run), dryRun: s.dryRun?.label,
      rollback: s.rollback ? (s.rollback.steps?.length ? s.rollback.steps.map((r) => text(r.run)).join('; ') : s.rollback.procedure) : src.noRollbackReason ? `none: ${src.noRollbackReason}` : undefined,
      state: st?.state ?? 'pending', output: st?.output
    };
  });
  const whyNot = record ? runnableProblem(record, input.policy) : 'It waits for approval.';
  const logFile = runLogFile(input.problemRoot, rb.id);
  const v = verifyRunLog(logFile);
  return {
    id: rb.id, title: rb.title, reason: rb.reason, explanation: rb.explanation, connectionId: rb.connectionId, stage: rb.stage,
    environment: { name: env.name, approvers: env.approvers === 'any' ? 'any person' : env.approvers.join(', ') || 'none configured', secondApprover: env.secondApprover, unattended: env.unattended },
    status: record?.status ?? 'awaiting-approval', pendingDecisionId: pending?.id,
    approvals: (record?.approvals ?? []).map((a) => ({ by: a.by, at: a.at, channel: a.channel })),
    runnable: !!record && !whyNot && check.ok, whyNot: whyNot ?? (check.ok ? undefined : check.errors.join(' ')),
    nextStep: record ? check.steps.find((s) => record.steps[s.id]?.state !== 'done')?.id : undefined,
    steps, errors: check.errors, warnings: check.warnings,
    log: readRunLog(logFile).slice(-50).map((e) => ({ seq: e.seq, at: e.at, step: e.step, action: e.action, who: e.who, ok: e.ok, command: e.command })),
    logIntact: v.ok, logProblem: v.reason
  };
}
