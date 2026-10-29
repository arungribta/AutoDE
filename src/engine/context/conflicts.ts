import { BaseNode, BusinessTermNode, ColumnNode, GraphEdge } from './types';
import { Assertion, canonicalJson, normalizeName } from './assertions';
import { AssertionLedger, LedgerEvent } from './ledger';
import { isMirror } from './projection';

/**
 * Conflict detection (C2, v0.29.0; docs/specs/context-layer.md §8.1).
 * Deterministic. Considers every assertion that is `active`, `proposed` or
 * `needs_review`; superseded and rejected ones can't conflict.
 *
 * Three rules:
 * 1. **definition** — two definitions of the same business name (glossary
 *    terms and metrics, whichever kind and subject they were recorded under)
 *    whose formula/definition text differs. This is how "Revenue" defined as
 *    gross in a document and as net in chat is caught, not merged.
 * 2. **value** — same kind + subject + predicate, incompatible value.
 * 3. **declared_key** — a `key` / `primary` assertion on a table whose
 *    columns differ from the primary key the schema itself declares.
 */

export interface Conflict {
  rule: 'definition' | 'value' | 'declared_key';
  /** Stable grouping key, e.g. `definition|revenue`. */
  key: string;
  subject: string[];
  /** The conflicting assertions, sorted. */
  ids: string[];
  /** One line per side, for the inbox / reports. */
  sides: string[];
}

const CONSIDERED = new Set(['active', 'proposed', 'needs_review']);

interface Definition { name: string; text: string; assertion: Assertion; display: string }

function normalizeDefinition(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/\s*([(),*+\-/<>=])\s*/g, '$1').trim();
}

function definitionOf(a: Assertion): Definition | undefined {
  const v = (a.value ?? {}) as Record<string, unknown>;
  if (isMirror(a)) {
    const node = (v as { node?: BaseNode }).node;
    if (!node || a.predicate !== 'node' || (node.type !== 'business_term' && node.type !== 'metric')) return undefined;
    const formula = (node as BusinessTermNode).formula;
    const text = formula || node.description;
    // Spec-derived "terms" are objectives/requirements text, not definitions of a name.
    if (!text || node.origin?.specId) return undefined;
    return { name: node.label, text, assertion: a, display: `${node.label} = ${text}` };
  }
  if (a.kind === 'business_term' && typeof v.term === 'string') {
    const text = [v.formula, v.definition].find((x) => typeof x === 'string' && x) as string | undefined;
    return text ? { name: v.term, text, assertion: a, display: `${v.term} = ${text}` } : undefined;
  }
  if (a.kind === 'metric') {
    const name = typeof v.name === 'string' ? v.name : a.subject[0]?.replace(/^metric:/i, '');
    const core = [v.expression, v.definition].find((x) => typeof x === 'string' && x) as string | undefined;
    if (!name || !core) return undefined;
    const filters = Array.isArray(v.filters) && v.filters.length ? ` WHERE ${(v.filters as string[]).join(' AND ')}` : '';
    return { name, text: core + filters, assertion: a, display: `${name} = ${core}${filters}` };
  }
  return undefined;
}

function valueKey(a: Assertion): string {
  if ((a.kind === 'key' || a.kind === 'grain') && Array.isArray(a.value)) {
    return canonicalJson((a.value as unknown[]).map((c) => String(c).toLowerCase()).sort());
  }
  return canonicalJson(a.value);
}

export function detectConflicts(assertions: readonly Assertion[]): Conflict[] {
  // A pending correction and the fact it would replace are a correction, not a conflict (C4b).
  const replaced = new Set(assertions.filter((a) => CONSIDERED.has(a.status) && a.supersedes).map((a) => a.supersedes as string));
  const considered = assertions.filter((a) => CONSIDERED.has(a.status) && !replaced.has(a.id));
  const conflicts: Conflict[] = [];

  // 1. definitions by business name
  const defs = new Map<string, Definition[]>();
  for (const a of considered) {
    const d = definitionOf(a);
    if (!d) continue;
    const k = normalizeName(d.name);
    if (!k) continue;
    defs.set(k, [...(defs.get(k) ?? []), d]);
  }
  for (const [name, list] of defs) {
    const distinct = new Set(list.map((d) => normalizeDefinition(d.text)));
    if (distinct.size < 2) continue;
    conflicts.push({
      rule: 'definition',
      key: `definition|${name}`,
      subject: [...new Set(list.flatMap((d) => d.assertion.subject))].sort(),
      ids: list.map((d) => d.assertion.id).sort(),
      sides: list.map((d) => `${d.display} (${d.assertion.trust}, ${d.assertion.status})`)
    });
  }

  // 2. same slot, incompatible value (definitional kinds are handled by rule 1)
  const slots = new Map<string, Assertion[]>();
  for (const a of considered) {
    if (isMirror(a) || a.kind === 'business_term' || a.kind === 'metric') continue;
    const k = `${a.kind}|${[...a.subject].sort().join(',')}|${a.predicate}`;
    slots.set(k, [...(slots.get(k) ?? []), a]);
  }
  for (const [k, list] of slots) {
    if (new Set(list.map(valueKey)).size < 2) continue;
    conflicts.push({
      rule: 'value',
      key: `value|${k}`,
      subject: [...list[0].subject].sort(),
      ids: list.map((a) => a.id).sort(),
      sides: list.map((a) => `${a.statement} (${a.trust}, ${a.status})`)
    });
  }

  // 3. claimed primary key vs the schema's declared primary key
  const nodes = new Map<string, { node: BaseNode; a: Assertion }>();
  const contains: GraphEdge[] = [];
  for (const a of considered) {
    if (!isMirror(a)) continue;
    const v = a.value as { node?: BaseNode; edge?: GraphEdge };
    if (v.node) nodes.set(v.node.id, { node: v.node, a });
    if (v.edge && v.edge.type === 'contains') contains.push(v.edge);
  }
  const declared = new Map<string, Array<{ name: string; a: Assertion }>>();
  for (const e of contains) {
    const col = nodes.get(e.target);
    if (!col || col.node.type !== 'column' || !(col.node as ColumnNode).isPrimaryKey) continue;
    declared.set(e.source, [...(declared.get(e.source) ?? []), { name: col.node.label.toLowerCase(), a: col.a }]);
  }
  for (const a of considered) {
    if (isMirror(a) || a.kind !== 'key' || a.predicate !== 'primary' || !Array.isArray(a.value)) continue;
    const table = a.subject.find((s) => declared.has(s));
    if (!table) continue;
    const pk = declared.get(table)!;
    const claimed = (a.value as unknown[]).map((c) => String(c).toLowerCase()).sort();
    const actual = pk.map((p) => p.name).sort();
    if (canonicalJson(claimed) === canonicalJson(actual)) continue;
    conflicts.push({
      rule: 'declared_key',
      key: `declared_key|${table}|${a.id}`,
      subject: [table],
      ids: [a.id, ...pk.map((p) => p.a.id)].sort(),
      sides: [`${a.statement} (${a.trust}, ${a.status})`, `Schema declares primary key (${actual.join(', ')}) (${pk[0].a.trust})`]
    });
  }

  return conflicts.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

/**
 * Sends every *active* participant of a conflict to `needs_review` (both
 * sides are flagged — principle C2: contradictions are surfaced). Idempotent:
 * an already-flagged assertion isn't flagged again. Returns the events appended.
 */
export async function flagConflicts(ledger: AssertionLedger, conflicts: readonly Conflict[]): Promise<LedgerEvent[]> {
  const byId = new Map(ledger.assertions().map((a) => [a.id, a] as const));
  const events: LedgerEvent[] = [];
  const flagged = new Set<string>();
  for (const c of conflicts) {
    for (const id of c.ids) {
      const a = byId.get(id);
      if (!a || a.status !== 'active' || flagged.has(id)) continue;
      // A declared schema fact is evidence, not a claim under dispute: only the claim is flagged.
      if (c.rule === 'declared_key' && isMirror(a)) continue;
      flagged.add(id);
      const others = c.ids.filter((x) => x !== id);
      events.push(ledger.buildEvent('flagged_needs_review', id, 'system', { reason: `conflicts with ${others.join(', ')} (${c.rule})`, causedBy: others[0] }));
    }
  }
  await ledger.append(events);
  return events;
}
