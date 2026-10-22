import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseYaml } from '../context/Yaml';
import { layoutPath } from '../workspaceLayout';
import { loadRoles, loadSkillPack } from './definitions';
import { loadSkillsFromDirectory } from '../skills/skillRegistry';
import { loadToolSkillStates } from '../skills/lifecycle';

/**
 * The skill catalog (v0.45.5; owner, 2026-10-22): one view of every skill
 * AutoDE has or works with —
 * - **autode**: AutoDE's own skills (`skills/autode-*`), from their frontmatter;
 * - **workspace**: skills the team imported (`.autode/config/skills/tool-skills/`), with their review state;
 * - **interview**: the requirements-interview packs (`skills/*.json`), until they become skills;
 * - **external**: vendor and community skills, as references only (`skills/external.yaml`, a team's
 *   `.autode/config/external-skills.yaml` merged over it by id). No vendor skill text is copied.
 *
 * External install commands are data, not code: they are probed before being offered, a team can
 * correct them, and "installed" always means the skill was found in a host's skills folder.
 */

export type CatalogGroup = 'autode' | 'workspace' | 'interview' | 'external';

export interface Licence { name: string; url?: string; redistribution: boolean | 'check'; summary?: string }
export interface Installer {
  id: string; title?: string; command: string[]; probe?: string[]; minCliVersion?: string; versionCommand?: string[];
  hostAlternatives?: Record<string, string>; docs?: string; verifiedAt?: string; verifiedHow?: string;
}
export interface CatalogEntry {
  name: string;
  group: CatalogGroup;
  summary: string;
  stageKinds: string[];
  platforms: string[];
  scope?: string;
  version?: number | string;
  maturity?: string;
  owner?: string;
  /** Workspace skills: lifecycle and review state. */
  status?: string;
  /** AutoDE skills: the roles that use them. */
  roles?: string[];
  source?: string;
  licence?: Licence;
  availability?: 'installable' | 'host-only' | 'importable';
  installer?: Installer;
  /** External skills: where they were found (host skills folders), or that the host's command is on PATH. */
  installed?: string[];
}

interface ExternalFile {
  installers?: Record<string, Omit<Installer, 'id'>>;
  licences?: Record<string, Licence>;
  entries?: Array<{ id: string; vendor?: string; title?: string; source?: string; licence?: string; availability?: CatalogEntry['availability']; installer?: string; detect?: { command?: string }; summary?: string; usedFor?: { stageKinds?: string[]; platforms?: string[] } }>;
}

function readExternal(file: string): ExternalFile | undefined {
  try { return parseYaml(fs.readFileSync(file, 'utf8')) as ExternalFile; } catch { return undefined; }
}

/** Where hosts keep skills: the project's and the user's folders for Claude Code, the Copilot CLI and Cortex Code. */
export function hostSkillDirs(workspaceRoot: string, home: string): string[] {
  return [
    path.join(workspaceRoot, '.claude', 'skills'), path.join(workspaceRoot, '.github', 'skills'), path.join(workspaceRoot, '.cortex', 'skills'),
    path.join(home, '.claude', 'skills'), path.join(home, '.copilot', 'skills'), path.join(home, '.snowflake', 'cortex', 'skills')
  ];
}

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  const win = process.platform === 'win32';
  const dirs = (env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter(Boolean);
  const exts = win ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  return dirs.some((d) => exts.some((e) => { try { return fs.statSync(path.join(d, name + e)).isFile(); } catch { return false; } }));
}

/** The external references: AutoDE's list with the team's merged over it by id; and what is wrong with them. */
export function externalCatalog(resourcesRoot: string, workspaceRoot?: string): { entries: CatalogEntry[]; errors: string[]; detect: Map<string, string | undefined> } {
  const base = readExternal(path.join(resourcesRoot, 'skills', 'external.yaml')) ?? {};
  const team = workspaceRoot ? readExternal(path.join(layoutPath(workspaceRoot, 'config'), 'external-skills.yaml')) ?? {} : {};
  const installers = { ...(base.installers ?? {}), ...(team.installers ?? {}) };
  const licences = { ...(base.licences ?? {}), ...(team.licences ?? {}) };
  const byId = new Map<string, NonNullable<ExternalFile['entries']>[number]>();
  for (const e of [...(base.entries ?? []), ...(team.entries ?? [])]) if (e && e.id) byId.set(e.id, { ...(byId.get(e.id) ?? {}), ...e });
  const errors: string[] = [];
  const detect = new Map<string, string | undefined>();
  const entries = [...byId.values()].map((e) => {
    const lic = e.licence ? licences[e.licence] : undefined;
    if (!e.source) errors.push(`external ${e.id}: a source URL is required.`);
    if (!lic) errors.push(`external ${e.id}: licence "${e.licence ?? ''}" is not described under licences.`);
    if (!e.summary) errors.push(`external ${e.id}: a summary (in AutoDE's own words) is required.`);
    if (!['installable', 'host-only', 'importable'].includes(String(e.availability))) errors.push(`external ${e.id}: availability is installable, host-only or importable.`);
    const inst = e.installer ? installers[e.installer] : undefined;
    if (e.availability === 'installable' && !inst) errors.push(`external ${e.id}: installer "${e.installer ?? ''}" is not described under installers.`);
    if (inst && (!Array.isArray(inst.command) || !inst.command.length)) errors.push(`installer ${e.installer}: command must be an argument list.`);
    if (lic && lic.redistribution === false && e.availability === 'importable') errors.push(`external ${e.id}: its licence doesn't allow redistribution, so it can't be importable.`);
    detect.set(e.id, e.detect?.command);
    return {
      name: e.id, group: 'external' as const, summary: e.summary ?? '', stageKinds: e.usedFor?.stageKinds ?? [], platforms: e.usedFor?.platforms ?? [],
      owner: e.vendor, source: e.source, licence: lic, availability: e.availability, installer: inst && e.installer ? { id: e.installer, ...inst } : undefined
    } as CatalogEntry;
  });
  return { entries, errors, detect };
}

export interface CatalogInput { resourcesRoot: string; workspaceRoot: string; home: string; env?: NodeJS.ProcessEnv }

export function skillCatalog(input: CatalogInput): { entries: CatalogEntry[]; errors: string[] } {
  const env = input.env ?? process.env;
  const pack = loadSkillPack(input.resourcesRoot);
  const roles = loadRoles(input.resourcesRoot, input.workspaceRoot).roles;
  const errors = [...pack.errors];
  const own: CatalogEntry[] = pack.skills.map((k) => ({
    name: k.id, group: 'autode', summary: k.description, stageKinds: k.meta.stageKinds, platforms: k.meta.platforms, scope: k.meta.scope,
    version: k.meta.version, maturity: k.meta.maturity, owner: k.meta.owner, roles: roles.filter((r) => r.skills.includes(k.id)).map((r) => r.name)
  }));
  for (const r of roles) for (const s of r.skills) if (!pack.skills.some((k) => k.id === s)) errors.push(`role ${r.name} names skill ${s}, which AutoDE doesn't have.`);
  const workspace: CatalogEntry[] = loadToolSkillStates(layoutPath(input.workspaceRoot, 'toolSkills'), 'catalog', { migrate: false }).map((t) => ({
    name: t.skill.id, group: 'workspace', summary: t.skill.description ?? '', stageKinds: [], platforms: [], version: t.sidecar.version,
    status: `${t.sidecar.status ?? 'published'}, ${t.effectiveTier}${t.changedSinceReview ? ' (changed since review)' : ''}`, owner: (t.sidecar.provenance as { source?: string } | undefined)?.source ?? 'imported'
  }));
  let interview: CatalogEntry[] = [];
  try { interview = loadSkillsFromDirectory(path.join(input.resourcesRoot, 'skills')).map((s) => ({ name: s.id, group: 'interview', summary: s.description ?? s.name, stageKinds: ['specify'], platforms: ['any'], owner: 'AutoDE' })); } catch { /* none */ }
  const ext = externalCatalog(input.resourcesRoot, input.workspaceRoot);
  errors.push(...ext.errors);
  const dirs = hostSkillDirs(input.workspaceRoot, input.home);
  for (const e of ext.entries) {
    const cmd = ext.detect.get(e.name);
    if (cmd) e.installed = onPath(cmd, env) ? [`${cmd} on PATH`] : [];
    else e.installed = dirs.filter((d) => fs.existsSync(path.join(d, e.name, 'SKILL.md')));
  }
  return { entries: [...own, ...workspace, ...interview, ...ext.entries], errors };
}

function semverAtLeast(found: string, min: string): boolean {
  const n = (v: string) => (v.match(/\d+(\.\d+){0,2}/)?.[0] ?? '0').split('.').map(Number);
  const a = n(found), b = n(min);
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); }
  return true;
}

export type Runner = (argv: string[]) => { code: number | null; stdout: string; stderr: string; error?: string };

export const spawnRunner: Runner = (argv) => {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 15000, shell: false, windowsHide: true });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message };
};

/** Whether the installer's command still exists on this machine, before it is offered (never runs the install). */
export function probeInstaller(inst: Installer, run: Runner = spawnRunner): { ok: boolean; reason: string; version?: string } {
  if (inst.versionCommand?.length && inst.minCliVersion) {
    const v = run(inst.versionCommand);
    if (v.error || v.code !== 0) return { ok: false, reason: `${inst.versionCommand[0]} isn't installed or didn't answer (${v.error ?? v.stderr.trim().slice(0, 200)}). Install it first${inst.docs ? `; see ${inst.docs}` : ''}.` };
    const version = (v.stdout || v.stderr).match(/\d+\.\d+(\.\d+)?/)?.[0];
    if (version && !semverAtLeast(version, inst.minCliVersion)) return { ok: false, version, reason: `${inst.versionCommand[0]} ${version} is older than ${inst.minCliVersion}, which the install needs.` };
    if (inst.probe?.length) {
      const p = run(inst.probe);
      if (p.error || p.code !== 0) return { ok: false, version, reason: `\`${inst.probe.join(' ')}\` failed: the vendor may have changed how these skills are installed (AutoDE last verified it on ${inst.verifiedAt ?? 'an unknown date'}). See ${inst.docs ?? 'the vendor documentation'}.` };
    }
    return { ok: true, version, reason: `${inst.command.join(' ')} is available (${inst.versionCommand[0]} ${version ?? ''}).` };
  }
  if (inst.probe?.length) {
    const p = run(inst.probe);
    if (p.error || p.code !== 0) return { ok: false, reason: `\`${inst.probe.join(' ')}\` failed. See ${inst.docs ?? 'the vendor documentation'}.` };
  }
  return { ok: true, reason: `${inst.command.join(' ')} is available.` };
}

/** The catalog as Markdown, for docs/skills.md (generated by `npm run docs:generate`). */
export function renderCatalogMarkdown(entries: readonly CatalogEntry[]): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const lines: string[] = [];
  const own = entries.filter((e) => e.group === 'autode');
  lines.push('## AutoDE skills', '', 'Named `autode-<scope>-<capability>` (scopes: `core`, `de`, `snowflake`, `databricks`, `oracle`, `dbt`). Each declares its stage kinds and platforms in its `metadata`; a stage gets the skills for its kind and the problem\'s target platform.', '',
    '| Skill | Scope | Stage kinds | Platforms | Version | Maturity | Used by | What it does |', '|---|---|---|---|---|---|---|---|',
    ...own.map((e) => `| \`${e.name}\` | ${e.scope} | ${e.stageKinds.join(', ') || '—'} | ${e.platforms.join(', ')} | ${e.version} | ${e.maturity} | ${(e.roles ?? []).join(', ') || '—'} | ${esc(e.summary)} |`));
  const iv = entries.filter((e) => e.group === 'interview');
  if (iv.length) lines.push('', '## Interview packs', '', 'The requirements interview\'s parts (`skills/*.json`), offered over MCP as `autode_interview_<id>` prompts. They become `autode-de-*` skills when the business analyst moves to a role template.', '', '| Pack | What it covers |', '|---|---|', ...iv.map((e) => `| \`${e.name}\` | ${esc(e.summary)} |`));
  const ext = entries.filter((e) => e.group === 'external');
  lines.push('', '## External skills (references only)', '', 'Skills from vendors and the community that AutoDE works with. AutoDE does not copy or ship them: their licences are below. When one is installed in a host, AutoDE names it in the assignments of the stages it helps with. When it isn\'t, AutoDE can offer the vendor\'s own install command (probed first, run only on a click). Correct or add entries in `.autode/config/external-skills.yaml`.', '',
    '| Skill | Vendor | Availability | Stage kinds | Platforms | Licence | Redistributable | What it does |', '|---|---|---|---|---|---|---|---|',
    ...ext.map((e) => `| [\`${e.name}\`](${e.source}) | ${e.owner ?? ''} | ${e.availability} | ${e.stageKinds.join(', ')} | ${e.platforms.join(', ')} | ${e.licence?.url ? `[${esc(e.licence.name)}](${e.licence.url})` : esc(e.licence?.name ?? '')} | ${e.licence?.redistribution === true ? 'yes' : e.licence?.redistribution === 'check' ? 'check per skill' : 'no'} | ${esc(e.summary)} |`));
  const installers = [...new Map(ext.filter((e) => e.installer).map((e) => [e.installer!.id, e.installer!])).values()];
  if (installers.length) lines.push('', '### Installing', '', ...installers.flatMap((i) => [`- **${i.title ?? i.id}:** \`${i.command.join(' ')}\`${i.minCliVersion ? ` (needs ${i.versionCommand?.[0] ?? 'the CLI'} ${i.minCliVersion}+)` : ''}; last verified ${i.verifiedAt ?? '—'} ${i.verifiedHow ? `(${i.verifiedHow})` : ''}. ${i.docs ? `Vendor docs: ${i.docs}.` : ''}`, ...Object.entries(i.hostAlternatives ?? {}).map(([h, t]) => `  - ${h}: ${t}`)]));
  const licences = [...new Map(ext.filter((e) => e.licence).map((e) => [e.licence!.name, e.licence!])).values()];
  if (licences.length) lines.push('', '### Licences', '', ...licences.map((l) => `- **${l.name}**${l.url ? ` ([text](${l.url}))` : ''}: ${l.summary ?? ''}`));
  return lines.join('\n') + '\n';
}
