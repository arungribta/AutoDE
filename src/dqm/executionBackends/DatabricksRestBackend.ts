import { QueryOptions, QueryResult } from '../types';
import { ExecutionBackend } from './types';

export interface DatabricksRestCredentials {
  /** Bare workspace host, no scheme (e.g. `adb-1234.5.azuredatabricks.net`). */
  host: string;
  /** The SQL warehouse's HTTP Path (e.g. `/sql/1.0/warehouses/<id>`) — `warehouse_id` is derived from its last path segment. */
  httpPath: string;
  token: string;
  catalog?: string;
  schema?: string;
}

interface DatabricksColumnDesc {
  name: string;
  type_name?: string;
}

interface DatabricksStatementResponse {
  statement_id?: string;
  status?: { state?: string; error?: { message?: string } };
  manifest?: { schema?: { columns?: DatabricksColumnDesc[] } };
  result?: { data_array?: unknown[][] };
}

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 300; // 5 minutes
const PENDING_STATES = new Set(['PENDING', 'RUNNING']);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function warehouseIdFrom(httpPath: string): string {
  return httpPath.replace(/\/+$/, '').split('/').pop() || '';
}

/**
 * `manifest.schema.columns[].type_name` is Spark's internal type name, not the SQL
 * type text (`type_text`) — confirmed against a real workspace: a `BIGINT` column
 * reports `type_name: "LONG"`, not `"BIGINT"`. Every case below is a verified or
 * well-documented Spark `DataType.simpleString()` name, not a SQL-standard one.
 */
function castDatabricksValue(raw: unknown, typeName: string | undefined): unknown {
  if (raw === null || raw === undefined) {
    return null;
  }
  switch ((typeName || '').toUpperCase()) {
    case 'BYTE':      // TINYINT
    case 'SHORT':     // SMALLINT
    case 'INT':
    case 'LONG':      // BIGINT
    case 'FLOAT':
    case 'DOUBLE':
    case 'DECIMAL':
      return Number(raw);
    case 'BOOLEAN':
      return raw === 'true' || raw === true;
    default:
      return raw;
  }
}

/**
 * Executes SQL via the Databricks Statement Execution API (`/api/2.0/sql/statements`)
 * — Phase 3b tier 3. Unlike Snowflake, Databricks has no CLI-native-protocol
 * execution path (its CLI is a thin wrapper over this same REST endpoint), so this
 * is the *only* non-driver execution path for Databricks — see the adapter's
 * handling of a CLI-derived (`profile`) credential for that asymmetry.
 */
export class DatabricksRestBackend implements ExecutionBackend {
  constructor(
    private readonly creds: DatabricksRestCredentials,
    private readonly log: (msg: string) => void
  ) {}

  private baseUrl(): string {
    return `https://${this.creds.host}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.creds.token}`, 'Content-Type': 'application/json' };
  }

  async executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult> {
    const startTime = Date.now();
    this.log(`[databricks:rest] Executing query (${sql.length} chars)...`);

    const body = JSON.stringify({
      warehouse_id: warehouseIdFrom(this.creds.httpPath),
      statement: sql,
      catalog: this.creds.catalog || undefined,
      schema: this.creds.schema || undefined,
      wait_timeout: '30s',
      format: 'JSON_ARRAY',
      disposition: 'INLINE'
    });

    const initial = await fetch(`${this.baseUrl()}/api/2.0/sql/statements`, { method: 'POST', headers: this.headers(), body });
    let result = (await initial.json()) as DatabricksStatementResponse;
    if (initial.status >= 400) {
      throw new Error(`Databricks SQL API error (${initial.status}): ${result.status?.error?.message ?? JSON.stringify(result)}`);
    }

    let attempts = 0;
    while (result.status?.state && PENDING_STATES.has(result.status.state)) {
      attempts++;
      if (attempts > MAX_POLL_ATTEMPTS) {
        throw new Error('Databricks query timed out waiting for results.');
      }
      if (options?.cancellationToken?.isCancellationRequested) {
        throw new Error('Databricks query was cancelled.');
      }
      await sleep(POLL_INTERVAL_MS);
      const poll = await fetch(`${this.baseUrl()}/api/2.0/sql/statements/${result.statement_id}`, { headers: this.headers() });
      result = (await poll.json()) as DatabricksStatementResponse;
      if (poll.status >= 400) {
        throw new Error(`Databricks SQL API error (${poll.status}): ${result.status?.error?.message ?? JSON.stringify(result)}`);
      }
    }

    if (result.status?.state === 'FAILED' || result.status?.state === 'CANCELED') {
      throw new Error(`Databricks query failed: ${result.status?.error?.message ?? result.status?.state}`);
    }

    const columnDefs = result.manifest?.schema?.columns ?? [];
    const columns = columnDefs.map((c) => c.name);
    const rawRows = result.result?.data_array ?? [];
    const rows = rawRows.map((row) => {
      const obj: Record<string, unknown> = {};
      row.forEach((value, i) => { obj[columns[i]] = castDatabricksValue(value, columnDefs[i]?.type_name); });
      return obj;
    });

    const limitedRows = typeof options?.maxRows === 'number' ? rows.slice(0, options.maxRows) : rows;
    return { columns, rows: limitedRows, rowCount: limitedRows.length, executionTimeMs: Date.now() - startTime };
  }

  dispose(): void {
    /* stateless HTTP calls — nothing to release */
  }
}
