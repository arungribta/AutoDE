import { STAGE_KINDS } from '../workflows/stageKinds';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml } from '../context/Yaml';
import { parseSkillMarkdown } from '../skills/toolSkills';
import { layoutPath } from '../workspaceLayout';

/**
 * AutoDE's agents and skills as definitions (PA3b, docs/mcp-engine-requirements.md
 * §9.2 PA3 §3–4):
 * - a **role template** (`agents/<role>.md`, Markdown with a small frontmatter:
 *   name, description, tools, skills) says who does a stage — reviewed, bundled,
 *   overridable per workspace in `.autode/config/agents/`;
 * - a **skill** (`skills/<id>/SKILL.md`, Agent Skills format) says how to do a task.
 * The planner adds a brief per stage; the method stays in the skills.
 */

export interface RoleTemplate {
  name: string;
  description: string;
  /** AutoDE engine tools this role may use — still capped by the stage's permission tier. */
  tools: string[];
  skills: string[];
  instructions: string;
  origin: string;
}

export interface PackSkill {
  id: string;
  name: string;
  description: string;
  allowedTools: string[];
  instructions: string;
  dir: string;
  /** Other files in the skill's folder (resources, templates), relative to it. */
  resources: string[];
  /** The registry fields from the skill's `metadata` (v0.45.5). */
  meta: SkillMeta;
}

/** AutoDE's registry fields, in the Agent Skills `metadata` map so the files stay standard. */
export interface SkillMeta {
  scope: string;
  /** The stage kinds the skill does (empty: AutoDE's own, e.g. the orchestrator). */
  stageKinds: string[];
  /** `any`, or the target platforms it is for. */
  platforms: string[];
  version: number;
  owner: string;
  /** `tested` skills have a fixture test in `npm test`; `preview` ones don't yet. */
  maturity: 'tested' | 'preview';
}

/** The naming convention of AutoDE's own skills (owner, 2026-10-22): `autode-<scope>-<capability>`. */
export const SKILL_SCOPES = ['core', 'de', 'snowflake', 'databricks', 'oracle', 'dbt'] as const;
export const SKILL_PLATFORMS = ['any', 'snowflake', 'databricks', 'oracle'] as const;
export const AUTODE_SKILL_NAME = new RegExp(`^autode-(${SKILL_SCOPES.join('|')})-[a-z0-9]+(-[a-z0-9]+)*$`);

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : []).map((x) => String(x).trim()).filter(Boolean);

/** The registry fields of a bundled skill, and what is wrong with them. */
export function skillMeta(name: string, metadata: Record<string, unknown> | undefined, stageKinds: readonly string[]): { meta: SkillMeta; errors: string[] } {
  const errors: string[] = [];
  const m = metadata ?? {};
  if (!AUTODE_SKILL_NAME.test(name)) errors.push(`name must follow autode-<scope>-<capability>, scope one of ${SKILL_SCOPES.join(', ')}.`);
  const scope = String(m.scope ?? name.split('-')[1] ?? '');
  if (scope !== name.split('-')[1]) errors.push(`metadata.scope "${scope}" must be the scope in the name.`);
  const kinds = listOf(m.stageKinds);
  for (const k of kinds) if (!stageKinds.includes(k)) errors.push(`metadata.stageKinds: unknown stage kind "${k}".`);
  const platforms = listOf(m.platforms);
  if (!platforms.length) errors.push('metadata.platforms is required (any, or the platforms it is for).');
  for (const p of platforms) if (!(SKILL_PLATFORMS as readonly string[]).includes(p)) errors.push(`metadata.platforms: unknown platform "${p}".`);
  if ((scope === 'snowflake' || scope === 'databricks' || scope === 'oracle') && !(platforms.length === 1 && platforms[0] === scope)) errors.push(`a ${scope} skill has platforms: [${scope}].`);
  const version = Number(m.version ?? 0);
  if (!Number.isInteger(version) || version < 1) errors.push('metadata.version must be a whole number, 1 or more.');
  const maturity = m.maturity === 'preview' ? 'preview' : m.maturity === 'tested' ? 'tested' : undefined;
  if (!maturity) errors.push('metadata.maturity is tested or preview.');
  return { meta: { scope, stageKinds: kinds, platforms, version, owner: String(m.owner ?? 'AutoDE'), maturity: maturity ?? 'preview' }, errors };
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const t = text.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(t);
  if (!m) return { data: {}, body: t.trim() };
  let data: Record<string, unknown> = {};
  try { const p = parseYaml(m[1]); if (p && typeof p === 'object' && !Array.isArray(p)) data = p as Record<string, unknown>; } catch { /* reported by the check */ }
  return { data, body: t.slice(m[0].length).trim() };
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).map((x) => x.trim()).filter(Boolean) : typeof v === 'string' ? v.split(/[,\s]+/).filter(Boolean) : []);

export function parseRole(text: string, origin: string): { role?: RoleTemplate; errors: string[] } {
  const { data, body } = frontmatter(text);
  const errors: string[] = [];
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!NAME.test(name)) errors.push('name must be lowercase words joined by dashes.');
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (!description) errors.push('description is required.');
  if (!body) errors.push('the role needs instructions (the Markdown body).');
  if (errors.length) return { errors };
  return { role: { name, description, tools: list(data.tools), skills: list(data.skills), instructions: body, origin }, errors };
}

/** Role templates: bundled `agents/*.md`, overridden or added by `.autode/config/agents/*.md` (by name). */
export function loadRoles(resourcesRoot: string, workspaceRoot?: string): { roles: RoleTemplate[]; errors: string[] } {
  const byName = new Map<string, RoleTemplate>();
  const errors: string[] = [];
  const dirs: Array<[string, string]> = [[path.join(resourcesRoot, 'agents'), 'bundled']];
  if (workspaceRoot) dirs.push([path.join(layoutPath(workspaceRoot, 'config'), 'agents'), 'workspace']);
  for (const [dir, origin] of dirs) {
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { continue; }
    for (const f of files) {
      const r = parseRole(fs.readFileSync(path.join(dir, f), 'utf8'), origin === 'bundled' ? 'bundled' : path.join(dir, f));
      if (r.role) {
        if (`${r.role.name}.md` !== f) errors.push(`${origin} agents/${f}: name "${r.role.name}" must match the file name.`);
        byName.set(r.role.name, r.role);
      } else errors.push(...r.errors.map((e) => `${origin} agents/${f}: ${e}`));
    }
  }
  return { roles: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

function filesUnder(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, base)); else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

/**
 * The bundled skill pack: one folder per skill under `<resources>/skills/`, each
 * with a `SKILL.md` (Agent Skills format: `name` equal to the folder, a
 * `description`, optional `allowed-tools`). The interview prompt packs
 * (`skills/*.json`) beside them are not part of the pack.
 */
export function loadSkillPack(resourcesRoot: string): { skills: PackSkill[]; errors: string[] } {
  const dir = path.join(resourcesRoot, 'skills');
  const skills: PackSkill[] = [];
  const errors: string[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return { skills, errors }; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, e.name, 'SKILL.md');
    if (!fs.existsSync(file)) { errors.push(`skills/${e.name}: no SKILL.md.`); continue; }
    const text = fs.readFileSync(file, 'utf8');
    const p = parseSkillMarkdown(text);
    const problems = checkSkillFormat(e.name, p.name, p.description, p.body);
    if (problems.length) { errors.push(...problems.map((x) => `skills/${e.name}: ${x}`)); continue; }
    const sm = skillMeta(e.name, p.metadata, Object.keys(STAGE_KINDS));
    if (sm.errors.length) { errors.push(...sm.errors.map((x) => `skills/${e.name}: ${x}`)); continue; }
    skills.push({ id: e.name, name: p.name!, description: p.description!, allowedTools: p.allowedTools ?? [], instructions: p.body, dir: path.join(dir, e.name), resources: filesUnder(path.join(dir, e.name)).filter((f) => f !== 'SKILL.md'), meta: sm.meta });
  }
  return { skills, errors };
}

/** The Agent Skills format rules a skill must meet to be portable to other hosts. */
export function checkSkillFormat(folder: string, name: string | undefined, description: string | undefined, body: string): string[] {
  const errors: string[] = [];
  if (!name) errors.push('frontmatter needs a name.');
  else {
    if (!NAME.test(name) || name.length > 64) errors.push('name must be lowercase words joined by dashes, at most 64 characters.');
    if (name !== folder) errors.push(`name "${name}" must equal the folder name "${folder}".`);
  }
  if (!description) errors.push('frontmatter needs a description (what the skill does and when to use it).');
  else if (description.length > 1024) errors.push('description must be at most 1024 characters.');
  if (!body.trim()) errors.push('the skill needs instructions (the Markdown body).');
  return errors;
}

/** Cross-checks: every skill a role names exists in the pack. */
export function checkDefinitions(roles: readonly RoleTemplate[], skills: readonly PackSkill[]): string[] {
  const ids = new Set(skills.map((s) => s.id));
  return roles.flatMap((r) => r.skills.filter((s) => !ids.has(s)).map((s) => `role ${r.name}: unknown skill "${s}".`));
}
