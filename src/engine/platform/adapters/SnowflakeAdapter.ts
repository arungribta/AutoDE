import * as fs from 'node:fs';
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
import { SnowflakeCliBackend, SnowflakeCliConnectionSpec } from '../executionBackends/SnowflakeCliBackend';
import { SnowflakeRestBackend } from '../executionBackends/SnowflakeRestBackend';
import { getCliDescriptor } from '../credentials/cliRegistry';

/**
 * Snowflake data platform adapter.
 *
 * Real execution (Phase 3b) picks between backends at `connect()` time, never a
 * bundled SDK:
 * - a CLI-derived connection (`connectionName`, from `CliConfigResolver`, Phase
 *   3a-ii) shells out to `snow sql`, riding Snowflake's native protocol — the
 *   preferred path, since it's the same wire path every other approved Snowflake
 *   tool uses and carries no bundle weight;
 * - a username/password credential also shells out to `snow sql`, but with the
 *   CLI's ad-hoc `--user`/`--password` flags instead of a named connection — this
 *   is the only way to honor that auth mode at all, since the SQL API below
 *   categorically rejects plain username/password;
 * - a direct credential (account/PAT/key-pair) calls the public SQL API v2
 *   directly over `fetch()` — the always-available fallback, with the caveats
 *   documented on `SnowflakeRestBackend`.
 *
 * Metadata extraction uses INFORMATION_SCHEMA views. Lineage extraction uses
 * ACCOUNT_USAGE.QUERY_HISTORY (requires elevated permissions).
 */
export class SnowflakeAdapter extends BaseDataSourceAdapter {
  private backend: ExecutionBackend | null = null;
  private connectedDb: string = '';
  private connectedSchema: string = '';

  /** `options.cliConsent`: the `dataPlatformCliConsent` setting, passed in so the engine never reads VS Code settings (v0.26.0). */
  constructor(credentials: Record<string, string>, log: (msg: string) => void, private readonly options: { cliConsent?: boolean } = {}) {
    super('snowflake', credentials, log);
  }

  async connect(): Promise<ConnectionInfo> {
    const connectionName = this.credentials['connectionName'] || '';
    const authMode = this.credentials['authMode'] || this.credentials['defaultSnowflakeAuthMode'] || 'key-pair';
    const password = this.credentials['password'] || '';

    if (connectionName) {
      this.backend = await this.createCliBackend({ kind: 'named', connectionName });
    } else if (authMode === 'username-password' && password) {
      // The SQL API (tier 3) categorically rejects plain username/password, so this
      // auth mode can only be honored via the CLI's own `--user`/`--password` flags —
      // still Snowflake's native protocol, not a REST workaround.
      this.backend = await this.createCliBackend(this.buildAdHocSpec(password));
    } else {
      this.backend = this.createRestBackend();
    }

    try {
      const info = await this.executeQuery(
        'SELECT CURRENT_DATABASE() AS CURRENT_DB, CURRENT_SCHEMA() AS CURRENT_SCHEMA, CURRENT_VERSION() AS CURRENT_VERSION'
      );
      const row = (info.rows[0] ?? {}) as Record<string, unknown>;
      this.connectedDb = String(row['CURRENT_DB'] ?? this.credentials['database'] ?? '');
      this.connectedSchema = String(row['CURRENT_SCHEMA'] ?? this.credentials['schema'] ?? 'PUBLIC');
      const version = String(row['CURRENT_VERSION'] ?? 'unknown');
      this.log(`[snowflake] Connected to ${this.connectedDb}.${this.connectedSchema} (Snowflake ${version}).`);
      return {
        connected: true,
        platform: 'snowflake',
        databaseName: this.connectedDb,
        schemaName: this.connectedSchema,
        version,
        capabilities: this.getCapabilities()
      };
    } catch (err) {
      this.backend = null;
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private async createCliBackend(spec: SnowflakeCliConnectionSpec): Promise<SnowflakeCliBackend> {
    const consent = this.options.cliConsent === true;
    if (!consent) {
      throw new Error(
        'Executing queries via the Snowflake CLI requires CLI-execution consent — enable "autoDataEngineeringHub.dataPlatformCliConsent" in Settings.'
      );
    }
    const descriptor = getCliDescriptor('snowflake');
    const detection = await descriptor?.detect(this.credentials['snowflakeCliPath']);
    if (!detection?.found || !detection.cliPath) {
      throw new Error(`Snowflake CLI not found: ${detection?.error ?? 'unknown error'}`);
    }
    return new SnowflakeCliBackend(detection.cliPath, spec, (msg) => this.log(msg));
  }

  private buildAdHocSpec(password: string): SnowflakeCliConnectionSpec {
    const account = this.credentials['account'] || this.credentials['defaultSnowflakeAccount'] || '';
    const username = this.credentials['username'] || this.credentials['defaultSnowflakeUsername'] || '';
    if (!account || !username) {
      throw new Error('Snowflake username/password auth requires an account and username.');
    }
    return {
      kind: 'adhoc',
      account,
      username,
      password,
      warehouse: this.credentials['warehouse'] || this.credentials['defaultSnowflakeWarehouse'] || undefined,
      database: this.credentials['database'] || this.credentials['defaultSnowflakeDatabase'] || undefined,
      schema: this.credentials['schema'] || this.credentials['defaultSnowflakeSchema'] || undefined,
      role: this.credentials['role'] || this.credentials['defaultSnowflakeRole'] || undefined
    };
  }

  private createRestBackend(): SnowflakeRestBackend {
    const account = this.credentials['account'] || this.credentials['defaultSnowflakeAccount'] || '';
    const username = this.credentials['username'] || this.credentials['defaultSnowflakeUsername'] || '';
    const warehouse = this.credentials['warehouse'] || this.credentials['defaultSnowflakeWarehouse'] || '';
    const database = this.credentials['database'] || this.credentials['defaultSnowflakeDatabase'] || '';
    const schema = this.credentials['schema'] || this.credentials['defaultSnowflakeSchema'] || 'PUBLIC';
    const role = this.credentials['role'] || this.credentials['defaultSnowflakeRole'] || 'SYSADMIN';
    const authMode = this.credentials['authMode'] || this.credentials['defaultSnowflakeAuthMode'] || 'key-pair';
    const token = this.credentials['token'] || this.credentials['pat'] || '';
    const keyPath = this.credentials['keyPath'] || this.credentials['snowflakePrivateKeyPath'] || '';
    const privateKeyPem = this.credentials['privateKey'] || this.readPrivateKeyFile(keyPath);
    const privateKeyPassphrase = this.credentials['privateKeyPassphrase'] || '';

    if (!account || !username || !database) {
      throw new Error('Snowflake connection requires account, username, and database.');
    }
    if (!token && authMode === 'key-pair' && !privateKeyPem) {
      throw new Error('Snowflake key-pair auth requires a private key path or private key content.');
    }
    if (!token && authMode === 'username-password') {
      throw new Error(
        'Username/password auth requires a password — set it in Settings → Connections (stored in VS Code SecretStorage), or provide a Programmatic Access Token/key-pair instead. The SQL API itself never accepts plain username/password; a password is only usable via the Snowflake CLI.'
      );
    }
    if (!token && authMode !== 'key-pair') {
      throw new Error(
        'Snowflake REST execution needs a Programmatic Access Token, OAuth token, or key-pair credentials — the SQL API does not accept plain username/password. Provide a token, switch to key-pair auth, or use a CLI-derived connection instead.'
      );
    }

    return new SnowflakeRestBackend(
      { account, username, warehouse, database, schema, role, token: token || undefined, privateKeyPem: privateKeyPem || undefined, privateKeyPassphrase: privateKeyPassphrase || undefined },
      (msg) => this.log(msg)
    );
  }

  private readPrivateKeyFile(keyPath: string): string {
    if (!keyPath) {
      return '';
    }
    try {
      return fs.readFileSync(keyPath, 'utf8');
    } catch (err) {
      this.log(`[snowflake] Could not read private key file at "${keyPath}": ${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
  }

  async disconnect(): Promise<void> {
    this.backend?.dispose();
    this.backend = null;
    this.log('[snowflake] Disconnected.');
  }

  dispose(): void {
    this.backend?.dispose();
    this.backend = null;
  }

  async executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult> {
    if (!this.backend) {
      throw new Error('Not connected to Snowflake. Call connect() first.');
    }
    return this.backend.executeQuery(sql, options);
  }

  /** Lists databases visible to the connected principal — lets a user pick from what's actually there (Step 4) instead of typing a name blindly. */
  async listDatabases(): Promise<string[]> {
    const result = await this.executeQuery('SHOW DATABASES');
    return result.rows
      .map((row) => this.firstColumnValue(row as Record<string, unknown>, ['name', 'NAME', 'database_name']))
      .filter((name) => name.length > 0);
  }

  /** Lists schemas within a given database. */
  async listSchemas(database: string): Promise<string[]> {
    const result = await this.executeQuery(`SHOW SCHEMAS IN DATABASE ${database}`);
    return result.rows
      .map((row) => this.firstColumnValue(row as Record<string, unknown>, ['name', 'NAME', 'schema_name']))
      .filter((name) => name.length > 0);
  }

  getCapabilities(): PlatformCapabilities {
    return {
      supportsMetadataExtraction: true,
      supportsQueryExecution: true,
      supportsDdlGeneration: true,
      supportsColumnProfiling: true,
      supportsLineageExtraction: true,  // via ACCOUNT_USAGE
      supportsChangeDataCapture: true,  // via streams
      supportsStreaming: true,          // via Snowpipe
      maxQueryTimeoutMs: 300000,
      supportedDialects: ['snowflake', 'ansi']
    };
  }

  getMetadataQueries(scope?: string, tables?: string[]): PlatformMetadataQueries {
    const parts = scope ? scope.split('.') : [];
    const db = parts.length > 1 ? parts[0] : this.connectedDb;
    const schema = parts.length > 0 ? parts[parts.length - 1] : (this.connectedSchema || 'PUBLIC');
    // Phase K2 query-through: only the named tables (case-insensitive; names are literals, quotes doubled).
    const only = tables && tables.length > 0 ? `\n          AND UPPER(table_name) IN (${tables.map((t) => `'${t.toUpperCase().replace(/'/g, "''")}'`).join(', ')})` : '';

    return {
      listTables: `
        SELECT
          table_catalog,
          table_schema,
          table_name,
          table_type,
          row_count,
          bytes,
          last_altered,
          comment
        FROM ${db}.INFORMATION_SCHEMA.TABLES
        WHERE table_schema = '${schema}'${only}
        ORDER BY table_name`,

      lastAltered: `
        SELECT table_schema, table_name, last_altered
        FROM ${db}.INFORMATION_SCHEMA.TABLES
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
        FROM ${db}.INFORMATION_SCHEMA.COLUMNS
        WHERE table_schema = '${schema}'${only}
        ORDER BY table_name, ordinal_position`,

      listForeignKeys: `
        SELECT
          fk_schema_name AS source_schema,
          fk_table_name AS source_table,
          fk_column_name AS source_column,
          pk_schema_name AS target_schema,
          pk_table_name AS target_table,
          pk_column_name AS target_column,
          constraint_name
        FROM ${db}.INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
        WHERE fk_schema_name = '${schema}'
           OR pk_schema_name = '${schema}'`,

      listViews: `
        SELECT
          table_catalog,
          table_schema,
          table_name,
          view_definition,
          comment
        FROM ${db}.INFORMATION_SCHEMA.VIEWS
        WHERE table_schema = '${schema}'
        ORDER BY table_name`,

      profileColumn: (fqn: string, col: string) => `
        SELECT
          COUNT(DISTINCT ${col}) AS distinct_count,
          COUNT(*) - COUNT(${col}) AS null_count,
          MIN(${col})::STRING AS min_value,
          MAX(${col})::STRING AS max_value,
          AVG(LENGTH(${col}::STRING)) AS avg_length
        FROM ${fqn}`,

      profileTable: (fqn: string, cols: string[], sampleRows: number) => `
        SELECT COUNT(*) AS row_count${cols.map((c, i) => `, COUNT(DISTINCT ${c}) AS d_${i}, COUNT(*) - COUNT(${c}) AS n_${i}`).join('')}
        FROM ${fqn} SAMPLE (${Math.max(1, Math.floor(sampleRows))} ROWS)`,

      extractLineage: `
        SELECT
          query_text,
          start_time,
          database_name,
          schema_name
        FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
        WHERE query_type IN ('CREATE_TABLE_AS_SELECT', 'INSERT', 'MERGE', 'COPY')
          AND start_time >= DATEADD(day, -30, CURRENT_DATE())
        ORDER BY start_time DESC
        LIMIT 1000`
    };
  }

  translateDialect(sql: string, _targetDialect: SqlDialect): string {
    // Snowflake SQL is largely ANSI-compliant. Most translations are no-ops.
    // Specific translations would be added here for non-Snowflake targets.
    return sql;
  }
}
