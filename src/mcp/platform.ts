import { ConnectionManager, ConnectionManagerOptions } from '../engine/platform/ConnectionManager';
import { ConnectionEntry, ConnectionsConfig, envStandInVariables, loadConnectionsConfig, resolveConnectionCredentials } from '../engine/platform/connectionsConfig';
import { registerBuiltInCredentialResolvers } from '../engine/platform/credentials';
import { gateQueryResult, sanitizeSnapshot } from '../engine/platform/sampleData';
import { checkReadOnlySql, checkSingleStatement, stripTrailingSemicolon } from '../engine/platform/sqlGuard';
import { EngineToolError } from './errors';
import { EngineTool, ToolAnnotations } from './tools';

/**
 * The data-platform tools (docs/mcp-engine-requirements.md §5.3, §6; phase 4).
 *
 * Connections come from `.autode/config/connections.yaml`, the personal
 * `.autode/local/connections.yaml` and the `AUTODE_*` environment
 * (connectionsConfig.ts); credentials only through the engine's own resolvers
 * (env vars, the platform CLI's configuration) — never VS Code's secret store,
 * which a server started by another client cannot read: a `resolver: vscode`
 * entry takes its secret from the same-named env variables here. When the
 * extension starts the server (phase 5) it passes SecretStorage values as the
 * same environment variables.
 *
 * Queries are read-only unless the server was started with `--allow-write`,
 * and row values are withheld unless the connection allows sample data in
 * prompts: whatever a tool returns goes into the calling agent's prompt.
 */

export interface PlatformOptions {
  workspaceRoot: string;
  /** `--allow-write`: statements other than SELECT / WITH / SHOW / DESCRIBE / EXPLAIN may run. */
  allowWrite: boolean;
  /** `--allow-cli`: consent to run the platform's CLI (Snowflake named connections, username/password). */
  allowCli: boolean;
  /** `--drivers <folder>`: where user-installed drivers live (default: `AUTODE_DRIVERS_DIR`, else `~/.autode/drivers`). */
  driversRoot?: string;
  log: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Tests: a manager with fake adapters registered. It must be built with the options it is given (consent). */
  createManager?: (log: (msg: string) => void, options: ConnectionManagerOptions) => ConnectionManager;
}

export const DEFAULT_MAX_ROWS = 100;
export const MAX_ROWS_CAP = 10_000;
const DEFAULT_TIMEOUT_S = 60;
const MAX_PLAN_ROWS = 500;
const TEST_QUERY_ORACLE = `SELECT SYS_CONTEXT('USERENV', 'CON_NAME') AS "database", SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS "schema", (SELECT version FROM product_component_version WHERE ROWNUM = 1) AS "version" FROM dual`;

/** Maps a platform failure to the §5.6 envelope. Raw text goes into `details` (redacted and truncated by `toEnvelope`). */
export function classifyPlatformError(err: unknown, connectionId: string, phase: 'connect' | 'query'): EngineToolError {
  if (err instanceof EngineToolError) return err;
  const raw = err instanceof Error ? err.message : String(err);
  const details = { connectionId, raw };
  if (/CLI-execution consent|dataPlatformCliConsent/i.test(raw)) {
    return new EngineToolError('PERMISSION_DENIED', `Connection "${connectionId}" runs through the platform CLI, which needs consent: start the server with --allow-cli.`, details);
  }
  if (/\b401\b|authenticat|unauthori[sz]ed|invalid (user|token|credential|password|jwt)|incorrect username or password|jwt|expired token|private key|passphrase/i.test(raw)) {
    return new EngineToolError('AUTH_FAILED', `Authentication to "${connectionId}" failed.`, details);
  }
  if (/\b403\b|permission|insufficient privileges|not authori[sz]ed|access denied|forbidden/i.test(raw)) {
    return new EngineToolError('PERMISSION_DENIED', `The principal of "${connectionId}" lacks a privilege this needs.`, details);
  }
  if (/timed? ?out|timeout|ETIMEDOUT/i.test(raw)) {
    return new EngineToolError('TIMEOUT', `"${connectionId}" did not answer in time.`, details, true);
  }
  if (phase === 'connect') {
    return new EngineToolError('CONNECTION_FAILED', `Could not connect to "${connectionId}".`, details, /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|network/i.test(raw));
  }
  return new EngineToolError('PLATFORM_ERROR', `The statement failed on "${connectionId}".`, details);
}

async function withTimeout<T>(seconds: number, connectionId: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new EngineToolError('TIMEOUT', `"${connectionId}" did not finish within ${seconds} s.`, { connectionId, timeoutSeconds: seconds }, true));
    }, seconds * 1000);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Live connections of one server process, opened on first use and kept until the server exits. */
export class PlatformSession {
  private readonly live = new Map<string, Promise<ConnectionManager>>();

  public constructor(public readonly options: PlatformOptions) {
    registerBuiltInCredentialResolvers();
  }

  public config(): ConnectionsConfig {
    return loadConnectionsConfig(this.options.workspaceRoot, this.options.env ?? process.env);
  }

  public entry(connectionId: string): ConnectionEntry {
    const config = this.config();
    const entry = config.connections.find((c) => c.id === connectionId) ?? config.connections.find((c) => c.id.toLowerCase() === connectionId.toLowerCase());
    if (!entry) {
      throw new EngineToolError('NOT_FOUND', `No connection "${connectionId}". Use autode_list_connections; connections are defined in ${config.file} or by AUTODE_* environment variables.`, { known: config.connections.map((c) => c.id), configErrors: config.errors });
    }
    return entry;
  }

  /** The connection's sample-data consent as the file says now (edits apply without a restart). */
  public consent(connectionId: string): boolean {
    return this.config().connections.find((c) => c.id === connectionId)?.allowSampleDataInPrompts === true;
  }

  /** The connected manager for an entry; a failed connect is forgotten so the next call retries. */
  public async connect(entry: ConnectionEntry, fresh = false): Promise<ConnectionManager> {
    if (fresh) await this.drop(entry.id);
    let pending = this.live.get(entry.id);
    if (!pending) {
      pending = (async () => {
        const log = (msg: string) => this.options.log(`[${entry.id}] ${msg}`);
        const managerOptions: ConnectionManagerOptions = { cliConsent: () => this.options.allowCli, sampleDataConsent: () => this.consent(entry.id), driversRoot: () => this.options.driversRoot };
        const manager = this.options.createManager?.(log, managerOptions) ?? new ConnectionManager(log, managerOptions);
        try {
          const credentials = await resolveConnectionCredentials(entry, this.options.env ?? process.env);
          await withTimeout(DEFAULT_TIMEOUT_S, entry.id, () => manager.connect(entry.platform, credentials));
          return manager;
        } catch (err) {
          manager.dispose();
          throw classifyPlatformError(err, entry.id, 'connect');
        }
      })();
      this.live.set(entry.id, pending);
      pending.catch(() => { if (this.live.get(entry.id) === pending) this.live.delete(entry.id); });
    }
    return pending;
  }

  private async drop(id: string): Promise<void> {
    const pending = this.live.get(id);
    this.live.delete(id);
    if (pending) {
      try { (await pending).dispose(); } catch { /* it never connected */ }
    }
  }

  /** Runs an approved platform change (Phase PA1) — the only path for a write; needs --allow-write. */
  public async executeApprovedChange(connectionId: string, sql: string): Promise<string> {
    if (!this.options.allowWrite) throw new EngineToolError('WRITE_NOT_ALLOWED', 'This server was not started with --allow-write, so it applies no platform change.');
    const entry = this.entry(connectionId);
    const manager = await this.connect(entry);
    try {
      const result = await withTimeout(DEFAULT_TIMEOUT_S, entry.id, () => manager.executeQuery(stripTrailingSemicolon(sql), { maxRows: 1, timeoutMs: DEFAULT_TIMEOUT_S * 1000 }));
      return `done in ${result.executionTimeMs} ms`;
    } catch (err) {
      throw classifyPlatformError(err, entry.id, 'query');
    }
  }

  public dispose(): void {
    for (const pending of this.live.values()) pending.then((m) => m.dispose(), () => undefined);
    this.live.clear();
  }
}

function annotations(title: string, opts: { readOnly: boolean }): ToolAnnotations {
  return { title, readOnlyHint: opts.readOnly, destructiveHint: !opts.readOnly, idempotentHint: opts.readOnly, openWorldHint: true };
}

const connectionIdSchema = { type: 'string', minLength: 1, description: 'A connection id from autode_list_connections (e.g. snowflake:prod).' };

function authModeOf(entry: ConnectionEntry): string {
  if (entry.fields.authMode) return entry.fields.authMode;
  if (entry.credentials.resolver === 'cli') return entry.platform === 'snowflake' ? 'connections-toml' : 'databrickscfg';
  if (entry.platform === 'oracle') return entry.fields.walletLocation ? 'password+wallet' : 'password';
  return entry.platform === 'databricks' ? 'pat' : 'key-pair';
}

/** The §5.3 tools over one session. Annotations reflect the session's write permission. */
export function platformTools(session: PlatformSession): EngineTool[] {
  const { allowWrite } = session.options;
  const run = async <T>(connectionId: string, f: (m: ConnectionManager, entry: ConnectionEntry) => Promise<T>, timeoutSeconds = DEFAULT_TIMEOUT_S): Promise<T> => {
    const entry = session.entry(connectionId);
    const manager = await session.connect(entry);
    try {
      return await withTimeout(timeoutSeconds, entry.id, () => f(manager, entry));
    } catch (err) {
      throw classifyPlatformError(err, entry.id, 'query');
    }
  };

  return [
    {
      name: 'autode_list_connections',
      description: 'List the data-platform connections this server can use: id, platform, role (source/target), auth mode, where credentials come from, and whether sample data may be returned. Never secrets.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { ...annotations('List connections', { readOnly: true }), openWorldHint: false },
      handler: async () => {
        const config = session.config();
        return {
          connections: config.connections.map((c) => ({
            id: c.id, platform: c.platform, role: c.role, authMode: authModeOf(c),
            credentials: { resolver: c.credentials.resolver, ref: c.credentials.ref || 'default' },
            allowSampleDataInPrompts: c.allowSampleDataInPrompts, origin: c.origin,
            // Phase DRV2: a secret kept in VS Code's secret storage reaches this server only through these variables.
            ...(c.credentials.resolver === 'vscode' ? { secretFromEnv: envStandInVariables(c) } : {})
          })),
          configFile: config.file,
          configFileExists: config.fileExists,
          configErrors: config.errors,
          writeAllowed: allowWrite,
          cliAllowed: session.options.allowCli
        };
      }
    },
    {
      name: 'autode_test_connection',
      description: 'Connect (afresh) to a configured connection and report the database, schema and platform version it lands in.',
      inputSchema: { type: 'object', required: ['connectionId'], additionalProperties: false, properties: { connectionId: connectionIdSchema } },
      annotations: annotations('Test a connection', { readOnly: true }),
      handler: async (args) => {
        const entry = session.entry(String(args.connectionId));
        const manager = await session.connect(entry, true);
        const probe = await run(entry.id, async (m) => m.executeQuery(entry.platform === 'oracle' ? TEST_QUERY_ORACLE : entry.platform === 'databricks' ? 'SELECT current_catalog() AS database, current_schema() AS schema, current_version() AS version' : 'SELECT CURRENT_DATABASE() AS DATABASE, CURRENT_SCHEMA() AS SCHEMA, CURRENT_VERSION() AS VERSION', { maxRows: 1 })).catch(() => undefined);
        const row = (probe?.rows[0] ?? {}) as Record<string, unknown>;
        const pick = (k: string) => row[k] ?? row[k.toUpperCase()] ?? null;
        return { connectionId: entry.id, connected: manager.isConnected(), platform: entry.platform, role: entry.role, database: pick('database'), schema: pick('schema'), version: pick('version') };
      }
    },
    {
      name: 'autode_list_databases',
      description: 'List the databases (Databricks: catalogs) the connection\'s principal can see.',
      inputSchema: { type: 'object', required: ['connectionId'], additionalProperties: false, properties: { connectionId: connectionIdSchema } },
      annotations: annotations('List databases', { readOnly: true }),
      handler: async (args) => ({ connectionId: args.connectionId, databases: await run(String(args.connectionId), (m) => m.listDatabases()) })
    },
    {
      name: 'autode_list_schemas',
      description: 'List the schemas of one database (Databricks: catalog).',
      inputSchema: { type: 'object', required: ['connectionId', 'database'], additionalProperties: false, properties: { connectionId: connectionIdSchema, database: { type: 'string', minLength: 1 } } },
      annotations: annotations('List schemas', { readOnly: true }),
      handler: async (args) => ({ connectionId: args.connectionId, database: args.database, schemas: await run(String(args.connectionId), (m) => m.listSchemas(String(args.database))) })
    },
    {
      name: 'autode_extract_metadata',
      description: 'Extract the structure of one schema: tables, columns, keys, views (and, with profile, sampled distinct/null counts). Row values (profile min/max, query-history text) are left out unless the connection allows sample data.',
      inputSchema: {
        type: 'object', required: ['connectionId', 'database', 'schema'], additionalProperties: false,
        properties: {
          connectionId: connectionIdSchema,
          database: { type: 'string', minLength: 1 },
          schema: { type: 'string', minLength: 1 },
          tables: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 500, description: 'Only these tables (names in the schema).' },
          profile: { type: 'boolean', description: 'Also profile columns (sampled, bounded number of queries). Default false.' }
        }
      },
      annotations: annotations('Extract metadata', { readOnly: true }),
      handler: async (args) => {
        const snapshot = await run(String(args.connectionId), async (m, entry) => {
          const raw = await m.extractMetadata({
            schemaFilter: [`${String(args.database)}.${String(args.schema)}`],
            tableFilter: args.tables as string[] | undefined,
            includeProfiling: args.profile === true
          });
          // The manager applied the consent already; applying it again costs nothing and keeps the tool safe on its own.
          return sanitizeSnapshot(raw, entry.allowSampleDataInPrompts);
        }, 300);
        return { ...(snapshot as unknown as Record<string, unknown>), connectionId: args.connectionId };
      }
    },
    {
      name: 'autode_explain_sql',
      description: 'Dry-run one statement with EXPLAIN: the platform compiles it and returns the plan without running it. Use it to check generated SQL (including DDL/DML) before anyone executes it.',
      inputSchema: { type: 'object', required: ['connectionId', 'sql'], additionalProperties: false, properties: { connectionId: connectionIdSchema, sql: { type: 'string', minLength: 1, description: 'One statement, without EXPLAIN.' } } },
      annotations: annotations('Explain SQL', { readOnly: true }),
      handler: async (args) => {
        const check = checkSingleStatement(String(args.sql));
        if (!check.ok) throw new EngineToolError('VALIDATION_FAILED', check.reason ?? 'Not a single statement.');
        if (check.firstKeyword === 'EXPLAIN') throw new EngineToolError('VALIDATION_FAILED', 'Pass the statement without EXPLAIN; the tool adds it.');
        const entry = session.entry(String(args.connectionId));
        const body = stripTrailingSemicolon(String(args.sql));
        // Oracle writes the plan to the session's PLAN_TABLE and reads it back; the others return it directly.
        const result = await run(entry.id, async (m) => {
          if (entry.platform !== 'oracle') return m.executeQuery(`${entry.platform === 'snowflake' ? 'EXPLAIN USING TEXT' : 'EXPLAIN'} ${body}`, { maxRows: MAX_PLAN_ROWS });
          await m.executeQuery(`EXPLAIN PLAN FOR ${body}`);
          return m.executeQuery('SELECT plan_table_output AS "plan" FROM TABLE(DBMS_XPLAN.DISPLAY())', { maxRows: MAX_PLAN_ROWS });
        });
        return { connectionId: entry.id, statement: check.firstKeyword, columns: result.columns, plan: result.rows };
      }
    },
    {
      name: 'autode_execute_query',
      description: 'Run one read-only statement (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN); anything else is refused — propose a change with autode_propose_platform_change instead. Row values are returned only if the connection allows sample data (otherwise just columns and the row count); personal-data columns are masked.',
      inputSchema: {
        type: 'object', required: ['connectionId', 'sql'], additionalProperties: false,
        properties: {
          connectionId: connectionIdSchema,
          sql: { type: 'string', minLength: 1, description: 'Exactly one statement.' },
          maxRows: { type: 'integer', minimum: 1, maximum: MAX_ROWS_CAP, description: `Rows to return (default ${DEFAULT_MAX_ROWS}, at most ${MAX_ROWS_CAP}).` },
          timeoutSeconds: { type: 'integer', minimum: 1, maximum: 600, description: `Default ${DEFAULT_TIMEOUT_S}.` }
        }
      },
      annotations: annotations('Execute a query', { readOnly: true }),
      handler: async (args) => {
        const sql = String(args.sql);
        const single = checkSingleStatement(sql);
        if (!single.ok) throw new EngineToolError('VALIDATION_FAILED', single.reason ?? 'Not a single statement.');
        // Phase PA1: a write is never run directly, with or without --allow-write; it is proposed and approved by a person.
        const check = checkReadOnlySql(sql);
        if (!check.ok) throw new EngineToolError('WRITE_NOT_ALLOWED', `${check.reason} Propose it with autode_propose_platform_change: a person approves it, then ${allowWrite ? 'autode_apply_decision runs it on this server' : 'a server started with --allow-write runs it (autode_apply_decision)'}.`, { statement: check.firstKeyword });
        const entry = session.entry(String(args.connectionId));
        const maxRows = Math.min(MAX_ROWS_CAP, (args.maxRows as number | undefined) ?? DEFAULT_MAX_ROWS);
        const timeoutSeconds = (args.timeoutSeconds as number | undefined) ?? DEFAULT_TIMEOUT_S;
        const result = await run(entry.id, (m) => m.executeQuery(stripTrailingSemicolon(sql), { maxRows, timeoutMs: timeoutSeconds * 1000 }), timeoutSeconds);
        const gated = gateQueryResult(result, { allowSampleData: entry.allowSampleDataInPrompts, metadata: single.kind === 'metadata', connectionId: entry.id });
        return { connectionId: entry.id, statement: single.firstKeyword, ...gated, maxRows, executionTimeMs: result.executionTimeMs };
      }
    }
  ];
}
