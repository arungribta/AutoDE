import { Assertion, TrustTier, isLive, trustRank } from './assertions';
import type { GraphView, TextMatch } from './retrieval';
import { isMirror } from './projection';

/**
 * Context gaps (C3, v0.30.0; docs/context-layer-requirements.md §7.3): a
 * fact a step or request needs that the context layer does not have at the
 * required trust. Principle C3 — the agent asks; it does not guess.
 *
 * Detected deterministically. C3 covers the two classes that can be decided
 * without the semantic model:
 *  - **relationship** — the text asks to combine two entities ("tickets per
 *    order", "join orders to customers") and no join path between them is
 *    backed at the required trust;
 *  - **decision** — a primitive parameter that carries a design decision
 *    (keys, partitioning, ordering) is backed by no assertion (raised from
 *    the grounding manifest, see `grounding/manifest.ts`).
 */

export type GapClass = 'relationship' | 'key' | 'grain' | 'decision' | 'structure';

export interface ContextGap {
  needed: GapClass;
  /** Graph node ids (or the text, when unresolved). */
  subject: string[];
  /** What the requester said, for the question shown to the engineer. */
  text: string;
  reason: 'absent' | 'below_trust';
  minTrust: TrustTier;
  /** The best trust found, when `below_trust`. */
  foundTrust?: TrustTier;
  stepId?: string;
}

/** Defaults from §7.3: keys / grain / joins need ≥ confirmed; others ≥ documented. */
export const DEFAULT_MIN_TRUST: Record<GapClass, TrustTier> = {
  relationship: 'confirmed',
  key: 'confirmed',
  grain: 'confirmed',
  decision: 'documented',
  structure: 'documented'
};

/**
 * Phrases that ask for two entities to be combined: "<A> per <B>",
 * "<A> by <B>", "<A> for each <B>", "join <A> (to|with|and) <B>",
 * "<A> joined (to|with) <B>". Returns the pairs of matches involved.
 */
function combinationPairs(text: string, matches: readonly TextMatch[]): Array<[TextMatch[], TextMatch[]]> {
  const tables = matches.filter((m) => m.via !== 'term' && m.via !== 'column' && m.via !== 'schema');
  if (tables.length < 2) return [];
  const lower = text.toLowerCase();
  const pairs: Array<[TextMatch[], TextMatch[]]> = [];
  const cue = /\b(per|by|for each|for every|joined to|joined with|join(?:ed)? on)\b/g;
  let m: RegExpExecArray | null;
  while ((m = cue.exec(lower)) !== null) {
    const at = m.index;
    const before = tables.filter((t) => t.index < at && at - (t.index + t.text.length) <= 3);
    const after = tables.filter((t) => t.index > at && t.index - (at + m![0].length) <= 3);
    if (before.length && after.length) pairs.push([group(before), group(after)]);
  }
  const join = /\bjoin\s+/g;
  while ((m = join.exec(lower)) !== null) {
    const start = m.index + m[0].length;
    const first = tables.filter((t) => t.index >= start && t.index - start <= 2);
    if (!first.length) continue;
    const firstEnd = Math.max(...first.map((t) => t.index + t.text.length));
    const rest = lower.slice(firstEnd);
    const link = /^\s+(to|with|and|onto)\s+/.exec(rest);
    if (!link) continue;
    const secondAt = firstEnd + link[0].length;
    const second = tables.filter((t) => t.index >= secondAt && t.index - secondAt <= 2);
    if (second.length) pairs.push([group(first), group(second)]);
  }
  return pairs;
}

/** All matches of the same text span (an ambiguous label matches several tables). */
function group(list: TextMatch[]): TextMatch[] {
  const first = list[list.length - 1];
  return list.filter((t) => t.index === first.index);
}

interface JoinEdge { a: string; b: string; trust: TrustTier }

/** Join evidence: foreign-key edges (trust of their supporting assertion) and live or proposed relationship assertions. */
function joinEdges(graph: GraphView, assertions: readonly Assertion[]): JoinEdge[] {
  const byId = new Map(assertions.map((a) => [a.id, a] as const));
  const out: JoinEdge[] = [];
  const nodeTable = new Map<string, string>(); // column id → table id
  for (const e of graph.edges) if (e.type === 'contains') nodeTable.set(e.target, e.source);
  const tableOf = (id: string) => nodeTable.get(id) ?? id;
  for (const e of graph.edges) {
    if (e.type !== 'foreign_key' && e.type !== 'related_to') continue;
    const trusts = (e.supportedBy ?? []).map((id) => byId.get(id)?.trust).filter((t): t is TrustTier => !!t);
    const trust = trusts.sort((x, y) => trustRank(y) - trustRank(x))[0] ?? 'documented';
    out.push({ a: tableOf(e.source), b: tableOf(e.target), trust });
  }
  for (const a of assertions) {
    if (isMirror(a) || a.kind !== 'relationship' || a.subject.length < 2) continue;
    if (!isLive(a.status) && a.status !== 'proposed') continue;
    // A proposal is evidence of a join, but only at the trust it has (inferred) — never enough on its own.
    out.push({ a: tableOf(a.subject[0]), b: tableOf(a.subject[1]), trust: a.status === 'proposed' ? 'inferred' : a.trust });
  }
  return out;
}

/** Best (max over paths of the min trust along the path) join trust between two tables, ≤ 3 hops. */
function bestPathTrust(edges: readonly JoinEdge[], from: string, to: string): TrustTier | undefined {
  if (from === to) return 'verified';
  let best: TrustTier | undefined;
  const walk = (at: string, visited: Set<string>, minSoFar: TrustTier | undefined, depth: number) => {
    if (depth > 3) return;
    for (const e of edges) {
      const next = e.a === at ? e.b : e.b === at ? e.a : undefined;
      if (!next || visited.has(next)) continue;
      const m = !minSoFar || trustRank(e.trust) < trustRank(minSoFar) ? e.trust : minSoFar;
      if (next === to) {
        if (!best || trustRank(m) > trustRank(best)) best = m;
        continue;
      }
      walk(next, new Set([...visited, next]), m, depth + 1);
    }
  };
  walk(from, new Set([from]), undefined, 1);
  return best;
}

/** Relationship gaps for a request or step text (see the module comment). */
export function detectRelationshipGaps(
  text: string,
  matches: readonly TextMatch[],
  graph: GraphView,
  assertions: readonly Assertion[],
  options: { minTrust?: TrustTier; stepId?: string } = {}
): ContextGap[] {
  const minTrust = options.minTrust ?? DEFAULT_MIN_TRUST.relationship;
  const edges = joinEdges(graph, assertions);
  const gaps: ContextGap[] = [];
  const seen = new Set<string>();
  for (const [left, right] of combinationPairs(text, matches)) {
    let best: TrustTier | undefined;
    for (const l of left) for (const r of right) {
      const t = bestPathTrust(edges, l.nodeId, r.nodeId);
      if (t && (!best || trustRank(t) > trustRank(best))) best = t;
    }
    if (best && trustRank(best) >= trustRank(minTrust)) continue;
    const subject = [...new Set([...left.map((x) => x.nodeId), ...right.map((x) => x.nodeId)])];
    const key = subject.slice().sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    gaps.push({
      needed: 'relationship',
      subject,
      text: `${left[0].text} ↔ ${right[0].text}`,
      reason: best ? 'below_trust' : 'absent',
      minTrust,
      foundTrust: best,
      stepId: options.stepId
    });
  }
  return gaps;
}

/** One line per gap, phrased as the question the engineer is asked. */
export function describeGap(gap: ContextGap): string {
  if (gap.needed === 'relationship') {
    return gap.reason === 'absent'
      ? `No known relationship joins ${gap.text}. How are they related (which columns), or should this be dropped?`
      : `The join ${gap.text} is only ${gap.foundTrust} (needs ${gap.minTrust}). Confirm the join columns before it is used.`;
  }
  if (gap.needed === 'structure') {
    return `The structure of ${gap.text} is not loaded (only its name is known). Connect to its system, or import its DDL or column dictionary, before relying on its columns.`;
  }
  return `${gap.needed} for ${gap.subject.join(', ')} is ${gap.reason === 'absent' ? 'not known' : `only ${gap.foundTrust} (needs ${gap.minTrust})`}.`;
}

