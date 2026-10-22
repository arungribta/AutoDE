import * as os from 'node:os';
import { externalCatalog, hostSkillDirs } from './skillCatalog';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml } from '../context/Yaml';
import { STAGE_KINDS, StageKind, Tier, TIERS, tierRank } from '../workflows/stageKinds';
import { readWorkflow } from '../workflows/instance';
import { layoutPath } from '../workspaceLayout';
import { PackSkill, RoleTemplate, loadRoles, loadSkillPack } from './definitions';

/**
 * An assignment (PA3b): what the hub hands a spoke for one stage — the role
 * template, the planner's brief (context only), the skills (the method), the
 * permission tier and exactly the engine tools that tier and role allow. The
 * same assignment drives AutoDE's in-process executor in VS Code and, through
 * `autode_workflow_next`, a host's agent.
 */

export interface ToolInfo { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } }

/** The tier a tool needs: read < propose < platform-read; destructive tools (resolving, applying) are never granted. */
export function toolTier(t: ToolInfo): Tier | 'never' {
  const a = t.annotations ?? {};
  if (a.destructiveHint === true) return 'never';
  if (a.openWorldHint === true) return 'platform-read';
  if (a.readOnlyHint === true) return 'read';
  return 'propose';
}

/** Workflow control stays with the hub: an agent never starts, hands in, skips, re-opens or re-plans stages itself. */
const HUB_ONLY = /^autode_(workflow_(start_stage|complete_stage|skip_stage|reopen_stage)|propose_workflow|resolve_decision|apply_decision|review_assertion|start_problem|select_problem)$/;

/** Every stage records its own deliverables (drafts in its own folder, approved at its gate), whatever its tier. */
const ANY_TIER = new Set(['autode_record_artifact']);

export function toolsForTier(tools: readonly ToolInfo[], tier: Tier, roleTools: readonly string[]): string[] {
  const allow = roleTools.length ? new Set(roleTools) : undefined;
  return tools.filter((t) => {
    if (HUB_ONLY.test(t.name)) return false;
    const need = ANY_TIER.has(t.name) ? 'read' : toolTier(t);
    if (need === 'never' || tierRank(need) > tierRank(tier)) return false;
    return !allow || allow.has(t.name);
  }).map((t) => t.name).sort();
}

export interface Assignment {
  problemId: string;
  stage: { id: string; title: string; kind: StageKind; status: string };
  role: string;
  roleDescription: string;
  roleInstructions: string;
  brief?: string;
  skills: Array<Pick<PackSkill, 'id' | 'name' | 'description' | 'instructions' | 'resources'>>;
  tier: Tier;
  /** Engine (MCP) tools this assignment may call. */
  engineTools: string[];
  /** File tools: read-only below workspace-write. */
  fileMode: 'read-only' | 'full';
  consumes: string[];
  produces: string[];
  doneWhen: string;
  tasks: Array<{ id: string; title: string }>;
  /** Vendor and community skills for this stage kind and platform (v0.45.5): installed ones are named in the text; references only. */
  externalSkills: Array<{ name: string; vendor?: string; summary: string; source?: string; installed: boolean; availability?: string }>;
  /** The whole assignment as one text, for a host agent or a prompt. */
  text: string;
}

/** The problem's target platform, from its target context (snowflake, databricks …). */
export function targetPlatform(problemRoot: string): string | undefined {
  try {
    const t = parseYaml(fs.readFileSync(path.join(problemRoot, 'context', 'target-context.yaml'), 'utf8')) as { platform?: string } | null;
    return typeof t?.platform === 'string' ? t.platform.toLowerCase() : undefined;
  } catch { return undefined; }
}

export interface AssignmentScope { workspaceRoot: string; resourcesRoot: string; problemId: string; /** Where the user's host skills live (default: the OS home). */ home?: string }

/** The assignment for a stage, or why there is none yet (the role has no definition: its old agent still does the work). */
export function assignmentFor(scope: AssignmentScope, stageId: string, tools: readonly ToolInfo[]): { assignment?: Assignment; reason?: string } {
  const w = readWorkflow(layoutPath(scope.workspaceRoot, 'problems', scope.problemId));
  const s = w?.stages.find((x) => x.id === stageId);
  if (!w || !s) return { reason: `No stage "${stageId}".` };
  if (!s.included) return { reason: `${stageId} is not in this workflow.` };
  const kind = STAGE_KINDS[s.kind];
  const roleName = s.agent?.role ?? kind.roles[0];
  const { roles } = loadRoles(scope.resourcesRoot, scope.workspaceRoot);
  // The skills for this stage: those whose metadata names its kind and fit the problem's target platform (v0.45.5).
  const { skills: pack } = loadSkillPack(scope.resourcesRoot);
  const platform = targetPlatform(layoutPath(scope.workspaceRoot, 'problems', scope.problemId));
  const fits = (k: PackSkill) => k.meta.stageKinds.includes(s.kind) && (k.meta.platforms.includes('any') || (!!platform && k.meta.platforms.includes(platform)));
  const forKind = new Set(pack.filter(fits).map((k) => k.id));
  // The role with a skill for this kind: the planned one first, then the others the kind allows; else the planned
  // role, else the first the kind allows that has a definition (roles defined after the plan was approved).
  const candidates = [roleName, ...kind.roles.filter((n) => n !== roleName)].map((n) => roles.find((r) => r.name === n)).filter((r): r is RoleTemplate => !!r);
  const role: RoleTemplate | undefined = candidates.find((r) => r.skills.some((id) => forKind.has(id))) ?? candidates[0];
  if (!role) return { reason: `Role ${roleName} has no definition yet; AutoDE's built-in agents still do ${s.kind} stages (AutoDE agents, plan steps).` };
  const tier = (s.agent?.tier && TIERS.includes(s.agent.tier) && tierRank(s.agent.tier) <= tierRank(kind.ceiling)) ? s.agent.tier : kind.ceiling;
  // A role with several skills gets those for this stage (the source assessor: conformance on a conformance stage),
  // and the platform's skills for the kind even when its own list predates them.
  const own = role.skills.filter((id) => forKind.has(id));
  const platformSkills = pack.filter((k) => fits(k) && !k.meta.platforms.includes('any')).map((k) => k.id);
  const ownKind = own.length ? [...new Set([...own, ...platformSkills])] : role.skills;
  const wanted = s.agent?.skills?.length ? s.agent.skills : ownKind;
  const skills = pack.filter((k) => wanted.includes(k.id)).map((k) => ({ id: k.id, name: k.name, description: k.description, instructions: k.instructions, resources: k.resources }));
  const engineTools = toolsForTier(tools, tier, role.tools);
  const dirs = hostSkillDirs(scope.workspaceRoot, scope.home ?? os.homedir());
  const externalSkills = externalCatalog(scope.resourcesRoot, scope.workspaceRoot).entries
    .filter((e) => e.stageKinds.includes(s.kind) && (!e.platforms.length || e.platforms.includes('any') || (!!platform && e.platforms.includes(platform))))
    .map((e) => ({ name: e.name, vendor: e.owner, summary: e.summary, source: e.source, availability: e.availability, installed: dirs.some((d) => fs.existsSync(path.join(d, e.name, 'SKILL.md'))) }));
  const a: Omit<Assignment, 'text'> = {
    problemId: scope.problemId,
    stage: { id: s.id, title: s.title, kind: s.kind, status: s.record.status },
    role: role.name, roleDescription: role.description, roleInstructions: role.instructions, brief: s.agent?.brief,
    skills, tier, engineTools, fileMode: tier === 'workspace-write' ? 'full' : 'read-only',
    consumes: s.consumes, produces: s.produces, doneWhen: kind.doneWhen, tasks: s.tasks.map((t) => ({ id: t.id, title: t.title })), externalSkills
  };
  return { assignment: { ...a, text: assignmentText(a) } };
}

export function assignmentText(a: Omit<Assignment, 'text'>): string {
  return [
    `# Assignment: ${a.stage.title} (${a.stage.kind}) — business problem ${a.problemId}`,
    `You are AutoDE's ${a.role}: ${a.roleDescription}`,
    a.roleInstructions,
    a.brief ? `## Brief for this stage\n${a.brief}` : '',
    a.tasks.length ? `## Tasks\n${a.tasks.map((t) => `- ${t.title}`).join('\n')}` : '',
    `## What this stage needs and produces\nConsumes: ${a.consumes.join(', ') || 'nothing'}. Produces: ${a.produces.join(', ')}. Done when ${a.doneWhen}.`,
    `## Your limits\nPermission tier: ${a.tier}. AutoDE tools you may call: ${a.engineTools.join(', ') || 'none'}. ${a.fileMode === 'full' ? 'You may write files in the workspace (each write is approved).' : 'You may read workspace files but not write them.'} Record each deliverable with autode_record_artifact. You never call another agent, start or hand in stages, or approve anything: AutoDE's workflow does that, and a person approves.`,
    ...a.skills.map((k) => `## Skill: ${k.name}\n${k.description}\n\n${k.instructions}`),
    a.externalSkills.some((e) => e.installed)
      ? `## Vendor skills installed in this host\nUse them for the platform's specifics; AutoDE's rules still apply (approvals, runbooks, recording deliverables):\n${a.externalSkills.filter((e) => e.installed).map((e) => `- ${e.name} (${e.vendor ?? 'external'}): ${e.summary}`).join('\n')}`
      : ''
  ].filter(Boolean).join('\n\n');
}
