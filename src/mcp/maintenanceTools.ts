import { EngineTool, ToolAnnotations } from './tools';
import { EngineToolError } from './errors';
import { EngineWorkspace } from './workspace';
import { ToolInfo } from '../engine/agents/assignment';
import { MAINTENANCE_RULES, MaintenanceItem, MaintenanceRule, openMaintenanceItems } from '../engine/maintenance/queue';
import { maintenanceAssignment } from '../engine/maintenance/brief';
import { loadMaintenanceConfig } from '../engine/maintenance/policy';
import { scanWorkspace } from '../engine/maintenance/scan';
import { dismissStatements } from '../engine/context/sessionReview';
import { listTurns } from '../engine/maintenance/turns';

/**
 * Knowledge maintenance over MCP (MM2; docs/context-layer-requirements.md
 * §5.6): the queue a host agent picks items up from, the work order for one,
 * the person-triggered workspace scan, and the curator's dismissal of chat
 * turns that state no fact. Dismissing an item stays a person's act (the CLI,
 * VS Code).
 */

const read = (title: string): ToolAnnotations => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

export async function workspaceMaintenance(ws: EngineWorkspace, all = false): Promise<MaintenanceItem[]> {
  const sources = await ws.contextSources();
  return openMaintenanceItems({ workspaceRoot: ws.options.workspaceRoot, resourcesRoot: ws.options.resourcesRoot, problemId: ws.activeProblemId(), sources, all });
}

export function maintenanceTools(allTools: () => readonly ToolInfo[] = () => []): EngineTool[] {
  return [
    {
      name: 'autode_maintenance_list',
      description: 'Knowledge maintenance: the open items AutoDE\'s rules raised (a confirmed fact that contradicts a semantic model, a column a model uses that is gone, a confirmed metric, join or term with no semantic counterpart, a knowledge article whose cited fact changed, glossary terms with no category, a document not yet read for knowledge, chat turns that read like facts but aren\'t reviewed, a stale stage). Each names the agent suited to it and what to do. Deterministic; an item closes itself when its cause is resolved.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { role: { type: 'string', minLength: 1, description: 'Only the items for this role (semantic-modeler, knowledge-engineer, context-curator, a stage role).' }, rule: { type: 'string', enum: [...MAINTENANCE_RULES] }, all: { type: 'boolean', description: 'Every problem\'s documents, not only the active problem\'s.' } } },
      annotations: read('Maintenance items'),
      handler: async (args, ws) => {
        const items = (await workspaceMaintenance(ws, args.all === true)).filter((i) => (!args.role || i.agent === args.role) && (!args.rule || i.rule === args.rule as MaintenanceRule));
        return { policy: loadMaintenanceConfig(ws.options.workspaceRoot).policy, items: items as unknown as Record<string, unknown>[] };
      }
    },
    {
      name: 'autode_maintenance_next',
      description: 'The next maintenance item (for a role, if given) and its work order: the role template, its skills, the item\'s brief and the AutoDE tools the role may use, in assignment.text. Do it as that role (a sub-agent of that name, or yourself following the text); propose, never approve. Under the default policy (suggest) nothing starts on its own: only when the user asks.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { role: { type: 'string', minLength: 1 }, key: { type: 'string', minLength: 1, description: 'A specific item, by its key.' } } },
      annotations: read('Next maintenance item'),
      handler: async (args, ws) => {
        const items = await workspaceMaintenance(ws, true);
        const item = args.key ? items.find((i) => i.key === args.key) : items.find((i) => (!args.role || i.agent === args.role) && i.agent !== 'person');
        if (!item) {
          if (args.key) throw new EngineToolError('NOT_FOUND', `No open maintenance item ${String(args.key)}: it was resolved or dismissed.`);
          return { item: null, next: args.role ? `Nothing for ${String(args.role)}.` : 'Nothing to maintain.' };
        }
        const a = maintenanceAssignment(ws.options.resourcesRoot, ws.options.workspaceRoot, item, allTools());
        return { item: item as unknown as Record<string, unknown>, assignment: (a.assignment ?? null) as unknown as Record<string, unknown> | null, ...(a.reason ? { noAssignment: a.reason } : {}) };
      }
    },
    {
      name: 'autode_maintenance_scan',
      description: 'Scan the whole workspace for text documents (Markdown, text, reStructuredText, AsciiDoc) no problem\'s pack holds, so their knowledge is queued for a reading (document-reading items for the context curator). Only when the user asks for it: it reads every such file. Records the scan; reads nothing with a model.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { title: 'Scan the workspace for knowledge', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (_args, ws) => {
        const r = scanWorkspace(ws.options.workspaceRoot);
        const reading = (await workspaceMaintenance(ws, true)).filter((i) => i.rule === 'document-reading');
        return { found: r.documents.length, skipped: r.skipped, truncated: r.truncated, toRead: reading as unknown as Record<string, unknown>[], next: reading.length ? 'Tell the user what was found; the context curator reads each (autode_maintenance_next with role context-curator) when they ask.' : 'Every document found is read already.' };
      }
    },
    {
      name: 'autode_dismiss_turns',
      description: 'Mark recorded chat turns as reviewed without a fact: they state no fact (a question, a request, chit-chat). Give their refs (autode_review_session lists them). A turn that does state a fact is recorded instead, with autode_propose_assertion citing its ref as chat_message evidence.',
      inputSchema: { type: 'object', required: ['refs'], additionalProperties: false, properties: { refs: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', minLength: 1 } } } },
      annotations: { title: 'Dismiss reviewed chat turns', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args, ws) => {
        const known = new Set(listTurns(ws.options.workspaceRoot).map((t) => t.ref));
        const refs = (args.refs as string[]).filter((r) => known.has(r));
        const unknown = (args.refs as string[]).filter((r) => !known.has(r));
        if (refs.length) dismissStatements(ws.options.workspaceRoot, refs);
        return { dismissed: refs, ...(unknown.length ? { unknown } : {}) };
      }
    }
  ];
}
