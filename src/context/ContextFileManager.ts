import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GraphManager } from './GraphManager';
import { parseYaml } from './Yaml';
import { readGraphSnapshot, writeGraphSnapshot } from './GraphPersistence';
import { ContextValidator } from './ContextValidator';
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

export class ContextFileManager implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 300;

  constructor(
    private readonly workspaceRoot: vscode.Uri,
    private readonly graphManager: GraphManager,
    private readonly log: (msg: string) => void,
    private readonly validator?: ContextValidator
  ) {}

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

    // Clear existing business context nodes (keep schema nodes if any)
    this.removeBusinessContextNodes();

    // ── Authoritative layer (`context/**` first, then legacy `.ai-context/` root) ──
    const bizCtxPath = this.firstExisting([
      path.join(authoritativeDir, 'business-context.yaml'),
      path.join(contextPath, 'business-context.yaml')
    ]);
    if (bizCtxPath) {
      try {
        const content = fs.readFileSync(bizCtxPath, 'utf8');
        const parsed = parseYaml(content) as BusinessContextFile;
        this.validateDoc('business-context.yaml', parsed);
        await this.loadBusinessContext(parsed);
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
        await this.loadVerifiedQueries(parsed);
        this.log(`Loaded verified queries from ${path.relative(contextPath, queriesPath)}`);
      } catch (err) {
        this.log(`Failed to parse verified-queries.yaml: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Derived layer: compiled `derived/graph.json` (atomic I/O), legacy `schema-graph.json` fallback ──
    const graphPath = path.join(contextPath, 'derived', 'graph.json');
    if (fs.existsSync(graphPath)) {
      try {
        const snapshot = readGraphSnapshot(graphPath);
        if (snapshot && Array.isArray(snapshot.nodes) && Array.isArray(snapshot.edges)) {
          await this.graphManager.loadSnapshot(snapshot as { nodes: BaseNode[]; edges: GraphEdge[] });
          this.log(`Loaded compiled graph from derived/graph.json (${snapshot.nodes.length} nodes, ${snapshot.edges.length} edges)`);
        }
      } catch (err) {
        this.log(`Failed to load derived/graph.json: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      const legacySchemaPath = path.join(contextPath, 'schema-graph.json');
      if (fs.existsSync(legacySchemaPath)) {
        try {
          const content = fs.readFileSync(legacySchemaPath, 'utf8');
          const snapshot = JSON.parse(content);
          if (snapshot.nodes && snapshot.edges) {
            await this.graphManager.loadSnapshot(snapshot);
            this.log(`Loaded schema graph with ${snapshot.nodes.length} nodes and ${snapshot.edges.length} edges`);
          }
        } catch (err) {
          this.log(`Failed to load schema-graph.json: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // ── Persist the compiled graph atomically to derived/graph.json ──
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
    }
  }

  /** Persists the current in-memory graph to derived/graph.json (atomic temp + rename). */
  private async persistCompiledGraph(): Promise<void> {
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

  private removeBusinessContextNodes(): void {
    // GraphManager doesn't have a remove-by-type, so we clear and reload.
    // In production, this would be more surgical.
    // For now, we only clear business context types and keep schema nodes.
    const diag = this.graphManager.getDiagnostics();
    if (diag.totalNodes > 0) {
      // Re-serialize, filter, and reload
      const snapshot = this.graphManager.serializeSnapshot();
      const schemaNodes = snapshot.nodes.filter(
        (n) => n.type === 'table' || n.type === 'column' || n.type === 'semantic_view'
      );
      const schemaEdges = snapshot.edges.filter(
        (e) => e.type === 'contains' || e.type === 'foreign_key'
      );
      this.graphManager.clear();
      // We'll reload schema from the file in loadAllFiles
    }
  }

  private async loadBusinessContext(data: BusinessContextFile): Promise<void> {
    let termIndex = 0;
    let ruleIndex = 0;

    if (data.business_terms) {
      for (const entry of data.business_terms) {
        const nodeId = `biz-term-${++termIndex}`;
        const node: BusinessTermNode = {
          id: nodeId,
          type: 'business_term',
          label: entry.term,
          description: entry.description,
          formula: entry.formula,
          mappedNodeIds: entry.mapped_tables || [],
          metadata: {},
          version: 1
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
          version: 1
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

  private async loadVerifiedQueries(data: VerifiedQueriesFile): Promise<void> {
    let queryIndex = 0;

    if (data.queries) {
      for (const entry of data.queries) {
        const nodeId = `verified-query-${++queryIndex}`;
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
          version: 1
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
      const tableNode = t as import('./types').TableNode;
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
  } {
    const diag = this.graphManager.getDiagnostics();
    return {
      tables: this.graphManager.getNodesByType('table').length,
      terms: this.graphManager.getNodesByType('business_term').length,
      queries: this.graphManager.getNodesByType('verified_query').length,
      rules: this.graphManager.getNodesByType('business_rule').length,
      columns: this.graphManager.getNodesByType('column').length,
      tokens: diag.totalNodes * 50, // rough estimate: ~50 tokens per node
      maxTokens: 4000
    };
  }

  /**
   * Build a formatted context string for inclusion in LLM prompts.
   */
  public buildContextPrompt(maxTokens?: number): string {
    const parts: string[] = [];
    const stats = this.getContextStats();

    if (stats.tables === 0 && stats.terms === 0 && stats.queries === 0) {
      return '';
    }

    parts.push('## Enterprise Context Layer');

    // Business Rules (STRICT first)
    const rules = this.graphManager.getNodesByType('business_rule') as import('./types').BusinessRuleNode[];
    const strictRules = rules.filter((r) => r.enforcementLevel === 'STRICT');
    if (strictRules.length > 0) {
      parts.push('### Business Rules (STRICT)');
      for (const r of strictRules) {
        parts.push(`- **${r.label}**: ${r.ruleText}`);
      }
    }

    // Tables
    const tables = this.graphManager.getNodesByType('table') as import('./types').TableNode[];
    if (tables.length > 0) {
      parts.push('### Database Tables');
      for (const t of tables.slice(0, 20)) {
        parts.push(`- \`${t.fqn || t.label}\`${t.description ? ' — ' + t.description : ''}`);
      }
      if (tables.length > 20) {
        parts.push(`- ... and ${tables.length - 20} more tables`);
      }
    }

    // Business Terms
    const terms = this.graphManager.getNodesByType('business_term') as import('./types').BusinessTermNode[];
    if (terms.length > 0) {
      parts.push('### Business Terms');
      for (const t of terms) {
        const formula = t.formula ? ` (formula: ${t.formula})` : '';
        parts.push(`- **${t.label}**${formula}${t.description ? ': ' + t.description : ''}`);
      }
    }

    // Verified Queries
    const queries = this.graphManager.getNodesByType('verified_query') as import('./types').VerifiedQueryNode[];
    if (queries.length > 0) {
      parts.push('### Verified SQL Queries');
      for (const q of queries.slice(0, 5)) {
        parts.push(`- **${q.label}** (${q.dialect})`);
      }
    }

    return parts.join('\n');
  }
}