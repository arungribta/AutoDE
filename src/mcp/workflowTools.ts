import { problemMaintenance } from '../engine/maintenance/queue';
import { EngineTool, ToolAnnotations } from './tools';
import { EngineToolError } from './errors';
import { EngineWorkspace } from './workspace';
import { WorkflowScope, answerPlanningQuestion, askPlanningQuestions, computeDraft, diffWorkflow, draftFrom, ensureWorkflow, historyFor, planningStatus, proposeCoverage, proposeWorkflow, redraft, reportCoverageChange, statusFor, suggestFor, templatesFor } from '../engine/workflows/service';
import { PlanningOutcome, REPORT_KINDS, ReportKind } from '../engine/workflows/planning';
import { ProposalValidationError } from '../engine/decisions/proposals';
import { WorkflowError, completeStage, nextAssignment, reopenStage, skipStage, startStage } from '../engine/workflows/runtime';
import { COMPOSED, MAX_BRIEF, WorkflowInstance, readWorkflow, templateOf } from '../engine/workflows/instance';
import { STAGE_KINDS, StageKind } from '../engine/workflows/stageKinds';
import { stageSkills } from '../engine/skills/port';
import { layoutPath } from '../engine/workspaceLayout';
import { Actor } from '../engine/workflows/events';
import { ToolInfo, assignmentFor, skillFits, targetPlatform } from '../engine/agents/assignment';
import { recordArtifact } from '../engine/agents/artifacts';
import { stageReadiness } from '../engine/workflows/readiness';
import { stageContextGaps } from '../engine/agents/stageGaps';
import { problemMode } from '../engine/documents/problemMode';
import { journeyContextFrom, journeyFor } from '../engine/workflows/journey';
import { CoverageStatus, placeCoverageItem, specCoverage } from '../engine/workflows/coverage';
import { parseEstate } from '../engine/context/estate';
import * as fs from 'node:fs';

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

export function workflowTools(clientName: () => string | undefined, allTools: () => readonly ToolInfo[] = () => []): EngineTool[] {
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
      name: 'autode_workflow_draft',
      description: 'The workflow to plan from, without proposing anything: the problem\'s current workflow (if any) and AutoDE\'s deterministic draft for a template (the suggested one by default), with what every stage kind allows: its roles, its permission-tier ceiling, and the skills that do it on this problem\'s platform (a kind with none is a person\'s to do: a gap). The planner refines the draft (stages in or out with reasons; per stage a role, a tier, skills and a brief), may take stages from another template (origin "combined" with fromTemplate) or compose from stage kinds alone (template "composed"), adds a "manual" stage with an owner for work done outside AutoDE, and proposes it with autode_propose_workflow, then the coverage with autode_propose_coverage. A brief carries context only (entities, constraints, open questions, what to produce): never tool or skill names.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { template: { type: 'string', minLength: 1 } } },
      annotations: read('Draft the workflow'),
      handler: async (args, ws) => wrap(() => {
        const scope = scopeOf(ws);
        const { workflow, template, suggestion } = computeDraft(scope, args.template as string | undefined);
        const current = readWorkflow(layoutPath(scope.workspaceRoot, 'problems', scope.problemId));
        const platform = targetPlatform(layoutPath(scope.workspaceRoot, 'problems', scope.problemId));
        const pack = stageSkills(scope.resourcesRoot, scope.workspaceRoot);
        const kinds = (Object.keys(STAGE_KINDS) as StageKind[]).map((k) => ({
          kind: k, roles: STAGE_KINDS[k].roles, ceiling: STAGE_KINDS[k].ceiling, doneWhen: STAGE_KINDS[k].doneWhen,
          skills: k === 'manual' ? [] : pack.filter((s) => skillFits(s, k, { platform })).map((s) => s.id),
          inDraft: workflow.stages.some((s) => s.kind === k)
        }));
        return { draft: workflow, template: { id: template.id, version: template.version }, suggestion: suggestion ?? null, current: current ? { status: current.status, template: current.template } : null, stageKinds: kinds, maxBrief: MAX_BRIEF } as unknown as Record<string, unknown>;
      })
    },
    {
      name: 'autode_workflow_status',
      description: 'The active problem\'s workflow: each stage\'s state (done, ready, in-progress, awaiting-approval, pending with what it waits for, stale with why, skipped with the reason) and what to do next. Since v0.56.0 also "journey": the whole journey in five phases (problem, discovery, specification, workflow plan, delivery), each step with who acts, where it stands and its one action; the specification\'s coverage; and, before the plan is approved, a preview of the delivery stages (template: one to preview).',
      inputSchema: { type: 'object', additionalProperties: false, properties: { template: { type: 'string', minLength: 1, description: 'The template the delivery preview shows (default: the suggested one).' } } },
      annotations: read('Workflow status'),
      handler: async (args, ws) => {
        const sources = await ws.contextSources();
        return wrap(() => {
          const scope = scopeOf(ws);
          let systems: Array<{ id: string; name: string; role: string }> = [];
          try { systems = parseEstate(fs.readFileSync(layoutPath(scope.workspaceRoot, 'estate'), 'utf8')).systems; } catch { /* no estate yet */ }
          const journey = journeyFor({ ...scope, context: journeyContextFrom({ systems, catalog: (sources.catalog as unknown as { all?: () => Array<{ system: string }> } | undefined)?.all?.() ?? [], assertions: sources.assertions }), previewTemplate: args.template as string | undefined });
          let status: Record<string, unknown> = {};
          try { status = statusFor(scope) as unknown as Record<string, unknown>; } catch { /* no workflow yet: the journey says what comes first */ }
          return { ...status, journey };
        });
      }
    },
    {
      name: 'autode_coverage',
      description: 'The active problem\'s coverage: each in-scope item, objective, constraint and acceptance criterion of the specification (and personal-data handling) with its status (covered by named stages, manual on a manual stage, out-of-scope with a reason, gap, or question still to place), against the workflow waiting for approval or the current one, with the engine\'s checks and the team\'s gap list. A person approves the coverage, then the workflow; neither while a question is open.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: read('Coverage'),
      handler: async (_args, ws) => wrap(() => {
        const scope = scopeOf(ws);
        const c = specCoverage(scope.workspaceRoot, scope.problemId);
        if (!c) throw new EngineToolError('NOT_FOUND', 'No coverage yet: it needs the specification and a workflow (autode_workflow_draft, autode_propose_workflow).');
        return { against: c.against, ...c.coverage, check: c.check };
      })
    },
    {
      name: 'autode_place_coverage',
      description: 'Place one coverage item (from autode_coverage): covered by stage ids, manual (tracked by stage ids, done outside AutoDE), out-of-scope with a reason, or gap with what is missing. Recorded with you as its author; a person approves the coverage with the workflow.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['item', 'status'],
        properties: {
          item: { type: 'string', minLength: 1, description: 'The item id (scope:… or objective:…).' },
          status: { type: 'string', enum: ['covered', 'manual', 'out-of-scope', 'gap'] },
          stages: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 },
          reason: { type: 'string', minLength: 1, maxLength: 2000 }
        }
      },
      annotations: records('Place a coverage item'),
      handler: async (args, ws) => wrap(() => {
        const scope = scopeOf(ws);
        let after;
        try { after = placeCoverageItem(scope.workspaceRoot, scope.problemId, String(args.item), { status: args.status as Exclude<CoverageStatus, 'question'>, stages: args.stages as string[] | undefined, reason: args.reason as string | undefined }, `agent: ${clientName() ?? 'MCP client'}`); }
        catch (err) { throw new EngineToolError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err)); }
        return { placed: after.coverage.entries.find((e) => e.id === args.item), check: after.check };
      })
    },
    {
      name: 'autode_propose_coverage',
      description: 'Propose the whole coverage (PLN1a): place the items of autode_coverage, as a decision a person approves before the workflow (what will be delivered, then how). Items you leave out keep their current placement. Refused, item by item, while an item is still a question, a stage named isn\'t in the workflow (propose the workflow first), a manual item isn\'t on a manual stage, or a gap or out-of-scope item has no reason. Use only AutoDE\'s stage kinds and skills: what none can deliver is a gap, never a new skill.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['placements'],
        properties: {
          placements: {
            type: 'array', minItems: 1, maxItems: 200,
            items: { type: 'object', additionalProperties: false, required: ['item', 'status'], properties: { item: { type: 'string', minLength: 1 }, status: { type: 'string', enum: ['covered', 'manual', 'out-of-scope', 'gap'] }, stages: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 }, reason: { type: 'string', minLength: 1, maxLength: 2000 } } }
          }
        }
      },
      annotations: records('Propose the coverage'),
      handler: async (args, ws) => wrap(() => {
        const scope = scopeOf(ws);
        let d;
        try { d = proposeCoverage(scope, args.placements as Array<{ item: string; status: Exclude<CoverageStatus, 'question'>; stages?: string[]; reason?: string }>, { host: 'mcp', client: clientName() }); }
        catch (err) { throw new EngineToolError('VALIDATION_FAILED', err instanceof ProposalValidationError ? err.report.errors.join(' ') : err instanceof Error ? err.message : String(err)); }
        return { decision: { id: d.id, kind: d.kind, stakes: d.stakes, status: d.status, title: d.title, summary: d.summary, validation: d.validation }, next: `A person approves it, then the workflow: the plan step in the AutoDE panel, \`autode workflow coverage approve\` in a terminal, or .autode/decisions/${d.id}.yaml. Tell the user.` };
      })
    },
    {
      name: 'autode_planning_questions',
      description: 'The planner\'s clarification rounds (PLN1b): every question with the coverage items it blocks, the planner\'s assumption, and its answer (clarifies, assumed, or scope-change), and the stages\' reports of what changes coverage (open, resolved by a revised workflow, or dismissed).',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: read('Planning questions'),
      handler: async (_args, ws) => wrap(() => planningStatus(scopeOf(ws)) as unknown as Record<string, unknown>)
    },
    {
      name: 'autode_ask_planning_questions',
      description: 'As the planner, ask the person what blocks coverage (PLN1b, a clarification round): at most seven questions, most important first, each naming the coverage items it blocks and the assumption you would make (offered as "assume and flag"). Ask only what you can\'t settle from the specification, the estate or the facts. A later round only follows an answer that raised a new question ("after": that question\'s id). Items a question blocks can\'t be placed until it is answered. Tell the user the questions; record their answers with autode_record_planning_answer.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['questions'],
        properties: {
          questions: {
            type: 'array', minItems: 1, maxItems: 7,
            items: { type: 'object', additionalProperties: false, required: ['prompt', 'items', 'assumption'], properties: { prompt: { type: 'string', minLength: 1, maxLength: 600 }, items: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }, assumption: { type: 'string', minLength: 1, maxLength: 600 }, kind: { type: 'string', enum: ['text', 'single-select', 'multi-select', 'boolean'] }, options: { type: 'array', items: { type: 'string' } }, after: { type: 'string' } } }
          }
        }
      },
      annotations: records('Ask planning questions'),
      handler: async (args, ws) => wrap(() => {
        try { return { round: askPlanningQuestions(scopeOf(ws), args.questions as never, agent(), 'tool') } as unknown as Record<string, unknown>; }
        catch (err) { throw new EngineToolError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err)); }
      })
    },
    {
      name: 'autode_record_planning_answer',
      description: 'Record the person\'s answer to a planning question, exactly as they gave it, as them (the person you work for; never your own answer). outcome: "clarifies" (a fact on the items; place them next), "assumed" (they accept your assumption: a flagged assumption the items rest on), or "scope-change" (it adds or drops scope: propose the specification\'s revision with autode_propose_spec_change; the coverage waits for it).',
      inputSchema: { type: 'object', additionalProperties: false, required: ['question', 'outcome', 'person'], properties: { question: { type: 'string', minLength: 1 }, outcome: { type: 'string', enum: ['clarifies', 'assumed', 'scope-change'] }, value: { type: 'string', minLength: 1, maxLength: 2000, description: 'Their answer (not needed for "assumed").' }, person: { type: 'string', minLength: 1, description: 'Who answered.' } } },
      annotations: records('Record a planning answer'),
      handler: async (args, ws) => {
        try {
          const r = await answerPlanningQuestion(scopeOf(ws), String(args.question), { value: args.value as string | undefined, outcome: args.outcome as PlanningOutcome }, { kind: 'person', name: String(args.person) }, 'tool');
          return { answered: r.question, ...(r.report ? { reported: r.report, next: 'The coverage was approved before this answer: the planner re-plans.' } : {}) } as unknown as Record<string, unknown>;
        } catch (err) { throw new EngineToolError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err)); }
      }
    },
    {
      name: 'autode_report_coverage_change',
      description: 'From the stage you were assigned: report what changes the plan\'s coverage (PLN1b): a source system the specification didn\'t name (new-source), an item this stage can\'t deliver (cannot-deliver, with the items), or other. The planner re-plans and a person approves the revision; stages already done stay done. Don\'t work around it in your stage.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['stage', 'kind', 'detail'], properties: { stage: { type: 'string', minLength: 1 }, kind: { type: 'string', enum: [...REPORT_KINDS] }, items: { type: 'array', items: { type: 'string', minLength: 1 } }, detail: { type: 'string', minLength: 5, maxLength: 2000 } } },
      annotations: records('Report a change to coverage'),
      handler: async (args, ws) => wrap(() => {
        try { return { report: reportCoverageChange(scopeOf(ws), { stage: String(args.stage), kind: args.kind as ReportKind, items: args.items as string[] | undefined, detail: String(args.detail) }, agent(), 'tool') } as unknown as Record<string, unknown>; }
        catch (err) { throw new EngineToolError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err)); }
      })
    },
    {
      name: 'autode_workflow_next',
      description: 'The next assignment from the workflow (the hub): which stage, which role, its tier, what it consumes and produces, and instructions. Do it, then hand it in with autode_workflow_complete_stage. Never run another agent from inside an assignment.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: read('Next assignment'),
      handler: async (_args, ws) => {
        const sources = await ws.contextSources();
        return wrap(() => {
        const scope = scopeOf(ws);
        ensureWorkflow(scope);
        // PLN1b: while a stage's report is open, the plan comes first: the planner re-plans, a person approves.
        const reports = planningStatus(scope).reports.filter((r) => r.status === 'open');
        if (reports.length) {
          const plan = assignmentFor(scope, readWorkflow(rctx(ws).problemRoot)?.stages.find((s) => s.kind === 'plan')?.id ?? 'plan', allTools());
          return { next: { replan: true, reports, instructions: 'The work reported something that changes coverage. As the planner: read the reports (autode_planning_questions), revise the workflow (autode_propose_workflow) and the coverage (autode_propose_coverage); a person approves both. Stages already done stay done.' }, assignment: plan.assignment ?? null, ...(plan.reason ? { noAssignment: plan.reason } : {}) } as unknown as Record<string, unknown>;
        }
        const next = nextAssignment(rctx(ws));
        if (!next) return { next: null };
        // PA3b: the full assignment when a skill does the stage's kind; otherwise why not (a person does it).
        // MM2: the knowledge-maintenance items and unreviewed chat turns, and those touching this problem's assets.
        const m = problemMaintenance({ workspaceRoot: scope.workspaceRoot, resourcesRoot: scope.resourcesRoot, problemId: scope.problemId, sources });
        const maintenance = { open: m.open, unreviewedTurns: m.unreviewedTurns, touching: m.touching.map((i) => ({ key: i.key, rule: i.rule, agent: i.agent, title: i.title })) };
        if (next.stage.status === 'awaiting-approval') return { next, assignment: null, maintenance };
        // The joins, keys and grain the stage's context doesn't back go into its assignment (v0.45.9).
        const gaps = stageContextGaps(sources, { problemRoot: rctx(ws).problemRoot, kind: next.stage.kind, title: next.stage.title, mode: problemMode(rctx(ws).problemRoot) });
        const a = assignmentFor(scope, next.stage.id, allTools(), { gaps });
        // The same check the panel's Run agent makes (v0.45.8): say what's missing before the agent starts.
        const notReady = stageReadiness({ workspaceRoot: scope.workspaceRoot, problemRoot: rctx(ws).problemRoot, kind: next.stage.kind });
        return { next, assignment: a.assignment ?? null, ...(a.reason ? { noAssignment: a.reason } : {}), ...(notReady.length ? { notReady } : {}), maintenance };
        });
      }
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
      description: 'Propose the active problem\'s workflow (the plan gate). Without "workflow", AutoDE drafts it deterministically from "template" (default: its suggestion) and the facts about the spec and estate; with "workflow", your refinement of that draft is checked against the template\'s rules (mandatory stages and gates kept, reasons for stages left out or added, roles and tiers allowed, dependencies sound) and the composition rules (a stage taken from another template keeps its kind, gates and dependencies; a manual stage names its owner; a model follows the mapping and deployment follows validation; a "' + COMPOSED + '" workflow that moves data reconciles and validates it). A person approves the coverage, then it.',
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
        const t = templateOf(templatesFor(scope).templates, w.template.id);
        return { decision: { id: d.id, kind: d.kind, stakes: d.stakes, status: d.status, title: d.title, validation: d.validation }, diff: t ? diffWorkflow(w, t) as unknown as Record<string, unknown> : null, next: `A person approves it: the AutoDE panel, \`autode workflow approve\` in a terminal, or .autode/decisions/${d.id}.yaml. Tell the user.` };
      })
    },
    {
      name: 'autode_record_artifact',
      description: 'Record a deliverable of a stage you were assigned (a document, SQL, YAML): AutoDE writes it to the problem\'s output folder for that stage, archives the previous revision, checks its grounding against the estate (unresolved tables and columns are reported) and notes it in the workflow\'s history. It is a draft: the stage\'s approval is where a person accepts it. List the returned paths as the stage\'s outputs when it is handed in.',
      inputSchema: { type: 'object', required: ['stage', 'path', 'content'], additionalProperties: false, properties: { stage: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1, description: 'File name relative to the stage\'s folder, e.g. design.md or sql/stg_orders.sql.' }, content: { type: 'string' }, language: { type: 'string', description: 'sql, markdown, yaml, python, json; default from the extension.' }, primitives: { type: 'array', description: 'For compiled code: the Pipeline Spec steps it came from (kind, params, and lineage: the estate table its columns trace to), so its grounding manifest records which facts back each decision.', items: { type: 'object', required: ['kind', 'params'], properties: { kind: { type: 'string', minLength: 1 }, params: { type: 'object' }, lineage: { type: 'string' } } } } } },
      annotations: records('Record a deliverable'),
      handler: async (args, ws) => {
        const r = rctx(ws);
        const w = readWorkflow(r.problemRoot);
        const s = w?.stages.find((x) => x.id === args.stage);
        if (!w || !s || !s.included) throw new EngineToolError('NOT_FOUND', `No stage "${String(args.stage)}" in the active problem's workflow.`);
        try {
          return recordArtifact({ workspaceRoot: r.workspaceRoot, problemId: r.problemId, problemRoot: r.problemRoot, stage: { id: s.id, kind: s.kind }, path: String(args.path), content: String(args.content), language: args.language as string | undefined, who: agent(), channel: 'tool', sources: await ws.contextSources(), primitiveUses: ((args.primitives as Array<{ kind: string; params: Record<string, unknown>; lineage?: string }> | undefined) ?? []).map((p) => ({ kind: p.kind, params: p.params, lineage: p.lineage, source: 'primitive' as const })) }) as unknown as Record<string, unknown>;
        } catch (err) {
          throw new EngineToolError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err));
        }
      }
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
