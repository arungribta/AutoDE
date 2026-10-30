import { checkReadOnlySql } from '../sqlGuard';
import { OperationParam, PlatformDefinition } from './types';

/**
 * Binding (POP1): a value goes into a template by its declared type, never
 * as pasted text. `{name}` binds a parameter as its type says; `{name:literal}`
 * binds it as a quoted value (an identifier compared in a WHERE clause).
 * A `statement` parameter must itself be one read-only statement.
 */

const PLAIN = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export class BindError extends Error {
  public constructor(message: string) { super(message); this.name = 'BindError'; }
}

type Dialect = NonNullable<PlatformDefinition['dialect']>;

/** One name part: plain names stay unquoted (the platform folds their case as usual); others are quoted and escaped. */
function identPart(part: string, d: Dialect): string {
  if (PLAIN.test(part)) return part;
  if (!part || part.length > 255 || [...part].some((ch) => ch.charCodeAt(0) < 32)) throw new BindError(`"${part}" is not a usable name.`);
  const q = d.identifierQuote ?? '"';
  return `${q}${part.split(q).join(q + q)}${q}`;
}

/** A name, possibly qualified (`db.schema.table`); quoted parts (`"My Table"`) are kept as written. */
export function identifier(value: unknown, d: Dialect = {}): string {
  const s = String(value ?? '').trim();
  if (!s) throw new BindError('an empty name.');
  const parts = s.match(/("([^"]|"")*"|`([^`]|``)*`|[^.]+)/g) ?? [];
  if (parts.join('.') !== s) throw new BindError(`"${s}" is not a name.`);
  return parts.map((p) => (/^["`]/.test(p) ? identPart(p.slice(1, -1).replace(/""|``/g, (m) => m[0]), d) : identPart(p, d))).join('.');
}

export function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function number(value: unknown, p: OperationParam): string {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw new BindError(`${p.name} must be a number.`);
  if (p.min !== undefined && n < p.min) throw new BindError(`${p.name} must be at least ${p.min}.`);
  if (p.max !== undefined && n > p.max) throw new BindError(`${p.name} must be at most ${p.max}.`);
  return String(n);
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : [v]);

function render(p: OperationParam, value: unknown, mode: string | undefined, d: Dialect): string {
  if (mode === 'literal') return p.type.endsWith('_list') ? asList(value).map(literal).join(', ') : literal(value);
  if (mode === 'lower' || mode === 'upper') {
    const f = (x: unknown) => literal(mode === 'lower' ? String(x).toLowerCase() : String(x).toUpperCase());
    return p.type.endsWith('_list') ? asList(value).map(f).join(', ') : f(value);
  }
  if (mode) throw new BindError(`unknown binding {${p.name}:${mode}} (literal, lower or upper).`);
  switch (p.type) {
    case 'identifier': return identifier(value, d);
    case 'identifier_list': { const l = asList(value); if (!l.length) throw new BindError(`${p.name} needs at least one name.`); return l.map((x) => identifier(x, d)).join(', '); }
    case 'literal': return literal(value);
    case 'literal_list': { const l = asList(value); if (!l.length) throw new BindError(`${p.name} needs at least one value.`); return l.map(literal).join(', '); }
    case 'number': return number(value, p);
    case 'boolean': { const b = d.booleans ?? ['TRUE', 'FALSE']; if (typeof value !== 'boolean' && !/^(true|false)$/i.test(String(value))) throw new BindError(`${p.name} must be true or false.`); return value === true || /^true$/i.test(String(value)) ? b[0] : b[1]; }
    case 'statement': {
      const sql = String(value ?? '').trim().replace(/;\s*$/, '');
      const c = checkReadOnlySql(sql);
      if (!c.ok) throw new BindError(`${p.name} must be one read-only statement: ${c.reason}`);
      return sql;
    }
  }
}

/** The values with defaults applied; a missing required value is an error. */
export function valuesFor(params: readonly OperationParam[], given: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    const v = given[p.name] ?? p.default;
    if (v === undefined || v === '') { if (p.required !== false) throw new BindError(`${p.name} is required (${p.label}).`); continue; }
    out[p.name] = v;
  }
  for (const k of Object.keys(given)) if (!params.some((p) => p.name === k)) throw new BindError(`no parameter ${k}.`);
  return out;
}

/**
 * Binds `{param}` and `{param:mode}` in a template; `{{` and `}}` are literal braces. v0.55.1: `[[ … ]]` is an
 * optional section, kept only when every parameter named inside it has a value (an optional filter).
 */
export function bindTemplate(template: string, params: readonly OperationParam[], values: Record<string, unknown>, d: Dialect = {}): string {
  const byName = new Map(params.map((p) => [p.name, p] as const));
  const named = (section: string) => [...section.matchAll(/\{([a-z][a-z0-9_]*)(?::[a-z_]+)?\}/g)].map((m) => m[1]);
  template = template.replace(/\[\[([\s\S]*?)\]\]/g, (_m, section: string) => (named(section).every((n) => values[n] !== undefined) ? section : ''));
  return template.replace(/\{\{|\}\}|\{([a-z][a-z0-9_]*)(?::([a-z_]+))?\}/g, (m, nm: string | undefined, mode: string | undefined) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    const p = byName.get(nm!);
    if (!p) throw new BindError(`the template names {${nm}}, which isn't a parameter.`);
    if (values[nm!] === undefined) throw new BindError(`${nm} has no value.`);
    return render(p, values[nm!], mode, d);
  });
}

/** A value of each parameter's type, for checking templates when a file is loaded. */
export function sampleValues(params: readonly OperationParam[]): Record<string, unknown> {
  const sample: Record<ParamTypeKey, unknown> = { identifier: 'a.b', identifier_list: ['a', 'b'], literal: 'x', literal_list: ['x', 'y'], number: 1, boolean: true, statement: 'SELECT 1' };
  return Object.fromEntries(params.map((p) => [p.name, p.type === 'number' && p.min !== undefined ? p.min : sample[p.type]]));
}
type ParamTypeKey = OperationParam['type'];
