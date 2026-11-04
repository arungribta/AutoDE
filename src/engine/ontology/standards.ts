import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { DecisionStore } from '../decisions/decisionStore';
import * as path from 'node:path';
import { parseYaml } from '../context/Yaml';
import { layoutPath } from '../workspaceLayout';
import { PackLicence } from './pack';
import { shippedDir, teamPacks } from './store';

/**
 * Industry standards AutoDE can onboard from (ONT1; docs/specs/context-layer.md §6.8): FIBO for banking, CIM for
 * utilities, BIAN for banking services, and any a team adds. A standard is **data**, `autode: standard/1`: who
 * publishes it, its industry and licence, the release it is pinned to, where its files are, and how to read them.
 * A new standard is a new file, never new code: a standard's quirks (which classes are datatypes, which property
 * holds a multiplicity) are reader settings in its file.
 *
 * Shipped in `ontologies/standards/`; a team's own in `.autode/config/standards/`, overriding a shipped one by id.
 * Nothing is fetched until a person asks to browse or onboard a standard (P6).
 */

export type StandardFormat = 'rdf' | 'openapi' | 'pack';

/** A rule on a source's items: an item is matched when its `property` (an IRI, or an OpenAPI key) has a value matching `value` (a regular expression). */
export interface MatchRule { property: string; value: string }

export interface ReaderSettings {
  /** The prefix of the pack's concept ids. */
  prefix?: string;
  /** RDF: classes that are datatypes or enumerations, not concepts (CIM: `cims:stereotype` CIMDatatype, Primitive, enumeration). */
  skipClasses?: MatchRule[];
  /** RDF: properties to leave out (CIM: association ends with `cims:AssociationUsed` No). */
  skipProperties?: MatchRule[];
  /** RDF: the property that holds a property's multiplicity (CIM: `cims:multiplicity`, `M:0..n`). */
  cardinalityProperty?: string;
  /** OpenAPI: a schema is a concept when one of its properties' `format` matches (BIAN: `class`), a datatype when it matches `datatypeFormat` (BIAN: `datatype`). */
  conceptFormat?: string;
  datatypeFormat?: string;
  /** OpenAPI: schemas whose name matches are enumerations, not concepts (BIAN: `values$`). */
  enumName?: string;
  /** Labels in title case, for a standard that writes them in lower case (FIBO). */
  labelCase?: 'title';
}

export interface StandardDefinition {
  autode: 'standard/1';
  id: string;
  title: string;
  publisher: string;
  industry: string;
  description?: string;
  home?: string;
  licence: PackLicence;
  format: StandardFormat;
  /** The pinned release: a tag, or a commit for a repository without tags. */
  release: { version: string; ref: string; date?: string };
  /** Where its files are: a Git repository (fetched on request, only `path`), or a pack AutoDE ships. */
  source?: { git?: string; path?: string | string[] };
  /** A pack AutoDE ships, generated from this standard (scripts/build-ontology-pack.cjs). */
  pack?: string;
  reader?: ReaderSettings;
  /** For the pack generator: where a class's module file is, by its IRI (a regular expression and a file under the repository, or a URL; `$1` …). */
  modules?: Array<{ iri: string; file?: string; url?: string; accept?: string }>;
}

export interface LoadedStandard { def?: StandardDefinition; file: string; origin: 'shipped' | 'team'; errors: string[] }

const ID = /^[a-z0-9][a-z0-9-]*$/;

export function parseStandard(text: string): { def?: StandardDefinition; errors: string[] } {
  let raw: unknown;
  try { raw = parseYaml(text); } catch (err) { return { errors: [`not YAML: ${err instanceof Error ? err.message : String(err)}`] }; }
  const r = (raw ?? {}) as Partial<StandardDefinition>;
  const errors: string[] = [];
  if (r.autode !== 'standard/1') errors.push('autode must be standard/1');
  if (!ID.test(String(r.id ?? ''))) errors.push('id is a slug: lower-case letters, digits and dashes');
  for (const k of ['title', 'publisher', 'industry'] as const) if (typeof r[k] !== 'string' || !r[k]) errors.push(`${k} is required`);
  if (!r.licence || !['allowed', 'forbidden', 'unknown'].includes(String(r.licence.redistribution))) errors.push('licence needs name and redistribution: allowed | forbidden | unknown');
  if (!['rdf', 'openapi', 'pack'].includes(String(r.format))) errors.push('format is rdf, openapi or pack');
  if (!r.release || typeof r.release.version !== 'string' || typeof r.release.ref !== 'string') errors.push('release needs version and ref (a tag or a commit: a standard is always pinned)');
  if (!r.pack && !r.source?.git) errors.push('give source.git (and source.path), or pack');
  if (r.source?.git && !/^(https:\/\/|git@|ssh:\/\/|file:\/\/)/.test(r.source.git)) errors.push('source.git is a Git URL (https://, git@, ssh:// or file://)');
  for (const p of Array.isArray(r.source?.path) ? r.source!.path : r.source?.path ? [r.source.path] : []) if (typeof p !== 'string' || p.split('/').includes('..') || path.isAbsolute(p)) errors.push('source.path is a folder (or a list of folders) inside the repository');
  for (const rule of [...(r.reader?.skipClasses ?? []), ...(r.reader?.skipProperties ?? [])]) { try { new RegExp(rule.value); } catch { errors.push(`reader rule ${rule.property}: ${rule.value} isn't a regular expression`); } }
  return errors.length ? { errors } : { def: r as StandardDefinition, errors: [] };
}

function readDir(dir: string, origin: LoadedStandard['origin'], rel: (f: string) => string): LoadedStandard[] {
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort(); } catch { return []; }
  return files.map((f) => { const p = parseStandard(fs.readFileSync(path.join(dir, f), 'utf8')); return { ...(p.def ? { def: p.def } : {}), file: rel(f), origin, errors: p.errors }; });
}

/** The standards catalog: shipped and the team's, a team's definition overriding a shipped one by id. */
export function loadStandards(scope: { workspaceRoot: string; resourcesRoot?: string }): LoadedStandard[] {
  const shipped = shippedDir(scope.resourcesRoot);
  const a = shipped ? readDir(path.join(shipped, 'standards'), 'shipped', (f) => `ontologies/standards/${f}`) : [];
  const teamDir = layoutPath(scope.workspaceRoot, 'standards');
  const b = readDir(teamDir, 'team', (f) => path.relative(scope.workspaceRoot, path.join(teamDir, f)).split(path.sep).join('/'));
  const byId = new Map<string, LoadedStandard>();
  for (const l of [...a, ...b]) byId.set(l.def?.id ?? l.file, l);
  return [...byId.values()].sort((x, y) => (x.def?.title ?? x.file).localeCompare(y.def?.title ?? y.file));
}

export function findStandard(scope: { workspaceRoot: string; resourcesRoot?: string }, id: string): StandardDefinition | undefined {
  return loadStandards(scope).find((l) => l.def?.id === id)?.def;
}

export interface StandardStatus {
  id: string; title: string; publisher: string; industry: string; description?: string; home?: string;
  licence: PackLicence; format: StandardFormat; release: StandardDefinition['release'];
  /** `proposed`: waiting for a person's approval (decision), which a person can try first. */
  origin: 'shipped' | 'team' | 'proposed'; file: string; decision?: string; reason?: string;
  /** How a person gets it: a pack AutoDE ships (no download), or the standard's repository, fetched on request. */
  availability: 'shipped-pack' | 'on-request';
  source?: string;
  /** The team packs onboarded from it, with their concept counts. */
  onboarded: Array<{ pack: string; state: string; concepts: number }>;
  errors: string[];
}

/** Every standard with how it can be had and what the team onboarded from it. */
export function standardsCatalog(scope: { workspaceRoot: string; resourcesRoot?: string }): StandardStatus[] {
  const team = teamPacks(scope.workspaceRoot);
  const proposed = pendingStandards(scope.workspaceRoot).filter((p) => p.def).map((p) => ({ def: p.def!, file: `.autode/decisions/${p.decision}.yaml`, origin: 'proposed' as const, errors: p.errors, decision: p.decision, reason: p.reason }));
  return [...loadStandards(scope).filter((l) => l.def).map((l) => ({ ...l, decision: undefined as string | undefined, reason: undefined as string | undefined })), ...proposed].map((l) => {
    const d = l.def!;
    const onboarded = team.filter((t) => t.pack && (t.pack.id === d.pack || t.pack.id === d.id || (t.pack.standard?.name ?? '').toLowerCase() === d.title.toLowerCase() || (t.pack.standard?.name ?? '').toLowerCase() === d.id))
      .map((t) => ({ pack: t.pack!.id, state: t.state, concepts: t.pack!.concepts.length }));
    return {
      id: d.id, title: d.title, publisher: d.publisher, industry: d.industry, ...(d.description ? { description: d.description } : {}), ...(d.home ? { home: d.home } : {}),
      licence: d.licence, format: d.format, release: d.release, origin: l.origin, file: l.file, ...(l.decision ? { decision: l.decision } : {}), ...(l.reason ? { reason: l.reason } : {}),
      availability: d.pack ? 'shipped-pack' : 'on-request',
      ...(d.source?.git ? { source: `${d.source.git}${d.source.path ? ` (${[d.source.path].flat().join(', ')})` : ''} @ ${d.release.ref}` } : {}),
      onboarded, errors: l.errors
    };
  });
}

// A team's standard, proposed by an agent or a person and approved as a decision (kind `standard`).

export interface StandardPayload {
  /** The standard's id; its file is `.autode/config/standards/<id>.yaml`. */
  id: string;
  /** The definition (`autode: standard/1`), as YAML. */
  content: string;
  /** Why the team needs it, and how the definition was researched (the publisher's page, the release, the licence). */
  reason: string;
}

export const teamStandardFile = (workspaceRoot: string, id: string) => path.join(layoutPath(workspaceRoot, 'standards'), `${id}.yaml`);

export function validateStandardPayload(p: StandardPayload, scope: { workspaceRoot: string; resourcesRoot?: string }): { errors: string[]; warnings: string[]; def?: StandardDefinition } {
  if (!p || typeof p.content !== 'string' || typeof p.id !== 'string') return { errors: ['give id, content (the standard/1 definition) and reason'], warnings: [] };
  const parsed = parseStandard(p.content);
  if (!parsed.def) return { errors: parsed.errors, warnings: [] };
  const errors: string[] = [];
  const warnings: string[] = [];
  if (parsed.def.id !== p.id) errors.push(`The definition's id is ${parsed.def.id}, not ${p.id}.`);
  if (!p.reason || p.reason.trim().length < 20) errors.push('Say why the team needs it and where the definition comes from (the publisher\'s page, the release, the licence): at least a sentence.');
  if (parsed.def.pack) errors.push('A team standard has no shipped pack: give source.git (and source.path) at a pinned release.');
  if (/^[0-9a-f]{7,39}$/.test(parsed.def.release.ref)) errors.push('release.ref is a full commit id (40 characters) or a tag.');
  const shipped = loadStandards(scope).find((l) => l.origin === 'shipped' && l.def?.id === p.id);
  if (shipped) warnings.push(`It replaces AutoDE's ${shipped.def!.title} for this workspace.`);
  if (parsed.def.licence.redistribution !== 'allowed') warnings.push(`Its licence (${parsed.def.licence.name}) doesn't allow redistribution: what is onboarded from it stays in this workspace.`);
  return { errors, warnings, def: parsed.def };
}

/** Writes the approved definition: the standard is in the catalog from now on. */
export function applyStandardPayload(p: StandardPayload, scope: { workspaceRoot: string; resourcesRoot?: string }): { file: string; errors: string[] } {
  const v = validateStandardPayload(p, scope);
  if (v.errors.length) return { file: '', errors: v.errors };
  const file = teamStandardFile(scope.workspaceRoot, p.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, p.content.endsWith('\n') ? p.content : `${p.content}\n`);
  return { file, errors: [] };
}

/** The team file's current content hash (`none` when there is none): what a proposal is made against. */
export function standardRevision(workspaceRoot: string, id: string): string {
  try { return createHash('sha256').update(fs.readFileSync(teamStandardFile(workspaceRoot, id), 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 16); } catch { return 'none'; }
}

/** Pending proposals of standards, for the catalog (a person can try one before approving it). */
export function pendingStandards(workspaceRoot: string): Array<{ decision: string; def?: StandardDefinition; reason: string; proposedBy?: string; errors: string[] }> {
  const store = new DecisionStore(workspaceRoot);
  return store.list({ status: 'pending', kind: 'standard' }).map((d) => {
    const p = store.proposal<StandardPayload>(d.id);
    const parsed = parseStandard(p?.content ?? '');
    return { decision: d.id, ...(parsed.def ? { def: parsed.def } : {}), reason: p?.reason ?? '', ...(d.proposedBy ? { proposedBy: [d.proposedBy.host, d.proposedBy.client].filter(Boolean).join(' ') } : {}), errors: parsed.errors };
  });
}
