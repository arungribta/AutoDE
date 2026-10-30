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

/** An older CLI without `-x`, or one that didn't read the password from the environment. */
function refusedEnvPassword(output: string): boolean {
  return /no such option|unrecognized|temporary.connection|password (is )?(required|missing|empty)|incorrect username or password|authenticat/i.test(output);
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
  /** v0.54.1: false once the CLI refused the password from its environment, so this backend passes it as `--password`. */
  private passwordFromEnv = true;

  constructor(
    private readonly cliPath: string,
    private readonly spec: SnowflakeCliConnectionSpec,
    private readonly log: (msg: string) => void,
    /** The variable the CLI reads the password from (the platform definition's `access.cli.credentialEnv`). */
    private readonly passwordEnv = 'SNOWFLAKE_PASSWORD'
  ) {}

  /**
   * Builds the CLI's connection args. For `adhoc` (v0.54.1), a temporary
   * connection (`-x`) whose password the CLI reads from its environment, so it is
   * not on the command line where anything that lists processes could see it. An
   * older CLI that refuses that gets `--password` instead, once, with a notice. The
   * password is never logged, written to disk, or included in an error message by
   * AutoDE itself; it lives only in VS Code SecretStorage (or the environment) between runs.
   */
  connectionArgs(): string[] {
    if (this.spec.kind === 'named') {
      return ['-c', this.spec.connectionName];
    }
    const args = this.passwordFromEnv
      ? ['-x', '--account', this.spec.account, '--user', this.spec.username]
      : ['--account', this.spec.account, '--user', this.spec.username, '--password', this.spec.password];
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

    let result = this.spawn(sql, options);
    if (this.spec.kind === 'adhoc' && this.passwordFromEnv && result.status !== 0 && refusedEnvPassword(`${result.stderr ?? ''}${result.stdout ?? ''}`)) {
      this.log(`[snowflake:cli] This Snowflake CLI didn't take the password from ${this.passwordEnv}; passing it as --password (visible to process listings) — update the CLI to keep it off the command line.`);
      this.passwordFromEnv = false;
      result = this.spawn(sql, options);
    }

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

  /** The CLI's environment: the password goes here for an ad-hoc connection, never in an argument. */
  connectionEnv(): Record<string, string> {
    return this.spec.kind === 'adhoc' && this.passwordFromEnv ? { [this.passwordEnv]: this.spec.password } : {};
  }

  private spawn(sql: string, options?: QueryOptions) {
    return spawnSync(
      this.cliPath,
      ['sql', ...this.connectionArgs(), '--format', 'JSON_EXT', '-q', sql],
      { encoding: 'utf8', timeout: options?.timeoutMs, maxBuffer: 100 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...this.connectionEnv() } }
    );
  }

  dispose(): void {
    /* no persistent connection to release — every query is its own process */
  }
}
