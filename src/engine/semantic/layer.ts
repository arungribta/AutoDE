import { ELEMENT_LISTS, ElementList, SemanticModel, SemanticTable } from './model';

/**
 * The semantic layer as the context layer uses it (C5b;
 * docs/context-layer-requirements.md §6.5): the **approved** definitions — shared
 * models approved at their current revision, and the active problem's
 * composites approved at their current resolution — indexed for packs, the
 * grounding check and the graph. Drafts are listed (for the Knowledge
 * Explorer) but never used as authority: an agent may not build on a join or
 * metric a person hasn't approved. Pure: `store.ts` loads it
 * (`loadSemanticLayer`), `layerGraph.ts` turns it into graph nodes.
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
}

export interface LayerTable {
  model: string;
  table: SemanticTable;
  /** `schema.table`, lower-cased: what physical tables are matched by. */
  base: string;
  baseName: string;
  baseSchema: string;
}

export interface LayerElement { model: string; table: string; list: ElementList; name: string; expr: string; synonyms: string[]; description?: string }

export interface LayerRelationship {
  model: string;
  name: string;
  leftTable: string;
  rightTable: string;
  /** Base tables (`schema.table`, lower-cased) of the two sides. */
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
      const lt: LayerTable = { model: model.name, table: t, base: `${baseSchema}.${baseName}`, baseName, baseSchema };
      baseOf.set(t.name.toLowerCase(), lt.base);
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

/** Whether a graph table (by its fqn) is the base table of a semantic table. */
export function baseMatches(lt: Pick<LayerTable, 'base'>, fqn: string): boolean {
  const f = fqn.toLowerCase();
  return f === lt.base || f.endsWith(`.${lt.base}`);
}

/** The semantic tables over a physical table (by fqn). */
export function semanticTablesFor(index: SemanticLayerIndex, fqn: string): LayerTable[] {
  const last = fqn.toLowerCase().split('.').pop() ?? '';
  return (index.byBaseName.get(last) ?? []).filter((lt) => fqn.includes('.') ? baseMatches(lt, fqn) : true);
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
export function definitionsFor(index: SemanticLayerIndex, fqns: readonly string[]): SemanticDefinitions {
  const tables = [...new Set(fqns.flatMap((f) => semanticTablesFor(index, f)))];
  const names = new Set(tables.map((t) => `${t.model}|${t.table.name.toLowerCase()}`));
  const bases = new Set(tables.map((t) => t.base));
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
