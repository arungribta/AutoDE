import { Assertion, AssertionKind, canonicalJson, isLive } from './assertions';
import { AssertionLedger, NewAssertion } from './ledger';
import { validateAssertion } from './assertionSchemas';

/**
 * Facts from conversation (docs/context-layer-requirements.md §5.2, Phase
 * C4b). After each engineer turn in chat or the interview, the configured
 * model proposes the facts the turn states — the only LLM step. Everything
 * around it is deterministic: validation, subject resolution, dedup, and
 * recognising a correction of an earlier fact. Proposals land in the ledger
 * as `proposed` / `inferred`; a person confirms them in the Context Inbox.
 * A correction carries `supersedes` while proposed and retires the earlier
 * fact only when it is confirmed (`AssertionLedger.confirm()`).
 */

export const CHAT_EXTRACTABLE: readonly AssertionKind[] = ['key', 'grain', 'relationship', 'business_term', 'metric', 'business_rule', 'quality_expectation', 'decision', 'assumption', 'constraint'];

/**
 * Predicates that hold one value per subject: a later, different value from
 * the conversation is a correction, not a second fact.
 */
const SINGLE_VALUED: ReadonlyArray<[AssertionKind, string]> = [
  ['key', 'primary'], ['grain', 'grain'], ['metric', 'defined_as'], ['business_term', 'defined_as'], ['constraint', 'platform']
];

export interface ChatTurn {
  /** Where the turn is recorded (`chat:<chatId>#<n>`, `interview:<problem>#<question>`). */
  ref: string;
  text: string;
  source: 'chat' | 'interview';
  previousReply?: string;
  /** Actions the assistant took in the turn (files written, commands run) — recorded as evidence too. */
  actions?: string[];
}

export interface ChatExtractionOutcome {
  proposed: NewAssertion[];
  dropped: string[];
  /** Proposals equal to a live or proposed fact (kind, subject, predicate, value): not recorded again. */
  duplicates: string[];
}

function compact(a: Assertion): string {
  return `- ${a.id} [${a.kind}/${a.status}] ${a.subject.join(', ')} ${a.predicate} ${canonicalJson(a.value)} — ${a.statement}`;
}

/** The prompt (exposed over MCP as `autode_extract_assertions`, so other hosts run the same extraction with their own model). */
export function buildChatExtractionPrompt(turn: Pick<ChatTurn, 'text' | 'previousReply' | 'source'>, existing: readonly Assertion[]): { system: string; user: string } {
  return {
    system: [
      'You extract the facts a data engineer states in a conversation about a data engineering project. You propose; the engineer confirms.',
      'Respond with one JSON object only: { "facts": [ { "kind": "<kind>", "subject": ["<table, table.column, term or metric name>"], "predicate": "<short verb>", "value": <kind-specific>, "statement": "<one sentence, in the engineer\'s own terms>" } ] }',
      `Kinds: ${CHAT_EXTRACTABLE.join(', ')}. Values: key (predicate "primary") and grain (predicate "grain") → ["col", ...]; business_term (predicate "defined_as") → { "term": "...", "definition": "..." }; metric (predicate "defined_as") → { "name": "...", "expression": "...", "filters": [...] } or { "name": "...", "definition": "..." }; business_rule → { "text": "...", "level": "STRICT" | "RECOMMENDED" }; relationship (predicate "joins_to") → { "from": { "entity": "...", "columns": [...] }, "to": { ... } }; quality_expectation → { "check": "not_null" | "unique" | "accepted_values" | "freshness", "values": [...] }; decision, assumption → { "text": "..." }; constraint (predicate "platform") → { "platform": "...", ... }.`,
      'Only facts the engineer\'s message states — not the assistant\'s suggestions, not questions. One fact per clause. Never invent tables or columns; use the names as said. When the message corrects a fact listed below, propose the corrected fact with the same kind, subject and predicate: AutoDE links the correction itself.',
      'No facts → { "facts": [] }.'
    ].join('\n'),
    user: [
      existing.length ? `## Facts already recorded about these subjects\n${existing.slice(0, 40).map(compact).join('\n')}` : '',
      turn.previousReply ? `## The assistant's previous reply (context only — extract nothing from it)\n${turn.previousReply.slice(0, 2000)}` : '',
      `## The engineer's message (${turn.source})\n${turn.text}`,
      'Extract the facts now.'
    ].filter(Boolean).join('\n\n')
  };
}

/**
 * Validates the model's facts: invalid ones are dropped and reported, never
 * thrown. Subjects are resolved deterministically; an unresolved one is kept
 * as said and flagged `unresolved_subject`.
 */
export function parseChatExtraction(raw: unknown, turn: ChatTurn, resolve: (ref: string) => string | undefined, options: { model?: string } = {}): ChatExtractionOutcome {
  const out: ChatExtractionOutcome = { proposed: [], dropped: [], duplicates: [] };
  const facts = raw && typeof raw === 'object' && Array.isArray((raw as { facts?: unknown }).facts) ? (raw as { facts: unknown[] }).facts : [];
  if (raw !== undefined && !(raw && typeof raw === 'object' && Array.isArray((raw as { facts?: unknown }).facts))) out.dropped.push('the response had no "facts" list');
  for (const f of facts) {
    const x = (f ?? {}) as Record<string, unknown>;
    const kind = String(x.kind ?? '') as AssertionKind;
    if (!CHAT_EXTRACTABLE.includes(kind)) { out.dropped.push(`kind "${kind}" is not extractable from conversation`); continue; }
    const refs = (Array.isArray(x.subject) ? x.subject : [x.subject]).map((s) => String(s ?? '').trim()).filter(Boolean);
    const subject = refs.map((r) => resolve(r) ?? r);
    const unresolved = refs.filter((r) => !resolve(r));
    const statement = String(x.statement ?? '').trim();
    const candidate: NewAssertion = {
      kind, subject, predicate: String(x.predicate ?? kind).trim() || kind, value: x.value ?? {}, statement,
      evidence: [
        { type: turn.source === 'interview' ? 'interview_answer' : 'chat_message', ref: turn.ref, excerpt: turn.text.slice(0, 300) },
        ...(turn.actions ?? []).slice(0, 5).map((a) => ({ type: 'user_edit' as const, ref: a }))
      ],
      trust: 'inferred', status: 'proposed', createdBy: `extractor:${turn.source}`,
      ...(options.model ? { model: options.model } : {}),
      ...(unresolved.length ? { flags: ['unresolved_subject'] } : {})
    };
    const errors = validateAssertion(candidate);
    if (errors.length) { out.dropped.push(`${kind} "${statement.slice(0, 60)}": ${errors.join('; ')}`); continue; }
    out.proposed.push(candidate);
  }
  return out;
}

function sameSubject(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (s: string) => s.toLowerCase();
  const sb = new Set(b.map(norm));
  return a.every((s) => sb.has(norm(s)));
}

function valueKey(kind: AssertionKind, value: unknown): string {
  if ((kind === 'key' || kind === 'grain') && Array.isArray(value)) return canonicalJson(value.map((c) => String(c).toLowerCase()).sort());
  return canonicalJson(value);
}

/**
 * Links corrections: a proposal on a single-valued predicate whose kind,
 * subject and predicate match a live or proposed fact with a different value
 * supersedes the most recent such fact (applied when it is confirmed).
 */
export function linkCorrections(proposed: NewAssertion[], existing: readonly Assertion[]): Array<{ statement: string; supersedes: string }> {
  const links: Array<{ statement: string; supersedes: string }> = [];
  const candidates = existing.filter((a) => isLive(a.status) || a.status === 'proposed').sort((x, y) => (x.id < y.id ? 1 : -1));
  for (const p of proposed) {
    if (p.supersedes) continue;
    if (!SINGLE_VALUED.some(([k, pred]) => k === p.kind && pred === p.predicate)) continue;
    const prior = candidates.find((a) => a.kind === p.kind && a.predicate === p.predicate && sameSubject(a.subject, p.subject) && valueKey(a.kind, a.value) !== valueKey(p.kind, p.value));
    if (prior) { p.supersedes = prior.id; links.push({ statement: p.statement, supersedes: prior.id }); }
  }
  return links;
}

/** Records proposals (corrections linked, duplicates skipped). `supersedes` is kept on the proposal; nothing is retired yet. */
export async function recordChatProposals(ledger: AssertionLedger, outcome: ChatExtractionOutcome, options: { admit?: (a: NewAssertion) => NewAssertion } = {}): Promise<{ recorded: Assertion[]; corrections: Array<{ statement: string; supersedes: string }> }> {
  const existing = ledger.assertions();
  const key = (a: Pick<NewAssertion, 'kind' | 'subject' | 'predicate' | 'value'>) => canonicalJson([a.kind, a.subject.map((s) => s.toLowerCase()).sort(), a.predicate, valueKey(a.kind, a.value)]);
  const known = new Set(existing.filter((a) => isLive(a.status) || a.status === 'proposed').map(key));
  const fresh: NewAssertion[] = [];
  for (const p of outcome.proposed) {
    const k = key(p);
    if (known.has(k)) { outcome.duplicates.push(p.statement); continue; }
    known.add(k);
    fresh.push(p);
  }
  const corrections = linkCorrections(fresh, existing);
  // A correction keeps waiting for a person in any mode: it retires a fact only once confirmed.
  const events = fresh.map((p) => ledger.buildAsserted(options.admit && !p.supersedes ? options.admit(p) : p));
  await ledger.append(events);
  return { recorded: events.map((e) => ledger.get(e.assertionId)).filter((a): a is Assertion => !!a), corrections };
}

export type CompleteJson = (system: string, user: string, purpose: string) => Promise<unknown>;

export interface ExtractionRun {
  recorded: Assertion[];
  dropped: string[];
  duplicates: string[];
  corrections: Array<{ statement: string; supersedes: string }>;
  /** Set when the model or the ledger failed; the chat turn is never affected. */
  error?: string;
}

/**
 * One extraction, end to end. Never throws: whatever fails is reported in
 * `error`, because extraction must never block or fail a chat turn.
 */
export async function extractFromTurn(input: { turn: ChatTurn; ledger: AssertionLedger; resolve: (ref: string) => string | undefined; complete: CompleteJson; timeoutMs?: number; model?: string; admit?: (a: NewAssertion) => NewAssertion }): Promise<ExtractionRun> {
  const empty: ExtractionRun = { recorded: [], dropped: [], duplicates: [], corrections: [] };
  try {
    if (!input.turn.text.trim() || input.turn.text.trim().startsWith('/')) return empty;
    const existing = input.ledger.assertions().filter((a) => (isLive(a.status) || a.status === 'proposed') && !a.createdBy.startsWith('system') && a.predicate !== 'node' && a.predicate !== 'edge');
    const { system, user } = buildChatExtractionPrompt(input.turn, existing);
    const timeout = input.timeoutMs ?? 120000;
    const raw = await Promise.race([
      input.complete(system, user, 'Extract the facts the engineer stated'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${Math.round(timeout / 1000)} s`)), timeout).unref?.())
    ]);
    const outcome = parseChatExtraction(raw, input.turn, input.resolve, { model: input.model });
    const { recorded, corrections } = await recordChatProposals(input.ledger, outcome, { admit: input.admit });
    return { recorded, dropped: outcome.dropped, duplicates: outcome.duplicates, corrections };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Explicit capture (no model) ─────────────────────────────────────────────

function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'term';
}

/**
 * `/define <term> = <definition>`, `/rule <text>`, `/decide <text>`, `/assume <text>`:
 * straight to `proposed`, skipping the model. Returns undefined for anything else.
 */
export function parseCaptureCommand(text: string, ref: string, resolve: (ref: string) => string | undefined = () => undefined): NewAssertion | { error: string } | undefined {
  const m = /^\/(define|rule|decide|assume)\b\s*([\s\S]*)$/i.exec(text.trim());
  if (!m) return undefined;
  const command = m[1].toLowerCase();
  const body = m[2].trim();
  if (!body) return { error: `Usage: /${command} ${command === 'define' ? '<term> = <definition>' : '<text>'}` };
  const evidence = [{ type: 'chat_message' as const, ref, excerpt: text.slice(0, 300) }];
  const base = { trust: 'inferred' as const, status: 'proposed' as const, createdBy: 'user:capture', evidence };
  if (command === 'define') {
    const eq = body.indexOf('=');
    if (eq <= 0 || !body.slice(eq + 1).trim()) return { error: 'Usage: /define <term> = <definition>' };
    const term = body.slice(0, eq).trim();
    const definition = body.slice(eq + 1).trim();
    return { ...base, kind: 'business_term', subject: [resolve(term) ?? `term:${slug(term)}`], predicate: 'defined_as', value: { term, definition }, statement: `${term}: ${definition}` };
  }
  const kind: AssertionKind = command === 'rule' ? 'business_rule' : command === 'decide' ? 'decision' : 'assumption';
  const value = command === 'rule' ? { text: body, level: /\b(must|never|always|shall)\b/i.test(body) ? 'STRICT' : 'RECOMMENDED' } : { text: body };
  return { ...base, kind, subject: ['project'], predicate: kind === 'business_rule' ? 'requires' : kind === 'decision' ? 'decided' : 'assumes', value, statement: body };
}

// ── Citations ───────────────────────────────────────────────────────────────

/** Instruction added to chat prompts, so answers cite the facts they rest on (§5.2, §7.2). */
export const CITATION_INSTRUCTION = 'When your answer relies on a fact listed in the context with an id in brackets, cite it inline as [fact:<id>] right after the claim. Cite only ids that appear in the context; never invent one.';

const CITE_RE = /\[fact:([0-9A-Z]{26})\]/g;

/** The fact ids an answer cites, in order of first appearance. */
export function citedFactIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CITE_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
