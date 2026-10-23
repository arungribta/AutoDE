import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml, stringifyYaml } from '../context/Yaml';
import { checkSingleStatement } from '../platform/sqlGuard';
import { foreignDialect } from '../platform/dialectMarkers';
import { ConnectionEntry } from '../platform/connectionsConfig';
import { EnvironmentPolicy, RunbookPolicy, StepClass, approvalsNeeded, approverProblem, environmentOf } from './policy';

/**
 * Runbooks (v0.45.6; owner, 2026-10-22): everything that changes a data
 * platform. An agent writes one; the engine checks it — its own
 * classification of every step, the CLI allowlist, arguments, rollback — a
 * person approves it under the team's policy; the runner runs it step by step.
 * The approval is bound to the runbook's content: an edited runbook needs
 * approving again.
 */

export type StepKind = 'sql' | 'cli' | 'bundle';

export interface RunbookStep {
  id: string;
  title: string;
  kind: StepKind;
  /** `sql`: one statement on the runbook's connection. */
  sql?: string;
  /** `cli`: the command as an argument list (never a shell string), without profile or credential flags: the runner adds the profile. */
  argv?: string[];
  /** `bundle` (Databricks): the bundle folder, workspace-relative, and its target. */
  folder?: string;
  target?: string;
  /** What the step is expected to do, for the reviewer. */
  expect: string;
  /** A step or a written procedure that undoes it. */
  rollback?: { steps?: RunbookStep[]; procedure?: string };
  /** Why a destructive step has no rollback. */
  noRollbackReason?: string;
  timeoutSec?: number;
}

export interface Runbook {
  id: string;
  title: string;
  /** Why it is needed. */
  reason: string;
  connectionId: string;
  /** The workflow stage it belongs to (deploy, platform-setup …), if any. */
  stage?: string;
  steps: RunbookStep[];
  /** The agent's plain-language explanation, shown labelled as such. */
  explanation?: string;
}

export interface CheckedStep {
  id: string;
  title: string;
  kind: StepKind;
  /** The engine's classification, never the agent's. */
  class: StepClass;
  /** What the runner will run: the statement, or the full argv with the profile added. */
  run: { sql?: string; argv?: string[]; cwd?: string };
  /** The dry run the runner can do, if any. */
  dryRun?: { sql?: string; argv?: string[]; cwd?: string; label: string };
  rollback?: { steps?: CheckedStep[]; procedure?: string };
}

export interface RunbookCheck { ok: boolean; errors: string[]; warnings: string[]; steps: CheckedStep[]; environment: EnvironmentPolicy; revision: string }

/** VACUUM deletes the files that time travel and a restore would need (v0.45.11). */
const DESTRUCTIVE = new Set(['DROP', 'TRUNCATE', 'DELETE', 'REVOKE', 'VACUUM']);
const PATH_PREFIX = /^(@|dbfs:|s3:|s3a:|gs:|abfss?:|wasbs?:|https?:|volumes?:|\/Volumes\/|\/Workspace\/)/i;

/** AutoDE's CLI allowlist: reviewed like code. A team adds its own commands in its policy. */
export const CLI_ALLOWLIST: ReadonlyArray<{ argv: string[]; class: StepClass; platform: 'snowflake' | 'databricks' }> = [
  { argv: ['snow', 'connection', 'test'], class: 'read', platform: 'snowflake' },
  { argv: ['snow', 'object', 'list'], class: 'read', platform: 'snowflake' },
  { argv: ['snow', 'object', 'describe'], class: 'read', platform: 'snowflake' },
  { argv: ['snow', 'stage', 'list-files'], class: 'read', platform: 'snowflake' },
  { argv: ['snow', 'stage', 'copy'], class: 'change', platform: 'snowflake' },
  { argv: ['snow', 'dbt', 'list'], class: 'read', platform: 'snowflake' },
  { argv: ['snow', 'dbt', 'deploy'], class: 'change', platform: 'snowflake' },
  { argv: ['snow', 'dbt', 'execute'], class: 'change', platform: 'snowflake' },
  { argv: ['databricks', 'current-user', 'me'], class: 'read', platform: 'databricks' },
  { argv: ['databricks', 'catalogs', 'list'], class: 'read', platform: 'databricks' },
  { argv: ['databricks', 'catalogs', 'get'], class: 'read', platform: 'databricks' },
  { argv: ['databricks', 'schemas', 'list'], class: 'read', platform: 'databricks' },
  { argv: ['databricks', 'schemas', 'get'], class: 'read', platform: 'databricks' },
  { argv: ['databricks', 'tables', 'list'], class: 'read', platform: 'databricks' },
  { argv: ['databricks', 'tables', 'get'], class: 'read', platform: 'databricks' },
  { argv: ['databricks', 'jobs', 'list'], class: 'read', platform: 'databricks' },
  { argv: ['databricks', 'jobs', 'get'], class: 'read', platform: 'databricks' },
  { argv: ['databricks', 'jobs', 'run-now'], class: 'change', platform: 'databricks' },
  { argv: ['databricks', 'fs', 'ls'], class: 'read', platform: 'databricks' },
  { argv: ['databricks', 'fs', 'cp'], class: 'change', platform: 'databricks' },
  { argv: ['databricks', 'pipelines', 'list-pipelines'], class: 'read', platform: 'databricks' },
  { argv: ['databricks', 'pipelines', 'get'], class: 'read', platform: 'databricks' },
  { argv: ['databricks', 'pipelines', 'start-update'], class: 'change', platform: 'databricks' },
  { argv: ['databricks', 'bundle', 'validate'], class: 'read', platform: 'databricks' },
  { argv: ['databricks', 'bundle', 'summary'], class: 'read', platform: 'databricks' },
  { argv: ['databricks', 'bundle', 'deploy'], class: 'change', platform: 'databricks' },
  { argv: ['databricks', 'bundle', 'run'], class: 'change', platform: 'databricks' },
  { argv: ['databricks', 'bundle', 'destroy'], class: 'destructive', platform: 'databricks' }
];

/** Flags the runner owns or that would carry credentials: never in a runbook. */
const FORBIDDEN_FLAG = /^--?(c|p|connection|profile|password|token|private-key|private-key-path|private-key-file|authenticator|account|user|host|client-secret|oauth.*|account-id)(=.*)?$/i;
const SECRET_VALUE = /(dapi[0-9a-f]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bpassword=|\btoken=|\bsecret=)/i;

export function classifySql(sql: string): { class?: StepClass; problem?: string } {
  const c = checkSingleStatement(sql);
  if (!c.ok) return { problem: c.reason };
  if (c.kind !== 'write') return { class: 'read' };
  const first = (c.firstKeyword ?? '').toUpperCase();
  const text = sql.replace(/'(?:[^']|'')*'/g, "''");
  if (DESTRUCTIVE.has(first) || (first === 'CREATE' && /\bOR\s+REPLACE\b/i.test(text)) || (first === 'ALTER' && /\b(DROP|SWAP\s+WITH|RENAME)\b/i.test(text)) || /\bOVERWRITE\b/i.test(text)) return { class: 'destructive' };
  return { class: 'change' };
}

export function runbookRevision(rb: Runbook): string {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify({ ...rb, explanation: undefined })).digest('hex');
}

function insideWorkspace(workspaceRoot: string, p: string): boolean {
  const abs = path.resolve(workspaceRoot, p);
  const rel = path.relative(workspaceRoot, abs);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

interface CheckCtx { workspaceRoot: string; connections: readonly ConnectionEntry[]; policy: RunbookPolicy }

function checkStep(s: RunbookStep, entry: ConnectionEntry | undefined, ctx: CheckCtx, where: string, errors: string[]): CheckedStep | undefined {
  const at = `${where} ${s?.id ?? '?'}`;
  if (!s || typeof s !== 'object' || !s.id || !/^[A-Za-z0-9_.-]+$/.test(s.id)) { errors.push(`${where}: every step needs an id (letters, digits, dots, dashes).`); return undefined; }
  if (!s.title?.trim()) errors.push(`${at}: a title is required.`);
  if (!s.expect?.trim()) errors.push(`${at}: say what it is expected to do (expect).`);
  const timeout = s.timeoutSec;
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600)) errors.push(`${at}: timeoutSec is 1 to 3600.`);
  if (s.kind === 'sql') {
    if (!s.sql?.trim()) { errors.push(`${at}: a sql step needs its statement.`); return undefined; }
    const c = classifySql(s.sql);
    if (!c.class) { errors.push(`${at}: ${c.problem}`); return undefined; }
    const dry = c.class === 'read' ? undefined : { sql: s.sql, label: 'EXPLAIN on the connection (the platform compiles it without running it)' };
    return { id: s.id, title: s.title, kind: 'sql', class: c.class, run: { sql: s.sql }, dryRun: dry };
  }
  if (s.kind === 'cli' || s.kind === 'bundle') {
    if (!entry) return undefined;
    const tool = entry.platform === 'snowflake' ? 'snow' : entry.platform === 'databricks' ? 'databricks' : undefined;
    if (!tool) { errors.push(`${at}: CLI steps run against Snowflake or Databricks connections; ${entry.id} is ${entry.platform}.`); return undefined; }
    if (entry.credentials.resolver !== 'cli') errors.push(`${at}: CLI steps need a connection whose credentials come from the CLI's own configuration (resolver cli); ${entry.id} uses ${entry.credentials.resolver}.`);
    const profile = tool === 'snow' ? ['--connection', entry.credentials.ref] : ['--profile', entry.credentials.ref];
    if (s.kind === 'bundle') {
      if (tool !== 'databricks') { errors.push(`${at}: bundle steps are Databricks bundles; use cli or sql steps for Snowflake.`); return undefined; }
      if (!s.folder || !insideWorkspace(ctx.workspaceRoot, s.folder)) { errors.push(`${at}: the bundle folder must be inside the workspace.`); return undefined; }
      const cwd = path.resolve(ctx.workspaceRoot, s.folder);
      if (!fs.existsSync(path.join(cwd, 'databricks.yml'))) errors.push(`${at}: ${s.folder} has no databricks.yml.`);
      const t = s.target ? ['--target', s.target] : [];
      return { id: s.id, title: s.title, kind: 'bundle', class: 'change', run: { argv: ['databricks', 'bundle', 'deploy', ...t, ...profile], cwd }, dryRun: { argv: ['databricks', 'bundle', 'validate', ...t, ...profile], cwd, label: 'databricks bundle validate' } };
    }
    const argv = Array.isArray(s.argv) ? s.argv.map(String) : [];
    if (!argv.length) { errors.push(`${at}: a cli step needs argv, a list.`); return undefined; }
    if (argv[0] !== tool) { errors.push(`${at}: ${entry.id} is a ${entry.platform} connection, so the command starts with ${tool}.`); return undefined; }
    const allowed = [...CLI_ALLOWLIST.filter((a) => a.platform === entry.platform), ...ctx.policy.allowCommands]
      .filter((a) => a.argv.every((w, i) => argv[i] === w)).sort((a, b) => b.argv.length - a.argv.length)[0];
    if (!allowed) { errors.push(`${at}: \`${argv.slice(0, 3).join(' ')}\` is not on the allowlist (AutoDE's, or the team's runbooks.allowCommands).`); return undefined; }
    for (const a of argv.slice(allowed.argv.length)) {
      if (FORBIDDEN_FLAG.test(a)) errors.push(`${at}: ${a.split('=')[0]} is not allowed: the runner adds the connection's profile, and credentials never go in a runbook.`);
      if (SECRET_VALUE.test(a)) errors.push(`${at}: an argument looks like a credential.`);
      if (!a.startsWith('-') && !PATH_PREFIX.test(a) && /[\\/]/.test(a) && !insideWorkspace(ctx.workspaceRoot, a)) errors.push(`${at}: ${a} is outside the workspace.`);
    }
    return { id: s.id, title: s.title, kind: 'cli', class: allowed.class, run: { argv: [...argv, ...profile], cwd: ctx.workspaceRoot } };
  }
  errors.push(`${at}: kind is sql, cli or bundle.`);
  return undefined;
}

export function checkRunbook(rb: Runbook, ctx: CheckCtx): RunbookCheck {
  const errors: string[] = [...ctx.policy.errors];
  const warnings: string[] = [];
  if (!rb || typeof rb !== 'object') return { ok: false, errors: ['a runbook must be an object.'], warnings, steps: [], environment: environmentOf(ctx.policy, ''), revision: '' };
  if (!rb.id || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(rb.id)) errors.push('id is lowercase letters, digits and dashes (2 to 63).');
  if (!rb.title?.trim()) errors.push('a title is required.');
  if (!rb.reason?.trim()) errors.push('say why it is needed (reason).');
  const entry = ctx.connections.find((c) => c.id === rb.connectionId);
  if (!entry) errors.push(`connection ${rb.connectionId} is not configured (autode connections list).`);
  if (!Array.isArray(rb.steps) || !rb.steps.length) errors.push('a runbook needs at least one step.');
  const env = environmentOf(ctx.policy, rb.connectionId);
  const ids = new Set<string>();
  const steps: CheckedStep[] = [];
  for (const s of rb.steps ?? []) {
    if (s?.id && ids.has(s.id)) errors.push(`step ${s.id} is defined twice.`);
    ids.add(s?.id);
    const c = checkStep(s, entry, ctx, 'step', errors);
    if (!c) continue;
    if (!env.allowedClasses.includes(c.class)) errors.push(`step ${s.id}: ${c.class} steps are not allowed in ${env.name}.`);
    if (s.rollback?.steps?.length || s.rollback?.procedure) {
      const rs = (s.rollback.steps ?? []).map((r) => checkStep(r, entry, ctx, `step ${s.id} rollback`, errors)).filter((x): x is CheckedStep => !!x);
      c.rollback = { steps: rs.length ? rs : undefined, procedure: s.rollback.procedure };
    } else if (c.class === 'destructive' && !s.noRollbackReason?.trim()) errors.push(`step ${s.id} is destructive: give its rollback (steps or a procedure), or noRollbackReason.`);
    const foreign = s.kind === 'sql' && entry ? foreignDialect(s.sql ?? '', entry.platform) : [];
    if (foreign.length) warnings.push(`step ${s.id} looks like ${entry!.platform === 'snowflake' ? 'Databricks' : 'Snowflake'} SQL (${foreign.join('; ')}), but ${entry!.id} is a ${entry!.platform} connection: its dry run will likely fail.`);
    if (c.class !== 'read' && !c.dryRun) warnings.push(`step ${s.id} has no dry run: it is reviewed from its description and the command.`);
    steps.push(c);
  }
  return { ok: errors.length === 0, errors, warnings, steps, environment: env, revision: runbookRevision(rb) };
}

// ── The record: the approved runbook and its run state ──────────────────────

export type RunbookStatus = 'awaiting-approval' | 'awaiting-second-approval' | 'approved' | 'running' | 'ran' | 'failed' | 'rolled-back';
export type StepState = 'pending' | 'dry-run-ok' | 'dry-run-failed' | 'done' | 'failed' | 'rolled-back' | 'rollback-failed';

export interface RunbookRecord {
  runbook: Runbook;
  revision: string;
  environment: string;
  status: RunbookStatus;
  decisionId?: string;
  problemId: string;
  approvals: Array<{ by: string; at: string; channel: string; revision: string }>;
  steps: Record<string, { state: StepState; at?: string; output?: string }>;
  createdBy?: string;
}

export function runbooksDir(problemRoot: string): string { return path.join(problemRoot, 'runbooks'); }
export function runbookFile(problemRoot: string, id: string): string { return path.join(runbooksDir(problemRoot), `${id}.yaml`); }
export function runLogFile(problemRoot: string, id: string): string { return path.join(problemRoot, 'runs', `${id}.jsonl`); }

export function readRunbook(problemRoot: string, id: string): RunbookRecord | undefined {
  try { return parseYaml(fs.readFileSync(runbookFile(problemRoot, id), 'utf8')) as RunbookRecord; } catch { return undefined; }
}

export function writeRunbook(problemRoot: string, r: RunbookRecord): void {
  fs.mkdirSync(runbooksDir(problemRoot), { recursive: true });
  fs.writeFileSync(runbookFile(problemRoot, r.runbook.id), '# AutoDE runbook: approved by a person, run by AutoDE\'s runner. Editing it voids its approvals.\n' + stringifyYaml(r as unknown as Record<string, unknown>));
}

export function listRunbooks(problemRoot: string): RunbookRecord[] {
  try { return fs.readdirSync(runbooksDir(problemRoot)).filter((f) => f.endsWith('.yaml')).map((f) => readRunbook(problemRoot, f.slice(0, -5))).filter((r): r is RunbookRecord => !!r); } catch { return []; }
}

/** The approvals that still count: given by allowed people to this revision. */
export function validApprovals(r: RunbookRecord): RunbookRecord['approvals'] {
  return r.approvals.filter((a) => a.revision === runbookRevision(r.runbook));
}

/** Records a person's approval under the policy; returns the record, or why it can't. */
export function approveRunbook(problemRoot: string, r: RunbookRecord, who: string, channel: string, policy: RunbookPolicy, now = new Date()): { record?: RunbookRecord; problem?: string } {
  if (r.revision !== runbookRevision(r.runbook)) return { problem: 'The runbook was changed after it was checked: propose it again.' };
  const env = environmentOf(policy, r.runbook.connectionId);
  const earlier = validApprovals(r).map((a) => a.by);
  const problem = approverProblem(env, who, earlier);
  if (problem) return { problem };
  const approvals = [...validApprovals(r), { by: who, at: now.toISOString(), channel, revision: r.revision }];
  const status: RunbookStatus = approvals.length >= approvalsNeeded(env) ? 'approved' : 'awaiting-second-approval';
  const record = { ...r, environment: env.name, approvals, status };
  writeRunbook(problemRoot, record);
  return { record };
}

/** Whether the runbook may run now, and why not. */
export function runnableProblem(r: RunbookRecord, policy: RunbookPolicy): string | undefined {
  if (r.revision !== runbookRevision(r.runbook)) return 'The runbook was edited after it was approved: its approvals no longer count. Propose it again.';
  const env = environmentOf(policy, r.runbook.connectionId);
  if (env.name !== r.environment) return `The team's policy now puts ${r.runbook.connectionId} in ${env.name}, not ${r.environment}: approve it again.`;
  const valid = validApprovals(r).filter((a) => !approverProblem(env, a.by, []));
  if (valid.length < approvalsNeeded(env)) return `${env.name} needs ${approvalsNeeded(env)} approval(s) from its approvers; it has ${valid.length}.`;
  return undefined;
}
