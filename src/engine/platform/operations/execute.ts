import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { recordOperationRun } from './runLog';
import { checkReadOnlySql } from '../sqlGuard';
import { BindError, bindPlain, bindTemplate, cliReadProblem, valuesFor } from './bind';
import { mapRows } from './map';
import { HttpCall, HttpRequest } from '../httpTransport';
import { FileCall, checkGlob } from '../fileTransport';
import { ShapeError, bindHttp, httpReadProblem, readHttp } from './httpRead';
import { PlatformDefinition, PlatformImpl, PlatformOperation } from './types';

/**
 * The executor (POP1): the one place an operation becomes a statement or a
 * command and its result. It picks the connection's platform implementation
 * within its version range, binds the parameters by type, checks a read with
 * the read-only guard again, runs it, and maps the result. A platform's
 * failure is a gap with its reason, never an exception: the reads around it
 * continue. A change operation never runs here: it becomes a runbook step.
 */

export interface OperationRunner {
  /** Runs one statement on the connection (its CLI or API); rows as the platform returns them. */
  sql?(statement: string, maxRows: number): Promise<Array<Record<string, unknown>>>;
  /** Runs a command (an argument list, no shell) with the connection's environment. */
  cli?(argv: string[]): Promise<{ stdout: string }>;
  /** POP5: one call to the connection's API (authenticated and kept on its address by the transport). */
  http?: HttpCall;
  /** POP5: reads files in the connection's bound folder. */
  file?: FileCall;
}

export interface RunInput {
  operation: PlatformOperation;
  platformId: string;
  platform?: PlatformDefinition;
  params: Record<string, unknown>;
  runner: OperationRunner;
  /** The connection's platform version, when known (read once per connection: `connectionVersion`). */
  version?: string;
  maxRows?: number;
  /** POP3: record the run's outcome (never its rows) in the run log, for health and drift. */
  log?: { connection: string; via?: string; workspaceRoot?: string };
}

/** Why a run read nothing (POP3): the drift kinds raise maintenance items; the others are reported where they happen. */
export type GapKind = 'version' | 'missing-object' | 'refused' | 'failed';

export interface RunResult {
  ok: boolean;
  operation: string;
  platform: string;
  transport?: 'sql' | 'cli' | 'http' | 'file';
  /** What was run: the bound statement, or the command. */
  statement?: string;
  argv?: string[];
  rows: Array<Record<string, unknown>>;
  /** More rows than `maxRows` came back; only `maxRows` are kept. */
  truncated: boolean;
  /** Why nothing (or not everything) was read. */
  gap?: string;
  /** What kind of gap it is (POP3). */
  gapKind?: GapKind;
  version?: string;
}

/** Words any platform uses when an object or column is gone; a platform definition adds its own codes (`errors.missingObject`). */
const MISSING_OBJECT = /\b(does not exist|doesn't exist|not found|no such (table|view|column|object)|invalid identifier|unknown (column|table|view)|undefined (column|table))\b/i;

/** Whether a platform's error says an object or column the operation reads is missing (POP3 drift). */
export function isMissingObject(message: string, platform?: PlatformDefinition): boolean {
  if (MISSING_OBJECT.test(message)) return true;
  return (platform?.errors?.missingObject ?? []).some((p) => { try { return new RegExp(p, 'i').test(message); } catch { return false; } });
}

/** A stable digest of an operation's content: a run records it, so drift raised against one content closes when it changes. */
export function operationDigest(op: PlatformOperation): string {
  return createHash('sha256').update(JSON.stringify(op)).digest('hex').slice(0, 16);
}

export const DEFAULT_MAX_ROWS = 5000;

/** `8.10.2` vs `8.9`: numeric parts compared in order. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

/** The first `x.y[.z]` in a platform's version string (`8.40.1`, `Oracle Database 19c … 19.0.0.0.0`). */
export function versionOf(text: unknown): string | undefined {
  return /\d+(\.\d+){1,3}/.exec(String(text ?? ''))?.[0];
}

function inRange(impl: PlatformImpl, version: string | undefined): string | undefined {
  if (!version) return undefined;
  if (impl.since && compareVersions(version, impl.since) < 0) return `needs ${impl.since} or later; the platform is ${version}`;
  if (impl.until && compareVersions(version, impl.until) >= 0) return `works before ${impl.until}; the platform is ${version}`;
  return undefined;
}

/** Binds an operation for one platform: what would run (a read's statement, or a change's step). Throws `BindError` on a bad value. */
export function bindOperation(operation: PlatformOperation, platformId: string, params: Record<string, unknown>, platform?: PlatformDefinition): { impl: PlatformImpl; statement?: string; argv?: string[]; request?: HttpRequest; glob?: string; shown?: string } {
  const impl = operation.platforms[platformId];
  if (!impl) throw new Error(`${operation.id} has no implementation for ${platformId} (it has ${Object.keys(operation.platforms).join(', ')}).`);
  const values = valuesFor(operation.params, params);
  const d = platform?.dialect ?? {};
  if (impl.sql) return { impl, statement: bindTemplate(impl.sql, operation.params, values, d).trim().replace(/;\s*$/, '') };
  // An argument is a value, not SQL: no quotes around it.
  if (impl.cli) return { impl, argv: impl.cli.map((a) => bindPlain(a, operation.params, values)) };
  if (impl.http) {
    const request = bindHttp(impl.http, operation.params, values);
    const q = new URLSearchParams(request.query as Record<string, string>).toString();
    return { impl, request, shown: `${request.method} ${request.path}${q ? `?${q}` : ''}${request.body !== undefined ? ` ${JSON.stringify(request.body)}` : ''}` };
  }
  if (impl.file) {
    const glob = bindPlain(impl.file.glob, operation.params, values);
    const bad = checkGlob(glob);
    if (bad) throw new BindError(`${bad}.`);
    return { impl, glob, shown: `files ${glob} (${impl.file.parse})` };
  }
  return { impl };
}

export async function runOperation(input: RunInput): Promise<RunResult> {
  const r = await runBound(input);
  const classified: RunResult = r.gap && !r.gapKind ? { ...r, gapKind: isMissingObject(r.gap, input.platform) ? 'missing-object' : 'failed' } : r;
  if (input.log) {
    recordOperationRun(input.log.workspaceRoot, {
      at: new Date().toISOString(), operation: input.operation.id, connection: input.log.connection, platform: input.platformId, ok: classified.ok && !classified.gap,
      ...(classified.ok ? { rows: classified.rows.length } : {}), ...(classified.gap ? { error: classified.gap, kind: classified.gapKind } : {}),
      ...(input.version ? { version: input.version } : {}), digest: operationDigest(input.operation), ...(input.log.via ? { via: input.log.via } : {})
    });
  }
  return classified;
}

async function runBound(input: RunInput): Promise<RunResult> {
  const { operation: op, platformId } = input;
  const base: RunResult = { ok: false, operation: op.id, platform: platformId, rows: [], truncated: false, ...(input.version ? { version: input.version } : {}) };
  if (op.kind !== 'read') return { ...base, gapKind: 'refused', gap: `${op.id} changes the platform: it runs only as a runbook step a person approves (propose it with autode_propose_runbook).` };
  const bound = bindOperation(op, platformId, input.params, input.platform);
  const shown = bound.statement ?? bound.shown;
  const out = { ...base, ...(shown ? { statement: shown } : {}), ...(bound.argv ? { argv: bound.argv } : {}) };
  const range = inRange(bound.impl, input.version);
  if (range) return { ...out, gapKind: 'version', gap: `${op.id} on ${platformId} ${range}.` };
  const maxRows = Math.max(1, Math.min(100_000, input.maxRows ?? DEFAULT_MAX_ROWS));
  try {
    if (bound.statement) {
      const c = checkReadOnlySql(bound.statement);
      if (!c.ok) return { ...out, transport: 'sql', gapKind: 'refused', gap: `refused: ${c.reason}` };
      if (!input.runner.sql) return { ...out, transport: 'sql', gap: 'no connection to run a statement on.' };
      const rows = await input.runner.sql(bound.statement, maxRows + 1);
      return { ...out, ok: true, transport: 'sql', rows: mapRows(op.returns, rows.slice(0, maxRows)), truncated: rows.length > maxRows };
    }
    if (bound.argv) {
      const problem = cliReadProblem(bound.argv, input.platform);
      if (problem) return { ...out, transport: 'cli', gapKind: 'refused', gap: `refused: ${problem}.` };
      if (!input.runner.cli) return { ...out, transport: 'cli', gap: 'no command runner for this connection.' };
      const { stdout } = await input.runner.cli(bound.argv);
      const rows = parseCliOutput(stdout, bound.impl.parse);
      return { ...out, ok: true, transport: 'cli', rows: mapRows(op.returns, rows.slice(0, maxRows)), truncated: rows.length > maxRows };
    }
    if (bound.request && bound.impl.http) {
      const problem = httpReadProblem(bound.impl.http, bound.request.body);
      if (problem) return { ...out, transport: 'http', gapKind: 'refused', gap: `refused: ${problem}` };
      if (!input.runner.http) return { ...out, transport: 'http', gap: `no API on this connection (${op.id} needs its base URL and sign-in).` };
      const r = await readHttp(bound.impl.http, bound.request, input.runner.http, maxRows);
      return finishRead({ ...out, transport: 'http' }, op, r.rows, r.truncated, r.gap);
    }
    if (bound.glob !== undefined && bound.impl.file) {
      if (!input.runner.file) return { ...out, transport: 'file', gap: `no folder on this connection (${op.id} reads files).` };
      const r = await input.runner.file({ glob: bound.glob, parse: bound.impl.file.parse, ...(bound.impl.file.results ? { results: bound.impl.file.results } : {}) }, maxRows);
      if (!r.files) return { ...out, ok: true, transport: 'file', gapKind: 'failed', gap: `no file matches ${bound.glob} in the connection's folder.` };
      const gap = r.problems.length ? `${r.problems.length} of ${r.files} file(s) couldn't be read: ${r.problems.slice(0, 5).join('; ')}` : undefined;
      return finishRead({ ...out, transport: 'file' }, op, r.rows, r.truncated, gap);
    }
    return { ...out, gap: `${op.id} has no implementation AutoDE can run on ${platformId}.` };
  } catch (err) {
    const transport = transportOf(bound.impl);
    if (err instanceof ShapeError) return { ...out, transport, gapKind: 'missing-object', gap: err.message };
    return { ...out, transport, gap: err instanceof Error ? err.message : String(err) };
  }
}

function transportOf(impl: PlatformImpl): NonNullable<RunResult['transport']> {
  return impl.sql ? 'sql' : impl.cli ? 'cli' : impl.http ? 'http' : 'file';
}

/**
 * POP5: rows from an API or files mapped to the declared result. Rows in which none of the declared fields is
 * present are a changed shape (drift), never a page of empty cells. A gap with rows is a partial read.
 */
function finishRead(out: RunResult, op: PlatformOperation, rows: Array<Record<string, unknown>>, truncated: boolean, gap?: string): RunResult {
  const mapped = mapRows(op.returns, rows);
  if (rows.length && op.returns.length && mapped.every((m) => Object.values(m).every((v) => v === null))) {
    return { ...out, gapKind: 'missing-object', gap: `none of the fields ${op.id} reads (${op.returns.map((r) => r.from ?? r.name).join(', ')}) are in what came back: the format may have changed.` };
  }
  return { ...out, ok: true, rows: mapped, truncated, ...(gap ? { gap, gapKind: 'failed' as const } : {}) };
}

/** A CLI's output as rows: a JSON array (or an object holding one), or a table with a header line. */
export function parseCliOutput(stdout: string, parse: PlatformImpl['parse'] = 'json'): Array<Record<string, unknown>> {
  const text = stdout.trim();
  if (!text) return [];
  if (parse === 'table') {
    const [head, ...lines] = text.split(/\r?\n/).filter((l) => l.trim());
    const cols = head.trim().split(/\s{2,}|\t/);
    return lines.map((l) => { const cells = l.trim().split(/\s{2,}|\t/); return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? null])); });
  }
  const j = JSON.parse(text.slice(Math.max(0, Math.min(...['[', '{'].map((c) => (text.indexOf(c) < 0 ? Infinity : text.indexOf(c)))))));
  if (Array.isArray(j)) return j as Array<Record<string, unknown>>;
  const arr = Object.values(j as Record<string, unknown>).find(Array.isArray);
  return (arr as Array<Record<string, unknown>> | undefined) ?? [j as Record<string, unknown>];
}

/** The default command runner: no shell, a timeout, the connection's environment (credentials pass here, never as arguments). */
export function spawnCli(env: Record<string, string> = {}, timeoutMs = 300_000): NonNullable<OperationRunner['cli']> {
  return (argv) => new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${argv[0]} timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`${argv[0]} couldn't start: ${e.message}`)); });
    child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve({ stdout }); else reject(new Error(`${argv[0]} exited with ${code}: ${stderr.trim().slice(0, 500)}`)); });
  });
}

const versions = new Map<string, string | null>();

/**
 * A connection's platform version, read once (the platform definition's
 * versionOperation) and kept until `forgetVersion` (a re-test). Unknown
 * when the platform has no version operation or it fails: ranges then
 * aren't enforced.
 */
export async function connectionVersion(connectionId: string, platform: PlatformDefinition | undefined, versionOp: PlatformOperation | undefined, runner: OperationRunner): Promise<string | undefined> {
  if (versions.has(connectionId)) return versions.get(connectionId) ?? undefined;
  let v: string | undefined;
  if (platform && versionOp) {
    const r = await runOperation({ operation: versionOp, platformId: platform.id, platform, params: {}, runner, maxRows: 1 });
    v = r.ok ? versionOf(r.rows[0]?.version) : undefined;
  }
  // Only a version that was read is kept: a passing failure must not turn range checks off for the rest of the session.
  if (v) versions.set(connectionId, v);
  return v;
}

export function forgetVersion(connectionId?: string): void {
  if (connectionId) versions.delete(connectionId); else versions.clear();
}
