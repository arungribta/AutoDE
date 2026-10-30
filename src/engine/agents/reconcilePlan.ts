import { typeClassOf } from '../grounding/sqlGrounding';
import { fill, fragmentsFor } from '../platform/dialects';

/**
 * Reconciliation plans (v0.45.11, mcp-engine §9.2 PA3 §9): read-only queries
 * that compare a source table with its target, generated deterministically so
 * that the reconciliation skill never hand-writes them. One aggregate query
 * per side — row count, distinct keys, and per mapped column a sum (numbers),
 * a minimum and maximum (dates), a distinct count (text) and a null count —
 * and the comparisons to make between their results. When both sides are on
 * the same platform a key hash is added (the hash functions differ between
 * platforms, so it is never compared across them); when both are on the same
 * connection, keys missing on either side are counted with anti-joins.
 * Nothing here runs a query: the stage's agent runs them read-only.
 */

export interface ReconcileColumn { name: string; type?: string }
export interface ReconcileSide { table: string; platform?: string; columns: ReconcileColumn[]; where?: string }
export interface ReconcileInput {
  source: ReconcileSide;
  target: ReconcileSide;
  /** Key columns as named on each side (same order). */
  keys: Array<{ source: string; target: string }>;
  /** Mapped columns to compare; the key columns are compared through the keys. */
  columns: Array<{ source: string; target: string }>;
  /** Both tables are reachable through one connection: adds the missing-keys queries. */
  sameConnection?: boolean;
}

export interface ReconcileQuery { id: string; side: 'source' | 'target' | 'both'; purpose: string; sql: string }
export interface ReconcileComparison { metric: string; source: string; target: string; rule: 'equal' | 'zero' | 'within-tolerance' }
export interface ReconcilePlan { queries: ReconcileQuery[]; comparisons: ReconcileComparison[]; notes: string[] }

const alias = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60);

function keyDistinct(platform: string | undefined, keys: readonly string[]): string {
  if (keys.length === 1) return `COUNT(DISTINCT ${keys[0]})`;
  // Where the platform counts distinct tuples directly (its definition says so), use that; elsewhere count distinct concatenations.
  if (fragmentsFor(platform).distinctTuples === 'native') return `COUNT(DISTINCT ${keys.join(', ')})`;
  return `COUNT(DISTINCT ${keys.map((k) => `COALESCE(CAST(${k} AS VARCHAR(4000)), '~')`).join(` || '|' || `)})`;
}

/** An order-independent hash of the keys, where the platform's definition has one. */
function keyHash(platform: string, keys: readonly string[]): string | undefined {
  const f = fragmentsFor(platform).keyHash;
  return f ? fill(f, { keys: keys.join(', ') }) : undefined;
}

function sideQuery(side: ReconcileSide, keys: readonly string[], cols: ReadonlyArray<{ mine: string; label: string }>, hash: boolean): { sql: string; metrics: string[] } {
  const typeOf = (c: string) => side.columns.find((x) => x.name.toLowerCase() === c.toLowerCase())?.type ?? '';
  const select: Array<[string, string]> = [['row_count', 'COUNT(*)'], ['key_distinct', keyDistinct(side.platform, keys)]];
  for (const k of keys) select.push([`key_nulls_${alias(k)}`, `COUNT(*) - COUNT(${k})`]);
  if (hash) { const h = keyHash(side.platform ?? '', keys); if (h) select.push(['key_hash', h]); }
  for (const c of cols) {
    const cls = typeClassOf(typeOf(c.mine));
    const a = alias(c.label);
    if (cls === 'numeric') select.push([`sum_${a}`, `SUM(${c.mine})`]);
    if (cls === 'temporal') { select.push([`min_${a}`, `MIN(${c.mine})`]); select.push([`max_${a}`, `MAX(${c.mine})`]); }
    if (cls === 'string') select.push([`distinct_${a}`, `COUNT(DISTINCT ${c.mine})`]);
    select.push([`nulls_${a}`, `COUNT(*) - COUNT(${c.mine})`]);
  }
  const sql = `SELECT\n  ${select.map(([n, e]) => `${e} AS ${n}`).join(',\n  ')}\nFROM ${side.table}${side.where ? `\nWHERE ${side.where}` : ''}`;
  return { sql, metrics: select.map(([n]) => n) };
}

export function reconcilePlan(input: ReconcileInput): { plan?: ReconcilePlan; errors: string[] } {
  const errors: string[] = [];
  if (!input.keys.length) errors.push('Reconciliation needs the key (columns on both sides): without one, only row counts can be compared. Confirm the key fact first.');
  const has = (side: ReconcileSide, c: string) => side.columns.some((x) => x.name.toLowerCase() === c.toLowerCase());
  for (const k of input.keys) {
    if (!has(input.source, k.source)) errors.push(`Key column ${k.source} is not in ${input.source.table}.`);
    if (!has(input.target, k.target)) errors.push(`Key column ${k.target} is not in ${input.target.table}.`);
  }
  const keyTargets = new Set(input.keys.map((k) => k.target.toLowerCase()));
  const cols = input.columns.filter((c) => !keyTargets.has(c.target.toLowerCase()));
  for (const c of cols) {
    if (!has(input.source, c.source)) errors.push(`Column ${c.source} is not in ${input.source.table}.`);
    if (!has(input.target, c.target)) errors.push(`Column ${c.target} is not in ${input.target.table}.`);
  }
  if (errors.length) return { errors };
  const samePlatform = !!input.source.platform && input.source.platform === input.target.platform && !!keyHash(input.source.platform, ['k']);
  const src = sideQuery(input.source, input.keys.map((k) => k.source), cols.map((c) => ({ mine: c.source, label: c.target })), samePlatform);
  const tgt = sideQuery(input.target, input.keys.map((k) => k.target), cols.map((c) => ({ mine: c.target, label: c.target })), samePlatform);
  const queries: ReconcileQuery[] = [
    { id: 'source-profile', side: 'source', purpose: `Counts and aggregates of ${input.source.table}`, sql: src.sql },
    { id: 'target-profile', side: 'target', purpose: `Counts and aggregates of ${input.target.table}`, sql: tgt.sql }
  ];
  const comparisons: ReconcileComparison[] = src.metrics.map((m) => ({
    metric: m, source: `source-profile.${m}`, target: `target-profile.${m}`,
    rule: m.startsWith('sum_') ? 'within-tolerance' : m.startsWith('key_nulls_') ? 'zero' : 'equal'
  }));
  const notes: string[] = [];
  if (input.sameConnection) {
    const on = input.keys.map((k) => `s.${k.source} = t.${k.target}`).join(' AND ');
    const sw = input.source.where ? ` WHERE ${input.source.where}` : '';
    const tw = input.target.where ? ` WHERE ${input.target.where}` : '';
    queries.push(
      { id: 'missing-in-target', side: 'both', purpose: 'Source keys with no target row', sql: `SELECT COUNT(*) AS missing_in_target\nFROM (SELECT * FROM ${input.source.table}${sw}) s\nLEFT JOIN (SELECT * FROM ${input.target.table}${tw}) t ON ${on}\nWHERE t.${input.keys[0].target} IS NULL` },
      { id: 'missing-in-source', side: 'both', purpose: 'Target keys with no source row', sql: `SELECT COUNT(*) AS missing_in_source\nFROM (SELECT * FROM ${input.target.table}${tw}) t\nLEFT JOIN (SELECT * FROM ${input.source.table}${sw}) s ON ${on}\nWHERE s.${input.keys[0].source} IS NULL` }
    );
    comparisons.push({ metric: 'missing_in_target', source: 'missing-in-target.missing_in_target', target: '0', rule: 'zero' }, { metric: 'missing_in_source', source: 'missing-in-source.missing_in_source', target: '0', rule: 'zero' });
  } else notes.push('The tables are on different connections: keys missing on either side can\'t be listed by a join. If counts differ, compare key ranges (MIN and MAX of the key) side by side, or land the source keys next to the target and reconcile there.');
  if (!samePlatform) notes.push('No key hash: the two sides are on different platforms (or their platform definition has no key hash), and hash functions differ between platforms.');
  if (cols.some((c) => input.source.columns.find((x) => x.name.toLowerCase() === c.source.toLowerCase())?.type !== input.target.columns.find((x) => x.name.toLowerCase() === c.target.toLowerCase())?.type)) {
    notes.push('Some columns change type between source and target: a sum or distinct count can differ by rounding or trimming. Take the tolerance from the quality rules (reconciliation tolerances), never pick one yourself.');
  }
  notes.push('Every query is read-only and returns aggregates only: run each with autode_execute_query on its side\'s connection.');
  return { plan: { queries, comparisons, notes }, errors };
}
