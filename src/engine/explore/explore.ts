import { Assertion, TrustTier, isLive, trustRank } from '../context/assertions';
import { Conflict } from '../context/conflicts';
import { createSubjectResolver, isMirror } from '../context/projection';
import { GraphView, resolveText } from '../context/retrieval';
import { BaseNode, BusinessRuleNode, BusinessTermNode, ColumnNode, GraphEdge, TableNode, VerifiedQueryNode } from '../context/types';
import { CatalogEntry, CatalogLookup } from '../context/catalog';
import { governanceFacts, sameTable } from '../governance/governance';
import { PhysicalRef, SemanticLayerIndex, isFormatSchema, knownDatabase, matchBase, physicalRef } from '../semantic/layer';
import { semanticGraph } from '../semantic/layerGraph';
import { AssetMetadata, MetadataConfig, assetMetadata, metadataBySubject, patternMatches, qualityDimension } from '../metadata/model';
import { Article, checkArticle } from '../knowledge/articles';

/**
 * Exploring what AutoDE knows (C5b; docs/context-layer-requirements.md §6.10,
 * §7.5): search with facets, the asset context of any object, column, term,
 * fact or semantic element, a graph neighbourhood, a fact table and an
 * overview. One deterministic implementation behind the Knowledge Explorer,
 * `autode explore` and the MCP tools, so every surface shows the same thing.
 *
 * Read-only. The graph it walks is the projected graph plus the semantic
 * layer's nodes (drafts included, flagged — the Explorer shows what exists;
 * packs and grounding use only what is approved).
 */

/**
 * Asset types, named as the catalogs and standards name them (v0.50.1;
 * docs/context-layer-requirements.md §6.11): physical objects as catalogs do,
 * semantic objects as Snowflake's semantic model does, and AutoDE's own
 * facts as *knowledge facts* (DataHub's "assertion" is a quality check, so
 * the word isn't reused).
 */
export type AssetType = 'database' | 'schema' | 'table' | 'view' | 'column' | 'domain' | 'data_product' | 'knowledge_article' | 'glossary_term' | 'rule' | 'verified_query' | 'semantic_model' | 'logical_table' | 'dimension' | 'time_dimension' | 'semantic_fact' | 'metric' | 'filter' | 'relationship' | 'custom_instruction' | 'knowledge_fact';

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  database: 'Database', schema: 'Schema', domain: 'Domain', data_product: 'Data product', knowledge_article: 'Knowledge article', table: 'Table', view: 'View', column: 'Column', glossary_term: 'Glossary term', rule: 'Rule', verified_query: 'Verified query',
  semantic_model: 'Semantic model', logical_table: 'Logical table', dimension: 'Dimension', time_dimension: 'Time dimension', semantic_fact: 'Fact (semantic)', metric: 'Metric', filter: 'Filter',
  relationship: 'Relationship', custom_instruction: 'Custom instructions',
  knowledge_fact: 'Knowledge fact'
};

/**
 * The three layers (context-layer §6.1, owner 2026-10-28): **physical** — what
 * exists (the metadata the others rest on); **context** — what it means to
 * the business and what is known about it (glossary, ontology; knowledge
 * facts, rules, articles; governance); **semantic** — how it is measured and
 * queried (semantic models and everything in them, verified queries
 * included).
 */
export type Layer = 'physical' | 'context' | 'semantic';

export const LAYER_OF: Record<AssetType, Layer> = {
  database: 'physical', schema: 'physical', domain: 'context', data_product: 'context', knowledge_article: 'context', table: 'physical', view: 'physical', column: 'physical',
  glossary_term: 'context', rule: 'context', knowledge_fact: 'context',
  verified_query: 'semantic', semantic_model: 'semantic', logical_table: 'semantic', dimension: 'semantic', time_dimension: 'semantic', semantic_fact: 'semantic', metric: 'semantic', filter: 'semantic', relationship: 'semantic', custom_instruction: 'semantic'
};

/**
 * Certification, as catalogs show it on an asset (Atlan, OpenMetadata):
 * derived from the evidence behind it (AutoDE's trust tiers, §4.1) or, for
 * the semantic layer, from approval. The tier itself stays available as
 * `trust` (shown as *Evidence*).
 */
export type Certification = 'verified' | 'documented' | 'unverified' | 'draft' | 'deprecated';

export function certificationOf(trust: TrustTier | undefined): Certification | undefined {
  if (!trust) return undefined;
  return trust === 'verified' || trust === 'confirmed' ? 'verified' : trust === 'documented' ? 'documented' : 'unverified';
}

export interface AssetSummary {
  id: string;
  /** Physical, context or semantic (§6.1). */
  layer: Layer;
  assetType: AssetType;
  label: string;
  /** Tables: `db.schema.table`; columns: `<table fqn>.<column>`. */
  fqn?: string;
  description?: string;
  /** The logical source or target system (estate, K1). */
  system?: string;
  /** The technology it lives on (snowflake, databricks, oracle, file, semantic layer). */
  platform?: string;
  environment?: string;
  /** Physical assets: their database (Databricks: catalog) and schema; `(unknown)` when the source didn't say. */
  database?: string;
  schema?: string;
  certification?: Certification;
  /** Evidence: the strongest trust tier among the facts it is projected from (a knowledge fact: its own). */
  trust?: TrustTier;
  /** Assets: active, deprecated, approved, draft, not visible. */
  status?: string;
  /** Knowledge facts only: proposed, active, needs_review, superseded, rejected. */
  reviewState?: string;
  classification?: string;
  /** Glossary terms assigned to it. */
  glossaryTerms?: string[];
  /** MM1 (§6.11): its domain, owners (people) and tags (`key` or `key=value`). */
  domain?: string;
  owners?: string[];
  tags?: string[];
  /** Who certified it, when a person did (otherwise the certification is derived from evidence or approval). */
  certifiedBy?: string;
  /** In the working set (graph), or known only from the estate catalog. */
  inWorkingSet: boolean;
}

export interface ExploreSources {
  graph: GraphView;
  assertions: readonly Assertion[];
  conflicts: readonly Conflict[];
  catalog?: CatalogLookup & { all?(): CatalogEntry[] };
  /** The semantic layer, drafts included (they are shown, flagged). */
  semantic?: SemanticLayerIndex;
  /** Artifacts and what their grounding manifests rest on (§8.3). */
  artifacts?: readonly ArtifactUse[];
  /** The metadata model's configuration: tag groups, custom properties, domains (MM1). */
  metadata?: MetadataConfig;
  /** Knowledge articles (MM1). */
  articles?: readonly Article[];
}

export interface ArtifactUse {
  path: string;
  agent?: string;
  generatedAt?: string;
  /** Assertion ids the manifest relies on. */
  assertions: string[];
  /** Decision subjects (table ids) and primitive lineage (fqns). */
  subjects: string[];
  warnings: number;
}

interface Index {
  graph: GraphView;
  nodes: Map<string, BaseNode>;
  out: Map<string, GraphEdge[]>;
  in: Map<string, GraphEdge[]>;
  tableOf: Map<string, string>;
  columnsOf: Map<string, string[]>;
  bySubject: Map<string, Assertion[]>;
  assertions: Map<string, Assertion>;
  classification: Map<string, { classification: string; strategy?: string; factId?: string; trust?: TrustTier }>;
  /** Asset id → the glossary terms assigned to it. */
  termsOf: Map<string, string[]>;
  /** Physical tables as the semantic layer matches them (§6.4), by id. */
  refs: Map<string, PhysicalRef>;
  /** MM1: metadata facts by subject, the configuration, and each asset's metadata (cached). */
  meta: Map<string, Assertion[]>;
  config: MetadataConfig;
  assetMeta: Map<string, AssetMetadata>;
  summaries: Map<string, AssetSummary>;
}

const indexes = new WeakMap<ExploreSources, Index>();

function buildIndex(sources: ExploreSources): Index {
  const cached = indexes.get(sources);
  if (cached) return cached;
  const overlay = sources.semantic ? semanticGraph(sources.semantic, sources.graph) : { nodes: [], edges: [] };
  const containers = containerGraph(sources.graph);
  const config = sources.metadata ?? { tagGroups: [], properties: [], domains: [], errors: [] };
  const governance = governanceNodes(config, sources.articles ?? [], new Set([...sources.graph.nodes, ...overlay.nodes].map((n) => n.id)));
  const graph: GraphView = { nodes: [...sources.graph.nodes, ...containers.nodes, ...overlay.nodes, ...governance.nodes], edges: [...sources.graph.edges, ...containers.edges, ...overlay.edges, ...governance.edges] };
  const nodes = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const out = new Map<string, GraphEdge[]>();
  const inc = new Map<string, GraphEdge[]>();
  const tableOf = new Map<string, string>();
  const columnsOf = new Map<string, string[]>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const list = m.get(k); if (list) list.push(v); else m.set(k, [v]); };
  for (const e of graph.edges) {
    push(out, e.source, e);
    push(inc, e.target, e);
    if (e.type === 'contains' && nodes.get(e.target)?.type === 'column') {
      tableOf.set(e.target, e.source);
      push(columnsOf, e.source, e.target);
    }
  }
  const bySubject = new Map<string, Assertion[]>();
  for (const a of sources.assertions) {
    if (isMirror(a)) continue;
    for (const s of a.subject) push(bySubject, s, a);
  }
  const classification = new Map<string, { classification: string; strategy?: string; factId?: string; trust?: TrustTier }>();
  const gov = governanceFacts(sources.assertions).filter((g) => g.status === undefined || isLive(g.status));
  if (gov.length) {
    for (const [colId, tableId] of tableOf) {
      const t = nodes.get(tableId) as TableNode | undefined;
      const c = nodes.get(colId);
      const g = t && c ? gov.find((x) => x.subject === colId || (sameTable(x.table, t.fqn || t.label) && x.column === c.label.toLowerCase())) : undefined;
      if (g) classification.set(colId, { classification: g.classification, ...(g.strategy ? { strategy: g.strategy } : {}), ...(g.assertionId ? { factId: g.assertionId } : {}), ...(g.trust ? { trust: g.trust } : {}) });
    }
  }
  const termsOf = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (n.type !== 'business_term') continue;
    const targets = new Set([...((n as BusinessTermNode).mappedNodeIds ?? []), ...(out.get(n.id) ?? []).filter((e) => e.type === 'maps_to').map((e) => e.target)]);
    for (const t of targets) push(termsOf, t, n.label);
  }
  const refs = new Map(sources.graph.nodes.filter((n) => n.type === 'table').map((n) => [n.id, physicalRef(n as TableNode)] as const));
  const idx: Index = { graph, nodes, out, in: inc, tableOf, columnsOf, bySubject, assertions: new Map(sources.assertions.map((a) => [a.id, a] as const)), classification, termsOf, refs, meta: metadataBySubject(sources.assertions), config, assetMeta: new Map(), summaries: new Map() };
  indexes.set(sources, idx);
  return idx;
}

const UNKNOWN = '(unknown)';

/**
 * Databases and schemas as physical assets (v0.50.3; the containers of
 * DataHub, OpenMetadata and Unity), computed from the tables' qualified
 * names within each system and environment: nothing new is stored. A table
 * whose source named no database is in an `(unknown)` database, never a
 * guessed one.
 */
/** A table's database and schema as its source wrote them (case kept); `(unknown)` for a database the source didn't name. */
function containersOf(t: TableNode): { database: string; schema: string } {
  const parts = (t.fqn || t.label).split('.');
  const database = parts.length >= 3 ? parts[parts.length - 3] : knownDatabase(t.database) ? t.database : UNKNOWN;
  return { database, schema: parts.length >= 2 && !isFormatSchema(parts[parts.length - 2], t.database, parts.length) ? parts[parts.length - 2] : '' };
}

function containerGraph(graph: GraphView): { nodes: BaseNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, BaseNode>();
  const edges: GraphEdge[] = [];
  for (const n of graph.nodes) {
    if (n.type !== 'table') continue;
    const { database: db, schema } = containersOf(n as TableNode);
    const system = n.origin?.system ?? 'unassigned';
    const env = n.origin?.systemEnvironment ?? 'default';
    // Ids are case-insensitive, as the platforms' unquoted identifiers are; labels keep the source's case.
    const dbId = `phys:${system}/${env}/${db.toLowerCase()}`;
    const origin = n.origin ? { ...n.origin } : undefined;
    if (!nodes.has(dbId)) {
      nodes.set(dbId, { id: dbId, type: 'database', label: db, metadata: { system, environment: env }, version: 1, ...(origin ? { origin } : {}) });
    }
    if (!schema) { edges.push({ id: `contains:${dbId}->${n.id}`, source: dbId, target: n.id, type: 'contains' }); continue; }
    const schemaId = `${dbId}/${schema.toLowerCase()}`;
    if (!nodes.has(schemaId)) {
      nodes.set(schemaId, { id: schemaId, type: 'schema', label: schema, metadata: { system, environment: env, database: db }, version: 1, ...(origin ? { origin } : {}) });
      edges.push({ id: `contains:${dbId}->${schemaId}`, source: dbId, target: schemaId, type: 'contains' });
    }
    edges.push({ id: `contains:${schemaId}->${n.id}`, source: schemaId, target: n.id, type: 'contains' });
  }
  return { nodes: [...nodes.values()], edges };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const domainId = (name: string) => `domain:${slug(name)}`;
export const dataProductId = (domain: string, name: string) => `product:${slug(domain)}/${slug(name)}`;
export const articleId = (s: string) => `article:${s}`;

/**
 * Domains and data products (from domains.yaml) and knowledge articles as
 * context-layer assets (MM1): a domain contains its data products; an
 * article relates to what it is about.
 */
function governanceNodes(config: MetadataConfig, articles: readonly Article[], known: ReadonlySet<string>): { nodes: BaseNode[]; edges: GraphEdge[] } {
  const nodes: BaseNode[] = []; const edges: GraphEdge[] = [];
  for (const d of config.domains) {
    const id = domainId(d.name);
    nodes.push({ id, type: 'domain', label: d.name, ...(d.description ? { description: d.description } : {}), metadata: { owners: d.owners, semanticModels: d.semanticModels, patterns: d.assets }, version: 1 });
    for (const p of d.dataProducts) {
      const pid = dataProductId(d.name, p.name);
      nodes.push({ id: pid, type: 'data_product', label: p.name, ...(p.description ? { description: p.description } : {}), metadata: { domain: d.name, ...(p.owner ? { owner: p.owner } : {}), patterns: p.assets }, version: 1 });
      edges.push({ id: `contains:${id}->${pid}`, source: id, target: pid, type: 'contains' });
    }
  }
  for (const a of articles) {
    const id = articleId(a.slug);
    nodes.push({ id, type: 'knowledge_article', label: a.title, metadata: { slug: a.slug, state: a.state, file: a.file, about: a.about, cites: a.cites, ...(a.author ? { author: a.author } : {}), ...(a.approved ? { approved: a.approved } : {}), ...(a.domain ? { domain: a.domain } : {}) }, version: 1 });
    for (const t of a.about) if (known.has(t)) edges.push({ id: `related_to:${id}->${t}`, source: id, target: t, type: 'related_to' });
  }
  return { nodes, edges };
}

/** An asset's metadata (MM1), cached: its facts, then domains.yaml. */
function metaOf(n: BaseNode, idx: Index): AssetMetadata | undefined {
  if (n.type === 'domain' || n.type === 'data_product' || n.type === 'knowledge_article') return undefined;
  const hit = idx.assetMeta.get(n.id);
  if (hit) return hit;
  const fqn = fqnOf(n, idx);
  const m = assetMetadata(idx.meta.get(n.id) ?? [], idx.config, { id: n.id, ...(fqn ? { fqn } : {}), ...(typeof n.metadata?.model === 'string' ? { model: n.metadata.model } : {}) });
  idx.assetMeta.set(n.id, m);
  return m;
}

function trustOf(ids: readonly string[] | undefined, idx: Index): TrustTier | undefined {
  const tiers = (ids ?? []).map((id) => idx.assertions.get(id)?.trust).filter((t): t is TrustTier => !!t);
  return tiers.sort((a, b) => trustRank(b) - trustRank(a))[0];
}

const ELEMENT_TYPES: Record<string, AssetType> = { dimensions: 'dimension', time_dimensions: 'time_dimension', facts: 'semantic_fact', metrics: 'metric', filters: 'filter' };

function assetTypeOf(n: BaseNode): AssetType {
  switch (n.type) {
    case 'table': case 'semantic_view': return (n as TableNode).isView ? 'view' : 'table';
    case 'business_term': return 'glossary_term';
    case 'business_rule': return 'rule';
    case 'semantic_table': return 'logical_table';
    case 'semantic_element': return ELEMENT_TYPES[String(n.metadata?.list)] ?? 'dimension';
    case 'semantic_relationship': return 'relationship';
    case 'semantic_instruction': return 'custom_instruction';
    default: return n.type as AssetType;
  }
}

const PLATFORMS = /^(snowflake|databricks|oracle|postgres|postgresql|bigquery|redshift|sqlserver|mysql)\b/i;

/** The technology an object lives on: its connection's platform, a platform named as its source, else a file. */
function platformOf(n: { id: string; origin?: BaseNode['origin'] }): string | undefined {
  if (n.id.startsWith('sem:')) return 'semantic layer';
  const o = n.origin;
  if (!o) return undefined;
  const fromConnection = o.connectionId?.split(':')[0];
  if (fromConnection) return fromConnection.toLowerCase();
  const named = PLATFORMS.exec(o.sourceRef ?? '')?.[1];
  if (named) return named.toLowerCase().replace('postgresql', 'postgres');
  return o.sourceRef && /[\\/.]/.test(o.sourceRef) ? 'file' : undefined;
}

function fqnOf(n: BaseNode, idx: Index): string | undefined {
  if (n.type === 'table' || n.type === 'semantic_view') return (n as TableNode).fqn || n.label;
  if (n.type === 'column') {
    const t = idx.nodes.get(idx.tableOf.get(n.id) ?? '') as TableNode | undefined;
    return t ? `${t.fqn || t.label}.${n.label}` : n.label;
  }
  return undefined;
}

/** Built field by field and cached per index: browsing a large estate summarizes tens of thousands of nodes (NFR-1). */
function summarize(n: BaseNode, idx: Index): AssetSummary {
  const hit = idx.summaries.get(n.id);
  if (hit) return hit;
  const assetType = assetTypeOf(n);
  const s: AssetSummary = { id: n.id, layer: LAYER_OF[assetType], assetType, label: n.label, inWorkingSet: true };
  const fqn = fqnOf(n, idx);
  if (fqn) s.fqn = fqn;
  if (n.description) s.description = n.description;
  if (n.origin?.system) s.system = n.origin.system;
  const platform = platformOf(n);
  if (platform) s.platform = platform;
  if (n.origin?.systemEnvironment) s.environment = n.origin.systemEnvironment;
  const trust = n.supportedBy?.length ? trustOf(n.supportedBy, idx) : undefined;
  if (trust) s.trust = trust;
  if (typeof n.metadata?.approved === 'boolean') {
    // The semantic layer: certified by a person's approval.
    s.status = n.metadata.approved ? 'approved' : 'draft';
    s.certification = n.metadata.approved ? 'verified' : 'draft';
  } else {
    if (n.status) s.status = n.status;
    const cert = certificationOf(trust);
    if (cert) s.certification = cert;
  }
  const cls = n.type === 'column' ? idx.classification.get(n.id) : undefined;
  if (cls) s.classification = cls.classification;
  const table = idx.nodes.get(n.type === 'column' ? idx.tableOf.get(n.id) ?? '' : n.id);
  if (table?.type === 'table') { const c = containersOf(table as TableNode); s.database = c.database; if (c.schema) s.schema = c.schema; }
  else if (n.type === 'database') s.database = n.label;
  else if (n.type === 'schema') { s.database = String(n.metadata.database ?? UNKNOWN); s.schema = n.label; }
  const terms = idx.termsOf.get(n.id);
  if (terms?.length) s.glossaryTerms = terms;
  const meta = metaOf(n, idx);
  if (meta) {
    if (meta.domain) s.domain = meta.domain.name;
    if (meta.owners.length) s.owners = [...new Set(meta.owners.map((o) => o.person))];
    if (meta.tags.length) s.tags = meta.tags.map((t) => (t.value !== undefined ? `${t.key}=${t.value}` : t.key));
    if (meta.certification) { s.certification = meta.certification.status; s.certifiedBy = meta.certification.by; }
  }
  if (n.type === 'knowledge_article') { s.status = String(n.metadata.state ?? 'draft'); s.certification = n.metadata.state === 'approved' ? 'verified' : 'draft'; }
  idx.summaries.set(n.id, s);
  return s;
}

function factSummary(a: Assertion): AssetSummary {
  return { id: a.id, layer: 'context', assetType: 'knowledge_fact', label: a.statement, trust: a.trust, certification: certificationOf(a.trust), reviewState: a.status, inWorkingSet: true, description: `${a.kind} · ${a.predicate}` };
}

function catalogSummary(e: CatalogEntry): AssetSummary {
  const platform = platformOf({ id: e.id, origin: e.origin });
  return { id: e.id, layer: 'physical', assetType: e.table.isView ? 'view' : 'table', label: e.table.label, fqn: e.table.fqn, ...(e.table.description ? { description: e.table.description } : {}), system: e.system, ...(platform ? { platform } : {}), environment: e.environment, inWorkingSet: false, ...(e.visible === false ? { status: 'not visible' } : {}) };
}

// ── Search ──

export interface SearchOptions {
  layers?: Layer[];
  assetTypes?: AssetType[];
  systems?: string[];
  platforms?: string[];
  environments?: string[];
  databases?: string[];
  schemas?: string[];
  domains?: string[];
  owners?: string[];
  tags?: string[];
  certifications?: Certification[];
  statuses?: string[];
  reviewStates?: string[];
  classifications?: string[];
  glossaryTerms?: string[];
  limit?: number;
  offset?: number;
}

/** Facets, in the order catalogs show them. */
export const FACETS = ['layer', 'assetType', 'system', 'platform', 'environment', 'database', 'schema', 'domain', 'owner', 'certification', 'status', 'reviewState', 'classification', 'tag', 'glossaryTerm'] as const;
export type FacetName = typeof FACETS[number];
export type Facets = Record<FacetName, Record<string, number>>;
/** Facets the metadata model defines but that have no data yet (MM1, v0.51.0): shown, disabled. */
export const PENDING_FACETS: readonly FacetName[] = [];

export interface SearchResult {
  query: string;
  total: number;
  results: AssetSummary[];
  facets: Facets;
  /** Catalog matches outside the working set (opening one loads it on demand). */
  fromCatalog: number;
  /** Nothing matched every word: these are related results from the vocabulary (abbreviations, synonyms, glossary). */
  approximate?: boolean;
  /** Facets without data yet. */
  pendingFacets: FacetName[];
}

const BROWSABLE = new Set(['database', 'schema', 'domain', 'data_product', 'knowledge_article', 'table', 'semantic_view', 'column', 'business_term', 'business_rule', 'verified_query', 'metric', 'semantic_model', 'semantic_table', 'semantic_element', 'semantic_relationship', 'semantic_instruction']);

function textScore(hay: { label: string; fqn?: string; aliases?: readonly string[]; description?: string }, tokens: readonly string[], whole: string): number {
  const label = hay.label.toLowerCase();
  const fqn = (hay.fqn ?? '').toLowerCase();
  const aliases = (hay.aliases ?? []).map((a) => a.toLowerCase());
  const desc = (hay.description ?? '').toLowerCase();
  let score = 0;
  if (label === whole || fqn === whole) score += 100;
  else if (label.startsWith(whole)) score += 60;
  for (const t of tokens) {
    if (label.includes(t) || fqn.includes(t)) score += 20;
    else if (aliases.some((a) => a.includes(t))) score += 12;
    else if (desc.includes(t)) score += 4;
    else return 0; // every word has to match somewhere
  }
  return score;
}


/**
 * Searches objects, columns, terms, rules, queries, semantic elements and
 * facts by name, alias, synonym and description (every word must match), plus
 * the vocabulary-aware retrieval of K2 and the estate catalog beyond the
 * working set. An empty query browses everything. Facet counts are over the
 * query's matches before the facet filters, so a filter never hides its own
 * alternatives.
 */
export function searchAssets(sources: ExploreSources, query: string, options: SearchOptions = {}): SearchResult {
  const idx = buildIndex(sources);
  const whole = query.trim().toLowerCase();
  const tokens = whole.split(/[\s.]+/).filter(Boolean);
  const scored = new Map<string, { s: AssetSummary; score: number }>();
  let approximate = false;
  const add = (s: AssetSummary, score: number) => { const prev = scored.get(s.id); if (!prev || prev.score < score) scored.set(s.id, { s, score }); };
  for (const n of idx.graph.nodes) {
    if (!BROWSABLE.has(n.type)) continue;
    const s = summarize(n, idx);
    const score = tokens.length ? textScore({ label: n.label, fqn: s.fqn, aliases: n.aliases, description: n.description }, tokens, whole) : 1;
    if (score > 0) add(s, score + (n.type === 'table' ? 5 : 0));
  }
  if (tokens.length) {
    // Vocabulary-aware matches (abbreviations, synonyms, glossary) when plain text finds nothing:
    // they can't tell whether every word matched, so they never widen a search that has results.
    if (scored.size === 0) {
      for (const m of resolveText(query, idx.graph)) {
        const n = idx.nodes.get(m.nodeId);
        if (n && BROWSABLE.has(n.type)) add(summarize(n, idx), Math.round(m.score * 30));
      }
      approximate = scored.size > 0;
    }
  }
  // Knowledge facts (live or proposed); browsing lists them too, after the assets.
  for (const a of sources.assertions) {
    if (isMirror(a) || (!isLive(a.status) && a.status !== 'proposed')) continue;
    const score = tokens.length ? textScore({ label: a.statement }, tokens, whole) : 1;
    if (score > 0) add(factSummary(a), tokens.length ? Math.max(1, score - 10) : 0);
  }
  let fromCatalog = 0;
  if (tokens.length && sources.catalog) {
    for (const h of sources.catalog.search(query).slice(0, 50)) {
      if (idx.nodes.has(h.id)) continue;
      const e = sources.catalog.get(h.id);
      if (!e) continue;
      add(catalogSummary(e), Math.round(h.score * 20));
      fromCatalog++;
    }
  }
  // Plain comparisons, not localeCompare: browsing a large estate sorts tens of thousands of entries (NFR-1).
  const all = [...scored.values()].sort((a, b) => b.score - a.score || (a.s.label < b.s.label ? -1 : a.s.label > b.s.label ? 1 : a.s.id < b.s.id ? -1 : 1)).map((x) => x.s);
  const facets = Object.fromEntries(FACETS.map((f) => [f, {}])) as Facets;
  const bump = (f: Record<string, number>, v: string | undefined) => { if (v) f[v] = (f[v] ?? 0) + 1; };
  for (const r of all) {
    bump(facets.layer, r.layer); bump(facets.assetType, r.assetType); bump(facets.system, r.system); bump(facets.platform, r.platform); bump(facets.environment, r.environment); bump(facets.database, r.database); bump(facets.schema, r.schema); bump(facets.domain, r.domain);
    for (const o of r.owners ?? []) bump(facets.owner, o);
    for (const t of r.tags ?? []) bump(facets.tag, t);
    bump(facets.certification, r.certification); bump(facets.status, r.status); bump(facets.reviewState, r.reviewState); bump(facets.classification, r.classification);
    for (const t of r.glossaryTerms ?? []) bump(facets.glossaryTerm, t);
  }
  const keep = (v: string | undefined, allowed?: readonly string[]) => !allowed?.length || (!!v && allowed.includes(v));
  const keepAny = (vs: readonly string[] | undefined, allowed?: readonly string[]) => !allowed?.length || (vs ?? []).some((v) => allowed.includes(v));
  const filtered = all.filter((r) => keep(r.layer, options.layers) && keep(r.assetType, options.assetTypes) && keep(r.system, options.systems) && keep(r.platform, options.platforms) && keep(r.environment, options.environments) && keep(r.database, options.databases) && keep(r.schema, options.schemas) && keep(r.domain, options.domains) && keepAny(r.owners, options.owners) && keepAny(r.tags, options.tags)
    && keep(r.certification, options.certifications) && keep(r.status, options.statuses) && keep(r.reviewState, options.reviewStates) && keep(r.classification, options.classifications) && keepAny(r.glossaryTerms, options.glossaryTerms));
  const offset = options.offset ?? 0;
  return { query, total: filtered.length, results: filtered.slice(offset, offset + (options.limit ?? 50)), facets, fromCatalog, ...(approximate ? { approximate } : {}), pendingFacets: [...PENDING_FACETS] };
}

// ── Asset context (§7.5) ──

export interface FactRow {
  id: string;
  kind: string;
  predicate: string;
  statement: string;
  status: string;
  trust: TrustTier;
  /** The column it is about, when listed on its table. */
  about?: string;
  createdBy: string;
  validFrom: string;
  supersedes?: string;
  evidence: Array<{ type: string; ref: string; excerpt?: string }>;
  verification?: Assertion['verification'];
}

export interface RelatedAsset { relation: string; direction: 'out' | 'in'; asset: AssetSummary; trust?: TrustTier }

export interface AssetContext {
  asset: AssetSummary;
  /** Overview: provenance and freshness. */
  overview: { aliases: string[]; tags: string[]; origin?: { source: string; ref: string; reliability?: string; extractedAt?: string; lastVerifiedAt?: string }; loadedAt?: string; parent?: AssetSummary };
  /** Tables: their columns. */
  schema?: { columns: Array<AssetSummary & { dataType: string; nullable: boolean; primaryKey: boolean; foreignKey: boolean; strategy?: string }>; keys: FactRow[]; grain: FactRow[]; profile: FactRow[] };
  /** Business meaning: glossary terms, semantic elements over it, and (for semantic elements) their definition. */
  meaning: { terms: AssetSummary[]; semantic: Array<AssetSummary & { expr?: string; model?: string }>; definition?: Record<string, unknown>; concepts: AssetSummary[] };
  /** Relationships and derivations known today; observed, designed and generated lineage arrive in LIN. */
  lineage: { related: RelatedAsset[]; note: string };
  governance: { classifications: Array<{ column: string; classification: string; strategy?: string; factId?: string; trust?: TrustTier }>; rules: Array<{ id: string; text: string; enforcement: string; ruleType?: string; modality?: string; scope?: string }> };
  /** MM1 (§6.11): owners (with role, and whether inherited from the domain), domain, data products, tags, custom properties, certification. */
  metadata?: AssetMetadata;
  /** Quality expectations by DAMA dimension. */
  quality?: Array<{ dimension: string; checks: FactRow[] }>;
  /** Knowledge articles about it, with whether each is stale. */
  articles?: Array<{ id: string; slug: string; title: string; state: string; stale: string[] }>;
  /** A glossary term's definition and SKOS links (MM1). */
  term?: Record<string, unknown>;
  facts: FactRow[];
  /** Decisions and assumptions in scope: about this asset, or team-wide. */
  memory: FactRow[];
  usedBy: { artifacts: Array<{ path: string; agent?: string; generatedAt?: string; warnings: number }>; semanticModels: AssetSummary[]; queries: AssetSummary[] };
  conflicts: Array<{ rule: string; sides: string[] }>;
  /** A database's schemas, a schema's tables (v0.50.3). */
  contents?: Array<AssetSummary & { children: number }>;
  /** A logical table whose base table fits several physical tables: the candidates (§6.4). */
  ambiguousBase?: AssetSummary[];
  /** Where each part came from, by category (§7.5 traceability). */
  sources: { metadata: string[]; semantic: string[]; governance: string[]; facts: number };
}

function factRow(a: Assertion, about?: string): FactRow {
  return {
    id: a.id, kind: a.kind, predicate: a.predicate, statement: a.statement, status: a.status, trust: a.trust,
    ...(about ? { about } : {}),
    createdBy: a.createdBy, validFrom: a.validFrom,
    ...(a.supersedes ? { supersedes: a.supersedes } : {}),
    evidence: a.evidence.map((e) => ({ type: e.type, ref: e.ref, ...(e.excerpt ? { excerpt: e.excerpt } : {}) })),
    ...(a.verification ? { verification: a.verification } : {})
  };
}

const byRecent = (a: FactRow, b: FactRow) => (a.validFrom < b.validFrom ? 1 : a.validFrom > b.validFrom ? -1 : a.id.localeCompare(b.id));

/** Finds an asset by id, fact id, catalog id, or (case-insensitive) name or fqn when that is unique. */
export function resolveAsset(sources: ExploreSources, ref: string): { node?: BaseNode; fact?: Assertion; entry?: CatalogEntry } | undefined {
  const idx = buildIndex(sources);
  const node = idx.nodes.get(ref);
  if (node) return { node };
  const fact = idx.assertions.get(ref);
  if (fact && !isMirror(fact)) return { fact };
  const entry = sources.catalog?.get(ref);
  if (entry) return { entry };
  const lower = ref.trim().toLowerCase();
  const hits = idx.graph.nodes.filter((n) => BROWSABLE.has(n.type) && (n.label.toLowerCase() === lower || fqnOf(n, idx)?.toLowerCase() === lower));
  const tables = hits.filter((n) => n.type === 'table' || n.type === 'semantic_view');
  const pick = hits.length === 1 ? hits[0] : tables.length === 1 ? tables[0] : undefined;
  return pick ? { node: pick } : undefined;
}

/**
 * Everything AutoDE knows about one asset (§7.5), each item with its source
 * and trust: overview, schema, meaning, lineage so far, governance, facts,
 * memory (decisions and assumptions in scope), what uses it and conflicts.
 * Unbudgeted and asset-centred; what an agent's prompt receives is a pack.
 */
export function getAssetContext(sources: ExploreSources, ref: string): AssetContext | undefined {
  const idx = buildIndex(sources);
  const found = resolveAsset(sources, ref);
  if (!found) return undefined;
  if (found.fact) return factContext(found.fact, idx, sources);
  if (found.entry && !found.node) return catalogContext(found.entry);
  const n = found.node!;
  const asset = summarize(n, idx);
  const isTable = n.type === 'table' || n.type === 'semantic_view';
  const columnIds = isTable ? idx.columnsOf.get(n.id) ?? [] : [];
  const scope = [n.id, ...columnIds];
  const label = (id: string) => idx.nodes.get(id)?.label;

  // Facts about it (and, for a table, about its columns).
  const factsAbout = scope.flatMap((s) => (idx.bySubject.get(s) ?? []).map((a) => ({ a, about: s === n.id ? undefined : label(s) })));
  const seen = new Set<string>();
  const facts = factsAbout.filter(({ a }) => (seen.has(a.id) ? false : (seen.add(a.id), true))).map(({ a, about }) => factRow(a, about)).sort(byRecent);
  const live = facts.filter((f) => isLive(f.status as Assertion['status']));

  const parentId = n.type === 'column' ? idx.tableOf.get(n.id) : (idx.in.get(n.id) ?? []).find((e) => e.type === 'contains' && (e.source.startsWith('sem:') || e.source.startsWith('phys:')))?.source;
  const parent = parentId ? idx.nodes.get(parentId) : undefined;
  const overview: AssetContext['overview'] = {
    aliases: [...(n.aliases ?? [])], tags: [...(n.tags ?? [])],
    ...(n.origin ? { origin: { source: n.origin.source, ref: n.origin.sourceRef, ...(n.origin.reliability ? { reliability: n.origin.reliability } : {}), ...(n.origin.extractedAt ? { extractedAt: n.origin.extractedAt } : {}), ...(n.origin.lastVerifiedAt ? { lastVerifiedAt: n.origin.lastVerifiedAt } : {}) } } : {}),
    ...(isTable && sources.catalog?.get(n.id)?.loadedAt ? { loadedAt: sources.catalog.get(n.id)!.loadedAt } : {}),
    ...(parent ? { parent: summarize(parent, idx) } : {})
  };

  const schema: AssetContext['schema'] = isTable ? {
    columns: columnIds.map((id) => {
      const c = idx.nodes.get(id) as ColumnNode;
      const cls = idx.classification.get(id);
      return { ...summarize(c, idx), dataType: c.dataType || '', nullable: c.isNullable !== false, primaryKey: !!c.isPrimaryKey, foreignKey: !!c.isForeignKey, ...(cls?.strategy ? { strategy: cls.strategy } : {}) };
    }),
    keys: live.filter((f) => f.kind === 'key'),
    grain: live.filter((f) => f.kind === 'grain'),
    profile: live.filter((f) => f.kind === 'data_fact')
  } : undefined;

  // Meaning: glossary terms bound to it, semantic elements over it.
  const terms = new Map<string, AssetSummary>();
  for (const s of scope) for (const e of idx.in.get(s) ?? []) {
    const src = idx.nodes.get(e.source);
    if (e.type === 'maps_to' && src?.type === 'business_term') terms.set(src.id, summarize(src, idx));
  }
  for (const t of idx.graph.nodes) if (t.type === 'business_term' && ((t as BusinessTermNode).mappedNodeIds ?? []).some((m) => scope.includes(m))) terms.set(t.id, summarize(t, idx));
  const semantic = new Map<string, AssetSummary & { expr?: string; model?: string }>();
  // A table shows the semantic tables over it and the metrics built from its columns;
  // a column, the elements derived from it (the rest belongs to each column's own page).
  for (const s of scope) for (const e of idx.in.get(s) ?? []) {
    const src = idx.nodes.get(e.source);
    if (!src?.id.startsWith('sem:') || (e.type !== 'maps_to' && e.type !== 'derives_from')) continue;
    if (isTable && s !== n.id && src.type !== 'metric') continue;
    semantic.set(src.id, { ...summarize(src, idx), ...(typeof src.metadata.expr === 'string' ? { expr: src.metadata.expr } : {}), ...(typeof src.metadata.model === 'string' ? { model: src.metadata.model } : {}) });
  }
  const definition = n.id.startsWith('sem:') || n.type === 'knowledge_article' || n.type === 'domain' || n.type === 'data_product' ? { ...n.metadata } : undefined;

  // Lineage so far: derivations, mappings, relationships and foreign keys, both ways. Links to the
  // semantic layer are in Meaning, except on a semantic element's own page.
  const related: RelatedAsset[] = [];
  const LINEAGE = new Set(['derives_from', 'maps_to', 'foreign_key', 'related_to', 'uses_table']);
  const shows = (other: string) => n.id.startsWith('sem:') || !other.startsWith('sem:');
  for (const s of scope) {
    for (const e of idx.out.get(s) ?? []) if (LINEAGE.has(e.type) && !scope.includes(e.target) && idx.nodes.has(e.target) && shows(e.target)) related.push({ relation: e.type, direction: 'out', asset: summarize(idx.nodes.get(e.target)!, idx), ...(trustOf(e.supportedBy, idx) ? { trust: trustOf(e.supportedBy, idx) } : {}) });
    for (const e of idx.in.get(s) ?? []) if (LINEAGE.has(e.type) && !scope.includes(e.source) && idx.nodes.has(e.source) && shows(e.source)) related.push({ relation: e.type, direction: 'in', asset: summarize(idx.nodes.get(e.source)!, idx), ...(trustOf(e.supportedBy, idx) ? { trust: trustOf(e.supportedBy, idx) } : {}) });
  }

  // Governance: classifications in scope, rules that name it or are linked to it.
  const classifications = scope.filter((s) => idx.classification.has(s)).map((s) => ({ column: label(s) ?? s, ...idx.classification.get(s)! }));
  const names = [n.label, ...(isTable ? [(n as TableNode).fqn] : []), ...(n.type === 'column' ? [] : columnIds.map(label))].filter((x): x is string => !!x && x.length >= 4).map((x) => x.toLowerCase());
  const rules = idx.graph.nodes.filter((r): r is BusinessRuleNode => r.type === 'business_rule')
    .filter((r) => (idx.out.get(r.id) ?? []).some((e) => scope.includes(e.target)) || (idx.in.get(r.id) ?? []).some((e) => scope.includes(e.source)) || names.some((x) => new RegExp(`(?<![a-z0-9_])${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_])`).test(r.ruleText.toLowerCase())))
    .map((r) => ({ id: r.id, text: r.ruleText, enforcement: r.enforcementLevel, ...(typeof r.metadata?.ruleType === 'string' ? { ruleType: r.metadata.ruleType } : {}), ...(typeof r.metadata?.modality === 'string' ? { modality: r.metadata.modality } : {}), ...(typeof r.metadata?.scope === 'string' ? { scope: r.metadata.scope } : {}) }));

  // Memory: decisions and assumptions about it, or team-wide.
  const memory = [...facts.filter((f) => f.kind === 'decision' || f.kind === 'assumption'), ...(idx.bySubject.get('project') ?? []).filter((a) => (a.kind === 'decision' || a.kind === 'assumption') && isLive(a.status)).map((a) => factRow(a, 'team-wide'))].filter((f, i, all) => all.findIndex((x) => x.id === f.id) === i);

  // Used by: artifacts whose manifests rest on it, semantic models over it, queries that use it.
  const factIds = new Set(facts.map((f) => f.id));
  const fqn = asset.fqn?.toLowerCase();
  const artifacts = (sources.artifacts ?? []).filter((u) => u.subjects.some((s) => s === n.id || (!!fqn && s.toLowerCase() === fqn)) || u.assertions.some((id) => factIds.has(id) || (idx.nodes.get(n.id)?.supportedBy ?? []).includes(id)))
    .map((u) => ({ path: u.path, ...(u.agent ? { agent: u.agent } : {}), ...(u.generatedAt ? { generatedAt: u.generatedAt } : {}), warnings: u.warnings }));
  const semanticModels = [...new Set([...semantic.values()].map((s) => s.model).filter((m): m is string => !!m))].map((m) => idx.nodes.get(`sem:${m}`)).filter((x): x is BaseNode => !!x).map((x) => summarize(x, idx));
  const logicalOver = (idx.in.get(n.id) ?? []).filter((e) => e.type === 'maps_to' && e.source.startsWith('sem:')).map((e) => e.source);
  const queries = [...new Set([n.id, ...logicalOver].flatMap((t) => (idx.in.get(t) ?? []).filter((e) => e.type === 'uses_table').map((e) => e.source)))]
    .map((id) => idx.nodes.get(id)).filter((q): q is VerifiedQueryNode => q?.type === 'verified_query').map((q) => summarize(q, idx));

  const conflicts = sources.conflicts.filter((c) => c.subject.some((s) => scope.includes(s)) || c.ids.some((id) => factIds.has(id))).map((c) => ({ rule: c.rule, sides: c.sides }));
  const contents = n.type === 'database' || n.type === 'schema' ? childrenOf(n.id, idx) : n.type === 'domain' || n.type === 'data_product' ? membersOf(n, idx) : undefined;
  const metadata = metaOf(n, idx);
  const quality = (() => {
    const by = new Map<string, FactRow[]>();
    for (const f of live.filter((x) => x.kind === 'quality_expectation')) { const d = qualityDimension(idx.assertions.get(f.id)?.value) ?? 'validity'; by.set(d, [...(by.get(d) ?? []), f]); }
    return [...by.entries()].map(([dimension, checks]) => ({ dimension, checks }));
  })();
  const scopeSet = new Set(scope);
  const articles = (sources.articles ?? []).filter((a) => a.about.some((x) => scopeSet.has(x))).map((a) => ({ id: articleId(a.slug), slug: a.slug, title: a.title, state: a.state, stale: checkArticle(a, sources.assertions).staleBecause }));
  const termFact = n.type === 'business_term' ? (n.supportedBy ?? []).map((id) => idx.assertions.get(id)).find((a) => a?.kind === 'business_term') : undefined;
  const ambiguousBase = Array.isArray(n.metadata?.ambiguous) ? (n.metadata.ambiguous as string[]).map((id) => idx.nodes.get(id)).filter((x): x is BaseNode => !!x).map((x) => summarize(x, idx)) : undefined;
  return {
    asset, overview, ...(schema ? { schema } : {}), ...(contents ? { contents } : {}), ...(ambiguousBase?.length ? { ambiguousBase } : {}),
    ...(metadata ? { metadata } : {}), ...(quality.length ? { quality } : {}), ...(articles.length ? { articles } : {}), ...(termFact ? { term: { ...(termFact.value as Record<string, unknown>) } } : {}),
    meaning: { terms: [...terms.values()], semantic: [...semantic.values()], ...(definition ? { definition } : {}), concepts: [] },
    lineage: { related, note: 'Relationships, mappings and derivations known today. Observed (platform), designed (mappings, specifications) and generated (artifacts) lineage, and impact analysis, arrive in LIN (v0.53.0).' },
    governance: { classifications, rules },
    facts, memory,
    usedBy: { artifacts, semanticModels, queries },
    conflicts,
    sources: {
      metadata: n.origin ? [`${n.origin.source}:${n.origin.sourceRef}`] : [],
      semantic: [...new Set([...semantic.values()].map((s) => s.model).filter((m): m is string => !!m))],
      governance: classifications.map((c) => c.factId).filter((x): x is string => !!x).map((id) => `fact:${id}`),
      facts: facts.length
    }
  };
}

function factContext(a: Assertion, idx: Index, sources: ExploreSources): AssetContext {
  const subjects = a.subject.map((s) => idx.nodes.get(s)).filter((x): x is BaseNode => !!x).map((x) => summarize(x, idx));
  const chain: FactRow[] = [];
  let cur: Assertion | undefined = a;
  while (cur?.supersedes && chain.length < 20) { cur = idx.assertions.get(cur.supersedes); if (cur) chain.push(factRow(cur)); }
  const later = sources.assertions.filter((x) => x.supersedes === a.id).map((x) => factRow(x));
  return {
    asset: factSummary(a),
    overview: { aliases: [], tags: [] },
    meaning: { terms: [], semantic: [], concepts: [] },
    lineage: { related: subjects.map((s) => ({ relation: 'about', direction: 'out' as const, asset: s })), note: 'A fact links to what it is about; its history is in facts.' },
    governance: { classifications: [], rules: [] },
    facts: [factRow(a), ...later, ...chain],
    memory: [],
    usedBy: { artifacts: (sources.artifacts ?? []).filter((u) => u.assertions.includes(a.id)).map((u) => ({ path: u.path, ...(u.agent ? { agent: u.agent } : {}), ...(u.generatedAt ? { generatedAt: u.generatedAt } : {}), warnings: u.warnings })), semanticModels: [], queries: [] },
    conflicts: sources.conflicts.filter((c) => c.ids.includes(a.id)).map((c) => ({ rule: c.rule, sides: c.sides })),
    sources: { metadata: [], semantic: [], governance: a.predicate === 'classification' ? [`fact:${a.id}`] : [], facts: 1 }
  };
}

function catalogContext(e: CatalogEntry): AssetContext {
  return {
    asset: catalogSummary(e),
    overview: { aliases: [...(e.table.aliases ?? [])], tags: [], ...(e.origin ? { origin: { source: e.origin.source, ref: e.origin.sourceRef } } : {}), ...(e.loadedAt ? { loadedAt: e.loadedAt } : {}) },
    schema: { columns: (e.columns ?? []).map((c) => ({ id: c.id, layer: 'physical' as const, assetType: 'column' as const, label: c.label, fqn: `${e.table.fqn}.${c.label}`, system: e.system, environment: e.environment, inWorkingSet: false, dataType: c.dataType || '', nullable: c.isNullable !== false, primaryKey: !!c.isPrimaryKey, foreignKey: !!c.isForeignKey })), keys: [], grain: [], profile: [] },
    meaning: { terms: [], semantic: [], concepts: [] },
    lineage: { related: [], note: 'Known from the estate catalog only: AutoDE loads it into the working set when a task uses it.' },
    governance: { classifications: [], rules: [] },
    facts: [], memory: [],
    usedBy: { artifacts: [], semanticModels: [], queries: [] },
    conflicts: [],
    sources: { metadata: [`catalog:${e.system}/${e.environment}`], semantic: [], governance: [], facts: 0 }
  };
}

/** A domain's or data product's assets: those its patterns, semantic models or facts put in it (MM1). */
function membersOf(n: BaseNode, idx: Index): Array<AssetSummary & { children: number }> {
  const candidates = idx.graph.nodes.filter((x) => x.type === 'table' || x.type === 'semantic_model' || x.type === 'semantic_table' || x.type === 'metric');
  const inDomain = (x: BaseNode) => metaOf(x, idx)?.domain?.name.toLowerCase() === (n.type === 'domain' ? n.label : String(n.metadata.domain ?? '')).toLowerCase();
  const members = n.type === 'domain'
    ? [...idx.graph.nodes.filter((x) => x.type === 'data_product' && String(x.metadata.domain ?? '').toLowerCase() === n.label.toLowerCase()), ...candidates.filter(inDomain)]
    : candidates.filter((x) => ((n.metadata.patterns as string[] | undefined) ?? []).some((p) => patternMatches(p, { id: x.id, ...(fqnOf(x, idx) ? { fqn: fqnOf(x, idx) } : {}) })));
  return members.map((x) => ({ ...summarize(x, idx), children: 0 })).sort((a, b) => (a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1));
}

function childrenOf(id: string, idx: Index): Array<AssetSummary & { children: number }> {
  return (idx.out.get(id) ?? []).filter((e) => e.type === 'contains').map((e) => idx.nodes.get(e.target)).filter((x): x is BaseNode => !!x)
    .map((x) => ({ ...summarize(x, idx), children: (idx.out.get(x.id) ?? []).filter((e) => e.type === 'contains').length }))
    .sort((a, b) => (a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1));
}

export interface BrowseLevel { parent?: AssetSummary; children: Array<AssetSummary & { children: number }>; truncated: number }

/**
 * The browse tree (v0.50.3): databases (each with its system and
 * environment), their schemas, tables and columns. Children are listed when
 * asked for, at most `limit` at a time.
 */
export function browseAssets(sources: ExploreSources, parent?: string, limit = 500): BrowseLevel {
  const idx = buildIndex(sources);
  const all = parent
    ? (idx.nodes.has(parent) ? (idx.nodes.get(parent)!.type === 'table' ? (idx.columnsOf.get(parent) ?? []).map((c) => ({ ...summarize(idx.nodes.get(c)!, idx), children: 0 })) : childrenOf(parent, idx)) : [])
    : idx.graph.nodes.filter((n) => n.type === 'database').map((n) => ({ ...summarize(n, idx), children: (idx.out.get(n.id) ?? []).filter((e) => e.type === 'contains').length }))
      .sort((a, b) => `${a.system}/${a.environment}/${a.label}`.toLowerCase() < `${b.system}/${b.environment}/${b.label}`.toLowerCase() ? -1 : 1);
  return { ...(parent && idx.nodes.has(parent) ? { parent: summarize(idx.nodes.get(parent)!, idx) } : {}), children: all.slice(0, limit), truncated: Math.max(0, all.length - limit) };
}

// ── Graph neighbourhood ──

/** A node of a graph view; a column names its table as `parent` when both are shown (drawn inside it). */
export interface GraphNodeView extends AssetSummary { parent?: string }

export interface GraphEdgeView {
  id: string;
  source: string;
  target: string;
  /** A graph edge type, or in the landscape: foreign_key, relationship, proposed_relationship, semantic_join. */
  type: string;
  /** The columns it joins on, or the model it comes from. */
  label?: string;
  trust?: TrustTier;
  /** Not confirmed: a proposed relationship, or a join in a draft semantic model (drawn dashed). */
  proposed?: boolean;
}

export interface GraphSlice {
  /** The asset it is centred on; absent for the landscape. */
  center?: string;
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  /** Neighbours not shown because of the cap, per node. */
  hidden: Record<string, number>;
  capped: boolean;
  /** Landscape: tables in scope before the cap, and the scopes to choose from. */
  total?: number;
  scopes?: { systems: Array<{ id: string; tables: number }>; schemas: Array<{ id: string; tables: number }>; models: Array<{ id: string; status: string }> };
}

function graphNode(n: BaseNode, idx: Index, shown: ReadonlySet<string>): GraphNodeView {
  const s = summarize(n, idx);
  const parent = n.type === 'column' ? idx.tableOf.get(n.id) : undefined;
  return parent && shown.has(parent) ? { ...s, parent } : s;
}

/**
 * A neighbourhood a few hops out, for the graph view (§6.10): edges both
 * ways, optionally by type, capped so a hub doesn't flood the canvas (the
 * rest is counted per node, "+N more"). Columns are left out unless asked
 * for or the centre is a column.
 */
export function exploreGraph(sources: ExploreSources, center: string, options: { hops?: number; edgeTypes?: string[]; includeColumns?: boolean; cap?: number } = {}): GraphSlice | undefined {
  const idx = buildIndex(sources);
  const start = resolveAsset(sources, center)?.node;
  if (!start) return undefined;
  const hops = Math.min(Math.max(options.hops ?? 1, 1), 3);
  const cap = options.cap ?? 120;
  const withColumns = options.includeColumns || start.type === 'column';
  const allowed = (e: GraphEdge) => !options.edgeTypes?.length || options.edgeTypes.includes(e.type);
  const keepNode = (id: string) => { const n = idx.nodes.get(id); return !!n && (withColumns || n.type !== 'column' || id === start.id); };
  const shown = new Set([start.id]);
  const hidden: Record<string, number> = {};
  let frontier = [start.id];
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      const around = [...(idx.out.get(id) ?? []).filter(allowed).map((e) => e.target), ...(idx.in.get(id) ?? []).filter(allowed).map((e) => e.source)].filter(keepNode);
      for (const nb of [...new Set(around)].sort()) {
        if (shown.has(nb)) continue;
        if (shown.size >= cap) { hidden[id] = (hidden[id] ?? 0) + 1; continue; }
        shown.add(nb);
        next.push(nb);
      }
    }
    frontier = next;
  }
  const edges = idx.graph.edges.filter((e) => shown.has(e.source) && shown.has(e.target) && allowed(e))
    .map((e) => ({ id: e.id, source: e.source, target: e.target, type: e.type, ...(trustOf(e.supportedBy, idx) ? { trust: trustOf(e.supportedBy, idx) } : {}) }));
  return { center: start.id, nodes: [...shown].map((id) => graphNode(idx.nodes.get(id)!, idx, shown)), edges, hidden, capped: Object.keys(hidden).length > 0 };
}

export interface LandscapeOptions {
  system?: string;
  schema?: string;
  /** A semantic model: its tables only. */
  model?: string;
  includeColumns?: boolean;
  /** Proposed relationships and joins of draft models, drawn dashed (default on). */
  proposed?: boolean;
  /** Joins the semantic layer defines (default on). */
  semantic?: boolean;
  cap?: number;
}

/**
 * The landscape (§6.10): the working set's tables, or one system, schema or
 * semantic model's, with every relationship AutoDE knows between them —
 * declared foreign keys, confirmed relationship facts, proposed ones, and
 * the semantic layer's joins — lifted to the tables they join (the columns
 * are the edge's label). Columns, when asked for, are drawn inside their
 * tables. Capped; `total` says how many were in scope.
 */
export function exploreLandscape(sources: ExploreSources, options: LandscapeOptions = {}): GraphSlice {
  const idx = buildIndex(sources);
  const tables = idx.graph.nodes.filter((n): n is TableNode => n.type === 'table' || n.type === 'semantic_view');
  const fqn = (t: TableNode) => t.fqn || t.label;
  const schemaOf = (t: TableNode) => { const parts = fqn(t).split('.'); return parts.length >= 2 ? parts[parts.length - 2] : ''; };
  const count = (keys: string[]) => [...keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())].map(([id, n]) => ({ id, tables: n })).sort((a, b) => (a.id < b.id ? -1 : 1));
  const scopes = {
    systems: count(tables.map((t) => t.origin?.system ?? 'unassigned')),
    schemas: count(tables.map(schemaOf).filter(Boolean)),
    models: (sources.semantic?.models ?? []).map((m) => ({ id: m.name, status: m.approved ? 'approved' : 'draft' }))
  };
  const inModel = options.model ? new Set((idx.out.get(`sem:${options.model}`) ?? []).flatMap((e) => (idx.out.get(e.target) ?? []).filter((x) => x.type === 'maps_to').map((x) => x.target))) : undefined;
  const selected = tables
    .filter((t) => (!options.system || (t.origin?.system ?? 'unassigned') === options.system) && (!options.schema || schemaOf(t).toLowerCase() === options.schema.toLowerCase()) && (!inModel || inModel.has(t.id)))
    .sort((a, b) => (fqn(a) < fqn(b) ? -1 : 1));
  const cap = options.cap ?? 250;
  const kept = selected.slice(0, cap);
  const ids = new Set(kept.map((t) => t.id));
  const shown = new Set(ids);
  if (options.includeColumns) for (const t of kept) for (const c of idx.columnsOf.get(t.id) ?? []) shown.add(c);
  const nodes = [...shown].map((id) => graphNode(idx.nodes.get(id)!, idx, shown));

  const edges = new Map<string, GraphEdgeView>();
  const table = (id: string) => idx.tableOf.get(id) ?? id;
  const col = (id: string) => (idx.nodes.get(id)?.type === 'column' ? idx.nodes.get(id)!.label : undefined);
  const add = (e: GraphEdgeView) => { if (e.source !== e.target && ids.has(e.source) && ids.has(e.target) && !edges.has(`${e.type}|${e.source}|${e.target}|${e.label ?? ''}`)) edges.set(`${e.type}|${e.source}|${e.target}|${e.label ?? ''}`, e); };
  for (const e of sources.graph.edges) {
    if (e.type !== 'foreign_key' && e.type !== 'related_to') continue;
    const cols = [col(e.source), col(e.target)];
    const trust = trustOf(e.supportedBy, idx);
    add({ id: `${e.type}:${e.id}`, source: table(e.source), target: table(e.target), type: e.type === 'foreign_key' ? 'foreign_key' : 'relationship', ...(cols[0] && cols[1] ? { label: `${cols[0]} = ${cols[1]}` } : {}), ...(trust ? { trust } : {}) });
  }
  if (options.proposed !== false) {
    const resolve = createSubjectResolver(sources.graph as Parameters<typeof createSubjectResolver>[0]);
    for (const a of sources.assertions) {
      if (a.kind !== 'relationship' || (a.status !== 'proposed' && a.status !== 'needs_review')) continue;
      const v = a.value as { from?: { entity: string; columns?: string[] }; to?: { entity: string; columns?: string[] }; cardinality?: string };
      const from = v.from ? resolve(v.from.entity) : undefined;
      const to = v.to ? resolve(v.to.entity) : undefined;
      if (!from || !to) continue;
      const label = (v.from?.columns ?? []).map((c, i) => `${c} = ${v.to?.columns?.[i] ?? c}`).join(', ');
      add({ id: `proposed:${a.id}`, source: table(from), target: table(to), type: 'proposed_relationship', ...(label ? { label } : {}), trust: a.trust, proposed: true });
    }
  }
  if (options.semantic !== false && sources.semantic) {
    const approved = new Map(sources.semantic.models.map((m) => [m.name, m.approved] as const));
    const refs = tables.map(physicalRef);
    const side = (model: string, logical: string) => { const lt = sources.semantic!.tables.find((t) => t.model === model && t.table.name === logical); const m = lt ? matchBase(lt, refs).match : undefined; return m ? kept.find((t) => t.id === m.id) : undefined; };
    for (const r of sources.semantic.relationships) {
      const l = side(r.model, r.leftTable);
      const rt = side(r.model, r.rightTable);
      if (!l || !rt) continue;
      add({ id: `semantic:${r.model}:${r.name}`, source: l.id, target: rt.id, type: 'semantic_join', label: `${r.model}: ${r.columns.map((c) => `${c.left} = ${c.right}`).join(', ')}`, ...(approved.get(r.model) ? {} : { proposed: true }) });
    }
  }
  return { nodes, edges: [...edges.values()], hidden: {}, capped: selected.length > cap, total: selected.length, scopes };
}

// ── Facts and overview ──

export interface FactFilter { kinds?: string[]; statuses?: string[]; trust?: TrustTier[]; text?: string; limit?: number; offset?: number }

/** The fact table: every non-mirror fact, filterable, newest first, with facet counts. */
export function listFacts(sources: ExploreSources, filter: FactFilter = {}): { total: number; rows: Array<FactRow & { subjects: string[] }>; facets: Record<'kind' | 'status' | 'trust', Record<string, number>> } {
  const idx = buildIndex(sources);
  const text = filter.text?.trim().toLowerCase();
  const all = sources.assertions.filter((a) => !isMirror(a) && (!text || a.statement.toLowerCase().includes(text) || a.subject.some((s) => s.toLowerCase().includes(text))));
  const facets: Record<'kind' | 'status' | 'trust', Record<string, number>> = { kind: {}, status: {}, trust: {} };
  for (const a of all) { facets.kind[a.kind] = (facets.kind[a.kind] ?? 0) + 1; facets.status[a.status] = (facets.status[a.status] ?? 0) + 1; facets.trust[a.trust] = (facets.trust[a.trust] ?? 0) + 1; }
  const keep = (v: string, allowed?: readonly string[]) => !allowed?.length || allowed.includes(v);
  const rows = all.filter((a) => keep(a.kind, filter.kinds) && keep(a.status, filter.statuses) && keep(a.trust, filter.trust))
    .map((a) => ({ ...factRow(a), subjects: a.subject.map((s) => idx.nodes.get(s)?.label ?? s) }))
    .sort(byRecent);
  const offset = filter.offset ?? 0;
  return { total: rows.length, rows: rows.slice(offset, offset + (filter.limit ?? 100)), facets };
}

export interface SemanticOverview {
  models: Array<AssetSummary & {
    source?: string;
    file?: string;
    logicalTables: AssetSummary[];
    metrics: Array<AssetSummary & { expr?: string; table?: string }>;
    relationships: AssetSummary[];
    verifiedQueries: Array<AssetSummary & { question?: string }>;
    instructions?: string;
  }>;
}

/** The semantic layer at a glance (§6.10): each model with its logical tables, metrics, joins, verified queries and instructions. */
export function semanticOverview(sources: ExploreSources): SemanticOverview {
  const idx = buildIndex(sources);
  const inside = (id: string) => (idx.out.get(id) ?? []).filter((e) => e.type === 'contains').map((e) => idx.nodes.get(e.target)).filter((x): x is BaseNode => !!x);
  const models = idx.graph.nodes.filter((n) => n.type === 'semantic_model').map((m) => {
    const children = inside(m.id);
    const tables = children.filter((c) => c.type === 'semantic_table');
    return {
      ...summarize(m, idx),
      ...(typeof m.metadata.source === 'string' ? { source: m.metadata.source } : {}),
      ...(typeof m.metadata.file === 'string' ? { file: m.metadata.file } : {}),
      logicalTables: tables.map((t) => summarize(t, idx)),
      metrics: tables.flatMap((t) => inside(t.id).filter((e) => e.type === 'metric').map((e) => ({ ...summarize(e, idx), ...(typeof e.metadata.expr === 'string' ? { expr: e.metadata.expr } : {}), table: t.label }))),
      relationships: children.filter((c) => c.type === 'semantic_relationship').map((c) => summarize(c, idx)),
      verifiedQueries: children.filter((c) => c.type === 'verified_query').map((c) => ({ ...summarize(c, idx), ...(typeof c.metadata.question === 'string' ? { question: c.metadata.question } : {}) })),
      ...(children.find((c) => c.type === 'semantic_instruction') ? { instructions: String(children.find((c) => c.type === 'semantic_instruction')!.metadata.text ?? '') } : {})
    };
  });
  return { models };
}

export interface ExploreOverview {
  counts: { domains: number; articles: number; databases: number; schemas: number; tables: number; columns: number; terms: number; rules: number; queries: number; facts: number; catalogTables: number; semanticModels: number; approvedSemanticModels: number; metrics: number; relationships: number };
  facts: { byStatus: Record<string, number>; byTrust: Record<string, number> };
  conflicts: number;
  needsReview: number;
  systems: Array<{ system: string; environment: string; tables: number }>;
  semanticModels: AssetSummary[];
}

/** The Explorer's landing page: what AutoDE knows, at a glance. */
export function exploreOverview(sources: ExploreSources): ExploreOverview {
  const idx = buildIndex(sources);
  const of = (t: string) => idx.graph.nodes.filter((n) => n.type === t);
  const facts = sources.assertions.filter((a) => !isMirror(a));
  const byStatus: Record<string, number> = {}; const byTrust: Record<string, number> = {};
  for (const a of facts) { byStatus[a.status] = (byStatus[a.status] ?? 0) + 1; byTrust[a.trust] = (byTrust[a.trust] ?? 0) + 1; }
  const systems = new Map<string, number>();
  for (const t of of('table')) { const k = `${t.origin?.system ?? 'unassigned'}|${t.origin?.systemEnvironment ?? 'default'}`; systems.set(k, (systems.get(k) ?? 0) + 1); }
  const models = of('semantic_model').map((n) => summarize(n, idx));
  return {
    counts: { domains: of('domain').length, articles: of('knowledge_article').length, databases: of('database').length, schemas: of('schema').length, tables: of('table').length, columns: of('column').length, terms: of('business_term').length, rules: of('business_rule').length, queries: of('verified_query').length, facts: facts.length, relationships: of('semantic_relationship').length, catalogTables: sources.catalog?.all?.().length ?? 0, semanticModels: models.length, approvedSemanticModels: models.filter((m) => m.status === 'approved').length, metrics: of('metric').length },
    facts: { byStatus, byTrust },
    conflicts: sources.conflicts.length,
    needsReview: facts.filter((a) => a.status === 'needs_review').length,
    systems: [...systems.entries()].map(([k, tables]) => { const [system, environment] = k.split('|'); return { system, environment, tables }; }).sort((a, b) => a.system.localeCompare(b.system) || a.environment.localeCompare(b.environment)),
    semanticModels: models
  };
}
