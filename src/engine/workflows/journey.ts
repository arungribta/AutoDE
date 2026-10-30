import * as fs from 'node:fs';
import { BusinessProblemSpec } from '../types';
import type { ContextFileManager } from '../context/contextFileManager';
import { Assertion } from '../context/assertions';
import { isMirror } from '../context/projection';
import { isLowStakesFact } from '../decisions/decisionStore';
import { parseBusinessProblemSpec, readProblemDocument } from '../documents/problemDocuments';
import { problemMode } from '../documents/problemMode';
import { readInterview, summarizeInterview } from '../interview/state';
import { interviewSkills } from '../skills/skillRegistry';
import { loadSkillPack } from '../agents/definitions';
import { listComposites, listShared } from '../semantic/store';
import { DecisionStore } from '../decisions/decisionStore';
import { layoutPath } from '../workspaceLayout';
import { readWorkflow, WorkflowInstance } from './instance';
import { actorLabel, readEvents, WorkflowEvent } from './events';
import { WorkflowScope, computeDraft, problemRootOf, statusFor, suggestFor, templatesFor } from './service';
import { CoverageCheck, checkCoverage, effectiveCoverage, readCoverage, Coverage } from './coverage';

/**
 * The whole journey of a business problem, in five phases (UI2; docs/specs/
 * ui-simplification.md §3.2, §3.4): ① Problem, ② Discovery, ③ Specification,
 * ④ Workflow plan, ⑤ Delivery. Phases ①–④ are the template's *specify* and
 * *plan* stages opened up into steps; ⑤ is the template's other stages.
 * Computed from the state AutoDE already keeps, never stored: the Workflow tab,
 * the palette, `autode workflow status` and `autode_workflow_status` all render
 * this one answer. No VS Code import.
 */

export type JourneyStatus = 'done' | 'now' | 'waiting' | 'todo' | 'skipped';

/** What moves a step forward: a surface-neutral id that each surface maps to its own way of acting. */
export interface JourneyAction {
  id: string;
  label: string;
  /** The same in a terminal. */
  cli?: string;
  /** The same for an agent host. */
  mcp?: string;
  args?: Record<string, string>;
}

export interface JourneyStep {
  id: string;
  title: string;
  status: JourneyStatus;
  /** You, AutoDE, or the agent's role. */
  who: string;
  /** Where it stands, with counts. */
  line: string;
  action?: JourneyAction;
  /** Informs, never blocks (the glossary, the semantic layer). */
  checkpoint?: boolean;
  why: string;
  waitsOn?: string;
  parts?: Array<{ name: string; status: string; detail?: string }>;
  history: Array<{ at: string; what: string; channel?: string }>;
}

export interface JourneyPhase {
  n: 1 | 2 | 3 | 4 | 5;
  id: 'problem' | 'discovery' | 'specification' | 'plan' | 'delivery';
  title: string;
  status: JourneyStatus;
  summary: string;
  steps: JourneyStep[];
}

export interface DeliveryPreview {
  template: string;
  suggested?: string;
  alternatives: Array<{ id: string; title: string; suggested: boolean; reason: string }>;
  stages: Array<{ id: string; title: string; kind: string; inclusion: string; included: boolean; reason?: string; lanes: string[]; dashed: boolean }>;
}

export interface Journey {
  problemId: string;
  statement: string;
  mode: string;
  holds: { systems: number; tables: number; facts: number };
  current: { phase: number; phaseTitle: string; step?: string; line: string; action?: JourneyAction };
  phases: JourneyPhase[];
  /** Before the plan is approved: the delivery stages as they would be, for a template. */
  preview?: DeliveryPreview;
  /** PLN0: the specification's coverage by the workflow, with the engine's checks. */
  coverage?: Coverage & { check: CoverageCheck };
  /** What waits for you, in a line. */
  waiting: string[];
}

/** What a journey reads from an open context (the estate, the catalog, the ledger): the caller has one open. */
export interface JourneyContext {
  systems: Array<{ id: string; name: string; role: string; tables: number }>;
  facts: { total: number; high: number };
  glossary: { terms: number; uncategorized: number };
}

/** From an open context (the panel, the CLI). */
export function journeyContext(cfm: ContextFileManager): JourneyContext {
  return journeyContextFrom({ systems: cfm.getEstate().systems, catalog: cfm.getCatalog().all(), assertions: cfm.getLedger().assertions() });
}

/** From the parts themselves (the MCP server holds a read-only projection, not an open context). */
export function journeyContextFrom(parts: { systems: ReadonlyArray<{ id: string; name: string; role: string }>; catalog: ReadonlyArray<{ system: string }>; assertions: readonly Assertion[] }): JourneyContext {
  const counts = new Map<string, number>();
  for (const e of parts.catalog) counts.set(e.system, (counts.get(e.system) ?? 0) + 1);
  const waiting = parts.assertions.filter((a) => !isMirror(a) && (a.status === 'proposed' || a.status === 'needs_review'));
  const terms = parts.assertions.filter((a) => a.kind === 'business_term' && a.status === 'active');
  return {
    systems: parts.systems.map((s) => ({ id: s.id, name: s.name, role: s.role, tables: counts.get(s.id) ?? 0 })),
    facts: { total: waiting.length, high: waiting.filter((a) => !isLowStakesFact(a.kind, a.predicate)).length },
    glossary: { terms: terms.length, uncategorized: terms.filter((a) => !(a.value as { category?: string } | undefined)?.category).length }
  };
}

export interface JourneyInput extends WorkflowScope {
  context?: JourneyContext;
  /** The template the delivery preview shows (default: the suggested one, or the workflow's). */
  previewTemplate?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function historyOf(events: readonly WorkflowEvent[], pick: (e: WorkflowEvent) => boolean): JourneyStep['history'] {
  return events.filter(pick).map((e) => ({ at: e.at, what: `${e.type}${e.stage ? ` ${e.stage}` : ''} by ${actorLabel(e.actor)}${e.reason ? `: ${e.reason}` : ''}`, channel: e.channel })).slice(-10);
}

function phaseStatus(steps: readonly JourneyStep[], blocking = steps.filter((s) => !s.checkpoint)): JourneyStatus {
  if (blocking.every((s) => s.status === 'done' || s.status === 'skipped')) return 'done';
  if (blocking.some((s) => s.status === 'waiting')) return 'waiting';
  if (blocking.some((s) => s.status === 'now' || s.status === 'done')) return 'now';
  return 'todo';
}

export function journeyFor(input: JourneyInput): Journey {
  const root = problemRootOf(input);
  let spec: BusinessProblemSpec | undefined;
  try { const text = readProblemDocument(root, 'spec'); if (text) spec = parseBusinessProblemSpec(text); } catch { /* no specification yet */ }
  const events = readEvents(root);
  const ctx = input.context;
  const workflow = readWorkflow(root);
  const store = new DecisionStore(input.workspaceRoot);
  const pendingWorkflow = store.list({ status: 'pending', kind: 'workflow' }).find((d) => d.problemId === input.problemId);
  const specApproved = spec?.status === 'approved' && spec.problemStatementApproved === true;
  const statement = spec?.problemStatement ?? '';

  // ① Problem
  const p1: JourneyStep[] = [
    { id: 'statement', title: 'Statement written', status: statement.trim() ? 'done' : 'now', who: 'You', line: statement.trim() ? `"${statement.slice(0, 120)}"` : 'No statement yet.', why: 'What the problem is, in your words: everything after it builds on it.', ...(statement.trim() ? {} : { action: { id: 'write-statement', label: 'Describe the problem', cli: 'autode problems new "<statement>"', mcp: 'autode_start_problem' } }), history: [] },
    { id: 'confirm', title: 'Statement confirmed', status: spec?.problemStatementApproved ? 'done' : statement.trim() ? 'waiting' : 'todo', who: 'You', line: spec?.problemStatementApproved ? 'Confirmed.' : 'Confirm it says what you mean.', why: 'The interview and discovery start from the confirmed statement.', ...(spec?.problemStatementApproved || !statement.trim() ? {} : { action: { id: 'confirm-statement', label: 'Confirm the statement' } }), history: [] }
  ];

  // ② Discovery
  const greenfield = spec?.implementationType === 'greenfield';
  const sources = (ctx?.systems ?? []).filter((s) => s.role === 'source' || s.role === 'both');
  const sourceTables = sources.reduce((n, s) => n + s.tables, 0);
  const sourcesStep: JourneyStep = {
    id: 'sources', title: 'Sources in the estate', who: sources.length ? 'AutoDE' : 'You',
    status: greenfield ? 'skipped' : sourceTables > 0 ? 'done' : specApproved ? 'done' : 'waiting',
    line: greenfield ? 'Greenfield: no source system is needed.' : sources.length ? sources.map((s) => `${s.id}: ${plural(s.tables, 'table')}`).join(' · ') : 'No source system yet: connect one, or ingest DDL or files.',
    why: 'The source systems\' tables are what the specification, mappings and pipelines are grounded in.',
    parts: sources.map((s) => ({ name: s.name || s.id, status: s.tables ? 'read' : 'not read', detail: plural(s.tables, 'table') })),
    ...(greenfield || sourceTables > 0 ? {} : { action: { id: 'source-assessment', label: 'Bring a source in', cli: 'autode estate extract --connection <id> --schema <DB.SCHEMA>', mcp: 'autode_ingest_metadata' } }),
    history: []
  };
  let interviewStep: JourneyStep;
  try {
    const s = readInterview(root, input.workspaceRoot);
    const skills = interviewSkills(loadSkillPack(input.resourcesRoot).skills, fs.existsSync(layoutPath(input.workspaceRoot, 'skills')) ? layoutPath(input.workspaceRoot, 'skills') : undefined);
    const sum = s ? summarizeInterview(s, skills) : undefined;
    const addressed = sum ? sum.parts.filter((x) => x.status === 'addressed').length : 0;
    const done = specApproved || sum?.status === 'done';
    const nextPart = sum?.parts.find((x) => x.status !== 'addressed');
    interviewStep = {
      id: 'interview', title: 'Interview', who: 'You', checkpoint: false,
      status: done ? 'done' : sum ? (sum.open.length ? 'waiting' : 'now') : statement.trim() ? 'todo' : 'todo',
      line: !sum ? 'Not started.' : done ? `${plural(addressed, 'part')} covered.` : `${addressed} of ${sum.parts.length} parts covered${sum.open.length ? ` · ${plural(sum.open.length, 'open question')}` : ''}${nextPart ? ` · next: ${nextPart.name}` : ''}`,
      why: 'The interview asks what the specification needs: requirements, sources, data flow, transformations, quality and constraints.',
      parts: sum?.parts.map((x) => ({ name: x.name, status: x.status })),
      ...(done ? {} : { action: { id: 'answer-interview', label: sum?.open.length ? `Answer ${plural(sum.open.length, 'question')}` : 'Continue the interview', cli: 'autode interview', mcp: 'autode_interview_state' } }),
      history: []
    };
  } catch {
    interviewStep = { id: 'interview', title: 'Interview', who: 'You', status: specApproved ? 'done' : 'todo', line: 'Not started.', why: 'The interview asks what the specification needs.', history: [] };
  }
  const facts = ctx?.facts ?? { total: 0, high: 0 };
  const factsStep: JourneyStep = {
    id: 'facts', title: 'Facts to review', who: 'You', status: facts.total ? 'waiting' : 'done',
    line: facts.total ? `${plural(facts.total, 'fact')} wait for you${facts.high ? ` (${facts.high} high stakes)` : ''}.` : 'Nothing waits for review.',
    why: 'Facts AutoDE read or inferred (keys, grains, relationships, rules) are confirmed by a person before they are trusted.',
    ...(facts.total ? { action: { id: 'review-facts', label: `Review ${plural(facts.total, 'fact')}`, cli: 'autode facts list', mcp: 'autode_list_assertions' } } : {}),
    history: []
  };
  const glossary = ctx?.glossary ?? { terms: 0, uncategorized: 0 };
  const glossaryStep: JourneyStep = {
    id: 'glossary', title: 'Glossary', who: 'Knowledge engineer', checkpoint: true, status: glossary.terms && !glossary.uncategorized ? 'done' : 'todo',
    line: glossary.terms ? `${plural(glossary.terms, 'term')}${glossary.uncategorized ? ` · ${glossary.uncategorized} in no category` : ''}` : 'No business terms yet.',
    why: 'Business terms give agents the problem\'s own words. A checkpoint, not a gate: it never blocks approval.',
    ...(glossary.uncategorized ? { action: { id: 'structure-glossary', label: 'Structure the glossary' } } : {}), history: []
  };
  let models = 0;
  try { models = listShared(input.workspaceRoot).length + listComposites(input.workspaceRoot, input.problemId).length; } catch { /* no semantic folder */ }
  const semanticStep: JourneyStep = {
    id: 'semantic', title: 'Semantic layer', who: 'Semantic modeler', checkpoint: true, status: models ? 'done' : 'todo',
    line: models ? `${plural(models, 'model')} (shared and this problem's).` : 'No semantic model yet.',
    why: 'Governed metrics and dimensions over the problem\'s tables. A checkpoint, not a gate: it never blocks approval.',
    ...(models ? {} : { action: { id: 'draft-semantic', label: 'Draft a model', mcp: 'autode_semantic_draft' } }), history: []
  };
  const p2 = [sourcesStep, interviewStep, factsStep, glossaryStep, semanticStep];

  // ③ Specification
  const specEvents = (e: WorkflowEvent) => e.stage === 'specify';
  const p3: JourneyStep[] = [
    { id: 'drafted', title: 'Drafted', who: 'Business analyst', status: spec && (spec.objectives?.length || spec.scope?.in?.length) ? 'done' : interviewStep.status === 'done' ? 'now' : 'todo', line: spec ? `Version ${spec.version ?? 1}${spec.objectives?.length ? ` · ${plural(spec.objectives.length, 'objective')}` : ''}${spec.scope?.in?.length ? ` · ${spec.scope.in.length} in scope` : ''}` : 'Not drafted.', why: 'The specification is drafted from the interview and discovery.', ...(spec?.objectives?.length ? {} : { action: { id: 'draft-spec', label: 'Draft the specification' } }), history: historyOf(events, specEvents) },
    { id: 'approved', title: 'Approved', who: 'You', status: specApproved ? 'done' : spec?.objectives?.length ? 'waiting' : 'todo', line: specApproved ? `Approved${spec?.approvedAt ? ` on ${String(spec.approvedAt).slice(0, 10)}` : ''}.` : 'Review and approve it.', why: 'An approved specification is what the workflow is planned from.', ...(specApproved || !spec?.objectives?.length ? {} : { action: { id: 'approve-spec', label: 'Approve the specification', cli: 'autode workflow approve specify' } }), history: [] }
  ];

  // ④ Workflow plan, with PLN0 coverage
  const suggestion = (() => { try { return suggestFor(input); } catch { return undefined; } })();
  const planApproved = workflow?.status === 'approved';
  let coverage: Journey['coverage'];
  const planned: WorkflowInstance | undefined = planApproved ? workflow : (pendingWorkflow ? store.proposal<WorkflowInstance>(pendingWorkflow.id) : workflow);
  if (spec && planned) {
    const c = effectiveCoverage(spec, planned, readCoverage(root));
    coverage = { ...c, check: checkCoverage(c, spec, planned) };
  }
  const planEvents = (e: WorkflowEvent) => !e.stage || e.stage === 'plan';
  const p4: JourneyStep[] = [
    { id: 'template', title: 'Template suggested', who: 'AutoDE', status: suggestion ? 'done' : 'todo', line: suggestion ? `${suggestion.id}: ${suggestion.reason}` : 'Waits for the specification.', why: 'The template is the stage catalogue for this kind of engagement.', history: historyOf(events, (e) => e.type === 'suggested') },
    {
      id: 'coverage', title: 'Coverage of the specification', who: coverage?.check.counts.question ? 'You' : 'AutoDE',
      status: !coverage ? 'todo' : coverage.approvedBy ? 'done' : coverage.check.ok ? 'now' : 'waiting',
      line: !coverage ? 'Waits for the specification and a plan.' : `${coverage.check.counts.covered} covered · ${coverage.check.counts.question} to place · ${coverage.check.counts['out-of-scope']} out of scope · ${coverage.check.counts.gap} gaps${coverage.approvedBy ? ` · approved by ${coverage.approvedBy}` : ''}`,
      why: 'Every in-scope item and objective is delivered by named stages, out of scope with a reason, or a gap: nothing drops silently (workflow-planning.md).',
      waitsOn: coverage?.check.counts.question ? 'Items no stage delivers: place them before the workflow can be approved.' : undefined,
      parts: coverage?.entries.map((e) => ({ name: e.text, status: e.status, detail: e.stages?.join(', ') ?? e.reason })),
      ...(coverage?.check.counts.question ? { action: { id: 'place-coverage', label: `Place ${plural(coverage.check.counts.question, 'item')}`, cli: 'autode workflow coverage', mcp: 'autode_coverage' } } : {}),
      history: []
    },
    { id: 'approved', title: 'Plan approved', who: 'You', status: planApproved ? 'done' : pendingWorkflow ? 'waiting' : specApproved ? 'now' : 'todo', line: planApproved ? `${workflow!.template.id}, approved by ${workflow!.approvedBy ?? 'unknown'}.` : pendingWorkflow ? `Proposed: ${pendingWorkflow.title}.` : 'Choose a template and propose the workflow.', why: 'The approved plan decides the delivery stages.', ...(planApproved ? {} : pendingWorkflow ? { action: { id: 'approve-workflow', label: 'Approve the plan', cli: 'autode workflow approve' } } : specApproved ? { action: { id: 'propose-workflow', label: 'Propose the workflow', cli: 'autode workflow propose', mcp: 'autode_propose_workflow' } } : {}), history: historyOf(events, planEvents) }
  ];

  // ⑤ Delivery
  const p5: JourneyStep[] = [];
  let preview: DeliveryPreview | undefined;
  if (planApproved) {
    try {
      const st = statusFor(input);
      for (const v of st.stages.filter((x) => x.kind !== 'specify' && x.kind !== 'plan')) {
        const status: JourneyStatus = v.status === 'done' ? 'done' : v.status === 'skipped' ? 'skipped' : v.status === 'awaiting-approval' || v.status === 'stale' ? 'waiting' : v.status === 'ready' || v.status === 'in-progress' ? 'now' : 'todo';
        p5.push({ id: v.id, title: v.title, status, who: v.status === 'awaiting-approval' ? 'You' : v.agent?.role ?? 'You', line: v.why ?? v.status.replace('-', ' '), why: `A ${v.kind} stage (${v.inclusion}).`, ...(status === 'now' ? { action: { id: 'run-stage', label: 'Run it', args: { stage: v.id }, cli: `autode workflow run ${v.id}` } } : status === 'waiting' ? { action: { id: 'approve-stage', label: 'Approve', args: { stage: v.id }, cli: `autode workflow approve ${v.id}` } } : {}), history: historyOf(events, (e) => e.stage === v.id) });
      }
    } catch { /* a workflow that can't be read: the Workflow view says why */ }
  } else {
    try {
      const templates = templatesFor(input).templates;
      const chosen = input.previewTemplate ?? (pendingWorkflow ? store.proposal<WorkflowInstance>(pendingWorkflow.id).template.id : suggestion?.id);
      const { workflow: draft, template } = computeDraft(input, chosen);
      const text = [statement, ...(spec?.objectives ?? []), ...(spec?.scope?.in ?? [])].join(' ').toLowerCase();
      preview = {
        template: template.id, suggested: suggestion?.id,
        alternatives: templates.map((t) => {
          const hits = t.suggestWhen.filter((w) => text.includes(w.toLowerCase()));
          return { id: t.id, title: t.title, suggested: t.id === suggestion?.id, reason: t.id === suggestion?.id ? suggestion!.reason : hits.length ? `mentions ${hits.map((h) => `"${h}"`).join(', ')}` : 'nothing in the specification points to it' };
        }),
        stages: draft.stages.filter((s) => s.kind !== 'specify' && s.kind !== 'plan').map((s) => ({ id: s.id, title: s.title, kind: s.kind, inclusion: s.inclusion, included: s.included, reason: s.reason, lanes: s.systems ?? [], dashed: s.inclusion === 'optional' || s.inclusion === 'conditional' }))
      };
    } catch { /* no template catalogue: nothing to preview */ }
  }

  const phases: JourneyPhase[] = [
    { n: 1, id: 'problem', title: 'Problem', status: phaseStatus(p1), summary: p1[1].status === 'done' ? 'Statement confirmed' : p1[0].status === 'done' ? 'Statement waits for confirmation' : 'No statement yet', steps: p1 },
    { n: 2, id: 'discovery', title: 'Discovery', status: specApproved ? 'done' : phaseStatus(p2), summary: [interviewStep.parts ? `${interviewStep.parts.filter((x) => x.status === 'addressed').length} of ${interviewStep.parts.length} interview parts` : '', facts.total ? `${plural(facts.total, 'fact')} to review` : '', sources.length ? `${plural(sourceTables, 'table')} in ${plural(sources.length, 'source')}` : ''].filter(Boolean).join(' · ') || 'Not started', steps: p2 },
    { n: 3, id: 'specification', title: 'Specification', status: phaseStatus(p3), summary: specApproved ? 'Approved' : spec?.objectives?.length ? 'Drafted, waits for approval' : 'Not drafted', steps: p3 },
    { n: 4, id: 'plan', title: 'Workflow plan', status: planApproved ? 'done' : specApproved || pendingWorkflow ? phaseStatus(p4) : 'todo', summary: planApproved ? `${workflow!.template.id} approved` : pendingWorkflow ? 'Proposed, waits for approval' : suggestion ? `${suggestion.id} suggested` : 'Not planned', steps: p4 },
    { n: 5, id: 'delivery', title: 'Delivery', status: planApproved ? (p5.length ? phaseStatus(p5) : 'done') : 'todo', summary: planApproved ? `${p5.filter((s) => s.status === 'done').length} of ${p5.filter((s) => s.status !== 'skipped').length} stages done` : preview ? `Preview: ${preview.stages.filter((s) => s.included).length} stages (${preview.template})` : 'Waits for the plan', steps: p5 }
  ];
  // Where you are: the first phase not done, at its first step that isn't done.
  const phase = phases.find((p) => p.status !== 'done') ?? phases[phases.length - 1];
  const step = phase.steps.find((s) => !s.checkpoint && s.status !== 'done' && s.status !== 'skipped') ?? phase.steps.find((s) => s.status !== 'done' && s.status !== 'skipped');
  const holdsTables = (ctx?.systems ?? []).reduce((n, s) => n + s.tables, 0);
  const waiting = [facts.total ? `${plural(facts.total, 'fact')} wait for you` : '', pendingWorkflow ? 'the plan waits for your approval' : '', coverage?.check.counts.question ? `${plural(coverage.check.counts.question, 'scope item')} to place` : ''].filter(Boolean);
  return {
    problemId: input.problemId, statement, mode: problemMode(root),
    holds: { systems: ctx?.systems.length ?? 0, tables: holdsTables, facts: facts.total },
    current: { phase: phase.n, phaseTitle: phase.title, step: step?.id, line: step ? `${step.title}: ${step.line}` : phase.summary, action: step?.action },
    phases, ...(preview ? { preview } : {}), ...(coverage ? { coverage } : {}), waiting
  };
}

/** The journey as lines for a terminal (`autode workflow status`, phases first). */
export function journeyLines(j: Journey): string[] {
  const mark: Record<JourneyStatus, string> = { done: '✓', now: '●', waiting: '◆', todo: '○', skipped: '–' };
  const lines = [`${j.problemId}: ${j.statement}`, `You are here: phase ${j.current.phase} of 5 · ${j.current.phaseTitle} — ${j.current.line}${j.current.action?.cli ? ` (${j.current.action.cli})` : ''}`, ''];
  for (const p of j.phases) {
    lines.push(`${mark[p.status]} ${p.n}. ${p.title} — ${p.summary}`);
    if (p.n === j.current.phase || p.status === 'waiting') for (const s of p.steps) lines.push(`    ${mark[s.status]} ${s.title} (${s.who})${s.checkpoint ? ' [checkpoint]' : ''}: ${s.line}`);
  }
  if (j.coverage?.check.counts.question) lines.push('', 'To place before the plan can be approved:', ...j.coverage.entries.filter((e) => e.status === 'question').map((e) => `    ? ${e.id} "${e.text}": ${e.reason ?? ''}`));
  if (j.preview) lines.push('', `Delivery preview (${j.preview.template}${j.preview.suggested === j.preview.template ? ', suggested' : ''}): ${j.preview.stages.filter((s) => s.included).map((s) => `${s.title}${s.lanes.length ? ` [${s.lanes.join(' | ')}]` : ''}`).join(' → ')}`);
  if (j.waiting.length) lines.push('', `Waits for you: ${j.waiting.join(' · ')}`);
  return lines;
}
