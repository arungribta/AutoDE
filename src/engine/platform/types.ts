import type { ObjectIdentity } from '../context/estate';
import { BaseNode, GraphEdge } from '../context/types';
import { DataPlatformProvider } from '../types';

// ── SQL Dialects ──
export type SqlDialect = 'snowflake' | 'spark_sql' | 'google_sql' | 'postgres' | 'tsql' | 'ansi';

// ── Platform Capabilities ──
export interface PlatformCapabilities {
  readonly supportsMetadataExtraction: boolean;
  readonly supportsQueryExecution: boolean;
  readonly supportsDdlGeneration: boolean;
  readonly supportsColumnProfiling: boolean;
  readonly supportsLineageExtraction: boolean;
  readonly supportsChangeDataCapture: boolean;
  readonly supportsStreaming: boolean;
  readonly maxQueryTimeoutMs: number;
  readonly supportedDialects: SqlDialect[];
}

// ── Connection ──
export interface ConnectionInfo {
  readonly connected: boolean;
  readonly platform: DataPlatformProvider;
  readonly databaseName: string;
  readonly schemaName: string;
  readonly version: string;
  readonly capabilities: PlatformCapabilities;
}

// ── Metadata Extraction ──
export interface ExtractOptions {
  readonly includeProfiling?: boolean;
  readonly schemaFilter?: string[];
  readonly signal?: AbortSignal;
}

export interface QueryOptions {
  readonly timeoutMs?: number;
  readonly maxRows?: number;
  readonly signal?: AbortSignal;
}

export interface QueryResult {
  readonly columns: string[];
  readonly rows: Array<Record<string, unknown>>;
  readonly rowCount: number;
  readonly executionTimeMs: number;
}

// ── Schema Snapshot ──
export interface SchemaSnapshot {
  readonly platform: DataPlatformProvider;
  /** Identifies the specific connection this snapshot came from (e.g. `snowflake:prod`), not just the platform kind — needed once more than one source connection can exist. See `BaseDataSourceAdapter.getConnectionId()`. */
  readonly connectionId?: string;
  readonly extractedAt: string;
  readonly tables: TableMetadata[];
  readonly views: ViewMetadata[];
  readonly foreignKeys: ForeignKeyMetadata[];
  readonly lineage?: LineageEdge[];
}

export interface TableMetadata {
  readonly catalog?: string;
  readonly schema: string;
  readonly name: string;
  readonly fqn: string;
  readonly type: 'TABLE' | 'VIEW' | 'EXTERNAL' | 'STREAM' | 'MATERIALIZED_VIEW';
  readonly rowCount?: number;
  readonly sizeBytes?: number;
  readonly columns: ColumnMetadata[];
  readonly comment?: string;
  readonly properties?: Record<string, unknown>;
}

export interface ViewMetadata {
  readonly catalog?: string;
  readonly schema: string;
  readonly name: string;
  readonly fqn: string;
  readonly definition: string;
  readonly comment?: string;
}

export interface ColumnMetadata {
  readonly name: string;
  readonly dataType: string;
  readonly isNullable: boolean;
  readonly isPrimaryKey: boolean;
  readonly isForeignKey: boolean;
  readonly ordinalPosition: number;
  readonly defaultValue?: string;
  readonly comment?: string;
  profile?: ColumnProfile;
}

export interface ColumnProfile {
  readonly distinctCount?: number;
  readonly nullCount?: number;
  readonly minValue?: string;
  readonly maxValue?: string;
  readonly avgLength?: number;
}

export interface ForeignKeyMetadata {
  readonly constraintName?: string;
  readonly sourceCatalog?: string;
  readonly sourceSchema: string;
  readonly sourceTable: string;
  readonly sourceColumn: string;
  readonly targetCatalog?: string;
  readonly targetSchema: string;
  readonly targetTable: string;
  readonly targetColumn: string;
}

export interface LineageEdge {
  readonly sourceFqn: string;
  readonly sourceColumn?: string;
  readonly targetFqn: string;
  readonly targetColumn?: string;
  readonly transformDescription?: string;
  readonly queryText?: string;
}

// ── Platform-Specific Metadata Queries ──
export interface PlatformMetadataQueries {
  readonly listTables: string;
  readonly listColumns: string;
  readonly listForeignKeys: string;
  readonly listViews: string;
  readonly profileColumn: (fqn: string, column: string) => string;
  readonly extractLineage?: string;
}

// ── Adapter Interface ──
/** Host-agnostic stand-in for `vscode.Disposable` (v0.26.0 engine boundary). */
export interface Disposable {
  dispose(): void;
}

export interface IDataSourceAdapter extends Disposable {
  connect(): Promise<ConnectionInfo>;
  disconnect(): Promise<void>;
  extractMetadata(options?: ExtractOptions): Promise<SchemaSnapshot>;
  executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult>;
  getCapabilities(): PlatformCapabilities;
  translateDialect(sql: string, targetDialect: SqlDialect): string;
  /** `scope` (`SCHEMA` or `DATABASE.SCHEMA`) overrides the connected schema (Phase K1: several schemas per connection). */
  getMetadataQueries(scope?: string): PlatformMetadataQueries;
  /** Stable id of this connection (e.g. `snowflake:acme`). */
  getConnectionId?(): string;
  /** Converts an extracted snapshot to graph nodes/edges with live-verified provenance. Pure — persisting it is the caller's job. */
  snapshotToGraph(snapshot: SchemaSnapshot, identity?: ObjectIdentity): { nodes: BaseNode[]; edges: GraphEdge[] };
  /**
   * Lists the databases/catalogs visible to the connected principal — lets a
   * user pick from what's actually there instead of typing a name blindly, and
   * is the discovery step "don't assume the whole account is relevant" needs
   * (Source & Target Context Architecture plan, Step 4). For Databricks this
   * lists catalogs (Unity Catalog's rough equivalent of a "database").
   */
  listDatabases(): Promise<string[]>;
  /** Lists the schemas within a given database/catalog — same rationale as `listDatabases()`. */
  listSchemas(database: string): Promise<string[]>;
}