import { randomBytes } from 'node:crypto';

/**
 * Assertions — the unit of context (context-layer Phase C2, v0.29.0;
 * docs/context-layer-requirements.md §4.1). One claim about one subject,
 * with provenance, trust, status and validity. The context graph is a
 * projection of the active assertions (see `projection.ts`); the ledger
 * (`ledger.ts`) is the system of record.
 */

export type AssertionKind =
  | 'schema_fact'          // table/column/type/nullability exists (discovery, file ingestion)
  | 'data_fact'            // profiled property: null %, distinct count, min/max, freshness
  | 'key'                  // primary / natural / candidate key of an entity
  | 'grain'                // "one row per <...>" for a table or entity
  | 'relationship'         // join path between entities, with cardinality
  | 'business_term'        // glossary definition, bound to physical columns where possible
  | 'metric'               // measure/metric definition: expression, aggregation, grain, filters
  | 'business_rule'        // STRICT | RECOMMENDED rule
  | 'quality_expectation'  // expected data property (not-null, accepted values, freshness SLA)
  | 'decision'             // a design choice made in chat ("SCD2 for customer")
  | 'assumption'           // something taken as true without evidence; must be visible
  | 'constraint'           // non-functional: latency, volume, cost, compliance
  | 'naming_convention'
  | 'verified_query'       // a reviewed SQL query (the graph's `verified_query` nodes)
  | 'classification'       // MM1: a column's (or table's) sensitivity / compliance classification, apart from rules
  | 'metadata';            // MM1: catalog metadata on an asset — predicates tag, owner, domain, certification, property

export const ASSERTION_KINDS: readonly AssertionKind[] = [
  'schema_fact', 'data_fact', 'key', 'grain', 'relationship', 'business_term', 'metric', 'business_rule',
  'quality_expectation', 'decision', 'assumption', 'constraint', 'naming_convention', 'verified_query', 'classification', 'metadata'
];

export type AssertionStatus = 'proposed' | 'active' | 'rejected' | 'superseded' | 'needs_review';
/**
 * `assumed` (C4c, exploration mode, §7.4): a model's proposal or best guess
 * taken as true without a person, in an exploration problem. Live, but below
 * `documented`, so governed checks never accept it.
 */
export type TrustTier = 'verified' | 'confirmed' | 'documented' | 'assumed' | 'inferred';

export const TRUST_TIERS: readonly TrustTier[] = ['verified', 'confirmed', 'documented', 'assumed', 'inferred'];

export interface Evidence {
  type: 'chat_message' | 'interview_answer' | 'attachment' | 'file' | 'introspection' | 'probe' | 'spec_field' | 'user_edit' | 'model';
  /** chat id + message index, file path + line range, probe id, spec path, ... */
  ref: string;
  /** ≤ 300 chars quote of the evidence. */
  excerpt?: string;
}

export interface Verification {
  method: 'introspection' | 'probe' | 'test';
  at: string;
  result: 'pass' | 'fail';
  detail?: string;
  probeId?: string;
}

export interface Assertion {
  /** ULID (sortable, merge-friendly). */
  id: string;
  kind: AssertionKind;
  /** Graph node ids this is about; ≥ 1. Unresolvable references are kept as given and flagged. */
  subject: string[];
  /** Kind-specific, e.g. 'unique', 'grain', 'joins_to', 'defined_as'. Graph mirrors use 'node' / 'edge'. */
  predicate: string;
  /** Kind-specific payload, schema-validated per kind (`assertionSchemas.ts`). */
  value: unknown;
  /** One-sentence human-readable form, shown in UI and prompts. */
  statement: string;
  status: AssertionStatus;
  trust: TrustTier;
  evidence: Evidence[];
  /** Id of the assertion this replaces. */
  supersedes?: string;
  /** Id of the assertion that replaced this one (set by folding a `superseded` event). */
  supersededBy?: string;
  validFrom: string;
  /** Set when superseded / rejected. */
  validTo?: string;
  verification?: Verification;
  /** Business problem it belongs to (undefined = project-wide). */
  specId?: string;
  /** 'user:<name>' | 'agent:<agentType>' | 'mcp:<clientName>' | 'system' */
  createdBy: string;
  createdAt: string;
  /** Machine-readable flags, e.g. 'unresolved_subject'. */
  flags?: string[];
  /** Why the assertion was last flagged / rejected (from the folding event). */
  reviewReason?: string;
  /** C4c: the model that extracted or guessed it (§5.5 item 5); absent for people, parsers and probes. */
  model?: string;
  /** C4c: other sources that stated the same fact (folded from `corroborated` events). */
  corroboratedBy?: string[];
}

const TRUST_RANK: Record<TrustTier, number> = { verified: 5, confirmed: 4, documented: 3, assumed: 2, inferred: 1 };

export function trustRank(tier: TrustTier): number {
  return TRUST_RANK[tier] ?? 0;
}

export function strongerTrust(a: TrustTier, b: TrustTier): TrustTier {
  return trustRank(a) >= trustRank(b) ? a : b;
}

/**
 * The numeric `Origin.confidence` a node gets from its strongest supporting
 * assertion (C2: "every node's origin.confidence is filled from its
 * supporting assertion's trust tier").
 */
export function trustToConfidence(tier: TrustTier): number {
  switch (tier) {
    case 'verified': return 1.0;
    case 'confirmed': return 0.9;
    case 'documented': return 0.8;
    case 'assumed': return 0.6;
    default: return 0.5;
  }
}

/** Statuses whose assertions still describe the world (projected, conflict-checked). */
export function isLive(status: AssertionStatus): boolean {
  return status === 'active' || status === 'needs_review';
}

// ── ULIDs ─────────────────────────────────────────────────────────────────────

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/**
 * Monotonic ULID factory: ids from one factory sort in creation order even
 * within the same millisecond (the random part is incremented instead of
 * redrawn), which is what makes folding order well-defined.
 */
export function createUlidFactory(now: () => number = Date.now): () => string {
  let lastTime = -1;
  let lastRandom: number[] = [];
  return () => {
    let time = now();
    if (time <= lastTime) {
      time = lastTime;
      // increment the 16-char base-32 random part
      for (let i = lastRandom.length - 1; i >= 0; i--) {
        if (lastRandom[i] < 31) { lastRandom[i]++; break; }
        lastRandom[i] = 0;
      }
    } else {
      lastTime = time;
      const bytes = randomBytes(16);
      lastRandom = Array.from(bytes, (b) => b % 32);
      lastRandom[0] = lastRandom[0] % 16; // headroom so increments never overflow in practice
    }
    return encodeTime(time) + lastRandom.map((d) => CROCKFORD[d]).join('');
  };
}

// ── Canonical comparison ──────────────────────────────────────────────────────

/** JSON with object keys sorted, so equal values serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** Lower-cases and strips everything but letters and digits — for comparing names. */
export function normalizeName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
