import { Assertion, isLive, trustRank } from './assertions';
import { ColumnNode, TableNode } from './types';
import { GraphView, resolveText } from './retrieval';
import { detectRelationshipGaps } from './contextGaps';
import { isMirror } from './projection';

/**
 * Discover → validate → ask (Phase C4a, items 6, 7): gaps are closed by
 * machines first — discovery fills structure, probes check claims — and the
 * interview asks only about what is left. This module decides, without an
 * LLM, which facts discovery already established and which interview
 * questions they answer.
 */

export interface KnownFact {
  /** Table graph id. */
  table: string;
  fqn: string;
  kind: 'key' | 'grain' | 'structure';
  text: string;
}

interface Index {
  tables: Map<string, TableNode>;
  columns: Map<string, ColumnNode[]>;
}

function index(graph: GraphView): Index {
  const tables = new Map<string, TableNode>();
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  for (const n of graph.nodes) if (n.type === 'table' || n.type === 'semantic_view') tables.set(n.id, n as TableNode);
  const columns = new Map<string, ColumnNode[]>();
  for (const e of graph.edges) {
    const c = e.type === 'contains' ? byId.get(e.target) : undefined;
    if (c && c.type === 'column') columns.set(e.source, [...(columns.get(e.source) ?? []), c as ColumnNode]);
  }
  return { tables, columns };
}

/** What discovery and confirmed or verified facts establish about tables: declared keys, confirmed keys and grains, loaded structure. */
export function knownFacts(graph: GraphView, assertions: readonly Assertion[], tableIds?: Iterable<string>): KnownFact[] {
  const idx = index(graph);
  const ids = tableIds ? [...tableIds] : [...idx.tables.keys()];
  const out: KnownFact[] = [];
  for (const id of ids) {
    const t = idx.tables.get(id);
    if (!t) continue;
    const fqn = t.fqn || t.label;
    const cols = idx.columns.get(id) ?? [];
    const pk = cols.filter((c) => c.isPrimaryKey).map((c) => c.label);
    const live = assertions.filter((a) => !isMirror(a) && isLive(a.status) && a.subject[0] === id && trustRank(a.trust) >= trustRank('confirmed'));
    const key = live.find((a) => a.kind === 'key');
    if (pk.length) out.push({ table: id, fqn, kind: 'key', text: `the key of ${fqn} is (${pk.join(', ')}) — declared in its schema` });
    else if (key) out.push({ table: id, fqn, kind: 'key', text: `the key of ${fqn} is (${(key.value as string[]).join(', ')}) — ${key.trust}` });
    const grain = live.find((a) => a.kind === 'grain');
    if (grain) out.push({ table: id, fqn, kind: 'grain', text: `the grain of ${fqn} is one row per (${(grain.value as string[]).join(', ')}) — ${grain.trust}` });
    if (cols.length) out.push({ table: id, fqn, kind: 'structure', text: `${fqn} has ${cols.length} known columns` });
  }
  return out;
}

const ASKS_KEY = /\b(primary key|keys?|unique(ly)?|identif(y|ies|ier)|natural key|business key)\b/i;
const ASKS_GRAIN = /\b(grain|granularity|one row per|level of detail)\b/i;
const ASKS_JOIN = /\b(join(ed|s)?|relat(e|ed|ionship)|link(ed)?|foreign key)\b/i;
const ASKS_STRUCTURE = /\b(what|which) (columns|fields|attributes)\b|\bdata ?types?\b|\bschema of\b/i;

/**
 * Why discovery already answers a question, or `undefined` when it doesn't.
 * Conservative: only drops a question when *every* table it names has the
 * fact, and the question asks about nothing else it could be about.
 */
export function answeredByDiscovery(question: string, graph: GraphView, assertions: readonly Assertion[]): string | undefined {
  const tables = [...new Set(resolveText(question, graph).filter((m) => m.via !== 'term').map((m) => m.nodeId))].filter((id) => graph.nodes.some((n) => n.id === id && (n.type === 'table' || n.type === 'semantic_view')));
  if (tables.length === 0) return undefined;
  const facts = knownFacts(graph, assertions, tables);
  const all = (kind: KnownFact['kind']) => tables.every((t) => facts.some((f) => f.table === t && f.kind === kind));
  const texts = (kind: KnownFact['kind']) => facts.filter((f) => f.kind === kind).map((f) => f.text).join('; ');
  if (ASKS_GRAIN.test(question)) return all('grain') ? texts('grain') : undefined;
  if (ASKS_KEY.test(question) && !ASKS_JOIN.test(question)) return all('key') ? texts('key') : undefined;
  if (ASKS_JOIN.test(question) && tables.length >= 2) {
    const gaps = detectRelationshipGaps(question, resolveText(question, graph), graph, assertions);
    const fkBacked = graph.edges.some((e) => e.type === 'foreign_key' && tables.some((t) => e.source.startsWith(t)) && tables.some((t) => e.target.startsWith(t)));
    return gaps.length === 0 && fkBacked ? `the join between ${tables.join(' and ')} is declared by a foreign key` : undefined;
  }
  if (ASKS_STRUCTURE.test(question)) return all('structure') ? texts('structure') : undefined;
  return undefined;
}

/** Splits proposed interview questions into those to ask and those discovery answered (with the reason, for the log). */
export function filterInterviewQuestions<Q extends { prompt: string }>(questions: readonly Q[], graph: GraphView, assertions: readonly Assertion[]): { ask: Q[]; answered: Array<{ question: Q; reason: string }> } {
  const ask: Q[] = [];
  const answered: Array<{ question: Q; reason: string }> = [];
  for (const q of questions) {
    const reason = answeredByDiscovery(q.prompt, graph, assertions);
    if (reason) answered.push({ question: q, reason }); else ask.push(q);
  }
  return { ask, answered };
}

/** A prompt block listing what discovery established, so the interviewer doesn't ask for it. */
export function knownFactsBlock(facts: readonly KnownFact[], max = 40): string {
  const lines = facts.filter((f) => f.kind !== 'structure').slice(0, max).map((f) => `- ${f.text}`);
  return lines.length ? ['## Already established by discovery — do not ask about these', ...lines].join('\n') : '';
}
