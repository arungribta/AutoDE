import { BaseDataSourceAdapter, EstateReads } from '../BaseAdapter';
import { DataPlatformProvider } from '../../types';
import { ConnectionInfo, ExtractOptions, PlatformCapabilities, PlatformMetadataQueries, QueryOptions, QueryResult, SqlDialect } from '../types';
import { PlatformDefinition, PlatformOperation } from '../operations/types';
import { runOperation, versionOf } from '../operations/execute';
import { identifier } from '../operations/bind';
import { CliCall, cliCall, connectionArgs, connectionEnv, runCliStatement } from '../cliStatement';
import { detectCliBinary } from '../credentials/cliDetection';
import { fill, fragmentsFor } from '../dialects';

/**
 * A platform with no adapter class (v0.55.0; docs/specs/platform-operations.md
 * §6.2): everything comes from its platform definition and operations. Statements
 * run through its CLI (`access.cli.statement`); the connection's fields are the
 * definition's (`connection`); the estate is read through the operations its
 * `estate` capability names, mapped to the column names the shared assembly reads;
 * profiling uses its dialect fragments. A read the account can't do is a gap, and
 * the other reads still run. Redshift is the first platform added this way.
 */

/** The estate reads, by the operation that serves each. */
const ESTATE_OPERATIONS = {
  tables: 'estate.list_tables', columns: 'estate.list_columns', views: 'estate.list_views',
  primaryKeys: 'estate.list_primary_keys', foreignKeys: 'estate.list_foreign_keys'
} as const;

export interface DefinitionAdapterOptions {
  definition: PlatformDefinition;
  /** The operation in effect with this id (shipped, or the team's approved file). */
  operation: (id: string) => PlatformOperation | undefined;
  /** The person's consent for AutoDE to run the platform's CLI. */
  cliConsent: boolean;
  /** Tests: the CLI call (no process). */
  call?: CliCall;
  /** Tests: the wait between polls. */
  sleep?: (ms: number) => Promise<void>;
}

const EMPTY: QueryResult = { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };

export class DefinitionAdapter extends BaseDataSourceAdapter {
  private call?: CliCall;
  private version: string | undefined;

  constructor(platform: DataPlatformProvider, credentials: Record<string, string>, log: (msg: string) => void, private readonly o: DefinitionAdapterOptions) {
    super(platform, credentials, log);
    this.call = o.call;
  }

  private get def(): PlatformDefinition { return this.o.definition; }

  public getConnectionId(): string {
    const ref = (this.def.connection?.idFields ?? []).map((f) => this.credentials[f]).find((v) => !!v);
    return ref ? `${this.platform}:${ref}` : super.getConnectionId();
  }

  /** The CLI, found once: a path given with the connection, the PATH, or the vendor's install folder. */
  private cli(): CliCall {
    if (this.call) return this.call;
    const cli = this.def.access?.cli;
    if (!cli?.statement) throw new Error(`${this.def.title}'s platform definition says no way to run a statement.`);
    if (!this.o.cliConsent) throw new Error(`${this.def.title} is reached through its CLI (${cli.command}), which AutoDE runs only with your consent: turn on autoDataEngineeringHub.dataPlatformCliConsent in VS Code, or start the MCP server or CLI with --allow-cli.`);
    const os = process.platform === 'win32' ? 'win32' : 'default';
    const found = detectCliBinary({
      displayName: this.def.title,
      binaryNames: { win32: cli.binary?.win32 ?? cli.command, default: cli.binary?.default ?? cli.command },
      explicitPathSetting: this.credentials['cliPath'],
      versionArgs: cli.versionArgs,
      installHint: cli.install ?? '',
      wellKnownDirs: cli.wellKnownDirs?.[os]
    });
    if (!found.found || !found.cliPath) throw new Error(found.error ?? `${cli.command} was not found.`);
    this.call = cliCall(found.cliPath, connectionEnv(this.def.connection, this.credentials, cli.env), 300_000);
    return this.call;
  }

  async executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult> {
    const statement = this.def.access?.cli?.statement;
    if (!statement) throw new Error(`${this.def.title}'s platform definition says no way to run a statement.`);
    const connection = { every: connectionArgs(this.def.connection, this.credentials, 'every'), submit: connectionArgs(this.def.connection, this.credentials, 'submit') };
    return runCliStatement(statement, this.cli(), sql, connection, { timeoutMs: options?.timeoutMs, signal: options?.signal, maxRows: options?.maxRows, sleep: this.o.sleep });
  }

  /** What the definition says a connection needs, checked before anything runs. */
  private checkFields(): void {
    const c = this.def.connection;
    if (!c) return;
    const missing = c.fields.filter((f) => f.required && !this.credentials[f.name]).map((f) => f.label);
    for (const group of c.exactlyOne ?? []) {
      const given = group.filter((f) => !!this.credentials[f]);
      const label = (f: string) => c.fields.find((x) => x.name === f)?.label ?? f;
      if (given.length !== 1) missing.push(`exactly one of ${group.map(label).join(' or ')}${given.length > 1 ? ` (${given.length} given)` : ''}`);
    }
    if (missing.length) throw new Error(`${this.def.title} connection needs: ${missing.join('; ')}.`);
  }

  private runner(options?: ExtractOptions) {
    return { sql: async (s: string, maxRows: number) => (await this.executeQuery(s, { maxRows, timeoutMs: 120_000, signal: options?.signal })).rows };
  }

  private async run(id: string, params: Record<string, unknown>, options?: ExtractOptions) {
    const op = this.o.operation(id);
    if (!op) return { ok: false as const, rows: [] as Array<Record<string, unknown>>, gap: `the operation ${id} isn't in the catalog` };
    return runOperation({ operation: op, platformId: this.def.id, platform: this.def, params, runner: this.runner(options), version: this.version, maxRows: 100_000 });
  }

  async connect(): Promise<ConnectionInfo> {
    this.checkFields();
    const versionId = this.def.versionOperation;
    if (versionId) {
      const r = await this.run(versionId, {});
      if (!r.ok) throw new Error(r.gap ?? 'the version could not be read');
      this.version = versionOf(r.rows[0]?.version);
    } else {
      await this.executeQuery('SELECT 1', { maxRows: 1, timeoutMs: 60_000 });
    }
    return {
      connected: true, platform: this.platform,
      databaseName: this.credentials['database'] ?? '', schemaName: this.credentials['schema'] ?? '',
      version: this.version ?? 'unknown', capabilities: this.getCapabilities()
    };
  }

  async disconnect(): Promise<void> { /* every statement is its own CLI call: nothing to close */ }
  dispose(): void { /* nothing held */ }

  getCapabilities(): PlatformCapabilities {
    const supported = (cap: string) => !!this.def.capabilities[cap] && this.def.capabilities[cap].support !== 'not_applicable';
    return {
      supportsMetadataExtraction: supported('estate'), supportsQueryExecution: true, supportsDdlGeneration: false,
      supportsColumnProfiling: supported('profiling'), supportsChangeDataCapture: false, supportsStreaming: false,
      maxQueryTimeoutMs: 300_000, supportedDialects: ['ansi']
    };
  }

  translateDialect(sql: string, _targetDialect: SqlDialect): string { return sql; }

  private estateOps(): string[] { return this.def.capabilities.estate?.operations ?? []; }

  /** `DATABASE.SCHEMA` or `SCHEMA`; the connection's database (and schema) where the scope doesn't say. */
  private scopeParams(scope: string | undefined): { database: string; schema: string } {
    const parts = scope ? scope.split('.') : [];
    return {
      database: parts.length > 1 ? parts[0] : this.credentials['database'] ?? '',
      schema: parts.length ? parts[parts.length - 1] : this.credentials['schema'] ?? 'public'
    };
  }

  async listDatabases(): Promise<string[]> {
    const r = await this.run('estate.list_databases', {});
    if (!r.ok) throw new Error(r.gap ?? 'the databases could not be listed');
    return r.rows.map((x) => String(x.name ?? '')).filter(Boolean);
  }

  async listSchemas(database: string): Promise<string[]> {
    const r = await this.run('estate.list_schemas', { database });
    if (!r.ok) throw new Error(r.gap ?? 'the schemas could not be listed');
    return r.rows.map((x) => String(x.name ?? '')).filter(Boolean);
  }

  /** Only profiling is a query here; the estate's reads are its operations (readEstate). */
  getMetadataQueries(): PlatformMetadataQueries {
    const d = this.def.dialect ?? {};
    const f = fragmentsFor(this.def.id);
    const col = (c: string) => identifier(c, d);
    const sampled = (fqn: string, n: number) => fill(f.sample, { table: identifier(fqn, d), n: String(Math.max(1, Math.floor(n))) });
    return {
      listTables: '', listColumns: '', listForeignKeys: '', listViews: '',
      profileColumn: (fqn, c) => `SELECT COUNT(DISTINCT ${col(c)}) AS distinct_count, COUNT(*) - COUNT(${col(c)}) AS null_count FROM ${identifier(fqn, d)}`,
      profileTable: (fqn, cols, n) => `SELECT COUNT(*) AS row_count${cols.map((c, i) => `, COUNT(DISTINCT ${col(c)}) AS d_${i}, COUNT(*) - COUNT(${col(c)}) AS n_${i}`).join('')} FROM ${sampled(fqn, n)}`
    };
  }

  protected async readEstate(_queries: PlatformMetadataQueries, scope: string | undefined, options: ExtractOptions | undefined): Promise<EstateReads> {
    const params = this.scopeParams(scope);
    const listed = new Set(this.estateOps());
    const gaps: string[] = [];
    const read = async (id: string): Promise<QueryResult> => {
      if (!listed.has(id)) return EMPTY;
      this.log(`[${this.platform}] ${id} (${params.database}.${params.schema})…`);
      const r = await this.run(id, params, options);
      if (!r.ok) { gaps.push(`${id}: ${r.gap}`); this.log(`[${this.platform}] ${id} not read: ${r.gap}`); return EMPTY; }
      return { columns: r.rows[0] ? Object.keys(r.rows[0]) : [], rows: r.rows, rowCount: r.rows.length, executionTimeMs: 0 };
    };
    const tables = await read(ESTATE_OPERATIONS.tables);
    // Row counts and sizes, where the platform keeps them apart from the table list.
    const stats = await read('estate.table_stats');
    if (stats.rows.length) {
      const key = (r: Record<string, unknown>) => `${String(r.table_schema ?? '')}.${String(r.table_name ?? '')}`.toLowerCase();
      const byTable = new Map(stats.rows.map((r) => [key(r), r]));
      for (const t of tables.rows) {
        const s = byTable.get(key(t));
        if (s) { if (s.row_count !== null && s.row_count !== undefined) t.row_count = s.row_count; if (s.bytes !== null && s.bytes !== undefined) t.bytes = s.bytes; }
      }
    }
    return {
      tables,
      columns: await read(ESTATE_OPERATIONS.columns),
      views: await read(ESTATE_OPERATIONS.views),
      primaryKeys: await read(ESTATE_OPERATIONS.primaryKeys),
      foreignKeys: await read(ESTATE_OPERATIONS.foreignKeys),
      gaps
    };
  }

  /** Refresh on use, where the platform's estate has a last-altered operation. */
  async readLastAltered(scope: string | undefined, tables: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.estateOps().includes('estate.last_altered')) return out;
    const params = this.scopeParams(scope);
    const r = await this.run('estate.last_altered', params);
    const wanted = new Set(tables.map((t) => t.toLowerCase()));
    for (const row of r.ok ? r.rows : []) {
      const name = String(row.table_name ?? ''); const at = row.last_altered;
      if (!name || at === null || at === undefined || (wanted.size && !wanted.has(name.toLowerCase()))) continue;
      out.set(`${params.database}.${String(row.table_schema ?? '')}.${name}`.toLowerCase(), String(at));
      out.set(`${String(row.table_schema ?? '')}.${name}`.toLowerCase(), String(at));
    }
    return out;
  }
}
