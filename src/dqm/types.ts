import * as vscode from 'vscode';
import { DataPlatformProvider } from '../core/types';

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
  readonly cancellationToken?: vscode.CancellationToken;
}

export interface QueryOptions {
  readonly timeoutMs?: number;
  readonly maxRows?: number;
  readonly cancellationToken?: vscode.CancellationToken;
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
export interface IDataSourceAdapter extends vscode.Disposable {
  connect(): Promise<ConnectionInfo>;
  disconnect(): Promise<void>;
  extractMetadata(options?: ExtractOptions): Promise<SchemaSnapshot>;
  executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult>;
  getCapabilities(): PlatformCapabilities;
  translateDialect(sql: string, targetDialect: SqlDialect): string;
  getMetadataQueries(): PlatformMetadataQueries;
  persistSchemaContext(snapshot: SchemaSnapshot, workspaceUri: vscode.Uri): Promise<void>;
}