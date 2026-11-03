import * as fs from 'node:fs';
import * as path from 'node:path';
import { NewAssertion } from '../context/ledger';
import { Vocabulary, concepts as wordsOf } from '../context/vocabulary';
import { BaseNode, GraphEdge, TableNode } from '../context/types';
import { PortError, SOURCE_CAPS, detectLicence, gitRunner, GitRunner, stageSource } from '../skills/port';
import { SourceAnalysis, SourceConcept, analyzeTriples, classifyLicence } from './convert';
import { Triple, parseRdf, rdfFormat } from './rdf';
import { Concept, MatchType, OntologyPack, PACK_FORMAT, UPPER_CONCEPTS, isUpper, normalizePack, parsePack, stringifyPack } from './pack';
import { Ontology, OntologyScope, loadOntology, readTeamPack, shippedPacks } from './store';
import { MeaningLink } from './links';

/**
 * Onboarding a standard (ONT1; docs/specs/context-layer.md §6.8): the same five steps on every surface — the
 * Knowledge Explorer, `autode ontology` and MCP, where analysis is read-only and the import is a proposal.
 * 1. **Source**: a pack shipped with AutoDE, or a file, folder or Git repository the user supplies (OWL in Turtle
 *    or RDF/XML, SKOS, or a pack). Nothing is downloaded automatically (P6); a Git source is staged with the same
 *    limits and checks as porting a skill (PA4).
 * 2. **Analysis**: concepts, relations, modules, version and licence.
 * 3. **Scope**: seed concepts from the workspace's glossary and estate, one hop out; the person adjusts them.
 * 4. **Placement and terms**: each concept under the upper layer; `means` links proposed for the vocabulary.
 * 5. **Approval**: a workspace-level decision (kind `ontology`); the pack is written to `.autode/knowledge/ontology/`.
 * Deterministic throughout: the same source and the same choices give the same pack.
 */

export type OntologySource =
  | { kind: 'shipped'; id: string }
  | { kind: 'file'; path: string }
  | { kind: 'git'; url: string; ref?: string; path?: string };

export interface ReadSource {
  analysis: SourceAnalysis;
  /** The pack's id and title (from the source; a team pack with the same id grows). */
  id: string;
  title: string;
  standard?: OntologyPack['standard'];
  source: NonNullable<OntologyPack['source']>;
}

const RDF_FILE = /\.(ttl|nt|n3|rdf|owl|xml)$/i;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'standard';

/** The shipped packs a person can onboard from (the upper layer is always in effect). */
export function shippedSources(resourcesRoot?: string): Array<{ id: string; title: string; standard?: string; version?: string; licence?: string; concepts: number; description?: string }> {
  return shippedPacks(resourcesRoot).filter((l) => l.pack && l.pack.id !== 'upper').map((l) => ({ id: l.pack!.id, title: l.pack!.title, ...(l.pack!.standard ? { standard: l.pack!.standard.name, version: l.pack!.standard.version, licence: l.pack!.standard.licence.name } : {}), concepts: l.pack!.concepts.length, ...(l.pack!.description ? { description: l.pack!.description } : {}) }));
}

function fromPack(pack: OntologyPack, source: ReadSource['source']): ReadSource {
  const modules = new Map<string, number>();
  for (const c of pack.concepts) modules.set(c.module ?? '(none)', (modules.get(c.module ?? '(none)') ?? 0) + 1);
  const licence = pack.standard?.licence ?? { name: 'the team\'s own', redistribution: 'allowed' as const };
  return {
    id: pack.id, title: pack.title, ...(pack.standard ? { standard: pack.standard } : {}), source,
    analysis: {
      title: pack.title, ...(pack.standard?.iri ? { iri: pack.standard.iri } : {}), ...(pack.standard?.version ? { version: pack.standard.version } : {}), licence,
      concepts: pack.concepts.map((c) => ({ ...c })), relations: pack.concepts.reduce((n, c) => n + (c.relations?.length ?? 0), 0),
      modules: [...modules.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([module, concepts]) => ({ module, concepts })),
      prefix: pack.prefix, warnings: [], checksum: source.checksum ?? ''
    }
  };
}

/** Files a folder holds that may be RDF (or packs), within the porting caps. */
function rdfFiles(dir: string): string[] {
  const out: string[] = [];
  let bytes = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { walk(p); continue; }
      if (!RDF_FILE.test(e.name) && !/\.ya?ml$/i.test(e.name)) continue;
      const size = fs.statSync(p).size;
      if (size > SOURCE_CAPS.maxFileBytes) throw new PortError(`${path.relative(dir, p)} is ${size} bytes; the most a file may be is ${SOURCE_CAPS.maxFileBytes}.`);
      bytes += size;
      if (out.length + 1 > SOURCE_CAPS.maxFiles || bytes > SOURCE_CAPS.maxBytes) throw new PortError(`The source has more than ${SOURCE_CAPS.maxFiles} files or ${SOURCE_CAPS.maxBytes} bytes: point at the modules you need.`);
      out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Reads files (or one file) into one analysis: a pack as it is, RDF as triples. */
function readFiles(files: string[], root: string, opts: { prefix?: string; licenceText?: string; name: string }): { analysis: SourceAnalysis; pack?: OntologyPack } {
  const texts = files.map((f) => ({ name: path.relative(root, f).split(path.sep).join('/') || path.basename(f), text: fs.readFileSync(f, 'utf8') }));
  const packs = texts.filter((t) => /\.ya?ml$/i.test(t.name) && new RegExp(`autode:\\s*${PACK_FORMAT.replace('/', '\\/')}`).test(t.text));
  if (packs.length === 1 && texts.filter((t) => RDF_FILE.test(t.name)).length === 0) {
    const parsed = parsePack(packs[0].text);
    if (!parsed.pack) throw new PortError(`${packs[0].name}: ${parsed.errors.join('; ')}`);
    return { analysis: fromPack(parsed.pack, { kind: 'file', ref: packs[0].name }).analysis, pack: parsed.pack };
  }
  const triples: Triple[] = [];
  const warnings: string[] = [];
  let read = 0;
  for (const t of texts.filter((x) => RDF_FILE.test(x.name))) {
    const format = rdfFormat(t.name, t.text);
    if (!format) { warnings.push(`${t.name}: not Turtle or RDF/XML; skipped.`); continue; }
    try { triples.push(...parseRdf(t.text, format, `urn:autode:source:${t.name}`).map((x) => ({ ...x, s: prefixBlank(x.s, read), o: x.literal ? x.o : prefixBlank(x.o, read) }))); read++; }
    catch (err) { throw new PortError(`${t.name}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  if (!read) throw new PortError('No ontology found: give a Turtle (.ttl), RDF/XML (.rdf, .owl) or SKOS file, a folder of them, or an AutoDE pack.');
  const analysis = analyzeTriples(triples, { name: opts.name, text: texts.map((t) => `${t.name}\n${t.text}`).join('\n'), ...(opts.prefix ? { prefix: opts.prefix } : {}), ...(opts.licenceText ? { licenceText: opts.licenceText } : {}) });
  analysis.warnings.unshift(...warnings);
  return { analysis };
}

const prefixBlank = (term: string, file: number) => (term.startsWith('_:') ? `_:f${file}${term.slice(2)}` : term);

/** Step 1 and 2: reads a source and analyses it. Read-only. */
export function readSource(scope: OntologyScope, src: OntologySource, opts: { prefix?: string; id?: string; git?: GitRunner } = {}): ReadSource {
  if (src.kind === 'shipped') {
    const l = shippedPacks(scope.resourcesRoot).find((x) => x.pack?.id === src.id);
    if (!l?.pack) throw new PortError(`No shipped pack "${src.id}" (${shippedSources(scope.resourcesRoot).map((s) => s.id).join(', ') || 'none'}).`);
    if (l.pack.id === 'upper') throw new PortError('The upper layer is always in effect; onboard an industry pack or your own standard.');
    return fromPack(l.pack, { kind: 'shipped', ref: l.file, checksum: l.revision });
  }
  if (src.kind === 'file') {
    const full = path.resolve(src.path);
    if (!fs.existsSync(full)) throw new PortError(`No file or folder "${src.path}".`);
    const isDir = fs.statSync(full).isDirectory();
    const files = isDir ? rdfFiles(full) : [full];
    if (!isDir && fs.statSync(full).size > SOURCE_CAPS.maxBytes) throw new PortError(`${src.path} is larger than ${SOURCE_CAPS.maxBytes} bytes.`);
    const licenceText = isDir ? licenceFile(full) : undefined;
    const { analysis, pack } = readFiles(files, isDir ? full : path.dirname(full), { name: path.basename(full), ...(opts.prefix ? { prefix: opts.prefix } : {}), ...(licenceText ? { licenceText } : {}) });
    const source = { kind: 'file' as const, ref: path.basename(full), checksum: analysis.checksum };
    if (pack) return { ...fromPack(pack, source), ...(opts.id ? { id: opts.id } : {}) };
    return { analysis, id: opts.id ?? slug(analysis.title), title: analysis.title, standard: standardOf(analysis), source };
  }
  const staged = stageSource({ kind: 'git', location: src.url, ...(src.ref ? { ref: src.ref } : {}) }, SOURCE_CAPS, opts.git ?? gitRunner);
  try {
    const dir = src.path ? path.join(staged.dir, src.path) : staged.dir;
    if (!path.resolve(dir).startsWith(path.resolve(staged.dir)) || !fs.existsSync(dir)) throw new PortError(`No folder "${src.path}" in the repository.`);
    const files = fs.statSync(dir).isDirectory() ? rdfFiles(dir) : [dir];
    const lic = detectLicence(staged.dir, staged.dir, undefined);
    const { analysis, pack } = readFiles(files, staged.dir, { name: src.url.split('/').pop() ?? 'repository', ...(opts.prefix ? { prefix: opts.prefix } : {}), ...(lic ? { licenceText: lic.spdx ?? lic.name } : {}) });
    const source = { kind: 'git' as const, ref: `${src.url}${src.path ? `#${src.path}` : ''}`, ...(staged.provenance.resolvedCommit ? { commit: staged.provenance.resolvedCommit } : {}), checksum: analysis.checksum };
    if (pack) return { ...fromPack(pack, source), ...(opts.id ? { id: opts.id } : {}) };
    return { analysis, id: opts.id ?? slug(analysis.title), title: analysis.title, standard: standardOf(analysis), source };
  } finally { staged.cleanup(); }
}

function licenceFile(dir: string): string | undefined {
  const f = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING'].map((x) => path.join(dir, x)).find((x) => fs.existsSync(x));
  if (!f) return undefined;
  const lic = detectLicence(dir, dir, undefined);
  const text = fs.readFileSync(f, 'utf8').slice(0, 4000);
  // An explicit prohibition wins over a name the detector recognised.
  return classifyLicence(text).redistribution === 'forbidden' ? text : lic?.spdx ?? lic?.name ?? text;
}

function standardOf(a: SourceAnalysis): OntologyPack['standard'] {
  return { name: a.title, version: a.version ?? 'unversioned', ...(a.iri ? { iri: a.iri } : {}), licence: a.licence };
}

// ── Step 3: scope ──

export interface ScopeSignal { text: string; kind: 'term' | 'table' | 'column' | 'document'; ref: string }
export interface Seed { id: string; label: string; score: number; matchedBy: Array<{ kind: ScopeSignal['kind']; ref: string; text: string }> }

const WEIGHT: Record<ScopeSignal['kind'], number> = { term: 3, table: 2, column: 1, document: 1 };
/** Words that say how a table is stored, not what it holds. */
const STORAGE_WORDS = new Set(['tbl', 'table', 'dim', 'dimension', 'fact', 'fct', 'stg', 'staging', 'raw', 'master', 'mstr', 'header', 'hdr', 'detail', 'dtl', 'source', 'src', 'target', 'tgt', 'vw', 'view', 'history', 'hist', 'snapshot', 'snap', 'current', 'curr', 'archive', 'arch', 'temp', 'tmp', 'bridge', 'xref', 'cross', 'reference', 'link', 'main', 'base', 'core', 'record', 'data', 'info', 'list', 'v', 't']);

/** Words that name an attribute of a thing rather than a kind of it (after the vocabulary's expansions). */
const ATTRIBUTE_WORDS = new Set(['amount', 'date', 'timestamp', 'number', 'identifier', 'rate', 'status', 'code', 'type', 'name', 'count', 'balance', 'value', 'flag', 'indicator', 'percent', 'total', 'description', 'text', 'time', 'year', 'month', 'day', 'period', 'term', 'limit', 'score', 'level', 'category', 'class', 'reference', 'quantity', 'price', 'currency']);

/** The words of each of a concept's names (label and synonyms), as the vocabulary reduces them. */
function phrases(c: Pick<Concept, 'label' | 'synonyms'>, vocab: Vocabulary): string[][] {
  return [c.label, ...(c.synonyms ?? [])].map((p) => wordsOf(p, vocab)).filter((w) => w.length > 0);
}

/** The workspace's words: glossary terms, tables and columns of the working set. */
export function workspaceSignals(graph: { nodes: readonly BaseNode[]; edges: readonly GraphEdge[] }): ScopeSignal[] {
  const out: ScopeSignal[] = [];
  for (const n of graph.nodes) {
    if (n.type === 'business_term') out.push({ text: n.label, kind: 'term', ref: n.id });
    else if (n.type === 'table') out.push({ text: n.label, kind: 'table', ref: n.id });
    else if (n.type === 'column') out.push({ text: n.label, kind: 'column', ref: n.id });
  }
  return out;
}

/** Concepts the signals name: for each signal, the concepts whose most specific name it contains. */
export function seedConcepts(concepts: readonly SourceConcept[], signals: readonly ScopeSignal[], vocab: Vocabulary): Seed[] {
  const named = concepts.filter((c) => c.status !== 'deprecated').map((c) => ({ c, phrases: phrases(c, vocab) }));
  const seeds = new Map<string, Seed>();
  for (const s of signals) {
    const words = wordsOf(s.text, vocab).filter((w) => s.kind === 'term' || !STORAGE_WORDS.has(w));
    if (!words.length) continue;
    const have = new Set(words);
    let best = 0;
    let hits: SourceConcept[] = [];
    for (const { c, phrases: ps } of named) {
      const len = Math.max(0, ...ps.filter((p) => p.every((w) => have.has(w))).map((p) => p.length));
      if (!len) continue;
      if (len > best) { best = len; hits = [c]; } else if (len === best) hits.push(c);
    }
    for (const c of hits) {
      const seed = seeds.get(c.id) ?? { id: c.id, label: c.label, score: 0, matchedBy: [] };
      seed.score += WEIGHT[s.kind];
      if (seed.matchedBy.length < 8) seed.matchedBy.push({ kind: s.kind, ref: s.ref, text: s.text });
      seeds.set(c.id, seed);
    }
  }
  return [...seeds.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export interface ScopeResult {
  seeds: Seed[];
  /** One hop out from the seeds: their parents and the concepts their relations reach. */
  neighbours: Array<{ id: string; label: string; via: string }>;
  /** The ancestors every chosen concept needs to reach the upper layer. */
  required: string[];
  /** Seeds and neighbours: the proposed selection, for the person to adjust. */
  selected: string[];
}

export function proposeScope(analysis: SourceAnalysis, seeds: readonly Seed[], adjust: { add?: string[]; remove?: string[] } = {}): ScopeResult {
  const byId = new Map(analysis.concepts.map((c) => [c.id, c] as const));
  const neighbours = new Map<string, { id: string; label: string; via: string }>();
  const seedIds = new Set(seeds.map((s) => s.id));
  for (const s of seeds) {
    const c = byId.get(s.id);
    if (!c) continue;
    const around = [...(c.parent && byId.has(c.parent) ? [[c.parent, `parent of ${c.id}`]] : []), ...(c.relations ?? []).filter((r) => byId.has(r.target)).map((r) => [r.target, `${c.id} ${r.verb}`])] as Array<[string, string]>;
    for (const [id, via] of around) if (!seedIds.has(id) && !neighbours.has(id)) neighbours.set(id, { id, label: byId.get(id)!.label, via });
  }
  const remove = new Set(adjust.remove ?? []);
  const unknown = (adjust.add ?? []).filter((id) => !byId.has(id));
  if (unknown.length) throw new PortError(`Not in the source: ${unknown.join(', ')}.`);
  const chosen = new Set([...seedIds, ...neighbours.keys(), ...(adjust.add ?? [])].filter((id) => !remove.has(id)));
  const required = new Set<string>();
  for (const id of chosen) for (let cur = byId.get(id)?.parent; cur && byId.has(cur) && !chosen.has(cur) && !required.has(cur); cur = byId.get(cur)?.parent) required.add(cur);
  return { seeds: [...seeds], neighbours: [...neighbours.values()].sort((a, b) => a.id.localeCompare(b.id)), required: [...required].sort(), selected: [...chosen].sort() };
}

// ── Step 4: placement, and the pack ──

export interface PlacementRow { id: string; label: string; parent?: string; suggested?: string; placed: boolean }

/** Where each chosen concept the source leaves without a parent goes (overrides win; the rest are suggestions). */
export function placementOf(read: ReadSource, ids: readonly string[], overrides: Record<string, string> = {}): PlacementRow[] {
  const byId = new Map(read.analysis.concepts.map((c) => [c.id, c] as const));
  return ids.map((id) => byId.get(id)!).filter((c) => !!c && !(c.parent && byId.has(c.parent))).map((c) => {
    const parent = overrides[c.id] ?? (c.parent && isUpper(c.parent) ? c.parent : undefined) ?? c.suggestedPlacement;
    return { id: c.id, label: c.label, ...(parent ? { parent } : {}), ...(c.suggestedPlacement ? { suggested: c.suggestedPlacement } : {}), placed: !!parent };
  });
}

export interface BuiltPack { pack: OntologyPack; text: string; added: string[]; kept: string[]; problems: string[] }

/**
 * The pack from a source and a person's choices: the chosen concepts (with the ancestors they need), placed;
 * relations to concepts outside the pack and the ontology in effect are left out. A team pack with the same id
 * grows: its concepts are kept (deprecated ones too), the new ones added.
 */
export function buildPack(scope: OntologyScope, read: ReadSource, chosen: readonly string[], overrides: Record<string, string> = {}, ontology: Ontology = loadOntology(scope)): BuiltPack {
  const problems: string[] = [];
  const byId = new Map(read.analysis.concepts.map((c) => [c.id, c] as const));
  const want = new Set(chosen);
  for (const id of [...want]) for (let cur = byId.get(id)?.parent; cur && byId.has(cur); cur = byId.get(cur)?.parent) want.add(cur);
  const existing = readTeamPack(scope.workspaceRoot, read.id)?.pack;
  const kept = existing?.concepts ?? [];
  const keptIds = new Set(kept.map((c) => c.id));
  const placements = new Map(placementOf(read, [...want], overrides).map((p) => [p.id, p] as const));
  for (const [id, upper] of Object.entries(overrides)) if (!/^upper:/.test(upper) && !byId.has(upper) && !ontology.concepts.has(upper)) problems.push(`${id}: ${upper} isn't an upper concept (${UPPER_CONCEPTS.map((u) => `upper:${u}`).join(', ')}) or a concept AutoDE knows.`);
  const added: Concept[] = [];
  for (const id of [...want].sort()) {
    if (keptIds.has(id)) continue;
    const c = byId.get(id);
    if (!c) { problems.push(`${id} isn't in the source.`); continue; }
    const concept: SourceConcept = { ...c };
    delete concept.suggestedPlacement;
    const parent = c.parent && byId.has(c.parent) ? c.parent : placements.get(id)?.parent;
    if (!parent) problems.push(`${id} (${c.label}) has no place: put it under one of ${UPPER_CONCEPTS.map((u) => `upper:${u}`).join(', ')}.`);
    added.push({ ...concept, ...(parent ? { parent } : {}) });
  }
  const all = [...kept, ...added];
  const known = new Set([...all.map((c) => c.id), ...ontology.concepts.keys()]);
  const concepts = all.map((c) => {
    const relations = (c.relations ?? []).filter((r) => known.has(r.target));
    const out: Concept = { ...c, ...(relations.length ? { relations } : {}) };
    if (!relations.length) delete out.relations;
    if (out.broader && !known.has(out.broader)) delete out.broader;
    return out;
  });
  const licence = read.standard?.licence;
  const pack = normalizePack({
    autode: PACK_FORMAT, id: read.id, title: existing?.title ?? read.title, prefix: existing?.prefix ?? read.analysis.prefix,
    ...(existing?.description ? { description: existing.description } : {}),
    ...(read.standard ? { standard: read.standard } : existing?.standard ? { standard: existing.standard } : {}),
    distribution: licence && licence.redistribution !== 'allowed' ? 'workspace' : existing?.distribution === 'workspace' ? 'workspace' : 'shareable',
    source: read.source,
    concepts
  });
  return { pack, text: stringifyPack(pack), added: added.map((c) => c.id), kept: kept.map((c) => c.id), problems };
}

// ── Step 4: terms ──

export interface TermCandidate { term: string; label: string; concept: string; conceptLabel: string; match: MatchType; reason: string }

/**
 * `means` links proposed for the vocabulary: a term whose words are a concept's name is an exact match; a term
 * whose words contain a concept's name and more is narrower than it (the concept is broader, skos:broadMatch).
 * Terms that already have a link (live or proposed) to the concept are skipped. Deterministic, no model.
 */
export function alignTerms(terms: ReadonlyArray<{ id: string; label: string }>, concepts: readonly Concept[], vocab: Vocabulary, existing: readonly MeaningLink[] = []): TermCandidate[] {
  const named = concepts.filter((c) => c.status !== 'deprecated' && !isUpper(c.id)).map((c) => ({ c, phrases: phrases(c, vocab) }));
  const linked = new Set(existing.filter((l) => l.predicate === 'means').map((l) => `${l.subject}|${l.concept}`));
  const out: TermCandidate[] = [];
  for (const t of terms) {
    const words = wordsOf(t.label, vocab);
    if (!words.length) continue;
    const have = new Set(words);
    const exact = named.filter(({ phrases: ps }) => ps.some((p) => p.length === have.size && p.every((w) => have.has(w))));
    let hits: Array<{ c: Concept; match: MatchType; reason: string }> = exact.map(({ c }) => ({ c, match: 'exact' as const, reason: `"${t.label}" is a name of ${c.label}` }));
    if (!hits.length) {
      let best = 0;
      for (const { c, phrases: ps } of named) {
        const fit = ps.filter((p) => p.length < have.size && p.every((w) => have.has(w))).sort((a, b) => b.length - a.length)[0];
        if (!fit || fit.length < best) continue;
        if (fit.length > best) { best = fit.length; hits = []; }
        // "Loan Amount" is about a loan, not a kind of loan: only attribute words beyond the name make it related.
        const extra = [...have].filter((w) => !fit.includes(w));
        const attribute = extra.every((w) => ATTRIBUTE_WORDS.has(w));
        hits.push(attribute
          ? { c, match: 'related', reason: `"${t.label}" is ${c.label} with ${extra.join(', ')}: an attribute of it` }
          : { c, match: 'broader', reason: `"${t.label}" contains ${c.label} and says more: the concept is broader` });
      }
    }
    for (const h of hits) if (!linked.has(`${t.id}|${h.c.id}`)) out.push({ term: t.id, label: t.label, concept: h.c.id, conceptLabel: h.c.label, match: h.match, reason: h.reason });
  }
  return out.sort((a, b) => a.term.localeCompare(b.term) || a.concept.localeCompare(b.concept));
}

export interface RepresentsCandidate { table: string; label: string; concept: string; conceptLabel: string; reason: string }

/** *represents* links proposed for tables whose name, without storage words, is a concept's name. */
export function representsCandidates(tables: readonly TableNode[], concepts: readonly Concept[], vocab: Vocabulary, existing: readonly MeaningLink[] = []): RepresentsCandidate[] {
  const named = concepts.filter((c) => c.status !== 'deprecated' && !isUpper(c.id)).map((c) => ({ c, phrases: phrases(c, vocab) }));
  const linked = new Set(existing.filter((l) => l.predicate === 'represents').map((l) => `${l.subject}|${l.concept}`));
  const out: RepresentsCandidate[] = [];
  for (const t of tables) {
    const words = wordsOf(t.label, vocab).filter((w) => !STORAGE_WORDS.has(w));
    if (!words.length) continue;
    const have = new Set(words);
    for (const { c, phrases: ps } of named) {
      if (!ps.some((p) => p.length === have.size && p.every((w) => have.has(w)))) continue;
      if (!linked.has(`${t.id}|${c.id}`)) out.push({ table: t.id, label: t.fqn || t.label, concept: c.id, conceptLabel: c.label, reason: `${t.label} names ${c.label}` });
    }
  }
  return out.sort((a, b) => a.table.localeCompare(b.table) || a.concept.localeCompare(b.concept));
}

/** The proposed facts for chosen candidates: high stakes, confirmed by a person in the Context Inbox. */
export function meaningProposals(input: { means?: readonly TermCandidate[]; represents?: readonly RepresentsCandidate[]; by: string; evidenceRef: string; specId?: string }): NewAssertion[] {
  const base = { trust: 'inferred' as const, status: 'proposed' as const, createdBy: input.by, ...(input.specId ? { specId: input.specId } : {}) };
  return [
    ...(input.means ?? []).map((m) => ({ ...base, kind: 'meaning' as const, subject: [m.term], predicate: 'means', value: { concept: m.concept, match: m.match, term: m.label }, statement: `The term "${m.label}" means ${m.conceptLabel} (${m.concept}, ${m.match} match).`, evidence: [{ type: 'file' as const, ref: input.evidenceRef, excerpt: m.reason.slice(0, 300) }] })),
    ...(input.represents ?? []).map((r) => ({ ...base, kind: 'meaning' as const, subject: [r.table], predicate: 'represents', value: { concept: r.concept }, statement: `${r.label} represents ${r.conceptLabel} (${r.concept}).`, evidence: [{ type: 'file' as const, ref: input.evidenceRef, excerpt: r.reason.slice(0, 300) }] }))
  ];
}
