import { Assertion } from '../context/assertions';
import { AssertionLedger } from '../context/ledger';
import { isPiiColumnName } from '../platform/sampleData';
import { PipelineGovernanceClassification, PipelineSpec } from '../pipelineSpec/types';
import { MaskStrategy } from '../transforms/primitives/mask';

/**
 * Governance as code (GOV, v0.47.0; mcp-engine §9.1).
 *
 * A column's classification is a fact like any other: a `business_rule`
 * assertion with predicate `classification` on the column, whose value names
 * the classification and, for personal data, how it is masked. A person
 * confirms it (Context Inbox, `autode governance classify`, or an agent's
 * proposal resolved by a person). From there:
 * - primitive candidates add a `mask` step after staging and fill the entity's
 *   `governance` block;
 * - the Pipeline Spec can't be valid while a `sensitive-pii` column of an
 *   entity isn't masked by a `mask` step of that entity (structural, in
 *   `validatePipelineSpec`);
 * - recording or approving a Pipeline Spec is refused while a confirmed
 *   `sensitive-pii` fact about a column it reads isn't in its governance block
 *   (`governanceGaps`, which needs the ledger).
 *
 * The name heuristic (`isPiiColumnName`, also used to mask sample rows) only
 * suggests candidates; it never classifies.
 */

export type Classification = PipelineGovernanceClassification;
export const CLASSIFICATIONS: readonly Classification[] = ['none', 'pii', 'sensitive-pii', 'confidential'];
export const CLASSIFICATION_PREDICATE = 'classification';

export interface ColumnGovernance {
  /** The column's ledger subject (`obj:<system>/<env>/<db.schema.table>.<column>`) or a plain `table.column`. */
  subject: string;
  table: string;
  column: string;
  classification: Classification;
  strategy?: MaskStrategy;
  /** The fact it comes from, and how far it is confirmed. */
  assertionId?: string;
  trust?: Assertion['trust'];
  status?: Assertion['status'];
}

/** Problem-level governance answers from the interview (BusinessProblemSpec.governance). */
export interface SpecGovernance {
  personalData: 'none' | 'present' | 'sensitive' | 'unknown';
  /** GDPR, HIPAA, PCI DSS, a client's own policy … */
  regulations?: string[];
  notes?: string[];
}

const LIVE = new Set(['active', 'proposed', 'needs_review']);

/** `obj:shop/prod/shop.public.customers.email` → table `shop.public.customers`, column `email`. */
export function splitColumnSubject(subject: string): { table: string; column: string } | undefined {
  const tail = subject.replace(/^obj:/, '').split('/').pop() ?? '';
  const i = tail.lastIndexOf('.');
  if (i <= 0 || i === tail.length - 1) return undefined;
  return { table: tail.slice(0, i).toLowerCase(), column: tail.slice(i + 1).toLowerCase() };
}

/** Whether a fact's table names this table: the same name, or one is a qualified form of the other. */
export function sameTable(a: string, b: string): boolean {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/** Live classification facts, the most recent per column; confirmed facts (active) before proposed ones. */
export function governanceFacts(assertions: readonly Assertion[]): ColumnGovernance[] {
  const byColumn = new Map<string, ColumnGovernance>();
  const rank = (s: string) => (s === 'active' ? 2 : 1);
  for (const a of assertions) {
    if (a.kind !== 'business_rule' || a.predicate !== CLASSIFICATION_PREDICATE || !LIVE.has(a.status)) continue;
    const v = (a.value ?? {}) as { classification?: string; strategy?: string };
    if (!CLASSIFICATIONS.includes(v.classification as Classification)) continue;
    for (const subject of a.subject) {
      const c = splitColumnSubject(subject);
      if (!c) continue;
      const key = `${c.table}.${c.column}`;
      const prev = byColumn.get(key);
      if (prev && rank(prev.status ?? '') > rank(a.status)) continue;
      byColumn.set(key, { subject, ...c, classification: v.classification as Classification, strategy: v.strategy === 'hash' || v.strategy === 'redact' ? v.strategy : undefined, assertionId: a.id, trust: a.trust, status: a.status });
    }
  }
  return [...byColumn.values()].sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
}

/** The facts about one table's columns. */
export function governanceFor(table: string, facts: readonly ColumnGovernance[]): ColumnGovernance[] {
  return facts.filter((f) => sameTable(f.table, table));
}

/** How a classification is masked by default: sensitive data and personal data are hashed (joins keep working); secrets are redacted. */
export function defaultStrategy(column: string, classification: Classification): MaskStrategy | undefined {
  if (classification === 'none' || classification === 'confidential') return undefined;
  return /(pass(word|wd)|secret|cvv|cvc|pin\b|token)/i.test(column) ? 'redact' : 'hash';
}

const SENSITIVE = /(ssn|social_?security|passport|national_?(id|insurance)|tax_?(id|number)|nin|nino|aadhaar|nric|card|iban|cvv|cvc|account_?number|routing|password|passwd|diagnosis|ethnicity|religion|salary|health|medical)/i;

export interface GovernanceCandidate { table: string; column: string; suggested: Classification; strategy?: MaskStrategy; why: string; fact?: ColumnGovernance }

/**
 * Columns that look like personal data by name, with a suggested classification,
 * next to what the ledger already says. Suggestions only: a person classifies.
 */
export function governanceCandidates(tables: ReadonlyArray<{ fqn: string; columns: readonly string[] }>, facts: readonly ColumnGovernance[]): GovernanceCandidate[] {
  const out: GovernanceCandidate[] = [];
  for (const t of tables) {
    for (const column of t.columns) {
      const fact = facts.find((f) => sameTable(f.table, t.fqn) && f.column === column.toLowerCase());
      if (!fact && !isPiiColumnName(column)) continue;
      const suggested: Classification = fact?.classification ?? (SENSITIVE.test(column) ? 'sensitive-pii' : 'pii');
      out.push({ table: t.fqn, column, suggested, strategy: fact?.strategy ?? defaultStrategy(column, suggested), why: fact ? `classified by fact ${fact.assertionId} (${fact.status}, ${fact.trust})` : 'its name suggests personal data', ...(fact ? { fact } : {}) });
    }
  }
  return out;
}

/** Whether personal data is in play for a problem: the governance interview part is asked only then. */
export function personalDataInPlay(input: { text?: string; columns?: readonly string[]; facts?: readonly ColumnGovernance[] }): boolean {
  if ((input.facts ?? []).some((f) => f.classification === 'pii' || f.classification === 'sensitive-pii')) return true;
  if ((input.columns ?? []).some((c) => isPiiColumnName(c))) return true;
  return /\b(customers?|patients?|employees?|members?|users?|subscribers?|personal data|pii|gdpr|hipaa|ccpa|pci|consumer|e-?mail|phone|address)\b/i.test(input.text ?? '');
}

/** Structural: every `sensitive-pii` column in an entity's governance block is masked by one of its `mask` steps. */
export function unmaskedSensitive(spec: Pick<PipelineSpec, 'entities'>): string[] {
  const errors: string[] = [];
  for (const [i, e] of (spec.entities ?? []).entries()) {
    const masked = new Set<string>();
    for (const t of e.transforms ?? []) if (t.kind === 'mask') for (const c of ((t.params as { columns?: Array<{ name?: string }> }).columns ?? [])) if (c?.name) masked.add(c.name.toLowerCase());
    for (const g of e.governance?.columns ?? []) {
      if (g.classification === 'sensitive-pii' && !masked.has(g.column.toLowerCase())) errors.push(`/entities/${i} ${e.name}: column ${g.column} is sensitive-pii but no mask step masks it.`);
    }
  }
  return errors;
}

/**
 * Against the ledger: confirmed `sensitive-pii` facts about a column an entity reads must be in that entity's
 * governance block (errors); unmasked `pii` columns are warnings (the platform's own masking policy may cover them).
 */
export function governanceGaps(spec: Pick<PipelineSpec, 'entities'>, facts: readonly ColumnGovernance[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const e of spec.entities ?? []) {
    const declared = new Map((e.governance?.columns ?? []).map((g) => [g.column.toLowerCase(), g.classification]));
    const masked = new Set<string>();
    for (const t of e.transforms ?? []) if (t.kind === 'mask') for (const c of ((t.params as { columns?: Array<{ name?: string }> }).columns ?? [])) if (c?.name) masked.add(c.name.toLowerCase());
    // Facts name source columns; after staging a column may be renamed, and one the staging step doesn't project doesn't flow on.
    const staging = (e.transforms ?? []).find((t) => t.kind === 'rename_cast');
    const renamed = staging ? new Map(((staging.params as { columns?: Array<{ source?: string; target?: string }> }).columns ?? []).filter((c) => c?.source && c?.target).map((c) => [c.source!.toLowerCase(), c.target!.toLowerCase()])) : undefined;
    for (const f of governanceFor(e.source?.object ?? '', facts)) {
      if (f.status !== 'active') continue;
      const name = renamed ? renamed.get(f.column) : f.column;
      if (!name) continue;
      if (f.classification === 'sensitive-pii' && declared.get(name) !== 'sensitive-pii') errors.push(`${e.name}: ${f.table}.${f.column} is sensitive-pii (fact ${f.assertionId}); add ${name} to the entity's governance block and mask it.`);
      else if (f.classification === 'pii' && !masked.has(name)) warnings.push(`${e.name}: ${f.table}.${f.column} is personal data and passes through unmasked; mask ${name}, or rely on the platform's masking policy (autode-snowflake-governance, autode-databricks-governance).`);
    }
  }
  return { errors, warnings };
}

/** The ledger subject of a table's column among known object ids, else a plain `table.column` subject. */
export function columnSubject(nodeIds: readonly string[], table: string, column: string): string {
  const col = column.toLowerCase();
  const hit = nodeIds.find((id) => { const c = splitColumnSubject(id); return !!c && c.column === col && sameTable(c.table, table) && id.startsWith('obj:'); });
  return hit ?? `${table.toLowerCase()}.${col}`;
}

/**
 * A person classifies a column (CLI, panel): a confirmed `business_rule` fact that replaces the column's
 * earlier classification, if any. Agents propose the same fact for a person to confirm instead.
 */
export async function classifyColumn(ledger: AssertionLedger, nodeIds: readonly string[], input: { table: string; column: string; classification: Classification; strategy?: MaskStrategy; by: string; channel: string; note?: string }): Promise<Assertion> {
  if (!CLASSIFICATIONS.includes(input.classification)) throw new Error(`The classification is one of ${CLASSIFICATIONS.join(', ')}.`);
  const personal = input.classification === 'pii' || input.classification === 'sensitive-pii';
  if (input.strategy && !personal) throw new Error('Only personal data (pii, sensitive-pii) is masked.');
  const subject = columnSubject(nodeIds, input.table, input.column);
  const strategy = personal ? input.strategy ?? defaultStrategy(input.column, input.classification) : undefined;
  const fact = {
    kind: 'business_rule' as const, subject: [subject], predicate: CLASSIFICATION_PREDICATE,
    value: { classification: input.classification, ...(strategy ? { strategy } : {}), level: 'STRICT', text: input.note ?? '' },
    statement: `${input.table}.${input.column} is ${input.classification}${strategy ? `, masked by ${strategy}` : ''}.`,
    evidence: [{ type: 'user_edit' as const, ref: `${input.channel}:${input.by}`, ...(input.note ? { excerpt: input.note.slice(0, 300) } : {}) }],
    trust: 'confirmed' as const, status: 'active' as const, createdBy: input.by
  };
  const prev = governanceFacts(ledger.assertions()).find((f) => f.column === input.column.toLowerCase() && sameTable(f.table, input.table));
  return prev?.assertionId ? ledger.supersede(prev.assertionId, fact) : ledger.assert(fact);
}

const PERSONAL = ['none', 'present', 'sensitive', 'unknown'] as const;
const SENSITIVITY = ['none', 'personal', 'sensitive'] as const;

/** The spec's `governance` field, read leniently (YAML or a model's JSON); absent when it says nothing. */
export function parseSpecGovernance(raw: unknown): SpecGovernance | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);
  const personalData = (PERSONAL as readonly string[]).includes(String(r.personalData)) ? r.personalData as SpecGovernance['personalData'] : 'unknown';
  const regulations = list(r.regulations), notes = list(r.notes);
  if (personalData === 'unknown' && !regulations.length && !notes.length) return undefined;
  return { personalData, ...(regulations.length ? { regulations } : {}), ...(notes.length ? { notes } : {}) };
}

/** A source's or a flow's `sensitivity` hint. */
export function parseSensitivity(raw: unknown): 'none' | 'personal' | 'sensitive' | undefined {
  return (SENSITIVITY as readonly string[]).includes(String(raw)) ? raw as 'none' | 'personal' | 'sensitive' : undefined;
}
