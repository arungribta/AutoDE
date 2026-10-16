/**
 * The MCP result and error contract (docs/mcp-engine-requirements.md §5.6).
 * Every failure a tool reports is one `EngineErrorEnvelope`; raw platform
 * output goes into `details` (truncated), never into the message, and every
 * string leaving the server passes through `redact()`.
 */

export type EngineErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNKNOWN_PRIMITIVE'
  | 'NOT_FOUND'
  | 'CONNECTION_FAILED'
  | 'AUTH_FAILED'
  | 'PERMISSION_DENIED'
  | 'WRITE_NOT_ALLOWED'
  | 'REVISION_CONFLICT'
  | 'TIMEOUT'
  | 'PLATFORM_ERROR'
  | 'INTERNAL_ERROR';

export interface EngineErrorEnvelope {
  code: EngineErrorCode;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

export class EngineToolError extends Error {
  public constructor(public readonly code: EngineErrorCode, message: string, public readonly details: Record<string, unknown> = {}, public readonly retryable = false) {
    super(message);
    this.name = 'EngineToolError';
  }
}

const MAX_DETAIL_CHARS = 2000;

/**
 * Secret shapes removed from anything the server returns or logs: PEM blocks,
 * bearer/basic tokens, JWTs, `key=value` pairs whose key names a secret,
 * credentials in URLs, Databricks PATs, GitHub/OpenAI/Anthropic/AWS-style keys,
 * and AutoDE's own `AUTODE_*` credential environment variables.
 */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED JWT]'],
  [/\b((?:AUTODE_[A-Z0-9_]*(?:PASSWORD|TOKEN|SECRET|KEY|PASSPHRASE)[A-Z0-9_]*))\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/g, '$1=[REDACTED]'],
  [/\b([A-Za-z0-9_-]*(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|passphrase|client[_-]?secret|access[_-]?key)[A-Za-z0-9_-]*)("?\s*[=:]\s*"?)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi, '$1$2[REDACTED]'],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
  [/\bdapi[0-9a-f]{32}(-\d+)?\b/gi, '[REDACTED]'],
  [/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]'],
  [/\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED]']
];

/** Removes secret-shaped substrings. Lexical — a guard, not a guarantee; secrets should never reach a message in the first place. */
export function redact(text: string): string {
  let out = String(text ?? '');
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Redacts every string in a JSON-like value (keys whose names denote secrets lose their value entirely). */
export function redactValue<T>(value: T): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (key && /password|passwd|secret|token|api[_-]?key|private[_-]?key|passphrase/i.test(key) && typeof v === 'string') return '[REDACTED]';
    if (typeof v === 'string') return redact(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value) as T;
}

function truncateDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (typeof v === 'string' && v.length > MAX_DETAIL_CHARS) out[k] = `${v.slice(0, MAX_DETAIL_CHARS)}… [truncated, ${v.length} chars]`;
    else out[k] = v;
  }
  return out;
}

/** Any thrown value as a redacted envelope; unexpected errors become INTERNAL_ERROR with the raw text in details. */
export function toEnvelope(err: unknown): EngineErrorEnvelope {
  if (err instanceof EngineToolError) {
    return redactValue({ code: err.code, message: err.message, retryable: err.retryable, details: truncateDetails(err.details) });
  }
  const raw = err instanceof Error ? `${err.message}${err.stack ? `\n${err.stack}` : ''}` : String(err);
  const message = err instanceof Error ? err.message.split('\n')[0].slice(0, 300) : 'Unexpected error';
  return redactValue({ code: 'INTERNAL_ERROR', message, retryable: false, details: truncateDetails({ raw }) });
}
