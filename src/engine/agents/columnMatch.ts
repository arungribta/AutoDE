import * as fs from 'node:fs';
import * as path from 'node:path';
import { EntityMapping } from '../types';
import { Vocabulary, concepts } from '../context/vocabulary';
import { TypeClass, typeClassOf } from '../grounding/sqlGrounding';
import { parseMappingContext } from '../documents/problemDocuments';
import { layoutPath } from '../workspaceLayout';
import { MeaningIndex, classificationOf, columnNode, foldConcepts, tableNode } from '../ontology/meaning';

/**
 * `autode_match_columns` (PA3b, v0.45.2): candidate source → target column
 * matches, deterministic, each with its reasons — the same name, the same
 * name without the table's prefix, the same meaning through the customer's
 * vocabulary (CUST_NO ~ customer_number), words in common, and how the
 * customer mapped the same column before (approved mappings of any
 * problem); types that can't convert lower the score. The mapper agent
 * decides; this gives it evidence instead of guesses.
 *
 * ONT2 (context-layer §6.8): with the meaning index, matching also goes
 * through meaning — names that are the same concept once the ontology's
 * names and synonyms are folded (deal ~ facility, pledge ~ collateral); a
 * target named by a glossary term bound to the source column, or by a term
 * of the source table that names the column; and columns whose terms mean
 * the same concept. Each says so in its reasons, with the chain. A shared
 * classification raises a match a little, and a sensitive source says the
 * target must mask it.
 */

export interface MatchColumn { name: string; type?: string }

export interface ColumnCandidate {
  sourceColumn: string;
  targetColumn: string;
  score: number;
  reasons: string[];
  sourceType?: string;
  targetType?: string;
}

export interface MatchResult {
  /** At most one per source and per target column, best first. */
  matches: ColumnCandidate[];
  /** Runners-up per source column, for the agent to weigh. */
  alternatives: Record<string, ColumnCandidate[]>;
  unmatchedSource: string[];
  unmatchedTarget: string[];
}

/** A past approved mapping: source column name → target column name, and where. */
export interface MappingPrecedent { source: string; target: string; problemId: string }

/** Every approved mapping document in the workspace, as column precedents. */
export function mappingPrecedents(workspaceRoot: string): MappingPrecedent[] {
  const root = layoutPath(workspaceRoot, 'problems');
  const out: MappingPrecedent[] = [];
  let ids: string[] = [];
  try { ids = fs.readdirSync(root); } catch { return out; }
  for (const id of ids) {
    let m;
    try { m = parseMappingContext(fs.readFileSync(path.join(root, id, 'context', 'mapping-context.yaml'), 'utf8')); } catch { continue; }
    if (m.status !== 'approved') continue;
    for (const e of m.mappings as EntityMapping[]) for (const c of e.columns ?? []) if (c.sourceColumn && c.targetColumn) out.push({ source: c.sourceColumn.toLowerCase(), target: c.targetColumn.toLowerCase(), problemId: id });
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The column name without a prefix naming its table (ord_id in orders → id; customer_name in customers → name). */
function withoutTablePrefix(column: string, table: string | undefined, vocab: Vocabulary): string {
  if (!table) return norm(column);
  const words = column.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length < 2) return norm(column);
  const tableConcepts = new Set(concepts(table, vocab));
  const first = concepts(words[0], vocab);
  return first.length && first.every((c) => tableConcepts.has(c)) ? words.slice(1).join('') : norm(column);
}

function convertible(a: TypeClass, b: TypeClass): boolean {
  if (a === 'other' || b === 'other' || a === b || a === 'string' || b === 'string') return true;
  const pair = [a, b].sort().join('|');
  return pair !== 'numeric|temporal' && pair !== 'boolean|temporal';
}

export function scorePair(s: MatchColumn, t: MatchColumn, ctx: { vocab: Vocabulary; sourceTable?: string; targetTable?: string; precedents: readonly MappingPrecedent[]; meaning?: MeaningIndex }): ColumnCandidate {
  const reasons: string[] = [];
  let score = 0;
  if (s.name.toLowerCase() === t.name.toLowerCase()) { score = 1; reasons.push('the same name'); }
  else if (norm(s.name) === norm(t.name)) { score = 0.95; reasons.push('the same name, apart from case and separators'); }
  else if (withoutTablePrefix(s.name, ctx.sourceTable, ctx.vocab) === withoutTablePrefix(t.name, ctx.targetTable, ctx.vocab)) { score = 0.85; reasons.push('the same name without the table prefix'); }
  else {
    const a = concepts(s.name, ctx.vocab), b = concepts(t.name, ctx.vocab);
    const sa = new Set(a), sb = new Set(b);
    const common = [...sa].filter((x) => sb.has(x));
    if (common.length && common.length === sa.size && common.length === sb.size) { score = 0.8; reasons.push(`the same meaning through the vocabulary (${common.join(' ')})`); }
    else if (common.length) {
      const j = common.length / new Set([...sa, ...sb]).size;
      score = Math.round(0.6 * j * 100) / 100;
      reasons.push(`words in common: ${common.join(', ')}`);
    }
  }
  if (ctx.meaning && score < 0.85) {
    const m = meaningScore(s, t, ctx.sourceTable, ctx.targetTable, ctx.meaning);
    if (m.score > score) { score = m.score; reasons.splice(0, reasons.length, ...m.reasons); }
  }
  if (ctx.meaning && score > 0) {
    // Classifications: the same one on both sides is a little more evidence; a sensitive source must be masked.
    const cs = classificationOf(ctx.sourceTable, s.name, ctx.meaning), ct = classificationOf(ctx.targetTable, t.name, ctx.meaning);
    if (cs && ct && cs === ct && cs !== 'none') { score = Math.min(1, Math.round((score + 0.05) * 100) / 100); reasons.push(`both classified ${cs}`); }
    if (cs === 'sensitive-pii' || cs === 'pii') reasons.push(`the source is classified ${cs}: the target must mask it`);
  }
  const before = ctx.precedents.filter((p) => p.source === s.name.toLowerCase() && p.target === t.name.toLowerCase());
  if (before.length) { score = Math.min(1, score + 0.2); reasons.push(`mapped this way before (${[...new Set(before.map((p) => p.problemId))].join(', ')})`); }
  if (s.type && t.type && score > 0) {
    const ca = typeClassOf(s.type), cb = typeClassOf(t.type);
    if (!convertible(ca, cb)) { score = Math.round(score * 50) / 100; reasons.push(`the types don't convert (${s.type} → ${t.type})`); }
  }
  return { sourceColumn: s.name, targetColumn: t.name, score, reasons, sourceType: s.type, targetType: t.type };
}

/** Best one-to-one matches at or above `threshold` (default 0.5), with alternatives. */
export function matchColumns(source: { table?: string; columns: MatchColumn[] }, target: { table?: string; columns: MatchColumn[] }, ctx: { vocab: Vocabulary; precedents?: readonly MappingPrecedent[]; threshold?: number; meaning?: MeaningIndex }): MatchResult {
  const threshold = ctx.threshold ?? 0.5;
  const all: ColumnCandidate[] = [];
  for (const s of source.columns) for (const t of target.columns) {
    const c = scorePair(s, t, { vocab: ctx.vocab, sourceTable: source.table, targetTable: target.table, precedents: ctx.precedents ?? [], ...(ctx.meaning ? { meaning: ctx.meaning } : {}) });
    if (c.score > 0) all.push(c);
  }
  all.sort((a, b) => b.score - a.score || a.sourceColumn.localeCompare(b.sourceColumn));
  const usedS = new Set<string>(), usedT = new Set<string>();
  const matches: ColumnCandidate[] = [];
  for (const c of all) {
    if (c.score < threshold || usedS.has(c.sourceColumn) || usedT.has(c.targetColumn)) continue;
    matches.push(c); usedS.add(c.sourceColumn); usedT.add(c.targetColumn);
  }
  const alternatives: Record<string, ColumnCandidate[]> = {};
  for (const s of source.columns) {
    const alt = all.filter((c) => c.sourceColumn === s.name && !matches.includes(c)).slice(0, 2);
    if (alt.length) alternatives[s.name] = alt;
  }
  return {
    matches, alternatives,
    unmatchedSource: source.columns.map((c) => c.name).filter((n) => !usedS.has(n)),
    unmatchedTarget: target.columns.map((c) => c.name).filter((n) => !usedT.has(n))
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) => { const x = new Set(a), y = new Set(b); return x.size > 0 && x.size === y.size && [...x].every((w) => y.has(w)); };

/** The meaning signals for a pair (ONT2), the strongest with its reason and chain. */
function meaningScore(s: MatchColumn, t: MatchColumn, sourceTable: string | undefined, targetTable: string | undefined, idx: MeaningIndex): { score: number; reasons: string[] } {
  const vocab = idx.sources.vocab;
  const best = { score: 0, reasons: [] as string[] };
  const offer = (score: number, reason: string) => { if (score > best.score) { best.score = score; best.reasons = [reason]; } };
  const tw = concepts(t.name, vocab);
  const sourceCol = columnNode(sourceTable, s.name, idx);
  const targetCol = columnNode(targetTable, t.name, idx);
  // A glossary term bound to the source column that is the target's name.
  for (const termId of sourceCol ? idx.termsOf.get(sourceCol.id) ?? [] : []) {
    const term = idx.nodes.get(termId);
    if (term && sameSet(concepts(term.label, vocab), tw)) offer(0.85, `through the term "${term.label}" bound to ${s.name}`);
  }
  // A term of the source table that names the column ("Loyalty Tier" of loyalty_members, for tier) and is the target's name.
  const st = tableNode(sourceTable, idx);
  const sw = new Set(concepts(s.name, vocab));
  for (const termId of st ? idx.termsOf.get(st.id) ?? [] : []) {
    const term = idx.nodes.get(termId);
    const words = term ? concepts(term.label, vocab) : [];
    if (term && sw.size && [...sw].every((w) => words.includes(w)) && sameSet(words, tw)) offer(0.75, `through the term "${term.label}" of ${st!.label}, which names ${s.name}`);
  }
  // The same concept once the ontology's names and synonyms are folded.
  const fs1 = foldConcepts(s.name, idx), ft = foldConcepts(t.name, idx);
  if ((fs1.concepts.length || ft.concepts.length) && sameSet(fs1.tokens, ft.tokens)) {
    const named = [...fs1.concepts, ...ft.concepts];
    const c = named[0];
    const pair = [...new Set(named.filter((x) => x.concept === c.concept).map((x) => x.phrase))];
    offer(0.8, `the same meaning through the concept ${c.label} (${c.concept}${pair.length > 1 ? `: ${pair.join(' ~ ')}` : ''})`);
  } else if (fs1.concepts.length && ft.concepts.length) {
    const a = new Set(fs1.tokens), b = new Set(ft.tokens);
    const common = [...a].filter((x) => b.has(x));
    if (common.some((x) => x.startsWith('<'))) offer(Math.round(0.6 * (common.length / new Set([...a, ...b]).size) * 100) / 100, `words in common through the ontology: ${common.map((x) => x.replace(/^<(.+)>$/, '$1')).join(', ')}`);
  }
  // Both columns' terms mean the same concept.
  if (sourceCol && targetCol) {
    const means = (col: string) => (idx.termsOf.get(col) ?? []).flatMap((termId) => idx.links.filter((l) => l.predicate === 'means' && l.subject === termId && l.status !== 'proposed').map((l) => ({ termId, concept: l.concept })));
    const a = means(sourceCol.id), b = means(targetCol.id);
    for (const x of a) for (const y of b) if (x.concept === y.concept) offer(0.85, `both mean ${idx.sources.ontology?.concepts.get(x.concept)?.label ?? x.concept} (${x.concept}): "${idx.nodes.get(x.termId)?.label}" and "${idx.nodes.get(y.termId)?.label}"`);
  }
  return best;
}
