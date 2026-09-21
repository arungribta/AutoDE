import { QueryOptions, QueryResult } from '../types';
import { ExecutionBackend } from './types';
import { buildSnowflakeKeyPairJwt } from '../adapters/snowflakeJwt';

export interface SnowflakeRestCredentials {
  account: string;
  username: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  role?: string;
  /** A Programmatic Access Token or OAuth access token — takes precedence over key-pair JWT when present. */
  token?: string;
  privateKeyPem?: string;
  privateKeyPassphrase?: string;
}

interface SnowflakeColumnDesc {
  name: string;
  type: string;
}

interface SnowflakeStatementResponse {
  statementHandle?: string;
  message?: string;
  resultSetMetaData?: { rowType: SnowflakeColumnDesc[] };
  data?: unknown[][];
}

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 300; // 5 minutes

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Casts a SQL API v2 value (always delivered as a JSON string) to the JS type `BaseDataSourceAdapter`'s assembly logic expects (`typeof x === 'number'` checks for row counts, sizes, etc.). */
function castSnowflakeValue(raw: unknown, type: string | undefined): unknown {
  if (raw === null || raw === undefined) {
    return null;
  }
  switch ((type || '').toLowerCase()) {
    case 'fixed':
    case 'real':
      return Number(raw);
    case 'boolean':
      return raw === 'true' || raw === true;
    default:
      return raw;
  }
}

/**
 * Executes SQL via Snowflake's public SQL API v2 (`/api/v2/statements`) — Phase 3b
 * tier 3, the always-available fallback. Per real-world feedback this incorporates
 * two honest limitations, not hidden: it can be slow for large-scale catalog
 * extraction (JSON-stringified values, partitioned pagination for big results —
 * AutoDE's queries are typically small enough to avoid this in practice, but it's
 * real), and it's a distinct REST surface some enterprises network-restrict
 * separately from Snowflake's native protocol (tier 1/2's wire path).
 */
export class SnowflakeRestBackend implements ExecutionBackend {
  constructor(
    private readonly creds: SnowflakeRestCredentials,
    private readonly log: (msg: string) => void
  ) {}

  private baseUrl(): string {
    return `https://${this.creds.account}.snowflakecomputing.com`;
  }

  private authHeaders(): Record<string, string> {
    if (this.creds.token) {
      return { Authorization: `Bearer ${this.creds.token}` };
    }
    if (this.creds.privateKeyPem) {
      const jwt = buildSnowflakeKeyPairJwt({
        account: this.creds.account,
        username: this.creds.username,
        privateKeyPem: this.creds.privateKeyPem,
        passphrase: this.creds.privateKeyPassphrase
      });
      return { Authorization: `Bearer ${jwt}`, 'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT' };
    }
    throw new Error('Snowflake REST execution requires a Programmatic Access Token, OAuth token, or key-pair private key.');
  }

  async executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult> {
    const startTime = Date.now();
    this.log(`[snowflake:rest] Executing query (${sql.length} chars)...`);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...this.authHeaders()
    };
    const body = JSON.stringify({
      statement: sql,
      warehouse: this.creds.warehouse || undefined,
      database: this.creds.database || undefined,
      schema: this.creds.schema || undefined,
      role: this.creds.role || undefined,
      timeout: options?.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : undefined
    });

    const initial = await fetch(`${this.baseUrl()}/api/v2/statements`, { method: 'POST', headers, body });
    let result = (await initial.json()) as SnowflakeStatementResponse;
    let status = initial.status;

    if (status >= 400 && status !== 202) {
      throw new Error(`Snowflake SQL API error (${status}): ${result.message ?? JSON.stringify(result)}`);
    }

    let attempts = 0;
    while (status === 202) {
      attempts++;
      if (attempts > MAX_POLL_ATTEMPTS) {
        throw new Error('Snowflake query timed out waiting for results.');
      }
      if (options?.cancellationToken?.isCancellationRequested) {
        throw new Error('Snowflake query was cancelled.');
      }
      await sleep(POLL_INTERVAL_MS);
      const poll = await fetch(`${this.baseUrl()}/api/v2/statements/${result.statementHandle}`, { headers });
      result = (await poll.json()) as SnowflakeStatementResponse;
      status = poll.status;
      if (status >= 400 && status !== 202) {
        throw new Error(`Snowflake query failed (${status}): ${result.message ?? 'unknown error'}`);
      }
    }

    const columnDefs = result.resultSetMetaData?.rowType ?? [];
    const columns = columnDefs.map((c) => c.name);
    const rawRows = result.data ?? [];
    const rows = rawRows.map((row) => {
      const obj: Record<string, unknown> = {};
      row.forEach((value, i) => { obj[columns[i]] = castSnowflakeValue(value, columnDefs[i]?.type); });
      return obj;
    });

    const limitedRows = typeof options?.maxRows === 'number' ? rows.slice(0, options.maxRows) : rows;
    return { columns, rows: limitedRows, rowCount: limitedRows.length, executionTimeMs: Date.now() - startTime };
  }

  dispose(): void {
    /* stateless HTTP calls — nothing to release */
  }
}
