import { loadRoles, loadSkillPack } from '../agents/definitions';
import { ToolInfo, toolsForTier } from '../agents/assignment';
import { MaintenanceItem } from './queue';

/**
 * Work orders for AutoDE's agents outside a workflow stage (MM2): a
 * maintenance item, or a task a person hands over from the chat (v0.52.1).
 * The role template, its skills, the task, and the tools the role may call
 * at the `propose` tier. The same text goes to a host agent
 * (`autode_maintenance_next`, `autode_work_order`) and to the VS Code
 * executor. The agent reads and proposes; a person approves.
 */

export interface WorkOrder {
  role: string;
  skills: string[];
  engineTools: string[];
  text: string;
}

export interface MaintenanceAssignment extends WorkOrder { item: MaintenanceItem }

export interface WorkTask {
  title: string;
  /** What the task is about, in the person's or the rule's words. */
  body: string;
  /** How it ends: the brief's closing instruction. */
  closing: string;
}

export function workOrder(resourcesRoot: string, workspaceRoot: string, roleName: string, task: WorkTask, tools: readonly ToolInfo[]): { order?: WorkOrder; reason?: string } {
  const role = loadRoles(resourcesRoot, workspaceRoot).roles.find((r) => r.name === roleName);
  if (!role) return { reason: `No role template ${roleName}.` };
  const pack = loadSkillPack(resourcesRoot).skills.filter((k) => role.skills.includes(k.id));
  const engineTools = toolsForTier(tools, 'propose', role.tools);
  const text = [
    `# ${task.title}`,
    `You are AutoDE's ${role.name}: ${role.description}`,
    role.instructions,
    task.body,
    `## Your limits\nAutoDE tools you may call: ${engineTools.join(', ') || 'none'}. You read and propose; you never approve, apply or dismiss anything. ${task.closing}`,
    ...pack.map((k) => `## Skill: ${k.name}\n${k.description}\n\n${k.instructions}`)
  ].join('\n\n');
  return { order: { role: role.name, skills: pack.map((k) => k.id), engineTools, text } };
}

export function maintenanceAssignment(resourcesRoot: string, workspaceRoot: string, item: MaintenanceItem, tools: readonly ToolInfo[]): { assignment?: MaintenanceAssignment; reason?: string } {
  if (item.agent === 'person') return { reason: `${item.title}: a person does this (${item.next})` };
  const w = workOrder(resourcesRoot, workspaceRoot, item.agent, {
    title: `Maintenance: ${item.title}`,
    body: `## The item (${item.rule}, key ${item.key})\n${item.detail}\n\nWhat to do: ${item.next}\n\nAbout: ${item.subjects.slice(0, 20).join(', ')}`,
    closing: 'The item closes itself once its cause is resolved (a person approves your proposal). If the item needs nothing, say why: a person dismisses it.'
  }, tools);
  return w.order ? { assignment: { ...w.order, item } } : { reason: w.reason };
}
