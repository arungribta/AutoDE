import * as fs from 'node:fs';
import * as path from 'node:path';
import { layoutPath } from '../../workspaceLayout';

/**
 * POP4a: the last runs of each operation on each connection, for the catalog's operation pages and health tab.
 * Kept in `.autode/local/` (per person, not committed); a run records its outcome, never its rows.
 */

export interface OperationRun {
  at: string;
  operation: string;
  connection: string;
  platform: string;
  ok: boolean;
  rows?: number;
  /** Why it failed, or the gap it reported. */
  error?: string;
  /** Who ran it: a feature, a person's try, a conformance run, an agent. */
  via?: string;
  /** POP3: the gap's kind (version, missing-object: drift), the platform version, and the operation's content digest. */
  kind?: string;
  version?: string;
  digest?: string;
}

/**
 * Where runs are recorded when the caller doesn't say (POP3): the workspace this process serves, set once by the
 * extension, the CLI and the MCP server. The adapters that read the estate don't know the workspace.
 */
let defaultRoot: string | undefined;
export function setOperationRunsRoot(workspaceRoot: string | undefined): void { defaultRoot = workspaceRoot; }
export function operationRunsRoot(): string | undefined { return defaultRoot; }

/** The most runs kept: older ones are dropped when it grows past this. */
const KEEP = 2000;

export function operationRunsFile(workspaceRoot: string): string {
  return path.join(path.dirname(layoutPath(workspaceRoot, 'connectionReadiness')), 'operation-runs.jsonl');
}

export function recordOperationRun(root: string | undefined, run: OperationRun): void {
  const workspaceRoot = root ?? defaultRoot;
  if (!workspaceRoot) return;
  try {
    const file = operationRunsFile(workspaceRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ...run, ...(run.error ? { error: run.error.slice(0, 500) } : {}) })}\n`);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > KEEP * 1.5) fs.writeFileSync(file, `${lines.slice(-KEEP).join('\n')}\n`);
  } catch { /* the log is a convenience: a run never fails because of it */ }
}

export function readOperationRuns(workspaceRoot: string | undefined): OperationRun[] {
  if (!workspaceRoot) return [];
  try {
    return fs.readFileSync(operationRunsFile(workspaceRoot), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as OperationRun]; } catch { return []; } });
  } catch { return []; }
}

/** The latest run of each operation on each connection. */
export function lastRuns(runs: readonly OperationRun[]): Map<string, OperationRun> {
  const out = new Map<string, OperationRun>();
  for (const r of runs) out.set(`${r.operation}@${r.connection}`, r);
  return out;
}

// ── Object kinds the platform reports (POP3) ────────────────────────────────

export interface ObservedKinds { connection: string; platform: string; at: string; kinds: Record<string, number> }

function kindsFile(workspaceRoot: string): string {
  return path.join(path.dirname(layoutPath(workspaceRoot, 'connectionReadiness')), 'object-kinds.json');
}

/** An object kind as platform definitions name them: `BASE TABLE` → `table`, `DYNAMIC TABLE` → `dynamic_table`. */
export function normalizeKind(kind: string): string {
  const k = kind.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return k === 'base_table' ? 'table' : k;
}

/** Records the object kinds an estate read saw on a connection (replacing that connection's last record). */
export function recordObjectKinds(root: string | undefined, observed: Omit<ObservedKinds, 'at'> & { at?: string }): void {
  const workspaceRoot = root ?? defaultRoot;
  if (!workspaceRoot) return;
  try {
    const all = readObjectKinds(workspaceRoot);
    all[observed.connection] = { ...observed, at: observed.at ?? new Date().toISOString() };
    fs.mkdirSync(path.dirname(kindsFile(workspaceRoot)), { recursive: true });
    fs.writeFileSync(kindsFile(workspaceRoot), JSON.stringify(all, null, 2) + '\n');
  } catch { /* a convenience: the read never fails because of it */ }
}

export function readObjectKinds(workspaceRoot: string | undefined): Record<string, ObservedKinds> {
  if (!workspaceRoot) return {};
  try { return JSON.parse(fs.readFileSync(kindsFile(workspaceRoot), 'utf8')) as Record<string, ObservedKinds>; } catch { return {}; }
}
