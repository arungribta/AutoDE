import Ajv, { ErrorObject } from 'ajv';
import { canonicalJson } from '../context/assertions';
import { parseYaml } from '../context/Yaml';
import { SemanticModel, SemanticNamedExpr, SemanticRelationship, SemanticTable, VerifiedQuery, findElement, serializeSemanticModel, tableElements, validateSemanticModel } from './model';

/**
 * Composites (C5a; docs/context-layer-requirements.md §6.4): a use case
 * composes shared models AtScale-style in a small AutoDE file. It narrows
 * what it uses, adds its own metrics, filters and verified queries, and
 * changes descriptions and synonyms — never a shared element's expression,
 * key or join. Resolution is deterministic: the same composite and shared
 * revisions give a byte-identical, self-contained Snowflake model.
 */

export const COMPOSITE_FORMAT = 'semantic-composite/1';

export interface CompositeUse { model: string; tables?: string[]; metrics?: string[] }
export interface CompositeAddition { table: string; name: string; expr: string; description?: string; synonyms?: string[] }
export interface Composite {
  autode: typeof COMPOSITE_FORMAT;
  name: string;
  description?: string;
  uses: CompositeUse[];
  add?: { metrics?: CompositeAddition[]; filters?: CompositeAddition[]; verified_queries?: VerifiedQuery[] };
  describe?: Record<string, { description?: string; synonyms?: string[] }>;
}

const names = { type: 'array', items: { type: 'string', minLength: 1 } };
const addition = { type: 'object', required: ['table', 'name', 'expr'], additionalProperties: false, properties: { table: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 }, expr: { type: 'string', minLength: 1 }, description: { type: 'string' }, synonyms: names } };
const SCHEMA = {
  type: 'object', required: ['autode', 'name', 'uses'], additionalProperties: false,
  properties: {
    autode: { const: COMPOSITE_FORMAT },
    name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
    description: { type: 'string' },
    uses: { type: 'array', minItems: 1, items: { type: 'object', required: ['model'], additionalProperties: false, properties: { model: { type: 'string', minLength: 1 }, tables: names, metrics: names } } },
    add: { type: 'object', additionalProperties: false, properties: { metrics: { type: 'array', items: addition }, filters: { type: 'array', items: addition }, verified_queries: { type: 'array', items: { type: 'object', required: ['name', 'question', 'sql'], properties: { name: { type: 'string' }, question: { type: 'string' }, sql: { type: 'string' } } } } } },
    describe: { type: 'object', additionalProperties: { type: 'object', additionalProperties: false, properties: { description: { type: 'string' }, synonyms: names } } }
  }
};

let validate: ReturnType<Ajv['compile']> | undefined;

/** Why the schema refused it, in the composite's own terms (a redefinition attempt is named as one). */
function explain(e: ErrorObject): string {
  const at = e.instancePath.replace(/^\//, '').replace(/\/(\d+)/g, '[$1]').replace(/\//g, '.') || 'the composite';
  if (e.keyword === 'additionalProperties') {
    const key = (e.params as { additionalProperty?: string }).additionalProperty ?? '';
    if (at === 'add' && ['tables', 'relationships', 'dimensions', 'time_dimensions', 'facts', 'primary_key'].includes(key)) {
      return `add.${key}: refused — a composite adds metrics, filters and verified queries only; tables, keys, joins and columns belong to the shared model (change it there, as a workspace decision).`;
    }
    if (at.startsWith('describe.')) return `${at}.${key}: refused — describe changes descriptions and synonyms only; a different expression is a new metric with its own name (add.metrics).`;
    return `${at}: "${key}" is not part of a composite`;
  }
  if (e.keyword === 'const') return `autode: must be "${COMPOSITE_FORMAT}"`;
  if (e.keyword === 'required') return `${at}: "${(e.params as { missingProperty?: string }).missingProperty}" is required`;
  return `${at} ${e.message ?? 'is invalid'}`;
}

export function isCompositeText(text: string): boolean {
  return /^\s*autode:\s*semantic-composite\//m.test(text);
}

export function parseComposite(text: string): { composite?: Composite; errors: string[] } {
  let raw: unknown;
  try { raw = parseYaml(text); } catch (err) { return { errors: [`not valid YAML: ${err instanceof Error ? err.message : String(err)}`] }; }
  validate ??= new Ajv({ allErrors: true, strict: false }).compile(SCHEMA);
  if (!validate(raw)) return { errors: (validate.errors ?? []).map(explain) };
  return { composite: raw as Composite, errors: [] };
}

export interface SharedSource { model: SemanticModel; revision: string }

export interface Resolution {
  model?: SemanticModel;
  /** The revision of every shared model used. */
  revisions: Record<string, string>;
  errors: string[];
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const lower = (s: string) => s.toLowerCase();

/** What two definitions of one table differ in: base table, key, or a column-level element (metrics and filters merge). */
function tableDifference(a: SemanticTable, b: SemanticTable): string | undefined {
  if (!same(a.base_table, b.base_table)) return `base_table ${Object.values(a.base_table).join('.')} vs ${Object.values(b.base_table).join('.')}`;
  if (!same(a.primary_key, b.primary_key)) return `primary_key (${a.primary_key?.columns.join(', ') ?? 'none'}) vs (${b.primary_key?.columns.join(', ') ?? 'none'})`;
  for (const list of ['dimensions', 'time_dimensions', 'facts'] as const) {
    const left = new Map((a[list] ?? []).map((e) => [lower(e.name), e]));
    for (const e of b[list] ?? []) {
      const other = left.get(lower(e.name));
      if (other && other.expr !== e.expr) return `${list}.${e.name}: "${other.expr}" vs "${e.expr}"`;
    }
  }
  return undefined;
}

/**
 * Resolves a composite against the shared models it uses (`load` returns
 * the parsed model and its revision, or undefined). Refused, with every
 * reason, on a missing model, table or metric, a collision between models,
 * or an addition that redefines a shared element.
 */
export function resolveComposite(c: Composite, load: (model: string) => SharedSource | undefined): Resolution {
  const errors: string[] = [];
  const revisions: Record<string, string> = {};
  const tables: SemanticTable[] = [];
  const from = new Map<string, string>(); // table → the model it came from
  const relationships: SemanticRelationship[] = [];
  const verified: VerifiedQuery[] = [];
  for (const use of c.uses) {
    const shared = load(use.model);
    if (!shared) { errors.push(`uses: no shared model "${use.model}" (expected <artifactDirectory>/semantic/${use.model}.yaml)`); continue; }
    revisions[use.model] = shared.revision;
    const wanted = use.tables?.map(lower);
    for (const t of use.tables ?? []) if (!shared.model.tables.some((x) => lower(x.name) === lower(t))) errors.push(`uses.${use.model}: no table "${t}" in it`);
    const metricsWanted = use.metrics?.map(lower);
    for (const m of use.metrics ?? []) if (!shared.model.tables.some((t) => (!wanted || wanted.includes(lower(t.name))) && (t.metrics ?? []).some((x) => lower(x.name) === lower(m)))) errors.push(`uses.${use.model}: no metric "${m}" in the tables it uses`);
    for (const t of shared.model.tables) {
      if (wanted && !wanted.includes(lower(t.name))) continue;
      const picked: SemanticTable = JSON.parse(JSON.stringify(t));
      if (metricsWanted) picked.metrics = (picked.metrics ?? []).filter((m) => metricsWanted.includes(lower(m.name)));
      const existing = tables.find((x) => lower(x.name) === lower(t.name));
      if (!existing) { tables.push(picked); from.set(lower(t.name), use.model); continue; }
      const diff = tableDifference(existing, picked);
      if (diff) { errors.push(`collision: table "${t.name}" is defined differently by ${from.get(lower(t.name))} and ${use.model} (${diff})`); continue; }
      // The same table from two models: its metrics and filters join, a name defined twice must agree.
      for (const list of ['metrics', 'filters'] as const) {
        for (const e of picked[list] ?? []) {
          const other = (existing[list] ?? []).find((x) => lower(x.name) === lower(e.name));
          if (other && other.expr !== e.expr) errors.push(`collision: ${t.name}.${e.name} is "${other.expr}" in ${from.get(lower(t.name))} and "${e.expr}" in ${use.model}`);
          else if (!other) existing[list] = [...(existing[list] ?? []), e];
        }
      }
    }
    for (const r of shared.model.relationships ?? []) {
      const included = (n: string) => !wanted || wanted.includes(lower(n));
      if (!included(r.left_table) || !included(r.right_table)) continue;
      const other = relationships.find((x) => lower(x.name) === lower(r.name));
      if (other && !same(other, r)) errors.push(`collision: relationship "${r.name}" is defined differently by two models`);
      else if (!other) relationships.push(r);
    }
    verified.push(...(shared.model.verified_queries ?? []).filter((q) => !verified.some((v) => lower(v.name) === lower(q.name))));
  }
  const model: SemanticModel = { name: c.name, ...(c.description ? { description: c.description } : {}), tables, relationships, verified_queries: verified };
  for (const list of ['metrics', 'filters'] as const) {
    for (const a of c.add?.[list] ?? []) {
      const t = tables.find((x) => lower(x.name) === lower(a.table));
      if (!t) { errors.push(`add.${list}.${a.name}: no table "${a.table}" among those used`); continue; }
      const clash = tableElements(t).find((e) => lower(e.element.name) === lower(a.name));
      if (clash) { errors.push(`add.${list}.${a.name}: refused — ${a.table}.${a.name} is already defined by the shared model ${from.get(lower(t.name))} ("${clash.element.expr}"); a composite never redefines a shared element: a different calculation is a new ${list === 'metrics' ? 'metric' : 'filter'} with its own name.`); continue; }
      const added: SemanticNamedExpr = { name: a.name, ...(a.synonyms ? { synonyms: a.synonyms } : {}), ...(a.description ? { description: a.description } : {}), expr: a.expr };
      t[list] = [...(t[list] ?? []), added];
    }
  }
  for (const q of c.add?.verified_queries ?? []) {
    if (verified.some((v) => lower(v.name) === lower(q.name))) errors.push(`add.verified_queries.${q.name}: refused — a shared model already has a verified query with that name`);
    else verified.push(q);
  }
  for (const [ref, change] of Object.entries(c.describe ?? {})) {
    const hit = findElement(model, ref);
    if (!hit) { errors.push(`describe.${ref}: no such table or element among those used`); continue; }
    const target = (hit.element ?? hit.table) as { description?: string; synonyms?: string[] };
    if (change.description !== undefined) target.description = change.description;
    if (change.synonyms !== undefined) target.synonyms = change.synonyms;
  }
  if (!tables.length && !errors.length) errors.push('the composite uses no table');
  if (errors.length) return { revisions, errors };
  const checked = validateSemanticModel(JSON.parse(JSON.stringify(model)));
  if (checked.errors.length) return { revisions, errors: checked.errors.map((e) => `the resolved model: ${e}`) };
  return { model, revisions, errors: [] };
}

/** The resolved file: a header naming the composite and the shared revisions, then the model. Byte-identical for the same inputs. */
export function serializeResolved(c: Composite, r: Resolution & { model: SemanticModel }): string {
  const revs = Object.entries(r.revisions).sort(([a], [b]) => a.localeCompare(b)).map(([m, v]) => `${m}@${v}`).join(', ');
  return serializeSemanticModel(r.model, `Resolved by AutoDE from the composite ${c.name}: don't edit; change the composite or the shared models and resolve again.\nShared models: ${revs}`);
}
