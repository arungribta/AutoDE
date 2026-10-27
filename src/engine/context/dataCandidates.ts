import { Assertion, Verification, canonicalJson, isLive, trustRank } from './assertions';
import { AssertionLedger, NewAssertion } from './ledger';
import { ColumnNode, TableNode } from './types';
import { GraphView } from './retrieval';
import { ProbeExecutor, ProbeResult, ProbeSpec, ValueShape } from './probes';
import { isMirror } from './projection';

/**
 * The data before any model (C4c; docs/context-layer-requirements.md §5.5
 * item 2). Candidate keys, foreign keys, grain, change columns and personal
 * data by value shape are found deterministically from the estate, then
 * checked by the fixed, aggregate-only probes. A candidate that passes is
 * recorded as a proposed fact with its probe result, so it arrives
 * `verified` and a person only confirms what it means. The model's job
 * narrows to business meaning.
 */

export interface ColumnShape { id: string; name: string; dataType: string; isPrimaryKey: boolean; description?: string }
export interface TableShape { id: string; fqn: string; name: string; schema: string; description?: string; columns: ColumnShape[] }

/** The tables (with their columns) of the graph, or of the given ids. */
export function tableShapes(graph: GraphView, ids?: Iterable<string>): TableShape[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const columns = new Map<string, ColumnShape[]>();
  for (const e of graph.edges) {
    if (e.type !== 'contains') continue;
    const c = byId.get(e.target);
    if (!c || c.type !== 'column') continue;
    const col = c as ColumnNode;
    columns.set(e.source, [...(columns.get(e.source) ?? []), { id: col.id, name: col.label, dataType: col.dataType ?? '', isPrimaryKey: !!col.isPrimaryKey, description: col.description }]);
  }
  const wanted = ids ? [...ids] : graph.nodes.filter((n) => n.type === 'table' || n.type === 'semantic_view').map((n) => n.id);
  return wanted.flatMap((id) => {
    const t = byId.get(id) as TableNode | undefined;
    if (!t || (t.type !== 'table' && t.type !== 'semantic_view')) return [];
    const fqn = t.fqn || t.label;
    const name = fqn.split('.').pop() ?? fqn;
    return [{ id, fqn, name, schema: t.schema ?? fqn.split('.').slice(-2, -1)[0] ?? '', description: t.description, columns: columns.get(id) ?? [] }];
  });
}

const singular = (name: string) => name.toLowerCase().replace(/ies$/, 'y').replace(/(ses|xes)$/, (m) => m.slice(0, -2)).replace(/s$/, '');

type TypeClass = 'number' | 'text' | 'time' | 'bool' | 'unknown';
export function typeClass(dataType: string): TypeClass {
  const t = dataType.toLowerCase();
  if (!t) return 'unknown';
  if (/int|number|numeric|decimal|float|double|real|bigint/.test(t)) return 'number';
  if (/timestamp|date|time/.test(t)) return 'time';
  if (/char|text|string|varchar|clob/.test(t)) return 'text';
  if (/bool/.test(t)) return 'bool';
  return 'unknown';
}

const compatible = (a: string, b: string) => { const x = typeClass(a); const y = typeClass(b); return x === 'unknown' || y === 'unknown' || x === y; };

/** Columns worth testing as the table's key, most likely first (at most three). */
export function keyColumnCandidates(t: TableShape): string[] {
  const one = singular(t.name);
  const preferred = ['id', `${one}_id`, `${t.name.toLowerCase()}_id`, `${one}_no`, `${one}_key`, `${one}_code`, `${one}_number`, 'code'];
  const names = t.columns.map((c) => c.name);
  const byPreference = preferred.map((p) => names.find((n) => n.toLowerCase() === p)).filter((n): n is string => !!n);
  const idLike = names.filter((n) => /(_id|_no|_key|_number|_code)$/i.test(n));
  return [...new Set([...byPreference, ...idLike])].slice(0, 3);
}

const CHANGE = /^(updated|modified|changed|last_?modified|last_?updated|last_?changed|last_?update)(_at|_on|_ts|_date|_time|_dt)?$|_(updated|modified|changed)_(at|on|ts|date|time)$|^(load|loaded|ingest(ed)?|etl|dw)_(at|ts|date|time)$/i;

/** Columns that look like the table's change (or load) timestamp, by name and type. */
export function changeColumnCandidates(t: TableShape): string[] {
  return t.columns.filter((c) => CHANGE.test(c.name) && ['time', 'unknown'].includes(typeClass(c.dataType))).map((c) => c.name);
}

export interface FkCandidate { from: { table: string; fqn: string; columns: string[] }; to: { table: string; fqn: string; columns: string[] }; why: string }

/**
 * Columns that name another table's single-column key: the same name
 * (`cust_no` → `crm.customers.cust_no`), `<table>_<key>` (`customer_id` for a
 * key `id` of `customers`), or `<schema>_<key>` / `<table>_<key>` prefixes
 * (`shop_customer_id` → `shop.customers.customer_id`), with compatible types.
 */
export function foreignKeyCandidates(tables: readonly TableShape[], keys: ReadonlyMap<string, string[]>): FkCandidate[] {
  const out: FkCandidate[] = [];
  for (const a of tables) {
    const own = new Set((keys.get(a.id) ?? []).map((c) => c.toLowerCase()));
    for (const col of a.columns) {
      if (own.has(col.name.toLowerCase())) continue;
      const n = col.name.toLowerCase();
      for (const b of tables) {
        if (b.id === a.id) continue;
        const k = keys.get(b.id);
        if (!k || k.length !== 1) continue;
        const key = k[0].toLowerCase();
        const keyCol = b.columns.find((c) => c.name.toLowerCase() === key);
        if (keyCol && !compatible(col.dataType, keyCol.dataType)) continue;
        const one = singular(b.name);
        const why = n === key && key !== 'id' ? `${col.name} has the name of ${b.fqn}'s key`
          : n === `${one}_${key}` || n === `${b.name.toLowerCase()}_${key}` ? `${col.name} is ${b.name}'s key named after its table`
            : n === `${b.schema.toLowerCase()}_${key}` || n === `${b.schema.toLowerCase()}_${one}_${key}` ? `${col.name} is ${b.fqn}'s key prefixed with its schema`
              : undefined;
        if (why) out.push({ from: { table: a.id, fqn: a.fqn, columns: [col.name] }, to: { table: b.id, fqn: b.fqn, columns: [k[0]] }, why });
      }
    }
  }
  return out;
}

export type FindingKind = 'key' | 'declared_key' | 'relationship' | 'grain' | 'change_column' | 'personal_data';

export interface CandidateFinding {
  kind: FindingKind;
  table: string;
  fqn: string;
  columns: string[];
  /** `relationship`: the referenced table. */
  to?: FkCandidate['to'];
  /** `personal_data`: the shape that matched. */
  shape?: ValueShape;
  why: string;
  /** The probe's verdict; undefined when nothing could run it. */
  result?: ProbeResult;
  /** Why no probe ran. */
  unverified?: string;
}

async function run(executor: ProbeExecutor | undefined, spec: ProbeSpec): Promise<{ result?: ProbeResult; unverified?: string }> {
  if (!executor) return { unverified: 'no connection or sample to probe' };
  try {
    const result = await executor.run(spec);
    return result ? { result } : { unverified: 'no connection or sample reaches this table' };
  } catch (err) { return { unverified: `the probe could not run: ${err instanceof Error ? err.message : String(err)}` }; }
}

const live = (a: Assertion) => !isMirror(a) && (isLive(a.status) || a.status === 'proposed');

/** The table's key as known: declared in its schema, or a live key fact at ≥ documented. */
export function knownKey(t: TableShape, assertions: readonly Assertion[]): { columns: string[]; source: 'declared' | 'fact'; fact?: Assertion } | undefined {
  const pk = t.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  if (pk.length) return { columns: pk, source: 'declared' };
  const fact = assertions.find((a) => !isMirror(a) && isLive(a.status) && a.kind === 'key' && a.subject[0] === t.id && trustRank(a.trust) >= trustRank('documented') && Array.isArray(a.value));
  return fact ? { columns: (fact.value as unknown[]).map(String), source: 'fact', fact } : undefined;
}

/**
 * Finds the candidates for the given tables and probes them. Declared keys
 * are probed too (a declared key the data breaks is reported). Text columns
 * not yet classified are probed for e-mail and phone shapes.
 */
export async function findCandidates(input: { graph: GraphView; tableIds: Iterable<string>; assertions: readonly Assertion[]; executor?: ProbeExecutor; classified?: (table: string, column: string) => boolean }): Promise<CandidateFinding[]> {
  const tables = tableShapes(input.graph, input.tableIds);
  const findings: CandidateFinding[] = [];
  const keys = new Map<string, string[]>();
  for (const t of tables) {
    const known = knownKey(t, input.assertions);
    if (known) {
      keys.set(t.id, known.columns);
      if (known.source === 'declared') {
        const r = await run(input.executor, { check: 'unique', table: { fqn: t.fqn, id: t.id }, columns: known.columns });
        if (r.result) findings.push({ kind: 'declared_key', table: t.id, fqn: t.fqn, columns: known.columns, why: 'declared as the primary key in its schema', ...r });
      }
      continue;
    }
    // A key someone already proposed is left for the Inbox, not raced.
    if (input.assertions.some((a) => live(a) && a.kind === 'key' && a.subject[0] === t.id)) continue;
    for (const c of keyColumnCandidates(t)) {
      const r = await run(input.executor, { check: 'unique', table: { fqn: t.fqn, id: t.id }, columns: [c] });
      findings.push({ kind: 'key', table: t.id, fqn: t.fqn, columns: [c], why: `${c} is named like a key`, ...r });
      if (r.result?.pass) {
        keys.set(t.id, [c]);
        if (!input.assertions.some((a) => live(a) && a.kind === 'grain' && a.subject[0] === t.id)) {
          findings.push({ kind: 'grain', table: t.id, fqn: t.fqn, columns: [c], why: `one row per ${c}: its key is unique in the data`, result: r.result });
        }
        break;
      }
    }
  }
  const related = (a: string, b: string) => input.assertions.some((x) => live(x) && x.kind === 'relationship' && x.subject.includes(a) && x.subject.includes(b))
    || input.graph.edges.some((e) => e.type === 'foreign_key' && ((e.source.startsWith(a) && e.target.startsWith(b)) || (e.source.startsWith(b) && e.target.startsWith(a))));
  for (const fk of foreignKeyCandidates(tables, keys)) {
    if (related(fk.from.table, fk.to.table)) continue;
    const r = await run(input.executor, { check: 'orphans', table: { fqn: fk.from.fqn, id: fk.from.table }, columns: fk.from.columns, to: { fqn: fk.to.fqn, id: fk.to.table, columns: fk.to.columns } });
    findings.push({ kind: 'relationship', table: fk.from.table, fqn: fk.from.fqn, columns: fk.from.columns, to: fk.to, why: fk.why, ...r });
  }
  for (const t of tables) {
    for (const c of changeColumnCandidates(t)) {
      if (input.assertions.some((a) => live(a) && a.kind === 'data_fact' && a.predicate === 'change_column' && a.subject[0] === t.id)) break;
      findings.push({ kind: 'change_column', table: t.id, fqn: t.fqn, columns: [c], why: `${c} is named like a change timestamp${typeClass(t.columns.find((x) => x.name === c)?.dataType ?? '') === 'time' ? ' and holds timestamps' : ''}` });
      break;
    }
    for (const c of t.columns.filter((x) => ['text', 'unknown'].includes(typeClass(x.dataType)))) {
      if (input.classified?.(t.fqn, c.name)) continue;
      for (const shape of ['email', 'phone'] as ValueShape[]) {
        const r = await run(input.executor, { check: 'shape', table: { fqn: t.fqn, id: t.id }, columns: [c.name], shape });
        if (r.result?.pass) { findings.push({ kind: 'personal_data', table: t.id, fqn: t.fqn, columns: [c.name], shape, why: r.result.detail, result: r.result }); break; }
      }
    }
  }
  return findings;
}

/** The fact a finding proposes (personal data is a person's classification: none). */
export function findingProposal(f: CandidateFinding, specId?: string): NewAssertion | undefined {
  const evidence = f.result
    ? [{ type: 'probe' as const, ref: `probe:${f.result.check}:${f.fqn}:${f.columns.join('+')}${f.result.source === 'sample' ? '@sample' : ''}`, excerpt: f.result.detail }]
    : [{ type: 'introspection' as const, ref: `estate:${f.table}`, excerpt: f.why }];
  const base = { evidence, trust: 'inferred' as const, status: 'proposed' as const, createdBy: 'system:candidates', flags: ['candidate'], ...(specId ? { specId } : {}) };
  switch (f.kind) {
    case 'key': return { ...base, kind: 'key', subject: [f.table], predicate: 'primary', value: f.columns, statement: `The key of ${f.fqn} is (${f.columns.join(', ')}): ${f.why}, and it is unique in the data.` };
    case 'grain': return { ...base, kind: 'grain', subject: [f.table], predicate: 'grain', value: f.columns, statement: `${f.fqn} has one row per (${f.columns.join(', ')}).` };
    case 'relationship': return f.to ? {
      ...base, kind: 'relationship', subject: [f.table, f.to.table], predicate: 'joins_to',
      value: { from: { entity: f.table, columns: f.columns }, to: { entity: f.to.table, columns: f.to.columns }, cardinality: 'N:1' },
      statement: `${f.fqn}.${f.columns.join(', ')} references ${f.to.fqn}.${f.to.columns.join(', ')} (${f.why}).`
    } : undefined;
    case 'change_column': return { ...base, kind: 'data_fact', subject: [f.table], predicate: 'change_column', value: { column: f.columns[0] }, statement: `${f.columns[0]} is the change timestamp of ${f.fqn} (${f.why}).` };
    default: return undefined;
  }
}

/**
 * Records the findings that passed (and change columns, which have no
 * probe) as proposed facts — each verified at once by its probe result — and
 * skips what the ledger already holds. `admit` applies the problem's mode
 * (exploration admits them at once). Failed and unverified findings are
 * reported, not recorded.
 */
export async function recordCandidates(ledger: AssertionLedger, findings: readonly CandidateFinding[], options: { specId?: string; admit?: (a: NewAssertion) => NewAssertion; now?: () => Date } = {}): Promise<Assertion[]> {
  const key = (a: Pick<NewAssertion, 'kind' | 'subject' | 'predicate' | 'value'>) => canonicalJson([a.kind, a.subject.map((s) => s.toLowerCase()), a.predicate, Array.isArray(a.value) ? a.value.map((v) => String(v).toLowerCase()) : a.value]);
  const known = new Set(ledger.assertions().filter(live).map(key));
  const recorded: Assertion[] = [];
  for (const f of findings) {
    if (f.kind === 'change_column' ? false : f.result?.pass !== true) continue;
    const proposal = findingProposal(f, options.specId);
    if (!proposal || known.has(key(proposal))) continue;
    known.add(key(proposal));
    const asserted = ledger.buildAsserted(options.admit ? options.admit(proposal) : proposal);
    const events = [asserted];
    if (f.result?.pass) {
      const verification: Verification = { method: 'probe', at: (options.now ?? (() => new Date()))().toISOString(), result: 'pass', detail: `${f.result.detail}${f.result.source === 'sample' ? ' (sample data)' : ''}`, probeId: `${f.result.check}:${f.fqn}:${f.columns.join('+')}` };
      events.push(ledger.buildEvent('verified', asserted.assertionId, 'system:candidates', { verification }));
    }
    await ledger.append(events);
    const a = ledger.get(asserted.assertionId);
    if (a) recorded.push(a);
  }
  return recorded;
}

export function describeFinding(f: CandidateFinding): string {
  const verdict = f.result ? (f.result.pass === true ? '✓' : f.result.pass === false ? '✗' : '·') : '·';
  const what = f.kind === 'relationship' && f.to ? `${f.fqn}.${f.columns.join('+')} → ${f.to.fqn}.${f.to.columns.join('+')}`
    : f.kind === 'personal_data' ? `${f.fqn}.${f.columns[0]} looks like ${f.shape === 'email' ? 'e-mail addresses' : 'phone numbers'}`
      : `${f.kind.replace('_', ' ')} of ${f.fqn}: (${f.columns.join(', ')})`;
  const detail = f.result ? `${f.result.detail}${f.result.source === 'sample' ? ' (sample data)' : ''}` : f.unverified ?? f.why;
  return `${verdict} ${what} — ${detail}`;
}
