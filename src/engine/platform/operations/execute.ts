import { spawn } from 'node:child_process';
import { checkReadOnlySql } from '../sqlGuard';
import { bindTemplate, valuesFor } from './bind';
import { mapRows } from './map';
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
}

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
  version?: string;
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
export function bindOperation(operation: PlatformOperation, platformId: string, params: Record<string, unknown>, platform?: PlatformDefinition): { impl: PlatformImpl; statement?: string; argv?: string[] } {
  const impl = operation.platforms[platformId];
  if (!impl) throw new Error(`${operation.id} has no implementation for ${platformId} (it has ${Object.keys(operation.platforms).join(', ')}).`);
  const values = valuesFor(operation.params, params);
  const d = platform?.dialect ?? {};
  if (impl.sql) return { impl, statement: bindTemplate(impl.sql, operation.params, values, d).trim().replace(/;\s*$/, '') };
  if (impl.cli) return { impl, argv: impl.cli.map((a) => bindTemplate(a, operation.params, values, d)) };
  return { impl };
}

export async function runOperation(input: RunInput): Promise<RunResult> {
  const { operation: op, platformId } = input;
  const base: RunResult = { ok: false, operation: op.id, platform: platformId, rows: [], truncated: false, ...(input.version ? { version: input.version } : {}) };
  if (op.kind !== 'read') return { ...base, gap: `${op.id} changes the platform: it runs only as a runbook step a person approves (propose it with autode_propose_runbook).` };
  const bound = bindOperation(op, platformId, input.params, input.platform);
  const out = { ...base, ...(bound.statement ? { statement: bound.statement } : {}), ...(bound.argv ? { argv: bound.argv } : {}) };
  const range = inRange(bound.impl, input.version);
  if (range) return { ...out, gap: `${op.id} on ${platformId} ${range}.` };
  const maxRows = Math.max(1, Math.min(100_000, input.maxRows ?? DEFAULT_MAX_ROWS));
  try {
    if (bound.statement) {
      const c = checkReadOnlySql(bound.statement);
      if (!c.ok) return { ...out, transport: 'sql', gap: `refused: ${c.reason}` };
      if (!input.runner.sql) return { ...out, transport: 'sql', gap: 'no connection to run a statement on.' };
      const rows = await input.runner.sql(bound.statement, maxRows + 1);
      return { ...out, ok: true, transport: 'sql', rows: mapRows(op.returns, rows.slice(0, maxRows)), truncated: rows.length > maxRows };
    }
    if (bound.argv) {
      if (!input.runner.cli) return { ...out, transport: 'cli', gap: 'no command runner for this connection.' };
      const { stdout } = await input.runner.cli(bound.argv);
      const rows = parseCliOutput(stdout, bound.impl.parse);
      return { ...out, ok: true, transport: 'cli', rows: mapRows(op.returns, rows.slice(0, maxRows)), truncated: rows.length > maxRows };
    }
    const t = bound.impl.http ? 'http' : 'file';
    return { ...out, transport: t, gap: `${t} operations run from POP5; this one is checked, not run.` };
  } catch (err) {
    return { ...out, transport: bound.statement ? 'sql' : 'cli', gap: err instanceof Error ? err.message : String(err) };
  }
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
  versions.set(connectionId, v ?? null);
  return v;
}

export function forgetVersion(connectionId?: string): void {
  if (connectionId) versions.delete(connectionId); else versions.clear();
}
