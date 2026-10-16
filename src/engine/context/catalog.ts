import { BaseNode, ColumnNode, GraphEdge, Origin, TableNode } from './types';
import { FileIo, nodeFileIo, writeFileAtomic } from './contextStore';
import { ALL_SIGNALS, Vocabulary, VocabularySignals, buildVocabulary, concepts } from './vocabulary';
import { DEFAULT_ENVIRONMENT, catalogWatermarks, edgeId, parseObjectId, slugifyId } from './estate';

/**
 * Per-system catalogs and the working-set cache (Phase K2;
 * docs/context-layer-requirements.md §11 Phase K, items 4, 5, 8, 12).
 *
 * The catalog holds what AutoDE knows about the estate's physical objects, in
 * tiers, incrementally — never a mirror of the whole estate:
 *  - tier 0: the name (database, schema, object) and table comment;
 *  - tier 1: structure — columns, types, keys — loaded when an object enters
 *    scope, or straight away when a file or extraction delivers it;
 *  - tier 2: tier 1 plus a column profile.
 *
 * The graph and the assertion ledger hold only the *working set*: the objects
 * a problem uses. Measured on the 2 000-table fixture, mirroring every column
 * into the ledger costs ~390 MB of extension-host memory; the catalog holds
 * the same estate in a fraction of that and is rebuildable (git-ignored JSON
 * under `.autode/local/catalog/<system>/<environment>/`).
 *
 * Retrieval over the catalog is a ranked full-text index of concepts (see
 * `vocabulary.ts`) over names, comments, glossary aliases and column names.
 */

export type CatalogTier = 0 | 1 | 2;

export type CatalogColumn = Omit<ColumnNode, 'origin' | 'type' | 'version'>;

export interface CatalogEntry {
  /** The table's graph id (`obj:<system>/<environment>/<fqn>`). */
  id: string;
  system: string;
  environment: string;
  /** The table node, without its origin (kept once, below). */
  table: Omit<TableNode, 'origin'>;
  origin?: Origin;
  tier: CatalogTier;
  /** Columns — tier ≥ 1. */
  columns?: CatalogColumn[];
  /** Edges other than `contains` that start at this table or one of its columns (foreign keys). */
  edges?: GraphEdge[];
  /** `false`: the name is known but the structure is not visible with the current grants. */
  visible?: boolean;
  /** When the structure was loaded or last re-checked against the source. */
  loadedAt?: string;
  /** The source's last-altered timestamp at `loadedAt`, when the source reports one. */
  lastAltered?: string;
  /** Last time the object was in scope (a pack seed or rendered table, a spec, a mapping). */
  lastUsedAt?: string;
}

export interface CatalogHit {
  id: string;
  score: number;
  tier: CatalogTier;
  visible: boolean;
  /** Request concepts the object matched on (for "why was this picked"). */
  matched: string[];
}

export interface CatalogSearchOptions {
  limit?: number;
  /** Ablation switches for the eval; AutoDE always uses every signal. */
  signals?: Partial<VocabularySignals & { comments: boolean; glossary: boolean }>;
}

/** Reads/writes one file per `system/environment`. */
const CATALOG_FILE = 'catalog.json';

function isTableNode(n: BaseNode): n is TableNode {
  return n.type === 'table' || n.type === 'semantic_view';
}

/** Groups graph nodes and edges into catalog entries (tier 1, or 2 when a profile is present). */
export function entriesFromGraph(nodes: readonly BaseNode[], edges: readonly GraphEdge[], loadedAt?: string): CatalogEntry[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const columnsOf = new Map<string, ColumnNode[]>();
  const tableOfColumn = new Map<string, string>();
  for (const e of edges) {
    if (e.type !== 'contains') continue;
    const c = byId.get(e.target);
    if (c && c.type === 'column') {
      columnsOf.set(e.source, [...(columnsOf.get(e.source) ?? []), c as ColumnNode]);
      tableOfColumn.set(c.id, e.source);
    }
  }
  const otherEdges = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    if (e.type === 'contains') continue;
    const owner = byId.get(e.source) && isTableNode(byId.get(e.source)!) ? e.source : tableOfColumn.get(e.source);
    if (owner) otherEdges.set(owner, [...(otherEdges.get(owner) ?? []), e]);
  }
  const out: CatalogEntry[] = [];
  for (const n of nodes) {
    if (!isTableNode(n)) continue;
    const parsed = parseObjectId(n.id);
    const system = n.origin?.system ?? parsed?.system ?? slugifyId(n.origin?.sourceRef ?? 'unassigned');
    const environment = n.origin?.systemEnvironment ?? parsed?.environment ?? DEFAULT_ENVIRONMENT;
    // `supportedBy` is the projection's annotation, not part of the object.
    const { origin, supportedBy: _s, ...table } = n;
    const cols = (columnsOf.get(n.id) ?? []).map(({ origin: _o, type: _t, version: _v, supportedBy: _cs, ...c }) => c);
    const lastAltered = (table.metadata as { lastAltered?: unknown } | undefined)?.lastAltered;
    out.push({
      id: n.id,
      system,
      environment,
      table,
      origin,
      tier: cols.some((c) => (c.metadata as { profile?: unknown } | undefined)?.profile) ? 2 : 1,
      columns: cols,
      edges: otherEdges.get(n.id),
      visible: true,
      loadedAt: loadedAt ?? origin?.lastVerifiedAt ?? origin?.extractedAt,
      ...(typeof lastAltered === 'string' ? { lastAltered } : {})
    });
  }
  return out;
}

/** The graph form of an entry: exactly the nodes and edges its producer emitted. */
export function entryToGraph(e: CatalogEntry): { nodes: BaseNode[]; edges: GraphEdge[] } {
  const table = { ...e.table, origin: e.origin } as TableNode;
  const nodes: BaseNode[] = [table];
  const edges: GraphEdge[] = [];
  for (const c of e.columns ?? []) {
    nodes.push({ ...c, type: 'column', version: 1, origin: e.origin } as ColumnNode);
    edges.push({ id: edgeId('contains', e.id, c.id), source: e.id, target: c.id, type: 'contains', weight: 1.0 });
  }
  edges.push(...(e.edges ?? []));
  return { nodes, edges };
}

function contentKey(e: CatalogEntry): string {
  return JSON.stringify([e.table.label, e.table.fqn, e.table.description, e.table.type, (e.columns ?? []).map((c) => [c.id, c.label, c.dataType, c.isNullable, c.isPrimaryKey, c.description]), (e.edges ?? []).map((x) => x.id)]);
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

interface IndexedDoc {
  id: string;
  /** concept → best field weight it occurs in. */
  weights: Map<string, number>;
  nameConcepts: Set<string>;
}

const FIELD = { name: 3, alias: 3, comment: 2, schema: 0.5, column: 0.5 };
/** A hit needs at least one concept from a field at least this strong (name, alias or comment) — a column-name match alone is too weak to seed a pack. */
const STRONG_FIELD = 2;

export class Catalog {
  private readonly entries = new Map<string, CatalogEntry>();
  private readonly dirty = new Set<string>();
  private vocab: Vocabulary = buildVocabulary();
  /** Glossary aliases: table id → term texts bound to it. */
  private aliases = new Map<string, string[]>();
  private index: { docs: IndexedDoc[]; postings: Map<string, number[]>; signalsKey: string } | undefined;
  private indexStale = true;

  public constructor(private readonly dir: string, private readonly io: FileIo = nodeFileIo, private readonly now: () => Date = () => new Date()) {}

  public get size(): number { return this.entries.size; }
  public get(id: string): CatalogEntry | undefined { return this.entries.get(id); }
  public all(): CatalogEntry[] { return [...this.entries.values()]; }
  public has(id: string): boolean { return this.entries.has(id); }

  public setVocabulary(vocab: Vocabulary): void { this.vocab = vocab; this.indexStale = true; }
  public setAliases(aliases: Map<string, string[]>): void {
    const key = (m: Map<string, string[]>) => JSON.stringify([...m].sort());
    if (key(aliases) !== key(this.aliases)) { this.aliases = aliases; this.indexStale = true; }
  }

  private scopeOf(e: Pick<CatalogEntry, 'system' | 'environment'>): string { return `${e.system}/${e.environment}`; }
  private fileOf(scope: string): string {
    const [system, environment] = scope.split('/');
    return [this.dir, slugifyId(system), slugifyId(environment), CATALOG_FILE].join('/');
  }

  /** Loads every `<system>/<environment>/catalog.json` under the catalog directory. */
  public async load(): Promise<void> {
    this.entries.clear();
    this.dirty.clear();
    const systems = (await this.io.listDir?.(this.dir)) ?? [];
    for (const s of systems) {
      const envs = (await this.io.listDir?.([this.dir, s].join('/'))) ?? [];
      for (const env of envs) {
        const bytes = await this.io.readFile([this.dir, s, env, CATALOG_FILE].join('/'));
        if (!bytes) continue;
        try {
          const doc = JSON.parse(Buffer.from(bytes).toString('utf8')) as { entries?: CatalogEntry[] };
          for (const e of doc.entries ?? []) this.entries.set(e.id, e);
        } catch {
          // A damaged cache is rebuilt from its sources; never fatal.
        }
        await yieldToLoop();
      }
    }
    this.indexStale = true;
  }

  /** Writes the scopes that changed. The folder ignores itself in git: it is a rebuildable cache. */
  public async save(): Promise<void> {
    if (this.dirty.size > 0 && !(await this.io.readFile([this.dir, '.gitignore'].join('/')))) {
      await this.io.mkdirp(this.dir);
      await this.io.writeFile([this.dir, '.gitignore'].join('/'), Buffer.from('# AutoDE catalog cache (rebuildable) - not committed\n*\n', 'utf8'));
    }
    for (const scope of [...this.dirty]) {
      const entries = this.all().filter((e) => this.scopeOf(e) === scope).sort((a, b) => (a.id < b.id ? -1 : 1));
      const [system, environment] = scope.split('/');
      await this.io.mkdirp([this.dir, slugifyId(system), slugifyId(environment)].join('/'));
      await writeFileAtomic(this.io, this.fileOf(scope), JSON.stringify({ version: 1, system, environment, entries }));
      this.dirty.delete(scope);
      await yieldToLoop();
    }
  }

  /**
   * Records tables at tier ≥ 1. An unchanged entry keeps its usage and
   * last-altered data; a changed one is replaced. Returns the ids that are
   * new or changed.
   */
  public upsert(entries: readonly CatalogEntry[]): string[] {
    const changed: string[] = [];
    for (const e of entries) {
      const prev = this.entries.get(e.id);
      if (prev && prev.tier > 0 && contentKey(prev) === contentKey(e)) {
        if (e.loadedAt && (!prev.loadedAt || e.loadedAt > prev.loadedAt)) { prev.loadedAt = e.loadedAt; this.dirty.add(this.scopeOf(prev)); }
        if (e.lastAltered && e.lastAltered !== prev.lastAltered) { prev.lastAltered = e.lastAltered; this.dirty.add(this.scopeOf(prev)); }
        if (prev.visible === false) { prev.visible = true; this.dirty.add(this.scopeOf(prev)); }
        if (e.tier === 2 && prev.tier < 2) { this.entries.set(e.id, { ...e, lastUsedAt: prev.lastUsedAt }); this.dirty.add(this.scopeOf(e)); }
        continue;
      }
      this.entries.set(e.id, { ...e, lastUsedAt: prev?.lastUsedAt, lastAltered: e.lastAltered ?? prev?.lastAltered });
      this.dirty.add(this.scopeOf(e));
      changed.push(e.id);
    }
    if (changed.length) this.indexStale = true;
    return changed;
  }

  /** Records names only (tier 0) — never downgrades an entry that has structure. */
  public upsertNames(entries: ReadonlyArray<Omit<CatalogEntry, 'tier' | 'columns'>>): number {
    let added = 0;
    for (const e of entries) {
      if (this.entries.has(e.id)) continue;
      this.entries.set(e.id, { ...e, tier: 0 });
      this.dirty.add(this.scopeOf(e));
      added++;
    }
    if (added) this.indexStale = true;
    return added;
  }

  public removeWhere(predicate: (e: CatalogEntry) => boolean): string[] {
    const removed: string[] = [];
    for (const e of this.all()) {
      if (!predicate(e)) continue;
      this.entries.delete(e.id);
      this.dirty.add(this.scopeOf(e));
      removed.push(e.id);
    }
    if (removed.length) this.indexStale = true;
    return removed;
  }

  /** Marks objects as used now (pack seeds, rendered tables, spec references). Column ids count for their table. */
  public touch(ids: Iterable<string>): void {
    const at = this.now().toISOString();
    for (const id of ids) {
      const e = this.entries.get(id) ?? this.entries.get(id.replace(/\.[^./]+$/, ''));
      if (!e || e.lastUsedAt === at) continue;
      e.lastUsedAt = at;
      this.dirty.add(this.scopeOf(e));
    }
  }

  /** The structure of `id` was looked for and is not visible (grants). Looked for again after the schema TTL. */
  public markInvisible(id: string, at: string = this.now().toISOString()): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.visible = false;
    e.loadedAt = at;
    this.dirty.add(this.scopeOf(e));
  }

  /** Re-checked against the source and unchanged (refresh on use, item 5). */
  public markChecked(id: string, at: string = this.now().toISOString()): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.loadedAt = at;
    this.dirty.add(this.scopeOf(e));
  }

  /**
   * Drops a live-sourced entry back to tier 0 (eviction, item 4). A
   * file-sourced entry keeps its structure: there is nothing to re-fetch it
   * from.
   */
  public demote(id: string): void {
    const e = this.entries.get(id);
    if (!e || e.tier === 0 || e.origin?.reliability !== 'live-verified') return;
    this.entries.set(id, { ...e, tier: 0, columns: undefined, edges: undefined });
    this.dirty.add(this.scopeOf(e));
    this.indexStale = true;
  }

  public toGraph(ids: Iterable<string>): { nodes: BaseNode[]; edges: GraphEdge[] } {
    const nodes: BaseNode[] = [];
    const edges: GraphEdge[] = [];
    for (const id of ids) {
      const e = this.entries.get(id);
      if (!e || e.tier === 0) continue;
      const g = entryToGraph(e);
      nodes.push(...g.nodes);
      edges.push(...g.edges);
    }
    return { nodes, edges };
  }

  /** Latest load per `system/environment` — the catalog's revision, pinned in grounding manifests (item 6). */
  public watermarks(): Record<string, string> {
    return catalogWatermarks(this.all().map((e) => ({ ...e.table, origin: e.origin } as BaseNode)));
  }

  // ── Retrieval index ─────────────────────────────────────────────────────────

  private docFor(e: CatalogEntry, signals: Required<NonNullable<CatalogSearchOptions['signals']>>): IndexedDoc {
    const weights = new Map<string, number>();
    const add = (text: string | undefined, w: number) => {
      for (const c of concepts(text ?? '', this.vocab, signals)) if ((weights.get(c) ?? 0) < w) weights.set(c, w);
    };
    const nameConcepts = new Set(concepts(e.table.label, this.vocab, signals));
    add(e.table.label, FIELD.name);
    add(e.table.schema, FIELD.schema);
    if (signals.comments) add(e.table.description, FIELD.comment);
    if (signals.glossary) for (const a of this.aliases.get(e.id) ?? []) add(a, FIELD.alias);
    for (const c of e.columns ?? []) {
      add(c.label, FIELD.column);
      if (signals.comments) add(c.description, FIELD.column);
    }
    return { id: e.id, weights, nameConcepts };
  }

  private fullSignals(s?: CatalogSearchOptions['signals']): Required<NonNullable<CatalogSearchOptions['signals']>> {
    return { ...ALL_SIGNALS, comments: true, glossary: true, ...(s ?? {}) };
  }

  /**
   * (Re)builds the index, yielding to the event loop every 100 entries so a
   * large catalog never blocks the extension host for long (item 11).
   */
  public async buildIndex(options: { signals?: CatalogSearchOptions['signals']; signal?: AbortSignal } = {}): Promise<void> {
    const signals = this.fullSignals(options.signals);
    const docs: IndexedDoc[] = [];
    const postings = new Map<string, number[]>();
    let i = 0;
    for (const e of this.entries.values()) {
      if (options.signal?.aborted) return;
      const d = this.docFor(e, signals);
      for (const c of d.weights.keys()) {
        const p = postings.get(c);
        if (p) p.push(docs.length); else postings.set(c, [docs.length]);
      }
      docs.push(d);
      if (++i % 100 === 0) await yieldToLoop();
    }
    this.index = { docs, postings, signalsKey: JSON.stringify(signals) };
    this.indexStale = false;
  }

  public isIndexStale(): boolean { return this.indexStale || !this.index; }

  /**
   * Ranked search: Σ idf(concept) × field weight over the request's concepts,
   * times (1 + the share of the object's name the request covers). Uses the
   * last built index; builds one synchronously only if none exists yet.
   */
  public search(query: string, options: CatalogSearchOptions = {}): CatalogHit[] {
    const signals = this.fullSignals(options.signals);
    if (!this.index || this.index.signalsKey !== JSON.stringify(signals)) this.buildIndexSync(signals);
    const { docs, postings } = this.index!;
    const q = [...new Set(concepts(query, this.vocab, signals, true))];
    const score = new Map<number, { s: number; strong: boolean; name: number; matched: string[] }>();
    for (const c of q) {
      const p = postings.get(c);
      if (!p) continue;
      const idf = Math.log(1 + docs.length / p.length);
      for (const d of p) {
        const w = docs[d].weights.get(c)!;
        const cur = score.get(d) ?? { s: 0, strong: false, name: 0, matched: [] };
        cur.s += idf * w;
        cur.strong = cur.strong || w >= STRONG_FIELD;
        if (docs[d].nameConcepts.has(c)) cur.name++;
        cur.matched.push(c);
        score.set(d, cur);
      }
    }
    const hits: CatalogHit[] = [];
    for (const [d, v] of score) {
      if (!v.strong) continue;
      const doc = docs[d];
      const coverage = doc.nameConcepts.size ? v.name / doc.nameConcepts.size : 0;
      const e = this.entries.get(doc.id);
      if (!e) continue;
      hits.push({ id: doc.id, score: v.s * (1 + coverage), tier: e.tier, visible: e.visible !== false, matched: v.matched });
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return hits.slice(0, options.limit ?? 10);
  }

  private buildIndexSync(signals: Required<NonNullable<CatalogSearchOptions['signals']>>): void {
    const docs: IndexedDoc[] = [];
    const postings = new Map<string, number[]>();
    for (const e of this.entries.values()) {
      const d = this.docFor(e, signals);
      for (const c of d.weights.keys()) {
        const p = postings.get(c);
        if (p) p.push(docs.length); else postings.set(c, [docs.length]);
      }
      docs.push(d);
    }
    this.index = { docs, postings, signalsKey: JSON.stringify(signals) };
    this.indexStale = false;
  }
}

/**
 * What a pack builder needs from the catalog (engine-side view; the host
 * owns the `Catalog`). Hits whose structure is loaded can be rendered and are
 * then promoted into the working set; tier-0 hits raise a context gap.
 */
export interface CatalogLookup {
  search(query: string): CatalogHit[];
  get(id: string): CatalogEntry | undefined;
  toGraph(ids: Iterable<string>): { nodes: BaseNode[]; edges: GraphEdge[] };
}

/**
 * Which hits become pack seeds: the best few, within a margin of the best
 * score — a ranked list's long tail is noise, not context.
 */
/**
 * Glossary aliases (Phase K2): a business term's or metric's name and
 * definition index the tables it maps to — resolved against the catalog, so
 * they bind to tables outside the working set too.
 */
export function glossaryAliases(entries: readonly CatalogEntry[], nodes: readonly BaseNode[]): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const e of entries) {
    for (const k of [e.table.fqn, `${e.table.schema}.${e.table.label}`, e.table.label].map((x) => String(x ?? '').toLowerCase())) {
      if (k) byName.set(k, [...new Set([...(byName.get(k) ?? []), e.id])]);
    }
  }
  const aliases = new Map<string, string[]>();
  for (const term of nodes) {
    if (term.type !== 'business_term' && term.type !== 'metric') continue;
    const text = [term.label, term.description].filter(Boolean).join(' ');
    for (const ref of (term as BaseNode & { mappedNodeIds?: string[] }).mappedNodeIds ?? []) {
      for (const id of byName.get(String(ref).toLowerCase()) ?? []) aliases.set(id, [...new Set([...(aliases.get(id) ?? []), text])]);
    }
  }
  return aliases;
}

export function selectSeedHits(hits: readonly CatalogHit[], options: { max?: number; margin?: number; minScore?: number } = {}): CatalogHit[] {
  if (hits.length === 0) return [];
  const best = hits[0].score;
  const floor = Math.max(options.minScore ?? 3, best * (options.margin ?? 0.75));
  return hits.filter((h) => h.score >= floor).slice(0, options.max ?? 3);
}

// ── Working set policy ────────────────────────────────────────────────────────

export interface WorkingSetPolicy {
  /** Tables the working set holds before imports stop entering it whole (§1 design target: 200). */
  maxTables: number;
  /** Unused working-set objects leave it after this many days (only while it is over `maxTables`). */
  evictAfterDays: number;
  /** Schema facts are re-checked when used after this many days (§8.2: 7). */
  schemaTtlDays: number;
}

export const DEFAULT_WORKING_SET_POLICY: WorkingSetPolicy = { maxTables: 200, evictAfterDays: 30, schemaTtlDays: 7 };

/** True when the entry's structure is older than the schema TTL. */
export function isStale(e: CatalogEntry, policy: WorkingSetPolicy, now: Date): boolean {
  if (!e.loadedAt) return true;
  return now.getTime() - Date.parse(e.loadedAt) > policy.schemaTtlDays * 86_400_000;
}

/**
 * Working-set tables to evict: unused for `evictAfterDays` and referenced by
 * no live business assertion — and only while the working set is over its
 * size, oldest first, until it fits. A small estate is never evicted.
 */
export function selectEvictions(
  workingSet: readonly string[],
  catalog: Pick<Catalog, 'get'>,
  referenced: ReadonlySet<string>,
  policy: WorkingSetPolicy,
  now: Date
): string[] {
  const excess = workingSet.length - policy.maxTables;
  if (excess <= 0) return [];
  const cutoff = now.getTime() - policy.evictAfterDays * 86_400_000;
  const candidates = workingSet
    .filter((id) => !referenced.has(id))
    .map((id) => ({ id, used: Date.parse(catalog.get(id)?.lastUsedAt ?? catalog.get(id)?.loadedAt ?? '') || 0 }))
    .filter((c) => c.used < cutoff)
    .sort((a, b) => a.used - b.used || (a.id < b.id ? -1 : 1));
  return candidates.slice(0, excess).map((c) => c.id);
}

/**
 * Reads structure from a live source (implemented over a platform adapter by
 * the host). Every method is optional in effect: a source that cannot answer
 * returns nothing and the caller degrades to what the catalog holds.
 */
export interface CatalogFetcher {
  /** Which systems/environments this fetcher can answer for. */
  covers(system: string, environment: string): boolean;
  /** Structure for the given tables (graph form). A table missing from the result is not visible with the current grants. */
  fetchStructure(entries: readonly CatalogEntry[]): Promise<{ nodes: BaseNode[]; edges: GraphEdge[] }>;
  /** The source's last-altered timestamp per table id, where it reports one. */
  lastAltered?(entries: readonly CatalogEntry[]): Promise<Map<string, string>>;
}
