import * as vscode from 'vscode';
import { DataPlatformProvider } from '../core/types';
import { BaseNode, TableNode, ColumnNode, GraphEdge } from '../context/types';
import {
  IDataSourceAdapter,
  PlatformCapabilities,
  ConnectionInfo,
  SchemaSnapshot,
  TableMetadata,
  ExtractOptions,
  QueryOptions,
  QueryResult,
  PlatformMetadataQueries,
  SqlDialect
} from './types';

/**
 * Abstract base class for all data platform adapters.
 * Sub-agents interact with this interface — never with platform-specific code.
 *
 * Each concrete adapter (Snowflake, Databricks, BigQuery, etc.) must implement:
 *   - connect()
 *   - disconnect()
 *   - executeQuery()
 *   - getCapabilities()
 *   - getMetadataQueries()
 *   - translateDialect()
 */
export abstract class BaseDataSourceAdapter implements IDataSourceAdapter {
  protected connection: unknown = null;

  constructor(
    protected readonly platform: DataPlatformProvider,
    protected readonly credentials: Record<string, string>,
    protected readonly log: (msg: string) => void
  ) {}

  // ── Abstract Methods (platform-specific) ──

  abstract connect(): Promise<ConnectionInfo>;
  abstract disconnect(): Promise<void>;
  abstract dispose(): void;
  abstract executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult>;
  abstract getCapabilities(): PlatformCapabilities;
  abstract getMetadataQueries(): PlatformMetadataQueries;
  abstract translateDialect(sql: string, targetDialect: SqlDialect): string;

  // ── Common Metadata Extraction (platform-agnostic orchestration) ──

  async extractMetadata(options?: ExtractOptions): Promise<SchemaSnapshot> {
    const queries = this.getMetadataQueries();
    const startTime = new Date().toISOString();

    this.log(`[${this.platform}] Extracting metadata...`);

    // 1. Fetch tables
    this.log(`[${this.platform}] Fetching tables...`);
    const tablesResult = await this.executeQuery(queries.listTables, {
      timeoutMs: 60000,
      cancellationToken: options?.cancellationToken
    });

    // 2. Fetch columns
    this.log(`[${this.platform}] Fetching columns...`);
    const columnsResult = await this.executeQuery(queries.listColumns, {
      timeoutMs: 60000,
      cancellationToken: options?.cancellationToken
    });

    // 3. Fetch foreign keys
    this.log(`[${this.platform}] Fetching foreign keys...`);
    let fkResult: QueryResult = { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };
    try {
      fkResult = await this.executeQuery(queries.listForeignKeys, {
        timeoutMs: 30000,
        cancellationToken: options?.cancellationToken
      });
    } catch (err) {
      this.log(`[${this.platform}] Foreign key extraction failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    // 4. Fetch views
    this.log(`[${this.platform}] Fetching views...`);
    let viewsResult: QueryResult = { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };
    try {
      viewsResult = await this.executeQuery(queries.listViews, {
        timeoutMs: 30000,
        cancellationToken: options?.cancellationToken
      });
    } catch (err) {
      this.log(`[${this.platform}] View extraction failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    // 5. Assemble tables with columns
    const tables = this.assembleTables(tablesResult, columnsResult);

    // 6. Assemble views
    const views = this.assembleViews(viewsResult);

    // 7. Assemble foreign keys
    const foreignKeys = this.assembleForeignKeys(fkResult);

    // 8. Optional: profile columns
    if (options?.includeProfiling && this.getCapabilities().supportsColumnProfiling) {
      await this.profileColumns(tables, queries, options?.cancellationToken);
    }

    // 9. Optional: extract lineage
    let lineage: import('./types').LineageEdge[] | undefined;
    if (queries.extractLineage && this.getCapabilities().supportsLineageExtraction) {
      try {
        const lineageResult = await this.executeQuery(queries.extractLineage, {
          timeoutMs: 60000,
          cancellationToken: options?.cancellationToken
        });
        lineage = this.assembleLineage(lineageResult);
      } catch (err) {
        this.log(`[${this.platform}] Lineage extraction failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.log(`[${this.platform}] Metadata extraction complete: ${tables.length} tables, ${views.length} views, ${foreignKeys.length} FKs`);

    return {
      platform: this.platform,
      extractedAt: startTime,
      tables,
      views,
      foreignKeys,
      lineage
    };
  }

  // ── Assembly Helpers ──

  private assembleTables(
    tablesResult: QueryResult,
    columnsResult: QueryResult
  ): TableMetadata[] {
    const tables: TableMetadata[] = [];

    for (const row of tablesResult.rows) {
      const r = row as Record<string, unknown>;
      const schema = String(r['table_schema'] ?? r['schema_name'] ?? r['TABLE_SCHEMA'] ?? '');
      const name = String(r['table_name'] ?? r['TABLE_NAME'] ?? '');
      const catalog = r['table_catalog'] ?? r['catalog_name'] ?? r['TABLE_CATALOG'];
      const fqn = catalog ? `${catalog}.${schema}.${name}` : `${schema}.${name}`;
      const tableType = String(r['table_type'] ?? r['TABLE_TYPE'] ?? 'TABLE').toUpperCase();

      // Find columns for this table
      const tableColumns = (columnsResult.rows as Array<Record<string, unknown>>)
        .filter((cr) => {
          const colSchema = String(cr['table_schema'] ?? cr['schema_name'] ?? cr['TABLE_SCHEMA'] ?? '');
          const colTable = String(cr['table_name'] ?? cr['TABLE_NAME'] ?? '');
          return colSchema === schema && colTable === name;
        })
        .map((cr, idx) => ({
          name: String(cr['column_name'] ?? cr['COLUMN_NAME'] ?? ''),
          dataType: String(cr['data_type'] ?? cr['DATA_TYPE'] ?? ''),
          isNullable: String(cr['is_nullable'] ?? cr['IS_NULLABLE'] ?? 'YES').toUpperCase() === 'YES',
          isPrimaryKey: false, // Will be updated from FK data
          isForeignKey: false,
          ordinalPosition: typeof cr['ordinal_position'] === 'number'
            ? cr['ordinal_position'] as number
            : idx + 1,
          defaultValue: cr['column_default'] ? String(cr['column_default']) : undefined,
          comment: cr['comment'] ? String(cr['comment']) : undefined
        }));

      tables.push({
        catalog: catalog ? String(catalog) : undefined,
        schema,
        name,
        fqn,
        type: tableType as TableMetadata['type'],
        rowCount: typeof r['row_count'] === 'number' ? r['row_count'] as number : undefined,
        sizeBytes: typeof r['bytes'] === 'number' ? r['bytes'] as number
          : typeof r['size_bytes'] === 'number' ? r['size_bytes'] as number
          : undefined,
        columns: tableColumns,
        comment: r['comment'] ? String(r['comment']) : undefined,
        properties: {}
      });
    }

    return tables;
  }

  private assembleViews(viewsResult: QueryResult): import('./types').ViewMetadata[] {
    return (viewsResult.rows as Array<Record<string, unknown>>).map((r) => {
      const schema = String(r['table_schema'] ?? r['schema_name'] ?? r['TABLE_SCHEMA'] ?? '');
      const name = String(r['table_name'] ?? r['TABLE_NAME'] ?? '');
      const catalog = r['table_catalog'] ?? r['catalog_name'] ?? r['TABLE_CATALOG'];
      const fqn = catalog ? `${catalog}.${schema}.${name}` : `${schema}.${name}`;

      return {
        catalog: catalog ? String(catalog) : undefined,
        schema,
        name,
        fqn,
        definition: String(r['view_definition'] ?? r['VIEW_DEFINITION'] ?? ''),
        comment: r['comment'] ? String(r['comment']) : undefined
      };
    });
  }

  private assembleForeignKeys(fkResult: QueryResult): import('./types').ForeignKeyMetadata[] {
    return (fkResult.rows as Array<Record<string, unknown>>).map((r, idx) => ({
      constraintName: r['constraint_name'] ? String(r['constraint_name']) : `fk-${idx}`,
      sourceSchema: String(r['source_schema'] ?? r['fk_schema'] ?? r['SOURCE_SCHEMA'] ?? ''),
      sourceTable: String(r['source_table'] ?? r['fk_table'] ?? r['SOURCE_TABLE'] ?? ''),
      sourceColumn: String(r['source_column'] ?? r['fk_column'] ?? r['SOURCE_COLUMN'] ?? ''),
      targetSchema: String(r['target_schema'] ?? r['pk_schema'] ?? r['TARGET_SCHEMA'] ?? ''),
      targetTable: String(r['target_table'] ?? r['pk_table'] ?? r['TARGET_TABLE'] ?? ''),
      targetColumn: String(r['target_column'] ?? r['pk_column'] ?? r['TARGET_COLUMN'] ?? '')
    }));
  }

  private assembleLineage(lineageResult: QueryResult): import('./types').LineageEdge[] {
    return (lineageResult.rows as Array<Record<string, unknown>>).map((r) => ({
      sourceFqn: String(r['source_fqn'] ?? r['SOURCE_FQN'] ?? ''),
      targetFqn: String(r['target_fqn'] ?? r['TARGET_FQN'] ?? ''),
      transformDescription: r['transform'] ? String(r['transform']) : undefined,
      queryText: r['query_text'] ? String(r['query_text']) : undefined
    }));
  }

  // ── Column Profiling ──

  private async profileColumns(
    tables: TableMetadata[],
    queries: PlatformMetadataQueries,
    cancellationToken?: vscode.CancellationToken
  ): Promise<void> {
    for (const table of tables) {
      if (cancellationToken?.isCancellationRequested) break;

      for (const col of table.columns) {
        if (cancellationToken?.isCancellationRequested) break;

        // Skip profiling for large/complex types
        const skipTypes = ['VARIANT', 'OBJECT', 'ARRAY', 'GEOGRAPHY', 'GEOMETRY', 'BINARY', 'STRUCT', 'MAP'];
        if (skipTypes.some((t) => col.dataType.toUpperCase().includes(t))) continue;

        try {
          const profileSql = queries.profileColumn(table.fqn, col.name);
          const result = await this.executeQuery(profileSql, {
            timeoutMs: 30000,
            cancellationToken
          });

          if (result.rows.length > 0) {
            const r = result.rows[0] as Record<string, unknown>;
            col.profile = {
              distinctCount: typeof r['distinct_count'] === 'number' ? r['distinct_count'] as number
                : typeof r['DISTINCT_COUNT'] === 'number' ? r['DISTINCT_COUNT'] as number
                : undefined,
              nullCount: typeof r['null_count'] === 'number' ? r['null_count'] as number
                : typeof r['NULL_COUNT'] === 'number' ? r['NULL_COUNT'] as number
                : undefined,
              minValue: r['min_value'] ? String(r['min_value']) : undefined,
              maxValue: r['max_value'] ? String(r['max_value']) : undefined,
              avgLength: typeof r['avg_length'] === 'number' ? r['avg_length'] as number : undefined
            };
          }
        } catch (err) {
          // Profiling is best-effort — skip columns that fail
          this.log(`[${this.platform}] Profile failed for ${table.fqn}.${col.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // ── Persistence ──

  async persistSchemaContext(snapshot: SchemaSnapshot, workspaceUri: vscode.Uri): Promise<void> {
    const contextDir = vscode.Uri.joinPath(workspaceUri, '.ai-context');
    const tempFile = vscode.Uri.joinPath(contextDir, `schema-graph.tmp.${Date.now()}.json`);
    const targetFile = vscode.Uri.joinPath(contextDir, 'schema-graph.json');

    // Ensure .ai-context directory exists
    try {
      await vscode.workspace.fs.createDirectory(contextDir);
    } catch {
      // Directory may already exist
    }

    // Convert snapshot to graph format
    const graphData = this.snapshotToGraph(snapshot);

    // Atomic write: temp → rename
    const content = Buffer.from(JSON.stringify(graphData, null, 2), 'utf8');
    await vscode.workspace.fs.writeFile(tempFile, content);
    await vscode.workspace.fs.rename(tempFile, targetFile, { overwrite: true });

    this.log(`[${this.platform}] Schema context persisted to .ai-context/schema-graph.json`);
  }

  // ── Graph Conversion ──

  protected snapshotToGraph(snapshot: SchemaSnapshot): { nodes: BaseNode[]; edges: GraphEdge[] } {
    const nodes: BaseNode[] = [];
    const edges: GraphEdge[] = [];

    for (const table of snapshot.tables) {
      const tableNode: TableNode = {
        id: `table-${table.fqn.replace(/[^a-zA-Z0-9_]/g, '_')}`,
        type: table.type === 'VIEW' || table.type === 'MATERIALIZED_VIEW' ? 'semantic_view' : 'table',
        label: table.name,
        description: table.comment,
        database: table.catalog || '',
        schema: table.schema,
        fqn: table.fqn,
        isView: table.type === 'VIEW' || table.type === 'MATERIALIZED_VIEW',
        metadata: {
          rowCount: table.rowCount,
          sizeBytes: table.sizeBytes,
          platform: snapshot.platform
        },
        version: 1
      };
      nodes.push(tableNode);

      for (const col of table.columns) {
        const colNode: ColumnNode = {
          id: `col-${table.fqn.replace(/[^a-zA-Z0-9_]/g, '_')}.${col.name}`,
          type: 'column',
          label: col.name,
          description: col.comment,
          dataType: col.dataType,
          isNullable: col.isNullable,
          isPrimaryKey: col.isPrimaryKey,
          isForeignKey: col.isForeignKey,
          metadata: {
            profile: col.profile,
            ordinalPosition: col.ordinalPosition
          },
          version: 1
        };
        nodes.push(colNode);

        edges.push({
          id: `edge-contains-${tableNode.id}-${colNode.id}`,
          source: tableNode.id,
          target: colNode.id,
          type: 'contains',
          weight: 1.0
        });
      }
    }

    // Add views as table nodes
    for (const view of snapshot.views) {
      const viewNode: TableNode = {
        id: `table-${view.fqn.replace(/[^a-zA-Z0-9_]/g, '_')}`,
        type: 'semantic_view',
        label: view.name,
        description: view.comment,
        database: view.catalog || '',
        schema: view.schema,
        fqn: view.fqn,
        isView: true,
        metadata: {
          viewDefinition: view.definition,
          platform: snapshot.platform
        },
        version: 1
      };
      nodes.push(viewNode);
    }

    // Add foreign key edges
    for (const fk of snapshot.foreignKeys) {
      const sourceFqn = fk.sourceCatalog
        ? `${fk.sourceCatalog}.${fk.sourceSchema}.${fk.sourceTable}`
        : `${fk.sourceSchema}.${fk.sourceTable}`;
      const targetFqn = fk.targetCatalog
        ? `${fk.targetCatalog}.${fk.targetSchema}.${fk.targetTable}`
        : `${fk.targetSchema}.${fk.targetTable}`;

      edges.push({
        id: `edge-fk-${sourceFqn.replace(/[^a-zA-Z0-9_]/g, '_')}-${targetFqn.replace(/[^a-zA-Z0-9_]/g, '_')}`,
        source: `table-${sourceFqn.replace(/[^a-zA-Z0-9_]/g, '_')}`,
        target: `table-${targetFqn.replace(/[^a-zA-Z0-9_]/g, '_')}`,
        type: 'foreign_key',
        weight: 0.9
      });
    }

    return { nodes, edges };
  }
}