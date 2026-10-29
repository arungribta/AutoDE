import { ELEMENT_LISTS, ElementList, SemanticModel, SemanticTable } from './model';
import type { BaseNode, TableNode } from '../context/types';

/**
 * The semantic layer as the context layer uses it (C5b;
 * docs/specs/context-layer.md §6.5): the **approved** definitions — shared
 * models approved at their current revision, and the active problem's
 * composites approved at their current resolution — indexed for packs, the
 * grounding check and the graph. Drafts are listed (for the Knowledge
 * Explorer) but never used as authority: an agent may not build on a join or
 * metric a person hasn't approved. Pure: `store.ts` loads it
 * (`loadSemanticLayer`), `layerGraph.ts` turns it into graph nodes.
 *
 * Identity (v0.50.3; §6.4): a logical table's base table is matched on its
 * database, schema and table, within the system (and environment) its model
 * is bound to. A part either side doesn't know (DDL without a database, the
 * `SET_DATABASE` placeholder, an unbound model) is not compared, so it can't
 * pick one of several tables: when more than one fits, the match is
 * *ambiguous* and nothing is linked — the checks name the candidates.
 */

export interface LayerModel {
  name: string;
  source: 'shared' | 'composite';
  problemId?: string;
  revision: string;
  approved: boolean;
  file: string;
  /** Element ref (`table`, `table.element`, `relationship:<name>`) → backing assertion ids, from the sidecar. */
  backing?: Record<string, string[]>;
  /** The system (and environment) whose tables the model's base tables are (v0.50.3); absent for models written before. */
  binding?: ModelBinding;
}

export interface ModelBinding { system: string; environment?: string }

export interface LayerTable {
  model: string;
  table: SemanticTable;
  /** `schema.table`, lower-cased. */
  base: string;
  /** `database.schema.table`, lower-cased, with `?` for an unknown database: the table's identity in the layer. */
  key: string;
  baseName: string;
  baseSchema: string;
  /** Lower-cased; '' when unknown (the placeholder). */
  baseDatabase: string;
  binding?: ModelBinding;
}

export interface LayerElement { model: string; table: string; list: ElementList; name: string; expr: string; synonyms: string[]; description?: string }

export interface LayerRelationship {
  model: string;
  name: string;
  leftTable: string;
  rightTable: string;
  /** The two sides' table keys (`LayerTable.key`). */
  left: string;
  right: string;
  columns: Array<{ left: string; right: string }>;
  joinType?: string;
  relationshipType?: string;
}

export interface LayerVerifiedQuery { model: string; name: string; question: string; sql: string; verifiedBy?: string; verifiedAt?: number; onboarding?: boolean }

export interface SemanticLayerIndex {
  models: LayerModel[];
  tables: LayerTable[];
  elements: LayerElement[];
  relationships: LayerRelationship[];
  verifiedQueries: LayerVerifiedQuery[];
  /** Each model's `custom_instructions`. */
  instructions: Array<{ model: string; text: string }>;
  /** Lower-cased base table name → the semantic tables over it. */
  byBaseName: Map<string, LayerTable[]>;
  /** Lower-cased metric names and synonyms → the metrics. */
  metricsByName: Map<string, LayerElement[]>;
}

export interface LoadedModel extends LayerModel { model: SemanticModel }

/** Indexes approved models (drafts are kept out; `includeDrafts` keeps them, flagged, for browsing). */
export function indexSemanticLayer(loaded: readonly LoadedModel[], options: { includeDrafts?: boolean } = {}): SemanticLayerIndex {
  const index: SemanticLayerIndex = { models: [], tables: [], elements: [], relationships: [], verifiedQueries: [], instructions: [], byBaseName: new Map(), metricsByName: new Map() };
  const seenRel = new Set<string>();
  for (const m of loaded) {
    if (!m.approved && !options.includeDrafts) continue;
    const { model, ...meta } = m;
    index.models.push(meta);
    const baseOf = new Map<string, string>();
    for (const t of model.tables) {
      const baseSchema = t.base_table.schema.toLowerCase();
      const baseName = t.base_table.table.toLowerCase();
      const baseDatabase = knownDatabase(t.base_table.database);
      const lt: LayerTable = { model: model.name, table: t, base: `${baseSchema}.${baseName}`, key: `${baseDatabase || '?'}.${baseSchema}.${baseName}`, baseName, baseSchema, baseDatabase, ...(meta.binding ? { binding: meta.binding } : {}) };
      baseOf.set(t.name.toLowerCase(), lt.key);
      index.tables.push(lt);
      index.byBaseName.set(baseName, [...(index.byBaseName.get(baseName) ?? []), lt]);
      for (const list of ELEMENT_LISTS) {
        for (const e of (t[list] as Array<{ name: string; expr: string; synonyms?: string[]; description?: string }> | undefined) ?? []) {
          const el: LayerElement = { model: model.name, table: t.name, list, name: e.name, expr: e.expr, synonyms: e.synonyms ?? [], ...(e.description ? { description: e.description } : {}) };
          index.elements.push(el);
          if (list !== 'metrics') continue;
          for (const key of [e.name, ...(e.synonyms ?? [])].map((s) => s.toLowerCase())) index.metricsByName.set(key, [...(index.metricsByName.get(key) ?? []), el]);
        }
      }
    }
    for (const q of model.verified_queries ?? []) {
      // A composite's resolution repeats its shared models' verified queries: one entry each.
      if (index.verifiedQueries.some((x) => x.name === q.name && x.sql === q.sql)) continue;
      index.verifiedQueries.push({ model: model.name, name: q.name, question: q.question, sql: q.sql, ...(q.verified_by ? { verifiedBy: q.verified_by } : {}), ...(q.verified_at ? { verifiedAt: q.verified_at } : {}), ...(q.use_as_onboarding_question ? { onboarding: true } : {}) });
    }
    if (model.custom_instructions?.trim()) index.instructions.push({ model: model.name, text: model.custom_instructions.trim() });
    for (const r of model.relationships ?? []) {
      const left = baseOf.get(r.left_table.toLowerCase());
      const right = baseOf.get(r.right_table.toLowerCase());
      if (!left || !right) continue;
      const columns = r.relationship_columns.map((c) => ({ left: c.left_column.toLowerCase(), right: c.right_column.toLowerCase() }));
      // A composite's resolution repeats its shared models' relationships: one entry each.
      const key = `${left}|${right}|${columns.map((c) => `${c.left}=${c.right}`).join(',')}`;
      if (seenRel.has(key)) continue;
      seenRel.add(key);
      index.relationships.push({ model: model.name, name: r.name, leftTable: r.left_table, rightTable: r.right_table, left, right, columns, joinType: r.join_type, relationshipType: r.relationship_type });
    }
  }
  return index;
}

/** Database names that mean "not known": the semantic draft's placeholder, and what file ingestion records for DDL without one. */
const UNKNOWN_DATABASES = new Set(['', 'set_database', 'ingested_files']);

/**
 * File ingestion files a table with no schema under its file format's name
 * (`ddl.orders`, with database `ingested_files`); that label is no schema.
 */
const FORMAT_SCHEMAS = new Set(['ddl', 'csv', 'json']);
export function isFormatSchema(schema: string, database: string | undefined, parts: number): boolean {
  return parts === 2 && (database ?? '').toLowerCase() === 'ingested_files' && FORMAT_SCHEMAS.has(schema.toLowerCase());
}

export function knownDatabase(database: string | undefined): string {
  const d = (database ?? '').toLowerCase();
  return UNKNOWN_DATABASES.has(d) ? '' : d;
}

/** A physical table as the layer matches it: its parts (lower-cased; '' when unknown) and where it lives. */
export interface PhysicalRef { id: string; fqn: string; database: string; schema: string; table: string; system?: string; environment?: string }

/** A table node (or any `db.schema.table` / `schema.table` name) as a `PhysicalRef`. */
export function physicalRef(t: Pick<BaseNode, 'id' | 'label' | 'origin'> & Partial<Pick<TableNode, 'fqn' | 'database'>>): PhysicalRef {
  const fqn = t.fqn || t.label;
  const parts = fqn.toLowerCase().split('.');
  const table = parts[parts.length - 1];
  const schema = parts.length >= 2 && !isFormatSchema(parts[parts.length - 2], t.database, parts.length) ? parts[parts.length - 2] : '';
  const database = parts.length >= 3 ? knownDatabase(parts[parts.length - 3]) : knownDatabase(t.database);
  return { id: t.id, fqn, database, schema, table, ...(t.origin?.system ? { system: t.origin.system } : {}), ...(t.origin?.systemEnvironment ? { environment: t.origin.systemEnvironment } : {}) };
}

/** A name in SQL (`db.schema.table`, `schema.table`, `table`) as a reference; unknown parts stay ''. */
export function nameRef(name: string): PhysicalRef {
  const parts = name.replace(/["`[\]]/g, '').toLowerCase().split('.');
  return { id: name, fqn: name, table: parts[parts.length - 1], schema: parts.length >= 2 ? parts[parts.length - 2] : '', database: parts.length >= 3 ? knownDatabase(parts[parts.length - 3]) : '' };
}

/** Whether a physical table can be a semantic table's base: equal where both sides know the part. */
export function physicalMatches(lt: Pick<LayerTable, 'baseName' | 'baseSchema' | 'baseDatabase' | 'binding'>, ref: PhysicalRef): boolean {
  if (ref.table !== lt.baseName) return false;
  if (ref.schema && lt.baseSchema && ref.schema !== lt.baseSchema) return false;
  if (ref.database && lt.baseDatabase && ref.database !== lt.baseDatabase) return false;
  if (lt.binding && ref.system && ref.system !== lt.binding.system) return false;
  if (lt.binding?.environment && ref.environment && ref.environment !== lt.binding.environment) return false;
  return true;
}

/**
 * The physical table a semantic table stands for: the one candidate that
 * fits, or — when several do — the one whose database is known and equal;
 * otherwise none, and the candidates (ambiguous).
 */
export function matchBase(lt: LayerTable, refs: readonly PhysicalRef[]): { match?: PhysicalRef; candidates: PhysicalRef[] } {
  const candidates = refs.filter((r) => physicalMatches(lt, r));
  if (candidates.length === 1) return { match: candidates[0], candidates };
  const exact = candidates.filter((r) => lt.baseDatabase && r.database === lt.baseDatabase && (!lt.baseSchema || r.schema === lt.baseSchema));
  return exact.length === 1 ? { match: exact[0], candidates } : { candidates };
}

/**
 * The semantic tables over a physical table. With `all` (the estate's
 * tables), only those that resolve to *this* table — not to another of the
 * same name — count.
 */
export function semanticTablesFor(index: SemanticLayerIndex, ref: PhysicalRef | string, all?: readonly PhysicalRef[]): LayerTable[] {
  const r = typeof ref === 'string' ? nameRef(ref) : ref;
  return (index.byBaseName.get(r.table) ?? []).filter((lt) => physicalMatches(lt, r) && (!all || matchBase(lt, all).match?.id === r.id));
}

export interface SemanticDefinitions {
  tables: LayerTable[];
  metrics: LayerElement[];
  filters: LayerElement[];
  relationships: LayerRelationship[];
  /** `model@revision` of every model the definitions came from. */
  models: string[];
}

/**
 * The definitions a task over these physical tables needs (§6.5): their
 * metrics and filters, and the relationships that touch them — so a pack
 * hands the agent the approved joins instead of letting it infer one.
 */
export function definitionsFor(index: SemanticLayerIndex, refs: ReadonlyArray<PhysicalRef | string>, all?: readonly PhysicalRef[]): SemanticDefinitions {
  const tables = [...new Set(refs.flatMap((f) => semanticTablesFor(index, f, all)))];
  const names = new Set(tables.map((t) => `${t.model}|${t.table.name.toLowerCase()}`));
  const bases = new Set(tables.map((t) => t.key));
  const of = (list: ElementList) => index.elements.filter((e) => e.list === list && names.has(`${e.model}|${e.table.toLowerCase()}`));
  const relationships = index.relationships.filter((r) => bases.has(r.left) || bases.has(r.right));
  const used = new Set([...tables.map((t) => t.model), ...relationships.map((r) => r.model)]);
  return { tables, metrics: of('metrics'), filters: of('filters'), relationships, models: index.models.filter((m) => used.has(m.name)).map((m) => `${m.name}@${m.revision}`) };
}

/** Graph ids of semantic-layer nodes. */
export const semanticModelId = (model: string) => `sem:${model}`;
export const semanticTableId = (model: string, table: string) => `sem:${model}/${table}`;
export const semanticElementId = (model: string, table: string, name: string) => `sem:${model}/${table}/${name}`;
export const semanticRelationshipId = (model: string, name: string) => `sem:${model}#rel:${name}`;
export const semanticQueryId = (model: string, name: string) => `sem:${model}#vq:${name}`;
export const semanticInstructionsId = (model: string) => `sem:${model}#instructions`;
