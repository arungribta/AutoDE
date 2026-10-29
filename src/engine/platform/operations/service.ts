import { Catalog, loadCatalog, operationById, platformById } from './load';
import { OperationRunner, RunResult, bindOperation, connectionVersion, runOperation } from './execute';
import { Origin, PlatformOperation } from './types';

/**
 * The catalog for every surface (POP1): what exists, and running one
 * operation on a connection — the same for the CLI, MCP, the panel and
 * AutoDE's own features (LIN's lineage).
 */

export interface OperationSummary {
  id: string;
  title: string;
  description: string;
  kind: 'read' | 'change';
  area: string;
  content: 'metadata' | 'data';
  platforms: string[];
  params: Array<{ name: string; type: string; label: string; required: boolean; default?: unknown }>;
  returns: string[];
  origin: Origin;
  status: 'approved' | 'draft';
  file: string;
  overrides?: boolean;
  /** The platform capabilities that name it (platform: capability). */
  usedBy: string[];
}

export function summarize(catalog: Catalog): OperationSummary[] {
  return catalog.operations.map((o) => ({
    id: o.item.id, title: o.item.title, description: o.item.description, kind: o.item.kind, area: o.item.area, content: o.item.content ?? 'data',
    platforms: Object.keys(o.item.platforms),
    params: o.item.params.map((p) => ({ name: p.name, type: p.type, label: p.label, required: p.required !== false && p.default === undefined, ...(p.default !== undefined ? { default: p.default } : {}) })),
    returns: o.item.returns.map((r) => r.name),
    origin: o.origin, status: o.status, file: o.file, ...(o.overrides ? { overrides: true } : {}),
    usedBy: catalog.platforms.filter((p) => p.status === 'approved').flatMap((p) => Object.entries(p.item.capabilities).filter(([, c]) => (c.operations ?? []).includes(o.item.id)).map(([cap]) => `${p.item.id}: ${cap}`))
  })).sort((a, b) => a.id.localeCompare(b.id) || a.origin.localeCompare(b.origin));
}

export interface ConnectionTarget {
  connectionId: string;
  platform: string;
  /** Runs one statement on the connection (its CLI or API, read-only: the executor checks it again). */
  query(sql: string, maxRows: number): Promise<Array<Record<string, unknown>>>;
  cli?: OperationRunner['cli'];
}

export class OperationError extends Error {
  public constructor(public readonly code: 'NOT_FOUND' | 'VALIDATION_FAILED' | 'CHANGE', message: string, public readonly step?: { kind: 'sql' | 'cli'; title: string; sql?: string; argv?: string[]; expect: string }) { super(message); }
}

/** Runs a read operation on a connection; a change operation is refused with the runbook step it would be. */
export async function runOnConnection(scope: { resourcesRoot?: string; workspaceRoot?: string; catalog?: Catalog }, target: ConnectionTarget, operationId: string, params: Record<string, unknown>, options: { maxRows?: number } = {}): Promise<RunResult> {
  const catalog = scope.catalog ?? loadCatalog(scope);
  const loaded = operationById(catalog, operationId);
  if (!loaded) {
    const draft = catalog.operations.find((o) => o.item.id === operationId);
    throw new OperationError('NOT_FOUND', draft ? `${operationId} is a team draft (${draft.file}): a person approves it first (autode platform propose ${draft.file}, then the decision).` : `No operation ${operationId} (autode platform operations lists them).`);
  }
  const op: PlatformOperation = loaded.item;
  const platform = platformById(catalog, target.platform);
  if (op.kind === 'change') {
    let bound;
    try { bound = bindOperation(op, target.platform, params, platform); } catch (err) { throw new OperationError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err)); }
    throw new OperationError('CHANGE', `${operationId} changes the platform: propose it as a runbook step (autode_propose_runbook); a person approves it and AutoDE's runner runs it.`, { kind: bound.statement ? 'sql' : 'cli', title: op.title, ...(bound.statement ? { sql: bound.statement } : {}), ...(bound.argv ? { argv: bound.argv } : {}), expect: op.description });
  }
  const runner: OperationRunner = { sql: (s, n) => target.query(s, n), ...(target.cli ? { cli: target.cli } : {}) };
  const versionOp = platform?.versionOperation ? operationById(catalog, platform.versionOperation)?.item : undefined;
  const version = await connectionVersion(target.connectionId, platform, versionOp, runner);
  try {
    return await runOperation({ operation: op, platformId: target.platform, platform, params, runner, version, maxRows: options.maxRows });
  } catch (err) {
    throw new OperationError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err));
  }
}
