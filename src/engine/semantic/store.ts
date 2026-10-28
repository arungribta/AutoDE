import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml, stringifyYaml } from '../context/Yaml';
import { layoutPath, outputDirSegments } from '../workspaceLayout';
import { lineDiff } from '../skills/port';
import { problemMode } from '../documents/problemMode';
import { SemanticModel, parseSemanticModel, semanticRevision, serializeSemanticModel } from './model';
import { Composite, SharedSource, isCompositeText, parseComposite, resolveComposite, serializeResolved } from './composite';
import { SemanticFinding } from './checks';
import { LoadedModel, SemanticLayerIndex, indexSemanticLayer } from './layer';

/**
 * The semantic layer's files (C5a; docs/context-layer-requirements.md §6.2):
 * shared models in `<artifactDirectory>/semantic/<subject>.yaml`, each
 * problem's composites in `<artifactDirectory>/<problem>/semantic/<name>.yaml`
 * with their resolved `<name>.resolved.yaml`, and AutoDE's metadata — the
 * facts behind drafted elements, approvals, the shared revisions a composite
 * was resolved from — in `.autode/semantic/`, so the deliverables stay
 * deployable as they are.
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** The deliverables folder: the `artifactDirectory` setting from `.vscode/settings.json`, else the default. */
export function configuredOutputDir(workspaceRoot: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(workspaceRoot, '.vscode', 'settings.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
    const v = (JSON.parse(raw) as Record<string, unknown>)['autoDataEngineeringHub.artifactDirectory'];
    return typeof v === 'string' && v.trim() ? v : undefined;
  } catch { return undefined; }
}

export interface SemanticPaths { sharedDir: string; compositeDir: (problemId: string) => string; sidecar: string }

export function semanticPaths(workspaceRoot: string, outputDir = configuredOutputDir(workspaceRoot)): SemanticPaths {
  const base = outputDirSegments('_', outputDir).slice(0, -1);
  return {
    sharedDir: path.join(workspaceRoot, ...base, 'semantic'),
    compositeDir: (problemId) => path.join(workspaceRoot, ...base, problemId, 'semantic'),
    sidecar: layoutPath(workspaceRoot, 'semantic')
  };
}

export interface Approval { by: string; at: string; revision: string; channel: string }

interface SharedMeta { model: string; approved?: Approval; backing?: Record<string, string[]>; draftedAt?: string; notes?: string[] }
interface CompositeMeta { problem: string; composite: string; compositeRevision?: string; resolvedFrom?: Record<string, string>; resolvedRevision?: string; approved?: Approval }

function readMeta<T>(file: string): T | undefined {
  try { return parseYaml(fs.readFileSync(file, 'utf8')) as T; } catch { return undefined; }
}
function writeMeta(file: string, meta: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# AutoDE semantic-layer metadata (not deployed)\n' + stringifyYaml(meta));
}
const sharedMetaFile = (p: SemanticPaths, name: string) => path.join(p.sidecar, 'shared', `${name}.yaml`);
const compositeMetaFile = (p: SemanticPaths, problemId: string, name: string) => path.join(p.sidecar, 'composites', problemId, `${name}.yaml`);

const yamlFiles = (dir: string) => { try { return fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f) && !/\.resolved\.ya?ml$/i.test(f)).sort(); } catch { return []; } };

export type SharedStatus = 'approved' | 'changed' | 'unapproved' | 'invalid';

export interface SharedEntry {
  name: string;
  file: string;
  revision: string;
  model?: SemanticModel;
  errors: string[];
  warnings: string[];
  status: SharedStatus;
  approved?: Approval;
  backing?: Record<string, string[]>;
}

export function readShared(workspaceRoot: string, name: string, p = semanticPaths(workspaceRoot)): SharedEntry | undefined {
  const file = [`${name}.yaml`, `${name}.yml`].map((f) => path.join(p.sharedDir, f)).find((f) => fs.existsSync(f));
  if (!file) return undefined;
  const text = fs.readFileSync(file, 'utf8');
  const parsed = parseSemanticModel(text);
  const meta = readMeta<SharedMeta>(sharedMetaFile(p, name));
  const revision = semanticRevision(text);
  const status: SharedStatus = parsed.errors.length ? 'invalid' : !meta?.approved ? 'unapproved' : meta.approved.revision === revision ? 'approved' : 'changed';
  return { name, file, revision, model: parsed.model, errors: parsed.errors, warnings: parsed.warnings, status, approved: meta?.approved, backing: meta?.backing };
}

export function listShared(workspaceRoot: string): SharedEntry[] {
  const p = semanticPaths(workspaceRoot);
  return yamlFiles(p.sharedDir).map((f) => readShared(workspaceRoot, f.replace(/\.ya?ml$/i, ''), p)).filter((x): x is SharedEntry => !!x);
}

/** The loader resolution uses: the shared model as it is now, with its revision. */
export function sharedLoader(workspaceRoot: string): (name: string) => SharedSource | undefined {
  return (name) => {
    const e = readShared(workspaceRoot, name);
    return e?.model ? { model: e.model, revision: e.revision } : undefined;
  };
}

export type CompositeStatus = 'resolved' | 'stale' | 'unresolved' | 'invalid';

export interface CompositeEntry {
  problemId: string;
  name: string;
  file: string;
  resolvedFile: string;
  composite?: Composite;
  errors: string[];
  status: CompositeStatus;
  /** Why it is stale: the shared models (or the composite) changed since it was resolved. */
  staleBecause: string[];
  approved?: Approval;
  /** Whether the approval is for the current resolved file. */
  approvalCurrent: boolean;
}

function compositeEntry(workspaceRoot: string, problemId: string, name: string, p: SemanticPaths): CompositeEntry {
  const dir = p.compositeDir(problemId);
  const file = path.join(dir, `${name}.yaml`);
  const resolvedFile = path.join(dir, `${name}.resolved.yaml`);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const { composite, errors } = parseComposite(text);
  const meta = readMeta<CompositeMeta>(compositeMetaFile(p, problemId, name));
  const staleBecause: string[] = [];
  let status: CompositeStatus = errors.length ? 'invalid' : !meta?.resolvedFrom || !fs.existsSync(resolvedFile) ? 'unresolved' : 'resolved';
  if (status === 'resolved' && composite && meta?.resolvedFrom) {
    if (meta.compositeRevision && meta.compositeRevision !== semanticRevision(text)) staleBecause.push(`${name} changed since it was resolved`);
    for (const u of composite.uses) {
      const now = readShared(workspaceRoot, u.model, p);
      const then = meta.resolvedFrom[u.model];
      if (!now) staleBecause.push(`the shared model ${u.model} is gone`);
      else if (now.revision !== then) staleBecause.push(`the shared model ${u.model} changed (${then ?? 'not used before'} → ${now.revision})`);
    }
    if (staleBecause.length) status = 'stale';
  }
  const resolvedRevision = fs.existsSync(resolvedFile) ? semanticRevision(fs.readFileSync(resolvedFile, 'utf8')) : undefined;
  return { problemId, name, file, resolvedFile, composite, errors, status, staleBecause, approved: meta?.approved, approvalCurrent: !!meta?.approved && meta.approved.revision === resolvedRevision && status === 'resolved' };
}

/** The composites of a problem (or of every problem with a deliverables folder). */
export function listComposites(workspaceRoot: string, problemId?: string): CompositeEntry[] {
  const p = semanticPaths(workspaceRoot);
  const problems = problemId ? [problemId] : (() => { try { return fs.readdirSync(path.dirname(p.sharedDir), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'semantic').map((d) => d.name).sort(); } catch { return []; } })();
  return problems.flatMap((id) => yamlFiles(p.compositeDir(id)).filter((f) => isCompositeText(fs.readFileSync(path.join(p.compositeDir(id), f), 'utf8'))).map((f) => compositeEntry(workspaceRoot, id, f.replace(/\.ya?ml$/i, ''), p)));
}

export function readComposite(workspaceRoot: string, problemId: string, name: string): CompositeEntry | undefined {
  const p = semanticPaths(workspaceRoot);
  return fs.existsSync(path.join(p.compositeDir(problemId), `${name}.yaml`)) ? compositeEntry(workspaceRoot, problemId, name, p) : undefined;
}

export interface ResolveOutcome { ok: boolean; errors: string[]; resolvedFile: string; diff: string; changed: boolean; revisions: Record<string, string> }

/** Resolves a composite and writes `<name>.resolved.yaml` and its metadata; the diff against the previous resolution is returned. */
export function resolveCompositeFile(workspaceRoot: string, problemId: string, name: string): ResolveOutcome {
  const p = semanticPaths(workspaceRoot);
  const e = compositeEntry(workspaceRoot, problemId, name, p);
  if (!e.composite) return { ok: false, errors: e.errors.length ? e.errors : [`no composite ${name} in ${problemId}`], resolvedFile: e.resolvedFile, diff: '', changed: false, revisions: {} };
  const r = resolveComposite(e.composite, sharedLoader(workspaceRoot));
  if (!r.model) return { ok: false, errors: r.errors, resolvedFile: e.resolvedFile, diff: '', changed: false, revisions: r.revisions };
  const text = serializeResolved(e.composite, { ...r, model: r.model });
  const before = fs.existsSync(e.resolvedFile) ? fs.readFileSync(e.resolvedFile, 'utf8') : '';
  fs.mkdirSync(path.dirname(e.resolvedFile), { recursive: true });
  if (before !== text) fs.writeFileSync(e.resolvedFile, text);
  const metaFile = compositeMetaFile(p, problemId, name);
  const meta = readMeta<CompositeMeta>(metaFile);
  writeMeta(metaFile, { problem: problemId, composite: name, compositeRevision: semanticRevision(fs.readFileSync(e.file, 'utf8')), resolvedFrom: r.revisions, resolvedRevision: semanticRevision(text), ...(meta?.approved ? { approved: meta.approved } : {}) });
  return { ok: true, errors: [], resolvedFile: e.resolvedFile, diff: before ? lineDiff(before, text) : '', changed: before !== text, revisions: r.revisions };
}

/** Writes a shared model (a person's draft, or an approved proposal); with `approved`, the approval is recorded for the written revision. */
export function writeShared(workspaceRoot: string, name: string, text: string, extra: { approved?: Omit<Approval, 'revision'>; backing?: Record<string, string[]>; notes?: string[] } = {}): SharedEntry {
  if (!NAME.test(name)) throw new Error(`"${name}" is not a valid model name (letters, digits, _ and -).`);
  const p = semanticPaths(workspaceRoot);
  fs.mkdirSync(p.sharedDir, { recursive: true });
  const file = path.join(p.sharedDir, `${name}.yaml`);
  fs.writeFileSync(file, text);
  const metaFile = sharedMetaFile(p, name);
  const meta = readMeta<SharedMeta>(metaFile) ?? { model: name };
  writeMeta(metaFile, {
    ...meta, model: name,
    ...(extra.backing ? { backing: extra.backing, draftedAt: new Date().toISOString(), notes: extra.notes } : {}),
    ...(extra.approved ? { approved: { ...extra.approved, revision: semanticRevision(text) } } : {})
  });
  return readShared(workspaceRoot, name, p)!;
}

/** Writes a drafted model as a new shared model (refused if one exists: a draft never overwrites). */
export function writeDraft(workspaceRoot: string, name: string, model: SemanticModel, backing: Record<string, string[]>, notes: string[]): SharedEntry {
  if (readShared(workspaceRoot, name)) throw new Error(`The shared model ${name} exists: a draft never overwrites it. Open it and compare, or draft under another name.`);
  return writeShared(workspaceRoot, name, serializeSemanticModel(model, `Drafted by AutoDE from confirmed facts and the estate. Review it, then approve it (a person).`), { backing, notes });
}

export interface ApproveInput { by: string; channel: string; findings: readonly SemanticFinding[]; at?: Date }

/**
 * A person approves a shared model at its current revision: a workspace-level
 * act, refused while the model is invalid or its checks have errors.
 */
export function approveShared(workspaceRoot: string, name: string, input: ApproveInput): { ok: boolean; message: string } {
  const e = readShared(workspaceRoot, name);
  if (!e) return { ok: false, message: `No shared model ${name}.` };
  if (e.errors.length) return { ok: false, message: `${name} isn't a valid semantic model: ${e.errors.join('; ')}` };
  const errors = input.findings.filter((f) => f.severity === 'error');
  if (errors.length) return { ok: false, message: `${name} can't be approved: ${errors.map((f) => `${f.where}: ${f.message}`).join('; ')}` };
  const p = semanticPaths(workspaceRoot);
  const meta = readMeta<SharedMeta>(sharedMetaFile(p, name)) ?? { model: name };
  writeMeta(sharedMetaFile(p, name), { ...meta, approved: { by: input.by, at: (input.at ?? new Date()).toISOString(), revision: e.revision, channel: input.channel } });
  return { ok: true, message: `${name} approved by ${input.by} at revision ${e.revision}. Every problem that uses it sees this version.` };
}

/**
 * A person approves a composite within its problem, at its resolved
 * revision. Refused while it is stale or unresolved; failed checks refuse in
 * governed mode and only warn in exploration mode (they are returned).
 */
export function approveComposite(workspaceRoot: string, problemId: string, name: string, input: ApproveInput & { problemRoot: string }): { ok: boolean; message: string; warnings: string[] } {
  const e = readComposite(workspaceRoot, problemId, name);
  if (!e) return { ok: false, message: `No composite ${name} in ${problemId}.`, warnings: [] };
  if (e.status !== 'resolved') return { ok: false, message: `${name} is ${e.status}${e.staleBecause.length ? ` (${e.staleBecause.join('; ')})` : ''}: resolve it first.`, warnings: [] };
  const errors = input.findings.filter((f) => f.severity === 'error').map((f) => `${f.where}: ${f.message}`);
  const exploring = problemMode(input.problemRoot) === 'exploration';
  if (errors.length && !exploring) return { ok: false, message: `${name} can't be approved: ${errors.join('; ')}`, warnings: [] };
  const p = semanticPaths(workspaceRoot);
  const metaFile = compositeMetaFile(p, problemId, name);
  const meta = readMeta<CompositeMeta>(metaFile)!;
  writeMeta(metaFile, { ...meta, approved: { by: input.by, at: (input.at ?? new Date()).toISOString(), revision: semanticRevision(fs.readFileSync(e.resolvedFile, 'utf8')), channel: input.channel } });
  return { ok: true, message: `${name} approved by ${input.by}.${errors.length ? ` Exploration mode: ${errors.length} check(s) only warned.` : ''}`, warnings: exploring ? errors : [] };
}

/** What waits for a person in the semantic layer: shared models not approved at their current revision, stale composites. */
export function semanticWaiting(workspaceRoot: string, problemId?: string): Array<{ key: string; title: string; detail: string; file: string; cli: string }> {
  const out: Array<{ key: string; title: string; detail: string; file: string; cli: string }> = [];
  for (const s of listShared(workspaceRoot)) {
    if (s.status === 'approved') continue;
    out.push({ key: `semantic:${s.name}`, title: `Approve the shared semantic model ${s.name}`, detail: s.status === 'invalid' ? `It isn't valid: ${s.errors[0]}` : s.status === 'changed' ? `It changed since ${s.approved?.by} approved it; every problem that uses it is affected.` : 'Drafted or edited, never approved.', file: s.file, cli: `autode semantic approve ${s.name}` });
  }
  for (const c of listComposites(workspaceRoot, problemId)) {
    if (c.status === 'stale' || c.status === 'unresolved') out.push({ key: `semantic:${c.problemId}/${c.name}`, title: `Resolve the composite ${c.name}`, detail: c.status === 'stale' ? c.staleBecause.join('; ') : 'Not resolved yet.', file: c.file, cli: `autode semantic resolve ${c.name}` });
  }
  return out;
}

/** Reads the workspace's semantic layer: approved shared models and the problem's approved composites (as resolved). */
export function loadSemanticLayer(workspaceRoot: string, options: { problemId?: string; includeDrafts?: boolean } = {}): SemanticLayerIndex {
  const loaded: LoadedModel[] = [];
  for (const s of listShared(workspaceRoot)) {
    if (!s.model) continue;
    loaded.push({ name: s.name, source: 'shared', revision: s.revision, approved: s.status === 'approved', file: s.file, backing: s.backing, model: s.model });
  }
  if (options.problemId) {
    for (const c of listComposites(workspaceRoot, options.problemId)) {
      if (!fs.existsSync(c.resolvedFile)) continue;
      const text = fs.readFileSync(c.resolvedFile, 'utf8');
      const parsed = parseSemanticModel(text);
      if (!parsed.model) continue;
      loaded.push({ name: c.name, source: 'composite', problemId: c.problemId, revision: semanticRevision(text), approved: c.approvalCurrent, file: c.resolvedFile, model: parsed.model });
    }
  }
  return indexSemanticLayer(loaded, options);
}

/** The files the layer is read from, for callers that cache on them. */
export function semanticLayerFiles(workspaceRoot: string, problemId?: string): string[] {
  const out = listShared(workspaceRoot).map((s) => s.file);
  if (problemId) for (const c of listComposites(workspaceRoot, problemId)) out.push(c.file, c.resolvedFile);
  return out;
}
