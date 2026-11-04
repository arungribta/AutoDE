#!/usr/bin/env node
/**
 * Builds a shipped ontology pack from its standard's own files (ONT1; docs/specs/context-layer.md §6.8).
 *
 * A curation file (`ontologies/sources/<pack>.curation.yaml`, `autode: ontology-curation/1`) says which concepts the
 * pack takes, by IRI, and what AutoDE adds: the placement under its upper layer, relations, attributes and hints.
 * This script reads the standard's modules at the pinned release, parses them with AutoDE's own RDF reader, fails if
 * any IRI isn't a class there, takes each concept's definition and synonyms from the standard, and writes
 * `ontologies/<pack>.yaml` with the release and the commit it was built from.
 *
 * A maintainer runs it when moving to a new release; it is never run at build or runtime (P6: AutoDE downloads
 * nothing on its own). `--from <folder>` reads a local copy of the standard instead of fetching.
 *
 *   npm run compile && node scripts/build-ontology-pack.cjs fibo-lending [--ref master_2026Q3] [--from <fibo clone>] [--cache <dir>] [--check]
 *
 * --check writes nothing: exit 1 if the committed pack differs from what the standard gives (a new release changed a
 * definition, or a concept moved).
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const need = (m) => { try { return require(path.join(root, 'dist', m)); } catch { console.error('Run npm run compile first.'); process.exit(2); } };
const { parseRdfXml } = need('engine/ontology/rdf.js');
const { classifyLicence } = need('engine/ontology/convert.js');
const { normalizePack, stringifyPack, parsePack, checkPacks } = need('engine/ontology/pack.js');
const { parseYaml } = need('engine/context/Yaml.js');

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const DEFINITIONS = ['http://www.w3.org/2004/02/skos/core#definition', 'http://www.w3.org/2000/01/rdf-schema#comment'];
const SYNONYM = /[#/](synonym|altLabel)$/;
const LICENCE = /[#/](license|rights)$/;

function args(argv) {
  const out = { pack: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (['--ref', '--from', '--cache'].includes(a)) out[a.slice(2)] = argv[++i];
    else { console.error(`Unknown option ${a}`); process.exit(2); }
  }
  if (!out.pack) { console.error('Usage: node scripts/build-ontology-pack.cjs <pack> [--ref <release>] [--from <folder>] [--cache <dir>] [--check]'); process.exit(2); }
  return out;
}

/** Where a class's module is: FIBO's in its repository at the release, OMG's (Commons, LCC) from OMG's site. */
function moduleOf(iri, std, ref) {
  const fibo = /^https:\/\/spec\.edmcouncil\.org\/fibo\/ontology\/(.+)\/[^/]+$/.exec(iri);
  if (fibo) return { key: `${fibo[1]}.rdf`, local: `${fibo[1]}.rdf`, url: `${std.repository.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/${ref}/${fibo[1]}.rdf` };
  const omg = /^(https:\/\/www\.omg\.org\/spec\/.+\/)[^/]+$/.exec(iri);
  if (omg) return { key: omg[1], url: omg[1], accept: 'application/rdf+xml', external: true };
  throw new Error(`${iri}: no known place to read its module from.`);
}

function fetchTo(url, file, accept) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('curl', ['-sS', '-f', '-L', ...(accept ? ['-H', `Accept: ${accept}`] : []), '-o', file, url], { stdio: ['ignore', 'ignore', 'inherit'] });
}

const titleCase = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
const english = (ts) => (ts.find((t) => !t.lang || /^en\b/i.test(t.lang)) ?? ts[0])?.o.trim().replace(/\s+/g, ' ');

function main() {
  const o = args(process.argv.slice(2));
  const curFile = path.join(root, 'ontologies', 'sources', `${o.pack}.curation.yaml`);
  const cur = parseYaml(fs.readFileSync(curFile, 'utf8'));
  if (cur.autode !== 'ontology-curation/1') throw new Error(`${curFile}: autode must be ontology-curation/1`);
  const std = cur.standard;
  const ref = o.ref ?? std.version;
  const cache = o.cache ? path.resolve(o.cache) : fs.mkdtempSync(path.join(os.tmpdir(), 'autode-ontology-'));
  const triplesOf = new Map();
  let commit;
  if (!o.from && /github\.com/.test(std.repository)) {
    // The commit the release tag names, recorded in the pack.
    try { commit = JSON.parse(execFileSync('curl', ['-sS', '-f', `${std.repository.replace('https://github.com/', 'https://api.github.com/repos/')}/commits/${ref}`], { encoding: 'utf8', maxBuffer: 1 << 26 })).sha; } catch { /* left out */ }
  }
  const read = (iri) => {
    const m = moduleOf(iri, std, ref);
    if (triplesOf.has(m.key)) return triplesOf.get(m.key);
    let file;
    if (o.from && m.local) file = path.join(path.resolve(o.from), m.local);
    else { file = path.join(cache, m.key.replace(/[^A-Za-z0-9._-]+/g, '_')); if (!fs.existsSync(file)) fetchTo(m.url, file, m.accept); }
    const t = parseRdfXml(fs.readFileSync(file, 'utf8'), m.url);
    const entry = { triples: t, external: !!m.external, url: m.url };
    triplesOf.set(m.key, entry);
    return entry;
  };
  const problems = [];
  const licences = new Set();
  const concepts = cur.concepts.map((c) => {
    const m = read(c.iri);
    const about = m.triples.filter((t) => t.s === c.iri);
    if (!about.some((t) => t.p === RDF_TYPE && t.o === OWL_CLASS)) { problems.push(`${c.id}: ${c.iri} is not a class in ${m.url}`); return undefined; }
    for (const t of m.triples) if (LICENCE.test(t.p) && t.literal) licences.add(classifyLicence(t.o).redistribution);
    const label = english(about.filter((t) => t.p === RDFS_LABEL && t.literal));
    const definition = DEFINITIONS.map((p) => english(about.filter((t) => t.p === p && t.literal))).find(Boolean);
    if (!definition) problems.push(`${c.id}: the standard gives no definition`);
    const synonyms = [...new Set([...(c.synonyms ?? []), ...about.filter((t) => SYNONYM.test(t.p) && t.literal && (!t.lang || /^en\b/i.test(t.lang))).map((t) => t.o.trim())])]
      .filter((s) => s.toLowerCase() !== (c.label ?? label ?? '').toLowerCase());
    const module = c.iri.replace(/^https:\/\/spec\.edmcouncil\.org\/fibo\/ontology\//, '').replace(/^https:\/\/www\.omg\.org\/spec\//, '').replace(/\/[^/]+$/, '');
    return { id: c.id, label: c.label ?? titleCase(label ?? c.id.split(':')[1]), iri: c.iri, parent: c.parent, ...(definition ? { definition } : {}), ...(synonyms.length ? { synonyms } : {}), ...(c.relations ? { relations: c.relations } : {}), ...(c.attributes ? { attributes: c.attributes } : {}), ...(c.hints ? { hints: c.hints } : {}), module };
  });
  if (licences.has('forbidden') || licences.has('unknown')) problems.push(`A module's licence isn't one that allows redistribution (${[...licences].join(', ')}): the pack can't ship.`);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  const pack = normalizePack({
    autode: 'ontology-pack/1', ...cur.pack, distribution: 'shareable',
    standard: { name: std.name, version: ref, iri: std.iri, licence: std.licence },
    source: { kind: 'shipped', ref: `${std.repository}/tree/${ref}`, ...(commit ? { commit } : {}) },
    concepts
  });
  const upper = parsePack(fs.readFileSync(path.join(root, 'ontologies', 'upper.yaml'), 'utf8')).pack;
  const checks = checkPacks([upper, pack]);
  if (checks.size) { console.error([...checks.values()].flat().join('\n')); process.exit(1); }
  const header = `# AutoDE ontology pack (ontology-pack/1; docs/specs/context-layer.md §6.8). GENERATED by scripts/build-ontology-pack.cjs\n# from ontologies/sources/${o.pack}.curation.yaml and ${std.name} ${ref}${commit ? ` (${commit.slice(0, 12)})` : ''}: edit the curation, not this file.\n# A source to onboard from (autode ontology onboard ${o.pack}), never in effect by itself. Definitions and synonyms are ${std.name}'s (MIT).\n`;
  const text = header + stringifyPack(pack).replace(/^# AutoDE ontology pack.*\n/, '');
  const out = path.join(root, 'ontologies', `${o.pack}.yaml`);
  const external = [...triplesOf.values()].filter((m) => m.external).map((m) => m.url);
  if (o.check) {
    // The commit is where it was built from, not content: a check compares everything else.
    const strip = (t) => t.replace(/^# from .*\n/m, '').replace(/^\s+commit: .*\n/m, '');
    const same = fs.existsSync(out) && strip(fs.readFileSync(out, 'utf8').replace(/\r\n/g, '\n')) === strip(text);
    console.log(same ? `${o.pack}: up to date with ${std.name} ${ref}.` : `${o.pack}: differs from ${std.name} ${ref}; run without --check to rebuild it, and review the diff.`);
    process.exit(same ? 0 : 1);
  }
  fs.writeFileSync(out, text);
  console.log(`wrote ${path.relative(root, out)}: ${concepts.length} concepts from ${std.name} ${ref}${commit ? ` (${commit.slice(0, 12)})` : ''}, ${triplesOf.size} modules${external.length ? `; read from OMG's site at their current version: ${external.join(', ')}` : ''}.`);
}

try { main(); } catch (err) { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); }
