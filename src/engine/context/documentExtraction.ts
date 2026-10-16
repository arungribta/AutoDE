import { AssertionKind, canonicalJson, isLive } from './assertions';
import { validateAssertion } from './assertionSchemas';
import { AssertionLedger, NewAssertion } from './ledger';
import { PackDocument, clauseRef } from './pack';
import { slugifyId } from './estate';

/**
 * Free-text extraction (Phase C4a, item 3): BRDs, notes and other
 * unstructured documents, per fact, through one governed prompt. Every fact
 * lands `proposed` / `inferred` with section-level provenance
 * (`<file>#<section>:L<a>-L<b>@<sha>`) and waits for the engineer — the LLM
 * proposes; it never decides (principle C3).
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
      'Respond with one JSON object only: { "facts": [ { "section": "<section id, exactly as given>", "kind": "<kind>", "subject": ["<table, table.column or term name>"], "predicate": "<short verb>", "value": <kind-specific>, "statement": "<one sentence, in the document\'s own terms>" } ] }',
      `Kinds: ${EXTRACTABLE.join(', ')}. Values: key/grain → ["col", ...]; business_term → { "term": "...", "definition": "..." }; metric → { "name": "...", "definition": "..." } or with "expression"; business_rule → { "text": "...", "level": "STRICT" | "RECOMMENDED" }; relationship → { "from": { "entity": "...", "columns": [...] }, "to": { ... } }; quality_expectation → { "check": "not_null" | "unique" | "accepted_values" | "freshness", "values": [...] }; decision, assumption, constraint → { "text": "..." }.`,
      'Only facts the document states. One fact per clause. Never invent tables or columns; when the document names a business concept rather than a table, use its name as the subject.'
    ].join('\n'),
    user: `## Document: ${doc.path} (role: ${doc.role})\n\n${sections.map((s) => `### [${s.path}] ${s.heading}\n${s.text}`).join('\n\n')}\n\nExtract the facts now.`
  };
}

export interface ExtractionOutcome {
  proposed: NewAssertion[];
  dropped: string[];
}

/**
 * Validates the model's facts: unknown sections and invalid values are
 * dropped (and reported); subjects are resolved deterministically — an
 * unresolved one is kept as given and flagged `unresolved_subject`.
 */
export function parseDocumentExtraction(raw: unknown, doc: Pick<PackDocument, 'id' | 'path'>, sections: readonly DocumentSection[], sha: string, resolve: (ref: string) => string | undefined): ExtractionOutcome {
  const out: ExtractionOutcome = { proposed: [], dropped: [] };
  const facts = raw && typeof raw === 'object' && Array.isArray((raw as { facts?: unknown }).facts) ? (raw as { facts: unknown[] }).facts : [];
  const bySection = new Map(sections.map((s) => [s.path, s] as const));
  for (const f of facts) {
    const x = (f ?? {}) as Record<string, unknown>;
    const section = bySection.get(String(x.section ?? ''));
    if (!section) { out.dropped.push(`unknown section "${String(x.section)}"`); continue; }
    const kind = String(x.kind ?? '') as AssertionKind;
    if (!EXTRACTABLE.includes(kind)) { out.dropped.push(`kind "${kind}" is not extractable`); continue; }
    const refs = (Array.isArray(x.subject) ? x.subject : [x.subject]).map((s) => String(s ?? '').trim()).filter(Boolean);
    const subject = refs.map((r) => resolve(r) ?? r);
    const unresolved = refs.filter((r) => !resolve(r));
    const statement = String(x.statement ?? '').trim();
    const candidate: NewAssertion = {
      kind, subject, predicate: String(x.predicate ?? kind).trim() || kind, value: x.value ?? {}, statement,
      evidence: [{ type: 'file', ref: clauseRef(doc.path, section.path, sha), excerpt: statement.slice(0, 300) }],
      trust: 'inferred', status: 'proposed', createdBy: `extractor:${doc.id}`,
      ...(unresolved.length ? { flags: ['unresolved_subject'] } : {})
    };
    const errors = validateAssertion(candidate);
    if (errors.length) { out.dropped.push(`${kind} in ${section.path}: ${errors.join('; ')}`); continue; }
    out.proposed.push(candidate);
  }
  return out;
}

/**
 * Records proposals; one equal (kind, subject, predicate, value) to a live or
 * proposed assertion is skipped, so re-extracting a document adds nothing.
 */
export async function recordExtraction(ledger: AssertionLedger, outcome: ExtractionOutcome): Promise<number> {
  const key = (a: Pick<NewAssertion, 'kind' | 'subject' | 'predicate' | 'value'>) => canonicalJson([a.kind, a.subject, a.predicate, a.value]);
  const known = new Set(ledger.assertions().filter((a) => isLive(a.status) || a.status === 'proposed').map(key));
  const fresh = outcome.proposed.filter((p) => !known.has(key(p)));
  await ledger.append(fresh.map((p) => ledger.buildAsserted(p)));
  return fresh.length;
}
