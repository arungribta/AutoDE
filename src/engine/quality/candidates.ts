import { Assertion, isLive } from '../context/assertions';
import { NewAssertion } from '../context/ledger';
import { ColumnNode, GraphEdge, TableNode } from '../context/types';
import { concepts as wordsOf } from '../context/vocabulary';
import { MeaningIndex } from '../ontology/meaning';
import { ancestorsOf } from '../ontology/pack';

/**
 * Quality-rule candidates from what is known (ONT2; docs/specs/context-layer.md §6.8, §11): a key is unique and never
 * null; a grain is unique; a relationship's columns reference the other table; an e-mail column has an e-mail's
 * pattern; and a concept's hints (FIBO: a payment's date is never null, its amount above zero) apply to the columns
 * that are its attributes, in the tables that represent it. Deterministic.
 *
 * Candidates only: proposing one records a `quality_expectation` fact for the Context Inbox (documented trust, from
 * a confirmed fact or a declared key; inferred from a hint). Nothing is applied silently.
 */

export type QualityCheck = 'not_null' | 'unique' | 'referential' | 'accepted_values' | 'pattern' | 'range';
export type CandidateSource = 'key' | 'declared key' | 'grain' | 'relationship' | 'foreign key' | 'classification' | 'hint';

export interface QualityCandidate {
  /** The column's (or, for a composite, the table's) node id: the fact's subject. */
  subject: string;
  table: string;
  columns: string[];
  check: QualityCheck;
  dimension: 'completeness' | 'uniqueness' | 'validity' | 'consistency';
  value: Record<string, unknown>;
  source: CandidateSource;
  /** Why, in words, and the facts it rests on. */
  reason: string;
  evidence: string[];
  /** A quality fact already about it (live or proposed): then it isn't proposed again. */
  existing?: string;
}

const EMAIL = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$';

export function qualityCandidates(idx: MeaningIndex, opts: { tables?: readonly string[] } = {}): QualityCandidate[] {
  const { graph, assertions } = idx.sources;
  const tables = graph.nodes.filter((n): n is TableNode => n.type === 'table' && (!opts.tables?.length || opts.tables.some((t) => t === n.id || ((n as TableNode).fqn || n.label).toLowerCase() === t.toLowerCase())));
  const columnsOf = new Map<string, ColumnNode[]>();
  for (const [col, table] of idx.tableOf) { const c = idx.nodes.get(col) as ColumnNode | undefined; if (c) columnsOf.set(table, [...(columnsOf.get(table) ?? []), c]); }
  const live = assertions.filter((a) => isLive(a.status));
  const quality = assertions.filter((a) => a.kind === 'quality_expectation' && (isLive(a.status) || a.status === 'proposed'));
  const out: QualityCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: Omit<QualityCandidate, 'existing'>) => {
    const k = `${c.subject}|${c.check}|${c.columns.join('+')}`;
    if (seen.has(k)) return;
    seen.add(k);
    const existing = quality.find((q) => q.subject.includes(c.subject) && (q.value as { check?: string } | undefined)?.check === c.check);
    out.push({ ...c, ...(existing ? { existing: existing.id } : {}) });
  };
  for (const t of tables) {
    const fqn = t.fqn || t.label;
    const cols = columnsOf.get(t.id) ?? [];
    const col = (name: string) => cols.find((c) => c.label.toLowerCase() === name.toLowerCase());
    const keyFacts = live.filter((a) => a.kind === 'key' && a.subject.includes(t.id) && Array.isArray(a.value));
    const keys: Array<{ columns: string[]; source: CandidateSource; fact?: Assertion }> = keyFacts.map((a) => ({ columns: (a.value as unknown[]).map(String), source: 'key' as const, fact: a }));
    const declared = cols.filter((c) => c.isPrimaryKey).map((c) => c.label);
    if (declared.length && !keys.some((k) => k.columns.map((x) => x.toLowerCase()).sort().join() === declared.map((x) => x.toLowerCase()).sort().join())) keys.push({ columns: declared, source: 'declared key' });
    for (const k of keys) {
      const ev = k.fact ? [k.fact.id] : [];
      const why = k.fact ? `the key of ${fqn} (fact ${k.fact.id})` : `the primary key ${fqn} declares`;
      for (const name of k.columns) { const c = col(name); if (c) add({ subject: c.id, table: fqn, columns: [c.label], check: 'not_null', dimension: 'completeness', value: { check: 'not_null', dimension: 'completeness' }, source: k.source, reason: `${c.label} is part of ${why}: never null`, evidence: ev }); }
      if (k.columns.length === 1) { const c = col(k.columns[0]); if (c) add({ subject: c.id, table: fqn, columns: [c.label], check: 'unique', dimension: 'uniqueness', value: { check: 'unique', dimension: 'uniqueness' }, source: k.source, reason: `${c.label} is ${why}: unique`, evidence: ev }); }
      else add({ subject: t.id, table: fqn, columns: k.columns, check: 'unique', dimension: 'uniqueness', value: { check: 'unique', dimension: 'uniqueness', columns: Object.fromEntries(k.columns.map((x) => [x, true])) }, source: k.source, reason: `(${k.columns.join(', ')}) is ${why}: unique together`, evidence: ev });
    }
    for (const g of live.filter((a) => a.kind === 'grain' && a.subject.includes(t.id) && Array.isArray(a.value))) {
      const gc = (g.value as unknown[]).map(String);
      if (keys.some((k) => k.columns.map((x) => x.toLowerCase()).sort().join() === gc.map((x) => x.toLowerCase()).sort().join())) continue;
      const one = gc.length === 1 ? col(gc[0]) : undefined;
      add({ subject: one?.id ?? t.id, table: fqn, columns: gc, check: 'unique', dimension: 'uniqueness', value: { check: 'unique', dimension: 'uniqueness', ...(gc.length > 1 ? { columns: Object.fromEntries(gc.map((x) => [x, true])) } : {}) }, source: 'grain', reason: `${fqn} has one row per (${gc.join(', ')}) (fact ${g.id}): unique`, evidence: [g.id] });
    }
    // Relationships from this table: confirmed facts, and declared foreign keys.
    for (const r of live.filter((a) => a.kind === 'relationship' && a.subject[0] === t.id)) {
      const v = r.value as { from?: { columns?: string[] }; to?: { entity?: string; columns?: string[] } };
      const target = idx.nodes.get(a1(r.subject)) as TableNode | undefined;
      const tfqn = target ? target.fqn || target.label : v.to?.entity ?? '';
      for (const [i, name] of (v.from?.columns ?? []).entries()) {
        const c = col(name);
        if (c) add({ subject: c.id, table: fqn, columns: [c.label], check: 'referential', dimension: 'consistency', value: { check: 'referential', dimension: 'consistency', references: `${tfqn}.${v.to?.columns?.[i] ?? ''}` }, source: 'relationship', reason: `${c.label} references ${tfqn}.${v.to?.columns?.[i] ?? ''} (fact ${r.id}): every value is there`, evidence: [r.id] });
      }
    }
    for (const e of graph.edges.filter((x: GraphEdge) => x.type === 'foreign_key' && idx.tableOf.get(x.source) === t.id)) {
      const c = idx.nodes.get(e.source); const to = idx.nodes.get(e.target);
      const toTable = to ? idx.nodes.get(idx.tableOf.get(to.id) ?? '') as TableNode | undefined : undefined;
      if (c && to && toTable) add({ subject: c.id, table: fqn, columns: [c.label], check: 'referential', dimension: 'consistency', value: { check: 'referential', dimension: 'consistency', references: `${toTable.fqn || toTable.label}.${to.label}` }, source: 'foreign key', reason: `${c.label} is a declared foreign key to ${toTable.fqn || toTable.label}.${to.label}`, evidence: [] });
    }
    // Classifications: an e-mail column classified personal data has an e-mail's pattern.
    for (const c of cols) {
      const cls = idx.classification.get(`${fqn.toLowerCase()}.${c.label.toLowerCase()}`) ?? [...idx.classification.entries()].find(([k]) => k.endsWith(`.${c.label.toLowerCase()}`) && fqn.toLowerCase().endsWith(k.slice(0, k.lastIndexOf('.')).split('.').pop() ?? '#'))?.[1];
      if ((cls === 'pii' || cls === 'sensitive-pii') && /e-?mail/i.test(c.label)) add({ subject: c.id, table: fqn, columns: [c.label], check: 'pattern', dimension: 'validity', value: { check: 'pattern', dimension: 'validity', pattern: EMAIL }, source: 'classification', reason: `${c.label} is classified ${cls} and holds e-mail addresses: an e-mail's shape`, evidence: [] });
    }
    // A concept's hints, for the columns that are its attributes, in the tables that represent it.
    const o = idx.sources.ontology;
    for (const l of idx.links.filter((x) => x.predicate === 'represents' && x.subject === t.id && x.status !== 'proposed')) {
      const family = [l.concept, ...(o ? ancestorsOf(l.concept, o.concepts) : [])];
      for (const cid of family) {
        const concept = o?.concepts.get(cid);
        for (const h of concept?.hints?.quality ?? []) {
          if (!h.attribute || !['not_null', 'unique', 'accepted_values', 'pattern', 'range'].includes(h.check)) continue;
          const want = wordsOf(h.attribute, idx.sources.vocab);
          const c = cols.find((x) => { const w = wordsOf(x.label, idx.sources.vocab); return w.length === want.length && want.every((y) => w.includes(y)); })
            ?? cols.find((x) => (idx.termsOf.get(x.id) ?? []).some((termId) => { const w = wordsOf(idx.nodes.get(termId)?.label ?? '', idx.sources.vocab); return w.length === want.length && want.every((y) => w.includes(y)); }));
          if (!c) continue;
          const dimension = h.check === 'not_null' ? 'completeness' : h.check === 'unique' ? 'uniqueness' : 'validity';
          add({ subject: c.id, table: fqn, columns: [c.label], check: h.check as QualityCheck, dimension, value: { check: h.check, dimension, ...(h.note ? { note: h.note } : {}) }, source: 'hint', reason: `${concept!.label} (${cid}) says its ${h.attribute} ${h.check === 'not_null' ? 'is never null' : h.check === 'unique' ? 'is unique' : h.check === 'range' ? `is in range${h.note ? ` (${h.note})` : ''}` : `has accepted values${h.note ? ` (${h.note})` : ''}`}; ${fqn} represents it (fact ${l.fact}) and ${c.label} is its ${h.attribute}`, evidence: [l.fact] });
        }
      }
    }
  }
  return out.sort((a, b) => a.table.localeCompare(b.table) || a.columns.join().localeCompare(b.columns.join()) || a.check.localeCompare(b.check));
}

const a1 = (subject: readonly string[]) => subject[1] ?? '';

/** The facts the chosen candidates propose (the Context Inbox): documented when they rest on a fact or a declared key, inferred from a hint. */
export function qualityProposals(chosen: readonly QualityCandidate[], by: string, specId?: string): NewAssertion[] {
  return chosen.filter((c) => !c.existing).map((c) => ({
    kind: 'quality_expectation' as const, subject: [c.subject], predicate: 'expects', value: c.value,
    statement: `${c.table}${c.columns.length === 1 ? `.${c.columns[0]}` : ` (${c.columns.join(', ')})`}: ${c.check.replace('_', ' ')}${c.value.references ? ` → ${String(c.value.references)}` : ''} (${c.reason}).`.slice(0, 300),
    evidence: [{ type: 'file' as const, ref: `quality:${c.source}`, excerpt: c.reason.slice(0, 300) }],
    trust: c.source === 'hint' ? 'inferred' as const : 'documented' as const, status: 'proposed' as const, createdBy: by, flags: ['candidate'],
    ...(specId ? { specId } : {})
  }));
}
