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

export interface CoverageItem {
  /** Stable for the item's text: `scope:<slug>` or `objective:<slug>`. */
  id: string;
  text: string;
  /** Where it comes from in the specification. */
  source: 'scope.in' | 'objectives';
}

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
}

export interface CoverageCheck {
  ok: boolean;
  /** Each problem, naming the item or stage. */
  errors: string[];
  /** Stages that deliver no item and aren't mandatory, and the like: shown, not blocking. */
  warnings: string[];
  counts: Record<CoverageStatus, number>;
}

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item';

/** The specification's in-scope items and objectives. */
export function coverageItems(spec: Pick<BusinessProblemSpec, 'scope' | 'objectives'>): CoverageItem[] {
  const out: CoverageItem[] = [];
  const seen = new Set<string>();
  const add = (text: string, source: CoverageItem['source']) => {
    const t = String(text ?? '').trim();
    if (!t) return;
    const id = `${source === 'scope.in' ? 'scope' : 'objective'}:${slug(t)}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, text: t, source });
  };
  for (const t of spec.scope?.in ?? []) add(t, 'scope.in');
  for (const t of spec.objectives ?? []) add(t, 'objectives');
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

/** The engine's starting coverage for the workflow: what it can place by rule, the rest as questions. */
export function startingCoverage(items: readonly CoverageItem[], w: Pick<WorkflowInstance, 'stages'>): CoverageEntry[] {
  const included = w.stages.filter((s) => s.included);
  const ofKind = (kind: StageKind) => included.filter((s) => s.kind === kind).map((s) => s.id);
  return items.map((item) => {
    const named = KIND_WORDS.find((k) => k.words.test(item.text));
    if (named) {
      const stages = ofKind(named.kind);
      return stages.length
        ? { ...item, status: 'covered' as const, stages, placedBy: `engine: "${item.text}" names ${named.kind} work` }
        : { ...item, status: 'question' as const, reason: `It names ${named.kind} work, and the workflow has no ${named.kind} stage: add one, say who does it outside AutoDE, or mark it out of scope.`, placedBy: 'engine' };
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
export function effectiveCoverage(spec: Pick<BusinessProblemSpec, 'scope' | 'objectives' | 'id' | 'version'>, w: Pick<WorkflowInstance, 'stages'>, saved?: Coverage): Coverage {
  const items = coverageItems(spec);
  const placed = new Map((saved?.entries ?? []).filter((e) => !e.placedBy.startsWith('engine')).map((e) => [e.id, e]));
  const entries = startingCoverage(items, w).map((e) => placed.get(e.id) ?? e);
  return { specId: spec.id, specVersion: spec.version, entries, ...(saved?.approvedBy && saved.specVersion === spec.version ? { approvedBy: saved.approvedBy, approvedAt: saved.approvedAt } : {}) };
}

/** The deterministic checks (§3.1). */
export function checkCoverage(c: Coverage, spec: Pick<BusinessProblemSpec, 'scope' | 'objectives'>, w: Pick<WorkflowInstance, 'stages'>): CoverageCheck {
  const errors: string[] = []; const warnings: string[] = [];
  const items = new Map(coverageItems(spec).map((i) => [i.id, i]));
  const seen = new Map<string, number>();
  const stages = new Map(w.stages.map((s) => [s.id, s]));
  for (const e of c.entries) {
    seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
    if (!items.has(e.id)) errors.push(`"${e.text}" isn't in the specification's scope or objectives.`);
    if (e.status === 'covered' || e.status === 'manual') {
      if (!e.stages?.length) errors.push(`"${e.text}" is ${e.status} but names no stage.`);
      for (const id of e.stages ?? []) {
        const s = stages.get(id);
        if (!s || !s.included) errors.push(`"${e.text}" names stage ${id}, which isn't in the workflow.`);
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
  return { ok: errors.length === 0, errors, warnings, counts };
}

/**
 * A person places an item (from the plan step, `autode coverage place`, or `autode_place_coverage`). Placing
 * changes the coverage, so an earlier approval of it no longer holds.
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

/** Records the coverage as approved with the workflow (PLN0: one action; PLN1 brings its own decision). */
export function approveCoverage(problemRoot: string, c: Coverage, by: string, at = new Date().toISOString()): void {
  writeCoverage(problemRoot, { ...c, approvedBy: by, approvedAt: at });
}

/**
 * A problem's coverage as every surface shows it: against the approved workflow, else the one waiting for
 * approval, else the current draft. Undefined when there is no specification or workflow yet.
 */
export function specCoverage(workspaceRoot: string, problemId: string): { coverage: Coverage; check: CoverageCheck; against: 'approved' | 'proposed' | 'draft'; problemRoot: string; stages: Array<{ id: string; title: string; kind: string }> } | undefined {
  const problemRoot = layoutPath(workspaceRoot, 'problems', problemId);
  let spec: BusinessProblemSpec;
  try { spec = parseBusinessProblemSpec(readProblemDocument(problemRoot, 'spec') ?? ''); } catch { return undefined; }
  const current = readWorkflow(problemRoot);
  const pending = new DecisionStore(workspaceRoot).list({ status: 'pending', kind: 'workflow' }).find((d) => d.problemId === problemId);
  const w = current?.status === 'approved' ? current : pending ? new DecisionStore(workspaceRoot).proposal<WorkflowInstance>(pending.id) : current;
  if (!w) return undefined;
  const coverage = effectiveCoverage(spec, w, readCoverage(problemRoot));
  return { coverage, check: checkCoverage(coverage, spec, w), against: current?.status === 'approved' ? 'approved' : pending ? 'proposed' : 'draft', problemRoot, stages: w.stages.filter((s) => s.included).map((s) => ({ id: s.id, title: s.title, kind: s.kind })) };
}
