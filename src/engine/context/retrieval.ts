import { BaseNode, GraphEdge, TableNode } from './types';
import { normalizeName } from './assertions';

/**
 * Deterministic retrieval primitives (C3, v0.30.0;
 * docs/specs/context-layer.md §7.1): resolving free text to graph
 * nodes, and neighbourhood expansion. No LLM, no embeddings — lexical,
 * alias and graph matching only (§12).
 */

export interface GraphView {
  nodes: readonly BaseNode[];
  edges: readonly GraphEdge[];
}

export interface TextMatch {
  nodeId: string;
  /** How it matched: `fqn` > `column` > `schema` > `label` > `term`. */
  via: 'fqn' | 'column' | 'schema' | 'label' | 'term';
  /** The text that matched. */
  text: string;
  /** Character offset of the match in the input (for cue analysis). */
  index: number;
  score: number;
}

const STOP_LABELS = new Set(['id', 'name', 'type', 'date', 'data', 'value', 'status', 'code', 'key', 'table', 'view', 'source', 'target']);

function singular(word: string): string {
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('sses')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
  return word;
}

/** Normalized forms a table label is recognised by: `order_items` → `orderitems`, `orderitem`. */
function labelForms(label: string): string[] {
  const parts = label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return [];
  const plain = parts.join('');
  const last = parts[parts.length - 1];
  const sing = parts.slice(0, -1).join('') + singular(last);
  return [...new Set([plain, sing])];
}

interface Token { word: string; index: number }

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /[A-Za-z0-9_]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) tokens.push({ word: m[0].toLowerCase(), index: m.index });
  return tokens;
}

/**
 * Finds the graph entities a piece of text mentions: qualified names
 * (`shop.orders`, `shop.orders.status`), schema names (→ every table in
 * that schema), table labels in prose ("support tickets", "order"), and
 * business-term / metric names. Ambiguous labels match every candidate
 * (e.g. "customers" → both `shop.customers` and `crm.customers`).
 */
export function resolveText(text: string, graph: GraphView): TextMatch[] {
  const matches: TextMatch[] = [];
  const seen = new Set<string>();
  const add = (m: TextMatch) => {
    const k = `${m.nodeId}|${m.index}`;
    if (seen.has(k)) return;
    seen.add(k);
    matches.push(m);
  };
  const lower = text.toLowerCase();
  const tables = graph.nodes.filter((n) => n.type === 'table' || n.type === 'semantic_view') as TableNode[];
  const columnsByTable = new Map<string, BaseNode[]>();
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  for (const e of graph.edges) {
    if (e.type !== 'contains') continue;
    const col = nodeById.get(e.target);
    if (col && col.type === 'column') columnsByTable.set(e.source, [...(columnsByTable.get(e.source) ?? []), col]);
  }

  // 1. Qualified names, longest first: `db.schema.table`, `schema.table`, then `<table>.<column>`.
  const qualified = [...lower.matchAll(/[a-z0-9_]+(?:\.[a-z0-9_]+)+/g)];
  for (const q of qualified) {
    const ref = q[0];
    const table = tables.find((t) => (t.fqn || '').toLowerCase() === ref);
    if (table) { add({ nodeId: table.id, via: 'fqn', text: ref, index: q.index ?? 0, score: 1 }); continue; }
    const dot = ref.lastIndexOf('.');
    const parent = tables.find((t) => (t.fqn || '').toLowerCase() === ref.slice(0, dot));
    const col = parent && (columnsByTable.get(parent.id) ?? []).find((c) => c.label.toLowerCase() === ref.slice(dot + 1));
    if (parent && col) {
      add({ nodeId: parent.id, via: 'fqn', text: ref.slice(0, dot), index: q.index ?? 0, score: 1 });
      add({ nodeId: col.id, via: 'column', text: ref, index: q.index ?? 0, score: 0.9 });
      continue;
    }
    // `orders.status` style — table label + column
    const byLabel = tables.filter((t) => t.label.toLowerCase() === ref.slice(0, dot));
    for (const t of byLabel) {
      const c = (columnsByTable.get(t.id) ?? []).find((x) => x.label.toLowerCase() === ref.slice(dot + 1));
      if (c) {
        add({ nodeId: t.id, via: 'label', text: ref.slice(0, dot), index: q.index ?? 0, score: 0.8 });
        add({ nodeId: c.id, via: 'column', text: ref, index: q.index ?? 0, score: 0.8 });
      }
    }
  }

  const tokens = tokenize(text);

  // 2. Schema names in prose: "the shop and crm source schemas" → every table in them.
  const schemas = new Map<string, TableNode[]>();
  for (const t of tables) {
    const s = (t.schema || '').toLowerCase();
    if (!s || s === 'ddl' || s === 'csv' || s === 'json') continue;
    schemas.set(s, [...(schemas.get(s) ?? []), t]);
  }
  for (let i = 0; i < tokens.length; i++) {
    const tables = schemas.get(tokens[i].word);
    if (!tables) continue;
    // Only as a schema mention, not as part of a qualified name (handled above).
    if (text[tokens[i].index + tokens[i].word.length] === '.' || text[tokens[i].index - 1] === '.') continue;
    const next = tokens[i + 1]?.word ?? '';
    const prev = tokens[i - 1]?.word ?? '';
    const schemaCue = /^(schemas?|systems?|sources?|database|db|tables)$/.test(next) || /^(schemas?|systems?)$/.test(tokens[i + 2]?.word ?? '') || prev === 'and' || next === 'and';
    if (!schemaCue) continue;
    for (const t of tables) add({ nodeId: t.id, via: 'schema', text: tokens[i].word, index: tokens[i].index, score: 0.6 });
  }

  // 3. Table labels in prose — n-grams of up to 3 words, singular/plural-insensitive.
  const formIndex = new Map<string, TableNode[]>();
  for (const t of tables) {
    if (STOP_LABELS.has(t.label.toLowerCase())) continue;
    for (const f of labelForms(t.label)) formIndex.set(f, [...(formIndex.get(f) ?? []), t]);
  }
  for (let i = 0; i < tokens.length; i++) {
    if (text[tokens[i].index - 1] === '.') continue; // second half of a qualified name
    for (let n = 3; n >= 1; n--) {
      if (i + n > tokens.length) continue;
      const words = tokens.slice(i, i + n).map((t) => t.word);
      const forms = [words.join(''), words.slice(0, -1).join('') + singular(words[words.length - 1])];
      const hit = forms.map((f) => formIndex.get(f)).find((x) => x && x.length > 0);
      if (!hit) continue;
      const end = tokens[i + n - 1].index + tokens[i + n - 1].word.length;
      if (text[end] === '.' && /[a-z0-9_]/i.test(text[end + 1] ?? '')) break; // `orders.status` — handled in step 1
      for (const t of hit) add({ nodeId: t.id, via: 'label', text: text.slice(tokens[i].index, end), index: tokens[i].index, score: hit.length > 1 ? 0.5 : 0.7 });
      i += n - 1;
      break;
    }
  }

  // 4. Business terms and metrics by name.
  const norm = normalizeName(lower);
  for (const n of graph.nodes) {
    if (n.type !== 'business_term' && n.type !== 'metric') continue;
    const name = normalizeName(n.label);
    if (name.length < 3 || n.origin?.specId) continue;
    const at = norm.indexOf(name);
    if (at >= 0) add({ nodeId: n.id, via: 'term', text: n.label, index: Math.max(0, lower.indexOf(n.label.toLowerCase().split(/\s+/)[0])), score: 0.6 });
  }

  return matches.sort((a, b) => a.index - b.index || (a.nodeId < b.nodeId ? -1 : 1));
}

/**
 * Breadth-first neighbourhood expansion with distance decay — the logic
 * `GraphManager.traverseNeighborhood()` carried (unused) since its
 * introduction, moved here so the engine owns it. Edges are walked in both
 * directions: a seed table must reach the terms and rules pointing at it.
 * Returns relevance per reached node (seed = 1, then × decay per hop).
 */
export function expandNeighborhood(graph: GraphView, seeds: readonly string[], options: { maxHops?: number; decay?: number } = {}): Map<string, { distance: number; relevance: number }> {
  const maxHops = options.maxHops ?? 2;
  const decay = options.decay ?? 0.6;
  const ids = new Set(graph.nodes.map((n) => n.id));
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
    adj.set(e.target, [...(adj.get(e.target) ?? []), e.source]);
  }
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const s of seeds) {
    if (ids.has(s) && !dist.has(s)) { dist.set(s, 0); queue.push(s); }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    const d = dist.get(id)!;
    if (d >= maxHops) continue;
    for (const next of adj.get(id) ?? []) {
      if (!dist.has(next) && ids.has(next)) { dist.set(next, d + 1); queue.push(next); }
    }
  }
  const out = new Map<string, { distance: number; relevance: number }>();
  for (const [id, d] of dist) out.set(id, { distance: d, relevance: Math.pow(decay, d) });
  return out;
}
