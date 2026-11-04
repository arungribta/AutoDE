import { createHash } from 'node:crypto';
import { RDF, Triple } from './rdf';
import { Concept, ConceptRelation, PackLicence, UPPER_CONCEPTS, localName } from './pack';
import type { MatchRule, ReaderSettings } from './standards';

/**
 * From a standard's triples to concepts (ONT1; docs/specs/context-layer.md §6.8): classes (OWL, RDFS) and SKOS
 * concepts, with their labels, definitions and synonyms, the parent each names (rdfs:subClassOf, skos:broader),
 * relations (object properties with a domain and range, and OWL restrictions), attributes (datatype properties)
 * and the ontology's version and licence. Only what the light pack format holds is kept: no axioms.
 *
 * Deterministic: the same triples give the same concepts in the same order, so onboarding the same source twice
 * produces the same pack.
 */

const OWL = 'http://www.w3.org/2002/07/owl#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const CLASS_TYPES = new Set([`${OWL}Class`, `${RDFS}Class`, `${SKOS}Concept`]);
const LABELS = [`${SKOS}prefLabel`, `${RDFS}label`];
const DEFINITIONS = [`${SKOS}definition`, `${RDFS}comment`, 'http://purl.org/dc/terms/description'];
const LICENCES = ['http://purl.org/dc/terms/license', 'http://purl.org/dc/elements/1.1/rights', 'http://purl.org/dc/terms/rights', 'http://creativecommons.org/ns#license', 'http://www.w3.org/1999/xhtml/vocab#license'];

/** A concept as the source states it: its parent is another concept of the source, or nothing (to be placed). */
export interface SourceConcept extends Concept {
  /** Upper concept AutoDE suggests for a concept the source gives no parent (the person decides). */
  suggestedPlacement?: string;
}

export interface SourceAnalysis {
  title: string;
  /** The ontology's IRI, version and licence as it states them. */
  iri?: string;
  version?: string;
  licence: PackLicence;
  concepts: SourceConcept[];
  relations: number;
  /** Concepts per module (FIBO: per ontology namespace). */
  modules: Array<{ module: string; concepts: number }>;
  /** A suggested prefix for the pack's concept ids. */
  prefix: string;
  /** What couldn't be read or was left out. */
  warnings: string[];
  /** The checksum of what was read, recorded as the pack's source. */
  checksum: string;
}

const pick = (values: Array<{ o: string; lang?: string }>) => {
  const best = values.find((v) => !v.lang || /^en\b/i.test(v.lang)) ?? values[0];
  return best?.o.trim().replace(/\s+/g, ' ');
};

const local = (iri: string) => decodeURIComponent((/[#/]([^#/]+)$/.exec(iri)?.[1] ?? iri).replace(/[^A-Za-z0-9_%-]/g, ''));
const spaced = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();

/** The licence a statement names: allowed, forbidden, or unknown (which keeps a pack in the workspace too). */
export function classifyLicence(text: string | undefined): PackLicence {
  const t = (text ?? '').trim();
  if (!t) return { name: 'not stated', redistribution: 'unknown', note: 'The source states no licence: the pack stays in this workspace.' };
  if (/all rights reserved|proprietary|not (be )?(for )?redistribut|no redistribution|may not be (copied|redistributed|shared)|internal use only|confidential/i.test(t)) return { name: t.slice(0, 120), redistribution: 'forbidden', note: 'The licence forbids redistribution: the pack stays in this workspace.' };
  if (/opensource\.org\/licenses\/MIT|\bMIT\b/.test(t)) return { name: 'MIT License', spdx: 'MIT', redistribution: 'allowed' };
  if (/apache\.org\/licenses\/LICENSE-2\.0|apache[- ]2\.0|apache license/i.test(t)) return { name: 'Apache License 2.0', spdx: 'Apache-2.0', redistribution: 'allowed' };
  if (/creativecommons\.org\/publicdomain\/zero|\bCC0\b/i.test(t)) return { name: 'CC0 1.0', spdx: 'CC0-1.0', redistribution: 'allowed' };
  if (/creativecommons\.org\/licenses\/by\/4\.0|\bCC[- ]BY[- ]4\.0\b/i.test(t)) return { name: 'CC BY 4.0', spdx: 'CC-BY-4.0', redistribution: 'allowed', note: 'Keep the attribution the licence asks for.' };
  if (/creativecommons\.org\/licenses\/by\/|\bCC[- ]BY\b(?![- ](NC|ND))/i.test(t)) return { name: 'Creative Commons Attribution', redistribution: 'allowed', note: 'Keep the attribution the licence asks for.' };
  if (/\bBSD\b/.test(t)) return { name: 'BSD licence', redistribution: 'allowed' };
  return { name: t.slice(0, 120), redistribution: 'unknown', note: 'AutoDE doesn\'t recognise the licence: the pack stays in this workspace until someone checks it.' };
}

/** Words that place a concept under an upper concept, most specific first within each. */
const PLACEMENT: Array<[typeof UPPER_CONCEPTS[number], RegExp]> = [
  ['Account', /\baccounts?\b|\bledgers?\b/],
  ['Transaction', /\btransactions?\b|\bpayments?\b|\btransfers?\b|\bdisbursements?\b|\brepayments?\b|\bdrawdowns?\b|\btrades?\b|\bpostings?\b/],
  ['Document', /\bdocuments?\b|\bstatements?\b|\breports?\b|\bcertificates?\b|\bapplications?\b|\bforms?\b|\bfilings?\b/],
  ['Agreement', /\bagreements?\b|\bcontracts?\b|\bloans?\b|\bfacilit(y|ies)\b|\bmortgages?\b|\bleases?\b|\bpolic(y|ies)\b|\bcommitments?\b|\bguarant(y|ee|ies|ees)\b|\bcovenants?\b|\bterms?\b/],
  ['Party', /\bpart(y|ies)\b|\bpersons?\b|\bpeople\b|\borgani[sz]ations?\b|\bcustomers?\b|\bclients?\b|\bborrowers?\b|\blenders?\b|\bguarantors?\b|\bagents?\b|\bemployees?\b|\blegal entit(y|ies)\b|\bcounterpart(y|ies)\b|\bindividuals?\b|\binstitutions?\b|\bissuers?\b|\bbanks?\b/],
  ['Location', /\blocations?\b|\baddress(es)?\b|\bcountr(y|ies)\b|\bregions?\b|\bsites?\b|\bjurisdictions?\b|\bplaces?\b|\bbranch(es)?\b/],
  ['Product', /\bproducts?\b|\bservices?\b|\bofferings?\b|\binstruments?\b|\bcollateral\b|\bassets?\b/],
  ['Event', /\bevents?\b|\bdefaults?\b|\bdelinquenc(y|ies)\b|\boccurrences?\b|\bchanges?\b|\borigination\b|\bclosings?\b|\bmaturity\b/]
];

/** An upper concept for a concept the source gives no parent, from its own and its ancestors' labels. */
export function suggestPlacement(labels: readonly string[]): string | undefined {
  for (const text of labels) {
    const t = text.toLowerCase();
    const hit = PLACEMENT.find(([, re]) => re.test(t));
    if (hit) return `upper:${hit[0]}`;
  }
  return undefined;
}

/** Concepts and metadata from a standard's triples. */
export function analyzeTriples(triples: readonly Triple[], opts: { name: string; text: string; prefix?: string; licenceText?: string; settings?: ReaderSettings }): SourceAnalysis {
  const warnings: string[] = [];
  const bySubject = new Map<string, Triple[]>();
  for (const t of triples) { const l = bySubject.get(t.s); if (l) l.push(t); else bySubject.set(t.s, [t]); }
  const values = (s: string, preds: readonly string[]) => (bySubject.get(s) ?? []).filter((t) => preds.includes(t.p));
  const literal = (s: string, preds: readonly string[]) => { for (const p of preds) { const v = pick(values(s, [p]).filter((t) => t.literal)); if (v) return v; } return undefined; };
  const typed = (type: string) => [...new Set(triples.filter((t) => t.p === `${RDF}type` && t.o === type).map((t) => t.s))];

  const onto = typed(`${OWL}Ontology`).sort()[0] ?? typed(`${SKOS}ConceptScheme`).sort()[0];
  const ontoValue = (preds: readonly string[]) => (onto ? (bySubject.get(onto) ?? []).find((t) => preds.includes(t.p))?.o : undefined);
  const version = onto ? (literal(onto, [`${OWL}versionInfo`]) ?? ontoValue([`${OWL}versionIRI`])) : undefined;
  const licence = classifyLicence(opts.licenceText ?? (onto ? ontoValue(LICENCES) : undefined));
  const title = (onto ? literal(onto, ['http://purl.org/dc/terms/title', 'http://purl.org/dc/elements/1.1/title', ...LABELS]) : undefined) ?? opts.name.replace(/\.[a-z]+$/i, '');

  // A standard's settings say which classes are datatypes or enumerations rather than concepts (CIM's stereotypes).
  const matches = (s: string, rules: readonly MatchRule[] | undefined) => !!rules?.length && rules.some((r) => (bySubject.get(s) ?? []).some((t) => t.p === r.property && new RegExp(r.value).test(t.o)));
  const skipped = new Set<string>();
  const classIris = new Set(triples.filter((t) => t.p === `${RDF}type` && CLASS_TYPES.has(t.o) && !t.s.startsWith('_:') && !t.s.startsWith(OWL) && !t.s.startsWith(RDFS)).map((t) => t.s).filter((s) => (matches(s, opts.settings?.skipClasses) ? (skipped.add(s), false) : true)));
  const iris = [...classIris].sort();
  // Ids from local names; a collision (the same name in two modules) gets a numbered suffix, in IRI order.
  const prefix = opts.prefix ?? opts.settings?.prefix ?? suggestPrefix(iris, title);
  const idOf = new Map<string, string>();
  const used = new Set<string>();
  for (const iri of iris) {
    let name = localName(spaced(local(iri)) || 'Concept');
    for (let n = 2; used.has(name); n++) name = `${localName(spaced(local(iri)))}${n}`;
    used.add(name);
    idOf.set(iri, `${prefix}:${name}`);
  }
  const base = commonBase(iris);

  // Relations: object properties with a domain and a range, and restrictions on a class.
  const relations = new Map<string, ConceptRelation[]>();
  const attributes = new Map<string, Set<string>>();
  const addRel = (iri: string, r: ConceptRelation) => { const l = relations.get(iri) ?? []; if (!l.some((x) => x.verb === r.verb && x.target === r.target)) l.push(r); relations.set(iri, l); };
  const propLabel = (p: string) => literal(p, LABELS) ?? spaced(local(p));
  const datatypeProps = new Set(typed(`${OWL}DatatypeProperty`));
  for (const p of typed(`${OWL}ObjectProperty`).sort()) {
    const domains = values(p, [`${RDFS}domain`]).map((t) => t.o).filter((o) => classIris.has(o));
    const ranges = values(p, [`${RDFS}range`]).map((t) => t.o).filter((o) => classIris.has(o));
    for (const d of domains) for (const r of ranges) addRel(d, { verb: verbOf(p, propLabel(p)), target: idOf.get(r)! });
  }
  for (const p of [...datatypeProps].sort()) for (const d of values(p, [`${RDFS}domain`]).map((t) => t.o).filter((o) => classIris.has(o))) {
    const s = attributes.get(d) ?? new Set<string>(); s.add(propLabel(p).toLowerCase()); attributes.set(d, s);
  }
  // Plain RDFS properties (CIM's vocabularies): a range that is a class of the file is a relation, anything else (a
  // datatype, a primitive, an enumeration) an attribute. The multiplicity comes from the standard's cardinality property.
  const objectProps = new Set(typed(`${OWL}ObjectProperty`));
  for (const p of typed(`${RDF}Property`).sort()) {
    if (objectProps.has(p) || datatypeProps.has(p) || matches(p, opts.settings?.skipProperties)) continue;
    const domains = values(p, [`${RDFS}domain`]).map((t) => t.o).filter((o) => classIris.has(o));
    if (!domains.length) continue;
    const range = values(p, [`${RDFS}range`])[0]?.o;
    const card = opts.settings?.cardinalityProperty ? multiplicity(values(p, [opts.settings.cardinalityProperty])[0]?.o) : undefined;
    const name = propLabel(p);
    for (const d of domains) {
      if (range && classIris.has(range)) addRel(d, { verb: verbOf(p, name), target: idOf.get(range)!, ...(card ? { cardinality: card } : {}) });
      else { const s = attributes.get(d) ?? new Set<string>(); s.add(spaced(name).toLowerCase()); attributes.set(d, s); }
    }
  }
  const parentsOf = new Map<string, string[]>();
  let restrictions = 0;
  for (const iri of iris) {
    const supers = values(iri, [`${RDFS}subClassOf`, `${SKOS}broader`, `${OWL}equivalentClass`]).map((t) => t.o);
    const named = supers.filter((o) => classIris.has(o) && o !== iri && !(bySubject.get(iri) ?? []).some((t) => t.p === `${OWL}equivalentClass` && t.o === o));
    parentsOf.set(iri, [...new Set(named)].sort());
    for (const b of supers.filter((o) => o.startsWith('_:'))) {
      const on = values(b, [`${OWL}onProperty`])[0]?.o;
      if (!on) continue;
      restrictions++;
      const target = values(b, [`${OWL}someValuesFrom`, `${OWL}allValuesFrom`, `${OWL}onClass`])[0]?.o;
      const card = cardinality(b, values);
      if (target && classIris.has(target)) addRel(iri, { verb: verbOf(on, propLabel(on)), target: idOf.get(target)!, ...(card ? { cardinality: card } : {}) });
      else if (datatypeProps.has(on) || (target && /XMLSchema#/.test(target))) { const s = attributes.get(iri) ?? new Set<string>(); s.add(propLabel(on).toLowerCase()); attributes.set(iri, s); }
    }
  }
  if (!iris.length) warnings.push('No classes or SKOS concepts found (owl:Class, rdfs:Class, skos:Concept).');

  const concepts: SourceConcept[] = iris.map((iri) => {
    const raw = literal(iri, LABELS) ?? spaced(local(iri));
    const label = opts.settings?.labelCase === 'title' ? raw.replace(/(^|[\s(/-])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase()) : raw;
    const parents = parentsOf.get(iri) ?? [];
    if (parents.length > 1) warnings.push(`${idOf.get(iri)} has ${parents.length} parents in the source; the pack keeps ${idOf.get(parents[0])} (the light format has one).`);
    const synonyms = (bySubject.get(iri) ?? []).filter((t) => t.literal && (t.p === `${SKOS}altLabel` || /[#/]synonym$/.test(t.p)) && (!t.lang || /^en\b/i.test(t.lang))).map((t) => t.o.trim()).filter((s) => s && s.toLowerCase() !== label.toLowerCase());
    const definition = literal(iri, DEFINITIONS);
    const attrs = [...(attributes.get(iri) ?? [])].sort();
    const mod = moduleOf(iri, base);
    return {
      id: idOf.get(iri)!, label, iri,
      ...(definition ? { definition } : {}),
      ...(parents.length ? { parent: idOf.get(parents[0])! } : {}),
      ...(synonyms.length ? { synonyms: [...new Set(synonyms)].sort() } : {}),
      ...(relations.get(iri)?.length ? { relations: relations.get(iri)!.sort((a, b) => a.verb.localeCompare(b.verb) || a.target.localeCompare(b.target)) } : {}),
      ...(attrs.length ? { attributes: { notable: attrs } } : {}),
      ...(mod ? { module: mod } : {}),
      ...((bySubject.get(iri) ?? []).some((t) => t.p === `${OWL}deprecated` && /^(true|1)$/.test(t.o)) ? { status: 'deprecated' as const } : {})
    };
  });
  // A placement for each concept the source leaves without a parent, from its own label and its children's (the person decides).
  const children = new Map<string, string[]>();
  for (const c of concepts) if (c.parent) children.set(c.parent, [...(children.get(c.parent) ?? []), c.label]);
  for (const c of concepts) if (!c.parent) {
    const s = suggestPlacement([c.label, ...(children.get(c.id) ?? []), c.definition ?? '']);
    if (s) c.suggestedPlacement = s;
  }
  const modules = new Map<string, number>();
  for (const c of concepts) modules.set(c.module ?? '(none)', (modules.get(c.module ?? '(none)') ?? 0) + 1);
  if (skipped.size) warnings.push(`${skipped.size} class(es) left out as datatypes or enumerations, by the standard's settings.`);
  if (restrictions) warnings.push(`${restrictions} OWL restriction(s) read as relations or attributes; other axioms are not kept (the pack format is light by design).`);
  return {
    title, ...(onto && !onto.startsWith('_:') ? { iri: onto } : {}), ...(version ? { version } : {}), licence,
    concepts, relations: concepts.reduce((n, c) => n + (c.relations?.length ?? 0), 0),
    modules: [...modules.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([module, n]) => ({ module, concepts: n })),
    prefix, warnings, checksum: createHash('sha256').update(opts.text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)
  };
}

/** `M:0..n`, `M:1`, `0..*` → `0..*`, `1`. */
function multiplicity(v: string | undefined): string | undefined {
  const m = v ? /(\d+)(?:\.\.(\d+|n|\*))?$/.exec(v) : null;
  return m ? (m[2] ? `${m[1]}..${m[2] === 'n' ? '*' : m[2]}` : m[1]) : undefined;
}

function cardinality(b: string, values: (s: string, preds: readonly string[]) => Triple[]): string | undefined {
  const n = (p: string) => { const v = values(b, [`${OWL}${p}`])[0]?.o; return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined; };
  const exact = n('qualifiedCardinality') ?? n('cardinality');
  if (exact !== undefined) return `${exact}`;
  const min = n('minQualifiedCardinality') ?? n('minCardinality');
  const max = n('maxQualifiedCardinality') ?? n('maxCardinality');
  if (min !== undefined || max !== undefined) return `${min ?? 0}..${max ?? '*'}`;
  if (values(b, [`${OWL}someValuesFrom`]).length) return '1..*';
  return undefined;
}

/** A relation's verb: its label in camel case (`has borrower` → `hasBorrower`). */
function verbOf(iri: string, label: string): string {
  const words = (label || spaced(local(iri))).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  // A name already in camel case (CIM's role names: DCConductingEquipment) keeps its words: dcConductingEquipment.
  const first = (w: string) => (/[a-z]/.test(w) && /[A-Z]/.test(w.slice(1)) ? w.replace(/^[A-Z]+(?=[A-Z][a-z])|^[A-Z]/, (m) => m.toLowerCase()) : w.toLowerCase());
  return words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : first(w))).join('') || 'relatedTo';
}

function commonBase(iris: readonly string[]): string {
  if (!iris.length) return '';
  let base = iris[0].replace(/[^/#]*$/, '');
  for (const i of iris) while (base && !i.startsWith(base)) base = base.replace(/[^/#]*[/#]$/, '');
  return base;
}

function moduleOf(iri: string, base: string): string | undefined {
  const ns = iri.replace(/[^/#]*$/, '');
  const m = ns.slice(base.length).replace(/[/#]+$/, '');
  return m || undefined;
}

/** A prefix for the pack's ids: a known standard's, else the title's initials. */
function suggestPrefix(iris: readonly string[], title: string): string {
  if (iris.some((i) => /edmcouncil\.org\/fibo\b/i.test(i))) return 'fibo';
  if (iris.some((i) => /schema\.org\//i.test(i))) return 'schema';
  if (iris.some((i) => /iec\.ch\/TC57\//i.test(i))) return 'cim';
  const initials = title.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 8);
  return /^[a-z][a-z0-9]*$/.test(initials) ? initials : 'std';
}
