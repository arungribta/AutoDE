import * as vscode from 'vscode';

export type NodeType = 'table' | 'column' | 'semantic_view' | 'business_term' | 'business_rule' | 'verified_query';
export type EdgeType = 'contains' | 'foreign_key' | 'maps_to' | 'uses_table' | 'constrained_by';

export interface BaseNode {
  readonly id: string;
  readonly type: NodeType;
  readonly label: string;
  readonly description?: string;
  readonly metadata: Record<string, unknown>;
  readonly version: number;
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
