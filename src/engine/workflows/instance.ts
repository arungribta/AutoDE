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
}

export interface WorkflowStage {
  id: string;
  title: string;
  kind: StageKind;
  origin: 'template' | 'added';
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
    agent: { role: kind.roles[0], tier: kind.ceiling },
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

/** The rules every workflow must follow (§9.2 PA3 §2), item by item. */
export function checkWorkflow(w: WorkflowInstance, template: WorkflowTemplate): PlanCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
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
  for (const s of w.stages.filter((x) => x.origin === 'added')) {
    if (template.stages.some((t) => t.id === s.id)) errors.push(`${s.id}: an added stage can't reuse a template stage id.`);
    if (!s.reason) errors.push(`${s.id}: an added stage needs a reason.`);
    warnings.push(`Added stage ${s.id} (${s.kind}): ${s.reason ?? 'no reason given'}.`);
  }
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
  for (const s of w.stages) if (s.origin === 'added') diff.added.push({ id: s.id, kind: s.kind, reason: s.reason });
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
