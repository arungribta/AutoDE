import { Catalog, loadCatalog, operationById } from './load';
import { lastRuns, normalizeKind, readObjectKinds, readOperationRuns } from './runLog';
import { operationDigest } from './execute';
import { skillOperations, skillTexts } from './catalogView';

/**
 * POP3, drift (docs/specs/platform-operations.md §6.4): what the platforms say has changed under AutoDE's
 * operations, from the recorded runs and estate reads, never from a model:
 * - **operation drift:** the last run of an operation on a connection failed because the platform's version is
 *   outside the implementation's range, or its error says a view or column is missing. It holds while the
 *   operation in effect is the content that failed: fixing the file (a team copy approved) closes it, and a later
 *   run that succeeds does too;
 * - **an unread object kind:** an estate read reported objects of a kind the platform's definition doesn't name.
 *   It holds until the definition (a team copy) names the kind.
 * The maintenance queue turns these into items for the platform maintainer.
 */

export interface OperationDrift {
  key: string;
  operation: string;
  connection: string;
  platform: string;
  version?: string;
  kind: 'version' | 'missing-object';
  error: string;
  at: string;
  /** Skills whose text names the operation, with their owners. */
  skills: Array<{ id: string; owner?: string }>;
}

export interface UnreadKind { key: string; platform: string; kind: string; count: number; connections: string[] }

export interface DriftReport { operations: OperationDrift[]; kinds: UnreadKind[] }

export function driftReport(scope: { resourcesRoot?: string; workspaceRoot?: string }, catalog: Catalog = loadCatalog(scope)): DriftReport {
  if (!scope.workspaceRoot) return { operations: [], kinds: [] };
  const operations: OperationDrift[] = [];
  let texts: ReturnType<typeof skillTexts> | undefined;
  for (const r of lastRuns(readOperationRuns(scope.workspaceRoot)).values()) {
    if (r.ok || (r.kind !== 'version' && r.kind !== 'missing-object')) continue;
    const op = operationById(catalog, r.operation)?.item;
    // The file changed since (or the operation is gone): this failure is no longer the current content's.
    if (!op || (r.digest && r.digest !== operationDigest(op))) continue;
    texts ??= scope.resourcesRoot ? skillTexts({ resourcesRoot: scope.resourcesRoot, workspaceRoot: scope.workspaceRoot }) : { texts: [], entries: [] };
    const skills = texts.texts.filter((t) => skillOperations(t.text, catalog).uses.some((u) => u.id === r.operation)).map((t) => ({ id: t.id, ...(texts!.entries.find((e) => e.name === t.id)?.owner ? { owner: texts!.entries.find((e) => e.name === t.id)!.owner } : {}) }));
    operations.push({ key: `${r.operation}@${r.connection}`, operation: r.operation, connection: r.connection, platform: r.platform, ...(r.version ? { version: r.version } : {}), kind: r.kind, error: r.error ?? '', at: r.at, skills });
  }
  const byKind = new Map<string, UnreadKind>();
  for (const o of Object.values(readObjectKinds(scope.workspaceRoot))) {
    const def = catalog.platforms.find((p) => p.item.id === o.platform && p.status === 'approved')?.item;
    if (!def) continue;
    const known = new Set((def.objectKinds ?? []).map(normalizeKind));
    for (const [kind, count] of Object.entries(o.kinds)) {
      if (known.has(kind)) continue;
      const key = `${o.platform}:${kind}`;
      const cur = byKind.get(key) ?? { key, platform: o.platform, kind, count: 0, connections: [] };
      cur.count += count; cur.connections.push(o.connection);
      byKind.set(key, cur);
    }
  }
  return { operations, kinds: [...byKind.values()] };
}
