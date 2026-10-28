import { Assertion, isLive } from '../context/assertions';
import { AssertionLedger, NewAssertion } from '../context/ledger';
import { isMirror } from '../context/projection';
import { MetadataConfig, OWNER_ROLES, checkMetadata, ruleOf } from './model';

/**
 * Writing the metadata model (MM1; §6.11). A person sets metadata through a
 * surface's own channel (the panel, an interactive terminal); an agent
 * proposes it as a fact for a person to confirm (`autode_propose_assertion`,
 * kind `metadata`; tags are low stakes). Single-valued metadata — a domain,
 * a certification, a property by name, a tag by key, an owner by role and
 * person — supersedes the fact it replaces, so history is kept.
 */

export type MetadataPredicate = 'tag' | 'owner' | 'domain' | 'certification' | 'property';

export interface SetMetadataInput {
  subject: string;
  /** For messages: the asset's name. */
  label?: string;
  predicate: MetadataPredicate;
  value: Record<string, unknown>;
  by: string;
  channel: string;
  note?: string;
}

function identity(predicate: string, v: Record<string, unknown>): string {
  if (predicate === 'tag') return `tag|${String(v.key).toLowerCase()}`;
  if (predicate === 'owner') return `owner|${String(v.role)}|${String(v.person).toLowerCase()}`;
  if (predicate === 'property') return `property|${String(v.name).toLowerCase()}`;
  return predicate;
}

function statementOf(input: SetMetadataInput): string {
  const v = input.value; const who = input.label ?? input.subject;
  switch (input.predicate) {
    case 'tag': return `${who} is tagged ${String(v.key)}${v.value !== undefined ? `=${String(v.value)}` : ''}.`;
    case 'owner': return `${String(v.person)} is ${who}'s ${String(v.role).replace(/_/g, ' ')}.`;
    case 'domain': return `${who} belongs to the ${String(v.domain)} domain.`;
    case 'certification': return `${who} is certified ${String(v.status)}${v.note ? ` (${String(v.note)})` : ''}.`;
    case 'property': return `${who}'s ${String(v.name)} is ${JSON.stringify(v.value)}.`;
  }
}

/** The live metadata fact this one would replace. */
export function previousMetadata(assertions: readonly Assertion[], subject: string, predicate: string, value: Record<string, unknown>): Assertion | undefined {
  const id = identity(predicate, value);
  return assertions.find((a) => a.kind === 'metadata' && a.predicate === predicate && isLive(a.status) && a.subject.includes(subject) && identity(predicate, (a.value ?? {}) as Record<string, unknown>) === id);
}

/** A person sets metadata: recorded confirmed, superseding what it replaces. Refused when it breaks the configuration (a controlled tag's values, a property's type). */
export async function setMetadata(ledger: AssertionLedger, config: MetadataConfig, input: SetMetadataInput): Promise<Assertion> {
  if (input.predicate === 'owner' && !OWNER_ROLES.includes(input.value.role as typeof OWNER_ROLES[number])) throw new Error(`An owner's role is one of ${OWNER_ROLES.join(', ')}.`);
  const problems = checkMetadata(config, input.predicate, input.value);
  if (problems.length) throw new Error(problems.join('; '));
  const fact: NewAssertion = {
    kind: 'metadata', subject: [input.subject], predicate: input.predicate, value: input.value, statement: statementOf(input),
    evidence: [{ type: 'user_edit', ref: `${input.channel}:${input.by}`, ...(input.note ? { excerpt: input.note.slice(0, 300) } : {}) }],
    trust: 'confirmed', status: 'active', createdBy: input.by
  };
  const prev = previousMetadata(ledger.assertions(), input.subject, input.predicate, input.value);
  return prev ? ledger.supersede(prev.id, fact) : ledger.assert(fact);
}

/** A person removes metadata: the fact is rejected (kept in history). */
export async function removeMetadata(ledger: AssertionLedger, input: Omit<SetMetadataInput, 'note'>): Promise<boolean> {
  const prev = previousMetadata(ledger.assertions(), input.subject, input.predicate, input.value);
  if (!prev) return false;
  await ledger.reject(prev.id, input.by, `removed through ${input.channel}`);
  return true;
}

/**
 * The MM1 migration, idempotent and recorded: a GOV-era classification
 * (`business_rule` / `classification`) becomes a `classification` fact, and a
 * rule written before MM1 gains its type and modality (STRICT → mandatory,
 * RECOMMENDED → advisory). Each is a supersession by `system`, keeping the
 * original's trust, status and evidence, so nothing is lost and the history
 * shows why it changed.
 */
export async function migrateMetadata(ledger: AssertionLedger): Promise<{ classifications: number; rules: number }> {
  let classifications = 0; let rules = 0;
  for (const a of ledger.assertions()) {
    if (a.kind !== 'business_rule' || isMirror(a) || !isLive(a.status)) continue;
    const v = (a.value ?? {}) as Record<string, unknown>;
    const base = { subject: a.subject, statement: a.statement, evidence: a.evidence, trust: a.trust, status: a.status, createdBy: 'system', ...(a.specId ? { specId: a.specId } : {}), ...(a.flags ? { flags: a.flags } : {}) };
    if (a.predicate === 'classification') {
      const value = Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'level'));
      await ledger.supersede(a.id, { ...base, kind: 'classification', predicate: 'classification', value });
      classifications++;
    } else if (!v.modality || !v.ruleType) {
      const r = ruleOf(a);
      await ledger.supersede(a.id, { ...base, kind: 'business_rule', predicate: a.predicate, value: { ...v, ruleType: r.ruleType, modality: r.modality, scope: r.scope } });
      rules++;
    }
  }
  return { classifications, rules };
}
