import { BaseDataSourceAdapter } from '../BaseAdapter';
import { ConnectionInfo, PlatformCapabilities, PlatformMetadataQueries, QueryOptions, QueryResult, SqlDialect } from '../types';
import { resolveConnectString } from '../credentials/tnsnames';

/**
 * Oracle Database as a source (docs/specs/mcp-engine.md §9.1 Phase DRV1).
 *
 * Runs on `node-oracledb` ≥ 6 in **Thin mode** (pure JavaScript; Oracle 12.1
 * and later), which the user installs with AutoDE's guidance
 * (`driverStore.ts`). The adapter never imports the package itself: it is
 * handed a loader, and nothing is loaded before the first `connect()`.
 *
 * Credentials: `connectString` (a tnsnames alias or Easy Connect), `username`,
 * `password`, optional `configDir` (where tnsnames.ora lives; otherwise
 * TNS_ADMIN, then $ORACLE_HOME/network/admin) and `walletLocation` /
 * `walletPassword` for TLS wallets.
 *
 * A schema is an owner. Metadata comes from the ALL_* dictionary views, so it
 * covers what the connected user can see.
 */

/** The part of node-oracledb AutoDE uses. */
export interface OracleDriver {
  getConnection(config: Record<string, unknown>): Promise<OracleConnection>;
  OUT_FORMAT_OBJECT?: number;
  CLOB?: unknown;
  NCLOB?: unknown;
  fetchAsString?: unknown[];
  thin?: boolean;
}

export interface OracleConnection {
  execute(sql: string, binds: unknown[], options: Record<string, unknown>): Promise<{ rows?: unknown[]; metaData?: Array<{ name: string }>; rowsAffected?: number }>;
  close(): Promise<void>;
  callTimeout?: number;
  oracleServerVersionString?: string;
}

export interface OracleAdapterOptions {
  /** Loads the verified driver (`loadDriver(root, 'oracle')`); throws `DriverNotReadyError` with install guidance. */
  loadDriver: () => OracleDriver;
  env?: NodeJS.ProcessEnv;
}

const OUT_FORMAT_OBJECT = 4002;

const lit = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
/** Oracle identifiers as the dictionary stores them, quoted so mixed case and reserved words survive. */
const qid = (name: string) => `"${String(name).replace(/"/g, '""')}"`;
const qfqn = (fqn: string) => fqn.split('.').map(qid).join('.');

export class OracleAdapter extends BaseDataSourceAdapter {
  private session: OracleConnection | null = null;
  private driver: OracleDriver | null = null;
  private connectedDb = '';
  private connectedSchema = '';

  constructor(credentials: Record<string, string>, log: (msg: string) => void, private readonly options: OracleAdapterOptions) {
    super('oracle', credentials, log);
  }

  async connect(): Promise<ConnectionInfo> {
    const connectString = this.credentials['connectString'] || '';
    const user = this.credentials['username'] || '';
    if (!connectString || !user) throw new Error('An Oracle connection needs a connect string (a tnsnames alias or host:port/service) and a username.');
    const resolved = resolveConnectString(connectString, this.credentials['configDir'], this.options.env ?? process.env);
    if (resolved.problem) throw new Error(resolved.problem);
    if (resolved.warning) this.log(`[oracle] ${resolved.warning}`);
    this.driver = this.options.loadDriver();
    // Comments and view text can be CLOBs; fetch them as strings.
    if (this.driver.CLOB !== undefined) this.driver.fetchAsString = [this.driver.CLOB, ...(this.driver.NCLOB !== undefined ? [this.driver.NCLOB] : [])];
    const config: Record<string, unknown> = { user, password: this.credentials['password'] || undefined, connectString };
    if (resolved.configDir) config.configDir = resolved.configDir;
    if (this.credentials['walletLocation']) config.walletLocation = this.credentials['walletLocation'];
    if (this.credentials['walletPassword']) config.walletPassword = this.credentials['walletPassword'];
    try {
      this.session = await this.driver.getConnection(config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/NJS-138|not supported by node-oracledb in Thin mode/i.test(msg)) {
        throw new Error(`${msg} — this database is older than Oracle 12.1, which needs Thick mode and Oracle Instant Client; AutoDE supports Thin mode only.`);
      }
      throw err instanceof Error ? err : new Error(msg);
    }
    const info = await this.executeQuery(`SELECT SYS_CONTEXT('USERENV', 'CON_NAME') AS "db", SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS "schema" FROM dual`);
    const row = (info.rows[0] ?? {}) as Record<string, unknown>;
    this.connectedDb = String(row['db'] ?? '');
    this.connectedSchema = String(row['schema'] ?? user.toUpperCase());
    const version = this.session?.oracleServerVersionString ?? 'unknown';
    this.log(`[oracle] Connected to ${this.connectedDb} as ${this.connectedSchema} (Oracle ${version}, Thin mode).`);
    return { connected: true, platform: 'oracle', databaseName: this.connectedDb, schemaName: this.connectedSchema, version, capabilities: this.getCapabilities() };
  }

  async disconnect(): Promise<void> {
    const c = this.session;
    this.session = null;
    if (c) await c.close();
  }

  dispose(): void {
    this.disconnect().catch(() => undefined);
  }

  async executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult> {
    if (!this.session) throw new Error('Not connected to Oracle.');
    const started = Date.now();
    // Oracle rejects a trailing semicolon on SQL (PL/SQL blocks keep theirs).
    const text = /^\s*(BEGIN|DECLARE)\b/i.test(sql) ? sql : sql.replace(/;\s*$/, '');
    this.session.callTimeout = options?.timeoutMs ?? 0;
    const result = await this.session.execute(text, [], { outFormat: this.driver?.OUT_FORMAT_OBJECT ?? OUT_FORMAT_OBJECT, ...(options?.maxRows ? { maxRows: options.maxRows } : {}) });
    const rows = (result.rows ?? []).map((r) => Object.fromEntries(Object.entries(r as Record<string, unknown>).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])));
    const columns = (result.metaData ?? []).map((m) => m.name);
    return { columns: columns.length ? columns : Object.keys(rows[0] ?? {}), rows, rowCount: rows.length, executionTimeMs: Date.now() - started };
  }

  /** Oracle has one database per connection (a PDB); this is it. */
  async listDatabases(): Promise<string[]> {
    return this.connectedDb ? [this.connectedDb] : [];
  }

  /** Schemas (owners) that are not Oracle-maintained (12.1+). */
  async listSchemas(_database: string): Promise<string[]> {
    const result = await this.executeQuery(`SELECT username AS "name" FROM all_users WHERE oracle_maintained = 'N' ORDER BY username`);
    return result.rows.map((r) => this.firstColumnValue(r as Record<string, unknown>, ['name', 'NAME', 'USERNAME'])).filter(Boolean);
  }

  getCapabilities(): PlatformCapabilities {
    return {
      supportsMetadataExtraction: true,
      supportsQueryExecution: true,
      supportsDdlGeneration: false,
      supportsColumnProfiling: true,
      supportsChangeDataCapture: false,
      supportsStreaming: false,
      maxQueryTimeoutMs: 300000,
      supportedDialects: ['ansi']
    };
  }

  /** `scope` is `OWNER` or `DATABASE.OWNER` (the database part is the connected one). */
  getMetadataQueries(scope?: string, tables?: string[]): PlatformMetadataQueries {
    const parts = scope ? scope.split('.') : [];
    const owner = (parts.length > 0 ? parts[parts.length - 1] : this.connectedSchema).toUpperCase();
    const ownerIs = (col: string) => `${col} = ${lit(owner)}`;
    const only = (col: string) => (tables && tables.length > 0 ? ` AND UPPER(${col}) IN (${tables.map((t) => lit(t.toUpperCase())).join(', ')})` : '');
    const dataType = `CASE
          WHEN c.data_type IN ('VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR') THEN c.data_type || '(' || c.char_length || ')'
          WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL THEN 'NUMBER(' || c.data_precision || ',' || NVL(c.data_scale, 0) || ')'
          WHEN c.data_type = 'RAW' THEN 'RAW(' || c.data_length || ')'
          ELSE c.data_type END`;
    return {
      listTables: `
        SELECT t.owner AS "table_schema", t.table_name AS "table_name", 'TABLE' AS "table_type", t.num_rows AS "row_count",
               o.last_ddl_time AS "last_altered", m.comments AS "comment"
        FROM all_tables t
        LEFT JOIN all_tab_comments m ON m.owner = t.owner AND m.table_name = t.table_name
        LEFT JOIN all_objects o ON o.owner = t.owner AND o.object_name = t.table_name AND o.object_type = 'TABLE'
        WHERE ${ownerIs('t.owner')} AND t.nested = 'NO' AND t.secondary = 'N'${only('t.table_name')}
        UNION ALL
        SELECT v.owner, v.view_name, 'VIEW', NULL, o.last_ddl_time, m.comments
        FROM all_views v
        LEFT JOIN all_tab_comments m ON m.owner = v.owner AND m.table_name = v.view_name
        LEFT JOIN all_objects o ON o.owner = v.owner AND o.object_name = v.view_name AND o.object_type = 'VIEW'
        WHERE ${ownerIs('v.owner')}${only('v.view_name')}
        ORDER BY 2`,

      lastAltered: `
        SELECT owner AS "table_schema", object_name AS "table_name", last_ddl_time AS "last_altered"
        FROM all_objects
        WHERE ${ownerIs('owner')} AND object_type IN ('TABLE', 'VIEW')${only('object_name')}`,

      listColumns: `
        SELECT c.owner AS "table_schema", c.table_name AS "table_name", c.column_name AS "column_name",
               ${dataType} AS "data_type",
               CASE c.nullable WHEN 'Y' THEN 'YES' ELSE 'NO' END AS "is_nullable",
               c.column_id AS "ordinal_position", m.comments AS "comment"
        FROM all_tab_columns c
        LEFT JOIN all_col_comments m ON m.owner = c.owner AND m.table_name = c.table_name AND m.column_name = c.column_name
        WHERE ${ownerIs('c.owner')}${only('c.table_name')}
        ORDER BY c.table_name, c.column_id`,

      listPrimaryKeys: `
        SELECT k.owner AS "table_schema", k.table_name AS "table_name", kc.column_name AS "column_name"
        FROM all_constraints k
        JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name
        WHERE k.constraint_type = 'P' AND ${ownerIs('k.owner')}${only('k.table_name')}`,

      listForeignKeys: `
        SELECT c.owner AS "source_schema", c.table_name AS "source_table", cc.column_name AS "source_column",
               r.owner AS "target_schema", r.table_name AS "target_table", rc.column_name AS "target_column",
               c.constraint_name AS "constraint_name"
        FROM all_constraints c
        JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
        JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name
        JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name AND rc.position = cc.position
        WHERE c.constraint_type = 'R' AND (${ownerIs('c.owner')} OR ${ownerIs('r.owner')})`,

      listViews: `
        SELECT owner AS "table_schema", view_name AS "table_name", text AS "view_definition"
        FROM all_views
        WHERE ${ownerIs('owner')}
        ORDER BY view_name`,

      profileColumn: (fqn: string, col: string) => `
        SELECT COUNT(DISTINCT ${qid(col)}) AS distinct_count, COUNT(*) - COUNT(${qid(col)}) AS null_count,
               MIN(${qid(col)}) AS min_value, MAX(${qid(col)}) AS max_value
        FROM ${qfqn(fqn)}`,

      profileTable: (fqn: string, cols: string[], sampleRows: number) => `
        SELECT COUNT(*) AS row_count${cols.map((c, i) => `, COUNT(DISTINCT ${qid(c)}) AS d_${i}, COUNT(*) - COUNT(${qid(c)}) AS n_${i}`).join('')}
        FROM (SELECT * FROM ${qfqn(fqn)} FETCH FIRST ${Math.max(1, Math.floor(sampleRows))} ROWS ONLY) s0`
    };
  }

  translateDialect(sql: string, _targetDialect: SqlDialect): string {
    return sql;
  }
}
