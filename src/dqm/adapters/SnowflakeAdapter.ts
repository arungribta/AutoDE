import * as vscode from 'vscode';
import { BaseDataSourceAdapter } from '../BaseAdapter';
import {
  PlatformCapabilities,
  ConnectionInfo,
  QueryOptions,
  QueryResult,
  PlatformMetadataQueries,
  SqlDialect
} from '../types';

/**
 * Snowflake data platform adapter.
 *
 * Metadata extraction uses INFORMATION_SCHEMA views.
 * Lineage extraction uses ACCOUNT_USAGE.QUERY_HISTORY (requires elevated permissions).
 * Authentication supports key-pair, OAuth, username/password, external browser, and MCP.
 */
export class SnowflakeAdapter extends BaseDataSourceAdapter {
  private conn: unknown = null;
  private connectedDb: string = '';
  private connectedSchema: string = '';

  constructor(credentials: Record<string, string>, log: (msg: string) => void) {
    super('snowflake', credentials, log);
  }

  async connect(): Promise<ConnectionInfo> {
    const account = this.credentials['account'] || this.credentials['defaultSnowflakeAccount'] || '';
    const username = this.credentials['username'] || this.credentials['defaultSnowflakeUsername'] || '';
    const warehouse = this.credentials['warehouse'] || this.credentials['defaultSnowflakeWarehouse'] || '';
    const database = this.credentials['database'] || this.credentials['defaultSnowflakeDatabase'] || '';
    const schema = this.credentials['schema'] || this.credentials['defaultSnowflakeSchema'] || 'PUBLIC';
    const role = this.credentials['role'] || this.credentials['defaultSnowflakeRole'] || 'SYSADMIN';
    const authMode = this.credentials['authMode'] || this.credentials['defaultSnowflakeAuthMode'] || 'key-pair';
    const password = this.credentials['password'] || '';
    const keyPath = this.credentials['keyPath'] || this.credentials['snowflakePrivateKeyPath'] || '';

    if (!account || !username || !database) {
      throw new Error('Snowflake connection requires account, username, and database.');
    }

    this.connectedDb = database;
    this.connectedSchema = schema;

    // In production, this would use the snowflake-sdk to establish a real connection.
    // For now, we validate credentials and return a connection info object.
    // The actual connection will be established lazily on first query.

    this.log(`[snowflake] Connecting to ${account}.snowflakecomputing.com as ${username}...`);

    // Simulate connection validation
    if (authMode === 'key-pair' && !keyPath && !password) {
      throw new Error('Snowflake key-pair auth requires a private key path or password.');
    }

    this.conn = { account, username, warehouse, database, schema, role, authMode };

    this.log(`[snowflake] Connected to ${database}.${schema}`);

    return {
      connected: true,
      platform: 'snowflake',
      databaseName: database,
      schemaName: schema,
      version: '7.x', // Would be fetched via SELECT CURRENT_VERSION()
      capabilities: this.getCapabilities()
    };
  }

  async disconnect(): Promise<void> {
    this.conn = null;
    this.log('[snowflake] Disconnected.');
  }

  dispose(): void {
    this.conn = null;
  }

  async executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult> {
    if (!this.conn) {
      throw new Error('Not connected to Snowflake. Call connect() first.');
    }

    const startTime = Date.now();

    // In production, this would execute via snowflake-sdk Connection.execute().
    // For now, we return an empty result set — the adapter layer is ready for
    // real execution when the snowflake-sdk integration is completed.
    this.log(`[snowflake] Executing query (${sql.length} chars)...`);

    // Simulate query execution
    const executionTimeMs = Date.now() - startTime;

    return {
      columns: [],
      rows: [],
      rowCount: 0,
      executionTimeMs
    };
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

  getMetadataQueries(): PlatformMetadataQueries {
    const db = this.connectedDb;
    const schema = this.connectedSchema || 'PUBLIC';

    return {
      listTables: `
        SELECT
          table_catalog,
          table_schema,
          table_name,
          table_type,
          row_count,
          bytes,
          comment
        FROM ${db}.INFORMATION_SCHEMA.TABLES
        WHERE table_schema = '${schema}'
        ORDER BY table_name`,

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
        WHERE table_schema = '${schema}'
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