import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { layoutPath } from '../workspaceLayout';
import { ConnectionEntry, envStandInVariables } from './connectionsConfig';

/**
 * Whether a named connection has passed its connectivity check on this
 * machine (docs/specs/mcp-engine.md §9.1 Phase DRV2). Readiness depends
 * on this machine's drivers, CLIs and credentials, so it lives in
 * `.autode/local/connection-readiness.json`, never in the committed file, and
 * it is bound to a hash of the entry: editing the entry clears it.
 *
 * Two consumers are reported separately. **AutoDE** (the extension) is ready
 * once the check passed. **MCP clients** (Claude Code, Copilot, …) run the
 * server in their own process: they can't read VS Code's secret storage and
 * have their own environment, so the status says what they still need.
 */

export interface ReadinessRecord {
  entryHash: string;
  checkedAt: string;
  ok: boolean;
  /** Where the check landed (`DB.SCHEMA (version)`) or why it failed. */
  detail: string;
}

export type AutodeReadiness = 'ready' | 'failed' | 'unchecked' | 'stale';

export interface ConnectionStatus {
  autode: AutodeReadiness;
  checkedAt?: string;
  detail?: string;
  mcp: { ready: boolean; note: string };
}

/** Stable over field order; covers everything that changes where or how the connection lands. */
export function entryHash(entry: Pick<ConnectionEntry, 'platform' | 'role' | 'fields' | 'credentials'>): string {
  const fields = Object.keys(entry.fields).sort().map((k) => [k, entry.fields[k]]);
  const canonical = JSON.stringify([entry.platform, entry.role, fields, entry.credentials.resolver, entry.credentials.ref]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function readReadiness(workspaceRoot: string): Record<string, ReadinessRecord> {
  try {
    const parsed = JSON.parse(fs.readFileSync(layoutPath(workspaceRoot, 'connectionReadiness'), 'utf8')) as { connections?: Record<string, ReadinessRecord> };
    return parsed.connections && typeof parsed.connections === 'object' ? parsed.connections : {};
  } catch {
    return {};
  }
}

export function recordReadiness(workspaceRoot: string, entry: ConnectionEntry, ok: boolean, detail: string, now: Date = new Date()): ReadinessRecord {
  const all = readReadiness(workspaceRoot);
  const record: ReadinessRecord = { entryHash: entryHash(entry), checkedAt: now.toISOString(), ok, detail };
  all[entry.id] = record;
  writeAll(workspaceRoot, all);
  return record;
}

function writeAll(workspaceRoot: string, all: Record<string, ReadinessRecord>): void {
  const file = layoutPath(workspaceRoot, 'connectionReadiness');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ connections: all }, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function forgetReadiness(workspaceRoot: string, id: string): void {
  const all = readReadiness(workspaceRoot);
  if (!(id in all)) return;
  delete all[id];
  writeAll(workspaceRoot, all);
}

/** What MCP clients still need for a connection that AutoDE can use. */
function mcpNote(entry: ConnectionEntry): { ready: boolean; note: string } {
  const notes: string[] = [];
  let ready = true;
  if (entry.credentials.resolver === 'vscode') {
    const vars = envStandInVariables(entry);
    const optional = entry.platform === 'snowflake' && (entry.fields.authMode || 'key-pair') === 'key-pair';
    if (optional) notes.push(`If the key is encrypted, the MCP client's environment needs ${vars.join(', ')}.`);
    else { ready = false; notes.push(`The secret is in VS Code's secret storage, which MCP clients can't read: set ${vars.join(' and ')} in the client's environment, or use a CLI connection.`); }
  } else if (entry.credentials.resolver === 'env') {
    notes.push('The MCP client\'s environment needs the same AUTODE_* variables.');
  } else {
    notes.push('Uses your platform CLI\'s configuration, which MCP clients read too.');
  }
  if (entry.platform === 'snowflake' && (entry.credentials.resolver === 'cli' || entry.fields.authMode === 'username-password')) notes.push('Start the MCP server with --allow-cli (this connection runs through the Snowflake CLI).');
  if (entry.platform === 'oracle') notes.push('The MCP server uses the same drivers folder; set AUTODE_DRIVERS_DIR if you changed driversDirectory.');
  return { ready, note: notes.join(' ') };
}

export function connectionStatus(entry: ConnectionEntry, record: ReadinessRecord | undefined): ConnectionStatus {
  const autode: AutodeReadiness = !record ? 'unchecked' : record.entryHash !== entryHash(entry) ? 'stale' : record.ok ? 'ready' : 'failed';
  const mcp = mcpNote(entry);
  return {
    autode, checkedAt: record?.checkedAt, detail: record?.detail,
    mcp: autode === 'ready' ? mcp : { ready: false, note: autode === 'stale' ? 'The entry changed since its last check: re-check it.' : 'Pass the connectivity check first.' }
  };
}
