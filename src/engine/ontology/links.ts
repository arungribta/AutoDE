import { Assertion, TrustTier, isLive } from '../context/assertions';
import { BaseNode, BusinessTermNode, GraphEdge } from '../context/types';
import { MatchType } from './pack';

/**
 * Links from the business vocabulary and the estate to concepts (ONT1; docs/specs/context-layer.md §6.8). Each
 * is a fact of kind `meaning`, with evidence and trust, reviewed in the Context Inbox:
 * - **means** (subject: a glossary term): the term means a concept, with a match type as SKOS names it;
 * - **represents** (subject: a table or a logical table): the entity-level link, as Collibra's *represents*.
 * Columns reach concepts only through the terms bound to them, so meaning is never stated twice.
 */

export interface MeaningLink {
  fact: string;
  /** The term or the table. */
  subject: string;
  concept: string;
  predicate: 'means' | 'represents';
  match?: MatchType;
  status: Assertion['status'];
  trust: TrustTier;
  statement: string;
}

/** Term scope (ONT1): the enterprise, a line of business, a named system or one business problem. */
export type ScopeLevel = 'enterprise' | 'line_of_business' | 'system' | 'problem';
export const SCOPE_RANK: Record<ScopeLevel, number> = { problem: 4, system: 3, line_of_business: 2, enterprise: 1 };
export interface TermScope { level: ScopeLevel; name?: string }

export function meaningLinks(assertions: readonly Assertion[], opts: { includeProposed?: boolean } = {}): MeaningLink[] {
  const out: MeaningLink[] = [];
  for (const a of assertions) {
    if (a.kind !== 'meaning' || (a.predicate !== 'means' && a.predicate !== 'represents')) continue;
    if (!(isLive(a.status) || (opts.includeProposed && a.status === 'proposed'))) continue;
    const v = (a.value ?? {}) as { concept?: string; match?: MatchType };
    if (typeof v.concept !== 'string' || !a.subject[0]) continue;
    out.push({ fact: a.id, subject: a.subject[0], concept: v.concept, predicate: a.predicate, ...(a.predicate === 'means' ? { match: v.match ?? 'exact' } : {}), status: a.status, trust: a.trust, statement: a.statement });
  }
  return out.sort((x, y) => x.fact.localeCompare(y.fact));
}

/** A term's scope: what its definition states, else the business problem it was recorded for, else the enterprise. */
export function termScope(term: BaseNode, assertions: ReadonlyMap<string, Assertion>): TermScope {
  for (const id of term.supportedBy ?? []) {
    const a = assertions.get(id);
    if (a?.kind !== 'business_term') continue;
    const s = (a.value as { scope?: TermScope } | undefined)?.scope;
    if (s?.level) return { level: s.level, ...(s.name ? { name: s.name } : {}) };
    if (a.specId) return { level: 'problem', name: a.specId };
  }
  return term.origin?.specId ? { level: 'problem', name: term.origin.specId } : { level: 'enterprise' };
}

/** Columns and tables a term is bound to: its mapped ids, `maps_to` edges and the definitions' `boundTo`. */
export function boundTo(term: BaseNode, edges: readonly GraphEdge[], assertions: ReadonlyMap<string, Assertion>): string[] {
  const out = new Set<string>((term as BusinessTermNode).mappedNodeIds ?? []);
  for (const e of edges) if (e.source === term.id && e.type === 'maps_to') out.add(e.target);
  for (const id of term.supportedBy ?? []) {
    const v = assertions.get(id)?.value as { boundTo?: string[] } | undefined;
    for (const b of v?.boundTo ?? []) out.add(b);
  }
  return [...out].sort();
}
