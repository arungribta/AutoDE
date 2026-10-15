import { DEFAULT_ENVIRONMENT, ObjectIdentity, edgeId, objectId, originSideFor, slugifyId } from '../context/estate';
import { DataPlatformProvider } from '../types';
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
  ProfilingReport,
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

  /**
   * A stable identifier for this specific connection (not just the platform
   * kind) — e.g. `snowflake:prod` for a named CLI connection, `snowflake:ACME`
   * for a direct-credential connection to account `ACME`, or just `snowflake`
   * when nothing more specific is available. Used to tag extracted schema so
   * multiple source connections of the same platform type stay distinguishable.
   */
  public getConnectionId(): string {
    const ref = this.credentials['connectionName'] || this.credentials['profile'] || this.credentials['account']
      || this.credentials['workspaceUrl'] || this.credentials['username'] || '';
    return ref ? `${this.platform}:${ref}` : this.platform;
  }

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
   * Account-wide lineage is read once.
   */
  async extractMetadata(options?: ExtractOptions): Promise<SchemaSnapshot> {
    const scopes: Array<string | undefined> = options?.schemaFilter && options.schemaFilter.length > 0 ? [...options.schemaFilter] : [undefined];
    const parts: SchemaSnapshot[] = [];
    const tables = options?.tableFilter && options.tableFilter.length > 0 ? options.tableFilter : undefined;
    for (let i = 0; i < scopes.length; i++) {
      if (options?.signal?.aborted) break;
      if (scopes[i]) this.log(`[${this.platform}] Schema ${scopes[i]} (${i + 1}/${scopes.length})`);
      // Query-through for a few tables (Phase K2) never reads account-wide lineage.
      parts.push(await this.extractScope(this.getMetadataQueries(scopes[i], tables), options, i === 0 && !tables));
    }
    if (parts.length === 1) return parts[0];
    const lineage = parts.flatMap((p) => p.lineage ?? []);
    const reports = parts.map((p) => p.profiling).filter((r): r is ProfilingReport => !!r);
    return {
      ...(reports.length ? { profiling: { queries: reports.reduce((n, r) => n + r.queries, 0), budget: reports[0].budget, profiledTables: reports.reduce((n, r) => n + r.profiledTables, 0), skippedTables: reports.reduce((n, r) => n + r.skippedTables, 0) } } : {}),
      platform: this.platform,
      connectionId: this.getConnectionId(),
      extractedAt: parts[0]?.extractedAt ?? new Date().toISOString(),
      tables: parts.flatMap((p) => p.tables),
      views: parts.flatMap((p) => p.views),
      foreignKeys: parts.flatMap((p) => p.foreignKeys),
      lineage: lineage.length > 0 ? lineage : undefined
    };
  }

  private async extractScope(queries: PlatformMetadataQueries, options: ExtractOptions | undefined, withLineage: boolean): Promise<SchemaSnapshot> {
    const startTime = new Date().toISOString();

    this.log(`[${this.platform}] Extracting metadata...`);

    // 1. Fetch tables
    this.log(`[${this.platform}] Fetching tables...`);
    let tablesResult: QueryResult = { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };
    try {
      tablesResult = await this.executeQuery(queries.listTables, {
        timeoutMs: 60000,
        signal: options?.signal
      });
    } catch (err) {
      this.log(`[${this.platform}] Table listing failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Fetch columns — non-fatal: some catalog types (e.g. Databricks' legacy
    // `hive_metastore`) have no bulk, schema-wide column-introspection query at
    // all (no `information_schema` support), only a per-table DESCRIBE — degrade
    // to tables-without-column-detail rather than aborting the whole extraction.
    this.log(`[${this.platform}] Fetching columns...`);
    let columnsResult: QueryResult = { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };
    try {
      columnsResult = await this.executeQuery(queries.listColumns, {
        timeoutMs: 60000,
        signal: options?.signal
      });
    } catch (err) {
      this.log(`[${this.platform}] Column listing failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Fetch foreign keys
    this.log(`[${this.platform}] Fetching foreign keys...`);
    let fkResult: QueryResult = { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };
    try {
      fkResult = await this.executeQuery(queries.listForeignKeys, {
        timeoutMs: 30000,
        signal: options?.signal
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
        signal: options?.signal
      });
    } catch (err) {
      this.log(`[${this.platform}] View extraction failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    // 5. Assemble tables with columns (a table filter also applies client-side, for
    // platforms whose listing can't be filtered, e.g. Hive metastore's SHOW TABLES)
    const wanted = options?.tableFilter && options.tableFilter.length > 0 ? new Set(options.tableFilter.map((t) => t.toLowerCase())) : undefined;
    const tables = this.assembleTables(tablesResult, columnsResult).filter((t) => !wanted || wanted.has(t.name.toLowerCase()));

    // 6. Assemble views
    const views = this.assembleViews(viewsResult);

    // 7. Assemble foreign keys
    const foreignKeys = this.assembleForeignKeys(fkResult);

    // 8. Optional: profile columns (Phase K2: sampled, bounded, budgeted)
    let profiling: ProfilingReport | undefined;
    if (options?.includeProfiling && this.getCapabilities().supportsColumnProfiling) {
      profiling = await this.profileTables(tables, queries, options);
    }

    // 9. Optional: extract lineage
    let lineage: import('./types').LineageEdge[] | undefined;
    if (withLineage && queries.extractLineage && this.getCapabilities().supportsLineageExtraction) {
      try {
        const lineageResult = await this.executeQuery(queries.extractLineage, {
          timeoutMs: 60000,
          signal: options?.signal
        });
        lineage = this.assembleLineage(lineageResult);
      } catch (err) {
        this.log(`[${this.platform}] Lineage extraction failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.log(`[${this.platform}] Metadata extraction complete: ${tables.length} tables, ${views.length} views, ${foreignKeys.length} FKs`);

    return {
      platform: this.platform,
      connectionId: this.getConnectionId(),
      extractedAt: startTime,
      tables,
      views,
      foreignKeys,
      lineage,
      ...(profiling ? { profiling } : {})
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

  private assembleLineage(lineageResult: QueryResult): import('./types').LineageEdge[] {
    return (lineageResult.rows as Array<Record<string, unknown>>).map((r) => ({
      sourceFqn: String(r['source_fqn'] ?? r['SOURCE_FQN'] ?? ''),
      targetFqn: String(r['target_fqn'] ?? r['TARGET_FQN'] ?? ''),
      transformDescription: r['transform'] ? String(r['transform']) : undefined,
      queryText: r['query_text'] ? String(r['query_text']) : undefined
    }));
  }

  // ── Column Profiling (tier 2, Phase K2) ──

  /**
   * Profiles columns within limits (docs/context-layer-requirements.md §11
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
    const num = (r: Record<string, unknown>, k: string): number | undefined => {
      const v = r[k] ?? r[k.toUpperCase()];
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      return Number.isFinite(n) ? n : undefined;
    };
    type Task = { table: TableMetadata; run: () => Promise<void> };
    const tasks: Task[] = [];
    for (const table of tables) {
      const cols = table.columns.filter((c) => !skipTypes.some((t) => c.dataType.toUpperCase().includes(t)));
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
          ...(table.lastAltered ? { lastAltered: table.lastAltered } : {})
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