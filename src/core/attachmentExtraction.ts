import { AttachmentExtract, AttachmentExtractEntity, IntakeAttachment } from './types';

/**
 * Structured extraction for spec-discovery attachments (Phase 2B-i). Pure
 * prompt-building + response-parsing only — the LLM call itself lives in
 * AgentHub (`extractAttachmentFacts`), same split as specOpsPrompts.ts /
 * specSynthesis.ts for the Business Problem Specification.
 *
 * Deliberately not a rigid, format-specific parser: an attachment could be a
 * schema DDL dump, a requirements memo, a Word-doc export, or anything else,
 * so extraction asks for "whatever structured facts exist, else summarize"
 * rather than a strict shape that fails on the first unexpected document.
 */

export const ATTACHMENT_EXTRACTION_SYSTEM_PROMPT = [
  'You are a data engineering analyst extracting structured facts from a user-supplied reference document.',
  'The document could be anything — a schema export, a data contract, a requirements memo, or something else entirely.',
  'Respond with a single valid JSON object only — no prose and no markdown fences. Use exactly this shape:',
  '{',
  '  "entities": [ { "name": "...", "columns": [ { "name": "...", "type": "..." } ] } ],',
  '  "businessRules": ["..."],',
  '  "constraints": ["..."],',
  '  "rawSummary": "a plain-text summary of the document, always populated",',
  '  "confidence": "high" | "medium" | "low"',
  '}',
  'Rules:',
  '- Only extract entities/columns/rules you can actually find in the document — never invent structure that is not there.',
  '- "rawSummary" must always be populated, even if nothing else can be extracted.',
  '- Use "confidence": "low" when the document has little or no clearly-structured content; "high" when it clearly describes concrete entities/columns.'
].join('\n');

export function buildAttachmentExtractionPrompt(attachment: IntakeAttachment): { system: string; user: string } {
  return {
    system: ATTACHMENT_EXTRACTION_SYSTEM_PROMPT,
    user: `## Attached document: ${attachment.path}\n\n${attachment.content}\n\nExtract structured facts from this document now.`
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0);
}

function parseEntities(value: unknown): AttachmentExtractEntity[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entities: AttachmentExtractEntity[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const name = str(record.name);
    if (!name) continue;
    const columns: { name: string; type?: string }[] = [];
    if (Array.isArray(record.columns)) {
      for (const c of record.columns) {
        if (!c || typeof c !== 'object') continue;
        const columnName = str((c as Record<string, unknown>).name);
        if (!columnName) continue;
        columns.push({ name: columnName, type: str((c as Record<string, unknown>).type) || undefined });
      }
    }
    entities.push({ name, columns: columns.length > 0 ? columns : undefined });
  }
  return entities.length > 0 ? entities : undefined;
}

const CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);

/** A summary-only fallback — the floor every extraction degrades to, never throws past this. */
export function fallbackAttachmentExtract(attachment: IntakeAttachment): AttachmentExtract {
  return {
    attachmentId: attachment.id,
    extractedAt: new Date().toISOString(),
    rawSummary: attachment.content.slice(0, 500),
    confidence: 'low'
  };
}

/**
 * Parses the LLM's extraction response into an `AttachmentExtract`, degrading
 * gracefully on any malformed/unexpected shape rather than throwing — a weak
 * extraction must never block the discovery flow.
 */
export function parseAttachmentExtract(raw: unknown, attachment: IntakeAttachment): AttachmentExtract {
  const fallback = fallbackAttachmentExtract(attachment);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fallback;
  }
  const record = raw as Record<string, unknown>;
  const rawSummary = str(record.rawSummary) || fallback.rawSummary;
  const confidenceCandidate = str(record.confidence);
  const confidence = (CONFIDENCE_LEVELS.has(confidenceCandidate) ? confidenceCandidate : 'low') as AttachmentExtract['confidence'];
  const businessRules = asStringArray(record.businessRules);
  const constraints = asStringArray(record.constraints);
  const entities = parseEntities(record.entities);
  return {
    attachmentId: attachment.id,
    extractedAt: fallback.extractedAt,
    entities,
    businessRules: businessRules.length > 0 ? businessRules : undefined,
    constraints: constraints.length > 0 ? constraints : undefined,
    rawSummary,
    confidence
  };
}
