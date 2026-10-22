import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A runbook's run log (v0.45.6): one JSON object per line, append-only, each
 * entry carrying the hash of the previous one, so a change or a deleted line
 * is evident (`verifyRunLog`). Commands and output are redacted before they
 * are written; output is truncated.
 */

export interface RunLogEntry {
  seq: number;
  at: string;
  runbook: string;
  /** The runbook's content hash the action ran against. */
  revision: string;
  step?: string;
  action: 'approved' | 'dry-run' | 'run' | 'rollback' | 'skip' | 'stop';
  who: string;
  /** The redacted command or statement. */
  command?: string;
  ok: boolean;
  exitCode?: number | null;
  durationMs?: number;
  /** Redacted and truncated. */
  output?: string;
  prev: string;
  hash: string;
}

const GENESIS = 'sha256:genesis';

function hashOf(e: Omit<RunLogEntry, 'hash'>): string {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(e)).digest('hex');
}

export function readRunLog(file: string): RunLogEntry[] {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as RunLogEntry); } catch { return []; }
}

export function appendRunLog(file: string, e: Omit<RunLogEntry, 'seq' | 'prev' | 'hash'>): RunLogEntry {
  const all = readRunLog(file);
  const last = all[all.length - 1];
  const base = { ...e, seq: (last?.seq ?? 0) + 1, prev: last?.hash ?? GENESIS };
  const entry: RunLogEntry = { ...base, hash: hashOf(base) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

/** Whether every entry links to the one before and hashes to what it says. */
export function verifyRunLog(file: string): { ok: boolean; entries: number; brokenAt?: number; reason?: string } {
  const all = readRunLog(file);
  let prev = GENESIS;
  for (const [i, e] of all.entries()) {
    const { hash, ...rest } = e;
    if (e.prev !== prev) return { ok: false, entries: all.length, brokenAt: e.seq, reason: `entry ${e.seq} doesn't follow entry ${i ? all[i - 1].seq : 0} (a line was changed, removed or inserted).` };
    if (hashOf(rest) !== hash) return { ok: false, entries: all.length, brokenAt: e.seq, reason: `entry ${e.seq} was changed after it was written.` };
    prev = hash;
  }
  return { ok: true, entries: all.length };
}
