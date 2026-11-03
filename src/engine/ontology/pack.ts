import { createHash } from 'node:crypto';
import { parseYaml, stringifyYaml } from '../context/Yaml';

/**
 * Ontology packs (ONT1; docs/specs/context-layer.md §6.8): the context layer's meaning, light by design.
 * Classes, subclasses, relations with cardinality hints and attributes, in plain YAML
 * (`autode: ontology-pack/1`): deterministic and diffable. No OWL axioms and no reasoner.
 *
 * Three layers: the **upper layer** (eight concepts, shipped, always in effect), **industry packs** (a curated,
 * problem-relevant subset of a standard such as FIBO, each concept with its source IRI) and **extensions**
 * (`ext:`, the team's own concepts, optionally broader than a standard one). Every concept chains to an upper
 * concept, which gives estates that span industries a common meeting point.
 */

export const PACK_FORMAT = 'ontology-pack/1';
export const UPPER_PACK = 'upper';
export const UPPER_CONCEPTS = ['Party', 'Agreement', 'Product', 'Account', 'Transaction', 'Location', 'Event', 'Document'] as const;

/** SKOS mapping relations, as a term's `means` link names them: skos:exactMatch, broadMatch, narrowMatch, relatedMatch. */
export type MatchType = 'exact' | 'broader' | 'narrower' | 'related';
export const MATCH_TYPES: readonly MatchType[] = ['exact', 'broader', 'narrower', 'related'];

/** Whether a pack may leave the team's workspace: decided by its standard's licence. */
export type Redistribution = 'allowed' | 'forbidden' | 'unknown';

export interface PackLicence { name: string; spdx?: string; redistribution: Redistribution; note?: string }

export interface ConceptRelation { verb: string; target: string; cardinality?: string }

export interface Concept {
  /** `<prefix>:<LocalName>`, e.g. `fibo:Loan`, `upper:Party`, `ext:CreditFacility`. */
  id: string;
  label: string;
  definition?: string;
  /** The standard's IRI for it; an extension has none. */
  iri?: string;
  /** Its parent: an upper concept or another pack's concept. Absent only in the upper layer. */
  parent?: string;
  /** An extension's nearest standard concept, when it is narrower than one (skos:broadMatch). */
  broader?: string;
  synonyms?: string[];
  relations?: ConceptRelation[];
  attributes?: { identifying?: string[]; notable?: string[] };
  /** Typical classifications and quality rules, offered as candidates at documented trust (ONT2); never applied silently. */
  hints?: { classifications?: string[]; quality?: Array<{ check: string; attribute?: string; note?: string }> };
  /** The standard's module (FIBO: `LOAN/LoansGeneral/Loans`). */
  module?: string;
  status?: 'active' | 'deprecated';
}

export interface OntologyPack {
  autode: typeof PACK_FORMAT;
  id: string;
  title: string;
  /** Concept ids of this pack start with it. */
  prefix: string;
  description?: string;
  /** The standard it is derived from, pinned. Absent for an extension pack. */
  standard?: { name: string; version: string; iri?: string; licence: PackLicence };
  /** `workspace`: the licence forbids (or doesn't say it allows) redistribution, so it never leaves the team's workspace. */
  distribution: 'shareable' | 'workspace';
  /** Where it was onboarded from (nothing is downloaded automatically, P6). */
  source?: { kind: 'shipped' | 'file' | 'git'; ref: string; commit?: string; checksum?: string };
  concepts: Concept[];
  /** Set by a person's approval (decision kind `ontology`); the revision it approved. */
  approved?: { by: string; at: string; revision: string; decision?: string };
}

const ID = /^[a-z][a-z0-9]*:[A-Za-z][A-Za-z0-9_]*$/;
const PACK_ID = /^[a-z0-9][a-z0-9-]*$/;

export const conceptPrefix = (id: string) => id.slice(0, id.indexOf(':'));
export const isUpper = (id: string) => conceptPrefix(id) === UPPER_PACK;
export const conceptNodeId = (conceptId: string) => `concept:${conceptId}`;
export const conceptOfNode = (nodeId: string) => (nodeId.startsWith('concept:') ? nodeId.slice('concept:'.length) : undefined);

/** A local name from a label: `loan contract` → `LoanContract`. */
export function localName(label: string): string {
  const s = label.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(s) ? s : `C${s}`;
}

/** The content a person approves: everything but the approval itself, canonical. */
export function packRevision(p: Omit<OntologyPack, 'approved'> & { approved?: unknown }): string {
  const rest: Record<string, unknown> = { ...p };
  delete rest.approved;
  return createHash('sha256').update(JSON.stringify(canonical(rest))).digest('hex').slice(0, 16);
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

/** The pack in a fixed order (concepts by id, lists sorted where order carries no meaning), so the same content is the same text. */
export function normalizePack(p: OntologyPack): OntologyPack {
  const uniq = (xs?: string[]) => (xs?.length ? [...new Set(xs.map((x) => x.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)) : undefined);
  const concepts = [...p.concepts].sort((a, b) => a.id.localeCompare(b.id)).map((c) => {
    const relations = c.relations?.length ? [...c.relations].sort((a, b) => a.verb.localeCompare(b.verb) || a.target.localeCompare(b.target)).map((r) => ({ verb: r.verb, target: r.target, ...(r.cardinality ? { cardinality: r.cardinality } : {}) })) : undefined;
    const identifying = uniq(c.attributes?.identifying); const notable = uniq(c.attributes?.notable);
    const classifications = uniq(c.hints?.classifications);
    const quality = c.hints?.quality?.length ? [...c.hints.quality].sort((a, b) => `${a.check}|${a.attribute ?? ''}`.localeCompare(`${b.check}|${b.attribute ?? ''}`)) : undefined;
    const out: Concept = {
      id: c.id, label: c.label.trim(),
      ...(c.definition?.trim() ? { definition: c.definition.trim().replace(/\s+/g, ' ') } : {}),
      ...(c.iri ? { iri: c.iri } : {}), ...(c.parent ? { parent: c.parent } : {}), ...(c.broader ? { broader: c.broader } : {}),
      ...(uniq(c.synonyms) ? { synonyms: uniq(c.synonyms) } : {}),
      ...(relations ? { relations } : {}),
      ...(identifying || notable ? { attributes: { ...(identifying ? { identifying } : {}), ...(notable ? { notable } : {}) } } : {}),
      ...(classifications || quality ? { hints: { ...(classifications ? { classifications } : {}), ...(quality ? { quality } : {}) } } : {}),
      ...(c.module ? { module: c.module } : {}),
      ...(c.status === 'deprecated' ? { status: 'deprecated' as const } : {})
    };
    return out;
  });
  return {
    autode: PACK_FORMAT, id: p.id, title: p.title, prefix: p.prefix,
    ...(p.description ? { description: p.description } : {}),
    ...(p.standard ? { standard: p.standard } : {}),
    distribution: p.distribution,
    ...(p.source ? { source: p.source } : {}),
    concepts,
    ...(p.approved ? { approved: p.approved } : {})
  };
}

export function stringifyPack(p: OntologyPack): string {
  return `# AutoDE ontology pack (${PACK_FORMAT}; docs/specs/context-layer.md §6.8).\n${stringifyYaml(normalizePack(p))}`;
}

export interface ParsedPack { pack?: OntologyPack; errors: string[] }

/** Parses a pack's text; the checks that need other packs (parents, relation targets) are in `checkPacks`. */
export function parsePack(text: string): ParsedPack {
  let raw: unknown;
  try { raw = parseYaml(text); } catch (err) { return { errors: [`not YAML: ${err instanceof Error ? err.message : String(err)}`] }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['a pack is a mapping (autode, id, title, prefix, concepts)'] };
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (r.autode !== PACK_FORMAT) errors.push(`autode must be ${PACK_FORMAT}`);
  const id = typeof r.id === 'string' ? r.id : '';
  if (!PACK_ID.test(id)) errors.push('id is a slug: lower-case letters, digits and dashes');
  const prefix = typeof r.prefix === 'string' ? r.prefix : '';
  if (!/^[a-z][a-z0-9]*$/.test(prefix)) errors.push('prefix is lower-case letters and digits (concept ids start with it)');
  if (typeof r.title !== 'string' || !r.title.trim()) errors.push('title is required');
  if (!Array.isArray(r.concepts)) errors.push('concepts is a list');
  const distribution = r.distribution === 'workspace' ? 'workspace' : r.distribution === 'shareable' ? 'shareable' : undefined;
  if (!distribution) errors.push('distribution is shareable or workspace');
  const std = r.standard as OntologyPack['standard'] | undefined;
  if (std && (typeof std.name !== 'string' || typeof std.version !== 'string' || !std.licence || !['allowed', 'forbidden', 'unknown'].includes(String(std.licence.redistribution)))) errors.push('standard needs name, version (pinned) and licence { name, redistribution: allowed | forbidden | unknown }');
  if (std && std.licence?.redistribution !== 'allowed' && distribution === 'shareable') errors.push(`the standard's licence doesn't allow redistribution (${std.licence?.redistribution}): distribution must be workspace`);
  const concepts: Concept[] = [];
  const seen = new Set<string>();
  for (const [i, c] of (Array.isArray(r.concepts) ? r.concepts : []).entries()) {
    const at = `concepts[${i}]`;
    if (!c || typeof c !== 'object') { errors.push(`${at} is a mapping`); continue; }
    const k = c as Concept;
    if (typeof k.id !== 'string' || !ID.test(k.id)) { errors.push(`${at}.id is <prefix>:<Name> (got ${JSON.stringify(k.id)})`); continue; }
    if (conceptPrefix(k.id) !== prefix && conceptPrefix(k.id) !== 'ext') errors.push(`${k.id}: a concept of this pack starts with ${prefix}: (or ext: for an extension)`);
    if (seen.has(k.id)) errors.push(`${k.id} appears twice`);
    seen.add(k.id);
    if (typeof k.label !== 'string' || !k.label.trim()) errors.push(`${k.id}: label is required`);
    if (k.parent !== undefined && (typeof k.parent !== 'string' || !ID.test(k.parent))) errors.push(`${k.id}: parent is a concept id`);
    if (k.broader !== undefined && (typeof k.broader !== 'string' || !ID.test(k.broader))) errors.push(`${k.id}: broader is a concept id`);
    for (const rel of Array.isArray(k.relations) ? k.relations : []) if (!rel || typeof rel.verb !== 'string' || typeof rel.target !== 'string' || !ID.test(rel.target)) errors.push(`${k.id}: each relation has a verb and a target concept id`);
    concepts.push(k);
  }
  if (errors.length) return { errors };
  return { pack: normalizePack({ ...(r as unknown as OntologyPack), distribution: distribution!, concepts }), errors: [] };
}

/**
 * Checks packs together: every parent, `broader` and relation target exists, every concept chains to an upper
 * concept, and nothing is its own ancestor. Returns errors per pack id.
 */
export function checkPacks(packs: readonly OntologyPack[]): Map<string, string[]> {
  const byId = new Map<string, Concept>();
  for (const p of packs) for (const c of p.concepts) byId.set(c.id, c);
  const out = new Map<string, string[]>();
  for (const p of packs) {
    const errors: string[] = [];
    for (const c of p.concepts) {
      if (p.id === UPPER_PACK) { if (c.parent) errors.push(`${c.id}: an upper concept has no parent`); continue; }
      if (!c.parent) { errors.push(`${c.id} has no parent: place it under one of the upper concepts (${UPPER_CONCEPTS.map((u) => `upper:${u}`).join(', ')}) or another concept`); continue; }
      if (!byId.has(c.parent)) errors.push(`${c.id}: its parent ${c.parent} isn't in any pack`);
      if (c.broader && !byId.has(c.broader)) errors.push(`${c.id}: broader ${c.broader} isn't in any pack`);
      for (const r of c.relations ?? []) if (!byId.has(r.target)) errors.push(`${c.id}: relation ${r.verb} → ${r.target}, which isn't in any pack`);
      const chain = new Set<string>([c.id]);
      let cur: string | undefined = c.parent;
      while (cur && !isUpper(cur)) {
        if (chain.has(cur)) { errors.push(`${c.id}: its parents loop (${[...chain, cur].join(' → ')})`); break; }
        chain.add(cur);
        cur = byId.get(cur)?.parent;
      }
    }
    if (errors.length) out.set(p.id, errors);
  }
  return out;
}

/** The upper concept a concept sits under (itself for an upper concept). */
export function upperOf(id: string, byId: ReadonlyMap<string, Concept>): string | undefined {
  let cur: string | undefined = id;
  for (let i = 0; cur && i < 50; i++) {
    if (isUpper(cur)) return cur;
    cur = byId.get(cur)?.parent;
  }
  return undefined;
}

/** Its ancestors, nearest first, up to the upper concept. */
export function ancestorsOf(id: string, byId: ReadonlyMap<string, Concept>): string[] {
  const out: string[] = [];
  let cur: string | undefined = byId.get(id)?.parent;
  while (cur && !out.includes(cur) && out.length < 50) { const next: string = cur; out.push(next); cur = byId.get(next)?.parent; }
  return out;
}
