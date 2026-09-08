import * as vscode from 'vscode';
import { GraphManager } from './GraphManager';
import { RegisteredSource } from './SourceRegistry';
import {
  BaseNode,
  BusinessTermNode,
  BusinessRuleNode,
  VerifiedQueryNode,
  GraphEdge
} from './types';

/**
 * Ingests registered source files and derives semantic nodes/edges (with
 * provenance) into the GraphManager. Extraction is rule-based for now;
 * LLM-assisted extraction is a planned enhancement.
 */
export class SynthesisPipeline {
  constructor(
    private readonly workspaceUri: vscode.Uri,
    private readonly graphManager: GraphManager,
    private readonly log: (msg: string) => void
  ) {}

  public async synthesize(sources: RegisteredSource[]): Promise<{ nodes: number; edges: number }> {
    let nodes = 0;
    let edges = 0;

    for (const source of sources) {
      const content = await this.readSource(source.path);
      if (content === null) {
        this.log(`Synthesis: skipped missing source "${source.path}"`);
        continue;
      }

      const result = this.extract(source, content);
      for (const node of result.nodes) {
        await this.graphManager.addNode(node);
        nodes++;
      }
      for (const edge of result.edges) {
        await this.graphManager.addEdge(edge);
        edges++;
      }
    }

    this.log(`Synthesis complete: ${nodes} node(s), ${edges} edge(s)`);
    return { nodes, edges };
  }

  private async readSource(relativePath: string): Promise<string | null> {
    const uri = vscode.Uri.joinPath(this.workspaceUri, relativePath);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return null;
    }
  }

  private extract(source: RegisteredSource, content: string): { nodes: BaseNode[]; edges: GraphEdge[] } {
    switch (source.kind) {
      case 'business_context':
        return this.extractBusinessContext(source, content);
      case 'verified_queries':
        return this.extractVerifiedQueries(source, content);
      case 'data_definitions':
        return this.extractDataDefinitions(source, content);
      default:
        return { nodes: [], edges: [] };
    }
  }

  private extractBusinessContext(source: RegisteredSource, content: string): { nodes: BaseNode[]; edges: GraphEdge[] } {
    const nodes: BaseNode[] = [];
    const now = new Date().toISOString();

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const bullet = trimmed.match(/^[-*]\s+(.+)$/);
      const text = bullet ? bullet[1].trim() : trimmed;

      const sep = text.indexOf(':');
      const term = sep > 0 ? text.slice(0, sep).trim() : text;
      const description = sep > 0 ? text.slice(sep + 1).trim() : '';
      if (!term) continue;

      const id = `term:${term.replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase()}`;
      const node: BusinessTermNode = {
        id,
        type: 'business_term',
        label: term,
        description: description || undefined,
        metadata: {},
        version: 1,
        layer: 'definition',
        status: 'active',
        origin: { source: 'derived', sourceRef: source.path, extractor: 'synthesis-pipeline', extractedAt: now },
        createdAt: now,
        updatedAt: now,
        updatedBy: 'autode',
        mappedNodeIds: []
      };
      nodes.push(node);
    }

    return { nodes, edges: [] };
  }

  private extractVerifiedQueries(source: RegisteredSource, content: string): { nodes: BaseNode[]; edges: GraphEdge[] } {
    const nodes: BaseNode[] = [];
    const now = new Date().toISOString();

    const blocks = content.match(/```(?:sql)?\s*([\s\S]*?)```/g) || [];
    for (let i = 0; i < blocks.length; i++) {
      const sql = blocks[i].replace(/```(?:sql)?\s*|```/g, '').trim();
      if (!sql) continue;
      const name = `query_${i + 1}`;
      const id = `query:${source.path.replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase()}_${name}`;
      const node: VerifiedQueryNode = {
        id,
        type: 'verified_query',
        label: name,
        description: `Verified query extracted from ${source.path}`,
        metadata: {},
        version: 1,
        layer: 'query',
        status: 'active',
        origin: { source: 'derived', sourceRef: source.path, extractor: 'synthesis-pipeline', extractedAt: now },
        createdAt: now,
        updatedAt: now,
        updatedBy: 'autode',
        sql,
        dialect: 'ansi',
        tablesUsed: []
      };
      nodes.push(node);
    }

    return { nodes, edges: [] };
  }

  private extractDataDefinitions(source: RegisteredSource, content: string): { nodes: BaseNode[]; edges: GraphEdge[] } {
    const nodes: BaseNode[] = [];
    const now = new Date().toISOString();

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const bullet = trimmed.match(/^[-*]\s+(.+)$/);
      const text = bullet ? bullet[1].trim() : trimmed;
      const sep = text.indexOf(':');
      if (sep <= 0) continue;

      const name = text.slice(0, sep).trim();
      const definition = text.slice(sep + 1).trim();
      if (!name || !definition) continue;

      const id = `rule:data_definition.${name.replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase()}`;
      const node: BusinessRuleNode = {
        id,
        type: 'business_rule',
        label: name,
        description: `Data definition: ${definition}`,
        metadata: {},
        version: 1,
        layer: 'system',
        status: 'active',
        origin: { source: 'derived', sourceRef: source.path, extractor: 'synthesis-pipeline', extractedAt: now },
        createdAt: now,
        updatedAt: now,
        updatedBy: 'autode',
        ruleText: definition,
        enforcementLevel: 'RECOMMENDED'
      };
      nodes.push(node);
    }

    return { nodes, edges: [] };
  }
}
