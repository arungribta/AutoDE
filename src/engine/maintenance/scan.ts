import * as fs from 'node:fs';
import * as path from 'node:path';
import { contentSha } from '../context/pack';
import { readPackFile } from '../context/packChecks';
import { listProblems } from '../documents/problems';
import { layoutPath } from '../workspaceLayout';
import { ScannedDocument, readMaintenanceState, writeMaintenanceState } from './policy';

/**
 * The whole-workspace scan (MM2; owner, 2026-10-28): started by a person, it
 * finds the text documents in the workspace that no problem's pack holds, so
 * the knowledge they carry is queued for a reading like any document AutoDE
 * touched. Deterministic: file names and contents, no model. The rules run
 * over every problem's documents with it (`all`).
 */

export const SCAN_EXTENSIONS = ['.md', '.markdown', '.txt', '.rst', '.adoc'];
const SKIP_DIRS = new Set(['.git', '.autode', 'autode-output', 'node_modules', 'dist', 'out', 'build', 'target', '.venv', 'venv', '__pycache__', '.vscode', '.idea', '.claude', '.github']);
const MAX_FILES = 500;
const MAX_BYTES = 2 * 1024 * 1024;

export interface ScanResult { documents: ScannedDocument[]; skipped: string[]; truncated: boolean }

export function scanWorkspace(workspaceRoot: string, options: { now?: Date } = {}): ScanResult {
  const inPacks = new Set(listProblems(workspaceRoot).flatMap((p) => readPackFile(path.join(layoutPath(workspaceRoot, 'problems', p.id), 'pack')).documents.map((d) => d.path.replace(/\\/g, '/'))));
  const documents: ScannedDocument[] = []; const skipped: string[] = [];
  let truncated = false;
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (documents.length >= MAX_FILES) { truncated = true; return; }
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(abs); continue; }
      if (!e.isFile() || !SCAN_EXTENSIONS.includes(path.extname(e.name).toLowerCase())) continue;
      const rel = path.relative(workspaceRoot, abs).split(path.sep).join('/');
      if (inPacks.has(rel)) continue;
      try {
        if (fs.statSync(abs).size > MAX_BYTES) { skipped.push(`${rel} (larger than 2 MB)`); continue; }
        documents.push({ path: rel, sha: contentSha(fs.readFileSync(abs, 'utf8')) });
      } catch { skipped.push(`${rel} (can't be read)`); }
    }
  };
  walk(workspaceRoot);
  const state = readMaintenanceState(workspaceRoot);
  writeMaintenanceState(workspaceRoot, { ...state, scan: { at: (options.now ?? new Date()).toISOString(), documents } });
  return { documents, skipped, truncated };
}

/** A person sets an item aside, with the reason (this engineer's; a changed cause makes a new item). */
export function dismissItem(workspaceRoot: string, key: string, by: string, reason: string, now = new Date()): void {
  const state = readMaintenanceState(workspaceRoot);
  writeMaintenanceState(workspaceRoot, { ...state, dismissed: { ...state.dismissed, [key]: { by, at: now.toISOString(), reason } } });
}
