import * as fs from 'node:fs';
import * as path from 'node:path';
import { AUTODE_DIR, LEGACY_DIR, ensureLayout, outputDirPath } from './workspaceLayout';

/**
 * Moves a pre-v0.36.0 workspace from `.ai-context/` to the `.autode/` layout
 * (workspaceLayout.ts) and generated artifacts to the visible output folder.
 *
 * - Only moves: nothing is rewritten, so history, ledger events and manifests
 *   stay byte-identical and git records renames.
 * - Never overwrites: a file already at its new place is left where it was and
 *   reported as a conflict (a teammate migrated first; their copy wins).
 * - Never guesses: an entry it doesn't recognise stays in `.ai-context/` and is
 *   reported.
 * - Idempotent: running it again moves whatever is still left (e.g. the local
 *   chats of an engineer who pulled a teammate's migration).
 */

export interface MigrationReport {
  /** True when there was a `.ai-context/` to migrate. */
  needed: boolean;
  moved: Array<{ from: string; to: string }>;
  conflicts: Array<{ from: string; to: string }>;
  /** Legacy entries left in place because no rule covers them. */
  unrecognised: string[];
  /** True when `.ai-context/` was emptied and removed. */
  legacyRemoved: boolean;
}

/** Legacy path (POSIX, relative to `.ai-context/`) → new path relative to the workspace root, or undefined when no rule applies. */
export function mapLegacyPath(rel: string, outputDir: (problemId: string) => string): string | undefined {
  const p = rel.split('/');
  const to = (...segs: string[]) => [AUTODE_DIR, ...segs].join('/');
  const head = p[0];
  const rest = p.slice(1);
  if (head === 'problems' && p.length >= 2) {
    // Generated deliverables move out to the visible output folder.
    if (p[2] === 'artifacts') return [outputDir(p[1]), ...p.slice(3)].join('/');
    return to('problems', ...rest);
  }
  if (head === 'ledger' || head === 'profiles') return to('knowledge', head, ...rest);
  if (p.length === 1 && ['estate.yaml', 'sources.yaml', 'business-context.yaml', 'verified-queries.yaml', 'vocabulary.yaml'].includes(head)) return to('knowledge', head);
  if (head === 'context') return rest.length ? to('knowledge', ...rest) : undefined;
  if (head === 'skills' || head === 'primitives') return to('config', head, ...rest);
  if (p.length === 1 && head === 'target-environment.yaml') return to('config', head);
  if (p.length === 1 && ['active-problem.json', 'schema-graph.json', 'state.json'].includes(head)) return to('local', head);
  if (head === 'chats' || head === 'derived' || head === 'catalog') return to('local', head, ...rest);
  return undefined;
}

function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else out.push(r);
  }
  return out;
}

function removeEmptyDirs(dir: string): boolean {
  if (!fs.existsSync(dir)) return true;
  let empty = true;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && removeEmptyDirs(path.join(dir, e.name))) continue;
    empty = false;
  }
  if (empty) fs.rmdirSync(dir);
  return empty;
}

export function migrateWorkspace(workspaceRoot: string, options: { artifactDirectory?: string } = {}): MigrationReport {
  const legacy = path.join(workspaceRoot, LEGACY_DIR);
  const report: MigrationReport = { needed: false, moved: [], conflicts: [], unrecognised: [], legacyRemoved: false };
  if (!fs.existsSync(legacy) || !fs.statSync(legacy).isDirectory()) return report;
  report.needed = true;
  ensureLayout(workspaceRoot);
  const outputDir = (problemId: string) => path.relative(workspaceRoot, outputDirPath(workspaceRoot, problemId, options.artifactDirectory)).split(path.sep).join('/');
  const unrecognisedTop = new Set<string>();
  for (const rel of listFiles(legacy)) {
    const target = mapLegacyPath(rel, outputDir);
    const from = `${LEGACY_DIR}/${rel}`;
    if (!target) {
      unrecognisedTop.add(rel.split('/')[0]);
      continue;
    }
    const abs = path.join(workspaceRoot, ...target.split('/'));
    if (fs.existsSync(abs)) {
      report.conflicts.push({ from, to: target });
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.renameSync(path.join(legacy, ...rel.split('/')), abs);
    report.moved.push({ from, to: target });
  }
  report.unrecognised = [...unrecognisedTop].sort().map((e) => `${LEGACY_DIR}/${e}`);
  report.legacyRemoved = removeEmptyDirs(legacy);
  return report;
}

/** A short, readable account of a migration (for a notification and the log). */
export function describeMigration(r: MigrationReport): string {
  if (!r.needed) return 'Nothing to migrate.';
  const out = r.moved.filter((m) => !m.to.startsWith(`${AUTODE_DIR}/`)).length;
  const parts = [`Moved ${r.moved.length} file(s) from ${LEGACY_DIR}/ to ${AUTODE_DIR}/${out ? ` (${out} generated artifact(s) to the output folder)` : ''}.`];
  if (r.conflicts.length) parts.push(`${r.conflicts.length} file(s) already existed at their new place and were left in ${LEGACY_DIR}/ (the copy in ${AUTODE_DIR}/ is used).`);
  if (r.unrecognised.length) parts.push(`Not recognised, left in place: ${r.unrecognised.join(', ')}.`);
  if (r.legacyRemoved) parts.push(`${LEGACY_DIR}/ was empty afterwards and has been removed.`);
  return parts.join(' ');
}
