/**
 * Reading RDF for onboarding a standard (ONT1; docs/specs/context-layer.md §6.8): OWL and SKOS files a user
 * supplies, in Turtle (N-Triples is a subset) or RDF/XML, become plain triples. Turtle is parsed by N3.js's
 * parser (MIT) and RDF/XML by AutoDE's mapping of the RDF/XML grammar over sax's XML events (BlueOak-1.0.0);
 * both are bundled, so nothing is downloaded (P6; the decision record is in the roadmap's decision log,
 * 2026-11-03). Shipped packs are YAML already, so only files a user supplies need this.
 *
 * Deterministic: blank nodes are numbered in document order, so the same file gives the same triples.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const N3Parser = require('n3/lib/N3Parser').default as new (options: { baseIRI?: string; blankNodePrefix?: string; format?: string }) => { parse(text: string): N3Quad[] };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sax = require('sax') as SaxModule;

interface N3Term { termType: 'NamedNode' | 'BlankNode' | 'Literal' | 'Variable' | 'DefaultGraph'; value: string; language?: string; datatype?: { value: string } }
interface N3Quad { subject: N3Term; predicate: N3Term; object: N3Term }
interface SaxTag { name: string; uri: string; local: string; prefix: string; attributes: Record<string, { name: string; value: string; uri: string; local: string; prefix: string }> }
interface SaxParser {
  ENTITIES: Record<string, string>;
  onopentag: (t: SaxTag) => void; onclosetag: (name: string) => void; ontext: (t: string) => void; oncdata: (t: string) => void;
  ondoctype: (d: string) => void; onerror: (e: Error) => void;
  write(s: string): SaxParser; close(): SaxParser;
}
interface SaxModule { parser(strict: boolean, opts: { xmlns: boolean; position?: boolean }): SaxParser }

export interface Triple {
  s: string;
  p: string;
  /** An IRI, a blank node (`_:b…`) or, when `literal`, the literal's text. */
  o: string;
  literal?: boolean;
  lang?: string;
  datatype?: string;
}

export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export type RdfFormat = 'turtle' | 'rdfxml';

/** Without a leading byte-order mark (editors on Windows write one). */
const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** The format of a file, from its name and first characters. */
export function rdfFormat(name: string, text: string): RdfFormat | undefined {
  const head = stripBom(text).replace(/^(\s*#[^\n]*\n)*/, '').trimStart();
  if (/\.(ttl|nt|n3)$/i.test(name)) return 'turtle';
  if (head.startsWith('<?xml') || /^<(!DOCTYPE|rdf:RDF|[A-Za-z_][\w.-]*:RDF\b)/.test(head)) return 'rdfxml';
  if (/\.(rdf|owl|xml)$/i.test(name)) return head.startsWith('<') && !/^<[^>]*>\s*<[^>]*>/.test(head) ? 'rdfxml' : 'turtle';
  if (/^(@prefix|@base|PREFIX|BASE|<[^>]+>\s*<)/i.test(head)) return 'turtle';
  return undefined;
}

export function parseRdf(text: string, format: RdfFormat, baseIRI = 'urn:autode:base'): Triple[] {
  return format === 'turtle' ? parseTurtle(text, baseIRI) : parseRdfXml(text, baseIRI);
}

export function parseTurtle(text: string, baseIRI = 'urn:autode:base'): Triple[] {
  let quads: N3Quad[];
  try { quads = new N3Parser({ baseIRI, blankNodePrefix: '' }).parse(text); } catch (err) { throw new Error(`Turtle: ${err instanceof Error ? err.message : String(err)}`); }
  const blanks = new Map<string, string>();
  const term = (t: N3Term) => (t.termType === 'BlankNode' ? (blanks.get(t.value) ?? (blanks.set(t.value, `_:b${blanks.size}`), blanks.get(t.value)!)) : t.value);
  return quads.map((q) => q.object.termType === 'Literal'
    ? { s: term(q.subject), p: q.predicate.value, o: q.object.value, literal: true, ...(q.object.language ? { lang: q.object.language } : {}), ...(q.object.datatype && !/#(string|langString)$/.test(q.object.datatype.value) ? { datatype: q.object.datatype.value } : {}) }
    : { s: term(q.subject), p: q.predicate.value, o: term(q.object) });
}

type Frame =
  | { kind: 'rdf'; lang?: string; base: string }
  | { kind: 'node'; subject: string; lang?: string; base: string; li: number }
  | { kind: 'prop'; subject: string; predicate: string; lang?: string; base: string; datatype?: string; text: string; object?: string; done?: boolean }
  | { kind: 'collection'; subject: string; predicate: string; lang?: string; base: string; items: string[] }
  | { kind: 'literal'; subject: string; predicate: string; lang?: string; base: string; text: string; depth: number };

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** RDF/XML (https://www.w3.org/TR/rdf-syntax-grammar/): node and property elements, the abbreviations OWL and SKOS files use. */
export function parseRdfXml(text: string, baseIRI = 'urn:autode:base'): Triple[] {
  const out: Triple[] = [];
  const stack: Frame[] = [];
  let blank = 0;
  const newBlank = () => `_:b${blank++}`;
  const named = new Map<string, string>();
  const nodeId = (id: string) => named.get(id) ?? (named.set(id, newBlank()), named.get(id)!);
  const resolve = (ref: string, base: string) => { try { return new URL(ref, base).href; } catch { return ref; } };
  const p = sax.parser(true, { xmlns: true });
  let failure: Error | undefined;
  p.onerror = (e) => { failure = failure ?? e; };
  p.ondoctype = (d) => { for (const m of d.matchAll(/<!ENTITY\s+([A-Za-z_][\w.-]*)\s+(["'])([\s\S]*?)\2\s*>/g)) p.ENTITIES[m[1]] = m[3]; };
  const attrsOf = (t: SaxTag) => Object.values(t.attributes);
  const isRdf = (a: { uri: string; local: string }, local: string) => a.uri === RDF && a.local === local;

  const openNode = (t: SaxTag, parent: Frame | undefined): string => {
    const lang = attrsOf(t).find((a) => a.uri === XML_NS && a.local === 'lang')?.value ?? parent?.lang;
    const base = (() => { const b = attrsOf(t).find((a) => a.uri === XML_NS && a.local === 'base')?.value; return b ? resolve(b, parent?.base ?? baseIRI) : parent?.base ?? baseIRI; })();
    const about = attrsOf(t).find((a) => isRdf(a, 'about'))?.value;
    const id = attrsOf(t).find((a) => isRdf(a, 'ID'))?.value;
    const nid = attrsOf(t).find((a) => isRdf(a, 'nodeID'))?.value;
    const subject = about !== undefined ? resolve(about, base) : id !== undefined ? resolve(`#${id}`, base) : nid !== undefined ? nodeId(nid) : newBlank();
    if (!(t.uri === RDF && t.local === 'Description')) out.push({ s: subject, p: `${RDF}type`, o: t.uri + t.local });
    for (const a of attrsOf(t)) {
      if (!a.uri || a.uri === XML_NS || a.uri === 'http://www.w3.org/2000/xmlns/' || a.prefix === 'xmlns' || a.name === 'xmlns') continue;
      if (a.uri === RDF && ['about', 'ID', 'nodeID'].includes(a.local)) continue;
      if (isRdf(a, 'type')) out.push({ s: subject, p: `${RDF}type`, o: resolve(a.value, base) });
      else out.push({ s: subject, p: a.uri + a.local, o: a.value, literal: true, ...(lang ? { lang } : {}) });
    }
    stack.push({ kind: 'node', subject, lang, base, li: 1 });
    return subject;
  };

  p.onopentag = (t) => {
    const parent = stack[stack.length - 1];
    if (parent?.kind === 'literal') { parent.depth++; parent.text += `<${t.name}>`; return; }
    if (!parent) {
      if (t.uri === RDF && t.local === 'RDF') { stack.push({ kind: 'rdf', lang: attrsOf(t).find((a) => a.uri === XML_NS && a.local === 'lang')?.value, base: (() => { const b = attrsOf(t).find((a) => a.uri === XML_NS && a.local === 'base')?.value; return b ? resolve(b, baseIRI) : baseIRI; })() }); return; }
      openNode(t, undefined);
      return;
    }
    if (parent.kind === 'rdf') { openNode(t, parent); return; }
    if (parent.kind === 'prop') {
      // A property element's object is this node element.
      const s = openNode(t, parent);
      parent.object = s;
      return;
    }
    if (parent.kind === 'collection') { parent.items.push(openNode(t, parent)); return; }
    // parent.kind === 'node': a property element.
    const predicate = t.uri === RDF && t.local === 'li' ? `${RDF}_${parent.li++}` : t.uri + t.local;
    const lang = attrsOf(t).find((a) => a.uri === XML_NS && a.local === 'lang')?.value ?? parent.lang;
    const base = parent.base;
    const resource = attrsOf(t).find((a) => isRdf(a, 'resource'))?.value;
    const nid = attrsOf(t).find((a) => isRdf(a, 'nodeID'))?.value;
    const parseType = attrsOf(t).find((a) => isRdf(a, 'parseType'))?.value;
    const datatype = attrsOf(t).find((a) => isRdf(a, 'datatype'))?.value;
    const propAttrs = attrsOf(t).filter((a) => a.uri && a.uri !== XML_NS && a.prefix !== 'xmlns' && !(a.uri === RDF && ['resource', 'nodeID', 'parseType', 'datatype', 'ID'].includes(a.local)));
    if (parseType === 'Resource') {
      const b = newBlank();
      out.push({ s: parent.subject, p: predicate, o: b });
      stack.push({ kind: 'node', subject: b, lang, base, li: 1 });
      return;
    }
    if (parseType === 'Collection') { stack.push({ kind: 'collection', subject: parent.subject, predicate, lang, base, items: [] }); return; }
    if (parseType === 'Literal') { stack.push({ kind: 'literal', subject: parent.subject, predicate, lang, base, text: '', depth: 0 }); return; }
    if (resource !== undefined || nid !== undefined || propAttrs.length) {
      const o = resource !== undefined ? resolve(resource, base) : nid !== undefined ? nodeId(nid) : newBlank();
      out.push({ s: parent.subject, p: predicate, o });
      for (const a of propAttrs) {
        if (isRdf(a, 'type')) out.push({ s: o, p: `${RDF}type`, o: resolve(a.value, base) });
        else out.push({ s: o, p: a.uri + a.local, o: a.value, literal: true, ...(lang ? { lang } : {}) });
      }
      stack.push({ kind: 'prop', subject: parent.subject, predicate, lang, base, text: '', done: true });
      return;
    }
    stack.push({ kind: 'prop', subject: parent.subject, predicate, lang, base, text: '', ...(datatype ? { datatype: resolve(datatype, base) } : {}) });
  };
  const onText = (s: string) => {
    const top = stack[stack.length - 1];
    if (top?.kind === 'prop' || top?.kind === 'literal') top.text += s;
  };
  p.ontext = onText;
  p.oncdata = onText;
  p.onclosetag = (name) => {
    const top = stack[stack.length - 1];
    if (top?.kind === 'literal' && top.depth > 0) { top.depth--; top.text += `</${name}>`; return; }
    stack.pop();
    if (!top) return;
    if (top.kind === 'prop' && !top.done) {
      if (top.object) out.push({ s: top.subject, p: top.predicate, o: top.object });
      else out.push({ s: top.subject, p: top.predicate, o: top.text.trim(), literal: true, ...(top.lang && !top.datatype ? { lang: top.lang } : {}), ...(top.datatype && !/#(string|langString)$/.test(top.datatype) ? { datatype: top.datatype } : {}) });
    } else if (top.kind === 'literal') {
      out.push({ s: top.subject, p: top.predicate, o: top.text, literal: true, datatype: `${RDF}XMLLiteral` });
    } else if (top.kind === 'collection') {
      if (!top.items.length) { out.push({ s: top.subject, p: top.predicate, o: `${RDF}nil` }); return; }
      const cells = top.items.map(() => newBlank());
      out.push({ s: top.subject, p: top.predicate, o: cells[0] });
      cells.forEach((c, i) => { out.push({ s: c, p: `${RDF}first`, o: top.items[i] }); out.push({ s: c, p: `${RDF}rest`, o: cells[i + 1] ?? `${RDF}nil` }); });
    }
  };
  try { p.write(stripBom(text)).close(); } catch (err) { failure = failure ?? (err instanceof Error ? err : new Error(String(err))); }
  if (failure) throw new Error(`RDF/XML: ${failure.message.split('\n')[0]}`);
  return out;
}
