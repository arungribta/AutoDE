import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml, stringifyYaml } from '../context/Yaml';
import { parseEstate } from '../context/estate';
import { readPackFile } from '../context/packChecks';
import { layoutPath } from '../workspaceLayout';
import { Artifact, Gate, STAGE_KINDS, StageKind, TIERS, Tier, tierRank } from './stageKinds';
import { ConditionFacts, Dependency, Inclusion, TemplateStage, WorkflowTemplate, checkStructure, parseCondition } from './templates';
import { Actor } from './events';

/**
 * A problem's workflow (PA3a): the planning stage's approved output, kept in
 * `.autode/problems/<id>/workflow.yaml`. It starts as a deterministic draft
 * from the chosen template and the facts about the spec and estate; the
 * planner (PA3b) refines it; the engine checks it against the template's
 * rules; a person approves it as a `workflow` decision.
 */

export type StageStatus = 'pending' | 'ready' | 'in-progress' | 'awaiting-check' | 'awaiting-approval' | 'done' | 'skipped' | 'stale';

export interface AgentAssignment {
  /** A role template (`agents/<role>.md`), allowed by the stage kind. */
  role: string;
  /** Context for this stage only — never the method, which lives in skills (PA3b writes these). */
  brief?: string;
  skills?: string[];
  tier?: Tier;
}

export interface StageTask { id: string; title: string; done?: boolean }

export interface StageRecord {
  status: StageStatus;
  startedAt?: string;
  completedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  /** The gate decision that approved it, when its output isn't a document with its own approval. */
  decisionId?: string;
  /** Revisions of what it consumed when it was approved — a later change makes it stale. */
  inputs?: Record<string, string>;
  outputs?: string[];
  reason?: string;
  by?: string;
  /** When it was last re-opened: its document approved before then is the version being redone, not an approval (v0.45.10 fix). */
  reopenedAt?: string;
}

export interface WorkflowStage {
  id: string;
  title: string;
  kind: StageKind;
  /** PLN1: `combined` is a stage taken from another template (`fromTemplate`), with its dependencies and gates. */
  origin: 'template' | 'added' | 'combined';
  fromTemplate?: string;
  inclusion: Inclusion;
  /** In this problem's workflow. A stage left out keeps its row, with the reason. */
  included: boolean;
  reason?: string;
  when?: string;
  after: Dependency[];
  consumes: Artifact[];
  produces: Artifact[];
  gates: Gate[];
  repeat?: 'per-source-system';
  join?: 'all' | 'any';
  /** For a repeated stage: the source systems it covers (tasks inside one stage, owner's decision 2026-10-21). */
  systems?: string[];
  tasks: StageTask[];
  agent?: AgentAssignment;
  /** PLN1: who does a `manual` stage outside AutoDE (a person, a team). */
  owner?: string;
  record: StageRecord;
}

export interface WorkflowInstance {
  problemId: string;
  template: { id: string; version: number };
  status: 'draft' | 'proposed' | 'approved';
  createdAt: string;
  approvedAt?: string;
  approvedBy?: string;
  decisionId?: string;
  /** The facts the draft was built from. */
  facts: ConditionFacts;
  /** Who did what (v0.44.1): the engine's suggestion and draft, the person who chose the template, an agent that refined it. */
  provenance?: { suggested?: { template: string; rule: string }; chosenBy?: Actor; draftedBy?: Actor; refinedBy?: Actor; proposedBy?: Actor };
  stages: WorkflowStage[];
}

export function workflowFile(problemRoot: string): string {
  return path.join(problemRoot, 'workflow.yaml');
}

export function readWorkflow(problemRoot: string): WorkflowInstance | undefined {
  try { return parseYaml(fs.readFileSync(workflowFile(problemRoot), 'utf8')) as WorkflowInstance; } catch { return undefined; }
}

export function writeWorkflow(problemRoot: string, w: WorkflowInstance): void {
  const file = workflowFile(problemRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `# AutoDE workflow (PA3a): this problem's planned stages and their state. Changed through the workflow commands and decisions.\n${stringifyYaml(w)}`);
  fs.renameSync(tmp, file);
}

/** What `when:` conditions read: source systems in the estate, a contract in the problem's pack, legacy code (set by the planner). */
export function workflowFacts(workspaceRoot: string, problemRoot: string | undefined, overrides: Partial<ConditionFacts> = {}): ConditionFacts {
  let systems: Array<{ role?: string }> = [];
  try { systems = parseEstate(fs.readFileSync(layoutPath(workspaceRoot, 'estate'), 'utf8')).systems; } catch { /* no estate yet */ }
  let hasContract = false;
  if (problemRoot) { try { hasContract = readPackFile(path.join(problemRoot, 'pack')).documents.some((d) => d.role === 'contract'); } catch { /* no pack */ } }
  return {
    'estate.sources': sourceSystems(workspaceRoot).length,
    'estate.systems': systems.length,
    'pack.has_contract': hasContract,
    'estate.has_legacy_code': false,
    ...overrides
  };
}

/** Files that hold the team's own knowledge; a system bound only to them (registered by mistake before v0.45.8) is not a source. */
const KNOWLEDGE_FILES = ['business-context.yaml', 'verified-queries.yaml'];

export function sourceSystems(workspaceRoot: string): string[] {
  try {
    const estate = parseEstate(fs.readFileSync(layoutPath(workspaceRoot, 'estate'), 'utf8'));
    const knowledgeOnly = (id: string) => { const b = estate.bindings.filter((x) => x.system === id); return b.length > 0 && b.every((x) => x.file && KNOWLEDGE_FILES.includes(x.file.toLowerCase())); };
    return estate.systems.filter((s) => (s.role === 'source' || s.role === 'both') && !knowledgeOnly(s.id)).map((s) => s.id);
  } catch { return []; }
}

function stageFrom(t: TemplateStage, included: boolean, reason: string | undefined, systems: string[]): WorkflowStage {
  const kind = STAGE_KINDS[t.kind];
  return {
    id: t.id, title: t.title, kind: t.kind, origin: 'template', inclusion: t.inclusion, included, reason, when: t.when,
    after: t.after, consumes: t.consumes, produces: t.produces, gates: t.gates, repeat: t.repeat, join: t.join,
    systems: t.repeat ? systems : undefined,
    tasks: t.repeat ? systems.map((s) => ({ id: `${t.id}:${s}`, title: `${t.title}: ${s}` })) : [],
    agent: kind.roles.length ? { role: kind.roles[0], tier: kind.ceiling } : undefined,
    record: { status: 'pending' }
  };
}

/**
 * The deterministic draft: mandatory and default stages, conditional ones whose
 * condition holds (the condition is the reason when it doesn't), optional ones
 * left out; repeated stages expanded per source system as tasks; each stage
 * given its kind's first role at its ceiling. The planner refines this.
 */
export function draftWorkflow(template: WorkflowTemplate, problemId: string, facts: ConditionFacts, systems: string[], now: Date = new Date()): WorkflowInstance {
  const stages = template.stages.map((t) => {
    if (t.inclusion === 'conditional' && t.when) {
      const c = parseCondition(t.when);
      const on = c.ok && c.test(facts);
      return stageFrom(t, on, on ? undefined : `condition "${t.when}" is false`, systems);
    }
    return stageFrom(t, t.inclusion !== 'optional', undefined, systems);
  });
  return { problemId, template: { id: template.id, version: template.version }, status: 'draft', createdAt: now.toISOString(), facts, stages };
}

export interface PlanCheck { errors: string[]; warnings: string[] }

/**
 * PLN1: a workflow built from stage kinds alone, where no template fits (workflow-planning.md §3.2). It has
 * no stage catalogue: every stage is added with a reason, and the composition rules hold as for any workflow.
 */
export const COMPOSED = 'composed';
export const composedTemplate: WorkflowTemplate = { id: COMPOSED, version: 1, title: 'Composed workflow', description: 'Built from stage kinds where no template fits; every stage has a reason.', suggestWhen: [], stages: [], origin: 'engine' };

/** The template a workflow is checked against: the named one, or the composed workflow's empty catalogue. */
export function templateOf(templates: readonly WorkflowTemplate[], id: string | undefined): WorkflowTemplate | undefined {
  return id === COMPOSED ? composedTemplate : templates.find((t) => t.id === id);
}

/** Whether `from` depends on `on`, directly or through other stages. */
function dependsOn(byId: ReadonlyMap<string, WorkflowStage>, from: string, on: string, seen = new Set<string>()): boolean {
  for (const d of byId.get(from)?.after ?? []) {
    if (d.stage === on) return true;
    if (!seen.has(d.stage)) { seen.add(d.stage); if (dependsOn(byId, d.stage, on, seen)) return true; }
  }
  return false;
}

/**
 * The composition rules (PLN1; workflow-planning.md §3.2) for what a template didn't place: a stage taken from
 * another template keeps its kind, gates and dependencies; a manual stage names its owner and has no agent;
 * a model's approval follows the mapping's and deployment follows validation; a composed workflow that moves
 * data between systems reconciles and validates it.
 */
function checkComposition(w: WorkflowInstance, templates: readonly WorkflowTemplate[], errors: string[]): void {
  const included = w.stages.filter((s) => s.included);
  const byId = new Map(included.map((s) => [s.id, s]));
  for (const s of w.stages.filter((x) => x.origin === 'combined')) {
    const from = templates.find((t) => t.id === s.fromTemplate);
    const t = from?.stages.find((x) => x.id === s.id);
    if (!from) { errors.push(`${s.id}: taken from template "${s.fromTemplate ?? ''}", which doesn't exist (known: ${templates.map((x) => x.id).join(', ')}).`); continue; }
    if (!t) { errors.push(`${s.id}: template ${from.id} has no stage ${s.id} (its stages: ${from.stages.map((x) => x.id).join(', ')}).`); continue; }
    if (s.kind !== t.kind) errors.push(`${s.id}: its kind is ${t.kind} in template ${from.id}.`);
    if (!s.reason) errors.push(`${s.id}: a stage taken from template ${from.id} needs a reason.`);
    if (!s.included) continue;
    for (const g of t.gates) if (!s.gates.includes(g)) errors.push(`${s.id}: the ${g} gate it has in template ${from.id} can't be removed.`);
    for (const d of t.after) if (byId.has(d.stage) && !s.after.some((x) => x.stage === d.stage && (x.approved || !d.approved))) errors.push(`${s.id}: keeps its dependency on ${d.stage}${d.approved ? ' (approved)' : ''} from template ${from.id}.`);
  }
  for (const s of w.stages.filter((x) => x.kind === 'manual')) {
    if (s.agent) errors.push(`${s.id}: a manual stage has no agent; a person does it outside AutoDE.`);
    if (!s.owner?.trim()) errors.push(`${s.id}: a manual stage names its owner (a person or a team).`);
  }
  const ofKind = (k: StageKind) => included.filter((s) => s.kind === k);
  const order: Array<[StageKind, StageKind, string]> = [['modelling', 'mapping', 'a model is approved after the mapping'], ['deploy', 'validate', 'deployment follows validation']];
  // A template's own order is its author's, reviewed with the template; these hold for what the planner placed.
  const planned = (s: WorkflowStage) => s.origin !== 'template' || w.template.id === COMPOSED;
  for (const [later, earlier, what] of order) {
    for (const l of ofKind(later)) for (const e of ofKind(earlier)) if ((planned(l) || planned(e)) && !dependsOn(byId, l.id, e.id)) errors.push(`${l.id}: must come after ${e.id} (${what}).`);
  }
  if (w.template.id === COMPOSED) {
    const movesData = included.some((s) => s.kind === 'build' || s.kind === 'code-conversion') && included.some((s) => s.kind === 'source-assessment' || s.consumes.includes('source-context'));
    if (movesData) for (const k of ['reconcile', 'validate'] as StageKind[]) if (!ofKind(k).length) errors.push(`A composed workflow that moves data between systems needs a ${k} stage.`);
  }
}

/** The longest brief a planner may write for a stage (v0.45.12). */
export const MAX_BRIEF = 1500;

/** The rules every workflow must follow (§9.2 PA3 §2), item by item. */
export function checkWorkflow(w: WorkflowInstance, template: WorkflowTemplate, opts: { skills?: ReadonlyArray<{ id: string; stageKinds: readonly string[] }>; templates?: readonly WorkflowTemplate[] } = {}): PlanCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  // The planner's briefs and skill choices (v0.45.12): a brief carries context, never the method or the tools.
  for (const s of w.stages) {
    const brief = s.agent?.brief;
    if (brief !== undefined) {
      if (typeof brief !== 'string' || !brief.trim()) errors.push(`${s.id}: a brief is text (or left out).`);
      else {
        if (brief.length > MAX_BRIEF) errors.push(`${s.id}: the brief is ${brief.length} characters; keep it under ${MAX_BRIEF} (context only: entities, constraints, open questions, what to produce).`);
        const named = [...new Set([...brief.matchAll(/\bautode_[a-z_]+\b|\bautode-[a-z]+-[a-z0-9-]+\b/g)].map((m) => m[0]))];
        if (named.length) errors.push(`${s.id}: the brief names ${named.join(', ')}. A brief carries context only; the role's tools and the stage's skills carry the method, within the tier.`);
      }
    }
    if (opts.skills && s.agent?.skills?.length) {
      for (const id of s.agent.skills) {
        const k = opts.skills.find((x) => x.id === id);
        if (!k) errors.push(`${s.id}: skill ${id} doesn't exist (autode skills list).`);
        else if (k.stageKinds.length && !k.stageKinds.includes(s.kind)) errors.push(`${s.id}: skill ${id} is for ${k.stageKinds.join(', ')} stages, not ${s.kind}.`);
      }
    }
  }
  if (w.template.id !== template.id) errors.push(`The workflow is from template ${w.template.id}, not ${template.id}.`);
  const byId = new Map(w.stages.map((s) => [s.id, s]));
  const ids = new Set<string>();
  for (const s of w.stages) {
    if (ids.has(s.id)) errors.push(`${s.id}: duplicate stage id.`);
    ids.add(s.id);
    const kind = STAGE_KINDS[s.kind];
    if (!kind) { errors.push(`${s.id}: unknown stage kind "${s.kind}".`); continue; }
    if (s.agent) {
      if (!kind.roles.includes(s.agent.role)) errors.push(`${s.id}: role ${s.agent.role} can't do a ${s.kind} stage (allowed: ${kind.roles.join(', ')}).`);
      if (s.agent.tier && (!TIERS.includes(s.agent.tier) || tierRank(s.agent.tier) > tierRank(kind.ceiling))) errors.push(`${s.id}: tier ${s.agent.tier} is above the ${s.kind} ceiling (${kind.ceiling}).`);
    }
    if (!s.included && !s.reason && s.inclusion !== 'optional') errors.push(`${s.id}: a ${s.inclusion} stage left out needs a reason.`);
    if (s.included) for (const d of s.after) { const dep = byId.get(d.stage); if (dep && !dep.included) errors.push(`${s.id}: depends on ${d.stage}, which is not in the workflow.`); }
  }
  for (const t of template.stages) {
    const s = byId.get(t.id);
    if (t.inclusion === 'mandatory' && (!s || !s.included)) { errors.push(`${t.id}: a mandatory stage of ${template.id} can't be left out.`); continue; }
    if (!s) { if (t.inclusion !== 'optional') errors.push(`${t.id}: a ${t.inclusion} stage left out needs a row with a reason.`); continue; }
    if (s.kind !== t.kind) errors.push(`${t.id}: its kind is ${t.kind} in the template.`);
    if (s.included) for (const g of t.gates) if (!s.gates.includes(g)) errors.push(`${t.id}: the ${g} gate can't be removed.`);
  }
  for (const s of w.stages.filter((x) => x.origin === 'added' || x.origin === 'combined')) {
    if (template.stages.some((t) => t.id === s.id)) errors.push(`${s.id}: an ${s.origin} stage can't reuse a template stage id.`);
    if (s.origin === 'added' && !s.reason) errors.push(`${s.id}: an added stage needs a reason.`);
    warnings.push(`${s.origin === 'added' ? 'Added' : `Taken from ${s.fromTemplate ?? '?'}:`} stage ${s.id} (${s.kind}): ${s.reason ?? 'no reason given'}.`);
  }
  if (w.template.id === COMPOSED) warnings.push('A composed workflow: no template fits, so the planner chose every stage, each with a reason.');
  checkComposition(w, opts.templates ?? [], errors);
  checkStructure(w.stages, errors, (s) => (s as WorkflowStage).included);
  return { errors, warnings };
}

export interface WorkflowDiff {
  added: Array<{ id: string; kind: string; reason?: string }>;
  dropped: Array<{ id: string; inclusion: string; reason?: string }>;
  included: Array<{ id: string; inclusion: string; reason?: string }>;
  reassigned: Array<{ id: string; role: string; tier?: string }>;
}

/** What the approver reads: the workflow against its template. */
export function diffWorkflow(w: WorkflowInstance, template: WorkflowTemplate): WorkflowDiff {
  const byId = new Map(w.stages.map((s) => [s.id, s]));
  const diff: WorkflowDiff = { added: [], dropped: [], included: [], reassigned: [] };
  for (const s of w.stages) if (s.origin === 'added' || s.origin === 'combined') diff.added.push({ id: s.id, kind: s.kind, reason: s.origin === 'combined' ? `from ${s.fromTemplate ?? '?'}: ${s.reason ?? ''}` : s.reason });
  for (const t of template.stages) {
    const s = byId.get(t.id);
    const defaultOn = t.inclusion === 'mandatory' || t.inclusion === 'default';
    if (defaultOn && (!s || !s.included)) diff.dropped.push({ id: t.id, inclusion: t.inclusion, reason: s?.reason });
    if (t.inclusion === 'conditional' && s && !s.included) diff.dropped.push({ id: t.id, inclusion: t.inclusion, reason: s.reason });
    if ((t.inclusion === 'optional' || t.inclusion === 'conditional') && s?.included) diff.included.push({ id: t.id, inclusion: t.inclusion, reason: s.reason });
    if (s?.agent && s.agent.role !== STAGE_KINDS[t.kind].roles[0]) diff.reassigned.push({ id: t.id, role: s.agent.role, tier: s.agent.tier });
  }
  return diff;
}
