import { DEFAULT_ENVIRONMENT, ObjectIdentity, edgeId, objectId, originSideFor, slugifyId } from '../context/estate';
import { DataPlatformProvider } from '../types';
import { BaseNode, TableNode, ColumnNode, GraphEdge } from '../context/types';
import { PlatformDefinition, PlatformOperation } from './operations/types';
import { runOperation } from './operations/execute';
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
  ProfilingReport,
  SqlDialect
} from './types';

/** The estate's raw reads for one scope, as rows with the platform-neutral column names `assembleTables` and the others read. */
/** Table types every platform shares; any other (a dynamic table, a metric view) is kept as the node's objectKind. */
const STANDARD_TYPES = new Set<string>(['TABLE', 'VIEW', 'MATERIALIZED_VIEW', 'EXTERNAL', 'BASE TABLE']);

/** The estate reads served by operations, by the read each one feeds. */
const ESTATE_READS = {
  tables: 'estate.list_tables', columns: 'estate.list_columns', views: 'estate.list_views',
  primaryKeys: 'estate.list_primary_keys', foreignKeys: 'estate.list_foreign_keys'
} as const;
/** Operations of the estate capability that aren't object lists. */
const NOT_OBJECT_LISTS = new Set<string>([...Object.values(ESTATE_READS), 'estate.table_stats', 'estate.last_altered', 'estate.list_databases', 'estate.list_schemas']);

export interface EstateReads {
  tables: QueryResult;
  columns: QueryResult;
  foreignKeys: QueryResult;
  views: QueryResult;
  primaryKeys: QueryResult;
  /** What couldn't be read, and why. */
  gaps: string[];
}

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

  /** v0.55.1: the platform definition whose estate operations read the estate (set by ConnectionManager, or by DefinitionAdapter). */
  protected estateSource?: { definition: PlatformDefinition; operation: (id: string) => PlatformOperation | undefined };

  constructor(
    protected readonly platform: DataPlatformProvider,
    protected readonly credentials: Record<string, string>,
    protected readonly log: (msg: string) => void
  ) {}

  /** v0.55.1: read the estate through the operations this platform definition names for `estate` (where it names any). */
  public useDefinition(definition: PlatformDefinition, operation: (id: string) => PlatformOperation | undefined): void {
    this.estateSource = { definition, operation };
  }

  /** The operations the definition names for the estate; none = the adapter's own queries. */
  protected estateOperations(): string[] {
    return this.estateSource?.definition.capabilities.estate?.operations ?? [];
  }

  /** Whether this scope's estate is read through operations (an adapter can keep its own queries for some scopes: Databricks' Hive metastore). */
  protected estateByOperations(_scope: string | undefined): boolean {
    return this.estateOperations().length > 0;
  }

  /** The database (catalog) and schema a read applies to where the scope doesn't say: the connection's. */
  protected defaultScope(): { database: string; schema: string } {
    return { database: this.credentials['database'] ?? this.credentials['catalog'] ?? '', schema: this.credentials['schema'] ?? '' };
  }

  /** `DATABASE.SCHEMA` or `SCHEMA`, completed from the connection. */
  protected scopeParams(scope: string | undefined): { database: string; schema: string } {
    const parts = scope ? scope.split('.') : [];
    const d = this.defaultScope();
    return { database: parts.length > 1 ? parts[0] : d.database, schema: parts.length ? parts[parts.length - 1] : d.schema };
  }

  /** Runs one of the definition's operations on this connection, with the parameters it declares. */
  protected async runEstateOperation(id: string, params: Record<string, unknown>, options?: { signal?: AbortSignal }) {
    const op = this.estateSource?.operation(id);
    if (!this.estateSource || !op) return { ok: false as const, rows: [] as Array<Record<string, unknown>>, gap: `the operation ${id} isn't in the catalog` };
    const declared = Object.fromEntries(Object.entries(params).filter(([k, v]) => v !== undefined && op.params.some((p) => p.name === k)));
    const runner = { sql: async (sql: string, maxRows: number) => (await this.executeQuery(sql, { maxRows, timeoutMs: 120_000, signal: options?.signal })).rows };
    return runOperation({ operation: op, platformId: this.estateSource.definition.id, platform: this.estateSource.definition, params: declared, runner, maxRows: 100_000 });
  }

  /** The estate's reads through operations: each a gap if it fails; extra object lists (a new kind) join the tables. */
  private async readEstateByOperations(scope: string | undefined, tableNames: string[] | undefined, options: ExtractOptions | undefined): Promise<EstateReads> {
    const params = { ...this.scopeParams(scope), ...(tableNames?.length ? { tables: tableNames } : {}) };
    const listed = this.estateOperations();
    const gaps: string[] = [];
    const empty: QueryResult = { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };
    const read = async (id: string): Promise<QueryResult> => {
      if (!listed.includes(id)) return empty;
      this.log(`[${this.platform}] ${id} (${params.database}.${params.schema})…`);
      const r = await this.runEstateOperation(id, params, options);
      if (!r.ok) { gaps.push(`${id}: ${r.gap}`); this.log(`[${this.platform}] ${id} not read: ${r.gap}`); return empty; }
      return { columns: r.rows[0] ? Object.keys(r.rows[0]) : [], rows: r.rows, rowCount: r.rows.length, executionTimeMs: 0 };
    };
    const tables = await read(ESTATE_READS.tables);
    // New object kinds: any other estate operation listing objects (a team file can add one) joins the tables, keeping its kind.
    for (const id of listed.filter((x) => !NOT_OBJECT_LISTS.has(x))) tables.rows.push(...(await read(id)).rows);
    // Row counts and sizes, where the platform keeps them apart from the table list.
    const stats = await read('estate.table_stats');
    if (stats.rows.length) {
      const key = (r: Record<string, unknown>) => `${String(r.table_schema ?? '')}.${String(r.table_name ?? '')}`.toLowerCase();
      const byTable = new Map(stats.rows.map((r) => [key(r), r]));
      for (const t of tables.rows) {
        const st = byTable.get(key(t));
        if (st) { if (st.row_count !== null && st.row_count !== undefined) t.row_count = st.row_count; if (st.bytes !== null && st.bytes !== undefined) t.bytes = st.bytes; }
      }
    }
    return {
      tables,
      columns: await read(ESTATE_READS.columns),
      views: await read(ESTATE_READS.views),
      primaryKeys: await read(ESTATE_READS.primaryKeys),
      foreignKeys: await read(ESTATE_READS.foreignKeys),
      gaps
    };
  }

  /**
   * A stable identifier for this specific connection (not just the platform
   * kind) — e.g. `snowflake:prod` for a named CLI connection, `snowflake:ACME`
   * for a direct-credential connection to account `ACME`, or just `snowflake`
   * when nothing more specific is available. Used to tag extracted schema so
   * multiple source connections of the same platform type stay distinguishable.
   */
  public getConnectionId(): string {
    const ref = this.credentials['connectionName'] || this.credentials['profile'] || this.credentials['account']
      || this.credentials['workspaceUrl'] || this.credentials['connectString'] || this.credentials['username'] || '';
    return ref ? `${this.platform}:${ref}` : this.platform;
  }

  /** The platform this adapter connects to. */
  public get platformId(): DataPlatformProvider { return this.platform; }

  abstract listDatabases(): Promise<string[]>;
  abstract listSchemas(database: string): Promise<string[]>;

  /**
   * Reads a value out of a query-result row by trying several candidate
   * column-name spellings in order — the same defensive pattern
   * `assembleTables()` already uses, since `SHOW DATABASES`/`SHOW SCHEMAS`/
   * `SHOW CATALOGS` return differently-cased/-named columns depending on
   * platform and execution tier (CLI JSON vs. REST JSON).
   */
  protected firstColumnValue(row: Record<string, unknown>, candidates: string[]): string {
    for (const key of candidates) {
      const value = row[key];
      if (typeof value === 'string' && value.length > 0) { return value; }
    }
    return '';
  }

  // ── Abstract Methods (platform-specific) ──

  abstract connect(): Promise<ConnectionInfo>;
  abstract disconnect(): Promise<void>;
  abstract dispose(): void;
  abstract executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult>;
  abstract getCapabilities(): PlatformCapabilities;
  abstract getMetadataQueries(scope?: string, tables?: string[]): PlatformMetadataQueries;
  abstract translateDialect(sql: string, targetDialect: SqlDialect): string;

  // ── Common Metadata Extraction (platform-agnostic orchestration) ──

  /**
   * Extracts every schema in `options.schemaFilter` (`SCHEMA` or
   * `DATABASE.SCHEMA`), or the connected one when none is given (Phase K1).
   */
  async extractMetadata(options?: ExtractOptions): Promise<SchemaSnapshot> {
    const scopes: Array<string | undefined> = options?.schemaFilter && options.schemaFilter.length > 0 ? [...options.schemaFilter] : [undefined];
    const parts: SchemaSnapshot[] = [];
    const tables = options?.tableFilter && options.tableFilter.length > 0 ? options.tableFilter : undefined;
    for (let i = 0; i < scopes.length; i++) {
      if (options?.signal?.aborted) break;
      if (scopes[i]) this.log(`[${this.platform}] Schema ${scopes[i]} (${i + 1}/${scopes.length})`);
      parts.push(await this.extractScope(scopes[i], tables, options));
    }
    if (parts.length === 1) return parts[0];
    const reports = parts.map((p) => p.profiling).filter((r): r is ProfilingReport => !!r);
    const gaps = parts.flatMap((p) => p.gaps ?? []);
    return {
      ...(reports.length ? { profiling: { queries: reports.reduce((n, r) => n + r.queries, 0), budget: reports[0].budget, profiledTables: reports.reduce((n, r) => n + r.profiledTables, 0), skippedTables: reports.reduce((n, r) => n + r.skippedTables, 0) } } : {}),
      ...(gaps.length ? { gaps } : {}),
      platform: this.platform,
      connectionId: this.getConnectionId(),
      extractedAt: parts[0]?.extractedAt ?? new Date().toISOString(),
      tables: parts.flatMap((p) => p.tables),
      views: parts.flatMap((p) => p.views),
      foreignKeys: parts.flatMap((p) => p.foreignKeys)
    };
  }

  /**
   * The estate's raw reads for one scope (v0.55.0: overridable, so a platform
   * defined by files reads them through its operations). Each read is
   * non-fatal: a failure leaves it empty and is reported as a gap.
   */
  protected async readEstate(queries: PlatformMetadataQueries, scope: string | undefined, options: ExtractOptions | undefined, tableNames?: string[]): Promise<EstateReads> {
    if (this.estateByOperations(scope)) return this.readEstateByOperations(scope, tableNames, options);
    const empty: QueryResult = { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };
    const gaps: string[] = [];
    const read = async (what: string, sql: string | undefined, timeoutMs: number): Promise<QueryResult> => {
      if (!sql) return empty;
      this.log(`[${this.platform}] Fetching ${what}...`);
      try {
        return await this.executeQuery(sql, { timeoutMs, signal: options?.signal });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.log(`[${this.platform}] ${what[0].toUpperCase()}${what.slice(1)} failed (non-fatal): ${reason}`);
        gaps.push(`${what}: ${reason}`);
        return empty;
      }
    };
    // Columns are non-fatal too: some catalog types (e.g. Databricks' legacy
    // `hive_metastore`) have no bulk, schema-wide column-introspection query at
    // all (no `information_schema` support), only a per-table DESCRIBE — degrade
    // to tables-without-column-detail rather than aborting the whole extraction.
    const tables = await read('tables', queries.listTables, 60000);
    const columns = await read('columns', queries.listColumns, 60000);
    const foreignKeys = await read('foreign keys', queries.listForeignKeys, 30000);
    const views = await read('views', queries.listViews, 30000);
    const primaryKeys = await read('primary keys', queries.listPrimaryKeys, 30000);
    return { tables, columns, foreignKeys, views, primaryKeys, gaps };
  }

  private async extractScope(scope: string | undefined, tableNames: string[] | undefined, options: ExtractOptions | undefined): Promise<SchemaSnapshot> {
    const startTime = new Date().toISOString();
    const queries = this.getMetadataQueries(scope, tableNames);

    this.log(`[${this.platform}] Extracting metadata...`);
    const reads = await this.readEstate(queries, scope, options, tableNames);
    const tablesResult = reads.tables;
    const columnsResult = reads.columns;
    const fkResult = reads.foreignKeys;
    const viewsResult = reads.views;

    // 5. Assemble tables with columns (a table filter also applies client-side, for
    // platforms whose listing can't be filtered, e.g. Hive metastore's SHOW TABLES)
    const wanted = options?.tableFilter && options.tableFilter.length > 0 ? new Set(options.tableFilter.map((t) => t.toLowerCase())) : undefined;
    const assembled = this.assembleTables(tablesResult, columnsResult).filter((t) => !wanted || wanted.has(t.name.toLowerCase()));

    // 6. Assemble views
    const views = this.assembleViews(viewsResult);

    // 7. Assemble foreign keys
    const foreignKeys = this.assembleForeignKeys(fkResult);

    // 7b. Key flags (v0.38.0): primary keys where the platform lists them, foreign keys from step 3.
    const pkRows: QueryResult['rows'] = reads.primaryKeys.rows;
    const keyOf = (schema: unknown, table: unknown, column: unknown) => `${String(schema)}.${String(table)}.${String(column)}`.toLowerCase();
    const pks = new Set(pkRows.map((r) => { const x = r as Record<string, unknown>; return keyOf(x['table_schema'] ?? x['TABLE_SCHEMA'], x['table_name'] ?? x['TABLE_NAME'], x['column_name'] ?? x['COLUMN_NAME']); }));
    const fks = new Set(foreignKeys.map((f) => keyOf(f.sourceSchema, f.sourceTable, f.sourceColumn)));
    const tables = pks.size === 0 && fks.size === 0 ? assembled : assembled.map((t) => ({
      ...t,
      columns: t.columns.map((c) => {
        const k = keyOf(t.schema, t.name, c.name);
        return pks.has(k) || fks.has(k) ? { ...c, isPrimaryKey: c.isPrimaryKey || pks.has(k), isForeignKey: c.isForeignKey || fks.has(k) } : c;
      })
    }));

    // 8. Optional: profile columns (Phase K2: sampled, bounded, budgeted)
    let profiling: ProfilingReport | undefined;
    if (options?.includeProfiling && this.getCapabilities().supportsColumnProfiling) {
      profiling = await this.profileTables(tables, queries, options);
    }

    // Lineage is not read here: platform skills carry the lineage queries (LIN, src/engine/lineage/observed.ts).

    this.log(`[${this.platform}] Metadata extraction complete: ${tables.length} tables, ${views.length} views, ${foreignKeys.length} FKs`);

    return {
      platform: this.platform,
      connectionId: this.getConnectionId(),
      extractedAt: startTime,
      tables,
      views,
      foreignKeys,
      ...(profiling ? { profiling } : {}),
      ...(reads.gaps.length ? { gaps: reads.gaps } : {})
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
      // `database`/`tableName` are Databricks' `SHOW TABLES` column names — the
      // fallback a legacy Hive metastore catalog (no `information_schema`) uses,
      // confirmed against a real workspace.
      const schema = String(r['table_schema'] ?? r['schema_name'] ?? r['TABLE_SCHEMA'] ?? r['database'] ?? '');
      const name = String(r['table_name'] ?? r['TABLE_NAME'] ?? r['tableName'] ?? '');
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
        lastAltered: r['last_altered'] ?? r['LAST_ALTERED'] ? String(r['last_altered'] ?? r['LAST_ALTERED']) : undefined,
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

  // ── Column Profiling (tier 2, Phase K2) ──

  /**
   * Profiles columns within limits (docs/specs/context-layer.md §11
   * Phase K, item 4): one sampled query per table where the platform has
   * `profileTable`, otherwise one query per column; at most `concurrency`
   * in flight and never more than `queryBudget` queries in one run. What the
   * budget leaves out is reported, not silently dropped. (Before v0.32.0:
   * one full-scan query per column, sequentially, 30 s timeout each.)
   */
  private async profileTables(tables: TableMetadata[], queries: PlatformMetadataQueries, options: ExtractOptions): Promise<ProfilingReport> {
    const budget = Math.max(0, options.profile?.queryBudget ?? 50);
    const concurrency = Math.max(1, options.profile?.concurrency ?? 4);
    const sampleRows = Math.max(1, options.profile?.sampleRows ?? 10_000);
    const skipTypes = ['VARIANT', 'OBJECT', 'ARRAY', 'GEOGRAPHY', 'GEOMETRY', 'BINARY', 'STRUCT', 'MAP'];
    // Oracle types COUNT(DISTINCT) can't take (v0.38.0), matched whole so Spark's LONG isn't caught.
    const oracleLobs = /^(N?CLOB|BLOB|BFILE|LONG|LONG RAW|RAW(\(\d+\))?|XMLTYPE|SDO_\w+)$/;
    const num = (r: Record<string, unknown>, k: string): number | undefined => {
      const v = r[k] ?? r[k.toUpperCase()];
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      return Number.isFinite(n) ? n : undefined;
    };
    type Task = { table: TableMetadata; run: () => Promise<void> };
    const tasks: Task[] = [];
    for (const table of tables) {
      const cols = table.columns.filter((c) => !skipTypes.some((t) => c.dataType.toUpperCase().includes(t)) && !(this.platform === 'oracle' && oracleLobs.test(c.dataType.toUpperCase())));
      if (cols.length === 0) continue;
      if (queries.profileTable) {
        tasks.push({ table, run: async () => {
          const result = await this.executeQuery(queries.profileTable!(table.fqn, cols.map((c) => c.name), sampleRows), { timeoutMs: 30000, signal: options.signal });
          const r = (result.rows[0] ?? {}) as Record<string, unknown>;
          cols.forEach((c, i) => { c.profile = { distinctCount: num(r, `d_${i}`), nullCount: num(r, `n_${i}`) }; });
        } });
      } else {
        for (const col of cols) {
          tasks.push({ table, run: async () => {
            const result = await this.executeQuery(queries.profileColumn(table.fqn, col.name), { timeoutMs: 30000, signal: options.signal });
            const r = (result.rows[0] ?? {}) as Record<string, unknown>;
            col.profile = {
              distinctCount: num(r, 'distinct_count'),
              nullCount: num(r, 'null_count'),
              minValue: r['min_value'] ?? r['MIN_VALUE'] ? String(r['min_value'] ?? r['MIN_VALUE']) : undefined,
              maxValue: r['max_value'] ?? r['MAX_VALUE'] ? String(r['max_value'] ?? r['MAX_VALUE']) : undefined,
              avgLength: num(r, 'avg_length')
            };
          } });
        }
      }
    }
    const runnable = tasks.slice(0, budget);
    let next = 0;
    let issued = 0;
    const worker = async () => {
      while (next < runnable.length && !options.signal?.aborted) {
        const task = runnable[next++];
        issued++;
        try {
          await task.run();
        } catch (err) {
          // Profiling is best-effort — a failed query leaves those columns unprofiled.
          this.log(`[${this.platform}] Profile failed for ${task.table.fqn}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, runnable.length) }, worker));
    const profiled = new Set(runnable.slice(0, issued).map((t) => t.table));
    const withWork = new Set(tasks.map((t) => t.table));
    const report: ProfilingReport = { queries: issued, budget, profiledTables: profiled.size, skippedTables: withWork.size - profiled.size };
    if (tasks.length > runnable.length) this.log(`[${this.platform}] Profiling stopped at its query budget (${budget}); ${report.skippedTables} table(s) not profiled.`);
    return report;
  }

  /** Phase K2 refresh on use: the platform's last-altered timestamp per lower-cased fqn, for some tables of one schema. */
  async readLastAltered(scope: string | undefined, tables: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (this.estateByOperations(scope)) {
      // v0.55.1: through the definition's estate.last_altered, where it names one.
      if (!this.estateOperations().includes('estate.last_altered')) return out;
      const params = this.scopeParams(scope);
      const r = await this.runEstateOperation('estate.last_altered', { ...params, ...(tables.length ? { tables } : {}) });
      const wanted = new Set(tables.map((t) => t.toLowerCase()));
      for (const row of r.ok ? r.rows : []) {
        const name = String(row.table_name ?? ''); const at = row.last_altered;
        if (!name || at === null || at === undefined || (wanted.size && !wanted.has(name.toLowerCase()))) continue;
        out.set(`${params.database}.${String(row.table_schema ?? '')}.${name}`.toLowerCase(), String(at));
        out.set(`${String(row.table_schema ?? '')}.${name}`.toLowerCase(), String(at));
      }
      return out;
    }
    const sql = this.getMetadataQueries(scope, tables).lastAltered;
    if (!sql) return out;
    const result = await this.executeQuery(sql, { timeoutMs: 30000 });
    const db = scope && scope.includes('.') ? scope.split('.')[0] : undefined;
    for (const row of result.rows) {
      const r = row as Record<string, unknown>;
      const schema = String(r['table_schema'] ?? r['TABLE_SCHEMA'] ?? '');
      const name = String(r['table_name'] ?? r['TABLE_NAME'] ?? '');
      const at = r['last_altered'] ?? r['LAST_ALTERED'];
      if (!name || at === undefined || at === null) continue;
      out.set((db ? `${db}.${schema}.${name}` : `${schema}.${name}`).toLowerCase(), String(at));
      out.set(`${schema}.${name}`.toLowerCase(), String(at));
    }
    return out;
  }

  // ── Graph Conversion ──

  /**
   * Graph form of a snapshot. Ids are estate-qualified (Phase K1):
   * `identity` says which system and environment the connection feeds; by
   * default a system named after the connection.
   */
  public snapshotToGraph(snapshot: SchemaSnapshot, identity?: ObjectIdentity): { nodes: BaseNode[]; edges: GraphEdge[] } {
    const nodes: BaseNode[] = [];
    const edges: GraphEdge[] = [];
    const now = new Date().toISOString();
    const ident: ObjectIdentity = identity ?? { system: slugifyId(snapshot.connectionId ?? snapshot.platform), environment: DEFAULT_ENVIRONMENT, role: 'source' };
    const side = originSideFor(ident.role);
    const idOf = (fqn: string, column?: string) => objectId(ident.system, ident.environment, fqn, column);
    // Every node here comes from introspecting a live, connected platform — in
    // AutoDE's current model that is always the *source* side of a Brownfield
    // implementation (nothing introspects a target platform; target intent is
    // expressed as TargetEnvironment config, not discovered schema).
    const sourceOrigin = {
      source: 'derived' as const,
      sourceRef: snapshot.platform,
      connectionId: snapshot.connectionId,
      extractor: 'source-assessment',
      extractedAt: now,
      ...(side ? { environment: side } : {}),
      system: ident.system,
      systemEnvironment: ident.environment,
      // Step 7 (governance layer): a live connection's introspection is the
      // most trustworthy provenance this codebase has — `confidence`/
      // `reliability` were never actually set here before, a confirmed gap
      // from the architecture review (Challenge 3).
      confidence: 1.0,
      reliability: 'live-verified' as const,
      lastVerifiedAt: now
    };

    for (const table of snapshot.tables) {
      const tableNode: TableNode = {
        id: idOf(table.fqn),
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
          platform: snapshot.platform,
          ...(table.lastAltered ? { lastAltered: table.lastAltered } : {}),
          ...(STANDARD_TYPES.has(table.type) ? {} : { objectKind: String(table.type).toLowerCase().replace(/[\s_]+/g, '_') })
        },
        version: 1,
        origin: sourceOrigin
      };
      nodes.push(tableNode);

      for (const col of table.columns) {
        const colNode: ColumnNode = {
          id: idOf(table.fqn, col.name),
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
          version: 1,
          origin: sourceOrigin
        };
        nodes.push(colNode);

        edges.push({
          id: edgeId('contains', tableNode.id, colNode.id),
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
        id: idOf(view.fqn),
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
        version: 1,
        origin: sourceOrigin
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
        id: edgeId('foreign_key', idOf(sourceFqn), idOf(targetFqn)),
        source: idOf(sourceFqn),
        target: idOf(targetFqn),
        type: 'foreign_key',
        weight: 0.9
      });
    }

    return { nodes, edges };
  }
}