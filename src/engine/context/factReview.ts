import { Assertion } from './assertions';
import { AssertionLedger } from './ledger';
import { Conflict, detectConflicts } from './conflicts';
import { isMirror } from './projection';
import { isLowStakesFact } from '../decisions/decisionStore';

/**
 * Reviewing facts — the Context Inbox's logic (C4b), shared by the panel and
 * `autode facts` (parity step 1b, v0.43.3): what is waiting, and confirming,
 * rejecting, editing (supersede and confirm) or bulk-confirming documented
 * facts. A person does these; agents confirm low-stakes facts only, through
 * `autode_review_assertion`.
 */

export interface FactView {
  id: string;
  kind: string;
  subject: string[];
  predicate: string;
  value: unknown;
  statement: string;
  status: string;
  trust: string;
  createdBy?: string;
  flags?: string[];
  reviewReason?: string;
  evidence: Array<{ type: string; ref: string; quote?: string }>;
  supersedes?: { id: string; statement?: string };
  verification?: { result: string; detail?: string };
  stakes: 'low' | 'high';
  /** The facts this one contradicts, and what confirming it does to each (v0.56.3). */
  contradicts?: Array<{ id: string; statement: string; status: string; settles: 'rejects' | 'blocks' }>;
}

export function factView(a: Assertion, byId: ReadonlyMap<string, Assertion>, conflicts: readonly Conflict[] = []): FactView {
  const others = contradicting(a.id, conflicts, byId);
  return {
    id: a.id, kind: a.kind, subject: a.subject, predicate: a.predicate, value: a.value, statement: a.statement, status: a.status, trust: a.trust,
    createdBy: a.createdBy, flags: a.flags, reviewReason: a.reviewReason, evidence: a.evidence.slice(0, 3) as FactView['evidence'],
    supersedes: a.supersedes ? { id: a.supersedes, statement: byId.get(a.supersedes)?.statement } : undefined,
    verification: a.verification ? { result: a.verification.result, detail: a.verification.detail } : undefined,
    stakes: isLowStakesFact(a.kind, a.predicate) ? 'low' : 'high',
    contradicts: others.length ? others.map((o) => ({ id: o.id, statement: isMirror(o) ? "the schema's declared primary key" : o.statement, status: o.status, settles: blocks(o) ? 'blocks' as const : 'rejects' as const })) : undefined
  };
}

/** The other sides of every conflict `id` is in. */
function contradicting(id: string, conflicts: readonly Conflict[], byId: ReadonlyMap<string, Assertion>): Assertion[] {
  const ids = new Set(conflicts.filter((c) => c.ids.includes(id)).flatMap((c) => c.ids).filter((x) => x !== id));
  return [...ids].map((x) => byId.get(x)).filter((x): x is Assertion => !!x);
}

/** A side a confirmation can't overrule: a fact a person confirmed, or the schema itself. */
function blocks(a: Assertion): boolean {
  return isMirror(a) || (a.status === 'active' && a.trust === 'confirmed');
}

/**
 * A confirmation settles the conflicts the fact is in (v0.56.3): the person chose this side, so
 * the other unconfirmed sides are rejected. Before, the confirmed fact was active for a moment
 * and conflict detection sent it straight back to review, so Confirm seemed to do nothing. A side
 * a person confirmed, or the schema's declared key, isn't overruled: that is refused with why.
 * Returns the ids to reject once the fact is confirmed.
 */
function settleConflicts(ledger: AssertionLedger, id: string, replacing?: string): string[] {
  const all = ledger.assertions();
  const byId = new Map(all.map((a) => [a.id, a] as const));
  const others = contradicting(id, detectConflicts(all), byId).filter((o) => o.id !== replacing);
  const blocked = others.filter(blocks);
  if (blocked.length) {
    const what = blocked.map((o) => (isMirror(o) ? 'the primary key the schema declares' : `the confirmed fact "${o.statement}"`)).join('; ');
    throw new Error(`This contradicts ${what}. Edit this fact to agree, reject it, or change that one first.`);
  }
  return others.map((o) => o.id);
}

async function rejectContradicted(ledger: AssertionLedger, ids: readonly string[], actor: string, chosen: Assertion): Promise<string> {
  for (const x of ids) await ledger.reject(x, actor, `contradicts the confirmed "${chosen.statement}"`);
  if (!ids.length) return '';
  return ids.length === 1 ? ' The fact it contradicted was rejected.' : ` The ${ids.length} facts it contradicted were rejected.`;
}

/** What waits for a person (proposed, or needing review after a failed check or a conflict), and the conflicts. */
export function inbox(ledger: AssertionLedger): { facts: FactView[]; conflicts: Array<{ rule: string; key: string; sides: unknown; ids: string[] }> } {
  const all = ledger.assertions();
  const byId = new Map(all.map((a) => [a.id, a] as const));
  const conflicts = detectConflicts(all);
  return {
    facts: all.filter((a) => !isMirror(a) && (a.status === 'proposed' || a.status === 'needs_review')).map((a) => factView(a, byId, conflicts)),
    conflicts: conflicts.map((c) => ({ rule: c.rule, key: c.key, sides: c.sides, ids: c.ids }))
  };
}

export type ReviewAction = 'confirm' | 'reject' | 'edit';

/**
 * One review by a person (`actor` like `user:jdoe`). `edit` supersedes the fact
 * with the edited statement or value (JSON) as confirmed, and still retires the
 * fact an edited correction corrects. Returns a line for the log.
 */
export async function reviewFact(ledger: AssertionLedger, id: string, action: ReviewAction, actor: string, edit: { statement?: string; value?: string; note?: string } = {}): Promise<string> {
  const a = ledger.get(id);
  if (!a || isMirror(a)) throw new Error(`No fact ${id}.`);
  if (action === 'confirm') {
    const contradicted = settleConflicts(ledger, id, a.supersedes);
    await ledger.confirm(id, actor);
    return `Confirmed: ${a.statement}${a.supersedes ? ' (replaces the earlier fact)' : ''}.${await rejectContradicted(ledger, contradicted, actor, a)}`;
  }
  if (action === 'reject') {
    await ledger.reject(id, actor, edit.note);
    return `Rejected: ${a.statement}.`;
  }
  let value: unknown = a.value;
  if (edit.value !== undefined && edit.value.trim()) {
    try { value = JSON.parse(edit.value); } catch { throw new Error('The value must be JSON (e.g. ["order_id"] or {"term": "…", "definition": "…"}).'); }
  }
  const replacement = await ledger.supersede(id, { kind: a.kind, subject: a.subject, predicate: a.predicate, value, statement: edit.statement?.trim() || a.statement, evidence: [...a.evidence, { type: 'user_edit', ref: 'context-inbox' }], trust: 'confirmed', status: 'active', specId: a.specId, createdBy: actor });
  const target = a.supersedes ? ledger.get(a.supersedes) : undefined;
  if (target && target.status !== 'superseded' && target.status !== 'rejected') await ledger.append([ledger.buildEvent('superseded', target.id, actor, { by: replacement.id })]);
  // The edit is what the person wants: what still contradicts it, unconfirmed, goes.
  let contradicted: string[];
  try { contradicted = settleConflicts(ledger, replacement.id); } catch (err) { return `Edited and confirmed: ${replacement.statement}. ${err instanceof Error ? err.message : String(err)}`; }
  return `Edited and confirmed: ${replacement.statement}.${await rejectContradicted(ledger, contradicted, actor, replacement)}`;
}

/** Bulk confirmation, allowed only for documented facts from one source (C4b §5.4). A fact in a conflict is left for a person to choose. */
export async function bulkConfirmDocumented(ledger: AssertionLedger, createdBy: string, actor: string): Promise<number> {
  const disputed = new Set(detectConflicts(ledger.assertions()).flatMap((c) => c.ids));
  const items = ledger.assertions().filter((a) => a.createdBy === createdBy && a.status === 'proposed' && a.trust === 'documented' && !isMirror(a) && !disputed.has(a.id));
  for (const a of items) await ledger.confirm(a.id, actor);
  return items.length;
}
