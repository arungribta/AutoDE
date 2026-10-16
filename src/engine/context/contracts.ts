import { Assertion, canonicalJson, isLive } from './assertions';
import { AssertionLedger, LedgerEvent, NewAssertion } from './ledger';
import { ContractModel } from './profiles';
import { PackDocument, clauseRef, trustFor } from './pack';
import { slugifyId } from './estate';

/**
 * Contract clauses as assertions (Phase C4a, items 4, 5). A data contract
 * says what *should* hold, so its clauses are expectations
 * (`quality_expectation`), never `schema_fact`: a contract never overwrites
 * what a catalog observed; a difference is a conformance violation
 * (`conformance.ts`).
 *
 * Subjects are contract ids — `contract:<document>/<entity>[.<field>]` —
 * because a contract entity is realised by tables in several systems.
 * Each clause carries clause-level provenance (`<file>#<path>@<sha>`).
 */

export function contractSubject(doc: Pick<PackDocument, 'id'>, entity: string, field?: string): string {
  return `contract:${doc.id}/${slugifyId(entity)}${field ? '.' + slugifyId(field) : ''}`;
}

/** The clauses a contract model states. `key` (subject|predicate) identifies a clause across versions. */
export function contractClauses(doc: PackDocument, model: ContractModel, sha: string): Array<{ key: string; assertion: NewAssertion }> {
  const out: Array<{ key: string; assertion: NewAssertion }> = [];
  const seen = new Set<string>();
  const trust = trustFor(doc.authority);
  const label = `${doc.path} v${doc.version}`;
  const add = (subject: string, predicate: string, value: Record<string, unknown>, statement: string, path: string) => {
    const key = `${subject}|${predicate}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, assertion: {
      kind: 'quality_expectation', subject: [subject], predicate, value, statement,
      evidence: [{ type: 'file', ref: clauseRef(doc.path, path, sha) }],
      trust, status: 'active', createdBy: `pack:${doc.id}`
    } });
  };
  for (const e of model.entities) {
    for (const f of e.fields) {
      const subject = contractSubject(doc, e.name, f.name);
      const schema: Record<string, unknown> = { check: 'schema' };
      if (f.type) schema.dataType = f.type;
      if (f.nullable !== undefined) schema.isNullable = f.nullable;
      if (f.columns) schema.columns = f.columns;
      add(subject, 'contract_schema', schema, `Contract ${label}: ${e.name}.${f.name}${f.type ? ` is ${f.type}` : ''}${f.nullable === false ? ', mandatory' : f.nullable ? ', optional' : ''}.`, f.path);
      if (f.unique) add(subject, 'unique', { check: 'unique' }, `Contract ${label}: ${e.name}.${f.name} is unique.`, f.path);
    }
    for (const r of e.rules) {
      const subject = contractSubject(doc, e.name, r.field);
      add(subject, r.check, { check: r.check, ...(r.values ? { values: r.values } : {}) }, `Contract ${label}: ${e.name}.${r.field} ${r.check === 'not_null' ? 'is never blank' : r.check === 'unique' ? 'is unique' : `is one of ${(r.values ?? []).join(', ')}`}.`, r.path);
    }
  }
  return out;
}

export interface ReconcileResult {
  asserted: number;
  superseded: number;
  retracted: number;
  unchanged: number;
}

/** The live clauses a document contributed earlier. */
export function documentClauses(assertions: readonly Assertion[], doc: Pick<PackDocument, 'id' | 'path'>): Assertion[] {
  return assertions.filter((a) => a.createdBy === `pack:${doc.id}` && (isLive(a.status) || a.status === 'proposed') && a.evidence.some((e) => e.ref.startsWith(`${doc.path}#`)));
}

/**
 * Records a (new version of a) document's clauses: new clauses are asserted,
 * changed ones supersede their predecessor, vanished ones are rejected with a
 * reason, and unchanged ones are left alone — so contract v2 supersedes
 * exactly the clauses that changed (acceptance).
 */
export async function reconcileContract(ledger: AssertionLedger, doc: PackDocument, model: ContractModel, sha: string): Promise<ReconcileResult> {
  const clauses = contractClauses(doc, model, sha);
  const existing = new Map<string, Assertion>(documentClauses(ledger.assertions(), doc).map((a) => [`${a.subject[0]}|${a.predicate}`, a]));
  const events: LedgerEvent[] = [];
  const result: ReconcileResult = { asserted: 0, superseded: 0, retracted: 0, unchanged: 0 };
  for (const { key, assertion } of clauses) {
    const prev = existing.get(key);
    existing.delete(key);
    if (!prev) {
      events.push(ledger.buildAsserted(assertion));
      result.asserted++;
    } else if (canonicalJson(prev.value) !== canonicalJson(assertion.value) || prev.trust !== assertion.trust) {
      const asserted = ledger.buildAsserted({ ...assertion, supersedes: prev.id });
      events.push(asserted, ledger.buildEvent('superseded', prev.id, assertion.createdBy ?? 'system', { by: asserted.assertionId, causedBy: asserted.id }));
      result.superseded++;
    } else {
      result.unchanged++;
    }
  }
  for (const gone of existing.values()) {
    events.push(ledger.buildEvent('rejected', gone.id, `pack:${doc.id}`, { reason: `no longer in ${doc.path} v${doc.version}` }));
    result.retracted++;
  }
  await ledger.append(events);
  return result;
}
