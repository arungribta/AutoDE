import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GraphManager } from './GraphManager';
import { parseYaml } from '../engine/context/Yaml';
import { readGraphSnapshot, writeGraphSnapshot } from './GraphPersistence';
import { ContextValidator } from '../engine/context/ContextValidator';
import { AssertionLedger } from '../engine/context/ledger';
import { projectGraph, syncGraphToLedger } from '../engine/context/projection';
import { Conflict, detectConflicts, flagConflicts } from '../engine/context/conflicts';
import { ContextPack, ContextPackRequest, ContextPackSources, buildContextPack } from '../engine/context/contextPack';
import {
  BaseNode,
  BusinessTermNode,
  BusinessRuleNode,
  VerifiedQueryNode,
  GraphEdge,
  NodeType
} from '../engine/context/types';

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

export class ContextFileManager implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | null = null;
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

  constructor(
    private readonly workspaceRoot: vscode.Uri,
    private readonly graphManager: GraphManager,
    private readonly log: (msg: string) => void,
    private readonly validator?: ContextValidator
  ) {
    this.ledger = new AssertionLedger(path.join(vscode.Uri.joinPath(workspaceRoot, '.ai-context').fsPath, 'ledger'));
  }

  /**
   * Sets which business problem's spec-derived assertions are in scope. Call
   * before synthesizing a spec into the graph; switching problems leaves the
   * previous problem's assertions live in the ledger, just not projected.
   */
  public setActiveSpecId(specId: string | undefined): void {
    this.activeSpecId = specId;
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
   * `null` to clear). Never written to `.ai-context/` — this is for live facts
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
    const contextDir = vscode.Uri.joinPath(this.workspaceRoot, '.ai-context');
    const contextPath = contextDir.fsPath;

    // Ensure .ai-context directory exists
    try {
      await vscode.workspace.fs.createDirectory(contextDir);
    } catch {
      // Directory may already exist
    }

    // Set up file watcher
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceRoot, '.ai-context/*.{yaml,yml,json}')
    );

    this.watcher.onDidChange(() => this.debouncedReindex());
    this.watcher.onDidCreate(() => this.debouncedReindex());
    this.watcher.onDidDelete(() => this.debouncedReindex());

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
    const contextDir = vscode.Uri.joinPath(this.workspaceRoot, '.ai-context');
    const contextPath = contextDir.fsPath;
    const authoritativeDir = path.join(contextPath, 'context');

    // ── Base graph (C2, v0.29.0): the projection of the assertion ledger, the
    // system of record. A workspace with no ledger yet starts from the compiled
    // `derived/graph.json` instead, which the persist below then migrates into
    // the ledger. ──
    this.graphManager.clear();
    const graphPath = path.join(contextPath, 'derived', 'graph.json');
    const legacySchemaPath = path.join(contextPath, 'schema-graph.json');
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
        const snapshot = JSON.parse(fs.readFileSync(legacySchemaPath, 'utf8')) as { nodes?: BaseNode[]; edges?: GraphEdge[] };
        if (snapshot.nodes && snapshot.edges) {
          const refs = new Set(snapshot.nodes.map((n) => n.origin?.sourceRef).filter((r): r is string => !!r));
          const ids = new Set(snapshot.nodes.map((n) => n.id));
          await this.graphManager.removeNodesWhere((n) => ids.has(n.id) || (!!n.origin?.sourceRef && refs.has(n.origin.sourceRef)));
          for (const n of snapshot.nodes) await this.graphManager.addNode(n);
          for (const e of snapshot.edges) await this.graphManager.addEdge(e);
          this.log(`Loaded schema graph with ${snapshot.nodes.length} nodes and ${snapshot.edges.length} edges (newer than the compiled cache)`);
        }
      } catch (err) {
        this.log(`Failed to load schema-graph.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Authoritative layer (`context/**` first, then legacy `.ai-context/` root),
    // re-read every time: what came from these files before is dropped first, so an
    // edited or removed entry is superseded or retracted in the ledger, not kept. ──
    await this.graphManager.removeNodesWhere((n) =>
      (n.type === 'business_term' || n.type === 'business_rule' || n.type === 'verified_query') &&
      (!n.origin || n.origin.extractor === 'business-context' || n.origin.extractor === 'verified-queries'));

    const bizCtxPath = this.firstExisting([
      path.join(authoritativeDir, 'business-context.yaml'),
      path.join(contextPath, 'business-context.yaml')
    ]);
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
    const queriesPath = this.firstExisting([
      path.join(authoritativeDir, 'verified-queries.yaml'),
      path.join(contextPath, 'verified-queries.yaml')
    ]);
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

    // ── Record in the ledger, re-project, persist ──
    await this.persistCompiledGraph();
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
  public async persistCompiledGraph(): Promise<void> {
    try {
      const sync = await syncGraphToLedger(this.ledger, this.graphManager.serializeSnapshot(), { activeSpecId: this.activeSpecId });
      this.conflicts = detectConflicts(this.ledger.assertions());
      const flagged = await flagConflicts(this.ledger, this.conflicts);
      if (sync.events > 0 || flagged.length > 0) {
        this.log(`Context ledger: ${sync.asserted} asserted, ${sync.superseded} superseded, ${sync.retracted} retracted, ${sync.reverified} re-verified, ${sync.dependentsFlagged + flagged.length} flagged for review; ${this.conflicts.length} conflict(s).`);
      }
      await this.graphManager.loadSnapshot(projectGraph(this.ledger.assertions(), { activeSpecId: this.activeSpecId }));
    } catch (err) {
      this.log(`Context ledger update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const contextPath = vscode.Uri.joinPath(this.workspaceRoot, '.ai-context').fsPath;
      const derivedDir = path.join(contextPath, 'derived');
      fs.mkdirSync(derivedDir, { recursive: true });
      const snapshot = this.graphManager.serializeSnapshot();
      writeGraphSnapshot(path.join(derivedDir, 'graph.json'), {
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
    let ruleIndex = 0;
    const usedIds = new Set<string>();
    const origin = { source: 'user' as const, sourceRef, extractor: 'business-context' };

    if (data.business_terms) {
      for (const entry of data.business_terms) {
        // Keyed by the term's name (v0.29.0; was its position in the file), so
        // reordering the file changes nothing and redefining a term supersedes it.
        const nodeId = uniqueId(`biz-term-${slugify(entry.term)}`, usedIds);
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
              id: `edge-maps-${nodeId}-${tn.id}`,
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
        const nodeId = `biz-rule-${++ruleIndex}`;
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
              id: `edge-constrained-${nodeId}-${tn.id}`,
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
        const nodeId = uniqueId(`verified-query-${slugify(entry.name)}`, usedIds);
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
              id: `edge-uses-${nodeId}-${tn.id}`,
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
      const tableNode = t as import('../engine/context/types').TableNode;
      entities.push({
        icon: '📦',
        label: tableNode.label,
        type: 'table',
        detail: tableNode.fqn || `${tableNode.database}.${tableNode.schema}.${tableNode.label}`
      });
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
      const ruleNode = r as import('../engine/context/types').BusinessRuleNode;
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
      runtimeFacts: [...this.runtimeFacts.values()]
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

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function slugify(text: string): string {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  used.add(id);
  return id;
}
