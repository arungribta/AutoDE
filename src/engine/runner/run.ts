import * as path from 'node:path';
import { ConnectionEntry } from '../platform/connectionsConfig';
import { completeStage } from '../workflows/runtime';
import { RunbookPolicy, environmentOf } from './policy';
import { CheckedStep, RunbookRecord, StepState, checkRunbook, readRunbook, runLogFile, runbookFile, runnableProblem, writeRunbook } from './runbook';
import { appendRunLog } from './runLog';
import { explorationEnvironmentProblem } from '../documents/problemMode';

/**
 * The runner (v0.45.6): deterministic code that runs an approved runbook's
 * steps, in order, one per request — a dry run first where the step has one —
 * through a host that knows how to reach the platform (the connector for SQL,
 * the user's own CLI profile for commands). It stops at the first failure and
 * offers the step's rollback. Every action is logged, hash-chained. No model is
 * involved anywhere here.
 */

export interface RunnerHost {
  /** `read`: a read-only statement; `write`: an approved change; `explain`: EXPLAIN it. Returns a short result. */
  sql(connectionId: string, sql: string, mode: 'read' | 'write' | 'explain'): Promise<string>;
  /** Runs an argv (no shell) and returns its exit code and output. */
  cli(argv: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export interface RunInput {
  workspaceRoot: string;
  problemRoot: string;
  runbookId: string;
  action: 'dry-run' | 'run' | 'rollback';
  /** The step; for `run`, defaults to the next one. */
  stepId?: string;
  who: string;
  channel: string;
  host: RunnerHost;
  connections: readonly ConnectionEntry[];
  policy: RunbookPolicy;
  now?: () => Date;
}

export interface RunResult { ok: boolean; message: string; record?: RunbookRecord; step?: string; output?: string; finished?: boolean }

const MAX_OUTPUT = 2000;

/** Masks what looks like a credential before anything is logged or shown. */
export function redactRun(text: string): string {
  return String(text ?? '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED KEY]')
    .replace(/\bdapi[0-9a-f]{16,}\b/gi, '[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [REDACTED]')
    .replace(/\b(password|passwd|pwd|token|secret|client_secret|private_key)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[REDACTED]');
}

const trunc = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}… (${s.length - MAX_OUTPUT} more characters)` : s);

async function execute(step: CheckedStep, mode: 'run' | 'dry', connectionId: string, host: RunnerHost, timeoutMs: number): Promise<{ ok: boolean; command: string; output: string; exitCode?: number | null }> {
  const what = mode === 'dry' ? step.dryRun! : step.run;
  if (what.sql !== undefined) {
    const sqlMode = mode === 'dry' ? 'explain' : step.class === 'read' ? 'read' : 'write';
    try { return { ok: true, command: `${sqlMode === 'explain' ? 'EXPLAIN ' : ''}${what.sql}`, output: await host.sql(connectionId, what.sql, sqlMode) }; } catch (err) { return { ok: false, command: what.sql, output: err instanceof Error ? err.message : String(err) }; }
  }
  const argv = what.argv!;
  try {
    const r = await host.cli(argv, what.cwd ?? process.cwd(), timeoutMs);
    return { ok: r.code === 0, command: argv.join(' '), output: [r.stdout, r.stderr].filter((x) => x && x.trim()).join('\n'), exitCode: r.code };
  } catch (err) { return { ok: false, command: argv.join(' '), output: err instanceof Error ? err.message : String(err) }; }
}

export async function runStep(input: RunInput): Promise<RunResult> {
  const now = input.now ?? (() => new Date());
  const r = readRunbook(input.problemRoot, input.runbookId);
  if (!r) return { ok: false, message: `No runbook "${input.runbookId}" has been approved in this problem.` };
  const notRunnable = runnableProblem(r, input.policy) ?? explorationEnvironmentProblem(input.problemRoot, environmentOf(input.policy, r.runbook.connectionId).name);
  if (notRunnable) return { ok: false, message: notRunnable, record: r };
  // Checked again now, with today's connections and policy.
  const check = checkRunbook(r.runbook, { workspaceRoot: input.workspaceRoot, connections: input.connections, policy: input.policy });
  if (!check.ok) return { ok: false, message: `The runbook no longer passes AutoDE's checks: ${check.errors.join(' ')}`, record: r };
  const order = check.steps.map((s) => s.id);
  const nextId = order.find((id) => r.steps[id]?.state !== 'done');
  const stepId = input.stepId ?? (input.action === 'run' ? nextId : undefined);
  const step = check.steps.find((s) => s.id === stepId);
  if (!step) return { ok: false, message: stepId ? `No step "${stepId}".` : input.action === 'run' ? 'Every step has run.' : 'Name the step.', record: r };
  const log = (action: 'dry-run' | 'run' | 'rollback', res: { ok: boolean; command: string; output: string; exitCode?: number | null }, durationMs: number) =>
    appendRunLog(runLogFile(input.problemRoot, r.runbook.id), { at: now().toISOString(), runbook: r.runbook.id, revision: r.revision, step: step.id, action, who: input.who, command: redactRun(res.command), ok: res.ok, exitCode: res.exitCode, durationMs, output: trunc(redactRun(res.output)) });
  const setState = (id: string, state: StepState, output?: string) => { r.steps[id] = { state, at: now().toISOString(), ...(output !== undefined ? { output: trunc(redactRun(output)) } : {}) }; };
  const timeoutMs = 1000 * (r.runbook.steps.find((s) => s.id === step.id)?.timeoutSec ?? 600);

  if (input.action === 'dry-run') {
    if (!step.dryRun) return { ok: true, message: `${step.id} has no dry run (${step.class === 'read' ? 'it only reads' : 'review it from its command and description'}).`, record: r, step: step.id };
    const t0 = Date.now();
    const res = await execute(step, 'dry', r.runbook.connectionId, input.host, timeoutMs);
    log('dry-run', res, Date.now() - t0);
    if (r.steps[step.id]?.state !== 'done') setState(step.id, res.ok ? 'dry-run-ok' : 'dry-run-failed', res.output);
    writeRunbook(input.problemRoot, r);
    return { ok: res.ok, message: res.ok ? `Dry run of ${step.id} passed (${step.dryRun.label}).` : `Dry run of ${step.id} failed.`, record: r, step: step.id, output: trunc(redactRun(res.output)) };
  }

  if (input.action === 'rollback') {
    const st = r.steps[step.id]?.state;
    if (st !== 'done' && st !== 'failed') return { ok: false, message: `${step.id} hasn't run, so there is nothing to roll back.`, record: r };
    if (!step.rollback?.steps?.length) return { ok: false, message: step.rollback?.procedure ? `${step.id} is rolled back by hand: ${step.rollback.procedure}` : `${step.id} has no rollback.`, record: r, step: step.id };
    let ok = true; const out: string[] = [];
    for (const rs of step.rollback.steps) {
      const t0 = Date.now();
      const res = await execute(rs, 'run', r.runbook.connectionId, input.host, timeoutMs);
      log('rollback', { ...res, command: `${rs.id}: ${res.command}` }, Date.now() - t0);
      out.push(res.output);
      if (!res.ok) { ok = false; break; }
    }
    setState(step.id, ok ? 'rolled-back' : 'rollback-failed', out.join('\n'));
    r.status = ok ? 'rolled-back' : 'failed';
    writeRunbook(input.problemRoot, r);
    return { ok, message: ok ? `${step.id} rolled back.` : `The rollback of ${step.id} failed: see the log.`, record: r, step: step.id, output: trunc(redactRun(out.join('\n'))) };
  }

  // run: strictly in order.
  if (step.id !== nextId) return { ok: false, message: `Steps run in order: the next one is ${nextId}.`, record: r };
  const t0 = Date.now();
  const res = await execute(step, 'run', r.runbook.connectionId, input.host, timeoutMs);
  log('run', res, Date.now() - t0);
  setState(step.id, res.ok ? 'done' : 'failed', res.output);
  const finished = res.ok && order.every((id) => r.steps[id]?.state === 'done');
  r.status = !res.ok ? 'failed' : finished ? 'ran' : 'running';
  writeRunbook(input.problemRoot, r);
  let message = res.ok ? `${step.id} done.` : `${step.id} failed; nothing after it ran.${step.rollback ? ' Its rollback is available.' : ''}`;
  if (finished && r.runbook.stage) {
    // The stage's deliverable is the runbook and its log; its gate then goes to a person as usual.
    const rel = (f: string) => path.relative(input.workspaceRoot, f).split(path.sep).join('/');
    try {
      const done = completeStage({ workspaceRoot: input.workspaceRoot, problemRoot: input.problemRoot, problemId: r.problemId }, r.runbook.stage, { outputs: [rel(runbookFile(input.problemRoot, r.runbook.id)), rel(runLogFile(input.problemRoot, r.runbook.id))], summary: `Runbook ${r.runbook.id} ran: ${order.length} step(s) on ${r.runbook.connectionId} (${r.environment}).`, who: { kind: 'person', name: input.who }, channel: input.channel });
      message += ` Every step ran. ${done.message}`;
    } catch (err) { message += ` Every step ran; stage ${r.runbook.stage} wasn't handed in: ${err instanceof Error ? err.message : String(err)}`; }
  } else if (finished) message += ' Every step ran.';
  return { ok: res.ok, message, record: r, step: step.id, output: trunc(redactRun(res.output)), finished };
}

/** Runs the remaining steps on one request, where the environment allows it; stops at the first failure. */
export async function runRemaining(input: Omit<RunInput, 'action' | 'stepId'>): Promise<RunResult> {
  const r = readRunbook(input.problemRoot, input.runbookId);
  if (!r) return { ok: false, message: `No runbook "${input.runbookId}".` };
  const env = environmentOf(input.policy, r.runbook.connectionId);
  if (!env.unattended) return { ok: false, message: `${env.name} runs one step at a time: run each step yourself.`, record: r };
  let last: RunResult = { ok: true, message: 'Nothing to run.', record: r };
  for (;;) {
    last = await runStep({ ...input, action: 'run' });
    if (!last.ok || last.finished) return last;
  }
}
