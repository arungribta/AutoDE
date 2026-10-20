import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Where AutoDE keeps things in a workspace (v0.36.0). Every path AutoDE uses
 * is defined here once, as segments relative to the workspace root, so the
 * extension (`vscode.Uri.joinPath(root, ...segments)`), the engine and the MCP
 * server (`path.join(root, ...segments)`) agree by construction.
 *
 *   .autode/            AutoDE's working state, grouped by lifecycle
 *     .gitignore        written by AutoDE: ignores local/
 *     problems/<id>/    per business problem: spec, plan, context, pack, attachments
 *     knowledge/        shared project knowledge: ledger, estate, sources, profiles,
 *                       business context, vocabulary, verified queries, snapshots
 *     config/           team customisations: skills, primitives, target environment,
 *                       connections (pointers and sample-data consent, never secrets)
 *     decisions/        proposed changes and who resolved them (committed; PA1)
 *     local/            per engineer and rebuildable: never committed (including
 *                       personal connection fields and connection readiness)
 *   autode-output/<id>/ generated deliverables (setting `artifactDirectory`)
 *
 * Before v0.36.0 everything lived in `.ai-context/` (see workspaceMigration.ts).
 */

export const AUTODE_DIR = '.autode';
export const LEGACY_DIR = '.ai-context';
/** Default for the `artifactDirectory` setting: workspace-relative, visible. */
export const DEFAULT_OUTPUT_DIR = 'autode-output';
export const UNSCOPED_PROBLEM = '_unscoped';

export const LAYOUT = {
  root: [AUTODE_DIR],
  gitignore: [AUTODE_DIR, '.gitignore'],
  problems: [AUTODE_DIR, 'problems'],
  knowledge: [AUTODE_DIR, 'knowledge'],
  ledger: [AUTODE_DIR, 'knowledge', 'ledger'],
  estate: [AUTODE_DIR, 'knowledge', 'estate.yaml'],
  sources: [AUTODE_DIR, 'knowledge', 'sources.yaml'],
  profiles: [AUTODE_DIR, 'knowledge', 'profiles'],
  businessContext: [AUTODE_DIR, 'knowledge', 'business-context.yaml'],
  verifiedQueries: [AUTODE_DIR, 'knowledge', 'verified-queries.yaml'],
  vocabulary: [AUTODE_DIR, 'knowledge', 'vocabulary.yaml'],
  snapshots: [AUTODE_DIR, 'knowledge', 'snapshots'],
  config: [AUTODE_DIR, 'config'],
  skills: [AUTODE_DIR, 'config', 'skills'],
  toolSkills: [AUTODE_DIR, 'config', 'skills', 'tool-skills'],
  primitives: [AUTODE_DIR, 'config', 'primitives'],
  targetEnvironment: [AUTODE_DIR, 'config', 'target-environment.yaml'],
  connections: [AUTODE_DIR, 'config', 'connections.yaml'],
  decisions: [AUTODE_DIR, 'decisions'],
  local: [AUTODE_DIR, 'local'],
  localConnections: [AUTODE_DIR, 'local', 'connections.yaml'],
  connectionReadiness: [AUTODE_DIR, 'local', 'connection-readiness.json'],
  activeProblem: [AUTODE_DIR, 'local', 'active-problem.json'],
  chats: [AUTODE_DIR, 'local', 'chats'],
  carryover: [AUTODE_DIR, 'local', 'chats', 'carryover'],
  derived: [AUTODE_DIR, 'local', 'derived'],
  graph: [AUTODE_DIR, 'local', 'derived', 'graph.json'],
  catalog: [AUTODE_DIR, 'local', 'catalog'],
  schemaGraph: [AUTODE_DIR, 'local', 'schema-graph.json']
} as const;

export type LayoutKey = keyof typeof LAYOUT;

/** Absolute path of a layout entry. */
export function layoutPath(workspaceRoot: string, key: LayoutKey, ...more: string[]): string {
  return path.join(workspaceRoot, ...LAYOUT[key], ...more);
}

/** Workspace-relative POSIX path of a layout entry, for messages and documents. */
export function layoutRel(key: LayoutKey, ...more: string[]): string {
  return [...LAYOUT[key], ...more].join('/');
}

export function problemRootPath(workspaceRoot: string, problemId: string): string {
  return layoutPath(workspaceRoot, 'problems', problemId);
}

/** The workspace root and problem id a problem folder (`<root>/.autode/problems/<id>`) belongs to. */
export function problemFromRoot(problemRoot: string): { workspaceRoot: string; problemId: string } {
  const normalized = path.resolve(problemRoot);
  return { workspaceRoot: path.dirname(path.dirname(path.dirname(normalized))), problemId: path.basename(normalized) };
}

/**
 * Where a problem's generated deliverables go: `<root>/<artifactDirectory>/<problemId>`.
 * The setting is workspace-relative; absolute values and `..` are refused (the
 * default is used instead), so artifacts never leave the workspace.
 */
export function outputDirPath(workspaceRoot: string, problemId: string, configured?: string): string {
  return path.join(workspaceRoot, ...outputDirSegments(problemId, configured));
}

/** The same location as workspace-relative segments (for `vscode.Uri.joinPath`). */
export function outputDirSegments(problemId: string, configured?: string): string[] {
  const given = String(configured ?? '').trim().replace(/\\/g, '/');
  // Absolute paths (/x, C:/x, //server/x) and any '..' are refused: artifacts never leave the workspace.
  const absolute = given.startsWith('/') || /^[A-Za-z]:/.test(given) || path.isAbsolute(given);
  const raw = given.replace(/\/+$/g, '');
  const safe = raw && !absolute && !raw.split('/').includes('..') ? raw : DEFAULT_OUTPUT_DIR;
  return [...safe.split('/').filter(Boolean), problemId];
}

export const AUTODE_GITIGNORE = [
  '# Written by AutoDE. local/ holds per-engineer state and rebuildable caches',
  '# (chat transcripts, the active problem, derived graph, catalog): never commit it.',
  'local/',
  ''
].join('\n');

/** Creates `.autode/` with its `.gitignore` and the knowledge/, config/ and local/ folders when missing. Idempotent; never overwrites an edited `.gitignore`. */
export function ensureLayout(workspaceRoot: string): void {
  for (const key of ['knowledge', 'config', 'local'] as const) fs.mkdirSync(layoutPath(workspaceRoot, key), { recursive: true });
  const ignore = layoutPath(workspaceRoot, 'gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, AUTODE_GITIGNORE);
}
