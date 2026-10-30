import { spawn } from 'node:child_process';
import { CliStatement, ConnectionDefinition } from './operations/types';
import { parseCliOutput } from './operations/execute';
import { QueryResult } from './types';

/**
 * Statements through a platform's CLI (v0.55.0; docs/specs/platform-operations.md
 * §6.2): the one runner for every platform reached only by its CLI, driven by its
 * definition's `access.cli.statement`. `sync`: one call returns the rows. `async`
 * (the AWS CLI's `redshift-data`, for example): submit, poll until finished, fetch
 * the result page by page. The connection's non-secret fields become arguments; its
 * secrets reach the CLI only through the environment, never as arguments.
 */

/** One CLI call: the arguments after the command; resolves to its standard output. */
export type CliCall = (args: string[]) => Promise<string>;

export interface CliStatementOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Stop fetching pages once this many rows are in. */
  maxRows?: number;
  /** Tests: the wait between polls. */
  sleep?: (ms: number) => Promise<void>;
}

/** Runs the CLI with no shell, the connection's environment and a timeout; a failure carries the CLI's own message. */
export function cliCall(cliPath: string, env: Record<string, string>, timeoutMs = 120_000): CliCall {
  return (args) => new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, { windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`The CLI didn't answer within ${Math.round(timeoutMs / 1000)}s.`)); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`The CLI couldn't start (${cliPath}): ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else { const text = (stderr || stdout).trim(); reject(new Error(text.length > 1500 ? `…${text.slice(-1500)}` : text || `exited with code ${code}`)); }
    });
  });
}

/** The connection's fields as CLI arguments: `every` ones on every call, the rest where the statement is submitted. */
export function connectionArgs(def: ConnectionDefinition | undefined, values: Readonly<Record<string, string>>, scope: 'every' | 'submit'): string[] {
  const out: string[] = [];
  for (const f of def?.fields ?? []) {
    if (!f.cliArg || f.secret || !values[f.name]) continue;
    if ((f.cliScope ?? 'submit') !== scope) continue;
    out.push(f.cliArg, values[f.name]);
  }
  return out;
}

/** The connection's secrets as the environment variables its CLI reads, plus the definition's fixed ones. */
export function connectionEnv(def: ConnectionDefinition | undefined, values: Readonly<Record<string, string>>, fixed: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = { ...fixed };
  for (const f of def?.fields ?? []) if (f.env && values[f.name]) env[f.env] = values[f.name];
  return env;
}

/** A value at a dotted path (`Result.Records`). */
function at(value: unknown, dotted: string | undefined): unknown {
  if (!dotted) return value;
  let v: unknown = value;
  for (const k of dotted.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
  return v;
}

function json(text: string, what: string): unknown {
  const t = text.trim();
  if (!t) return {};
  try { return JSON.parse(t); } catch { throw new Error(`The CLI's answer to ${what} wasn't JSON: ${t.slice(0, 200)}`); }
}

/** `{name}` in an argument filled in (the whole argument or part of it). */
function fill(args: readonly string[], values: Record<string, string>): string[] {
  return args.map((a) => a.replace(/\{(sql|id)\}/g, (m, k: string) => values[k] ?? m));
}

/** A typed cell (`{"stringValue": "x"}`, `{"longValue": 3}`, `{"isNull": true}`) as its value. */
function cellValue(cell: unknown): unknown {
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return cell;
  const c = cell as Record<string, unknown>;
  if (c.isNull === true) return null;
  const values = Object.values(c);
  return values.length ? values[0] : null;
}

function rowsOf(records: unknown, columns: string[], cells: 'plain' | 'typed' | undefined): Array<Record<string, unknown>> {
  if (!Array.isArray(records)) return [];
  return records.map((r) => {
    if (Array.isArray(r)) return Object.fromEntries(columns.map((c, i) => [c, cells === 'typed' ? cellValue(r[i]) : r[i]]));
    return r as Record<string, unknown>;
  });
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runCliStatement(spec: CliStatement, call: CliCall, sql: string, connection: { every: string[]; submit: string[] }, options: CliStatementOptions = {}): Promise<QueryResult> {
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? 300_000);
  const sleep = options.sleep ?? wait;
  const done = (rows: Array<Record<string, unknown>>, columns?: string[]): QueryResult => {
    const kept = typeof options.maxRows === 'number' ? rows.slice(0, options.maxRows) : rows;
    return { columns: columns ?? (kept[0] ? Object.keys(kept[0]) : []), rows: kept, rowCount: kept.length, executionTimeMs: Date.now() - started };
  };
  if (spec.mode === 'sync') {
    if (!spec.run) throw new Error('The platform definition\'s statement has no run call.');
    const out = await call([...fill(spec.run.args, { sql }), ...connection.submit, ...connection.every]);
    return done(spec.run.rows ? rowsOf(at(json(out, 'the statement'), spec.run.rows), [], 'plain') : parseCliOutput(out));
  }
  const { submit, poll, fetch } = spec;
  if (!submit || !poll || !fetch) throw new Error('The platform definition\'s asynchronous statement needs submit, poll and fetch calls.');
  const id = String(at(json(await call([...fill(submit.args, { sql }), ...connection.submit, ...connection.every]), 'the submit'), submit.id) ?? '');
  if (!id) throw new Error('The platform accepted the statement but returned no id to follow it by.');
  const cancel = async () => { if (spec.cancel) { try { await call([...fill(spec.cancel.args, { id }), ...connection.every]); } catch { /* best effort */ } } };
  let state: unknown;
  for (let n = 0; ; n++) {
    state = json(await call([...fill(poll.args, { id }), ...connection.every]), 'the status check');
    const status = String(at(state, poll.status) ?? '');
    if (poll.finished.includes(status)) break;
    if (poll.failed.includes(status)) throw new Error(`The statement ${status.toLowerCase()}: ${String(at(state, poll.error) ?? 'no reason given')}`);
    if (options.signal?.aborted) { await cancel(); throw new Error('Stopped.'); }
    if (Date.now() > deadline) { await cancel(); throw new Error(`The statement didn't finish within ${Math.round((options.timeoutMs ?? 300_000) / 1000)}s; it was cancelled.`); }
    await sleep(Math.min(2000, 250 * 1.5 ** n));
  }
  if (poll.hasResult && at(state, poll.hasResult) === false) return done([], []);
  const rows: Array<Record<string, unknown>> = [];
  let columns: string[] = [];
  let token: string | undefined;
  do {
    const page = json(await call([...fill(fetch.args, { id }), ...connection.every, ...(token && fetch.nextTokenArg ? [fetch.nextTokenArg, token] : [])]), 'a result page');
    const meta = at(page, fetch.columns);
    if (Array.isArray(meta) && meta.length) columns = meta.map((c) => String(fetch.columnName ? at(c, fetch.columnName) : c));
    rows.push(...rowsOf(at(page, fetch.rows), columns, fetch.cells));
    const next = at(page, fetch.nextToken);
    token = typeof next === 'string' && next ? next : undefined;
  } while (token && (options.maxRows === undefined || rows.length < options.maxRows));
  return done(rows, columns);
}
