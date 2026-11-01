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
}

/** The most runs kept: older ones are dropped when it grows past this. */
const KEEP = 2000;

export function operationRunsFile(workspaceRoot: string): string {
  return path.join(path.dirname(layoutPath(workspaceRoot, 'connectionReadiness')), 'operation-runs.jsonl');
}

export function recordOperationRun(workspaceRoot: string | undefined, run: OperationRun): void {
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
