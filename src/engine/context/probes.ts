import { Assertion, Verification } from './assertions';
import { AssertionLedger } from './ledger';
import { BaseNode, GraphEdge, TableNode } from './types';
import { createSubjectResolver } from './projection';

/**
 * Verification probes (Phase C4a, item 8; docs/context-layer-requirements.md
 * §5.3): read-only checks that turn a claim ("member_id is unique") into
 * evidence. Generated from **fixed templates per check and dialect** — never
 * written by an LLM — and returning **aggregates only** (counts, rates,
 * min/max), never row values, so they need no sample-data consent.
 *
 * Two executors run the same `ProbeSpec`: SQL on a live connection
 * (`createSqlProbeExecutor`), or the same aggregates computed over sample
 * rows the customer supplied (`createSampleProbeExecutor`) — for sources with
 * no live connector, which merges and legacy migrations often have.
 */

export type ProbeCheck = 'unique' | 'not_null' | 'accepted_values' | 'orphans' | 'freshness';

export interface ProbeTable {
  /** Name as the platform knows it (`DB.SCHEMA.TABLE`). */
  fqn: string;
  /** Graph id, for sample lookup and reporting. */
  id?: string;
}

export interface ProbeSpec {
  check: ProbeCheck;
  table: ProbeTable;
  columns: string[];
  /** `accepted_values`. */
  values?: unknown[];
  /** `orphans`: the referenced table and its columns (same order as `columns`). */
  to?: ProbeTable & { columns: string[] };
  /** `freshness`. */
  maxAgeHours?: number;
}

export interface ProbeResult {
  check: ProbeCheck;
  /** `undefined` when the result can't decide (no rows). */
  pass: boolean | undefined;
  rows: number;
  sampled: boolean;
  /** Aggregates only. */
  observed: Record<string, number | string>;
  detail: string;
  /** What it ran on (set by the executor). */
  source?: 'live' | 'sample';
}

export interface ProbeExecutor {
  /** What this executor reads — reported with each result. */
  readonly kind: 'live' | 'sample' | 'combined';
  /** Whether it can reach this table (graph id); absent = try everything. */
  covers?(tableId: string | undefined): boolean;
  /** `undefined` when it has nothing to run the probe on (e.g. no sample of that table). */
  run(spec: ProbeSpec): Promise<ProbeResult | undefined>;
}

/** Live first where the connection reaches the table, else the customer's samples. */
export function combineProbeExecutors(executors: ReadonlyArray<ProbeExecutor | undefined>): ProbeExecutor | undefined {
  const list = executors.filter((e): e is ProbeExecutor => !!e);
  if (list.length <= 1) return list[0];
  return {
    kind: 'combined',
    async run(spec) {
      for (const e of list) {
        if (e.covers && !e.covers(spec.table.id)) continue;
        const r = await e.run(spec);
        if (r) return r;
      }
      return undefined;
    }
  };
}

export type ProbeDialect = 'snowflake' | 'spark_sql' | 'oracle' | 'ansi';

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Probe refused: "${name}" is not a plain identifier.`);
  return name;
}

function literal(v: unknown, dialect?: ProbeDialect): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  // Oracle SQL has no boolean literals before 23ai.
  if (typeof v === 'boolean') return dialect === 'oracle' ? (v ? '1' : '0') : v ? 'TRUE' : 'FALSE';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function sampled(table: string, dialect: ProbeDialect, sampleRows: number | undefined): string {
  if (!sampleRows) return ident(table);
  const n = Math.max(1, Math.floor(sampleRows));
  if (dialect === 'snowflake') return `${ident(table)} SAMPLE (${n} ROWS)`;
  if (dialect === 'spark_sql') return `${ident(table)} TABLESAMPLE (${n} ROWS)`;
  if (dialect === 'oracle') return `(SELECT * FROM ${ident(table)} FETCH FIRST ${n} ROWS ONLY) s0`;
  return `(SELECT * FROM ${ident(table)} LIMIT ${n}) s0`;
}

/** The SQL for a probe — one row of aggregates. */
export function renderProbeSql(spec: ProbeSpec, dialect: ProbeDialect, options: { sampleRows?: number } = {}): string {
  const cols = spec.columns.map(ident);
  if (cols.length === 0) throw new Error('Probe refused: no columns.');
  const from = sampled(spec.table.fqn, dialect, options.sampleRows);
  const anyNull = cols.map((c) => `${c} IS NULL`).join(' OR ');
  switch (spec.check) {
    case 'unique': {
      const distinct = (dialect === 'ansi' || dialect === 'oracle') && cols.length > 1
        ? `(SELECT COUNT(*) FROM (SELECT DISTINCT ${cols.join(', ')} FROM ${from} WHERE NOT (${anyNull})) d)`
        : `COUNT(DISTINCT ${cols.join(', ')})`;
      return `SELECT COUNT(*) AS row_count, ${distinct} AS distinct_count, SUM(CASE WHEN ${anyNull} THEN 1 ELSE 0 END) AS null_count FROM ${from}`;
    }
    case 'not_null':
      return `SELECT COUNT(*) AS row_count, SUM(CASE WHEN ${anyNull} THEN 1 ELSE 0 END) AS null_count FROM ${from}`;
    case 'accepted_values': {
      const list = (spec.values ?? []).map((v) => literal(v, dialect)).join(', ');
      if (!list) throw new Error('Probe refused: accepted_values needs values.');
      return `SELECT COUNT(*) AS row_count, SUM(CASE WHEN ${cols[0]} IS NOT NULL AND ${cols[0]} NOT IN (${list}) THEN 1 ELSE 0 END) AS violation_count FROM ${from}`;
    }
    case 'orphans': {
      if (!spec.to || spec.to.columns.length !== cols.length) throw new Error('Probe refused: orphans needs matching "to" columns.');
      const toCols = spec.to.columns.map(ident);
      const on = cols.map((c, i) => `f.${c} = t.${toCols[i]}`).join(' AND ');
      return `SELECT COUNT(*) AS row_count, SUM(CASE WHEN t.${toCols[0]} IS NULL THEN 1 ELSE 0 END) AS orphan_count FROM (SELECT ${cols.join(', ')} FROM ${from}) f LEFT JOIN (SELECT DISTINCT ${toCols.join(', ')} FROM ${ident(spec.to.fqn)}) t ON ${on} WHERE NOT (${cols.map((c) => `f.${c} IS NULL`).join(' OR ')})`;
    }
    case 'freshness':
      return `SELECT COUNT(*) AS row_count, MAX(${cols[0]}) AS max_value FROM ${from}`;
  }
}

function num(row: Record<string, unknown>, key: string): number {
  const v = row[key] ?? row[key.toUpperCase()];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '0%');

/** Turns one row of aggregates into a verdict — shared by both executors, so they agree. */
export function interpretProbe(spec: ProbeSpec, row: Record<string, unknown>, sampledRows: boolean, now: Date = new Date()): ProbeResult {
  const rows = num(row, 'row_count');
  const where = `${rows} ${sampledRows ? 'sampled ' : ''}row(s) of ${spec.table.fqn}`;
  const name = spec.columns.join(', ');
  const base = { check: spec.check, rows, sampled: sampledRows };
  if (rows === 0) return { ...base, pass: undefined, observed: { rows: 0 }, detail: `no rows to check in ${spec.table.fqn}` };
  switch (spec.check) {
    case 'unique': {
      const nulls = num(row, 'null_count');
      const distinct = num(row, 'distinct_count');
      const dupes = rows - nulls - distinct;
      const pass = dupes === 0 && nulls === 0;
      return { ...base, pass, observed: { rows, distinct, nulls, duplicates: dupes }, detail: pass ? `${name} is unique in ${where}` : `${name} is not unique: ${dupes} duplicate(s) (${pct(dupes, rows)}) and ${nulls} null(s) in ${where}` };
    }
    case 'not_null': {
      const nulls = num(row, 'null_count');
      return { ...base, pass: nulls === 0, observed: { rows, nulls }, detail: nulls === 0 ? `${name} has no nulls in ${where}` : `${name} has ${nulls} null(s) (${pct(nulls, rows)}) in ${where}` };
    }
    case 'accepted_values': {
      const bad = num(row, 'violation_count');
      return { ...base, pass: bad === 0, observed: { rows, violations: bad }, detail: bad === 0 ? `${name} holds only accepted values in ${where}` : `${name} has ${bad} value(s) outside the accepted set (${pct(bad, rows)}) in ${where}` };
    }
    case 'orphans': {
      const orphans = num(row, 'orphan_count');
      return { ...base, pass: orphans === 0, observed: { rows, orphans }, detail: orphans === 0 ? `every ${name} in ${where} has a match in ${spec.to?.fqn}` : `${orphans} of ${where} (${pct(orphans, rows)}) have no match in ${spec.to?.fqn}` };
    }
    case 'freshness': {
      const max = row['max_value'] ?? row['MAX_VALUE'];
      const at = max === undefined || max === null ? NaN : Date.parse(String(max));
      const ageH = Number.isFinite(at) ? (now.getTime() - at) / 3_600_000 : NaN;
      const pass = Number.isFinite(ageH) ? ageH <= (spec.maxAgeHours ?? 24) : undefined;
      return { ...base, pass, observed: { rows, ageHours: Number.isFinite(ageH) ? Math.round(ageH) : 'unknown' }, detail: pass === undefined ? `no timestamp in ${name}` : `latest ${name} is ${Math.round(ageH)} h old (allowed ${spec.maxAgeHours ?? 24} h)` };
    }
  }
}

/** Runs probes as SQL on a live connection — one row of aggregates per probe. */
export function createSqlProbeExecutor(query: (sql: string) => Promise<Array<Record<string, unknown>>>, dialect: ProbeDialect, options: { sampleRows?: number; covers?: (tableId: string | undefined) => boolean } = {}): ProbeExecutor {
  return {
    kind: 'live',
    covers: options.covers,
    async run(spec) {
      const rows = await query(renderProbeSql(spec, dialect, options));
      return { ...interpretProbe(spec, rows[0] ?? {}, !!options.sampleRows), source: 'live' };
    }
  };
}

/**
 * Computes the same aggregates over sample rows (keyed by table graph id) —
 * the rows never leave this function; only counts come back.
 */
export function createSampleProbeExecutor(samples: ReadonlyMap<string, ReadonlyArray<Record<string, string>>>): ProbeExecutor {
  const rowsOf = (t: ProbeTable | undefined) => (t?.id ? samples.get(t.id) : undefined);
  const col = (row: Record<string, string>, name: string) => {
    const key = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());
    const v = key === undefined ? undefined : row[key];
    return v === undefined || v === '' ? null : v;
  };
  return {
    kind: 'sample',
    covers: (tableId) => !!tableId && samples.has(tableId),
    async run(spec) {
      const rows = rowsOf(spec.table);
      if (!rows) return undefined;
      const agg: Record<string, unknown> = { row_count: rows.length };
      const isNull = (r: Record<string, string>) => spec.columns.some((c) => col(r, c) === null);
      if (spec.check === 'unique') {
        agg.null_count = rows.filter(isNull).length;
        agg.distinct_count = new Set(rows.filter((r) => !isNull(r)).map((r) => JSON.stringify(spec.columns.map((c) => col(r, c))))).size;
      } else if (spec.check === 'not_null') {
        agg.null_count = rows.filter(isNull).length;
      } else if (spec.check === 'accepted_values') {
        const ok = new Set((spec.values ?? []).map(String));
        agg.violation_count = rows.filter((r) => col(r, spec.columns[0]) !== null && !ok.has(String(col(r, spec.columns[0])))).length;
      } else if (spec.check === 'orphans') {
        const to = rowsOf(spec.to);
        if (!to || !spec.to) return undefined;
        const keys = new Set(to.map((r) => JSON.stringify(spec.to!.columns.map((c) => col(r, c)))));
        const present = rows.filter((r) => !isNull(r));
        agg.row_count = present.length;
        agg.orphan_count = present.filter((r) => !keys.has(JSON.stringify(spec.columns.map((c) => col(r, c))))).length;
      } else if (spec.check === 'freshness') {
        const ts = rows.map((r) => col(r, spec.columns[0])).filter((v): v is string => v !== null).sort();
        agg.max_value = ts[ts.length - 1];
      }
      return { ...interpretProbe(spec, agg, true), source: 'sample' };
    }
  };
}

/** Parses a sample CSV (header + rows; quoted fields with commas). */
export function parseSampleCsv(content: string): Array<Record<string, string>> {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const split = (line: string) => {
    const out: string[] = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim());
  };
  const header = split(lines[0]);
  return lines.slice(1).map((l) => { const cells = split(l); return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])); });
}

// ── Claims → probes → ledger ─────────────────────────────────────────────────

/** Resolves a graph id (table or column) to the table it belongs to, as a probe target. */
export type ProbeResolver = (id: string) => { table: ProbeTable; column?: string } | undefined;

/** Resolves graph table and column ids (or names) to probe targets — shared by the extension and the MCP server. */
export function createProbeResolver(g: { nodes: readonly BaseNode[]; edges: readonly GraphEdge[] }): ProbeResolver {
  const byId = new Map(g.nodes.map((n) => [n.id, n] as const));
  const tableOf = new Map<string, string>();
  for (const e of g.edges) if (e.type === 'contains') tableOf.set(e.target, e.source);
  const resolveRef = createSubjectResolver(g as Parameters<typeof createSubjectResolver>[0]);
  return (ref) => {
    const id = byId.has(ref) ? ref : resolveRef(ref);
    const n = id ? byId.get(id) : undefined;
    if (!n) return undefined;
    if (n.type === 'table' || n.type === 'semantic_view') return { table: { fqn: (n as TableNode).fqn || n.label, id: n.id } };
    const t = n.type === 'column' ? byId.get(tableOf.get(n.id) ?? '') : undefined;
    return t ? { table: { fqn: (t as TableNode).fqn || t.label, id: t.id }, column: n.label } : undefined;
  };
}

/** The probes that test an assertion (§5.3 table). Assertions about non-physical subjects get none. */
export function probesFor(a: Assertion, resolve: ProbeResolver): ProbeSpec[] {
  const target = a.subject[0] ? resolve(a.subject[0]) : undefined;
  if (!target) return [];
  if ((a.kind === 'key' || a.kind === 'grain') && Array.isArray(a.value) && a.value.length) {
    return [{ check: 'unique', table: target.table, columns: (a.value as unknown[]).map(String) }];
  }
  if (a.kind === 'quality_expectation' && target.column) {
    const v = (a.value ?? {}) as { check?: string; values?: unknown[]; maxAgeHours?: number };
    if (v.check === 'unique' || v.check === 'not_null' || v.check === 'freshness') return [{ check: v.check, table: target.table, columns: [target.column], maxAgeHours: v.maxAgeHours }];
    if (v.check === 'accepted_values' && v.values?.length) return [{ check: 'accepted_values', table: target.table, columns: [target.column], values: v.values }];
  }
  if (a.kind === 'relationship') {
    const v = a.value as { from?: { entity: string; columns: string[] }; to?: { entity: string; columns: string[] } };
    const from = v.from ? resolve(v.from.entity) : undefined;
    const to = v.to ? resolve(v.to.entity) : undefined;
    if (from && to && v.from && v.to) return [{ check: 'orphans', table: from.table, columns: v.from.columns, to: { ...to.table, columns: v.to.columns } }];
  }
  return [];
}

export interface VerifyOutcome {
  assertionId: string;
  statement: string;
  result: ProbeResult | undefined;
  /** Why nothing ran. */
  skipped?: string;
}

/**
 * Runs the probes for each assertion without recording anything — the
 * `autode probe` report (Phase PA2). `verifyAssertions` records the same
 * outcomes in the ledger.
 */
export async function probeAssertions(assertions: readonly Assertion[], executor: ProbeExecutor, resolve: ProbeResolver): Promise<Array<VerifyOutcome & { probeId?: string }>> {
  const out: Array<VerifyOutcome & { probeId?: string }> = [];
  for (const a of assertions) {
    const specs = probesFor(a, resolve);
    if (specs.length === 0) { out.push({ assertionId: a.id, statement: a.statement, result: undefined, skipped: 'no probe for this kind of claim, or its subject is not a known table' }); continue; }
    for (const spec of specs) {
      let result: ProbeResult | undefined;
      try {
        result = await executor.run(spec);
      } catch (err) {
        out.push({ assertionId: a.id, statement: a.statement, result: undefined, skipped: `probe failed to run: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      if (!result) { out.push({ assertionId: a.id, statement: a.statement, result: undefined, skipped: 'not verified — no connection or sample reaches this table' }); continue; }
      out.push({ assertionId: a.id, statement: a.statement, result, probeId: `${spec.check}:${spec.table.fqn}:${spec.columns.join('+')}` });
    }
  }
  return out;
}

/**
 * Probes each assertion and records the outcome in the ledger: a pass is a
 * `verified` event (trust → verified), a fail a `verification_failed` event
 * (status → needs_review, the observed numbers as the reason). Undecided or
 * unrunnable probes record nothing.
 */
export async function verifyAssertions(ledger: AssertionLedger, assertions: readonly Assertion[], executor: ProbeExecutor, resolve: ProbeResolver, now: () => Date = () => new Date()): Promise<VerifyOutcome[]> {
  const outcomes = await probeAssertions(assertions, executor, resolve);
  for (const o of outcomes) {
    if (!o.result || o.result.pass === undefined) continue;
    const verification: Verification = { method: 'probe', at: now().toISOString(), result: o.result.pass ? 'pass' : 'fail', detail: `${o.result.detail}${o.result.source === 'sample' ? ' (sample data)' : ''}`, probeId: o.probeId };
    await ledger.recordVerification(o.assertionId, verification);
  }
  return outcomes.map(({ probeId: _probeId, ...o }) => o);
}
