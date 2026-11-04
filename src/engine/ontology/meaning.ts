import { Assertion, TrustTier } from '../context/assertions';
import { BaseNode, GraphEdge, TableNode } from '../context/types';
import { Vocabulary, concepts as wordsOf } from '../context/vocabulary';
import { governanceFacts, sameTable } from '../governance/governance';
import { MeaningLink, TermScope, boundTo, meaningLinks, termScope } from './links';
import { ancestorsOf, isUpper } from './pack';
import { Ontology } from './store';

/**
 * Reasoning through meaning (ONT2; docs/specs/context-layer.md §6.8): the ontology in effect, the glossary's links
 * to it and the terms bound to columns, as one index the deterministic tools share.
 * - **Folding**: a concept's names (label and synonyms, through the customer's vocabulary) become one token, so
 *   "deal", "facility" and "credit line" compare as the same thing wherever a concept says they are.
 * - **The chain**: column → term (its binding) → concept (the term's `means` link) → the upper layer, each step with
 *   the fact behind it. Resolution and column matching return it as their evidence.
 * Read-only and deterministic: no model.
 */

export interface MeaningSources {
  graph: { nodes: readonly BaseNode[]; edges: readonly GraphEdge[] };
  assertions: readonly Assertion[];
  ontology?: Ontology;
  vocab: Vocabulary;
}

export interface ChainStep {
  kind: 'column' | 'table' | 'term' | 'concept' | 'upper';
  id: string;
  label: string;
  /** How this step follows from the previous one, and the fact behind it. */
  via?: 'bound to' | 'means' | 'represents' | 'under' | 'named';
  fact?: string;
  trust?: TrustTier;
  match?: string;
  scope?: TermScope;
}

interface Phrase { concept: string; label: string; words: string[] }

export interface MeaningIndex {
  sources: MeaningSources;
  phrases: Phrase[];
  links: MeaningLink[];
  /** Column or table id → the terms bound to it. */
  termsOf: Map<string, string[]>;
  nodes: Map<string, BaseNode>;
  tableOf: Map<string, string>;
  assertions: Map<string, Assertion>;
  /** Column subject (`table.column`, lower case) → its classification. */
  classification: Map<string, string>;
}

const cache = new WeakMap<object, MeaningIndex>();

export function meaningIndex(src: MeaningSources): MeaningIndex {
  const hit = cache.get(src);
  if (hit) return hit;
  const phrases: Phrase[] = [];
  for (const c of src.ontology?.concepts.values() ?? []) {
    if (isUpper(c.id) || c.status === 'deprecated') continue;
    for (const name of [c.label, ...(c.synonyms ?? [])]) {
      const words = wordsOf(name, src.vocab);
      if (words.length) phrases.push({ concept: c.id, label: c.label, words });
    }
  }
  // Longest names first, so "credit facility" folds before "facility".
  phrases.sort((a, b) => b.words.length - a.words.length || a.concept.localeCompare(b.concept));
  const nodes = new Map(src.graph.nodes.map((n) => [n.id, n] as const));
  const assertions = new Map(src.assertions.map((a) => [a.id, a] as const));
  const out = new Map<string, GraphEdge[]>();
  const tableOf = new Map<string, string>();
  for (const e of src.graph.edges) {
    out.set(e.source, [...(out.get(e.source) ?? []), e]);
    if (e.type === 'contains' && nodes.get(e.target)?.type === 'column') tableOf.set(e.target, e.source);
  }
  const termsOf = new Map<string, string[]>();
  for (const n of src.graph.nodes) if (n.type === 'business_term') for (const t of boundTo(n, out.get(n.id) ?? [], assertions)) termsOf.set(t, [...(termsOf.get(t) ?? []), n.id]);
  const classification = new Map(governanceFacts(src.assertions).filter((g) => g.status === 'active').map((g) => [`${g.table}.${g.column}`, g.classification] as const));
  const idx: MeaningIndex = { sources: src, phrases, links: meaningLinks(src.assertions), termsOf, nodes, tableOf, assertions, classification };
  cache.set(src, idx);
  return idx;
}

/** A name's words with every concept's name in it replaced by the concept (longest first), and the concepts found. */
export function foldConcepts(text: string, idx: MeaningIndex): { tokens: string[]; concepts: Array<{ concept: string; label: string; phrase: string }> } {
  let words = wordsOf(text, idx.sources.vocab);
  const found: Array<{ concept: string; label: string; phrase: string }> = [];
  for (const p of idx.phrases) {
    for (let i = 0; i + p.words.length <= words.length; i++) {
      if (!p.words.every((w, k) => words[i + k] === w)) continue;
      found.push({ concept: p.concept, label: p.label, phrase: words.slice(i, i + p.words.length).join(' ') });
      words = [...words.slice(0, i), `<${p.concept}>`, ...words.slice(i + p.words.length)];
    }
  }
  return { tokens: words, concepts: found };
}

/** The concepts a term means (live links). */
function conceptsOfTerm(termId: string, idx: MeaningIndex): MeaningLink[] {
  return idx.links.filter((l) => l.predicate === 'means' && l.subject === termId);
}

/** The binding fact of a term to an asset: the term definition that names it. */
function bindingFact(termId: string, assetId: string, idx: MeaningIndex): Assertion | undefined {
  const t = idx.nodes.get(termId);
  return (t?.supportedBy ?? []).map((id) => idx.assertions.get(id)).find((a): a is Assertion => !!a && a.kind === 'business_term' && (a.subject.includes(assetId) || ((a.value as { boundTo?: string[] } | undefined)?.boundTo ?? []).includes(assetId)));
}

/**
 * The chains from an asset to the concepts it means: a column through its terms, a table through *represents* (and
 * its terms), a term directly. Each chain ends at the upper layer.
 */
export function meaningChains(assetId: string, idx: MeaningIndex): ChainStep[][] {
  const n = idx.nodes.get(assetId);
  if (!n) return [];
  const o = idx.sources.ontology;
  const start: ChainStep = { kind: n.type === 'column' ? 'column' : n.type === 'business_term' ? 'term' : 'table', id: n.id, label: n.type === 'column' ? `${idx.nodes.get(idx.tableOf.get(n.id) ?? '')?.label ?? ''}.${n.label}`.replace(/^\./, '') : n.label };
  const tail = (concept: string): ChainStep[] => {
    const c = o?.concepts.get(concept);
    if (!c) return [{ kind: 'concept', id: concept, label: concept }];
    return ancestorsOf(concept, o!.concepts).map((a) => ({ kind: isUpper(a) ? 'upper' as const : 'concept' as const, id: a, label: o!.concepts.get(a)?.label ?? a, via: 'under' as const }));
  };
  const conceptStep = (l: MeaningLink): ChainStep => ({ kind: 'concept', id: l.concept, label: o?.concepts.get(l.concept)?.label ?? l.concept, via: l.predicate === 'means' ? 'means' : 'represents', fact: l.fact, trust: l.trust, ...(l.match ? { match: l.match } : {}) });
  const chains: ChainStep[][] = [];
  const viaTerms = (termIds: readonly string[], prefix: ChainStep[]) => {
    for (const t of termIds) {
      const term = idx.nodes.get(t);
      if (!term) continue;
      const bind = n.type === 'business_term' ? undefined : bindingFact(t, n.id, idx);
      const termStep: ChainStep = { kind: 'term', id: t, label: term.label, ...(n.type === 'business_term' ? {} : { via: 'bound to' as const }), ...(bind ? { fact: bind.id, trust: bind.trust } : {}), scope: termScope(term, idx.assertions) };
      const means = conceptsOfTerm(t, idx).filter((l) => l.status !== 'proposed');
      if (!means.length) { chains.push([...prefix, termStep]); continue; }
      for (const l of means) chains.push([...prefix, termStep, conceptStep(l), ...tail(l.concept)]);
    }
  };
  if (n.type === 'business_term') viaTerms([n.id], []);
  else {
    for (const l of idx.links.filter((x) => x.predicate === 'represents' && x.subject === n.id && x.status !== 'proposed')) chains.push([start, conceptStep(l), ...tail(l.concept)]);
    viaTerms(idx.termsOf.get(n.id) ?? [], [start]);
  }
  return chains;
}

export interface MeaningMatch {
  concept: string;
  label: string;
  /** What in the text named it: a concept name or synonym, or a glossary term. */
  matched: string;
  via: 'concept name' | 'term';
  terms: Array<{ id: string; label: string; scope: TermScope; match?: string; fact: string }>;
  /** Assets that mean it, each with its chain. */
  assets: Array<{ id: string; label: string; kind: string; chain: ChainStep[] }>;
}

/**
 * Resolution through concepts (ONT2): the concepts a text names (a concept's name or synonym, or a glossary term
 * that means one), and every asset that means them — tables that represent them, columns bound to their terms —
 * each with the chain as its evidence. Terms of the most specific scope first.
 */
export function resolveMeaning(text: string, idx: MeaningIndex, limit = 20): MeaningMatch[] {
  const o = idx.sources.ontology;
  if (!o) return [];
  const byConcept = new Map<string, MeaningMatch>();
  const add = (concept: string, matched: string, via: MeaningMatch['via']) => { if (!byConcept.has(concept) && o.concepts.has(concept)) byConcept.set(concept, { concept, label: o.concepts.get(concept)!.label, matched, via, terms: [], assets: [] }); };
  for (const f of foldConcepts(text, idx).concepts) add(f.concept, f.phrase, 'concept name');
  // A glossary term the text names (all of its words) brings the concepts it means.
  const words = new Set(wordsOf(text, idx.sources.vocab));
  for (const n of idx.sources.graph.nodes) {
    if (n.type !== 'business_term') continue;
    const tw = wordsOf(n.label, idx.sources.vocab);
    if (!tw.length || !tw.every((w) => words.has(w))) continue;
    for (const l of conceptsOfTerm(n.id, idx).filter((x) => x.status !== 'proposed')) add(l.concept, n.label, 'term');
  }
  const rank: Record<string, number> = { problem: 4, system: 3, line_of_business: 2, enterprise: 1 };
  for (const m of byConcept.values()) {
    const termIds = idx.links.filter((l) => l.predicate === 'means' && l.concept === m.concept && l.status !== 'proposed');
    m.terms = termIds.map((l) => { const t = idx.nodes.get(l.subject); return t ? { id: t.id, label: t.label, scope: termScope(t, idx.assertions), ...(l.match ? { match: l.match } : {}), fact: l.fact } : undefined; })
      .filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => rank[b.scope.level] - rank[a.scope.level] || a.label.localeCompare(b.label));
    const seen = new Set<string>();
    const assets: MeaningMatch['assets'] = [];
    for (const l of idx.links.filter((x) => x.predicate === 'represents' && x.concept === m.concept && x.status !== 'proposed')) {
      const t = idx.nodes.get(l.subject);
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      assets.push({ id: t.id, label: (t as TableNode).fqn || t.label, kind: t.type, chain: meaningChains(t.id, idx).find((c) => c.some((s) => s.id === m.concept)) ?? [] });
    }
    for (const term of m.terms) for (const [asset, ids] of idx.termsOf) {
      if (!ids.includes(term.id) || seen.has(asset)) continue;
      const a = idx.nodes.get(asset);
      if (!a) continue;
      seen.add(asset);
      const table = idx.nodes.get(idx.tableOf.get(asset) ?? '') as TableNode | undefined;
      assets.push({ id: a.id, label: a.type === 'column' && table ? `${table.fqn || table.label}.${a.label}` : (a as TableNode).fqn || a.label, kind: a.type, chain: meaningChains(a.id, idx).find((c) => c.some((s) => s.id === m.concept)) ?? [] });
    }
    m.assets = assets.slice(0, 50);
  }
  return [...byConcept.values()].slice(0, limit);
}

/** A column's classification, by its table and name. */
export function classificationOf(table: string | undefined, column: string, idx: MeaningIndex): string | undefined {
  if (!table) return undefined;
  for (const [k, v] of idx.classification) { const i = k.lastIndexOf('.'); if (k.slice(i + 1) === column.toLowerCase() && sameTable(k.slice(0, i), table)) return v; }
  return undefined;
}

/** The column node of a table's column, by the table's fully qualified name. */
export function columnNode(table: string | undefined, column: string, idx: MeaningIndex): BaseNode | undefined {
  if (!table) return undefined;
  for (const [col, t] of idx.tableOf) {
    const tn = idx.nodes.get(t) as TableNode | undefined;
    const c = idx.nodes.get(col);
    if (tn && c && c.label.toLowerCase() === column.toLowerCase() && sameTable(tn.fqn || tn.label, table)) return c;
  }
  return undefined;
}

/** The table node by its fully qualified name. */
export function tableNode(table: string | undefined, idx: MeaningIndex): BaseNode | undefined {
  if (!table) return undefined;
  return [...idx.nodes.values()].find((n) => n.type === 'table' && sameTable((n as TableNode).fqn || n.label, table));
}

