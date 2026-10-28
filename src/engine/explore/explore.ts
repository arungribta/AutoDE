import { Assertion, TrustTier, isLive, trustRank } from '../context/assertions';
import { Conflict } from '../context/conflicts';
import { isMirror } from '../context/projection';
import { GraphView, resolveText } from '../context/retrieval';
import { BaseNode, BusinessRuleNode, BusinessTermNode, ColumnNode, GraphEdge, TableNode, VerifiedQueryNode } from '../context/types';
import { CatalogEntry, CatalogLookup } from '../context/catalog';
import { governanceFacts, sameTable } from '../governance/governance';
import { SemanticLayerIndex } from '../semantic/layer';
import { semanticGraph } from '../semantic/layerGraph';

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

export type AssetKind = 'table' | 'view' | 'column' | 'business_term' | 'business_rule' | 'verified_query' | 'metric' | 'semantic_model' | 'semantic_table' | 'semantic_element' | 'fact';

export interface AssetSummary {
  id: string;
  kind: AssetKind;
  label: string;
  /** Tables: `db.schema.table`; columns: `<table fqn>.<column>`. */
  fqn?: string;
  description?: string;
  system?: string;
  environment?: string;
  /** The strongest trust among the facts it is projected from (facts: their own). */
  trust?: TrustTier;
  status?: string;
  classification?: string;
  /** In the working set (graph), or known only from the estate catalog. */
  inWorkingSet: boolean;
  /** Semantic elements: approved at the current revision, or a draft. */
  approved?: boolean;
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
  summaries: Map<string, AssetSummary>;
}

const indexes = new WeakMap<ExploreSources, Index>();

function buildIndex(sources: ExploreSources): Index {
  const cached = indexes.get(sources);
  if (cached) return cached;
  const overlay = sources.semantic ? semanticGraph(sources.semantic, sources.graph) : { nodes: [], edges: [] };
  const graph: GraphView = { nodes: [...sources.graph.nodes, ...overlay.nodes], edges: [...sources.graph.edges, ...overlay.edges] };
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
  const idx: Index = { graph, nodes, out, in: inc, tableOf, columnsOf, bySubject, assertions: new Map(sources.assertions.map((a) => [a.id, a] as const)), classification, summaries: new Map() };
  indexes.set(sources, idx);
  return idx;
}

function trustOf(ids: readonly string[] | undefined, idx: Index): TrustTier | undefined {
  const tiers = (ids ?? []).map((id) => idx.assertions.get(id)?.trust).filter((t): t is TrustTier => !!t);
  return tiers.sort((a, b) => trustRank(b) - trustRank(a))[0];
}

function kindOf(n: BaseNode): AssetKind {
  if (n.type === 'table' || n.type === 'semantic_view') return (n as TableNode).isView ? 'view' : 'table';
  return n.type as AssetKind;
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
  const s: AssetSummary = { id: n.id, kind: kindOf(n), label: n.label, inWorkingSet: true };
  const fqn = fqnOf(n, idx);
  if (fqn) s.fqn = fqn;
  if (n.description) s.description = n.description;
  if (n.origin?.system) s.system = n.origin.system;
  if (n.origin?.systemEnvironment) s.environment = n.origin.systemEnvironment;
  const trust = n.supportedBy?.length ? trustOf(n.supportedBy, idx) : undefined;
  if (trust) s.trust = trust;
  if (n.status) s.status = n.status;
  const cls = n.type === 'column' ? idx.classification.get(n.id) : undefined;
  if (cls) s.classification = cls.classification;
  if (typeof n.metadata?.approved === 'boolean') s.approved = n.metadata.approved as boolean;
  idx.summaries.set(n.id, s);
  return s;
}

function factSummary(a: Assertion): AssetSummary {
  return { id: a.id, kind: 'fact', label: a.statement, trust: a.trust, status: a.status, inWorkingSet: true, description: `${a.kind} · ${a.predicate}` };
}

function catalogSummary(e: CatalogEntry): AssetSummary {
  return { id: e.id, kind: e.table.isView ? 'view' : 'table', label: e.table.label, fqn: e.table.fqn, ...(e.table.description ? { description: e.table.description } : {}), system: e.system, environment: e.environment, inWorkingSet: false, ...(e.visible === false ? { status: 'not visible' } : {}) };
}

// ── Search ──

export interface SearchOptions {
  kinds?: AssetKind[];
  systems?: string[];
  environments?: string[];
  trust?: TrustTier[];
  statuses?: string[];
  classifications?: string[];
  limit?: number;
  offset?: number;
}

export type Facets = Record<'kind' | 'system' | 'environment' | 'trust' | 'status' | 'classification', Record<string, number>>;

export interface SearchResult {
  query: string;
  total: number;
  results: AssetSummary[];
  facets: Facets;
  /** Catalog matches outside the working set (opening one loads it on demand). */
  fromCatalog: number;
  /** Nothing matched every word: these are related results from the vocabulary (abbreviations, synonyms, glossary). */
  approximate?: boolean;
}

const BROWSABLE = new Set(['table', 'semantic_view', 'column', 'business_term', 'business_rule', 'verified_query', 'metric', 'semantic_model', 'semantic_table', 'semantic_element']);

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
    for (const a of sources.assertions) {
      if (isMirror(a) || (!isLive(a.status) && a.status !== 'proposed')) continue;
      const score = textScore({ label: a.statement }, tokens, whole);
      if (score > 0) add(factSummary(a), Math.max(1, score - 10));
    }
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
  const facets: Facets = { kind: {}, system: {}, environment: {}, trust: {}, status: {}, classification: {} };
  const bump = (f: Record<string, number>, v: string | undefined) => { if (v) f[v] = (f[v] ?? 0) + 1; };
  for (const r of all) { bump(facets.kind, r.kind); bump(facets.system, r.system); bump(facets.environment, r.environment); bump(facets.trust, r.trust); bump(facets.status, r.status); bump(facets.classification, r.classification); }
  const keep = (v: string | undefined, allowed?: readonly string[]) => !allowed?.length || (!!v && allowed.includes(v));
  const filtered = all.filter((r) => keep(r.kind, options.kinds) && keep(r.system, options.systems) && keep(r.environment, options.environments) && keep(r.trust, options.trust) && keep(r.status, options.statuses) && keep(r.classification, options.classifications));
  const offset = options.offset ?? 0;
  return { query, total: filtered.length, results: filtered.slice(offset, offset + (options.limit ?? 50)), facets, fromCatalog, ...(approximate ? { approximate } : {}) };
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
  governance: { classifications: Array<{ column: string; classification: string; strategy?: string; factId?: string; trust?: TrustTier }>; rules: Array<{ id: string; text: string; enforcement: string }> };
  facts: FactRow[];
  /** Decisions and assumptions in scope: about this asset, or team-wide. */
  memory: FactRow[];
  usedBy: { artifacts: Array<{ path: string; agent?: string; generatedAt?: string; warnings: number }>; semanticModels: AssetSummary[]; queries: AssetSummary[] };
  conflicts: Array<{ rule: string; sides: string[] }>;
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

  const parentId = n.type === 'column' ? idx.tableOf.get(n.id) : n.id.startsWith('sem:') ? (idx.in.get(n.id) ?? []).find((e) => e.type === 'contains')?.source : undefined;
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
  const definition = n.id.startsWith('sem:') ? { ...n.metadata } : undefined;

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
    .map((r) => ({ id: r.id, text: r.ruleText, enforcement: r.enforcementLevel }));

  // Memory: decisions and assumptions about it, or team-wide.
  const memory = [...facts.filter((f) => f.kind === 'decision' || f.kind === 'assumption'), ...(idx.bySubject.get('project') ?? []).filter((a) => (a.kind === 'decision' || a.kind === 'assumption') && isLive(a.status)).map((a) => factRow(a, 'team-wide'))].filter((f, i, all) => all.findIndex((x) => x.id === f.id) === i);

  // Used by: artifacts whose manifests rest on it, semantic models over it, queries that use it.
  const factIds = new Set(facts.map((f) => f.id));
  const fqn = asset.fqn?.toLowerCase();
  const artifacts = (sources.artifacts ?? []).filter((u) => u.subjects.some((s) => s === n.id || (!!fqn && s.toLowerCase() === fqn)) || u.assertions.some((id) => factIds.has(id) || (idx.nodes.get(n.id)?.supportedBy ?? []).includes(id)))
    .map((u) => ({ path: u.path, ...(u.agent ? { agent: u.agent } : {}), ...(u.generatedAt ? { generatedAt: u.generatedAt } : {}), warnings: u.warnings }));
  const semanticModels = [...new Set([...semantic.values()].map((s) => s.model).filter((m): m is string => !!m))].map((m) => idx.nodes.get(`sem:${m}`)).filter((x): x is BaseNode => !!x).map((x) => summarize(x, idx));
  const queries = (idx.in.get(n.id) ?? []).filter((e) => e.type === 'uses_table').map((e) => idx.nodes.get(e.source)).filter((q): q is VerifiedQueryNode => q?.type === 'verified_query').map((q) => summarize(q, idx));

  const conflicts = sources.conflicts.filter((c) => c.subject.some((s) => scope.includes(s)) || c.ids.some((id) => factIds.has(id))).map((c) => ({ rule: c.rule, sides: c.sides }));
  return {
    asset, overview, ...(schema ? { schema } : {}),
    meaning: { terms: [...terms.values()], semantic: [...semantic.values()], ...(definition ? { definition } : {}), concepts: [] },
    lineage: { related, note: 'Relationships, mappings and derivations known today. Observed (platform), designed (mappings, specifications) and generated (artifacts) lineage, and impact analysis, arrive in LIN (v0.51.0).' },
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
    schema: { columns: (e.columns ?? []).map((c) => ({ id: c.id, kind: 'column' as const, label: c.label, fqn: `${e.table.fqn}.${c.label}`, system: e.system, environment: e.environment, inWorkingSet: false, dataType: c.dataType || '', nullable: c.isNullable !== false, primaryKey: !!c.isPrimaryKey, foreignKey: !!c.isForeignKey })), keys: [], grain: [], profile: [] },
    meaning: { terms: [], semantic: [], concepts: [] },
    lineage: { related: [], note: 'Known from the estate catalog only: AutoDE loads it into the working set when a task uses it.' },
    governance: { classifications: [], rules: [] },
    facts: [], memory: [],
    usedBy: { artifacts: [], semanticModels: [], queries: [] },
    conflicts: [],
    sources: { metadata: [`catalog:${e.system}/${e.environment}`], semantic: [], governance: [], facts: 0 }
  };
}

// ── Graph neighbourhood ──

export interface GraphSlice {
  center: string;
  nodes: AssetSummary[];
  edges: Array<{ id: string; source: string; target: string; type: string; trust?: TrustTier }>;
  /** Neighbours not shown because of the cap, per node. */
  hidden: Record<string, number>;
  capped: boolean;
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
  return { center: start.id, nodes: [...shown].map((id) => summarize(idx.nodes.get(id)!, idx)), edges, hidden, capped: Object.keys(hidden).length > 0 };
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

export interface ExploreOverview {
  counts: { tables: number; columns: number; terms: number; rules: number; queries: number; facts: number; catalogTables: number; semanticModels: number; approvedSemanticModels: number; metrics: number };
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
    counts: { tables: of('table').length, columns: of('column').length, terms: of('business_term').length, rules: of('business_rule').length, queries: of('verified_query').length, facts: facts.length, catalogTables: sources.catalog?.all?.().length ?? 0, semanticModels: models.length, approvedSemanticModels: models.filter((m) => m.approved).length, metrics: of('metric').length },
    facts: { byStatus, byTrust },
    conflicts: sources.conflicts.length,
    needsReview: facts.filter((a) => a.status === 'needs_review').length,
    systems: [...systems.entries()].map(([k, tables]) => { const [system, environment] = k.split('|'); return { system, environment, tables }; }).sort((a, b) => a.system.localeCompare(b.system) || a.environment.localeCompare(b.environment)),
    semanticModels: models
  };
}
