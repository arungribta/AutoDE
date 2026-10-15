import { BaseDataSourceAdapter } from '../BaseAdapter';
import {
  PlatformCapabilities,
  ConnectionInfo,
  QueryOptions,
  QueryResult,
  PlatformMetadataQueries,
  SqlDialect
} from '../types';
import { ExecutionBackend } from '../executionBackends/types';
import { DatabricksRestBackend } from '../executionBackends/DatabricksRestBackend';

/**
 * Databricks data platform adapter.
 *
 * Real execution (Phase 3b) goes through the Statement Execution REST API only —
 * unlike Snowflake, Databricks' CLI has no native-protocol execution path of its
 * own (`databricks api post ...` is a thin wrapper over this exact same REST
 * endpoint), so there is no CLI-shell-out tier to fall back to here. A
 * CLI-derived (`profile`) credential is rejected with an explanation rather than
 * silently failing on a missing workspace URL.
 *
 * Metadata extraction uses system.information_schema (Unity Catalog).
 * Profiling uses Spark SQL aggregate functions.
 */
export class DatabricksAdapter extends BaseDataSourceAdapter {
  private backend: ExecutionBackend | null = null;
  private connectedCatalog: string = '';
  private connectedSchema: string = '';
  /** `'auto'` (default) infers hive_metastore-vs-Unity-Catalog from the catalog name; an explicit `'unity'`/`'hive_metastore'` always wins — see `defaultDatabricksCatalogType`. */
  private catalogType: 'auto' | 'unity' | 'hive_metastore' = 'auto';

  constructor(credentials: Record<string, string>, log: (msg: string) => void) {
    super('databricks', credentials, log);
  }

  async connect(): Promise<ConnectionInfo> {
    const profile = this.credentials['profile'] || '';
    if (profile) {
      throw new Error(
        'Databricks has no CLI-based native execution path the way Snowflake does — the Databricks CLI only wraps the same Statement Execution REST API. Configure a workspace host, SQL warehouse HTTP path, and token directly (Settings → Connections) to connect.'
      );
    }

    const workspaceUrl = this.credentials['workspaceUrl'] || this.credentials['workspace_url'] || '';
    const httpPath = this.credentials['httpPath'] || '';
    const token = this.credentials['token'] || '';
    const catalog = this.credentials['catalog'] || 'main';
    const schema = this.credentials['schema'] || 'default';
    const catalogType = this.credentials['catalogType'];
    if (catalogType === 'unity' || catalogType === 'hive_metastore') {
      this.catalogType = catalogType;
    }

    if (!workspaceUrl || !httpPath || !token) {
      throw new Error('Databricks connection requires a workspace host, SQL warehouse HTTP path, and token.');
    }

    const host = workspaceUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.backend = new DatabricksRestBackend({ host, httpPath, token, catalog, schema }, (msg) => this.log(msg));
    this.connectedCatalog = catalog;
    this.connectedSchema = schema;

    try {
      const info = await this.executeQuery('SELECT current_catalog() AS CURRENT_CATALOG, current_schema() AS CURRENT_SCHEMA');
      const row = (info.rows[0] ?? {}) as Record<string, unknown>;
      this.connectedCatalog = String(row['CURRENT_CATALOG'] ?? catalog);
      this.connectedSchema = String(row['CURRENT_SCHEMA'] ?? schema);
      this.log(`[databricks] Connected to ${this.connectedCatalog}.${this.connectedSchema}.`);
      return {
        connected: true,
        platform: 'databricks',
        databaseName: this.connectedCatalog,
        schemaName: this.connectedSchema,
        version: 'unknown', // no SELECT CURRENT_VERSION() equivalent exposed generically across DBR versions
        capabilities: this.getCapabilities()
      };
    } catch (err) {
      this.backend = null;
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async disconnect(): Promise<void> {
    this.backend?.dispose();
    this.backend = null;
    this.log('[databricks] Disconnected.');
  }

  dispose(): void {
    this.backend?.dispose();
    this.backend = null;
  }

  async executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult> {
    if (!this.backend) {
      throw new Error('Not connected to Databricks. Call connect() first.');
    }
    return this.backend.executeQuery(sql, options);
  }

  /**
   * Lists catalogs visible to the connected principal — Unity Catalog's rough
   * equivalent of a "database" (Step 4). `hive_metastore` (if present)
   * naturally appears alongside real Unity Catalog catalogs in this same list,
   * confirmed live — no special-casing needed here.
   */
  async listDatabases(): Promise<string[]> {
    const result = await this.executeQuery('SHOW CATALOGS');
    return result.rows
      .map((row) => this.firstColumnValue(row as Record<string, unknown>, ['catalog', 'CATALOG', 'catalog_name']))
      .filter((name) => name.length > 0);
  }

  /**
   * Lists schemas within a catalog. `SHOW SCHEMAS IN <catalog>` is a bare SHOW
   * command (not wrapped in SELECT/WITH), so it works even for `hive_metastore`
   * — confirmed live this session that only *wrapping* a SHOW command breaks,
   * not the bare command itself.
   */
  async listSchemas(database: string): Promise<string[]> {
    const result = await this.executeQuery(`SHOW SCHEMAS IN ${database}`);
    return result.rows
      .map((row) => this.firstColumnValue(row as Record<string, unknown>, ['databaseName', 'namespace', 'schemaName']))
      .filter((name) => name.length > 0);
  }

  getCapabilities(): PlatformCapabilities {
    return {
      supportsMetadataExtraction: true,
      supportsQueryExecution: true,
      supportsDdlGeneration: true,
      supportsColumnProfiling: true,
      supportsLineageExtraction: false,  // Requires Unity Catalog lineage (separate feature)
      supportsChangeDataCapture: true,   // via Delta CDF
      supportsStreaming: true,           // via Structured Streaming
      maxQueryTimeoutMs: 600000,
      supportedDialects: ['spark_sql', 'ansi']
    };
  }

  getMetadataQueries(scope?: string, tables?: string[]): PlatformMetadataQueries {
    const parts = scope ? scope.split('.') : [];
    const catalog = parts.length > 1 ? parts[0] : (this.connectedCatalog || 'main');
    const schema = parts.length > 0 ? parts[parts.length - 1] : (this.connectedSchema || 'default');

    // The legacy Hive metastore catalog (Databricks' pre-Unity-Catalog compatibility
    // layer, still the default on older workspaces) has no `information_schema`
    // support at all — confirmed against a real workspace. Any Unity-Catalog-backed
    // catalog does support it uniformly regardless of the underlying table format
    // (Delta, Iceberg via UC's own Iceberg REST support, or a Lakehouse Federation
    // catalog) or which catalog service manages it (Unity Catalog itself, or an
    // external Iceberg REST catalog like Apache Polaris / Snowflake Open Catalog
    // attached to Unity Catalog) — from Databricks SQL's perspective those are all
    // just Unity Catalog catalog objects.
    //
    // `defaultDatabricksCatalogType` decides this explicitly when set — a single
    // workspace can have both kinds of catalog side by side (confirmed live: this
    // exact workspace has `hive_metastore` *and* dozens of Unity Catalog catalogs),
    // so which shape applies is a per-connection fact the user can state rather
    // than something silently inferred every time. `'auto'` (the default) falls
    // back to checking for the reserved `hive_metastore` name, which Databricks
    // never lets a user repurpose for anything else — a safe, zero-config default,
    // not a fragile heuristic. An explicit override also works as a manual escape
    // hatch for any other catalog that turns out to share the legacy catalog's
    // limitations, without AutoDE needing to know about it by name.
    const resolvedType = this.catalogType !== 'auto' ? this.catalogType : (catalog === 'hive_metastore' ? 'hive_metastore' : 'unity');
    if (resolvedType === 'hive_metastore') {
      return this.getHiveMetastoreMetadataQueries(catalog, schema);
    }
    return this.getUnityCatalogMetadataQueries(catalog, schema, tables);
  }

  /**
   * Table listing only — `SHOW TABLES` is the one bulk introspection command Hive
   * metastore supports, and Spark SQL cannot reshape a SHOW command's output via
   * `SELECT`/`WITH` (confirmed against a real workspace), so there is no single
   * static query that can give column/FK/view-level detail the way
   * `information_schema` does for Unity Catalog — that would need a per-table
   * `DESCRIBE` loop, which the current one-static-query-per-kind
   * `PlatformMetadataQueries` contract can't express. Those three queries are
   * deliberately empty, always-valid no-ops (never touched, since `extractMetadata()`
   * only profiles columns that `listColumns` actually returned) rather than
   * mis-mapped guesses or a hard failure.
   */
  private getHiveMetastoreMetadataQueries(catalog: string, schema: string): PlatformMetadataQueries {
    const emptyOf = (cols: string[]): string => `SELECT ${cols.map((c) => `CAST(NULL AS STRING) AS ${c}`).join(', ')} WHERE 1 = 0`;
    return {
      listTables: `SHOW TABLES IN ${catalog}.${schema}`,
      listColumns: emptyOf(['table_catalog', 'table_schema', 'table_name', 'column_name', 'data_type', 'is_nullable', 'ordinal_position', 'comment', 'column_default']),
      listForeignKeys: emptyOf(['source_schema', 'source_table', 'source_column', 'target_schema', 'target_table', 'target_column', 'constraint_name']),
      listViews: emptyOf(['table_catalog', 'table_schema', 'table_name', 'view_definition']),
      profileColumn: (fqn: string, col: string) => `
        SELECT
          COUNT(DISTINCT ${col}) AS distinct_count,
          COUNT(*) - COUNT(${col}) AS null_count,
          CAST(MIN(${col}) AS STRING) AS min_value,
          CAST(MAX(${col}) AS STRING) AS max_value,
          AVG(LENGTH(CAST(${col} AS STRING))) AS avg_length
        FROM ${fqn}`
    };
  }

  /** Unity Catalog (and anything Unity-Catalog-backed — Iceberg-via-UC, Lakehouse Federation, an attached external Iceberg REST catalog) — `information_schema` is a schema within each catalog, uniformly. */
  private getUnityCatalogMetadataQueries(catalog: string, schema: string, tables?: string[]): PlatformMetadataQueries {
    // Phase K2 query-through: only the named tables (Unity Catalog stores names lower-cased).
    const only = tables && tables.length > 0 ? `\n          AND lower(table_name) IN (${tables.map((t) => `'${t.toLowerCase().replace(/'/g, "''")}'`).join(', ')})` : '';
    return {
      // `<catalog>.information_schema.tables`, not nested under a `system` catalog
      // segment — confirmed against a real workspace (Phase 3b live verification);
      // the earlier `${catalog}.system.information_schema...` shape was never real.
      listTables: `
        SELECT
          table_catalog,
          table_schema,
          table_name,
          table_type,
          data_source_format,
          last_altered,
          comment
        FROM ${catalog}.information_schema.tables
        WHERE table_schema = '${schema}'${only}
        ORDER BY table_name`,

      lastAltered: `
        SELECT table_schema, table_name, last_altered
        FROM ${catalog}.information_schema.tables
        WHERE table_schema = '${schema}'${only}`,

      listColumns: `
        SELECT
          table_catalog,
          table_schema,
          table_name,
          column_name,
          data_type,
          is_nullable,
          ordinal_position,
          comment,
          column_default
        FROM ${catalog}.information_schema.columns
        WHERE table_schema = '${schema}'${only}
        ORDER BY table_name, ordinal_position`,

      listForeignKeys: `
        SELECT
          kcu.constraint_schema AS source_schema,
          kcu.table_name AS source_table,
          kcu.column_name AS source_column,
          ccu.constraint_schema AS target_schema,
          ccu.table_name AS target_table,
          ccu.column_name AS target_column,
          kcu.constraint_name
        FROM ${catalog}.information_schema.key_column_usage kcu
        JOIN ${catalog}.information_schema.constraint_column_usage ccu
          ON kcu.constraint_name = ccu.constraint_name
        WHERE kcu.constraint_schema = '${schema}'`,

      // `information_schema.views` has no `comment` column (confirmed against a real
      // workspace — unlike `.tables`/`.columns`, which both do).
      listViews: `
        SELECT
          table_catalog,
          table_schema,
          table_name,
          view_definition
        FROM ${catalog}.information_schema.views
        WHERE table_schema = '${schema}'
        ORDER BY table_name`,

      profileColumn: (fqn: string, col: string) => `
        SELECT
          COUNT(DISTINCT ${col}) AS distinct_count,
          COUNT(*) - COUNT(${col}) AS null_count,
          CAST(MIN(${col}) AS STRING) AS min_value,
          CAST(MAX(${col}) AS STRING) AS max_value,
          AVG(LENGTH(CAST(${col} AS STRING))) AS avg_length
        FROM ${fqn}`,

      profileTable: (fqn: string, cols: string[], sampleRows: number) => `
        SELECT COUNT(*) AS row_count${cols.map((c, i) => `, COUNT(DISTINCT ${c}) AS d_${i}, COUNT(*) - COUNT(${c}) AS n_${i}`).join('')}
        FROM ${fqn} TABLESAMPLE (${Math.max(1, Math.floor(sampleRows))} ROWS)`
    };
  }

  translateDialect(sql: string, targetDialect: SqlDialect): string {
    if (targetDialect === 'snowflake') {
      // Translate Spark SQL → Snowflake SQL
      return sql
        .replace(/uuid\(\)/gi, 'UUID_STRING()')
        .replace(/current_timestamp\(\)/gi, 'CURRENT_TIMESTAMP()')
        .replace(/date_add\(/gi, 'DATEADD(day, ')
        .replace(/date_sub\(/gi, 'DATEADD(day, -');
    }

    if (targetDialect === 'google_sql') {
      // Translate Spark SQL → GoogleSQL
      return sql
        .replace(/uuid\(\)/gi, 'GENERATE_UUID()')
        .replace(/current_timestamp\(\)/gi, 'CURRENT_TIMESTAMP()');
    }

    // Spark SQL is the native dialect — no translation needed
    return sql;
  }
}
