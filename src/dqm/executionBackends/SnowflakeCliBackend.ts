import { spawnSync } from 'node:child_process';
import { QueryOptions, QueryResult } from '../types';
import { ExecutionBackend } from './types';

/**
 * Either a pre-configured `connections.toml` name, or ad-hoc connection params
 * supplied directly (e.g. from a username/password the user entered in Settings →
 * Connections and AutoDE resolved out of VS Code SecretStorage). Ad-hoc exists
 * because the SQL API (tier 3, `SnowflakeRestBackend`) categorically does not accept
 * plain username/password — the CLI's own `--user`/`--password` flags are the only
 * way AutoDE can honor that auth mode at all, and doing so here still rides
 * Snowflake's native protocol rather than inventing a REST workaround.
 */
export type SnowflakeCliConnectionSpec =
  | { kind: 'named'; connectionName: string }
  | { kind: 'adhoc'; account: string; username: string; password: string; warehouse?: string; database?: string; schema?: string; role?: string };

/** Tolerates a stray line before the JSON array, same resilience `claudeCodeAdapter.ts` uses for its own CLI output. */
function parseSnowCliJson(stdout: string): Array<Record<string, unknown>> {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1));
        return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
      } catch {
        /* fall through */
      }
    }
    throw new Error(`Could not parse Snowflake CLI JSON output: ${trimmed.slice(0, 300)}`);
  }
}

/**
 * Executes SQL via `snow sql`, riding Snowflake's native protocol (the CLI is built
 * on the Python connector) rather than the public SQL API — Phase 3b tier 1, the
 * preferred path when a CLI-derived connection is available: no bundle weight, and
 * the same wire path every other Snowflake-approved tool (Snowsight, JDBC/ODBC)
 * already uses, sidestepping enterprise network policies that specifically
 * restrict the separate SQL API surface.
 */
export class SnowflakeCliBackend implements ExecutionBackend {
  constructor(
    private readonly cliPath: string,
    private readonly spec: SnowflakeCliConnectionSpec,
    private readonly log: (msg: string) => void
  ) {}

  /**
   * Builds the CLI's connection args. For `adhoc`, `--password` is passed as a
   * command-line argument — the CLI's own supported mechanism for this, not an
   * AutoDE invention, but that means the plaintext value is briefly visible to
   * anything on the same machine that can list process command lines (e.g. Task
   * Manager/`ps`) for the life of this one short-lived process. It is never logged,
   * written to disk, or included in an error message by AutoDE itself; the password
   * still lives only in VS Code SecretStorage between runs.
   */
  private connectionArgs(): string[] {
    if (this.spec.kind === 'named') {
      return ['-c', this.spec.connectionName];
    }
    const args = ['--account', this.spec.account, '--user', this.spec.username, '--password', this.spec.password];
    if (this.spec.warehouse) { args.push('--warehouse', this.spec.warehouse); }
    if (this.spec.database) { args.push('--database', this.spec.database); }
    if (this.spec.schema) { args.push('--schema', this.spec.schema); }
    if (this.spec.role) { args.push('--role', this.spec.role); }
    return args;
  }

  async executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult> {
    const startTime = Date.now();
    const label = this.spec.kind === 'named' ? `connection "${this.spec.connectionName}"` : `account "${this.spec.account}" as "${this.spec.username}"`;
    this.log(`[snowflake:cli] Executing query via ${label} (${sql.length} chars)...`);

    const result = spawnSync(
      this.cliPath,
      ['sql', ...this.connectionArgs(), '--format', 'JSON_EXT', '-q', sql],
      { encoding: 'utf8', timeout: options?.timeoutMs, maxBuffer: 100 * 1024 * 1024, windowsHide: true }
    );

    if (result.error) {
      throw new Error(`Failed to run the Snowflake CLI: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const combined = (result.stderr || result.stdout || '').trim();
      // The CLI can emit a long, noisy internal traceback before its actual, actionable
      // error box (confirmed live: a Snowflake network-policy rejection appeared at the
      // END of a multi-KB combined output) — take the tail, not the head, so truncation
      // never cuts off the message a user actually needs to act on.
      const detail = combined.length > 2000 ? `...${combined.slice(-2000)}` : combined;
      throw new Error(`Snowflake CLI query failed: ${detail || `exited with code ${result.status}`}`);
    }

    const rows = parseSnowCliJson(result.stdout);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    const limitedRows = typeof options?.maxRows === 'number' ? rows.slice(0, options.maxRows) : rows;
    return { columns, rows: limitedRows, rowCount: limitedRows.length, executionTimeMs: Date.now() - startTime };
  }

  dispose(): void {
    /* no persistent connection to release — every query is its own process */
  }
}
