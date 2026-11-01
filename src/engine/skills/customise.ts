import * as fs from 'node:fs';
import * as path from 'node:path';
import { PackSkill, loadSkillPack, readPackSkill } from '../agents/definitions';
import { layoutPath } from '../workspaceLayout';
import { HISTORY_DIRNAME, ToolSkillSidecar, ToolSkillState, loadToolSkillStates, readSidecar, skillContentChecksum, writeSidecarFile } from './lifecycle';

/**
 * POP4b, Customise (docs/specs/platform-operations.md §6.3): a team copy of one of AutoDE's skills, under the same
 * id in the workspace's team skills folder. It goes through the skills' lifecycle (PA4) like an imported skill: a
 * draft, unreviewed once edited, in effect only when a person has reviewed and published it. Then it wins over
 * AutoDE's bundled skill everywhere AutoDE picks a skill (`skillsInEffect`).
 *
 * The copy keeps the AutoDE content it started from (`.autode-history/autode-base/`, outside the content checksum),
 * so a later AutoDE release that changes the original is flagged with both differences: AutoDE's change and the
 * team's. *Keep* records that the team has seen AutoDE's change; *Reset* archives the copy and removes it.
 */

export interface CustomiseScope { resourcesRoot: string; workspaceRoot: string }

const BASE_DIR = 'autode-base';

function teamDir(workspaceRoot: string, id: string): string {
  return layoutPath(workspaceRoot, 'toolSkills', id);
}

function copyContent(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name.startsWith('.autode')) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyContent(a, b); else fs.copyFileSync(a, b);
  }
}

function bundled(resourcesRoot: string, id: string): PackSkill | undefined {
  return loadSkillPack(resourcesRoot).skills.find((k) => k.id === id);
}

/** Whether a team skill folder is a copy of AutoDE's skill (rather than an imported one). */
export function isTeamCopy(skillDir: string): boolean {
  return readSidecar(skillDir)?.provenance.source === 'autode';
}

/**
 * Makes the team copy: AutoDE's content, a draft, reviewed for that exact content (it is AutoDE's own, reviewed with
 * the release); an edit makes it unreviewed until a person reviews it again. An existing copy is kept, never
 * overwritten; an imported skill with the same id is refused.
 */
export function customiseSkill(scope: CustomiseScope, id: string, by: string, now = new Date().toISOString()): { dir: string; created: boolean; sidecar: ToolSkillSidecar } {
  const k = bundled(scope.resourcesRoot, id);
  if (!k) throw new Error(`No AutoDE skill "${id}" (autode skills list --group autode).`);
  const dir = teamDir(scope.workspaceRoot, id);
  if (fs.existsSync(dir)) {
    const sc = readSidecar(dir);
    if (sc?.provenance.source === 'autode') return { dir, created: false, sidecar: sc };
    throw new Error(`The workspace already has an imported skill "${id}": it isn't a copy of AutoDE's. Rename or retire it first.`);
  }
  copyContent(k.dir, dir);
  copyContent(k.dir, path.join(dir, HISTORY_DIRNAME, BASE_DIR));
  const checksum = skillContentChecksum(dir);
  const sidecar: ToolSkillSidecar = {
    status: 'draft', version: 1, trustTier: 'reviewed',
    provenance: { source: 'autode', location: `skills/${id}`, contentChecksum: checksum, importedAt: now, base: { version: k.meta.version, checksum } },
    transitions: [
      { at: now, by, action: 'customise', to: 'draft', version: 1, checksum },
      { at: now, by: 'autode', action: 'review', from: 'unreviewed', to: 'reviewed', version: 1, checksum }
    ]
  };
  writeSidecarFile(dir, sidecar);
  return { dir, created: true, sidecar };
}

export interface FileChange { path: string; change: 'added' | 'removed' | 'changed' }

function listContent(dir: string, rel = ''): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => {
    if (e.name.startsWith('.autode')) return [];
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? listContent(dir, r) : [r];
  });
}

const read = (f: string) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

/** The files that differ between two skill folders (AutoDE's sidecar and history left out). */
export function contentChanges(before: string, after: string): FileChange[] {
  const a = new Set(listContent(before)), b = new Set(listContent(after));
  return [...new Set([...a, ...b])].sort().flatMap((p): FileChange[] => {
    if (!a.has(p)) return [{ path: p, change: 'added' }];
    if (!b.has(p)) return [{ path: p, change: 'removed' }];
    return read(path.join(before, p)) === read(path.join(after, p)) ? [] : [{ path: p, change: 'changed' }];
  });
}

export interface TeamCopyState {
  id: string;
  dir: string;
  file: string;
  state: ToolSkillState;
  /** In effect in place of AutoDE's: published and reviewed for its current content, with valid metadata. */
  inEffect: boolean;
  /** Why it isn't in effect, in words; and the next step. */
  why?: string;
  next: string;
  baseVersion: number;
  /** AutoDE's current version of the skill (absent: AutoDE no longer ships it). */
  autodeVersion?: number;
  /** AutoDE's skill changed since the copy was made or last kept. */
  upstreamChanged: boolean;
  /** What AutoDE changed since the base, and what the team changed. */
  autodeChanges: FileChange[];
  teamChanges: FileChange[];
  /** The copy's metadata or format problems (it isn't used while it has any). */
  errors: string[];
}

function copyState(scope: CustomiseScope, s: ToolSkillState): TeamCopyState {
  const id = s.skill.id;
  const dir = s.skill.sourceDir;
  const k = bundled(scope.resourcesRoot, id);
  const base = s.sidecar.provenance.base;
  const baseDir = path.join(dir, HISTORY_DIRNAME, BASE_DIR);
  const hasBase = fs.existsSync(path.join(baseDir, 'SKILL.md'));
  const autodeChecksum = k ? skillContentChecksum(k.dir) : undefined;
  const upstreamChanged = !k || (base ? autodeChecksum !== base.checksum : false);
  const parsed = readPackSkill(dir, id);
  const published = s.sidecar.status === 'published';
  const reviewed = s.effectiveTier !== 'unreviewed';
  const inEffect = !!k && published && reviewed && !parsed.errors.length;
  const why = !k ? 'AutoDE no longer ships this skill: the copy is used by nothing.'
    : parsed.errors.length ? `its SKILL.md has problems: ${parsed.errors.join(' ')}`
    : !reviewed ? (s.changedSinceReview ? 'it changed since it was reviewed' : 'it has not been reviewed')
    : !published ? 'it is a draft' : undefined;
  const next = !k ? `autode skills reset ${id}`
    : parsed.errors.length ? `fix ${path.relative(scope.workspaceRoot, path.join(dir, 'SKILL.md')).split(path.sep).join('/')}`
    : !reviewed ? `autode skills review ${id}, then autode skills publish ${id}`
    : !published ? `autode skills publish ${id}`
    : upstreamChanged ? `compare AutoDE's change (autode skills show ${id}), merge what you want, then autode skills keep ${id}; or autode skills reset ${id}`
    : 'nothing: the team copy is in effect';
  return {
    id, dir, file: path.join(dir, 'SKILL.md'), state: s, inEffect, ...(why ? { why } : {}), next,
    baseVersion: base?.version ?? k?.meta.version ?? 1, ...(k ? { autodeVersion: k.meta.version } : {}), upstreamChanged,
    autodeChanges: k && hasBase && upstreamChanged ? contentChanges(baseDir, k.dir) : [],
    teamChanges: hasBase ? contentChanges(baseDir, dir) : [],
    errors: parsed.errors
  };
}

/** Every team copy of an AutoDE skill in the workspace, with its state. */
export function teamCopies(scope: CustomiseScope): TeamCopyState[] {
  return loadToolSkillStates(layoutPath(scope.workspaceRoot, 'toolSkills'), 'catalog', { migrate: false })
    .filter((s) => s.sidecar.provenance.source === 'autode')
    .map((s) => copyState(scope, s));
}

export function teamCopy(scope: CustomiseScope, id: string): TeamCopyState | undefined {
  return teamCopies(scope).find((c) => c.id === id);
}

/**
 * The one rule (owner, 2026-10-29): AutoDE's skills, each replaced by the team's published, reviewed copy where
 * there is one. Every place AutoDE picks a skill uses this: stage assignments, interview parts, maintenance briefs,
 * MCP, the plugin install. A copy that can't be used (bad metadata) leaves AutoDE's in place, with the reason.
 */
export function skillsInEffect(resourcesRoot: string, workspaceRoot?: string): { skills: PackSkill[]; errors: string[] } {
  const pack = loadSkillPack(resourcesRoot);
  if (!workspaceRoot || !fs.existsSync(layoutPath(workspaceRoot, 'toolSkills'))) return pack;
  const errors = [...pack.errors];
  const copies = new Map(teamCopies({ resourcesRoot, workspaceRoot }).map((c) => [c.id, c] as const));
  const skills = pack.skills.map((k) => {
    const c = copies.get(k.id);
    if (!c) return k;
    if (c.state.sidecar.status === 'published' && c.errors.length) errors.push(`The team copy of ${k.id} isn't used (AutoDE's is): ${c.errors.join(' ')}`);
    if (!c.inEffect) return k;
    const r = readPackSkill(c.dir, k.id);
    return { ...r.skill!, meta: { ...r.skill!.meta, owner: 'team' }, teamCopy: { teamVersion: c.state.sidecar.version, baseVersion: c.baseVersion, autodeVersion: k.meta.version, upstreamChanged: c.upstreamChanged } };
  });
  return { skills, errors };
}

export interface SkillFrontmatterEdit { description?: string; stageKinds?: string[]; platforms?: string[] }

/**
 * A skill's text with its description and AutoDE metadata (stage kinds, platforms) set, for the catalog's metadata
 * form. Only those lines change, so the rest of the frontmatter keeps its layout (flow lists, comments).
 */
export function setSkillFrontmatter(text: string, edit: SkillFrontmatterEdit): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error('The skill has no frontmatter (--- lines at its top).');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('The skill\'s frontmatter has no closing --- line.');
  const fm = lines.slice(1, end);
  const scalar = (v: string) => /^[\w(][^:#]*$/.test(v) && !/\s$/.test(v) ? v : JSON.stringify(v);
  const flow = (xs: string[]) => `[${xs.join(', ')}]`;
  // Replaces a key's line and its continuation lines (more indented, or list items under it).
  const replace = (re: RegExp, indent: string, line: string): boolean => {
    const i = fm.findIndex((l) => re.test(l));
    if (i < 0) return false;
    let j = i + 1;
    while (j < fm.length && (fm[j].startsWith(`${indent}  `) || fm[j].startsWith(`${indent}- `) || (!indent && /^\s+\S/.test(fm[j]) && !/^\s+\w+\s*:/.test(fm[j]) && re.source.startsWith('^description')))) j++;
    fm.splice(i, j - i, line);
    return true;
  };
  if (edit.description !== undefined) {
    const line = `description: ${scalar(edit.description.trim())}`;
    if (!replace(/^description\s*:/, '', line)) fm.splice(1, 0, line);
  }
  for (const key of ['stageKinds', 'platforms'] as const) {
    const v = edit[key];
    if (!v) continue;
    const line = `  ${key}: ${flow(v)}`;
    if (replace(new RegExp(`^  ${key}\\s*:`), '  ', line)) continue;
    let m = fm.findIndex((l) => /^metadata\s*:/.test(l));
    if (m < 0) { fm.push('metadata:'); m = fm.length - 1; }
    fm.splice(m + 1, 0, line);
  }
  return ['---', ...fm, ...lines.slice(end)].join(nl);
}

/** Removes the team copy so AutoDE's skill is in effect again. The copy is archived under `.autode/local/reset-skills/`. */
export function resetSkill(scope: CustomiseScope, id: string, now = new Date()): { archived: string } {
  const dir = teamDir(scope.workspaceRoot, id);
  if (!fs.existsSync(dir)) throw new Error(`The workspace has no copy of ${id}: AutoDE's is already in effect.`);
  if (!isTeamCopy(dir)) throw new Error(`${id} is an imported skill, not a copy of AutoDE's: retire it instead.`);
  const archived = layoutPath(scope.workspaceRoot, 'local', 'reset-skills', `${id}-${now.toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.cpSync(dir, archived, { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
  return { archived };
}

/**
 * Keeps the team's copy after AutoDE's skill changed: the new AutoDE content becomes the base the copy is compared
 * with. The copy's own content doesn't change, so its review and publication stand.
 */
export function keepTeamCopy(scope: CustomiseScope, id: string, by: string, now = new Date().toISOString()): ToolSkillSidecar {
  const c = teamCopy(scope, id);
  if (!c) throw new Error(`The workspace has no copy of ${id}.`);
  const k = bundled(scope.resourcesRoot, id);
  if (!k) throw new Error(`AutoDE no longer ships ${id}: reset the copy (autode skills reset ${id}).`);
  if (!c.upstreamChanged) throw new Error(`AutoDE's ${id} hasn't changed since the copy was made or last kept.`);
  const baseDir = path.join(c.dir, HISTORY_DIRNAME, BASE_DIR);
  fs.rmSync(baseDir, { recursive: true, force: true });
  copyContent(k.dir, baseDir);
  const sc = c.state.sidecar;
  const updated: ToolSkillSidecar = {
    ...sc,
    provenance: { ...sc.provenance, base: { version: k.meta.version, checksum: skillContentChecksum(k.dir) } },
    transitions: [...sc.transitions, { at: now, by, action: 'keep', from: `autode v${c.baseVersion}`, to: `autode v${k.meta.version}`, version: sc.version, checksum: c.state.checksum }]
  };
  writeSidecarFile(c.dir, updated);
  return updated;
}
