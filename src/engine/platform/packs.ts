import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml, stringifyYaml } from '../context/Yaml';
import { layoutPath } from '../workspaceLayout';
import { Decision, DecisionStore, Proposer } from '../decisions/decisionStore';
import { BundleFile, PlatformBundlePayload, propose } from '../decisions/proposals';
import { analysisContext, analyzeSkill, importSkill, toolSkillsDir } from '../skills/port';
import { loadToolSkillStates, skillContentChecksum } from '../skills/lifecycle';
import { Catalog, checkOperation, checkPlatform, checksumOf, loadCatalog, readApprovals } from './operations/load';
import { ImplementationFile, Loaded, PlatformDefinition, PlatformOperation } from './operations/types';
import { onboardingState } from './onboarding';

/**
 * POP5c, packs (docs/specs/platform-operations.md §6.5): a team's platform definitions, operations, implementations
 * and skills, as a folder another workspace can import (a Git checkout works; AutoDE doesn't fetch it). Only what a
 * team approved or published goes in, and only the team's own files: never a connection, a secret, or AutoDE's own
 * files. A recorded example of an operation that reads row values stays out: it is a client's data. Importing
 * checks every file again, shows what it adds and changes, and files one decision; nothing runs until a person
 * approves it. Skills arrive as ported skills do: unreviewed drafts. An approved file is never replaced unless asked.
 */

export const PACK_FORMAT = 'autode-platform-pack/1';
export const PACK_MANIFEST = 'autode-pack.yaml';
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 5_000_000;

export interface PackItem { what: BundleFile['what']; id: string; file: string; checksum: string }
export interface PackSkill { name: string; dir: string; checksum: string }

export interface PackManifest {
  format: string;
  name: string;
  exportedAt: string;
  exportedBy: string;
  autode?: string;
  items: PackItem[];
  skills: PackSkill[];
  /** A statement by the exporting workspace, shown to the reviewer: who reviewed which platform's conformance. It proves nothing here. */
  reviewed?: Record<string, { by: string; at: string }>;
}

export interface ScopeWithResources { resourcesRoot?: string; workspaceRoot: string }

const folderOf: Record<PackItem['what'], string> = { platforms: 'platforms', operations: 'platform-operations', implementations: 'platform-implementations' };
const layoutOf = { platforms: 'platformDefinitions', operations: 'platformOperations', implementations: 'platformImplementations' } as const;

/** What looks like a credential in a file: a pack must never carry one. */
const SECRET_SHAPES: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}/, 'a bearer token'],
  [/\b(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"]?[^\s'"{}<,]{8,}/i, 'a credential value']
];

export function secretIn(text: string): string | undefined {
  return SECRET_SHAPES.find(([p]) => p.test(text))?.[1];
}

export interface ExportOptions { out: string; name: string; platforms?: string[]; by: string; autode?: string; now?: Date }
export interface ExportResult { manifest: PackManifest; out: string }

export class PackError extends Error {
  public constructor(public readonly problems: string[]) { super(problems.join(' ')); this.name = 'PackError'; }
}

const isTeam = <T>(l: Loaded<T>) => l.origin === 'team';

/** The skills a platform's pack carries: the workspace's published ones named for it. */
function publishedSkills(scope: ScopeWithResources, platforms: readonly string[]) {
  const prefixes = platforms.map((p) => `${p.replace(/_/g, '-')}-`);
  return loadToolSkillStates(toolSkillsDir(scope.workspaceRoot), 'autode', { migrate: false }).filter((s) => s.sidecar.status === 'published' && (!platforms.length || prefixes.some((p) => s.skill.name.startsWith(p))));
}

function copyPlain(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name.startsWith('.autode')) continue;
    if (e.isDirectory()) copyPlain(path.join(from, e.name), path.join(to, e.name));
    else if (e.isFile()) fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
  }
}

/** Writes a pack. Refuses, with every reason at once, rather than leaving a file out silently. */
export function exportPack(scope: ScopeWithResources, o: ExportOptions): ExportResult {
  const catalog = loadCatalog(scope);
  const wanted = o.platforms ?? [];
  const problems: string[] = [];
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(o.name)) problems.push('A pack name is lower-case letters, digits, _ or -.');
  for (const p of wanted) if (!catalog.platforms.some((x) => x.item.id === p && isTeam(x))) problems.push(`${p} isn't a team platform: only a team's own files go in a pack.`);
  const forPlatform = (ids: string[]) => !wanted.length || ids.some((p) => wanted.includes(p));
  const platforms = catalog.platforms.filter((p) => isTeam(p) && forPlatform([p.item.id]));
  const operations = catalog.operations.filter((x) => isTeam(x) && forPlatform(Object.keys(x.item.platforms)));
  const implementations = catalog.implementations.filter((x) => forPlatform([x.item.platform]));
  for (const x of [...platforms, ...operations, ...implementations]) if (x.status !== 'approved') problems.push(`${x.file} is a draft: only what a person approved goes in a pack.`);
  for (const p of platforms) {
    const state = onboardingState(scope, p.item.id, catalog);
    if (state === 'trial') problems.push(`${p.item.id} is on trial: a person reviews a conformance run first.`);
  }
  const reading = (id: string) => operations.find((x) => x.item.id === id)?.item ?? catalog.operations.find((x) => x.item.id === id)?.item;
  for (const x of operations) if (x.item.content !== 'metadata' && x.item.example?.rows?.length) problems.push(`${x.file}: its recorded example holds rows of data. Replace them with made-up values, approve it again, then export.`);
  for (const x of implementations) if (reading(x.item.implements)?.content !== 'metadata' && x.item.example?.rows?.length) problems.push(`${x.file}: its recorded example holds rows of data. Replace them with made-up values, approve it again, then export.`);
  const items: Array<{ item: PackItem; text: string }> = [];
  const add = (what: PackItem['what'], l: Loaded<{ id: string }>) => {
    const text = fs.readFileSync(path.resolve(scope.workspaceRoot, l.file), 'utf8');
    const secret = secretIn(text);
    if (secret) problems.push(`${l.file} seems to hold ${secret}: a pack never carries a credential.`);
    items.push({ item: { what, id: l.item.id, file: `${folderOf[what]}/${path.basename(l.file)}`, checksum: l.checksum }, text });
  };
  platforms.forEach((x) => add('platforms', x));
  operations.forEach((x) => add('operations', x));
  implementations.forEach((x) => add('implementations', x));
  const skills = publishedSkills(scope, wanted);
  if (!items.length && !skills.length) problems.push('Nothing to export: the workspace has no approved team files for this selection.');
  if (fs.existsSync(o.out) && fs.readdirSync(o.out).length) problems.push(`${o.out} isn't empty: export into a new folder.`);
  if (problems.length) throw new PackError([...new Set(problems)]);
  for (const { item, text } of items) { const full = path.join(o.out, item.file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); }
  const packSkills: PackSkill[] = [];
  for (const s of skills) {
    const dir = `skills/${s.skill.name}`;
    copyPlain(s.skill.sourceDir, path.join(o.out, dir));
    packSkills.push({ name: s.skill.name, dir, checksum: skillContentChecksum(s.skill.sourceDir) });
  }
  const conformance = readApprovals(scope.workspaceRoot).conformance;
  const reviewed = Object.fromEntries(platforms.flatMap((p) => (conformance[p.item.id]?.checksum === p.checksum ? [[p.item.id, { by: conformance[p.item.id].by, at: conformance[p.item.id].at }]] : [])));
  const manifest: PackManifest = { format: PACK_FORMAT, name: o.name, exportedAt: (o.now ?? new Date()).toISOString(), exportedBy: o.by, ...(o.autode ? { autode: o.autode } : {}), items: items.map((x) => x.item), skills: packSkills, ...(Object.keys(reviewed).length ? { reviewed } : {}) };
  fs.mkdirSync(o.out, { recursive: true });
  fs.writeFileSync(path.join(o.out, PACK_MANIFEST), stringifyYaml(manifest));
  return { manifest, out: o.out };
}

export interface PackReport {
  ok: boolean;
  name?: string;
  from?: string;
  /** Files the workspace doesn't have. */
  adds: string[];
  /** Team files it would replace; an approved one is a conflict unless replacing is asked for. */
  replaces: string[];
  /** Already here, the same content. */
  same: string[];
  /** It would change what AutoDE ships, for this workspace. */
  overridesShipped: string[];
  skills: string[];
  /** The exporter's word for a conformance review, shown as such. */
  reviewed: string[];
  problems: string[];
  warnings: string[];
}

/** Every path a pack may use is the manifest's, inside the folder; links and anything else refuse it. */
function checkFolder(dir: string, manifest: PackManifest, problems: string[]): void {
  const allowed = new Set([PACK_MANIFEST, ...manifest.items.map((i) => i.file)]);
  const skillDirs = manifest.skills.map((s) => `${s.dir}/`);
  let count = 0;
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { problems.push(`${r} is a symbolic link: a pack is plain files.`); continue; }
      if (e.isDirectory()) { walk(r); continue; }
      if (++count > MAX_FILES) { problems.push(`More than ${MAX_FILES} files.`); return; }
      if (fs.statSync(path.join(dir, r)).size > MAX_FILE_BYTES) problems.push(`${r} is over ${MAX_FILE_BYTES} bytes.`);
      if (!allowed.has(r) && !skillDirs.some((d) => r.startsWith(d))) problems.push(`${r} isn't in the pack's manifest.`);
    }
  };
  walk('');
}

const safe = (p: string) => !!p && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.replace(/\\/g, '/').split('/').includes('..');

function readManifest(dir: string, problems: string[]): PackManifest | undefined {
  let raw: unknown;
  try { raw = parseYaml(fs.readFileSync(path.join(dir, PACK_MANIFEST), 'utf8')); } catch { problems.push(`${dir} has no readable ${PACK_MANIFEST}: it isn't a pack.`); return undefined; }
  const m = raw as PackManifest;
  if (!m || m.format !== PACK_FORMAT) { problems.push(`The pack's format is ${String(m?.format)}; this AutoDE reads ${PACK_FORMAT}.`); return undefined; }
  if (!Array.isArray(m.items) || !Array.isArray(m.skills ?? [])) { problems.push('The manifest has no list of items.'); return undefined; }
  m.skills = m.skills ?? [];
  const expected: Record<string, string> = { platforms: 'platforms/', operations: 'platform-operations/', implementations: 'platform-implementations/' };
  for (const i of m.items) if (!expected[i.what] || !safe(i.file) || !i.file.startsWith(expected[i.what]) || path.posix.basename(i.file).length === 0 || !/\.ya?ml$/.test(i.file)) problems.push(`The manifest's item ${String(i.file)} isn't a pack file.`);
  for (const s of m.skills) if (!safe(s.dir) || !s.dir.startsWith('skills/') || !/^[a-z0-9][a-z0-9-]*$/.test(s.name)) problems.push(`The manifest's skill ${String(s.name)} isn't a pack skill.`);
  return problems.length ? undefined : m;
}

/** Checks a pack against this workspace; writes nothing. */
export function inspectPack(scope: ScopeWithResources, dir: string, options: { replace?: boolean } = {}, catalog: Catalog = loadCatalog(scope)): PackReport {
  const r: PackReport = { ok: false, adds: [], replaces: [], same: [], overridesShipped: [], skills: [], reviewed: [], problems: [], warnings: [] };
  const m = readManifest(dir, r.problems);
  if (!m) return r;
  r.name = m.name; r.from = m.exportedBy;
  checkFolder(dir, m, r.problems);
  if (r.problems.length) return r;
  const approved = new Map(catalog.platforms.filter((p) => p.status === 'approved').map((p) => [p.item.id, p.item] as const));
  const incoming: Array<{ item: PackItem; value: unknown }> = [];
  for (const item of m.items) {
    let text: string;
    try { text = fs.readFileSync(path.join(dir, item.file), 'utf8'); } catch { r.problems.push(`${item.file} is in the manifest but not in the pack.`); continue; }
    if (checksumOf(text) !== item.checksum) { r.problems.push(`${item.file} changed after the pack was exported.`); continue; }
    const secret = secretIn(text);
    if (secret) r.problems.push(`${item.file} seems to hold ${secret}.`);
    let value: unknown;
    try { value = parseYaml(text); } catch (err) { r.problems.push(`${item.file}: ${err instanceof Error ? err.message : String(err)}`); continue; }
    incoming.push({ item, value });
    if (item.what === 'platforms') approved.set((value as PlatformDefinition).id, value as PlatformDefinition);
  }
  const opIds = new Set(incoming.filter((x) => x.item.what === 'operations').map((x) => (x.value as PlatformOperation).id));
  for (const { item, value } of incoming) {
    if (item.what === 'platforms') r.problems.push(...checkPlatform(value as PlatformDefinition).map((e) => `${item.file}: ${e}`));
    if (item.what === 'operations') r.problems.push(...checkOperation(value as PlatformOperation, approved).map((e) => `${item.file}: ${e}`));
    if (item.what === 'implementations') {
      const f = value as ImplementationFile;
      const base = catalog.operations.find((o) => o.item.id === f.implements && o.status === 'approved')?.item;
      if (!base && !opIds.has(f.implements)) r.problems.push(`${item.file}: this workspace has no operation ${f.implements} to add to.`);
      else if (base) r.problems.push(...checkOperation({ ...base, platforms: { [f.platform]: f.implementation }, example: f.example ? { ...f.example, platform: f.platform } : undefined } as PlatformOperation, approved).map((e) => `${item.file}: ${e}`));
    }
    const target = targetFile(scope, item);
    const here = fs.existsSync(target) ? checksumOf(fs.readFileSync(target, 'utf8')) : undefined;
    const shipped = item.what === 'platforms' ? catalog.platforms.some((p) => p.item.id === item.id && p.origin === 'shipped') : item.what === 'operations' ? catalog.operations.some((o) => o.item.id === item.id && o.origin === 'shipped') : false;
    if (shipped) r.overridesShipped.push(item.id);
    if (here === undefined) r.adds.push(item.id);
    else if (here === item.checksum) r.same.push(item.id);
    else {
      r.replaces.push(item.id);
      const loaded = [...catalog.platforms, ...catalog.operations, ...catalog.implementations].find((x) => path.resolve(scope.workspaceRoot, x.file) === target);
      if (loaded?.status === 'approved' && !options.replace) r.problems.push(`${item.id} is approved here with other content: importing would stop it running until a person approves the pack. Ask to replace it, knowingly.`);
    }
  }
  for (const s of m.skills) {
    if (!fs.existsSync(path.join(dir, s.dir, 'SKILL.md'))) { r.problems.push(`${s.dir} has no SKILL.md.`); continue; }
    if (skillContentChecksum(path.join(dir, s.dir)) !== s.checksum) r.problems.push(`${s.dir} changed after the pack was exported.`);
    const here = path.join(toolSkillsDir(scope.workspaceRoot), s.name);
    if (fs.existsSync(here) && skillContentChecksum(here) === s.checksum) { r.same.push(s.name); continue; }
    if (fs.existsSync(here) && !options.replace) r.problems.push(`A skill ${s.name} is already here with other content: ask to replace it (its review starts over).`);
    r.skills.push(s.name);
  }
  r.reviewed = Object.entries(m.reviewed ?? {}).map(([p, v]) => `${p}: ${m.exportedBy} says ${v.by} reviewed a conformance run on ${v.at}`);
  if (r.overridesShipped.length) r.warnings.push(`It replaces what AutoDE ships for this workspace: ${r.overridesShipped.join(', ')}.`);
  r.problems = [...new Set(r.problems)];
  r.ok = !r.problems.length;
  return r;
}

function targetFile(scope: ScopeWithResources, item: PackItem): string {
  return layoutPath(scope.workspaceRoot, layoutOf[item.what], path.posix.basename(item.file));
}

/** Copies a checked pack in and files the one decision; nothing runs until a person approves it. Skills arrive unreviewed. */
export function importPack(scope: ScopeWithResources & { resourcesRoot: string }, dir: string, proposer: Proposer, options: { replace?: boolean } = {}): { decision?: Decision; report: PackReport; files: BundleFile[]; skills: string[] } {
  const report = inspectPack(scope, dir, options);
  if (!report.ok) throw new PackError(report.problems);
  const m = readManifest(dir, [])!;
  const files: BundleFile[] = [];
  for (const item of m.items) {
    const target = targetFile(scope, item);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(dir, item.file), target);
    files.push({ what: item.what, id: item.id, file: path.relative(scope.workspaceRoot, target).split(path.sep).join('/'), checksum: item.checksum });
  }
  const by = proposer.client ?? proposer.host ?? 'pack import';
  const skills: string[] = [];
  for (const s of m.skills.filter((x) => report.skills.includes(x.name))) {
    const source = path.join(dir, s.dir);
    const analysis = analyzeSkill(source, '', analysisContext(scope.resourcesRoot, scope.workspaceRoot, dir));
    const imported = importSkill({ workspaceRoot: scope.workspaceRoot, stagedDir: source, analysis, provenance: { source: 'local', location: `pack ${m.name}` }, by, managementEnabled: true, replace: options.replace });
    skills.push(imported.id);
  }
  if (!files.length) return { report, files, skills };
  // What a reviewer must not miss goes first: the summary is cut short.
  const reason = `${report.overridesShipped.length ? `It replaces what AutoDE ships: ${report.overridesShipped.join(', ')}. ` : ''}Pack ${m.name} from ${m.exportedBy} (${m.exportedAt}).${report.reviewed.length ? ` ${report.reviewed.join('; ')}.` : ''}`;
  const payload: PlatformBundlePayload = { title: `Import pack ${m.name}`, reason, files };
  const decision = propose(new DecisionStore(scope.workspaceRoot), { workspaceRoot: scope.workspaceRoot, resourcesRoot: scope.resourcesRoot }, 'platform_bundle', payload, { proposedBy: proposer });
  return { decision, report, files, skills };
}

