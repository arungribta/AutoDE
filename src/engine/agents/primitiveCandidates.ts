import { Assertion } from '../context/assertions';
import { BaseNode } from '../context/types';
import { SchemaIndex, typeClassOf } from '../grounding/sqlGrounding';
import { listPrimitives, validateTransformSpec } from '../transforms/registry';
import { PipelineEntity, PipelineTransformStep } from '../pipelineSpec/types';

/**
 * `autode_primitive_candidates` (PA3b, v0.45.4): the transform steps a
 * mapped entity needs, as primitives with their parameters filled in from
 * what AutoDE knows — a staging projection that renames and casts the mapped
 * columns, deduplication on the key fact keeping the latest row by the
 * change column, an incremental MERGE on the key — each with its reasons and
 * validated against the primitive's schema. What no primitive covers yet
 * (column expressions) is listed, not hidden. The pipeline engineer decides.
 */

export interface CandidateColumn { source: string; target: string; type?: string; transform?: string }

export interface CandidateStep extends PipelineTransformStep { reasons: string[]; valid: boolean; errors: string[] }

export interface CandidateResult {
  entity: Omit<PipelineEntity, 'transforms'> & { transforms: CandidateStep[] };
  /** What the steps don't cover, and what is missing to suggest more. */
  notes: string[];
  /** Other primitives registered in this workspace, for the agent to consider. */
  available: Array<{ kind: string; description: string }>;
}

const LIVE = new Set(['active', 'proposed', 'needs_review']);
const CHANGE_COLUMN = /(updated|modified|changed|last_?upd|load(ed)?_?(at|ts|date|time)|ingest|extract(ed)?_?(at|ts))/i;

function refOf(ref: string, nodes: readonly BaseNode[]): string {
  const n = nodes.find((x) => x.id === ref) as (BaseNode & { fqn?: string }) | undefined;
  return String(n?.fqn || n?.label || ref).replace(/^obj:/, '').toLowerCase();
}

const last = (fqn: string) => fqn.split('.').pop()!;

export function primitiveCandidates(input: {
  source: string;
  target?: string;
  columns?: CandidateColumn[];
  schemaIndex: SchemaIndex;
  assertions: readonly Assertion[];
  nodes: readonly BaseNode[];
}): CandidateResult {
  const lower = input.source.toLowerCase();
  const table = input.schemaIndex.tables.find((t) => t.fqn.toLowerCase() === lower) ?? (input.schemaIndex.byName.get(last(lower)) ?? [])[0];
  if (!table) throw new Error(`${input.source} is not in the estate AutoDE knows.`);
  const notes: string[] = [];
  const columns: CandidateColumn[] = input.columns?.length ? input.columns : [...table.columns.entries()].map(([name, type]) => ({ source: name, target: name, type: type || undefined }));
  const toTarget = new Map(columns.map((c) => [c.source.toLowerCase(), c.target]));
  // Default names keep the schema: two systems' `customers` tables stay two entities.
  const flat = table.fqn.toLowerCase().split('.').slice(-2).join('_');
  const targetObject = input.target ?? flat;
  const staging = `stg_${flat}`;
  const steps: CandidateStep[] = [];
  const add = (kind: string, params: Record<string, unknown>, reasons: string[]) => {
    const v = validateTransformSpec({ kind, params });
    steps.push({ kind, params, reasons, valid: v.valid, errors: v.errors });
  };
  // 1. Staging: project, rename and cast the mapped columns. Expressions aren't a primitive yet.
  const plain = columns.filter((c) => !c.transform);
  const exprs = columns.filter((c) => c.transform);
  const renamed = plain.filter((c) => c.source.toLowerCase() !== c.target.toLowerCase()).length;
  const cast = plain.filter((c) => c.type && table.columns.get(c.source.toLowerCase()) && typeClassOf(c.type) !== typeClassOf(table.columns.get(c.source.toLowerCase())!)).length;
  if (plain.length) add('rename_cast', { sourceObject: table.fqn, targetObject: staging, objectKind: 'view', columns: plain.map((c) => ({ source: c.source, target: c.target, ...(c.type ? { type: c.type } : {}) })) },
    [`projects the ${plain.length} mapped column(s) of ${table.fqn}`, ...(renamed ? [`renames ${renamed}`] : []), ...(cast ? [`casts ${cast}`] : [])]);
  if (exprs.length) notes.push(`${exprs.length} column(s) need an expression no primitive covers yet: ${exprs.map((c) => `${c.target} = ${c.transform}`).join('; ')}. Add them as a reviewed SQL step and check its grounding.`);
  // 2. The key and the change column, from facts and the source's columns.
  // The fact is about this table: its fully qualified name, or a bare name only when it is unqualified.
  const about = (s: string) => { const r = refOf(s, input.nodes); return r === table.fqn.toLowerCase() || (!r.includes('.') && r === last(table.fqn).toLowerCase()); };
  const key = input.assertions.find((a) => a.kind === 'key' && LIVE.has(a.status) && a.subject.some(about) && Array.isArray(a.value));
  const keyCols = key ? (key.value as string[]).map((c) => toTarget.get(c.toLowerCase())) : undefined;
  const change = [...table.columns.entries()].find(([n, t]) => CHANGE_COLUMN.test(n) && typeClassOf(t) === 'temporal' && toTarget.has(n));
  const changeCol = change ? toTarget.get(change[0])! : undefined;
  let current = plain.length ? staging : table.fqn;
  if (!key) notes.push(`No key is known for ${table.fqn}: deduplication and incremental loads need one (propose the key as a fact).`);
  else if (!keyCols!.every(Boolean)) notes.push(`The key of ${table.fqn} (${(key.value as string[]).join(', ')}) isn't fully mapped.`);
  else {
    const dupes = input.assertions.some((a) => a.kind === 'data_fact' && LIVE.has(a.status) && a.subject.some((s) => refOf(s, input.nodes).startsWith(table.fqn.toLowerCase())) && typeof (a.value as { distinctCount?: number; rowCount?: number }).distinctCount === 'number' && (a.value as { distinctCount: number; rowCount?: number }).distinctCount < ((a.value as { rowCount?: number }).rowCount ?? Infinity));
    if (changeCol) {
      add('dedup', { sourceObject: current, targetObject: `${staging}_dedup`, objectKind: 'view', partitionByColumns: keyCols, orderByColumn: changeCol, orderDirection: 'DESC' },
        [`one row per ${keyCols!.join(', ')} (key from fact ${key.id}, ${key.trust}${key.status === 'active' ? '' : `, ${key.status}: not confirmed yet, so the build's manifest will show it unbacked`})`, `keeps the latest by ${changeCol}`, ...(dupes ? ['a profile shows duplicate keys'] : [])]);
      current = `${staging}_dedup`;
      const update = columns.map((c) => c.target).filter((c) => !keyCols!.includes(c));
      if (update.length) add('incremental_load', { sourceObject: current, targetObject, keyColumns: keyCols, updateColumns: update },
        [`MERGE into ${targetObject} on ${keyCols!.join(', ')}`, `${changeCol} lets each run pick up only changed rows`]);
    } else notes.push(`${table.fqn} has no change column (updated_at, modified …): deduplication needs an order and incremental loads need one; a full refresh may be the right choice.`);
  }
  const used = new Set(steps.map((s) => s.kind));
  return {
    entity: { name: targetObject, source: { object: table.fqn, type: 'table' }, target: { object: targetObject, materialization: 'table' }, transforms: steps },
    notes,
    available: listPrimitives().filter((p) => !used.has(p.kind)).map((p) => ({ kind: p.kind, description: p.description }))
  };
}
