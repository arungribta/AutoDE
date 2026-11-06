import { BaseDataSourceAdapter } from '../BaseAdapter';
import { DataPlatformProvider } from '../../types';
import { ConnectionInfo, ExtractOptions, PlatformCapabilities, PlatformMetadataQueries, QueryOptions, QueryResult, SqlDialect } from '../types';
import { PlatformDefinition, PlatformOperation } from '../operations/types';
import { OperationRunner, runOperation, versionOf } from '../operations/execute';
import { identifier } from '../operations/bind';
import { CliCall, cliCall, connectionArgs, connectionEnv, runCliStatement } from '../cliStatement';
import { detectCliBinary } from '../credentials/cliDetection';
import { HttpCall, HttpOptions, httpConnection } from '../httpTransport';
import { FileCall, fileConnection } from '../fileTransport';
import { fill, fragmentsFor } from '../dialects';

/**
 * A platform with no adapter class (v0.55.0; docs/specs/platform-operations.md
 * §6.2): everything comes from its platform definition and operations. Statements
 * run through its CLI (`access.cli.statement`); the connection's fields are the
 * definition's (`connection`); the estate is read through the operations its
 * `estate` capability names, mapped to the column names the shared assembly reads;
 * profiling uses its dialect fragments. A read the account can't do is a gap, and
 * the other reads still run. Redshift is the first platform added this way.
 * POP5: a platform may have no statements at all: a catalog or semantic system is
 * reached through `http` and `file` operations, from the connection's base URL,
 * sign-in and folder. Such a connection has no SQL and no estate of tables.
 */

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
  /** POP5: where a relative folder is resolved (the workspace). */
  baseDir?: string;
  /** Tests: the http transport's options. */
  http?: HttpOptions;
}

export class DefinitionAdapter extends BaseDataSourceAdapter {
  private call?: CliCall;
  private httpCall?: HttpCall;
  private version: string | undefined;

  constructor(platform: DataPlatformProvider, credentials: Record<string, string>, log: (msg: string) => void, private readonly o: DefinitionAdapterOptions) {
    super(platform, credentials, log);
    this.call = o.call;
    this.useDefinition(o.definition, o.operation);
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
    if (!cli) throw new Error(`${this.def.title}'s platform definition names no CLI.`);
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
    this.call = cliCall(found.cliPath, connectionEnv(this.def.connection, this.credentials, cli.env), 300_000, cli.browserSignIn);
    return this.call;
  }

  /** POP5: the connection's API, when it names a base URL. */
  private http(): HttpCall | undefined {
    const api = this.def.access?.api;
    if (!this.def.transports.includes('http') || !api?.baseUrlField || !this.credentials[api.baseUrlField]) return undefined;
    this.httpCall ??= httpConnection(api, this.def.title, this.credentials, this.o.http);
    return this.httpCall;
  }

  /** POP5: the connection's bound folder, when it names one. */
  private file(): FileCall | undefined {
    const field = this.def.access?.file?.rootField;
    if (!this.def.transports.includes('file') || !field || !this.credentials[field]) return undefined;
    return fileConnection(this.credentials[field], this.def.title, this.o.baseDir);
  }

  /** POP5: `cli` operations, each kept to the platform's own CLI. */
  private cliOperation(): NonNullable<OperationRunner['cli']> {
    return async (argv) => {
      const command = this.def.access?.cli?.command;
      if (!command || argv[0] !== command) throw new Error(`Refused: ${this.def.title}'s operations run ${command ?? 'no CLI'}, not ${argv[0]}.`);
      return { stdout: await this.cli()([...argv.slice(1), ...connectionArgs(this.def.connection, this.credentials, 'every')]) };
    };
  }

  /** POP5: every way this connection reaches its platform, for the executor. */
  public operationRunner(options?: ExtractOptions): OperationRunner {
    const http = this.http(); const file = this.file();
    return {
      ...(this.def.access?.cli?.statement ? { sql: async (s: string, maxRows: number) => (await this.executeQuery(s, { maxRows, timeoutMs: 120_000, signal: options?.signal })).rows } : {}),
      ...(this.def.access?.cli ? { cli: this.cliOperation() } : {}),
      ...(http ? { http } : {}), ...(file ? { file } : {})
    };
  }

  async executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult> {
    const statement = this.def.access?.cli?.statement;
    if (!statement) throw new Error(`${this.def.title} takes no SQL: it is reached through its operations (autode platform operations --platform ${this.def.id}).`);
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

  private async run(id: string, params: Record<string, unknown>, options?: ExtractOptions) {
    const op = this.o.operation(id);
    if (!op) return { ok: false as const, rows: [] as Array<Record<string, unknown>>, gap: `the operation ${id} isn't in the catalog` };
    return runOperation({ operation: op, platformId: this.def.id, platform: this.def, params, runner: this.operationRunner(options), version: this.version, maxRows: 100_000, log: { connection: this.getConnectionId(), via: 'estate' } });
  }

  protected defaultScope(): { database: string; schema: string } {
    return { database: this.credentials['database'] ?? '', schema: this.credentials['schema'] ?? 'public' };
  }

  async connect(): Promise<ConnectionInfo> {
    this.checkFields();
    const http = this.http(); const file = this.file();
    if (!this.def.access?.cli?.statement && !http && !file) throw new Error(`${this.def.title} connection needs ${[this.def.access?.api?.baseUrlField, this.def.access?.file?.rootField].filter(Boolean).join(' or ')}.`);
    const versionId = this.def.versionOperation;
    const versionImpl = versionId ? this.o.operation(versionId)?.platforms[this.def.id] : undefined;
    // A connection with only a folder can't run an API's version read: the folder is checked instead.
    if (versionId && !(versionImpl?.http && !http)) {
      const r = await this.run(versionId, {});
      if (!r.ok) throw new Error(r.gap ?? 'the version could not be read');
      this.version = versionOf(r.rows[0]?.version);
    } else if (this.def.access?.cli?.statement) {
      await this.executeQuery('SELECT 1', { maxRows: 1, timeoutMs: 60_000 });
    }
    if (file) await file({ glob: '.autode-no-such-file', parse: 'json' }, 1);
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
      supportsMetadataExtraction: supported('estate'), supportsQueryExecution: !!this.def.access?.cli?.statement, supportsDdlGeneration: false,
      supportsColumnProfiling: supported('profiling'), supportsChangeDataCapture: false, supportsStreaming: false,
      maxQueryTimeoutMs: 300_000, supportedDialects: ['ansi']
    };
  }

  translateDialect(sql: string, _targetDialect: SqlDialect): string { return sql; }

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
    if (!this.def.capabilities['estate'] || this.def.capabilities['estate'].support === 'not_applicable') {
      throw new Error(`${this.def.title} is a ${this.def.category} system: it has no tables to read as an estate. What AutoDE reads from it is listed on its catalog page (autode platform catalog --platform ${this.def.id}).`);
    }
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
}
