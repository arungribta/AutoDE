import { ApiAccess, ApiAuth } from './operations/types';

/**
 * The `http` transport's connection side (POP5; docs/specs/platform-operations.md §2.1): one authenticated call to
 * the base URL a connection names. The sign-in methods are a small fixed set, coded once and chosen by the platform
 * definition: `bearer` (also an API key in a header of its own), `basic`, and `oauth_client_credentials`. An
 * operation only ever names a path: this module keeps every call on the connection's own origin and base path, so
 * neither a parameter nor a server's "next page" link can carry the credential somewhere else. Redirects aren't
 * followed, for the same reason. Plain `http://` is for this machine only. A secret never reaches an error message.
 */

export interface HttpRequest {
  method: 'GET' | 'POST';
  /** Relative to the base URL; or `url`, a server's "next page" link, checked to stay on the connection. */
  path?: string;
  url?: string;
  query?: Readonly<Record<string, string>>;
  body?: unknown;
}

export interface HttpReply { status: number; json: unknown }

export type HttpCall = (request: HttpRequest) => Promise<HttpReply>;

export interface HttpOptions {
  timeoutMs?: number;
  /** Tests: the waits between retries. */
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 30_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The connection's base URL, checked: https, or http to this machine; no credentials in it. */
export function baseUrlOf(value: string | undefined, title: string): URL {
  const text = (value ?? '').trim();
  if (!text) throw new Error(`${title} connection needs its base URL.`);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`"${text}" isn't a URL (for example https://acme.example.com).`); }
  if (url.username || url.password) throw new Error('The base URL must not hold a user name or password: they come from the connection\'s credentials.');
  if (url.search || url.hash) throw new Error('The base URL must not have a query or fragment.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) throw new Error(`${title} is reached over https (plain http only to this machine): ${url.origin}.`);
  return url;
}

/** The base URL's path without a trailing slash: empty for `https://host` (a URL's own pathname is then `/`). */
const basePath = (base: URL) => base.pathname.replace(/\/+$/, '');

/** The URL of a request, refused if it leaves the connection's origin or base path. */
export function requestUrl(base: URL, request: Pick<HttpRequest, 'path' | 'url' | 'query'>): URL {
  const prefix = basePath(base);
  let url: URL;
  if (request.url) {
    try { url = new URL(request.url, `${base.origin}${prefix}/`); } catch { throw new Error(`The server's next-page link isn't a URL: ${request.url.slice(0, 200)}`); }
  } else {
    const p = request.path ?? '';
    if (!p.startsWith('/') || p.startsWith('//')) throw new Error(`An http operation's path must start with one /: ${p.slice(0, 200)}`);
    url = new URL(`${base.origin}${prefix}${p}`);
  }
  const within = url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
  if (url.origin !== base.origin || !within) throw new Error(`Refused: ${url.origin}${url.pathname} is outside the connection (${base.origin}${prefix}); credentials stay on the connection's own address.`);
  for (const [k, v] of Object.entries(request.query ?? {})) url.searchParams.set(k, v);
  return url;
}

/** The sign-in method whose fields the connection has: the first that is complete. */
export function chooseAuth(methods: readonly ApiAuth[] | undefined, values: Readonly<Record<string, string>>): ApiAuth | undefined {
  return (methods ?? []).find((a) => {
    if (a.method === 'bearer') return !!a.tokenField && !!values[a.tokenField];
    if (a.method === 'basic') return !!a.usernameField && !!a.passwordField && !!values[a.usernameField] && !!values[a.passwordField];
    return !!a.clientIdField && !!a.clientSecretField && !!values[a.clientIdField] && !!values[a.clientSecretField];
  });
}

/** The values an error message must never show. */
function secretsOf(auth: ApiAuth | undefined, values: Readonly<Record<string, string>>): string[] {
  if (!auth) return [];
  const out = [auth.tokenField, auth.passwordField, auth.clientSecretField].flatMap((f) => (f && values[f] ? [values[f]] : []));
  if (auth.method === 'basic' && auth.usernameField && auth.passwordField) out.push(Buffer.from(`${values[auth.usernameField]}:${values[auth.passwordField]}`).toString('base64'));
  return out;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`The response is ${declared} bytes; the most AutoDE reads is ${maxBytes}. Narrow the read or page it.`);
  const reader = res.body?.getReader();
  if (!reader) return res.text();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error(`The response is over ${maxBytes} bytes, the most AutoDE reads. Narrow the read or page it.`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function retryWait(res: Response, attempt: number): number {
  const seconds = Number(res.headers.get('retry-after'));
  return Math.min(MAX_RETRY_WAIT_MS, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 500 * 2 ** attempt);
}

/** One platform's API on one connection: authenticated, confined, timed out; a failure says why, without a secret. */
export function httpConnection(api: ApiAccess, title: string, values: Readonly<Record<string, string>>, options: HttpOptions = {}): HttpCall {
  const base = baseUrlOf(api.baseUrlField ? values[api.baseUrlField] : undefined, title);
  const auth = chooseAuth(api.auth, values);
  if (api.auth?.length && !auth) throw new Error(`${title} connection has no complete sign-in: it needs ${api.auth.map((a) => [a.tokenField, a.usernameField, a.passwordField, a.clientIdField, a.clientSecretField].filter(Boolean).join(' and ')).join(', or ')}.`);
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? wait;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const hidden = secretsOf(auth, values);
  const scrub = (text: string) => hidden.reduce((t, s) => t.split(s).join('***'), text);
  let token: { value: string; until: number } | undefined;

  const signIn = async (): Promise<string> => {
    if (token && Date.now() < token.until) return token.value;
    const url = requestUrl(base, { path: auth!.tokenPath ?? '/oauth/token' });
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: values[auth!.clientIdField!], client_secret: values[auth!.clientSecretField!], ...(auth!.scope ? { scope: auth!.scope } : {}) });
    const res = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString(), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const text = await readCapped(res, 1_000_000);
    if (!res.ok) throw new Error(`Signing in to ${title} failed (HTTP ${res.status}): ${scrub(text).slice(0, 300)}`);
    let reply: { access_token?: unknown; expires_in?: unknown };
    try { reply = JSON.parse(text) as typeof reply; } catch { throw new Error(`${title}'s sign-in answer wasn't JSON.`); }
    if (typeof reply.access_token !== 'string' || !reply.access_token) throw new Error(`${title}'s sign-in answer has no access_token.`);
    hidden.push(reply.access_token);
    token = { value: reply.access_token, until: Date.now() + Math.max(0, (Number(reply.expires_in) || 300) - 30) * 1000 };
    return token.value;
  };

  const authHeaders = async (): Promise<Record<string, string>> => {
    if (!auth) return {};
    if (auth.method === 'basic') return { Authorization: `Basic ${Buffer.from(`${values[auth.usernameField!]}:${values[auth.passwordField!]}`).toString('base64')}` };
    if (auth.method === 'bearer') { const scheme = auth.scheme ?? 'Bearer'; return { [auth.header ?? 'Authorization']: `${scheme ? `${scheme} ` : ''}${values[auth.tokenField!]}` }; }
    return { Authorization: `Bearer ${await signIn()}` };
  };

  const call = async (request: HttpRequest, attempt: number, signedInAgain: boolean): Promise<HttpReply> => {
    const url = requestUrl(base, request);
    const where = `${request.method} ${url.pathname}`;
    const headers: Record<string, string> = { Accept: 'application/json', ...(api.headers ?? {}), ...(await authHeaders()), ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
    let res: Response;
    try {
      res = await doFetch(url, { method: request.method, headers, ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const e = err as Error & { cause?: { message?: string } };
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`${title} didn't answer ${where} within ${Math.round(timeoutMs / 1000)}s.`);
      throw new Error(`${title} couldn't be reached (${where}): ${scrub(e.cause?.message ?? e.message)}`);
    }
    if (res.status >= 300 && res.status < 400) throw new Error(`${title} redirected ${where} to ${res.headers.get('location') ?? 'another address'}. AutoDE doesn't follow redirects with credentials: correct the connection's base URL.`);
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) { await sleep(retryWait(res, attempt)); return call(request, attempt + 1, signedInAgain); }
    if (res.status === 401 && auth?.method === 'oauth_client_credentials' && !signedInAgain) { token = undefined; return call(request, attempt, true); }
    const text = await readCapped(res, maxBytes);
    if (!res.ok) {
      const hint = res.status === 401 ? ' Check the connection\'s credentials.' : res.status === 403 ? ' The signed-in account may lack a privilege.' : '';
      throw new Error(`HTTP ${res.status} ${res.statusText || ''} from ${where}: ${scrub(text).slice(0, 300)}${hint}`.replace(/\s+/g, ' ').trim());
    }
    if (!text.trim()) return { status: res.status, json: null };
    try { return { status: res.status, json: JSON.parse(text) }; } catch {
      const html = /^\s*</.test(text);
      throw new Error(`${title}'s answer to ${where} wasn't JSON${html ? ': it looks like a web page, often a sign-in page, so a browser-only account or the wrong base URL' : ''}.`);
    }
  };

  return (request) => call(request, 0, false);
}
