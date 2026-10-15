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
  specId?: string;
  specVersion?: number;
  /**
   * Which side of a Brownfield implementation this node describes — `source`
   * for facts about an existing system (schema, registered business context,
   * data contracts), `target` for the platform being built. Undefined means
   * the node isn't environment-specific (e.g. spec-derived objectives/
   * constraints, which apply regardless of source/target). Kept on `Origin`
   * rather than a new node field so it travels with provenance, not identity.
   */
  environment?: 'source' | 'target';
  /**
   * Which specific connection/platform instance this node came from — distinct
   * from `sourceRef` (which today is just the bare kind, e.g. `'snowflake'`, or
   * a file path). Undefined for anything not tied to a specific connection
   * (spec-derived facts, business-context.yaml entries). Required going forward
   * for anything environment-tagged `'source'`, once more than one source
   * connection can exist side by side — without it, two connections of the same
   * platform type (or two tables both named the same across different sources)
   * are indistinguishable. See the Source & Target Context Architecture plan.
   */
  connectionId?: string;
  /**
   * Explicit reliability tag — Step 7 of the Source & Target Context
   * Architecture plan (governance layer, reusing the Phase 4 skill-governance
   * 3-layer model: provenance capture, review before low-confidence content
   * drives generation, explicit re-verify). `'live-verified'` means this node
   * came from introspecting a real, currently-reachable system just now;
   * `'best-effort-inferred'` covers everything else (file-derived, LLM-
   * derived, user-typed descriptions) — a real distinction the review flagged
   * as missing (`confidence` existed but was never actually set anywhere).
   * Undefined means pre-dates this field (legacy/spec-derived nodes) — never
   * treated as a red flag, just unknown.
   */
  reliability?: 'live-verified' | 'best-effort-inferred';
  /**
   * When this node's content was last confirmed against its real source,
   * distinct from `extractedAt` (when it was first captured) — closes the
   * "silent staleness" gap the review flagged: nothing today re-validates
   * captured context after the fact, so an unnoticed drift in the real
   * source becomes a correctness risk once specs/code are generated off it.
   */
  lastVerifiedAt?: string;
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
  /** Ids of the ledger assertions this node is projected from (C2, v0.29.0). Set by the projection, never by producers. */
  readonly supportedBy?: string[];
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
  /** Ids of the ledger assertions this edge is projected from (C2, v0.29.0). */
  readonly supportedBy?: string[];
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

