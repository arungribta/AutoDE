import { EngineTool, ToolAnnotations } from './tools';
import { EngineToolError } from './errors';
import { EngineWorkspace } from './workspace';
import { WorkflowScope, diffWorkflow, draftFrom, ensureWorkflow, historyFor, proposeWorkflow, redraft, statusFor, suggestFor, templatesFor } from '../engine/workflows/service';
import { WorkflowError, completeStage, nextAssignment, reopenStage, skipStage, startStage } from '../engine/workflows/runtime';
import { WorkflowInstance, readWorkflow } from '../engine/workflows/instance';
import { layoutPath } from '../engine/workspaceLayout';
import { Actor } from '../engine/workflows/events';

/**
 * The workflow over MCP (PA3a): the runtime is the hub; an agent asks what to
 * do next, does it, and hands it in. Approving the workflow or a stage gate is
 * a person's act (panel, CLI in a terminal, decision file — and, from PA3c,
 * elicitation); these tools never approve.
 */

const read = (title: string): ToolAnnotations => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const records = (title: string): ToolAnnotations => ({ title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });

function scopeOf(ws: EngineWorkspace): WorkflowScope {
  const problemId = ws.activeProblemId();
  if (!problemId) throw new EngineToolError('NOT_FOUND', 'No active business problem: start or select one (autode_start_problem, autode_select_problem).');
  return { workspaceRoot: ws.options.workspaceRoot, resourcesRoot: ws.options.resourcesRoot, problemId };
}

function rctx(ws: EngineWorkspace) {
  const s = scopeOf(ws);
  return { workspaceRoot: s.workspaceRoot, problemRoot: layoutPath(s.workspaceRoot, 'problems', s.problemId), problemId: s.problemId };
}

function wrap<T>(fn: () => T): T {
  try { return fn(); } catch (err) {
    if (err instanceof WorkflowError) throw new EngineToolError(err.code === 'NOT_FOUND' ? 'NOT_FOUND' : err.code === 'CHECK_FAILED' ? 'VALIDATION_FAILED' : 'PERMISSION_DENIED', err.message);
    throw err;
  }
}

export function workflowTools(clientName: () => string | undefined): EngineTool[] {
  const agent = (): Actor => ({ kind: 'agent', name: clientName() ?? 'MCP client', host: 'MCP' });
  return [
    {
      name: 'autode_workflow_templates',
      description: 'The workflow templates (greenfield, modernization, estate-merge, and this workspace\'s own): stage catalogues with each stage\'s kind and inclusion (mandatory, default, conditional, optional), and the one AutoDE suggests for the active problem.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: read('Workflow templates'),
      handler: async (_args, ws) => {
        const { templates, errors } = templatesFor({ workspaceRoot: ws.options.workspaceRoot, resourcesRoot: ws.options.resourcesRoot });
        let suggested;
        try { suggested = suggestFor(scopeOf(ws)); } catch { /* no problem yet */ }
        return { templates: templates.map((t) => ({ id: t.id, version: t.version, title: t.title, description: t.description, origin: t.origin, stages: t.stages.map((s) => ({ id: s.id, kind: s.kind, inclusion: s.inclusion, when: s.when, after: s.after })) })), suggested, errors };
      }
    },
    {
      name: 'autode_workflow_status',
      description: 'The active problem\'s workflow: each stage\'s state (done, ready, in-progress, awaiting-approval, pending with what it waits for, stale with why, skipped with the reason) and what to do next.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: read('Workflow status'),
      handler: async (_args, ws) => wrap(() => statusFor(scopeOf(ws)) as unknown as Record<string, unknown>)
    },
    {
      name: 'autode_workflow_next',
      description: 'The next assignment from the workflow (the hub): which stage, which role, its tier, what it consumes and produces, and instructions. Do it, then hand it in with autode_workflow_complete_stage. Never run another agent from inside an assignment.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: read('Next assignment'),
      handler: async (_args, ws) => wrap(() => { ensureWorkflow(scopeOf(ws)); return { next: nextAssignment(rctx(ws)) ?? null }; })
    },
    {
      name: 'autode_workflow_history',
      description: 'The workflow\'s history: who did what (the engine\'s rules, a person, an agent), when, through which channel, why, with the decision and files involved. Optionally for one stage.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { stage: { type: 'string', minLength: 1 } } },
      annotations: read('Workflow history'),
      handler: async (args, ws) => wrap(() => ({ events: historyFor(scopeOf(ws), args.stage as string | undefined) as unknown as Record<string, unknown>[] }))
    },
    {
      name: 'autode_propose_workflow',
      description: 'Propose the active problem\'s workflow (the plan gate). Without "workflow", AutoDE drafts it deterministically from "template" (default: its suggestion) and the facts about the spec and estate; with "workflow", your refinement of that draft is checked against the template\'s rules (mandatory stages and gates kept, reasons for stages left out or added, roles and tiers allowed, dependencies sound). A person approves it.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { template: { type: 'string', minLength: 1 }, workflow: { type: 'object', description: 'A full workflow instance (as autode_workflow_status / the draft shows it), refined.' } } },
      annotations: records('Propose the workflow'),
      handler: async (args, ws) => wrap(() => {
        const scope = scopeOf(ws);
        let w: WorkflowInstance;
        if (args.workflow) w = args.workflow as WorkflowInstance;
        else {
          const current = readWorkflow(layoutPath(scope.workspaceRoot, 'problems', scope.problemId));
          if (current && current.status === 'approved') {
            const id = (args.template as string | undefined) ?? current.template.id;
            if (!templatesFor(scope).templates.some((x) => x.id === id)) throw new EngineToolError('NOT_FOUND', `No workflow template "${id}".`);
            w = draftFrom(scope, id, args.template ? agent() : undefined);
          } else w = redraft(scope, args.template as string | undefined, args.template ? agent() : undefined);
          if (args.workflow === undefined && w.provenance && args.template) w.provenance.chosenBy = agent();
        }
        const d = proposeWorkflow(scope, w, { host: 'mcp', client: clientName() });
        const t = templatesFor(scope).templates.find((x) => x.id === w.template.id);
        return { decision: { id: d.id, kind: d.kind, stakes: d.stakes, status: d.status, title: d.title, validation: d.validation }, diff: t ? diffWorkflow(w, t) as unknown as Record<string, unknown> : null, next: `A person approves it: the AutoDE panel, \`autode workflow approve\` in a terminal, or .autode/decisions/${d.id}.yaml. Tell the user.` };
      })
    },
    {
      name: 'autode_workflow_start_stage',
      description: 'Mark a stage in progress. Working ahead of its dependencies is allowed (recorded with a warning); it can\'t be approved until they are.',
      inputSchema: { type: 'object', required: ['stage'], additionalProperties: false, properties: { stage: { type: 'string', minLength: 1 } } },
      annotations: records('Start a stage'),
      handler: async (args, ws) => wrap(() => startStage(rctx(ws), String(args.stage), agent(), 'tool') as unknown as Record<string, unknown>)
    },
    {
      name: 'autode_workflow_complete_stage',
      description: 'Hand in a stage: its check runs (the outputs exist), then its approval gate becomes a decision for a person. Stages whose output is a document with its own approval (spec, target and source context, mapping, Pipeline Spec) complete when that document is approved through its proposal.',
      inputSchema: { type: 'object', required: ['stage', 'summary'], additionalProperties: false, properties: { stage: { type: 'string', minLength: 1 }, outputs: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Workspace-relative files the stage produced.' }, summary: { type: 'string', minLength: 1, description: 'What was done, for the approver.' } } },
      annotations: records('Hand in a stage'),
      handler: async (args, ws) => wrap(() => completeStage(rctx(ws), String(args.stage), { outputs: (args.outputs as string[] | undefined) ?? [], summary: String(args.summary), who: agent(), channel: 'tool' }) as unknown as Record<string, unknown>)
    },
    {
      name: 'autode_workflow_skip_stage',
      description: 'Skip a default, conditional or optional stage, with a reason (recorded and shown to the team). Mandatory stages can\'t be skipped, nor a stage whose output a later stage needs.',
      inputSchema: { type: 'object', required: ['stage', 'reason'], additionalProperties: false, properties: { stage: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 5 } } },
      annotations: records('Skip a stage'),
      handler: async (args, ws) => wrap(() => ({ stage: skipStage(rctx(ws), String(args.stage), String(args.reason), agent(), 'tool') }))
    },
    {
      name: 'autode_workflow_reopen_stage',
      description: 'Re-open a done stage to change its output; every stage downstream of it becomes stale and needs its approval again.',
      inputSchema: { type: 'object', required: ['stage', 'reason'], additionalProperties: false, properties: { stage: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 5 } } },
      annotations: records('Re-open a stage'),
      handler: async (args, ws) => wrap(() => reopenStage(rctx(ws), String(args.stage), agent(), String(args.reason), 'tool') as unknown as Record<string, unknown>)
    }
  ];
}
