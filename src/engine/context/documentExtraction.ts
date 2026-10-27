import { Assertion, AssertionKind, canonicalJson, isLive } from './assertions';
import { validateAssertion } from './assertionSchemas';
import { AssertionLedger, LedgerEvent, NewAssertion } from './ledger';
import { PackDocument, clauseRef } from './pack';
import { slugifyId } from './estate';

/**
 * Free-text extraction (Phase C4a, item 3): BRDs, notes and other
 * unstructured documents, per fact, through one governed prompt. Every fact
 * lands `proposed` / `inferred` with section-level provenance
 * (`<file>#<section>:L<a>-L<b>@<sha>`) and waits for the engineer — the LLM
 * proposes; it never decides (principle C3).
 *
 * C4c (§5.5 item 3) keeps the model honest: every fact quotes the words that
 * state it, and a fact whose quote isn't in its section is dropped as
 * unsupported; the model accounts for every section, and a section it didn't
 * report on is read again on its own; tables (a data dictionary) and fixed
 * phrases ("must be unique", "never null", "one row per") are parsed without
 * a model; the same fact from a second source corroborates the first; and
 * each fact records the model that read it. Optionally, keys, grain and
 * relationships are read twice and kept only where the readings agree.
 */

export interface DocumentSection {
  /** `<heading-slug>:L<a>-L<b>` (lines 1-based). */
  path: string;
  heading: string;
  text: string;
}

/** Splits on Markdown headings (or numbered headings like "2.1 Scope"); a document without them is one section per blank-line block. */
export function splitSections(content: string): DocumentSection[] {
  const lines = content.split(/\r?\n/);
  const isHeading = (l: string) => /^#{1,6}\s+\S/.test(l) || /^\d+(\.\d+)*\.?\s+[A-Z]/.test(l);
  const starts: number[] = [];
  lines.forEach((l, i) => { if (isHeading(l)) starts.push(i); });
  const sections: DocumentSection[] = [];
  const push = (from: number, last: number, heading: string) => {
    let to = last;
    while (to > from && !lines[to].trim()) to--; // a range ends at its last non-blank line
    const body = lines.slice(from, to + 1).join('\n').trim();
    if (!body) return;
    sections.push({ path: `${slugifyId(heading) || 'section'}:L${from + 1}-L${to + 1}`, heading, text: body });
  };
  if (starts.length === 0) {
    let from = -1;
    lines.forEach((l, i) => {
      if (l.trim() && from < 0) from = i;
      if ((!l.trim() || i === lines.length - 1) && from >= 0) { push(from, l.trim() ? i : i - 1, `para ${sections.length + 1}`); from = -1; }
    });
    return sections;
  }
  if (starts[0] > 0) push(0, starts[0] - 1, 'preamble');
  starts.forEach((s, k) => push(s, (starts[k + 1] ?? lines.length) - 1, lines[s].replace(/^#+\s*/, '').trim()));
  return sections;
}

const EXTRACTABLE: AssertionKind[] = ['business_term', 'metric', 'business_rule', 'decision', 'assumption', 'constraint', 'key', 'grain', 'relationship', 'quality_expectation'];

export function buildDocumentExtractionPrompt(doc: Pick<PackDocument, 'path' | 'role'>, sections: readonly DocumentSection[]): { system: string; user: string } {
  return {
    system: [
      'You extract individual facts from a customer\'s business document for a data engineering project. You propose; an engineer confirms.',
      'Respond with one JSON object only: { "facts": [ { "section": "<section id, exactly as given>", "kind": "<kind>", "subject": ["<table, table.column or term name>"], "predicate": "<short verb>", "value": <kind-specific>, "statement": "<one sentence, in the document\'s own terms>", "quote": "<the words in the section that state it, copied exactly>" } ], "sections": [ { "section": "<section id>", "facts": <how many facts you took from it; 0 when it states nothing factual> } ] }',
      `Kinds: ${EXTRACTABLE.join(', ')}. Values: key/grain → ["col", ...]; business_term → { "term": "...", "definition": "..." }; metric → { "name": "...", "definition": "..." } or with "expression"; business_rule → { "text": "...", "level": "STRICT" | "RECOMMENDED" }; relationship → { "from": { "entity": "...", "columns": [...] }, "to": { ... } }; quality_expectation → { "check": "not_null" | "unique" | "accepted_values" | "freshness", "values": [...] }; decision, assumption, constraint → { "text": "..." }.`,
      'Only facts the document states. One fact per clause. Never invent tables or columns; when the document names a business concept rather than a table, use its name as the subject.',
      'Every fact quotes its section word for word: a fact whose quote is not in its section is dropped. Report on every section in "sections", including those with nothing factual: a section you leave out is read again.'
    ].join('\n'),
    user: `## Document: ${doc.path} (role: ${doc.role})\n\n${sections.map((s) => `### [${s.path}] ${s.heading}\n${s.text}`).join('\n\n')}\n\nExtract the facts now.`
  };
}

export interface ExtractionOutcome {
  proposed: NewAssertion[];
  dropped: string[];
  /** Facts whose quote isn't in their section (also listed in `dropped`). */
  unsupported?: number;
  /** Sections the model neither reported on nor took a fact from: read them again. */
  reread?: string[];
}

/** For comparing a quote with its section: case, whitespace, emphasis, quote marks and dashes don't count. */
export function normalizeQuote(text: string): string {
  return text.toLowerCase()
    .replace(/[‘’‛`]/g, '\'').replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[*_]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Validates the model's facts: unknown sections, unsupported quotes and
 * invalid values are dropped (and reported); subjects are resolved
 * deterministically — an unresolved one is kept as given and flagged
 * `unresolved_subject`. Sections the answer doesn't account for are listed in
 * `reread`.
 */
export function parseDocumentExtraction(raw: unknown, doc: Pick<PackDocument, 'id' | 'path'>, sections: readonly DocumentSection[], sha: string, resolve: (ref: string) => string | undefined, options: { model?: string } = {}): ExtractionOutcome {
  const out: ExtractionOutcome = { proposed: [], dropped: [], unsupported: 0, reread: [] };
  const obj = raw && typeof raw === 'object' ? raw as { facts?: unknown; sections?: unknown } : undefined;
  const facts = Array.isArray(obj?.facts) ? obj!.facts as unknown[] : [];
  const reports = Array.isArray(obj?.sections) ? obj!.sections as unknown[] : [];
  const bySection = new Map(sections.map((s) => [s.path, s] as const));
  const accounted = new Set<string>(reports.map((r) => String(((r ?? {}) as { section?: unknown }).section ?? '')));
  for (const f of facts) {
    const x = (f ?? {}) as Record<string, unknown>;
    const section = bySection.get(String(x.section ?? ''));
    if (!section) { out.dropped.push(`unknown section "${String(x.section)}"`); continue; }
    accounted.add(section.path);
    const quote = String(x.quote ?? '').trim();
    if (!quote || !normalizeQuote(section.text).includes(normalizeQuote(quote))) {
      out.unsupported = (out.unsupported ?? 0) + 1;
      out.dropped.push(`unsupported in ${section.path}: ${quote ? 'its quote is not in the section' : 'no quote'} ("${String(x.statement ?? '').slice(0, 60)}")`);
      continue;
    }
    const kind = String(x.kind ?? '') as AssertionKind;
    if (!EXTRACTABLE.includes(kind)) { out.dropped.push(`kind "${kind}" is not extractable`); continue; }
    const refs = (Array.isArray(x.subject) ? x.subject : [x.subject]).map((s) => String(s ?? '').trim()).filter(Boolean);
    const subject = refs.map((r) => resolve(r) ?? r);
    const unresolved = refs.filter((r) => !resolve(r));
    const statement = String(x.statement ?? '').trim();
    const candidate: NewAssertion = {
      kind, subject, predicate: String(x.predicate ?? kind).trim() || kind, value: x.value ?? {}, statement,
      evidence: [{ type: 'file', ref: clauseRef(doc.path, section.path, sha), excerpt: quote.slice(0, 300) }],
      trust: 'inferred', status: 'proposed', createdBy: `extractor:${doc.id}`,
      ...(options.model ? { model: options.model } : {}),
      ...(unresolved.length ? { flags: ['unresolved_subject'] } : {})
    };
    const errors = validateAssertion(candidate);
    if (errors.length) { out.dropped.push(`${kind} in ${section.path}: ${errors.join('; ')}`); continue; }
    out.proposed.push(candidate);
  }
  // A model that answered at all accounts for every section; one it skipped is read again.
  if (obj) out.reread = sections.map((s) => s.path).filter((p) => !accounted.has(p));
  return out;
}

/** Facts that change joins, keys or grain: with double extraction they need two agreeing readings. */
export const HIGH_STAKES_KINDS: readonly AssertionKind[] = ['key', 'grain', 'relationship'];

/** Kind, subject and value, case-insensitive for names: what two sources must share to state the same fact. */
export function factKey(a: Pick<NewAssertion, 'kind' | 'subject' | 'predicate' | 'value'>): string {
  return canonicalJson([a.kind, a.subject.map((s) => s.toLowerCase()), a.predicate, Array.isArray(a.value) ? a.value.map((v) => String(v).toLowerCase()) : a.value]);
}

/**
 * Double extraction (§5.5 item 5, optional): high-stakes facts from the
 * first reading are kept only where the second reading has the same fact;
 * the rest of the first reading is kept as is.
 */
export function agreeingReadings(first: ExtractionOutcome, second: ExtractionOutcome): ExtractionOutcome {
  const seconds = new Set(second.proposed.map(factKey));
  const kept: NewAssertion[] = [];
  const dropped = [...first.dropped];
  for (const p of first.proposed) {
    if (HIGH_STAKES_KINDS.includes(p.kind) && !seconds.has(factKey(p))) { dropped.push(`${p.kind} "${p.statement.slice(0, 60)}": the second reading did not agree`); continue; }
    kept.push(p);
  }
  return { ...first, proposed: kept, dropped };
}

// ── Deterministic first ─────────────────────────────────────────────────────

const HEADER_NAME = /^(column|column name|field|field name|attribute|name)$/i;
const YES = /^(y|yes|true|x|✓|pk|primary key|primary|key|required|mandatory|not null|unique)$/i;
const NO = /^(n|no|false)$/i;

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim().replace(/^`|`$/g, ''));
}

const tableName = (heading: string) => heading.replace(/^(table|entity)\s*[:-]?\s*/i, '').replace(/[`*]/g, '').trim();

/**
 * Facts a document states in a fixed form, read without a model: Markdown
 * tables with a column-name header (a data dictionary: description, key,
 * unique, required or nullable), and sentences with fixed phrases about a
 * column the estate knows ("<table.column> must be unique", "<column> is
 * never null", "<column> is required", "<table> has one row per
 * <columns>"). A bare column name counts under a heading that names its
 * table. Recorded `documented` / `proposed`, citing the section, with the
 * line as their quote; only subjects the estate resolves are kept.
 */
export function parseDocumentDeterministic(doc: Pick<PackDocument, 'id' | 'path'>, sections: readonly DocumentSection[], sha: string, resolve: (ref: string) => string | undefined): NewAssertion[] {
  const out: NewAssertion[] = [];
  const base = (section: DocumentSection, quote: string) => ({
    evidence: [{ type: 'file' as const, ref: clauseRef(doc.path, section.path, sha), excerpt: quote.slice(0, 300) }],
    trust: 'documented' as const, status: 'proposed' as const, createdBy: `parser:${doc.id}`
  });
  const column = (table: string | undefined, name: string) => (name.includes('.') ? resolve(name) : undefined) ?? (table ? resolve(`${table}.${name}`) : undefined);
  for (const section of sections) {
    const lines = section.text.split(/\r?\n/);
    const heading = tableName(section.heading);
    const headingTable = resolve(heading) ? heading : undefined;
    // Tables.
    for (let i = 0; i + 1 < lines.length; i++) {
      if (!/^\s*\|.*\|\s*$/.test(lines[i]) || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) continue;
      const header = cells(lines[i]).map((h) => h.toLowerCase());
      const nameAt = header.findIndex((h) => HEADER_NAME.test(h));
      if (nameAt < 0) continue;
      const at = (re: RegExp) => header.findIndex((h) => re.test(h));
      const tableAt = at(/^(table|entity|object)$/);
      const descAt = at(/^(description|definition|meaning|business meaning)$/);
      const keyAt = at(/^(pk|key|primary key)$/);
      const uniqueAt = at(/^unique$/);
      const requiredAt = at(/^(required|mandatory|not null)$/);
      const nullableAt = at(/^(nullable|null|nulls allowed)$/);
      for (let j = i + 2; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
        const row = cells(lines[j]);
        const table = tableAt >= 0 ? row[tableAt] : headingTable;
        const name = row[nameAt];
        const col = name ? column(table, name) : undefined;
        if (!col || !name) continue;
        const tableId = table ? resolve(table) : undefined;
        const b = base(section, lines[j].trim());
        if (descAt >= 0 && row[descAt]) out.push({ ...b, kind: 'business_term', subject: [col], predicate: 'defined_as', value: { term: name, definition: row[descAt], boundTo: [col] }, statement: `${table ? `${table}.` : ''}${name}: ${row[descAt]}` });
        if (keyAt >= 0 && YES.test(row[keyAt] ?? '') && tableId) out.push({ ...b, kind: 'key', subject: [tableId], predicate: 'primary', value: [name], statement: `${name} is the key of ${table}.` });
        if (uniqueAt >= 0 && YES.test(row[uniqueAt] ?? '')) out.push({ ...b, kind: 'quality_expectation', subject: [col], predicate: 'expects', value: { check: 'unique' }, statement: `${name} is unique.` });
        if ((requiredAt >= 0 && YES.test(row[requiredAt] ?? '')) || (nullableAt >= 0 && NO.test(row[nullableAt] ?? ''))) out.push({ ...b, kind: 'quality_expectation', subject: [col], predicate: 'expects', value: { check: 'not_null' }, statement: `${name} is never null.` });
      }
    }
    // Phrases (outside tables).
    const prose = lines.filter((l) => !/^\s*\|/.test(l)).join('\n');
    for (const sentence of prose.split(/(?<=[.;!?])\s+|\n+/)) {
      const text = sentence.replace(/[`*]/g, '').trim();
      if (!text) continue;
      const unique = /\b([A-Za-z_][\w.]*)\s+(?:must be|is|are|should be)\s+(?:always\s+)?unique\b/i.exec(text);
      const notNull = /\b([A-Za-z_][\w.]*)\s+(?:must never be|is never|must not be|cannot be|can never be|should never be)\s+(?:null|empty|blank)\b/i.exec(text)
        ?? /\b([A-Za-z_][\w.]*)\s+(?:is|are)\s+(?:required|mandatory)\b/i.exec(text);
      const grain = /\b([A-Za-z_][\w.]*)\s+(?:has|holds|contains|is)\s+one row per\s+([A-Za-z_]\w*(?:\s*(?:,|and)\s*[A-Za-z_]\w*)*)/i.exec(text);
      const u = unique ? column(headingTable, unique[1]) : undefined;
      if (u) out.push({ ...base(section, text), kind: 'quality_expectation', subject: [u], predicate: 'expects', value: { check: 'unique' }, statement: text });
      const nn = notNull ? column(headingTable, notNull[1]) : undefined;
      if (nn) out.push({ ...base(section, text), kind: 'quality_expectation', subject: [nn], predicate: 'expects', value: { check: 'not_null' }, statement: text });
      if (grain) {
        const table = resolve(grain[1]);
        const cols = grain[2].split(/\s*(?:,|\band\b)\s*/).map((c) => c.trim()).filter(Boolean);
        if (table && cols.length && cols.every((c) => resolve(`${grain[1]}.${c}`))) out.push({ ...base(section, text), kind: 'grain', subject: [table], predicate: 'grain', value: cols, statement: text });
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((a) => { const k = factKey(a); if (seen.has(k)) return false; seen.add(k); return validateAssertion(a).length === 0; });
}

// ── Recording ───────────────────────────────────────────────────────────────

/** The document (or chat, or probe) a fact's first evidence comes from, without section or version. */
const sourceOf = (evidence: readonly { ref: string }[]) => (evidence[0]?.ref ?? '').split('#')[0].split('@')[0];

/**
 * Records proposals, skipping one equal (kind, subject, predicate, value) to
 * a live or proposed fact — unless it comes from another source: then it
 * corroborates the fact held, whose evidence it joins (§5.5 item 3,
 * agreement). A different value for the same thing is left to conflict
 * detection (§8.1). `admit` applies the problem's mode.
 */
export async function recordWithAgreement(ledger: AssertionLedger, proposals: readonly NewAssertion[], options: { admit?: (a: NewAssertion) => NewAssertion } = {}): Promise<{ recorded: number; corroborated: number }> {
  const held = new Map<string, Assertion>();
  for (const a of ledger.assertions()) if (isLive(a.status) || a.status === 'proposed') held.set(factKey(a), a);
  const events: LedgerEvent[] = [];
  const fresh = new Set<string>();
  let recorded = 0;
  let corroborated = 0;
  for (const p of proposals) {
    const k = factKey(p);
    const existing = held.get(k);
    if (existing) {
      const src = sourceOf(p.evidence);
      const sources = new Set(existing.evidence.map((e) => sourceOf([e])));
      if (src && !sources.has(src)) {
        events.push(ledger.buildEvent('corroborated', existing.id, p.createdBy ?? 'system', { evidence: p.evidence }));
        existing.evidence = [...existing.evidence, ...p.evidence];
        corroborated++;
      }
      continue;
    }
    if (fresh.has(k)) continue;
    fresh.add(k);
    events.push(ledger.buildAsserted(options.admit ? options.admit(p) : p));
    recorded++;
  }
  await ledger.append(events);
  return { recorded, corroborated };
}

/**
 * Records proposals; one equal (kind, subject, predicate, value) to a live or
 * proposed assertion is skipped (or corroborates it, from another source), so
 * re-extracting a document adds nothing.
 */
export async function recordExtraction(ledger: AssertionLedger, outcome: ExtractionOutcome, options: { admit?: (a: NewAssertion) => NewAssertion } = {}): Promise<number> {
  return (await recordWithAgreement(ledger, outcome.proposed, options)).recorded;
}
