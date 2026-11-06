import * as fs from 'node:fs';
import * as path from 'node:path';
import { Catalog, loadCatalog, operationById, platformById, readApprovalsStamp } from './operations/load';
import { layoutPath } from '../workspaceLayout';
import { PlatformDefinition, PlatformOperation } from './operations/types';

/**
 * Where AutoDE finds the platform definitions and operations in effect
 * (POP1; v0.55.0 for the platforms that have no adapter class). The entry
 * points register the shipped root (`setPlatformResourcesRoot`); otherwise
 * it is the package this module ships in. The shipped catalog is read once;
 * a workspace's (with the team's approved files) is read on each call, so
 * an approval or an edit takes effect at once.
 *
 * POP5: code that knows only a platform's id (connection fields, credential
 * variables, dialects) finds a team-defined platform through the workspace last
 * registered (`usePlatformWorkspace`, called wherever a workspace's connections
 * are read). Shipped platforms are found first, without touching the workspace.
 */

export interface PlatformScope { resourcesRoot?: string; workspaceRoot?: string }

let registeredRoot: string | undefined;
const changed: Array<() => void> = [];
let shippedCatalog: { root: string | undefined; catalog: Catalog } | undefined;

/** Where AutoDE's shipped platform definitions are (the extension, the CLI package, the MCP server set it at start). */
export function setPlatformResourcesRoot(resourcesRoot: string): void {
  registeredRoot = resourcesRoot;
  shippedCatalog = undefined;
  for (const f of changed) f();
}

/** Called when the root changes (caches built on the catalog drop theirs). */
export function onPlatformResourcesRootChange(f: () => void): void { changed.push(f); }

/** Unset: the package this module ships in (bundled in dist/, or compiled to dist/engine/platform/). */
function shippedRoot(): string | undefined {
  for (let dir = __dirname, i = 0; i < 4; i++, dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'platforms')) && fs.existsSync(path.join(dir, 'platform-operations'))) return dir;
  }
  return undefined;
}

export function platformResourcesRoot(scope: PlatformScope = {}): string | undefined {
  return scope.resourcesRoot ?? registeredRoot ?? shippedRoot();
}

/** The catalog in effect: the shipped one (read once), or with the workspace's approved files (read each time). */
export function platformCatalog(scope: PlatformScope = {}): Catalog {
  const resourcesRoot = platformResourcesRoot(scope);
  if (scope.workspaceRoot) return loadCatalog({ resourcesRoot, workspaceRoot: scope.workspaceRoot });
  if (!shippedCatalog || shippedCatalog.root !== resourcesRoot) shippedCatalog = { root: resourcesRoot, catalog: loadCatalog({ resourcesRoot }) };
  return shippedCatalog.catalog;
}

let workspaceRoot: string | undefined;
let teamCatalog: { key: string; catalog: Catalog } | undefined;

/** POP5: the workspace whose team platforms count where a caller has only a platform's id. */
export function usePlatformWorkspace(root: string | undefined): void {
  if (root !== workspaceRoot) teamCatalog = undefined;
  workspaceRoot = root;
}

/** The team's definitions change only with their files or an approval: their names, times and the approvals are the key. */
function teamDefinitionsStamp(root: string): string {
  const dir = layoutPath(root, 'platformDefinitions');
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n)).sort(); } catch { return ''; }
  const stamps = names.map((n) => { try { return `${n}:${fs.statSync(path.join(dir, n)).mtimeMs}`; } catch { return n; } });
  return `${stamps.join('|')}#${readApprovalsStamp(root)}`;
}

function registeredTeamDefinition(platformId: string, scope: PlatformScope): PlatformDefinition | undefined {
  if (!workspaceRoot) return undefined;
  const stamp = teamDefinitionsStamp(workspaceRoot);
  if (!stamp) return undefined;
  const key = `${workspaceRoot}#${platformResourcesRoot(scope) ?? ''}#${stamp}`;
  if (teamCatalog?.key !== key) teamCatalog = { key, catalog: platformCatalog({ ...scope, workspaceRoot }) };
  return platformById(teamCatalog.catalog, platformId);
}

export function platformDefinition(platformId: string | undefined, scope: PlatformScope = {}): PlatformDefinition | undefined {
  if (!platformId) return undefined;
  return platformById(platformCatalog(scope), platformId) ?? (scope.workspaceRoot ? undefined : registeredTeamDefinition(platformId, scope));
}

export function platformOperation(operationId: string, scope: PlatformScope = {}): PlatformOperation | undefined {
  return operationById(platformCatalog(scope), operationId)?.item;
}

/** Whether a definition says enough to connect without an adapter or a card written for it: a CLI statement, an API or a folder (POP5). */
export function connectsByDefinition(p: PlatformDefinition): boolean {
  return !!p.connection && (!!p.access?.cli?.statement || !!p.access?.api?.baseUrlField || !!p.access?.file?.rootField);
}

/** The platforms whose connection is described by their definition (no card or adapter written for them). */
export function definedConnectionPlatforms(scope: PlatformScope = {}): PlatformDefinition[] {
  return platformCatalog(scope.workspaceRoot ? scope : { ...scope, workspaceRoot }).platforms.filter((p) => p.status === 'approved' && connectsByDefinition(p.item)).map((p) => p.item);
}
