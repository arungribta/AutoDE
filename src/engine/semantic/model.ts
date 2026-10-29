import { createHash } from 'node:crypto';
import Ajv, { ErrorObject } from 'ajv';
import { parseYaml, stringifyYaml } from '../context/Yaml';

/**
 * Shared semantic models (C5a; docs/specs/context-layer.md §6.3):
 * Snowflake's semantic model YAML — the format of
 * `SYSTEM$CREATE_SEMANTIC_VIEW_FROM_YAML` and Cortex Analyst — as AutoDE's
 * native format. A shared model stays deployable as is: unknown keys are
 * refused (Snowflake's validator rejects them too), and AutoDE's own metadata
 * lives beside it in `.autode/semantic/`, never inside it.
 */

export interface SemanticElement {
  name: string;
  synonyms?: string[];
  description?: string;
  expr: string;
  data_type?: string;
  unique?: boolean;
  sample_values?: string[];
  is_enum?: boolean;
  access_modifier?: 'public_access' | 'private_access';
}

export interface SemanticNamedExpr { name: string; synonyms?: string[]; description?: string; expr: string; access_modifier?: 'public_access' | 'private_access' }

export interface SemanticTable {
  name: string;
  description?: string;
  synonyms?: string[];
  base_table: { database: string; schema: string; table: string };
  primary_key?: { columns: string[] };
  dimensions?: SemanticElement[];
  time_dimensions?: SemanticElement[];
  facts?: SemanticElement[];
  metrics?: SemanticNamedExpr[];
  filters?: SemanticNamedExpr[];
}

export interface SemanticRelationship {
  name: string;
  left_table: string;
  right_table: string;
  relationship_columns: Array<{ left_column: string; right_column: string }>;
  join_type?: 'left_outer' | 'inner';
  relationship_type?: 'many_to_one' | 'one_to_one';
}

export interface VerifiedQuery {
  name: string;
  question: string;
  sql: string;
  verified_at?: number;
  verified_by?: string;
  use_as_onboarding_question?: boolean;
}

export interface SemanticModel {
  name: string;
  description?: string;
  tables: SemanticTable[];
  relationships?: SemanticRelationship[];
  verified_queries?: VerifiedQuery[];
  custom_instructions?: string;
}

/** The element lists of a table, in the order they are shown and serialized. */
export const ELEMENT_LISTS = ['dimensions', 'time_dimensions', 'facts', 'metrics', 'filters'] as const;
export type ElementList = typeof ELEMENT_LISTS[number];

const strings = { type: 'array', items: { type: 'string' } };
const element = {
  type: 'object', required: ['name', 'expr'], additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 }, synonyms: strings, description: { type: 'string' }, expr: { type: 'string', minLength: 1 },
    data_type: { type: 'string' }, unique: { type: 'boolean' }, sample_values: { type: 'array' }, is_enum: { type: 'boolean' },
    cortex_search_service: { type: 'object' }, cortex_search_service_name: { type: 'string' }, access_modifier: { enum: ['public_access', 'private_access'] }
  }
};
const namedExpr = {
  type: 'object', required: ['name', 'expr'], additionalProperties: false,
  properties: { name: { type: 'string', minLength: 1 }, synonyms: strings, description: { type: 'string' }, expr: { type: 'string', minLength: 1 }, access_modifier: { enum: ['public_access', 'private_access'] } }
};

export const SEMANTIC_MODEL_SCHEMA = {
  type: 'object', required: ['name', 'tables'], additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    tables: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', required: ['name', 'base_table'], additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1 }, description: { type: 'string' }, synonyms: strings,
          base_table: { type: 'object', required: ['database', 'schema', 'table'], additionalProperties: false, properties: { database: { type: 'string', minLength: 1 }, schema: { type: 'string', minLength: 1 }, table: { type: 'string', minLength: 1 } } },
          primary_key: { type: 'object', required: ['columns'], additionalProperties: false, properties: { columns: { ...strings, minItems: 1 } } },
          dimensions: { type: 'array', items: element }, time_dimensions: { type: 'array', items: element },
          facts: { type: 'array', items: element }, measures: { type: 'array', items: element },
          metrics: { type: 'array', items: namedExpr }, filters: { type: 'array', items: namedExpr }
        }
      }
    },
    relationships: {
      type: 'array',
      items: {
        type: 'object', required: ['name', 'left_table', 'right_table', 'relationship_columns'], additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1 }, left_table: { type: 'string', minLength: 1 }, right_table: { type: 'string', minLength: 1 },
          relationship_columns: { type: 'array', minItems: 1, items: { type: 'object', required: ['left_column', 'right_column'], additionalProperties: false, properties: { left_column: { type: 'string', minLength: 1 }, right_column: { type: 'string', minLength: 1 } } } },
          join_type: { enum: ['left_outer', 'inner'] }, relationship_type: { enum: ['many_to_one', 'one_to_one'] }
        }
      }
    },
    verified_queries: {
      type: 'array',
      items: { type: 'object', required: ['name', 'question', 'sql'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1 }, question: { type: 'string', minLength: 1 }, sql: { type: 'string', minLength: 1 }, verified_at: { type: 'number' }, verified_by: { type: 'string' }, use_as_onboarding_question: { type: 'boolean' } } }
    },
    custom_instructions: { type: 'string' },
    module_custom_instructions: { type: 'object' }
  }
};

let validate: ReturnType<Ajv['compile']> | undefined;

function describeError(e: ErrorObject): string {
  const at = e.instancePath.replace(/^\//, '').replace(/\/(\d+)/g, '[$1]').replace(/\//g, '.') || 'the model';
  if (e.keyword === 'additionalProperties') {
    const key = (e.params as { additionalProperty?: string }).additionalProperty;
    return `${at}: "${key}" is not a Snowflake semantic model key (Snowflake rejects unknown keys; AutoDE keeps its own metadata in .autode/semantic/)`;
  }
  if (e.keyword === 'required') return `${at}: "${(e.params as { missingProperty?: string }).missingProperty}" is required`;
  return `${at} ${e.message ?? 'is invalid'}`;
}

/**
 * Checks a model against the Snowflake semantic model format, then the
 * structure Snowflake also enforces: unique table names, unique element names
 * within a table, relationships between tables the model has.
 */
export function validateSemanticModel(raw: unknown): { model?: SemanticModel; errors: string[]; warnings: string[] } {
  validate ??= new Ajv({ allErrors: true, strict: false }).compile(SEMANTIC_MODEL_SCHEMA);
  const warnings: string[] = [];
  if (!validate(raw)) return { errors: (validate.errors ?? []).map(describeError), warnings };
  const model = raw as SemanticModel & { tables: Array<SemanticTable & { measures?: SemanticElement[] }> };
  const errors: string[] = [];
  const tables = new Set<string>();
  for (const t of model.tables) {
    if (tables.has(t.name.toLowerCase())) errors.push(`tables: "${t.name}" is defined twice`);
    tables.add(t.name.toLowerCase());
    if (t.measures) warnings.push(`tables.${t.name}: "measures" is the older name for "facts"`);
    const names = new Set<string>();
    for (const list of [...ELEMENT_LISTS, 'measures'] as const) {
      for (const e of (t as unknown as Record<string, Array<{ name: string }> | undefined>)[list] ?? []) {
        if (names.has(e.name.toLowerCase())) errors.push(`tables.${t.name}: "${e.name}" is defined twice`);
        names.add(e.name.toLowerCase());
      }
    }
  }
  const rels = new Set<string>();
  for (const r of model.relationships ?? []) {
    if (rels.has(r.name.toLowerCase())) errors.push(`relationships: "${r.name}" is defined twice`);
    rels.add(r.name.toLowerCase());
    for (const side of [r.left_table, r.right_table]) if (!tables.has(side.toLowerCase())) errors.push(`relationships.${r.name}: no table "${side}" in the model`);
  }
  return errors.length ? { errors, warnings } : { model, errors, warnings };
}

export function parseSemanticModel(text: string): { model?: SemanticModel; errors: string[]; warnings: string[] } {
  let raw: unknown;
  try { raw = parseYaml(text); } catch (err) { return { errors: [`not valid YAML: ${err instanceof Error ? err.message : String(err)}`], warnings: [] }; }
  return validateSemanticModel(raw);
}

/** The content revision AutoDE records (resolution, approval): the first 12 hex of SHA-256. */
export function semanticRevision(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);
}

const ELEMENT_KEYS = ['name', 'synonyms', 'description', 'expr', 'data_type', 'unique', 'sample_values', 'is_enum', 'access_modifier'];
const TABLE_KEYS = ['name', 'description', 'synonyms', 'base_table', 'primary_key', ...ELEMENT_LISTS];
const MODEL_KEYS = ['name', 'description', 'tables', 'relationships', 'verified_queries', 'custom_instructions'];
const REL_KEYS = ['name', 'left_table', 'right_table', 'relationship_columns', 'join_type', 'relationship_type'];

function ordered(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [...keys, ...Object.keys(obj).filter((x) => !keys.includes(x))]) {
    const v = obj[k];
    if (v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out;
}

/** Serializes in a fixed key order (Snowflake's documented order), dropping empty lists: equal models give equal bytes. */
export function serializeSemanticModel(model: SemanticModel, header?: string): string {
  const body = ordered({
    ...model,
    tables: model.tables.map((t) => ordered({
      ...t,
      base_table: ordered(t.base_table as unknown as Record<string, unknown>, ['database', 'schema', 'table']),
      ...Object.fromEntries(ELEMENT_LISTS.map((l) => [l, (t[l] as unknown as Array<Record<string, unknown>> | undefined)?.map((e) => ordered(e, ELEMENT_KEYS))]))
    }, TABLE_KEYS)),
    relationships: model.relationships?.map((r) => ordered(r as unknown as Record<string, unknown>, REL_KEYS))
  } as unknown as Record<string, unknown>, MODEL_KEYS);
  return (header ? header.split('\n').map((l) => `# ${l}`).join('\n') + '\n' : '') + stringifyYaml(body);
}

/** Finds an element by `table.name` (or a table by `table`). */
export function findElement(model: SemanticModel, ref: string): { table: SemanticTable; list?: ElementList; element?: SemanticElement | SemanticNamedExpr } | undefined {
  const [tableName, name] = ref.split('.');
  const table = model.tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase());
  if (!table) return undefined;
  if (!name) return { table };
  for (const list of ELEMENT_LISTS) {
    const element = (table[list] as Array<SemanticElement | SemanticNamedExpr> | undefined)?.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (element) return { table, list, element };
  }
  return undefined;
}

/** Every element of a table, with its list. */
export function tableElements(t: SemanticTable): Array<{ list: ElementList; element: SemanticElement | SemanticNamedExpr }> {
  return ELEMENT_LISTS.flatMap((list) => ((t[list] as Array<SemanticElement | SemanticNamedExpr> | undefined) ?? []).map((element) => ({ list, element })));
}
