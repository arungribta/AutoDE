import * as vscode from 'vscode';
import { GraphManager } from './GraphManager';
import { RegisteredSource } from './SourceRegistry';
import { BusinessProblemSpec } from '../core/types';
import {
  BaseNode,
  BusinessTermNode,
  BusinessRuleNode,
  VerifiedQueryNode,
  GraphEdge,
  Origin
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

  /**
   * Ingests the approved Business Problem Specification itself as a context
   * source — objectives, business requirements and dependencies become
   * `business_term` nodes; constraints and assumptions become `business_rule`
   * nodes (STRICT / RECOMMENDED respectively) — each stamped with `Origin.specId`
   * / `specVersion` so it's traceable to the exact spec revision it came from.
   *
   * Re-synthesizing (e.g. on a later spec version) first removes every node
   * this method previously derived from this same spec id, so the graph always
   * reflects the *current* approved spec rather than accumulating stale
   * fields from earlier revisions.
   */
  public async synthesizeFromSpec(spec: BusinessProblemSpec): Promise<{ nodes: number; edges: number }> {
    const sourceRef = `spec:${spec.id}`;
    await this.graphManager.removeNodesBySourceRef(sourceRef);

    const now = new Date().toISOString();
    const origin = (extractor: string): Origin => ({
      source: 'derived',
      sourceRef,
      extractor,
      extractedAt: now,
      specId: spec.id,
      specVersion: spec.version
    });

    let nodes = 0;

    const addTerm = async (idSuffix: string, text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const node: BusinessTermNode = {
        id: `spec-term-${spec.id}-${idSuffix}`,
        type: 'business_term',
        label: trimmed.slice(0, 80),
        description: trimmed,
        metadata: {},
        version: spec.version,
        layer: 'domain',
        status: 'active',
        origin: origin('spec-sync'),
        createdAt: now,
        updatedAt: now,
        updatedBy: 'autode',
        mappedNodeIds: []
      };
      await this.graphManager.addNode(node);
      nodes++;
    };

    const addRule = async (idSuffix: string, ruleText: string, enforcementLevel: 'STRICT' | 'RECOMMENDED'): Promise<void> => {
      const trimmed = ruleText.trim();
      if (!trimmed) return;
      const node: BusinessRuleNode = {
        id: `spec-rule-${spec.id}-${idSuffix}`,
        type: 'business_rule',
        label: trimmed.slice(0, 80),
        ruleText: trimmed,
        enforcementLevel,
        metadata: {},
        version: spec.version,
        layer: 'domain',
        status: 'active',
        origin: origin('spec-sync'),
        createdAt: now,
        updatedAt: now,
        updatedBy: 'autode'
      };
      await this.graphManager.addNode(node);
      nodes++;
    };

    for (let i = 0; i < spec.objectives.length; i++) { await addTerm(`objective-${i}`, spec.objectives[i]); }
    for (let i = 0; i < (spec.businessRequirements ?? []).length; i++) { await addTerm(`requirement-${i}`, spec.businessRequirements![i]); }
    for (let i = 0; i < (spec.dependencies ?? []).length; i++) { await addTerm(`dependency-${i}`, spec.dependencies![i]); }
    for (let i = 0; i < spec.constraints.length; i++) { await addRule(`constraint-${i}`, spec.constraints[i], 'STRICT'); }
    for (let i = 0; i < spec.assumptions.length; i++) { await addRule(`assumption-${i}`, spec.assumptions[i], 'RECOMMENDED'); }

    this.log(`Context sync: ${nodes} node(s) derived from approved specification v${spec.version}.`);
    return { nodes, edges: 0 };
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
        origin: { source: 'derived', sourceRef: source.path, extractor: 'synthesis-pipeline', extractedAt: now, environment: 'source' },
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
        origin: { source: 'derived', sourceRef: source.path, extractor: 'synthesis-pipeline', extractedAt: now, environment: 'source' },
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
        origin: { source: 'derived', sourceRef: source.path, extractor: 'synthesis-pipeline', extractedAt: now, environment: 'source' },
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
