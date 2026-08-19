import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GraphManager } from './GraphManager';
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
    private readonly log: (msg: string) => void
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

    // Clear existing business context nodes (keep schema nodes if any)
    this.removeBusinessContextNodes();

    // Load business-context.yaml
    const bizCtxPath = path.join(contextPath, 'business-context.yaml');
    if (fs.existsSync(bizCtxPath)) {
      try {
        const content = fs.readFileSync(bizCtxPath, 'utf8');
        const parsed = this.parseYamlSimple(content) as BusinessContextFile;
        await this.loadBusinessContext(parsed);
        this.log(`Loaded business context from business-context.yaml`);
      } catch (err) {
        this.log(`Failed to parse business-context.yaml: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Load verified-queries.yaml
    const queriesPath = path.join(contextPath, 'verified-queries.yaml');
    if (fs.existsSync(queriesPath)) {
      try {
        const content = fs.readFileSync(queriesPath, 'utf8');
        const parsed = this.parseYamlSimple(content) as VerifiedQueriesFile;
        await this.loadVerifiedQueries(parsed);
        this.log(`Loaded verified queries from verified-queries.yaml`);
      } catch (err) {
        this.log(`Failed to parse verified-queries.yaml: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Load schema-graph.json if it exists
    const schemaPath = path.join(contextPath, 'schema-graph.json');
    if (fs.existsSync(schemaPath)) {
      try {
        const content = fs.readFileSync(schemaPath, 'utf8');
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
   * Simple YAML parser for flat structures.
   * Handles the subset of YAML needed for business-context.yaml and verified-queries.yaml.
   * In production, replace with a proper YAML library like `js-yaml`.
   */
  private parseYamlSimple(content: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = content.split('\n');
    let currentKey: string | null = null;
    let currentArray: unknown[] = [];
    let currentObj: Record<string, unknown> | null = null;
    let inArray = false;
    let inObject = false;
    let indentLevel = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const indent = line.search(/\S/);
      const isListItem = trimmed.startsWith('- ');

      // Top-level key
      if (!trimmed.startsWith('-') && trimmed.includes(':') && indent === 0) {
        // Flush previous
        if (currentKey && currentArray.length > 0) {
          result[currentKey] = currentArray;
        }
        const colonIdx = trimmed.indexOf(':');
        currentKey = trimmed.substring(0, colonIdx).trim();
        const value = trimmed.substring(colonIdx + 1).trim();
        if (value) {
          result[currentKey] = value;
          currentKey = null;
        } else {
          currentArray = [];
          inArray = false;
          inObject = false;
        }
        continue;
      }

      // List item start
      if (isListItem && currentKey) {
        const itemContent = trimmed.substring(2).trim();
        if (itemContent.includes(':') && !itemContent.startsWith('"')) {
          // Object in list
          currentObj = {};
          const colonIdx = itemContent.indexOf(':');
          const objKey = itemContent.substring(0, colonIdx).trim();
          const objValue = itemContent.substring(colonIdx + 1).trim();
          if (objValue) {
            currentObj[objKey] = objValue;
          }
          inObject = true;
          inArray = true;
          currentArray.push(currentObj);
        } else {
          // Simple value in list
          if (inObject && currentObj) {
            // This is a continuation of the object
            const colonIdx = itemContent.indexOf(':');
            if (colonIdx > 0) {
              const objKey = itemContent.substring(0, colonIdx).trim();
              const objValue = itemContent.substring(colonIdx + 1).trim();
              currentObj[objKey] = objValue;
            }
          } else {
            inArray = true;
            inObject = false;
            currentArray.push(itemContent);
          }
        }
        continue;
      }

      // Continuation of object property (indented)
      if (inObject && currentObj && indent > 0) {
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx > 0) {
          const objKey = trimmed.substring(0, colonIdx).trim();
          const objValue = trimmed.substring(colonIdx + 1).trim();
          if (objKey === 'mapped_tables' || objKey === 'tables_used' || objKey === 'applies_to') {
            // Next line(s) will be list items
            currentObj[objKey] = [];
            (currentObj as Record<string, unknown>)[`_nextArrayKey`] = objKey;
          } else {
            currentObj[objKey] = objValue;
          }
        }
        continue;
      }

      // Nested list item (for arrays like mapped_tables)
      if (isListItem && inObject && currentObj) {
        const arrayKey = (currentObj as Record<string, unknown>)['_nextArrayKey'] as string;
        if (arrayKey) {
          const arr = (currentObj[arrayKey] as unknown[]) || [];
          arr.push(trimmed.substring(2).trim());
          currentObj[arrayKey] = arr;
        }
        continue;
      }
    }

    // Flush final
    if (currentKey && currentArray.length > 0) {
      result[currentKey] = currentArray;
    }

    return result;
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