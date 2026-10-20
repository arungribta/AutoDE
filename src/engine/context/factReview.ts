import { Assertion } from './assertions';
import { AssertionLedger } from './ledger';
import { detectConflicts } from './conflicts';
import { isMirror } from './projection';
import { LOW_STAKES_ASSERTION_KINDS } from '../decisions/decisionStore';

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
}

export function factView(a: Assertion, byId: ReadonlyMap<string, Assertion>): FactView {
  return {
    id: a.id, kind: a.kind, subject: a.subject, predicate: a.predicate, value: a.value, statement: a.statement, status: a.status, trust: a.trust,
    createdBy: a.createdBy, flags: a.flags, reviewReason: a.reviewReason, evidence: a.evidence.slice(0, 3) as FactView['evidence'],
    supersedes: a.supersedes ? { id: a.supersedes, statement: byId.get(a.supersedes)?.statement } : undefined,
    verification: a.verification ? { result: a.verification.result, detail: a.verification.detail } : undefined,
    stakes: LOW_STAKES_ASSERTION_KINDS.includes(a.kind) ? 'low' : 'high'
  };
}

/** What waits for a person (proposed, or needing review after a failed check or a conflict), and the conflicts. */
export function inbox(ledger: AssertionLedger): { facts: FactView[]; conflicts: Array<{ rule: string; key: string; sides: unknown; ids: string[] }> } {
  const all = ledger.assertions();
  const byId = new Map(all.map((a) => [a.id, a] as const));
  return {
    facts: all.filter((a) => !isMirror(a) && (a.status === 'proposed' || a.status === 'needs_review')).map((a) => factView(a, byId)),
    conflicts: detectConflicts(all).map((c) => ({ rule: c.rule, key: c.key, sides: c.sides, ids: c.ids }))
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
    await ledger.confirm(id, actor);
    return `Confirmed: ${a.statement}${a.supersedes ? ' (replaces the earlier fact)' : ''}.`;
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
  return `Edited and confirmed: ${replacement.statement}.`;
}

/** Bulk confirmation, allowed only for documented facts from one source (C4b §5.4). */
export async function bulkConfirmDocumented(ledger: AssertionLedger, createdBy: string, actor: string): Promise<number> {
  const items = ledger.assertions().filter((a) => a.createdBy === createdBy && a.status === 'proposed' && a.trust === 'documented' && !isMirror(a));
  for (const a of items) await ledger.confirm(a.id, actor);
  return items.length;
}
