import { loadRoles, loadSkillPack } from '../agents/definitions';
import { ToolInfo, toolsForTier } from '../agents/assignment';
import { MaintenanceItem } from './queue';

/**
 * The work order for one maintenance item (MM2): the role the rule names,
 * its skills, and the item's brief. The same text goes to a host agent
 * (`autode_maintenance_next`) and to the VS Code executor. The tier is
 * `propose`: the agent reads and proposes; a person approves.
 */

export interface MaintenanceAssignment {
  item: MaintenanceItem;
  role: string;
  skills: string[];
  engineTools: string[];
  text: string;
}

export function maintenanceAssignment(resourcesRoot: string, workspaceRoot: string, item: MaintenanceItem, tools: readonly ToolInfo[]): { assignment?: MaintenanceAssignment; reason?: string } {
  if (item.agent === 'person') return { reason: `${item.title}: a person does this (${item.next})` };
  const role = loadRoles(resourcesRoot, workspaceRoot).roles.find((r) => r.name === item.agent);
  if (!role) return { reason: `No role template ${item.agent}.` };
  const pack = loadSkillPack(resourcesRoot).skills.filter((k) => role.skills.includes(k.id));
  const engineTools = toolsForTier(tools, 'propose', role.tools);
  const text = [
    `# Maintenance: ${item.title}`,
    `You are AutoDE's ${role.name}: ${role.description}`,
    role.instructions,
    `## The item (${item.rule}, key ${item.key})\n${item.detail}\n\nWhat to do: ${item.next}\n\nAbout: ${item.subjects.slice(0, 20).join(', ')}`,
    `## Your limits\nAutoDE tools you may call: ${engineTools.join(', ') || 'none'}. You read and propose; you never approve, apply or dismiss anything. The item closes itself once its cause is resolved (a person approves your proposal). If the item needs nothing, say why: a person dismisses it.`,
    ...pack.map((k) => `## Skill: ${k.name}\n${k.description}\n\n${k.instructions}`)
  ].join('\n\n');
  return { assignment: { item, role: role.name, skills: pack.map((k) => k.id), engineTools, text } };
}
