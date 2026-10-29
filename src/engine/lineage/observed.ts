import { Assertion, canonicalJson, isLive } from '../context/assertions';
import { ObjectIdentity, objectId, parseObjectId, slugifyId } from '../context/estate';
import { AssertionLedger, LedgerEvent } from '../context/ledger';

/**
 * Observed lineage (LIN, docs/specs/context-layer.md §8.5), platform
 * neutral. The engine knows no platform's lineage views: edges read from a
 * platform (by its operations, once the platform operations catalog lands),
 * a vendor's lineage API or OpenLineage events come in as a batch, and are
 * recorded here as `verified` `lineage` facts under the connection's estate
 * system and environment. Idempotent; an edge a complete batch no longer
 * contains is retired with the reason, never deleted.
 */

export interface ObservedEnd { object: string; column?: string }

export interface ObservedEdge {
  upstream: ObservedEnd;
  /** Absent when only a job, notebook or report read the upstream object. */
  downstream?: ObservedEnd;
  /** The job, notebook, pipeline or report that moved (or read) the data. */
  entity?: { type: string; id: string; name?: string };
}

export interface ObservedBatch {
  connectionId: string;
  /** Where the edges came from (`access_history`, `column_lineage`, `openlineage` …). */
  method: string;
  /** False when the read was cut off or partial: edges missing from it are then not retired. */
  complete: boolean;
  edges: ObservedEdge[];
  windowDays?: number;
  /** DATABASE (or catalog) names the read covered; edges outside them are left alone when retiring. */
  databases?: string[];
}

export interface RecordResult { recorded: number; unchanged: number; retired: number; skipped: Array<{ edge: number; reason: string }> }

const MAX_EDGES = 20_000;

/**
 * Rows in the lineage operations' result shape (upstream_object, upstream_column, downstream_object,
 * downstream_column, entity_type, entity_id, entity_name) as edges; a row missing an end is skipped and counted.
 */
export function rowsToEdges(rows: ReadonlyArray<Record<string, unknown>>): { edges: ObservedEdge[]; skipped: number } {
  const edges: ObservedEdge[] = [];
  let skipped = 0;
  for (const raw of rows) {
    const r: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (v !== null && v !== undefined && String(v).trim() !== '') r[k.toLowerCase()] = String(v).trim();
    const entity = r.entity_id ? { type: r.entity_type ?? 'job', id: r.entity_id, ...(r.entity_name ? { name: r.entity_name } : {}) } : undefined;
    if (!r.upstream_object || (!r.downstream_object && !entity)) { skipped++; continue; }
    edges.push({
      upstream: { object: r.upstream_object, ...(r.upstream_column ? { column: r.upstream_column } : {}) },
      ...(r.downstream_object ? { downstream: { object: r.downstream_object, ...(r.downstream_column ? { column: r.downstream_column } : {}) } } : {}),
      ...(entity ? { entity } : {})
    });
  }
  return { edges, skipped };
}

/** The id of a job, notebook or report a lineage source names. */
export function entityNodeId(identity: Pick<ObjectIdentity, 'system' | 'environment'>, entity: { type: string; id: string }): string {
  return `job:${identity.system}/${identity.environment}/${slugifyId(entity.type)}/${entity.id}`;
}

/** Reports (dashboards, saved queries, workbooks) apart from pipelines (jobs, notebooks, pipelines). */
export function isReportEntity(type: string): boolean {
  return /dashboard|report|workbook|query|sheet|visual/i.test(type);
}

interface LineageValue {
  upstream: string; downstream: string; level: 'table' | 'column';
  source: 'observed'; method: string; connection: string; scope: string;
  entity?: { type: string; id: string; name?: string };
}

const nameOf = (id: string) => parseObjectId(id)?.path ?? id;
const keyOf = (v: Pick<LineageValue, 'method' | 'upstream' | 'downstream'> & { entity?: { id: string } }) => `${v.method}|${v.upstream}|${v.downstream}|${v.entity?.id ?? ''}`;

function valueOf(e: ObservedEdge, batch: ObservedBatch, identity: Pick<ObjectIdentity, 'system' | 'environment'>): LineageValue | string {
  const clean = (s: string) => s.replace(/["`[\]]/g, '');
  const parts = (o: string) => clean(o).split('.').filter(Boolean);
  if (parts(e.upstream.object).length < 2) return `upstream "${e.upstream.object}" is not a qualified object name`;
  if (e.downstream && parts(e.downstream.object).length < 2) return `downstream "${e.downstream.object}" is not a qualified object name`;
  const end = (x: ObservedEnd) => objectId(identity.system, identity.environment, clean(x.object), x.column ? clean(x.column) : undefined);
  const columnLevel = !!e.upstream.column && !!e.downstream?.column;
  const upstream = columnLevel ? end(e.upstream) : objectId(identity.system, identity.environment, clean(e.upstream.object));
  const downstream = e.downstream ? end(columnLevel ? e.downstream : { object: e.downstream.object }) : e.entity ? entityNodeId(identity, e.entity) : '';
  if (upstream === downstream) return 'an object that derives from itself';
  return {
    upstream, downstream, level: columnLevel ? 'column' : 'table', source: 'observed', method: batch.method, connection: batch.connectionId,
    scope: `${identity.system}/${identity.environment}`, ...(e.entity ? { entity: { type: e.entity.type, id: e.entity.id, ...(e.entity.name ? { name: e.entity.name } : {}) } } : {})
  };
}

/** Live observed lineage facts this batch speaks for: same connection scope and method, inside its databases. */
function coveredBy(a: Assertion, batch: ObservedBatch, scope: string): boolean {
  const v = a.value as Partial<LineageValue>;
  if (a.kind !== 'lineage' || v.source !== 'observed' || v.method !== batch.method || v.scope !== scope || !isLive(a.status)) return false;
  if (!batch.databases?.length) return true;
  const dbs = new Set(batch.databases.map((d) => d.toLowerCase()));
  const db = (id: string | undefined) => (id ? parseObjectId(id)?.path.split('.')[0] : undefined);
  return [db(v.upstream), db(v.downstream)].some((d) => !!d && dbs.has(d));
}

/**
 * Records a batch: a new edge is a `verified` lineage fact; one already
 * recorded is left alone (nothing appended); when the batch is complete, a
 * recorded edge it no longer contains is rejected with the reason, never
 * deleted. Idempotent.
 */
export async function recordObservedLineage(ledger: AssertionLedger, batch: ObservedBatch, identity: Pick<ObjectIdentity, 'system' | 'environment'>, options: { actor?: string; now?: Date } = {}): Promise<RecordResult> {
  if (!/^[a-z0-9_-]+$/i.test(batch.method)) throw new Error(`method "${batch.method}" must be a short name (letters, digits, _ and -).`);
  if (batch.edges.length > MAX_EDGES) throw new Error(`At most ${MAX_EDGES} edges per batch (got ${batch.edges.length}).`);
  const actor = options.actor ?? 'system';
  const scope = `${identity.system}/${identity.environment}`;
  const existing = new Map<string, Assertion>();
  for (const a of ledger.assertions()) if (coveredBy(a, batch, scope)) existing.set(keyOf(a.value as LineageValue), a);
  const events: LedgerEvent[] = [];
  const seen = new Set<string>();
  const skipped: RecordResult['skipped'] = [];
  let unchanged = 0;
  batch.edges.forEach((e, i) => {
    const v = valueOf(e, batch, identity);
    if (typeof v === 'string') { skipped.push({ edge: i, reason: v }); return; }
    const key = keyOf(v);
    if (seen.has(key)) return;
    seen.add(key);
    const prev = existing.get(key);
    if (prev && canonicalJson(prev.value) === canonicalJson(v)) { unchanged++; return; }
    const via = v.entity ? ` by ${v.entity.type} ${v.entity.name ?? v.entity.id}` : '';
    events.push(ledger.buildAsserted({
      kind: 'lineage', subject: [v.downstream, v.upstream], predicate: 'derives_from', value: v,
      statement: v.downstream.startsWith('job:') ? `${nameOf(v.upstream)} is read${via} (observed: ${batch.method} on ${batch.connectionId}).` : `${nameOf(v.downstream)} derives from ${nameOf(v.upstream)}${via} (observed: ${batch.method} on ${batch.connectionId}).`,
      evidence: [{ type: 'introspection', ref: `${batch.connectionId}:${batch.method}`, ...(batch.windowDays ? { excerpt: `last ${batch.windowDays} days` } : {}) }],
      trust: 'verified', status: 'active', createdBy: actor, ...(prev ? { supersedes: prev.id } : {})
    }));
    if (prev) events.push(ledger.buildEvent('superseded', prev.id, actor, { by: events[events.length - 1].assertionId }));
  });
  let retired = 0;
  if (batch.complete) {
    const at = (options.now ?? new Date()).toISOString().slice(0, 10);
    for (const [key, a] of existing) {
      if (seen.has(key)) continue;
      events.push(ledger.buildEvent('rejected', a.id, actor, { reason: `Not observed by ${batch.method}${batch.windowDays ? ` in the last ${batch.windowDays} days` : ''} (read of ${at}).` }));
      retired++;
    }
  }
  await ledger.append(events);
  return { recorded: events.filter((e) => e.type === 'asserted').length, unchanged, retired, skipped };
}
