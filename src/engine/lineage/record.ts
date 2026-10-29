import { ContextFileManager } from '../context/contextFileManager';
import { ObservedBatch, RecordResult, recordObservedLineage, rowsToEdges } from './observed';
import { loadCatalog, operationById, platformById } from '../platform/operations/load';
import { ConnectionTarget, runOnConnection } from '../platform/operations/service';

/** Observed edges for a connection (LIN), recorded under its estate identity: `autode lineage record` and `autode_record_observed_lineage`. */
export async function recordLineageBatch(cfm: ContextFileManager, batch: ObservedBatch, actor?: string): Promise<RecordResult & { system: string; environment: string }> {
  const { identity } = cfm.resolveConnection(batch.connectionId);
  const r = await recordObservedLineage(cfm.getLedger(), batch, identity, { actor });
  return { ...r, system: identity.system, environment: identity.environment };
}

export interface MethodReport { operation: string; edges: number; recorded: number; retired: number; complete: boolean; skipped: number; error?: string }

export interface RefreshReport {
  connectionId: string;
  platform: string;
  at: string;
  days: number;
  databases: string[];
  methods: MethodReport[];
  /** Why nothing was read: the platform has no lineage capability, or no databases are bound. */
  note?: string;
  /** What the role needs, from the platform definition (shown with a failure). */
  privileges?: string;
}

/** The databases (or catalogs) a connection's estate binding covers: the first part of each DATABASE.SCHEMA. */
export function bindingDatabases(schemas: readonly string[] | undefined): string[] {
  return [...new Set((schemas ?? []).map((s) => s.split('.')).filter((p) => p.length >= 2).map((p) => p[0].replace(/["`[\]]/g, '')))];
}

/**
 * Observed lineage for one connection (LIN through POP1): the operations the
 * platform definition names for its `lineage` capability, run read-only for
 * the databases bound to the connection; each result recorded by LIN's
 * recorder. A failed operation is reported with the privileges the platform
 * needs, and the others still run; a cut-off read retires nothing.
 */
export async function refreshLineage(input: {
  resourcesRoot?: string;
  workspaceRoot: string;
  cfm: ContextFileManager;
  target: ConnectionTarget;
  databases?: string[];
  days?: number;
  limit?: number;
  actor?: string;
  now?: Date;
}): Promise<RefreshReport> {
  const days = input.days ?? 30;
  const limit = Math.max(1, Math.min(20_000, input.limit ?? 5000));
  const catalog = loadCatalog({ resourcesRoot: input.resourcesRoot, workspaceRoot: input.workspaceRoot });
  const resolved = input.cfm.resolveConnection(input.target.connectionId);
  const databases = input.databases?.length ? input.databases : bindingDatabases(resolved.schemas);
  const report: RefreshReport = { connectionId: input.target.connectionId, platform: input.target.platform, at: (input.now ?? new Date()).toISOString(), days, databases, methods: [] };
  const cap = platformById(catalog, input.target.platform)?.capabilities.lineage;
  if (cap?.privileges) report.privileges = cap.privileges;
  const ops = cap?.support === 'not_applicable' ? [] : (cap?.operations ?? []);
  if (!ops.length) { report.note = cap?.note ?? `No lineage operations for ${input.target.platform}: its platform definition names none (platforms/${input.target.platform}.yaml, or a team copy).`; return report; }
  if (!databases.length) { report.note = `Name the databases (or catalogs) to read lineage for, or bind the connection's schemas in estate.yaml.`; return report; }
  for (const id of ops) {
    const method = id.replace(/^lineage\./, '');
    const m: MethodReport = { operation: id, edges: 0, recorded: 0, retired: 0, complete: false, skipped: 0 };
    report.methods.push(m);
    const op = operationById(catalog, id)?.item;
    if (!op) { m.error = `the operation ${id} isn't in the catalog`; continue; }
    const params: Record<string, unknown> = { databases };
    if (op.params.some((p) => p.name === 'days')) params.days = days;
    if (op.params.some((p) => p.name === 'limit')) params.limit = limit + 1;
    try {
      const r = await runOnConnection({ catalog }, input.target, id, params, { maxRows: limit });
      if (!r.ok) { m.error = r.gap ?? 'not read'; continue; }
      const { edges, skipped } = rowsToEdges(r.rows);
      const windowed = op.params.some((p) => p.name === 'days');
      const rec = await recordObservedLineage(input.cfm.getLedger(), { connectionId: input.target.connectionId, method, complete: !r.truncated, edges, databases, ...(windowed ? { windowDays: days } : {}) }, resolved.identity, { actor: input.actor, now: input.now });
      Object.assign(m, { edges: edges.length, recorded: rec.recorded, retired: rec.retired, complete: !r.truncated, skipped: skipped + rec.skipped.length });
    } catch (err) { m.error = err instanceof Error ? err.message : String(err); }
  }
  return report;
}

/** One line per operation, for the CLI and the Output channel. */
export function refreshLines(r: RefreshReport): string[] {
  if (r.note) return [r.note];
  const lines = r.methods.map((m) => m.error
    ? `✗ ${m.operation}: ${m.error}`
    : `✓ ${m.operation}: ${m.edges} edge(s), ${m.recorded} new, ${m.retired} retired${m.skipped ? `, ${m.skipped} row(s) skipped` : ''}${m.complete ? '' : ' — cut off at the row limit, nothing retired'}`);
  if (r.methods.some((m) => m.error) && r.privileges) lines.push(`  It needs: ${r.privileges}`);
  return lines;
}
