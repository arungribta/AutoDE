import { RoleTemplate } from './definitions';
import { ToolInfo, toolsForTier } from './assignment';
import { STAGE_KINDS, StageKind } from '../workflows/stageKinds';
import { readWorkflow } from '../workflows/instance';
import { layoutPath } from '../workspaceLayout';

/**
 * The chat as AutoDE's front door (v0.52.1; owner, 2026-10-28). One chat,
 * not a persona picker:
 * - questions are answered by the chat itself, with AutoDE's read-only tools
 *   (search, asset context, articles, facts, the maintenance queue, the
 *   workflow), on top of the context pack it already gets;
 * - work that belongs to an agent is handed over: the chat names the agent
 *   and the person starts it with one click (a work order at the propose
 *   tier); stage work points to its stage, so nothing bypasses the workflow;
 * - `@<agent> <task>` at the start of a message hands that one message over.
 * The chat never starts an agent itself.
 */

/** AutoDE tools the chat may call: reads only (the tier caps them again). */
export const CHAT_TOOLS = [
  'autode_search_assets', 'autode_get_asset_context', 'autode_browse_assets', 'autode_explore_graph', 'autode_search_articles',
  'autode_resolve', 'autode_list_assertions', 'autode_semantic_list', 'autode_maintenance_list', 'autode_workflow_status',
  'autode_approvals_list', 'autode_list_decisions'
];

export function chatToolNames(tools: readonly ToolInfo[]): string[] {
  return toolsForTier(tools, 'read', CHAT_TOOLS);
}

/** Roles that work outside the workflow's stages (the layers' agents); every other role's work is a stage. */
export function isStageRole(role: string): boolean {
  return Object.values(STAGE_KINDS).some((k) => k.roles.includes(role));
}

export interface Handoff {
  role: string;
  task: string;
  /** `run`: the person starts the agent; `stage`: the work is a workflow stage, opened instead. */
  kind: 'run' | 'stage';
  stage?: { id: string; title: string; status: string };
}

/** Where a handover goes: the agent itself, or (stage roles) the active problem's next stage it does. */
export function handoffFor(workspaceRoot: string, problemId: string | undefined, role: string, task: string): Handoff {
  if (!isStageRole(role)) return { role, task, kind: 'run' };
  const w = problemId ? readWorkflow(layoutPath(workspaceRoot, 'problems', problemId)) : undefined;
  const s = w?.stages.find((x) => x.included && x.record.status !== 'done' && x.record.status !== 'skipped' && (x.agent?.role === role || STAGE_KINDS[x.kind as StageKind].roles.includes(role)));
  return { role, task, kind: 'stage', ...(s ? { stage: { id: s.id, title: s.title, status: s.record.status } } : {}) };
}

const MENTION = /^@([a-z][a-z0-9-]*)\b[\s:,]*([\s\S]*)$/;
const HANDOFF_LINE = /^\s*HANDOFF:\s*([a-z][a-z0-9-]*)\s*\|\s*(.+?)\s*$/m;

/** `@knowledge-engineer write an article on customer ids` → the role and the task (only for known roles). */
export function parseMention(message: string, roles: readonly Pick<RoleTemplate, 'name'>[]): { role: string; task: string } | undefined {
  const m = MENTION.exec(message.trim());
  if (!m || !roles.some((r) => r.name === m[1])) return undefined;
  return { role: m[1], task: m[2].trim() };
}

/** The chat's reply without its `HANDOFF: <role> | <task>` line, and the handover it names (a known role only). */
export function parseHandoff(reply: string, roles: readonly Pick<RoleTemplate, 'name'>[]): { text: string; handoff?: { role: string; task: string } } {
  const m = HANDOFF_LINE.exec(reply);
  if (!m) return { text: reply };
  const text = reply.replace(m[0], '').replace(/\n{3,}/g, '\n\n').trim();
  return roles.some((r) => r.name === m[1]) ? { text, handoff: { role: m[1], task: m[2] } } : { text };
}

/** What the chat's system prompt adds: the tools, the agents, and how to hand work over. */
export function chatFrontDoorPrompt(roles: readonly Pick<RoleTemplate, 'name' | 'description'>[], tools: readonly string[]): string {
  return [
    '## AutoDE\'s knowledge and agents',
    tools.length
      ? `Answer questions about the estate, the business's terms, facts, articles, semantic models and the workflow from AutoDE's own tools (${tools.join(', ')}), not from memory. Cite what they return.`
      : 'AutoDE\'s tools are not available in this chat: answer from the context above.',
    'You answer questions; AutoDE\'s agents do work. When the user asks for work one of these agents does (writing or fixing a semantic model, a knowledge article, the glossary, reading a document for facts, a workflow stage\'s deliverable), don\'t do it yourself: say in one or two sentences which agent does it and what it will propose, and end your reply with one line exactly like',
    'HANDOFF: <agent> | <the task in one sentence>',
    'The user starts the agent with a click; a person approves what it proposes. Name at most one agent; no handoff line for questions.',
    'Agents:',
    ...roles.map((r) => `- ${r.name}: ${r.description}`)
  ].join('\n');
}
