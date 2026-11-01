import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml, stringifyYaml } from '../context/Yaml';
import { BusinessProblemSpec } from '../types';
import { StageKind } from './stageKinds';
import { WorkflowInstance, readWorkflow } from './instance';
import { DecisionStore } from '../decisions/decisionStore';
import { parseBusinessProblemSpec, readProblemDocument } from '../documents/problemDocuments';
import { layoutPath } from '../workspaceLayout';

/**
 * Coverage of the approved specification by the workflow (PLN0;
 * docs/specs/workflow-planning.md §3.1, §4). Every in-scope item and objective
 * is delivered by named stages, done outside AutoDE, out of scope with a
 * reason, a gap no approved skill can serve, or an open question. Nothing
 * drops silently: the workflow can't be approved while a question is open.
 *
 * PLN0 has no planner: the engine proposes a starting coverage (an item that
 * names a kind of work goes to the workflow's stage of that kind; a plain data
 * subject to its main delivery stage), and a person places what it can't. What
 * the person placed is kept in `coverage.yaml` beside the workflow.
 */

export type CoverageStatus = 'covered' | 'manual' | 'out-of-scope' | 'gap' | 'question';

/** Where an item comes from in the specification. PLN1a adds the constraints, acceptance criteria and personal data a stage must act on. */
export type CoverageSource = 'scope.in' | 'objectives' | 'constraints' | 'acceptanceCriteria' | 'governance';

export interface CoverageItem {
  /** Stable for the item's text: `scope:<slug>`, `objective:<slug>`, `constraint:<slug>`, `acceptance:<slug>`, or `governance:personal-data`. */
  id: string;
  text: string;
  source: CoverageSource;
}

/** The parts of a specification coverage reads. */
export type CoverageSpec = Pick<BusinessProblemSpec, 'scope' | 'objectives'> & Partial<Pick<BusinessProblemSpec, 'constraints' | 'acceptanceCriteria' | 'governance'>>;

export interface CoverageEntry extends CoverageItem {
  status: CoverageStatus;
  stages?: string[];
  reason?: string;
  /** Who placed it: the engine's rule, or a person. */
  placedBy: string;
}

export interface Coverage {
  specId?: string;
  specVersion?: number;
  entries: CoverageEntry[];
  approvedBy?: string;
  approvedAt?: string;
  /** PLN1a: the `coverage` decision that approved it. */
  decisionId?: string;
}

export interface CoverageCheck {
  ok: boolean;
  /** Each problem, naming the item or stage. */
  errors: string[];
  /** Stages that deliver no item and aren't mandatory, and the like: shown, not blocking. */
  warnings: string[];
  counts: Record<CoverageStatus, number>;
  /** PLN1a: work AutoDE can't do yet (gaps, and items done by hand outside it): the team's list for new skills. */
  teamGaps: string[];
}

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';

const PREFIX: Record<CoverageSource, string> = { 'scope.in': 'scope', objectives: 'objective', constraints: 'constraint', acceptanceCriteria: 'acceptance', governance: 'governance' };

/** The specification's in-scope items and objectives, and (PLN1a) its constraints, acceptance criteria and personal-data handling. */
export function coverageItems(spec: CoverageSpec): CoverageItem[] {
  const out: CoverageItem[] = [];
  const seen = new Set<string>();
  const add = (text: string, source: CoverageSource, id = `${PREFIX[source]}:${slug(String(text ?? ''))}`) => {
    const t = String(text ?? '').trim();
    if (!t || seen.has(id)) return;
    seen.add(id);
    out.push({ id, text: t, source });
  };
  for (const t of spec.scope?.in ?? []) add(t, 'scope.in');
  for (const t of spec.objectives ?? []) add(t, 'objectives');
  for (const t of spec.constraints ?? []) add(t, 'constraints');
  for (const t of spec.acceptanceCriteria ?? []) add(t, 'acceptanceCriteria');
  const g = spec.governance;
  if (g && (g.personalData === 'present' || g.personalData === 'sensitive')) {
    add(`Personal data is protected${g.regulations?.length ? ` (${g.regulations.join(', ')})` : ''}`, 'governance', 'governance:personal-data');
  }
  return out;
}

/** Words that name a kind of work, and the stage kind that does it. */
const KIND_WORDS: Array<{ kind: StageKind; words: RegExp }> = [
  { kind: 'bi-migration', words: /\b(reports?|dashboards?|power ?bi|tableau|looker|bi)\b/i },
  { kind: 'quality-rules', words: /\b(data quality|quality rules?|quality checks?|validation rules?)\b/i },
  { kind: 'reconcile', words: /\breconcil/i },
  { kind: 'entity-resolution', words: /\b(golden record|master data|mdm|entity resolution|match(ing)? (customers|records))\b/i },
  { kind: 'code-conversion', words: /\b(stored procedures?|legacy code|convert(ing)? (code|sql|procedures))\b/i },
  { kind: 'platform-setup', words: /\b(access control|roles?|security|permissions?|environments?|provision)\b/i },
  { kind: 'deploy', words: /\b(deploy(ment)?|release|go[- ]live)\b/i },
  { kind: 'document', words: /\b(documentation|document the|data dictionary)\b/i },
  { kind: 'modelling', words: /\b(data model|star schema|dimensional|dimensions?|fact tables?|data vault)\b/i },
  { kind: 'mapping', words: /\b(source[- ]to[- ]target|mapping)\b/i }
];

/** Where a plain data subject ("orders", "customer data") is delivered: the first of these the workflow includes. */
const DELIVERY_KINDS: StageKind[] = ['build', 'modelling', 'mapping'];

/** PLN1a: personal data is protected where access is set up, else where the pipelines are built (masking, policies). */
const PERSONAL_DATA = /\b(pii|personal data|personally identifiable|mask(s|ed|ing)?|gdpr|hipaa|ccpa|sensitive data)\b/i;
const PROTECTION_KINDS: StageKind[] = ['platform-setup', 'build'];

/** PLN1a: words for work no AutoDE stage kind does (found by the planning eval: a handover went to the build stage). */
const OUTSIDE = /\b(machine learning|ml (model|features?)|data scien(ce|tists?)|predictive|forecast(ing)? model|stream(ing)? (service|platform|pipeline)|kafka|hand(ed)? (over|off|to)|handover|hand-off|sign[- ]off)\b/i;

/** The engine's starting coverage for the workflow: what it can place by rule, the rest as questions. */
export function startingCoverage(items: readonly CoverageItem[], w: Pick<WorkflowInstance, 'stages'>): CoverageEntry[] {
  const included = w.stages.filter((s) => s.included);
  const ofKind = (kind: StageKind) => included.filter((s) => s.kind === kind).map((s) => s.id);
  return items.map((item) => {
    if (item.source === 'governance' || ((item.source === 'constraints' || item.source === 'acceptanceCriteria') && PERSONAL_DATA.test(item.text))) {
      const where = PROTECTION_KINDS.map(ofKind).find((x) => x.length);
      return where
        ? { ...item, status: 'covered' as const, stages: where.slice(0, 1), placedBy: 'engine: personal data is protected where access is set up or the pipelines are built' }
        : { ...item, status: 'question' as const, reason: 'Personal data must be protected, and no stage sets up access or builds the pipelines: say which stage does it.', placedBy: 'engine' };
    }
    // A constraint is a judgement (a deadline names deployment but isn't a deliverable): the planner or a person places it.
    if (item.source === 'constraints') {
      return { ...item, status: 'question' as const, reason: 'A constraint: say which stage acts on it, or mark it out of scope when no stage needs to (a deadline, a budget).', placedBy: 'engine' };
    }
    // Work AutoDE may not do (ML, streaming, a handover or sign-off elsewhere) is never put on a stage by default.
    if (OUTSIDE.test(item.text)) {
      return { ...item, status: 'question' as const, reason: 'It may be work outside AutoDE (machine learning, streaming, a handover or sign-off): track it on a manual stage, mark it a gap, or say which stage delivers it.', placedBy: 'engine' };
    }
    const named = KIND_WORDS.find((k) => k.words.test(item.text));
    if (named) {
      const stages = ofKind(named.kind);
      return stages.length
        ? { ...item, status: 'covered' as const, stages, placedBy: `engine: "${item.text}" names ${named.kind} work` }
        : { ...item, status: 'question' as const, reason: `It names ${named.kind} work, and the workflow has no ${named.kind} stage: add one, say who does it outside AutoDE, or mark it out of scope.`, placedBy: 'engine' };
    }
    if (item.source === 'acceptanceCriteria') {
      // The validate stage traces the acceptance criteria (its kind's "done when").
      const v = ofKind('validate');
      return v.length
        ? { ...item, status: 'covered' as const, stages: v, placedBy: 'engine: acceptance criteria are traced by validation' }
        : { ...item, status: 'question' as const, reason: 'An acceptance criterion, and the workflow has no validate stage: add one, or say which stage proves it.', placedBy: 'engine' };
    }
    const delivery = DELIVERY_KINDS.map(ofKind).find((x) => x.length);
    return delivery
      ? { ...item, status: 'covered' as const, stages: delivery.slice(0, 1), placedBy: 'engine: a data subject, delivered by the main delivery stage' }
      : { ...item, status: 'question' as const, reason: 'The workflow has no stage that builds, models or maps data: say which stage delivers it.', placedBy: 'engine' };
  });
}

export function coverageFile(problemRoot: string): string {
  return path.join(problemRoot, 'coverage.yaml');
}

export function readCoverage(problemRoot: string): Coverage | undefined {
  try {
    const raw = parseYaml(fs.readFileSync(coverageFile(problemRoot), 'utf8')) as Coverage;
    return raw && Array.isArray(raw.entries) ? raw : undefined;
  } catch { return undefined; }
}

export function writeCoverage(problemRoot: string, c: Coverage): void {
  fs.mkdirSync(problemRoot, { recursive: true });
  const file = coverageFile(problemRoot);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, stringifyYaml(c));
  fs.renameSync(tmp, file);
}

/**
 * The coverage in effect: the engine's starting coverage for the specification's current items, with what a
 * person placed (kept by item id) over it. An item a person placed that is no longer in the specification drops out.
 */
export function effectiveCoverage(spec: CoverageSpec & Pick<BusinessProblemSpec, 'id' | 'version'>, w: Pick<WorkflowInstance, 'stages'>, saved?: Coverage): Coverage {
  const items = coverageItems(spec);
  const approved = !!saved?.approvedBy && saved.specVersion === spec.version;
  // An approved coverage keeps every entry the approver saw, the engine's too (PLN1a); otherwise the engine's are recomputed.
  const placed = new Map((saved?.entries ?? []).filter((e) => approved || !e.placedBy.startsWith('engine')).map((e) => [e.id, e]));
  const entries = startingCoverage(items, w).map((e) => placed.get(e.id) ?? e);
  return { specId: spec.id, specVersion: spec.version, entries, ...(approved ? { approvedBy: saved!.approvedBy, approvedAt: saved!.approvedAt, ...(saved!.decisionId ? { decisionId: saved!.decisionId } : {}) } : {}) };
}

/** The deterministic checks (§3.1). */
export function checkCoverage(c: Coverage, spec: CoverageSpec, w: Pick<WorkflowInstance, 'stages'>): CoverageCheck {
  const errors: string[] = []; const warnings: string[] = [];
  const items = new Map(coverageItems(spec).map((i) => [i.id, i]));
  const seen = new Map<string, number>();
  const stages = new Map(w.stages.map((s) => [s.id, s]));
  for (const e of c.entries) {
    seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
    if (!items.has(e.id)) errors.push(`"${e.text}" isn't in the specification (its scope, objectives, constraints or acceptance criteria).`);
    if (e.status === 'covered' || e.status === 'manual') {
      if (!e.stages?.length) errors.push(`"${e.text}" is ${e.status} but names no stage.`);
      for (const id of e.stages ?? []) {
        const s = stages.get(id);
        if (!s || !s.included) errors.push(`"${e.text}" names stage ${id}, which isn't in the workflow.`);
        // PLN1a: done by hand outside AutoDE means a manual stage tracks it, and a manual stage delivers nothing AutoDE does.
        else if (e.status === 'manual' && s.kind !== 'manual') errors.push(`"${e.text}" is manual, and ${id} is a ${s.kind} stage: a manual item is tracked by a manual stage.`);
        else if (e.status === 'covered' && s.kind === 'manual') errors.push(`"${e.text}" is covered by ${id}, a manual stage: mark it manual (done outside AutoDE).`);
      }
    }
    if ((e.status === 'gap' || e.status === 'out-of-scope') && !e.reason?.trim()) errors.push(`"${e.text}" is ${e.status} without a reason.`);
    if (e.status === 'question') errors.push(`"${e.text}" isn't placed yet: ${e.reason ?? 'say which stage delivers it, or mark it out of scope or a gap.'}`);
  }
  for (const [id, n] of seen) if (n > 1) errors.push(`"${items.get(id)?.text ?? id}" is listed ${n} times.`);
  for (const [id, i] of items) if (!seen.has(id)) errors.push(`"${i.text}" has no entry.`);
  const delivering = new Set(c.entries.flatMap((e) => e.stages ?? []));
  const support = new Set<StageKind>(['specify', 'plan', 'target-context', 'source-assessment', 'conformance', 'reconcile', 'validate', 'document', 'deploy']);
  for (const s of w.stages.filter((x) => x.included && x.inclusion !== 'mandatory' && !support.has(x.kind) && !delivering.has(x.id))) {
    warnings.push(`Stage ${s.id} (${s.title}) delivers no in-scope item.`);
  }
  const counts = { covered: 0, manual: 0, 'out-of-scope': 0, gap: 0, question: 0 } as Record<CoverageStatus, number>;
  for (const e of c.entries) counts[e.status]++;
  const teamGaps = [
    ...c.entries.filter((e) => e.status === 'gap').map((e) => `"${e.text}": ${e.reason ?? 'no approved skill delivers it'}`),
    ...c.entries.filter((e) => e.status === 'manual').map((e) => `"${e.text}": done outside AutoDE (${(e.stages ?? []).map((id) => { const s = stages.get(id); return s?.owner ? `${id}, ${s.owner}` : id; }).join('; ')})`)
  ];
  return { ok: errors.length === 0, errors, warnings, counts, teamGaps };
}

/**
 * A person or an agent places an item (from the plan step, `autode workflow coverage place`, or
 * `autode_place_coverage`). Placing changes the coverage, so an earlier approval of it no longer holds.
 */
export function placeCoverage(problemRoot: string, current: Coverage, itemId: string, placement: { status: Exclude<CoverageStatus, 'question'>; stages?: string[]; reason?: string }, by: string): Coverage {
  const e = current.entries.find((x) => x.id === itemId);
  if (!e) throw new Error(`No coverage item ${itemId}: ${current.entries.map((x) => x.id).join(', ')}.`);
  if ((placement.status === 'covered' || placement.status === 'manual') && !placement.stages?.length) throw new Error(`Name the stage(s) that ${placement.status === 'manual' ? 'track' : 'deliver'} "${e.text}".`);
  if ((placement.status === 'gap' || placement.status === 'out-of-scope') && !placement.reason?.trim()) throw new Error(`Say why "${e.text}" is ${placement.status}.`);
  const next: Coverage = {
    specId: current.specId, specVersion: current.specVersion,
    entries: current.entries.map((x) => (x.id === itemId ? { id: x.id, text: x.text, source: x.source, status: placement.status, ...(placement.stages?.length ? { stages: placement.stages } : {}), ...(placement.reason ? { reason: placement.reason.trim() } : {}), placedBy: by } : x))
  };
  writeCoverage(problemRoot, next);
  return next;
}

/** PLN1a: what a `coverage` decision proposes: the whole coverage, for one problem and specification version. */
export interface CoverageProposal extends Coverage { problemId: string }

/** The pending coverage proposal for a problem, if any (the newest replaces older ones). */
export function pendingCoverage(workspaceRoot: string, problemId: string): { id: string; coverage: CoverageProposal } | undefined {
  const store = new DecisionStore(workspaceRoot);
  const d = store.list({ status: 'pending', kind: 'coverage' }).find((x) => x.problemId === problemId);
  return d ? { id: d.id, coverage: store.proposal<CoverageProposal>(d.id) } : undefined;
}

/**
 * Places one item in a problem's coverage as every surface shows it. A pending coverage proposal is the
 * starting point and is withdrawn: the placement and the proposal's other entries become the coverage file,
 * which a person approves next.
 */
export function placeCoverageItem(workspaceRoot: string, problemId: string, itemId: string, placement: { status: Exclude<CoverageStatus, 'question'>; stages?: string[]; reason?: string }, by: string): { coverage: Coverage; check: CoverageCheck } {
  const c = specCoverage(workspaceRoot, problemId);
  if (!c) throw new Error('No coverage yet: it needs the specification and a workflow.');
  placeCoverage(c.problemRoot, c.coverage, itemId, placement, by);
  const pending = pendingCoverage(workspaceRoot, problemId);
  if (pending) new DecisionStore(workspaceRoot).withdraw(pending.id, 'autode', `replaced: ${by} placed ${itemId}`);
  const after = specCoverage(workspaceRoot, problemId)!;
  return { coverage: after.coverage, check: after.check };
}

/** Records an approved coverage (PLN1a: applying a `coverage` decision). */
export function approveCoverage(problemRoot: string, c: Coverage, by: string, at = new Date().toISOString(), decisionId?: string): void {
  writeCoverage(problemRoot, { specId: c.specId, specVersion: c.specVersion, entries: c.entries, approvedBy: by, approvedAt: at, ...(decisionId ? { decisionId } : {}) });
}

/** The workflow coverage is checked against: the one waiting for approval, else the problem's current one. */
export function plannedWorkflow(workspaceRoot: string, problemId: string): { workflow: WorkflowInstance; against: 'approved' | 'proposed' | 'draft' } | undefined {
  const current = readWorkflow(layoutPath(workspaceRoot, 'problems', problemId));
  const store = new DecisionStore(workspaceRoot);
  const pending = store.list({ status: 'pending', kind: 'workflow' }).find((d) => d.problemId === problemId);
  if (pending) return { workflow: store.proposal<WorkflowInstance>(pending.id), against: 'proposed' };
  return current ? { workflow: current, against: current.status === 'approved' ? 'approved' : 'draft' } : undefined;
}

/**
 * A problem's coverage as every surface shows it: against the workflow waiting for approval, else the
 * current one; the pending coverage proposal over the coverage file. Undefined with no specification or workflow.
 */
export function specCoverage(workspaceRoot: string, problemId: string): { coverage: Coverage; check: CoverageCheck; against: 'approved' | 'proposed' | 'draft'; problemRoot: string; stages: Array<{ id: string; title: string; kind: string }>; pendingDecision?: string } | undefined {
  const problemRoot = layoutPath(workspaceRoot, 'problems', problemId);
  let spec: BusinessProblemSpec;
  try { spec = parseBusinessProblemSpec(readProblemDocument(problemRoot, 'spec') ?? ''); } catch { return undefined; }
  const planned = plannedWorkflow(workspaceRoot, problemId);
  if (!planned) return undefined;
  const w = planned.workflow;
  const pending = pendingCoverage(workspaceRoot, problemId);
  const coverage = effectiveCoverage(spec, w, pending?.coverage ?? readCoverage(problemRoot));
  return { coverage, check: checkCoverage(coverage, spec, w), against: planned.against, problemRoot, stages: w.stages.filter((s) => s.included).map((s) => ({ id: s.id, title: s.title, kind: s.kind })), ...(pending ? { pendingDecision: pending.id } : {}) };
}
