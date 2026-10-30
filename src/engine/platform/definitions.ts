import * as fs from 'node:fs';
import * as path from 'node:path';
import { Catalog, loadCatalog, operationById, platformById } from './operations/load';
import { PlatformDefinition, PlatformOperation } from './operations/types';

/**
 * Where AutoDE finds the platform definitions and operations in effect
 * (POP1; v0.55.0 for the platforms that have no adapter class). The entry
 * points register the shipped root (`setPlatformResourcesRoot`); otherwise
 * it is the package this module ships in. The shipped catalog is read once;
 * a workspace's (with the team's approved files) is read on each call, so
 * an approval or an edit takes effect at once.
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

export function platformDefinition(platformId: string | undefined, scope: PlatformScope = {}): PlatformDefinition | undefined {
  return platformId ? platformById(platformCatalog(scope), platformId) : undefined;
}

export function platformOperation(operationId: string, scope: PlatformScope = {}): PlatformOperation | undefined {
  return operationById(platformCatalog(scope), operationId)?.item;
}

/** The platforms whose connection is described by their definition (no card or adapter written for them). */
export function definedConnectionPlatforms(scope: PlatformScope = {}): PlatformDefinition[] {
  return platformCatalog(scope).platforms.filter((p) => p.status === 'approved' && !!p.item.connection && !!p.item.access?.cli?.statement).map((p) => p.item);
}
