import { checkReadOnlySql } from '../sqlGuard';
import { valueAt } from '../fileTransport';
import { HttpCall, HttpRequest } from '../httpTransport';
import { BindError, bindPlain } from './bind';
import { HttpImpl, OperationParam } from './types';

/**
 * An `http` read (POP5; docs/specs/platform-operations.md §2.1): binding a REST call and following its pages. Values
 * are encoded for where they land (a path segment or a query value), so a value can't add a path, a parameter or
 * a host. The rows are at the operation's `results` path. A response without that path is drift, never an empty
 * result. Paging is declared, not looped by the operation: `offset`, `page`, `cursor` or `link`.
 */

/** The platform answered, but not in the shape the operation declares: drift (POP3), never an empty result. */
export class ShapeError extends Error {}

export const MAX_PAGES = 1000;

const WHOLE = /^\{([a-z][a-z0-9_]*)\}$/;

/** A body template: `"{name}"` alone takes the value with its type; an optional parameter with no value drops the key. */
function bindBody(value: unknown, params: readonly OperationParam[], values: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value);
    if (whole) {
      const v = values[whole[1]];
      if (!params.some((p) => p.name === whole[1])) throw new BindError(`the template names {${whole[1]}}, which isn't a parameter.`);
      return v;
    }
    return bindPlain(value, params, values);
  }
  if (Array.isArray(value)) return value.map((x) => bindBody(x, params, values)).filter((x) => x !== undefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bindBody(v, params, values)] as const).filter(([, v]) => v !== undefined));
  }
  return value;
}

/** The request an implementation makes with these values (its first page). */
export function bindHttp(impl: HttpImpl, params: readonly OperationParam[], values: Record<string, unknown>): HttpRequest {
  const segment = (s: string) => {
    if (s === '.' || s === '..') throw new BindError(`"${s}" can't be part of a path.`);
    return encodeURIComponent(s);
  };
  const query: Record<string, string> = {};
  for (const [k, template] of Object.entries(impl.query ?? {})) {
    const v = bindPlain(template, params, values);
    if (v !== '') query[k] = v;
  }
  return { method: impl.method, path: bindPlain(impl.path, params, values, segment), query, ...(impl.body !== undefined ? { body: bindBody(impl.body, params, values) } : {}) };
}

/** Why this read may not run: anything but a GET or a declared read-only POST, or SQL in the body that changes something. */
export function httpReadProblem(impl: Pick<HttpImpl, 'method' | 'readOnly'>, body: unknown): string | undefined {
  if (impl.method !== 'GET' && !impl.readOnly) return 'a read over http is a GET, or a POST declared readOnly (a search)';
  return statementProblem(body);
}

function statementProblem(value: unknown): string | undefined {
  if (Array.isArray(value)) { for (const v of value) { const p = statementProblem(v); if (p) return p; } return undefined; }
  if (!value || typeof value !== 'object') return undefined;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && /^(statement|sql)$/i.test(k)) { const c = checkReadOnlySql(v); if (!c.ok) return `the request's ${k} isn't read-only: ${c.reason}`; }
    const p = statementProblem(v);
    if (p) return p;
  }
  return undefined;
}

/** The rows in one response: an array at the path, or the one object there. */
function rowsIn(json: unknown, results: string | undefined, where: string): Array<Record<string, unknown>> {
  const at = valueAt(json, results);
  if (results && (at === undefined || at === null)) throw new ShapeError(`The response to ${where} has no ${results}: the API may have changed.`);
  if (at === null || at === undefined) return [];
  const list = Array.isArray(at) ? at : [at];
  return list.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : { value: x }));
}

export interface HttpReadResult { rows: Array<Record<string, unknown>>; truncated: boolean; gap?: string }

/** Runs a read: its first request, then each page the implementation declares, up to `maxRows`. */
export async function readHttp(impl: HttpImpl, first: HttpRequest, call: HttpCall, maxRows: number): Promise<HttpReadResult> {
  const rows: Array<Record<string, unknown>> = [];
  const paging = impl.paging;
  const where = `${impl.method} ${impl.path}`;
  const size = paging?.size ?? 100;
  const startPage = paging?.start ?? (paging?.style === 'page' ? 1 : 0);
  let request: HttpRequest = first;
  if (paging?.style === 'offset' || paging?.style === 'page') {
    request = { ...first, query: { ...first.query, ...(paging.sizeParam ? { [paging.sizeParam]: String(size) } : {}), [paging.param!]: String(startPage) } };
  }
  const seen = new Set<string>();
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) return { rows: rows.slice(0, maxRows), truncated: true, gap: `stopped after ${MAX_PAGES} pages of ${where}.` };
    const reply = await call(request);
    const got = rowsIn(reply.json, impl.results, where);
    rows.push(...got);
    if (rows.length > maxRows) return { rows: rows.slice(0, maxRows), truncated: true };
    if (!paging) break;
    if (paging.style === 'offset' || paging.style === 'page') {
      const total = paging.total ? Number(valueAt(reply.json, paging.total)) : NaN;
      if (got.length === 0 || got.length < size || (Number.isFinite(total) && rows.length >= total)) break;
      const next = paging.style === 'offset' ? startPage + rows.length : startPage + page + 1;
      request = { ...request, query: { ...request.query, [paging.param!]: String(next) } };
      continue;
    }
    const raw = valueAt(reply.json, paging.next);
    const next = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
    if (!next) break;
    if (seen.has(next)) return { rows: rows.slice(0, maxRows), truncated: true, gap: `the server gave the same next page twice for ${where}; stopped there.` };
    seen.add(next);
    request = paging.style === 'cursor'
      ? { ...request, query: { ...request.query, [paging.param!]: next } }
      : { method: first.method, url: next, ...(first.body !== undefined ? { body: first.body } : {}) };
  }
  return { rows, truncated: false };
}
