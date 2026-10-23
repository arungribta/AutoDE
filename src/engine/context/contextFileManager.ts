import { ensureLayout, layoutPath } from '../workspaceLayout';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GraphManager } from './graphManager';
import { parseYaml } from './Yaml';
import { readGraphSnapshot, writeGraphSnapshot } from './graphPersistence';
import { ContextValidator } from './ContextValidator';
import { AssertionLedger } from './ledger';
import { projectGraph, syncGraphToLedger } from './projection';
import { Conflict, detectConflicts, flagConflicts } from './conflicts';
import { ContextPack, ContextPackRequest, ContextPackSources, buildContextPack } from './contextPack';
import { DEFAULT_ENVIRONMENT, Estate, mergeWatermarks, EstateBinding, ObjectIdentity, UNASSIGNED_SYSTEM, catalogWatermarks, edgeId, emptyEstate, parseEstate, queryId, rekeyLegacyGraph, resolveIdentity, ruleId, serializeEstate, termId } from './estate';
import type { IngestIdentity } from './fileIngestion';
import { Catalog, CatalogEntry, CatalogFetcher, DEFAULT_WORKING_SET_POLICY, WorkingSetPolicy, entriesFromGraph, glossaryAliases, isStale, selectEvictions, selectSeedHits } from './catalog';
import { buildVocabulary, parseVocabularyFile } from './vocabulary';
import { isLive } from './assertions';
import { isMirror } from './projection';
import type { Origin } from './types';
import {
  BaseNode,
  BusinessTermNode,
  BusinessRuleNode,
  VerifiedQueryNode,
  GraphEdge,
  NodeType
} from './types';

interface BusinessContextEntry {
  term: string;
  description?: string;
  formula?: string;
  mapped_tables?: string[];
  enforcement?: 'STRICT' | 'RECOMMENDED';
}

interface VerifiedQueryEntry {
  name: string;
  sql: string;
  dialect?: string;
  tables_used?: string[];
  author?: string;
}

interface BusinessContextFile {
  business_terms?: BusinessContextEntry[];
  business_rules?: BusinessRuleEntry[];
}

interface BusinessRuleEntry {
  rule: string;
  enforcement?: 'STRICT' | 'RECOMMENDED';
  applies_to?: string[];
}

interface VerifiedQueriesFile {
  queries?: VerifiedQueryEntry[];
}

/**
 * A generic, ephemeral fact about the current session (e.g. "a Snowflake
 * connection is live right now") — never persisted to disk, cleared on
 * extension reload by construction. Deliberately generic: `ContextFileManager`
 * doesn't need to know what produced a fact (a connection, an LLM provider
 * check, anything else), only how to render it — keeping fact producers and
 * the LLM-prompt consumer decoupled through this one shared object.
 */
export interface RuntimeFact {
  label: string;
  text: string;
}

/** Watches `.autode/knowledge/` for edits (the extension passes VS Code's watcher; the CLI and MCP server need none). */
export type KnowledgeWatcher = (knowledgeDir: string, onChange: () => void) => { dispose(): void };

/**
 * The context layer of one workspace: ledger, estate, catalog, working set and
 * packs. In the engine since v0.43.2 (it lived in src/context/), with no VS Code
 * dependency, so `autode estate` and the MCP ingest tools load an estate with
 * exactly the code the panel uses.
 */
export class ContextFileManager {
  private watcher: { dispose(): void } | null = null;
  private readonly root: string;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 300;
  private readonly runtimeFacts = new Map<string, RuntimeFact>();
  /**
   * The assertion ledger (C2, v0.29.0) — the context layer's system of
   * record. The graph is rebuilt from it on every persist; see
   * `persistCompiledGraph()`. Node `fs`, like the rest of this class.
   */
  private readonly ledger: AssertionLedger;
  private conflicts: Conflict[] = [];
  /** The active business problem's spec id — scopes spec-derived assertions (see `inSpecScope`). */
  private activeSpecId: string | undefined;
  /** The most recent packs, newest first — what "AutoDE: What the Agent Saw" lists (C3). */
  private readonly recentPacks: Array<{ title: string; at: string; pack: ContextPack }> = [];
  /** `.autode/knowledge/estate.yaml` (Phase K1): systems, environments, bindings. */
  private estate: Estate = emptyEstate();
  private estateDirty = false;
  /** Re-keyings found while loading, recorded in the ledger at the next persist. */
  private pendingAliases = new Map<string, string>();
  /**
   * Phase K2: the estate catalog (tiers 0–2, `.autode/local/catalog/`, git-ignored).
   * The graph and ledger hold only the working set; see `admitObjects()`.
   */
  private readonly catalog: Catalog;
  private catalogLoaded = false;
  private policy: WorkingSetPolicy = { ...DEFAULT_WORKING_SET_POLICY };
  private fetcher: CatalogFetcher | undefined;
  /** Promotions requested by packs, applied one after another. */
  private promotions: Promise<void> = Promise.resolve();

  constructor(
    workspaceRoot: string | { fsPath: string },
    private readonly graphManager: GraphManager,
    private readonly log: (msg: string) => void,
    private readonly validator?: ContextValidator,
    private readonly watchKnowledge?: KnowledgeWatcher
  ) {
    this.root = typeof workspaceRoot === 'string' ? workspaceRoot : workspaceRoot.fsPath;
    this.ledger = new AssertionLedger(layoutPath(this.root, 'ledger'));
    this.catalog = new Catalog(layoutPath(this.root, 'catalog'));
  }

  // ── Working set and catalog (Phase K2) ──────────────────────────────────────

  /** Working-set size, eviction age and schema TTL (settings `autoDataEngineeringHub.context.*`). */
  public setWorkingSetPolicy(policy: Partial<WorkingSetPolicy>): void {
    this.policy = { ...this.policy, ...Object.fromEntries(Object.entries(policy).filter(([, v]) => typeof v === 'number' && v >= 0)) };
  }

  /** Live structure lookups for query-through and refresh-on-use; `undefined` when nothing is connected. */
  public setCatalogFetcher(fetcher: CatalogFetcher | undefined): void {
    this.fetcher = fetcher;
  }

  public getCatalog(): Catalog {
    return this.catalog;
  }

  /** Resolves when the promotions packs asked for have been applied. */
  public whenIdle(): Promise<void> {
    return this.promotions;
  }

  /** Physical tables (and views) in the working set — the graph. */
  private workingSetTableIds(): Set<string> {
    return new Set([...this.graphManager.getNodesByType('table'), ...this.graphManager.getNodesByType('semantic_view')].map((n) => n.id).filter((id) => id.startsWith('obj:')));
  }

  /** Tables that live business assertions are about (a column counts for its table) — never evicted. */
  private referencedTables(): Set<string> {
    const out = new Set<string>();
    for (const a of this.ledger.assertions()) {
      if (isMirror(a) || !isLive(a.status)) continue;
      for (const s of a.subject) {
        if (this.catalog.has(s)) out.add(s);
        else {
          const table = s.replace(/\.[^./]+$/, '');
          if (this.catalog.has(table)) out.add(table);
        }
      }
    }
    return out;
  }

  /** Replaces the graph's copy of these tables (and their columns) with the catalog's. */
  private async putInGraph(ids: ReadonlySet<string>): Promise<void> {
    if (ids.size === 0) return;
    const snap = this.graphManager.serializeSnapshot();
    const remove = new Set(ids);
    for (const e of snap.edges) if (e.type === 'contains' && ids.has(e.source)) remove.add(e.target);
    await this.graphManager.removeNodesWhere((n) => remove.has(n.id));
    const g = this.catalog.toGraph(ids);
    for (const n of g.nodes) await this.graphManager.addNode(n);
    for (const e of g.edges) await this.graphManager.addEdge(e);
    await this.relinkGlossary(ids);
  }

  /**
   * Glossary terms name their tables (`mapped_tables`); the `maps_to` edges are
   * made when the glossary is read. A table that arrives later — imported,
   * extracted or promoted after that — gets its edges here. (Before v0.32.0
   * they appeared only after the next re-index.)
   */
  private async relinkGlossary(tableIds: ReadonlySet<string>): Promise<void> {
    const tables = [...tableIds].map((id) => this.graphManager.getNodeById(id)).filter((n): n is BaseNode => !!n);
    if (tables.length === 0) return;
    for (const term of [...this.graphManager.getNodesByType('business_term'), ...this.graphManager.getNodesByType('metric')]) {
      const refs = ((term as BusinessTermNode).mappedNodeIds ?? []).map((r) => String(r).toLowerCase());
      for (const t of tables) {
        const fqn = String((t as unknown as { fqn?: string }).fqn ?? '').toLowerCase();
        if (!refs.some((r) => r === fqn || fqn.endsWith('.' + r) || r === t.label.toLowerCase())) continue;
        await this.graphManager.addEdge({ id: edgeId('maps_to', term.id, t.id), source: term.id, target: t.id, type: 'maps_to', weight: 0.8 });
      }
    }
  }

  /**
   * Admits parsed or extracted objects (Phase K2, item 4): every table goes
   * into the catalog; the working set takes all of them when they fit its
   * size (`maxTables`), otherwise only the ones already in it or referenced
   * by a business assertion — the rest enter it when a pack, spec or mapping
   * uses them. Does not persist; callers do.
   */
  public async admitObjects(nodes: readonly BaseNode[], edges: readonly GraphEdge[], workingSetBefore?: ReadonlySet<string>): Promise<{ catalogued: number; promoted: number }> {
    const entries = entriesFromGraph(nodes, edges);
    this.catalog.upsert(entries);
    const ws = workingSetBefore ?? this.workingSetTableIds();
    const fresh = entries.filter((e) => !ws.has(e.id));
    const fits = ws.size + fresh.length <= this.policy.maxTables;
    const referenced = fits ? new Set<string>() : this.referencedTables();
    const chosen = fits ? entries : entries.filter((e) => ws.has(e.id) || referenced.has(e.id));
    await this.putInGraph(new Set(chosen.map((e) => e.id)));
    if (!fits) this.log(`Catalogued ${entries.length} table(s); ${chosen.length} in the working set (limit ${this.policy.maxTables}). The rest enter it when a task uses them.`);
    return { catalogued: entries.length, promoted: chosen.length };
  }

  /** "Import File…" and other producers: admit, then record in the ledger and persist. */
  public async ingestParsed(nodes: readonly BaseNode[], edges: readonly GraphEdge[]): Promise<{ catalogued: number; promoted: number }> {
    const r = await this.admitObjects(nodes, edges);
    await this.persistCompiledGraph();
    return r;
  }

  /** Brings catalog objects with loaded structure into the working set (a pack used them). */
  public async promote(ids: readonly string[]): Promise<number> {
    const ws = this.workingSetTableIds();
    const todo = new Set(ids.filter((id) => !ws.has(id) && (this.catalog.get(id)?.tier ?? 0) > 0));
    if (todo.size === 0) return 0;
    await this.putInGraph(todo);
    await this.persistCompiledGraph();
    this.log(`Working set: ${todo.size} table(s) promoted from the catalog.`);
    return todo.size;
  }

  /**
   * Re-checks entries against the live source (items 4 and 5): unchanged
   * last-altered → just marked checked; otherwise the structure is fetched.
   * A requested table the source doesn't return is not visible with the
   * current grants. Working-set members get their new structure in the graph,
   * so the ledger records a change as a supersession and flags dependents.
   */
  private async refreshEntries(entries: readonly CatalogEntry[]): Promise<{ checked: number; fetched: number }> {
    const f = this.fetcher;
    const mine = f ? entries.filter((e) => f.covers(e.system, e.environment)) : [];
    if (!f || mine.length === 0) return { checked: 0, fetched: 0 };
    const now = new Date().toISOString();
    let toFetch = mine;
    if (f.lastAltered) {
      const known = mine.filter((e) => e.tier > 0 && e.lastAltered);
      const altered = known.length ? await f.lastAltered(known) : new Map<string, string>();
      const unchanged = new Set(known.filter((e) => altered.get(e.id) === e.lastAltered).map((e) => e.id));
      for (const id of unchanged) this.catalog.markChecked(id, now);
      toFetch = mine.filter((e) => !unchanged.has(e.id));
    }
    if (toFetch.length === 0) return { checked: mine.length, fetched: 0 };
    const g = await f.fetchStructure(toFetch);
    const fetched = entriesFromGraph(g.nodes, g.edges, now);
    const got = new Set(fetched.map((e) => e.id));
    for (const e of toFetch) if (!got.has(e.id)) this.catalog.markInvisible(e.id, now);
    this.catalog.upsert(fetched);
    const ws = this.workingSetTableIds();
    const inWs = new Set(fetched.filter((e) => ws.has(e.id)).map((e) => e.id));
    if (inWs.size > 0) {
      await this.putInGraph(inWs);
      await this.persistCompiledGraph();
    } else {
      await this.catalog.save();
    }
    return { checked: mine.length, fetched: fetched.length };
  }

  /**
   * Before a pack is built (`ContextPackProvider.prepare`): the request's
   * catalog matches are loaded (query-through for name-only entries, refresh
   * for stale ones) and promoted into the working set. Offline, nothing is
   * fetched and the pack reports what's missing as a context gap.
   */
  public async prepareContext(request: ContextPackRequest): Promise<void> {
    if (!request.query) return;
    if (this.catalog.isIndexStale()) await this.catalog.buildIndex();
    const now = new Date();
    const entries = selectSeedHits(this.catalog.search(request.query))
      .map((h) => this.catalog.get(h.id))
      .filter((e): e is CatalogEntry => !!e && (e.visible !== false || isStale(e, this.policy, now)));
    await this.refreshEntries(entries.filter((e) => e.tier === 0 || isStale(e, this.policy, now)));
    await this.promote(entries.map((e) => e.id));
  }

  /** Refresh on use before a plan runs (`ContextPackProvider.beforeRun`): the working set's stale objects. */
  public async refreshWorkingSet(): Promise<{ checked: number; fetched: number }> {
    const now = new Date();
    const stale = [...this.workingSetTableIds()].map((id) => this.catalog.get(id)).filter((e): e is CatalogEntry => !!e && isStale(e, this.policy, now));
    return this.refreshEntries(stale);
  }

  /** Working-set tables unused past the eviction age while the set is over its size (item 4). */
  private async evictUnused(): Promise<Set<string> | undefined> {
    const ids = selectEvictions([...this.workingSetTableIds()], this.catalog, this.referencedTables(), this.policy, new Date());
    if (ids.length === 0) return undefined;
    const set = new Set(ids);
    for (const e of this.graphManager.serializeSnapshot().edges) if (e.type === 'contains' && ids.includes(e.source)) set.add(e.target);
    await this.graphManager.removeNodesWhere((n) => set.has(n.id));
    for (const id of ids) this.catalog.demote(id);
    this.log(`Working set: ${ids.length} unused table(s) evicted to the catalog.`);
    return set;
  }

  /** The working set into the catalog (backfills workspaces from before K2), glossary aliases, index, save. */
  private async syncCatalog(): Promise<void> {
    const snap = this.graphManager.serializeSnapshot();
    this.catalog.upsert(entriesFromGraph(snap.nodes, snap.edges));
    this.catalog.setAliases(glossaryAliases(this.catalog.all(), snap.nodes));
    if (this.catalog.isIndexStale()) await this.catalog.buildIndex();
    await this.catalog.save();
  }

  /** Re-reads `vocabulary.yaml` and rebuilds the retrieval index (after "Propose Vocabulary" wrote to it). */
  public async reloadVocabulary(): Promise<void> {
    this.loadVocabulary();
    await this.catalog.buildIndex();
  }

  /** `.autode/knowledge/vocabulary.yaml`: the customer's abbreviations and synonyms. */
  private loadVocabulary(): void {
    const file = this.firstExisting([layoutPath(this.root, 'vocabulary')]);
    try {
      this.catalog.setVocabulary(buildVocabulary(file ? parseVocabularyFile(fs.readFileSync(file, 'utf8')) : undefined));
    } catch (err) {
      this.log(`Failed to read vocabulary.yaml: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Sets which business problem's spec-derived assertions are in scope. Call
   * before synthesizing a spec into the graph; switching problems leaves the
   * previous problem's assertions live in the ledger, just not projected.
   */
  public setActiveSpecId(specId: string | undefined): void {
    this.activeSpecId = specId;
  }

  private estatePath(): string {
    return layoutPath(this.root, 'estate');
  }

  private loadEstate(): void {
    try {
      this.estate = parseEstate(fs.existsSync(this.estatePath()) ? fs.readFileSync(this.estatePath(), 'utf8') : undefined);
    } catch (err) {
      this.log(`Could not read estate.yaml (${err instanceof Error ? err.message : String(err)}); using an empty estate.`);
      this.estate = emptyEstate();
    }
  }

  private saveEstateIfChanged(): void {
    if (!this.estateDirty) return;
    try {
      fs.mkdirSync(path.dirname(this.estatePath()), { recursive: true });
      const tmp = `${this.estatePath()}.tmp.${Date.now()}`;
      fs.writeFileSync(tmp, serializeEstate(this.estate), 'utf8');
      fs.renameSync(tmp, this.estatePath());
      this.estateDirty = false;
    } catch (err) {
      this.log(`Could not write estate.yaml: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Re-reads `estate.yaml` unless there are unsaved changes, so edits made in the editor apply at once. */
  private refreshEstate(): void {
    if (!this.estateDirty) this.loadEstate();
  }

  /** The estate (systems, environments, bindings) — Phase K1. */
  public getEstate(): Estate {
    this.refreshEstate();
    return this.estate;
  }

  /** Adds or replaces a binding (and its system, when new) and saves `estate.yaml`. */
  public bindToSystem(binding: EstateBinding, systemName?: string, role: 'source' | 'target' | 'both' = 'source'): void {
    this.refreshEstate();
    const others = this.estate.bindings.filter((b) => !((binding.connection && b.connection === binding.connection) || (binding.file && b.file && b.file.toLowerCase() === binding.file.toLowerCase())));
    const systems = this.estate.systems.some((s) => s.id === binding.system) ? this.estate.systems : [...this.estate.systems, { id: binding.system, name: systemName ?? binding.system, role }];
    this.estate = { systems, bindings: [...others, binding] };
    this.estateDirty = true;
    this.saveEstateIfChanged();
  }

  /** Which system/environment a live connection feeds, and which schemas to extract. Creates a system for an unbound connection. */
  public resolveConnection(connectionId: string): { identity: ObjectIdentity; schemas?: string[] } {
    this.refreshEstate();
    const r = resolveIdentity(this.estate, { connection: connectionId });
    if (r.created) { this.estate = r.estate; this.estateDirty = true; this.saveEstateIfChanged(); }
    const binding = this.estate.bindings.find((b) => b.connection === connectionId);
    return { identity: r.identity, schemas: binding?.schemas };
  }

  /** Which system/environment an imported file belongs to. Creates a system named after the file when unbound. */
  public resolveFile(filePath: string): IngestIdentity {
    this.refreshEstate();
    const r = resolveIdentity(this.estate, { file: filePath });
    if (r.created) { this.estate = r.estate; this.estateDirty = true; this.saveEstateIfChanged(); }
    return r.identity;
  }

  /** Identity for re-keying a legacy node from its provenance. */
  private identityOfOrigin(origin: Origin | undefined): { system: string; environment: string } {
    if (origin?.system) return { system: origin.system, environment: origin.systemEnvironment ?? DEFAULT_ENVIRONMENT };
    // The team's own knowledge files describe the business, not a system: they never become a source (v0.45.8 fix).
    if (origin?.extractor === 'business-context' || origin?.extractor === 'verified-queries') return { system: UNASSIGNED_SYSTEM, environment: DEFAULT_ENVIRONMENT };
    const looksLikeFile = (ref: string) => /[\\/]|\.(csv|json|sql|ddl)$/i.test(ref);
    let r: ReturnType<typeof resolveIdentity> | undefined;
    if (origin?.connectionId) r = resolveIdentity(this.estate, { connection: origin.connectionId });
    else if (origin?.sourceRef && looksLikeFile(origin.sourceRef)) r = resolveIdentity(this.estate, { file: origin.sourceRef });
    if (!r) return { system: UNASSIGNED_SYSTEM, environment: DEFAULT_ENVIRONMENT };
    if (r.created) { this.estate = r.estate; this.estateDirty = true; }
    return { system: r.identity.system, environment: r.identity.environment };
  }

  /** Re-keys legacy ids in the live graph (Phase K1 item 2); remembers the aliases for the next persist. */
  private async rekeyLiveGraph(): Promise<void> {
    const snap = this.graphManager.serializeSnapshot();
    const r = rekeyLegacyGraph(snap, (o) => this.identityOfOrigin(o));
    if (r.aliases.size === 0) return;
    for (const [from, to] of r.aliases) this.pendingAliases.set(from, to);
    await this.graphManager.loadSnapshot({ nodes: r.nodes, edges: r.edges });
    this.log(`Re-keyed ${r.aliases.size} legacy id(s) to the estate scheme.`);
  }

  public getActiveSpecId(): string | undefined {
    return this.activeSpecId;
  }

  public getLedger(): AssertionLedger {
    return this.ledger;
  }

  /** Contradictions found at the last persist (§8.1). */
  public getConflicts(): readonly Conflict[] {
    return this.conflicts;
  }

  /** `AutoDE: Compact Context Ledger` — snapshot the folded state; history is kept unless `prune`. */
  public async compactLedger(prune = false): Promise<{ assertions: number; prunedFiles: number }> {
    return this.ledger.compact({ prune });
  }

  /**
   * Records or clears an in-memory, session-scoped fact under `key` (pass
   * `null` to clear). Never written to `.autode/` — this is for live facts
   * that must not survive a reload, not durable schema/glossary content.
   */
  public setRuntimeFact(key: string, fact: RuntimeFact | null): void {
    if (fact === null) {
      this.runtimeFacts.delete(key);
    } else {
      this.runtimeFacts.set(key, fact);
    }
  }

  public dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
  }

  public async initialize(): Promise<void> {
    // Ensure .autode/ (with its .gitignore for local/) exists
    try {
      ensureLayout(this.root);
    } catch {
      // Not a local file system, or already there
    }

    // Shared knowledge files (estate, sources, business context, vocabulary …) re-index on change — where the host watches.
    if (this.watchKnowledge) this.watcher = this.watchKnowledge(layoutPath(this.root, 'knowledge'), () => this.debouncedReindex());

    // Initial load
    await this.loadAllFiles();
  }

  private debouncedReindex(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.loadAllFiles().catch((err) =>
        this.log(`Context re-index failed: ${err instanceof Error ? err.message : String(err)}`)
      );
    }, this.DEBOUNCE_MS);
  }

  private async loadAllFiles(): Promise<void> {
    const contextPath = layoutPath(this.root, 'root');

    // ── Base graph (C2, v0.29.0): the projection of the assertion ledger, the
    // system of record. A workspace with no ledger yet starts from the compiled
    // `derived/graph.json` instead, which the persist below then migrates into
    // the ledger. ──
    this.graphManager.clear();
    this.loadEstate();
    if (!this.catalogLoaded) {
      try {
        await this.catalog.load();
      } catch (err) {
        this.log(`Failed to read the catalog (it is rebuilt from its sources): ${err instanceof Error ? err.message : String(err)}`);
      }
      this.catalogLoaded = true;
    }
    this.loadVocabulary();
    const graphPath = layoutPath(this.root, 'graph');
    const legacySchemaPath = layoutPath(this.root, 'schemaGraph');
    try {
      await this.ledger.load();
    } catch (err) {
      this.log(`Failed to read the context ledger: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!this.ledger.isEmpty()) {
      await this.graphManager.loadSnapshot(projectGraph(this.ledger.assertions(), { activeSpecId: this.activeSpecId }));
    } else if (fs.existsSync(graphPath)) {
      try {
        const snapshot = readGraphSnapshot(graphPath);
        if (snapshot && Array.isArray(snapshot.nodes) && Array.isArray(snapshot.edges)) {
          await this.graphManager.loadSnapshot(snapshot as { nodes: BaseNode[]; edges: GraphEdge[] });
          this.log(`Loaded compiled graph from derived/graph.json (${snapshot.nodes.length} nodes, ${snapshot.edges.length} edges)`);
        }
      } catch (err) {
        this.log(`Failed to load derived/graph.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await this.rekeyLiveGraph();

    // ── A live extraction (Source Assessment, "Connect to build Source Context")
    // writes `schema-graph.json` via ConnectionManager.persistSchemaContext().
    // When it is newer than the compiled graph it is merged in: nodes from the
    // same source (`origin.sourceRef`) are replaced, everything else — file
    // ingestion, business context — is kept (before v0.29.0 the whole graph was
    // replaced). Compare mtimes rather than existence: persistCompiledGraph()
    // writes derived/graph.json on every reindex, so an exists() check would
    // shadow every later extraction (a real bug, fixed earlier). ──
    const graphMtimeMs = fs.existsSync(graphPath) ? fs.statSync(graphPath).mtimeMs : -1;
    const legacyMtimeMs = fs.existsSync(legacySchemaPath) ? fs.statSync(legacySchemaPath).mtimeMs : -1;
    if (legacyMtimeMs > graphMtimeMs) {
      try {
        const raw = JSON.parse(fs.readFileSync(legacySchemaPath, 'utf8')) as { nodes?: BaseNode[]; edges?: GraphEdge[] };
        if (raw.nodes && raw.edges) {
          // An extraction written before Phase K1 still has legacy ids.
          const re = rekeyLegacyGraph({ nodes: raw.nodes, edges: raw.edges }, (o) => this.identityOfOrigin(o));
          const snapshot = { nodes: re.nodes, edges: re.edges };
          // Phase K1: replace exactly what this extraction covers — the same
          // system, environment and database.schema (or the same connection
          // and database.schema, should the connection have been re-bound) —
          // so extracting a second schema never retracts the first.
          const scopeKey = (n: BaseNode) => {
            const t = n as unknown as { database?: string; schema?: string };
            return `${n.origin?.system ?? ''}|${n.origin?.systemEnvironment ?? ''}|${(t.database ?? '').toLowerCase()}.${(t.schema ?? '').toLowerCase()}`;
          };
          const connScope = (n: BaseNode) => {
            const t = n as unknown as { database?: string; schema?: string };
            return `${n.origin?.connectionId ?? ''}|${(t.database ?? '').toLowerCase()}.${(t.schema ?? '').toLowerCase()}`;
          };
          const incomingTables = snapshot.nodes.filter((n) => n.type === 'table' || n.type === 'semantic_view');
          const scopes = new Set(incomingTables.map(scopeKey));
          const connScopes = new Set(incomingTables.filter((n) => n.origin?.connectionId).map(connScope));
          const current = this.graphManager.serializeSnapshot();
          const replacedTables = new Set(current.nodes.filter((n) => (n.type === 'table' || n.type === 'semantic_view') && (scopes.has(scopeKey(n)) || connScopes.has(connScope(n)))).map((n) => n.id));
          const replaced = new Set(replacedTables);
          for (const e of current.edges) if (e.type === 'contains' && replacedTables.has(e.source)) replaced.add(e.target);
          const before = this.workingSetTableIds();
          const ids = new Set(snapshot.nodes.map((n) => n.id));
          await this.graphManager.removeNodesWhere((n) => ids.has(n.id) || replaced.has(n.id));
          // Phase K2: the same scope is replaced in the catalog; the extraction is
          // admitted there whole and into the working set as far as it fits.
          const incoming = new Set(incomingTables.map((n) => n.id));
          this.catalog.removeWhere((e) => {
            const n = { ...e.table, origin: e.origin } as BaseNode;
            return !incoming.has(e.id) && (scopes.has(scopeKey(n)) || connScopes.has(connScope(n)));
          });
          await this.admitObjects(snapshot.nodes, snapshot.edges, before);
          for (const [from, to] of re.aliases) this.pendingAliases.set(from, to);
          this.log(`Loaded schema graph with ${snapshot.nodes.length} nodes and ${snapshot.edges.length} edges (newer than the compiled cache)`);
        }
      } catch (err) {
        this.log(`Failed to load schema-graph.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Authoritative layer (`.autode/knowledge/business-context.yaml`, `verified-queries.yaml`),
    // re-read every time: what came from these files before is dropped first, so an
    // edited or removed entry is superseded or retracted in the ledger, not kept. ──
    await this.graphManager.removeNodesWhere((n) =>
      (n.type === 'business_term' || n.type === 'business_rule' || n.type === 'verified_query') &&
      (!n.origin || n.origin.extractor === 'business-context' || n.origin.extractor === 'verified-queries'));

    const bizCtxPath = this.firstExisting([layoutPath(this.root, 'businessContext')]);
    if (bizCtxPath) {
      try {
        const content = fs.readFileSync(bizCtxPath, 'utf8');
        const parsed = parseYaml(content) as BusinessContextFile;
        this.validateDoc('business-context.yaml', parsed);
        await this.loadBusinessContext(parsed, toPosix(path.relative(contextPath, bizCtxPath)));
        this.log(`Loaded business context from ${path.relative(contextPath, bizCtxPath)}`);
      } catch (err) {
        this.log(`Failed to parse business-context.yaml: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Load verified-queries.yaml
    const queriesPath = this.firstExisting([layoutPath(this.root, 'verifiedQueries')]);
    if (queriesPath) {
      try {
        const content = fs.readFileSync(queriesPath, 'utf8');
        const parsed = parseYaml(content) as VerifiedQueriesFile;
        this.validateDoc('verified-queries.yaml', parsed);
        await this.loadVerifiedQueries(parsed, toPosix(path.relative(contextPath, queriesPath)));
        this.log(`Loaded verified queries from ${path.relative(contextPath, queriesPath)}`);
      } catch (err) {
        this.log(`Failed to parse verified-queries.yaml: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Eviction (Phase K2), then record in the ledger, re-project, persist ──
    const evicted = await this.evictUnused();
    await this.persistCompiledGraph({ evicted });
  }

  /** Returns the first path that exists, or null. */
  private firstExisting(candidates: string[]): string | null {
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** Best-effort AJV envelope validation of an authoritative context document. */
  private validateDoc(label: string, data: unknown): void {
    if (!this.validator || !data || typeof data !== 'object') return;
    // Validate only envelope-shaped documents (authoritative `context/**` files).
    // Legacy list-of-entry formats (business_terms/queries) are normalized by the loaders.
    const candidates: unknown[] = Array.isArray(data)
      ? data.filter((x) => x && typeof x === 'object')
      : [data];
    for (const candidate of candidates) {
      const record = candidate as Record<string, unknown>;
      if (!record || typeof record.id !== 'string' || typeof record.kind !== 'string') continue;
      const result = this.validator.validateEnvelope(record);
      if (!result.valid) {
        this.log(`Context validation (${label}): ${result.errors.slice(0, 5).join('; ')}`);
      }
      if (result.warnings.length > 0) {
        this.log(`Context validation warning (${label}, ${String(record.kind)} content): ${result.warnings.slice(0, 5).join('; ')}`);
      }
    }
  }

  /**
   * Records the current in-memory graph in the assertion ledger, rebuilds the
   * graph from the ledger, and persists that projection to derived/graph.json
   * (atomic temp + rename) — no reload from disk first, so a caller that adds
   * nodes directly to the shared `GraphManager` (file ingestion, spec sync)
   * can save them.
   *
   * C2 (v0.29.0): this is the one place every producer's facts reach the
   * ledger — live discovery and Source Assessment (via the reindex that
   * follows `schema-graph.json`), file ingestion (`ingestFileIntoGraph`),
   * spec sync and the business-context files. New nodes are asserted, changed
   * ones superseded, vanished ones rejected with a reason; conflicts are
   * detected and their active sides flagged for review. A ledger failure is
   * logged and the graph is still persisted as it stands.
   */
  public async persistCompiledGraph(options: { evicted?: ReadonlySet<string> } = {}): Promise<void> {
    try {
      await this.rekeyLiveGraph();
      const aliases = new Map(this.pendingAliases);
      if (aliases.size > 0) await this.ledger.append(this.ledger.buildAliasEvents(aliases));
      const sync = await syncGraphToLedger(this.ledger, this.graphManager.serializeSnapshot(), { activeSpecId: this.activeSpecId, aliases, evicted: options.evicted });
      this.pendingAliases.clear();
      this.graphManager.setAliases(this.ledger.aliases());
      this.saveEstateIfChanged();
      this.conflicts = detectConflicts(this.ledger.assertions());
      const flagged = await flagConflicts(this.ledger, this.conflicts);
      if (sync.events > 0 || flagged.length > 0) {
        this.log(`Context ledger: ${sync.rekeyed ? `${sync.rekeyed} re-keyed, ` : ''}${sync.asserted} asserted, ${sync.superseded} superseded, ${sync.retracted} retracted, ${sync.reverified} re-verified, ${sync.dependentsFlagged + flagged.length} flagged for review; ${this.conflicts.length} conflict(s).`);
      }
      await this.graphManager.loadSnapshot(projectGraph(this.ledger.assertions(), { activeSpecId: this.activeSpecId }));
    } catch (err) {
      this.log(`Context ledger update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await this.syncCatalog();
    } catch (err) {
      this.log(`Catalog update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const derivedDir = layoutPath(this.root, 'derived');
      fs.mkdirSync(derivedDir, { recursive: true });
      const snapshot = this.graphManager.serializeSnapshot();
      writeGraphSnapshot(layoutPath(this.root, 'graph'), {
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        compiledAt: snapshot.generatedAt
      });
      this.log(`Compiled graph persisted to derived/graph.json (${snapshot.nodes.length} nodes)`);
    } catch (err) {
      this.log(`Failed to persist derived/graph.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async loadBusinessContext(data: BusinessContextFile, sourceRef: string): Promise<void> {
    const usedIds = new Set<string>();
    const origin = { source: 'user' as const, sourceRef, extractor: 'business-context' };

    if (data.business_terms) {
      for (const entry of data.business_terms) {
        // Keyed by the term's name (v0.29.0; was its position in the file), so
        // reordering the file changes nothing and redefining a term supersedes it.
        const nodeId = uniqueId(termId(entry.term), usedIds);
        const node: BusinessTermNode = {
          id: nodeId,
          type: 'business_term',
          label: entry.term,
          description: entry.description,
          formula: entry.formula,
          mappedNodeIds: entry.mapped_tables || [],
          metadata: {},
          version: 1,
          origin
        };
        await this.graphManager.addNode(node);

        // Create edges to mapped tables
        for (const tableRef of entry.mapped_tables || []) {
          const byFqn = this.graphManager.findByFqn(tableRef);
          const byLabel = this.graphManager.findByLabel(tableRef);
          const tableNodes: BaseNode[] = [];
          if (byFqn) tableNodes.push(byFqn);
          for (const n of byLabel) tableNodes.push(n);
          for (const tn of tableNodes) {
            const edge: GraphEdge = {
              id: edgeId('maps_to', nodeId, tn.id),
              source: nodeId,
              target: tn.id,
              type: 'maps_to',
              weight: 0.8
            };
            await this.graphManager.addEdge(edge);
          }
        }
      }
    }

    if (data.business_rules) {
      for (const entry of data.business_rules) {
        const nodeId = uniqueId(ruleId(entry.rule), usedIds);
        const node: BusinessRuleNode = {
          id: nodeId,
          type: 'business_rule',
          label: entry.rule.substring(0, 80),
          ruleText: entry.rule,
          enforcementLevel: entry.enforcement || 'RECOMMENDED',
          metadata: {},
          version: 1,
          origin
        };
        await this.graphManager.addNode(node);

        // Create edges to tables the rule applies to
        for (const tableRef of entry.applies_to || []) {
          const byFqn = this.graphManager.findByFqn(tableRef);
          const byLabel = this.graphManager.findByLabel(tableRef);
          const tableNodes: BaseNode[] = [];
          if (byFqn) tableNodes.push(byFqn);
          for (const n of byLabel) tableNodes.push(n);
          for (const tn of tableNodes) {
            const edge: GraphEdge = {
              id: edgeId('constrained_by', nodeId, tn.id),
              source: nodeId,
              target: tn.id,
              type: 'constrained_by',
              weight: 1.0
            };
            await this.graphManager.addEdge(edge);
          }
        }
      }
    }
  }

  private async loadVerifiedQueries(data: VerifiedQueriesFile, sourceRef: string): Promise<void> {
    const usedIds = new Set<string>();

    if (data.queries) {
      for (const entry of data.queries) {
        const nodeId = uniqueId(queryId(entry.name), usedIds);
        const node: VerifiedQueryNode = {
          id: nodeId,
          type: 'verified_query',
          label: entry.name,
          description: `Verified SQL query: ${entry.name}`,
          sql: entry.sql,
          dialect: (entry.dialect as VerifiedQueryNode['dialect']) || 'ansi',
          tablesUsed: entry.tables_used || [],
          author: entry.author,
          metadata: {},
          version: 1,
          origin: { source: 'user', sourceRef, extractor: 'verified-queries' }
        };
        await this.graphManager.addNode(node);

        // Create edges to tables used
        for (const tableRef of entry.tables_used || []) {
          const byFqn = this.graphManager.findByFqn(tableRef);
          const byLabel = this.graphManager.findByLabel(tableRef);
          const tableNodes: BaseNode[] = [];
          if (byFqn) tableNodes.push(byFqn);
          for (const n of byLabel) tableNodes.push(n);
          for (const tn of tableNodes) {
            const edge: GraphEdge = {
              id: edgeId('uses_table', nodeId, tn.id),
              source: nodeId,
              target: tn.id,
              type: 'uses_table',
              weight: 0.7
            };
            await this.graphManager.addEdge(edge);
          }
        }
      }
    }
  }

  /**
   * Get all mentionable entities for @-mention autocomplete.
   */
  public getMentionableEntities(): Array<{ icon: string; label: string; type: string; detail: string }> {
    const entities: Array<{ icon: string; label: string; type: string; detail: string }> = [];

    const tables = this.graphManager.getNodesByType('table');
    for (const t of tables) {
      const tableNode = t as import('./types').TableNode;
      entities.push({
        icon: '📦',
        label: tableNode.label,
        type: 'table',
        detail: tableNode.fqn || `${tableNode.database}.${tableNode.schema}.${tableNode.label}`
      });
    }

    // Phase K2: tables in the catalog but outside the working set can be mentioned too.
    const inGraph = new Set(tables.map((t) => t.id));
    for (const e of this.catalog.all()) {
      if (inGraph.has(e.id)) continue;
      entities.push({ icon: '📦', label: e.table.label, type: 'table', detail: `${e.table.fqn} (catalog)` });
    }

    const terms = this.graphManager.getNodesByType('business_term');
    for (const t of terms) {
      entities.push({
        icon: '🏷',
        label: t.label,
        type: 'business_term',
        detail: t.description || 'Business term'
      });
    }

    const queries = this.graphManager.getNodesByType('verified_query');
    for (const q of queries) {
      entities.push({
        icon: '✅',
        label: q.label,
        type: 'verified_query',
        detail: q.description || 'Verified SQL query'
      });
    }

    const rules = this.graphManager.getNodesByType('business_rule');
    for (const r of rules) {
      const ruleNode = r as import('./types').BusinessRuleNode;
      entities.push({
        icon: '📏',
        label: r.label,
        type: 'business_rule',
        detail: ruleNode.enforcementLevel
      });
    }

    return entities;
  }

  /**
   * Get context statistics for the context drawer.
   */
  public getContextStats(): {
    tables: number;
    terms: number;
    queries: number;
    rules: number;
    columns: number;
    tokens: number;
    maxTokens: number;
    sourceEnvironmentNodes: number;
  } {
    const diag = this.graphManager.getDiagnostics();
    const allTyped = ['table', 'column', 'semantic_view', 'business_term', 'business_rule', 'verified_query', 'metric'] as const;
    const sourceEnvironmentNodes = allTyped.reduce(
      (count, type) => count + this.graphManager.getNodesByType(type).filter((n) => n.origin?.environment === 'source').length,
      0
    );
    return {
      tables: this.graphManager.getNodesByType('table').length,
      terms: this.graphManager.getNodesByType('business_term').length,
      queries: this.graphManager.getNodesByType('verified_query').length,
      rules: this.graphManager.getNodesByType('business_rule').length,
      columns: this.graphManager.getNodesByType('column').length,
      tokens: diag.totalNodes * 50, // rough estimate: ~50 tokens per node
      maxTokens: 4000,
      /** Nodes tagged `origin.environment === 'source'` — introspected schema + registered source-side context (§8.8 / §16.3a). */
      sourceEnvironmentNodes
    };
  }

  /** What packs are built from: the projected graph, the ledger and the current conflicts. */
  public getPackSources(): ContextPackSources {
    const snapshot = this.graphManager.serializeSnapshot();
    return {
      graph: { nodes: snapshot.nodes, edges: snapshot.edges },
      assertions: this.ledger.assertions(),
      conflicts: this.conflicts,
      runtimeFacts: [...this.runtimeFacts.values()],
      catalogRevisions: mergeWatermarks(catalogWatermarks(snapshot.nodes), this.catalog.watermarks()),
      catalog: this.catalog
    };
  }

  /**
   * A task-scoped context pack (C3, v0.30.0; docs/context-layer-requirements.md
   * §7.1) — what every LLM call should receive instead of the global dump.
   * Recorded for "What the agent saw" when `title` is given.
   */
  public buildContextPack(request: ContextPackRequest, title?: string): ContextPack {
    const pack = buildContextPack(request, this.getPackSources());
    if (title) this.recordPack(title, pack);
    // Phase K2: what a pack used stays in the working set; what it rendered from the catalog enters it.
    this.catalog.touch([...pack.manifest.seeds, ...pack.manifest.nodeIds]);
    const promoted = pack.manifest.promoted ?? [];
    if (promoted.length > 0) {
      this.promotions = this.promotions.then(() => this.promote(promoted).then(() => undefined)).catch((err) => this.log(`Working-set promotion failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return pack;
  }

  /** Remembers a pack built elsewhere (e.g. a plan step's, built by the hub). */
  public recordPack(title: string, pack: ContextPack): void {
    this.recentPacks.unshift({ title, at: new Date().toISOString(), pack });
    if (this.recentPacks.length > 50) this.recentPacks.length = 50;
  }

  public getRecentPacks(): ReadonlyArray<{ title: string; at: string; pack: ContextPack }> {
    return this.recentPacks;
  }

  /**
   * The project overview: a pack with no seeds, which renders exactly what
   * this method produced before C3. Kept as a thin wrapper so callers that
   * have nothing to scope by keep working; callers with a task use
   * `buildContextPack()`.
   */
  public buildContextPrompt(maxTokens?: number): string {
    return this.buildContextPack({ purpose: 'chat', maxTokens }).text;
  }
}

/** Latest watermark per key across two maps (`unknown` loses to any timestamp). */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  used.add(id);
  return id;
}
