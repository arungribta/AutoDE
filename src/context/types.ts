import * as vscode from 'vscode';

export type NodeType = 'table' | 'column' | 'semantic_view' | 'business_term' | 'business_rule' | 'verified_query' | 'metric';
export type EdgeType = 'contains' | 'foreign_key' | 'maps_to' | 'uses_table' | 'constrained_by' | 'derives_from' | 'related_to';
export type ContextLayer = 'industry' | 'enterprise' | 'domain' | 'system' | 'definition' | 'query' | 'artifact';
export type NodeStatus = 'active' | 'draft' | 'deprecated';
export type OriginSource = 'user' | 'derived' | 'system' | 'llm' | 'template';

/**
 * Provenance / traceability metadata attached to every derived object.
 * Tracks where the object came from and how it was produced.
 */
export interface Origin {
  source: OriginSource;
  sourceRef: string;
  confidence?: number;
  extractor?: string;
  extractedAt?: string;
}

export interface BaseNode {
  readonly id: string;
  readonly type: NodeType;
  readonly label: string;
  readonly description?: string;
  readonly metadata: Record<string, unknown>;
  readonly version: number;
  // Unified envelope (see docs/requirements.md §3.4)
  readonly layer?: ContextLayer;
  readonly status?: NodeStatus;
  readonly aliases?: string[];
  readonly tags?: string[];
  readonly origin?: Origin;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly updatedBy?: string;
}

export interface TableNode extends BaseNode {
  readonly type: 'table' | 'semantic_view';
  readonly database: string;
  readonly schema: string;
  readonly fqn: string; // Fully Qualified Name: db.schema.table
  readonly isView: boolean;
}

export interface ColumnNode extends BaseNode {
  readonly type: 'column';
  readonly dataType: string;
  readonly isNullable: boolean;
  readonly isPrimaryKey: boolean;
  readonly isForeignKey: boolean;
}

export interface BusinessTermNode extends BaseNode {
  readonly type: 'business_term';
  readonly formula?: string;
  readonly mappedNodeIds: readonly string[];
}

export interface BusinessRuleNode extends BaseNode {
  readonly type: 'business_rule';
  readonly ruleText: string;
  readonly enforcementLevel: 'STRICT' | 'RECOMMENDED';
}

export interface VerifiedQueryNode extends BaseNode {
  readonly type: 'verified_query';
  readonly sql: string;
  readonly dialect: 'snowflake' | 'databricks' | 'bigquery' | 'postgres' | 'ansi';
  readonly tablesUsed: readonly string[];
  readonly author?: string;
}

export interface GraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly type: EdgeType;
  readonly weight?: number;
  readonly origin?: Origin;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface RetrievalOptions {
  readonly topKSeeds?: number;
  readonly maxHops?: number;
  readonly maxTokens?: number;
  readonly minScoreThreshold?: number;
  readonly includeVerifiedQueries?: boolean;
}

export interface SubgraphResult {
  readonly nodes: readonly BaseNode[];
  readonly edges: readonly GraphEdge[];
  readonly formattedContext: string;
  readonly tokenCount: number;
  readonly latencyMs: number;
}

export interface ContextEngineDiagnostics {
  readonly totalNodes: number;
  readonly totalEdges: number;
  readonly memoryUsageMB: number;
  readonly isWorkerReady: boolean;
  readonly lastIndexedAt: Date | null;
}

export interface IDisposable extends vscode.Disposable {}
