import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml } from '../context/Yaml';
import { layoutPath } from '../workspaceLayout';
import { ARTIFACTS, Artifact, EXTERNAL_ARTIFACTS, Gate, STAGE_KINDS, StageKind } from './stageKinds';

/**
 * Workflow templates (PA3a; docs/specs/workflow-templates.md): stage catalogues per
 * category of engagement. Bundled in `workflows/*.yaml`; a workspace overrides
 * or adds templates by id in `.autode/config/workflows/`. The language is
 * deliberately small: inclusion, `when`, `after` (optionally "(approved)"),
 * consumes / produces, `repeat: per-source-system`, `join`. No loops.
 */

export type Inclusion = 'mandatory' | 'default' | 'conditional' | 'optional';
export const INCLUSIONS: readonly Inclusion[] = ['mandatory', 'default', 'conditional', 'optional'];

export interface Dependency { stage: string; approved: boolean }

export interface TemplateStage {
  id: string;
  title: string;
  kind: StageKind;
  inclusion: Inclusion;
  when?: string;
  after: Dependency[];
  consumes: Artifact[];
  produces: Artifact[];
  gates: Gate[];
  repeat?: 'per-source-system';
  join?: 'all' | 'any';
  note?: string;
}

export interface WorkflowTemplate {
  id: string;
  version: number;
  title: string;
  description: string;
  suggestWhen: string[];
  stages: TemplateStage[];
  /** Where it was loaded from: `bundled` or the workspace file. */
  origin: string;
}

/** Facts a `when:` condition may name. */
export interface ConditionFacts {
  'estate.sources': number;
  'estate.systems': number;
  'pack.has_contract': boolean;
  'estate.has_legacy_code': boolean;
}
export const CONDITION_FACTS: readonly (keyof ConditionFacts)[] = ['estate.sources', 'estate.systems', 'pack.has_contract', 'estate.has_legacy_code'];

const CONDITION = /^\s*(not\s+)?([a-z_.]+)\s*(?:(>=|<=|==|!=|>|<)\s*(\d+))?\s*$/;

/** `fact`, `not fact`, or `fact <op> <number>`. Returns an error for anything else. */
export function parseCondition(text: string): { ok: true; test: (f: ConditionFacts) => boolean } | { ok: false; error: string } {
  const m = CONDITION.exec(text);
  if (!m) return { ok: false, error: `"${text}" is not a condition (write a fact, "not <fact>", or "<fact> <op> <number>").` };
  const [, neg, fact, op, num] = m;
  if (!(CONDITION_FACTS as readonly string[]).includes(fact)) return { ok: false, error: `Unknown fact "${fact}" (known: ${CONDITION_FACTS.join(', ')}).` };
  return {
    ok: true,
    test: (f) => {
      const v = f[fact as keyof ConditionFacts];
      let r: boolean;
      if (!op) r = typeof v === 'number' ? v > 0 : v === true;
      else {
        const n = Number(num); const x = typeof v === 'number' ? v : v ? 1 : 0;
        r = op === '>' ? x > n : op === '>=' ? x >= n : op === '<' ? x < n : op === '<=' ? x <= n : op === '==' ? x === n : x !== n;
      }
      return neg ? !r : r;
    }
  };
}

/** `"mapping"` or `"mapping (approved)"`. */
export function parseDependency(text: string): Dependency {
  const m = /^\s*([A-Za-z0-9_.-]+)\s*(\(\s*approved\s*\))?\s*$/.exec(text);
  return m ? { stage: m[1], approved: !!m[2] } : { stage: text.trim(), approved: false };
}

/** Finds a cycle among `after` dependencies; returns the stage ids on it, or undefined. */
export function findCycle(stages: ReadonlyArray<{ id: string; after: Dependency[] }>): string[] | undefined {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting'); stack.push(id);
    for (const d of byId.get(id)?.after ?? []) { if (byId.has(d.stage)) { const c = visit(d.stage); if (c) return c; } }
    stack.pop(); state.set(id, 'done');
    return undefined;
  };
  for (const s of stages) { const c = visit(s.id); if (c) return c; }
  return undefined;
}

/** Parses and validates a template; `errors` lists every problem, item by item. */
export function parseTemplate(raw: unknown, origin: string): { template?: WorkflowTemplate; errors: string[] } {
  const errors: string[] = [];
  const doc = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const id = str(doc.id);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) errors.push('id must be lowercase letters, digits and dashes.');
  const version = typeof doc.version === 'number' && Number.isInteger(doc.version) && doc.version > 0 ? doc.version : (errors.push('version must be a positive integer.'), 1);
  if (!Array.isArray(doc.stages) || doc.stages.length === 0) { errors.push('stages must list at least one stage.'); return { errors }; }
  const stages: TemplateStage[] = [];
  const ids = new Set<string>();
  (doc.stages as unknown[]).forEach((rs, i) => {
    const s = (rs && typeof rs === 'object' ? rs : {}) as Record<string, unknown>;
    const where = `stages[${i}]${str(s.id) ? ` (${str(s.id)})` : ''}`;
    const sid = str(s.id);
    if (!/^[A-Za-z0-9_.-]+$/.test(sid)) errors.push(`${where}: id is required (letters, digits, . _ -).`);
    else if (ids.has(sid)) errors.push(`${where}: duplicate id.`);
    ids.add(sid);
    const kind = str(s.kind) as StageKind;
    const spec = STAGE_KINDS[kind];
    if (!spec) errors.push(`${where}: unknown kind "${kind}" (known: ${Object.keys(STAGE_KINDS).join(', ')}).`);
    const inclusion = (str(s.inclusion) || 'default') as Inclusion;
    if (!INCLUSIONS.includes(inclusion)) errors.push(`${where}: inclusion must be ${INCLUSIONS.join(', ')}.`);
    const when = str(s.when) || undefined;
    if (inclusion === 'conditional' && !when) errors.push(`${where}: a conditional stage needs "when".`);
    if (when) { const c = parseCondition(when); if (!c.ok) errors.push(`${where}: ${c.error}`); }
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : v === undefined ? undefined : [String(v)]);
    const artifacts = (v: unknown, fallback: Artifact[], field: string): Artifact[] => {
      const l = list(v);
      if (!l) return fallback;
      for (const a of l) if (!(ARTIFACTS as readonly string[]).includes(a)) errors.push(`${where}: unknown artifact "${a}" in ${field}.`);
      return l as Artifact[];
    };
    const gates = (list(s.gates) ?? spec?.gates ?? []) as Gate[];
    for (const g of gates) if (g !== 'check' && g !== 'approve') errors.push(`${where}: gates are check and approve.`);
    const repeat = s.repeat === undefined ? undefined : str(s.repeat);
    if (repeat !== undefined && repeat !== 'per-source-system') errors.push(`${where}: repeat can only be per-source-system.`);
    const join = s.join === undefined ? undefined : str(s.join);
    if (join !== undefined && join !== 'all' && join !== 'any') errors.push(`${where}: join is all or any.`);
    stages.push({
      id: sid, title: str(s.title) || sid, kind, inclusion, when,
      after: (list(s.after) ?? []).map(parseDependency),
      consumes: artifacts(s.consumes, spec?.consumes ?? [], 'consumes'),
      produces: artifacts(s.produces, spec?.produces ?? [], 'produces'),
      gates, repeat: repeat as TemplateStage['repeat'], join: join as TemplateStage['join'], note: str(s.note) || undefined
    });
  });
  // In a template every consumed artifact needs a producer somewhere in the catalogue; an instance must also include it.
  checkStructure(stages, errors);
  if (errors.length) return { errors };
  return { template: { id, version, title: str(doc.title) || id, description: str(doc.description), suggestWhen: Array.isArray(doc.suggestWhen) ? doc.suggestWhen.map(String) : [], stages, origin }, errors };
}

/**
 * The structural rules shared by templates and workflow instances: specify then
 * plan come first and are mandatory; dependencies name known stages and are
 * acyclic; what a stage consumes has a producer among the stages that will run
 * (`included`), or comes from outside.
 */
export function checkStructure(stages: ReadonlyArray<Pick<TemplateStage, 'id' | 'kind' | 'after' | 'consumes' | 'produces'> & { inclusion?: Inclusion }>, errors: string[], included: (s: (typeof stages)[number]) => boolean = () => true): void {
  if (stages[0]?.kind !== 'specify') errors.push('The first stage must be of kind specify.');
  if (stages[1]?.kind !== 'plan') errors.push('The second stage must be of kind plan.');
  for (const s of stages.slice(0, 2)) if (s.inclusion !== undefined && s.inclusion !== 'mandatory') errors.push(`${s.id}: the ${s.kind} stage is mandatory.`);
  const ids = new Set(stages.map((s) => s.id));
  for (const s of stages) for (const d of s.after) if (!ids.has(d.stage)) errors.push(`${s.id}: depends on unknown stage "${d.stage}".`);
  const cycle = findCycle(stages);
  if (cycle) errors.push(`Dependency cycle: ${cycle.join(' → ')}.`);
  const produced = new Set<string>(stages.filter(included).flatMap((s) => s.produces));
  for (const s of stages.filter(included)) {
    for (const a of s.consumes) if (!produced.has(a) && !EXTERNAL_ARTIFACTS.includes(a)) errors.push(`${s.id}: consumes ${a}, which no stage in the workflow produces.`);
  }
}

/** Bundled templates (`<resources>/workflows`) overridden or extended by the workspace's (`.autode/config/workflows`), by id. */
export function loadTemplates(resourcesRoot: string, workspaceRoot?: string): { templates: WorkflowTemplate[]; errors: string[] } {
  const byId = new Map<string, WorkflowTemplate>();
  const errors: string[] = [];
  const dirs: Array<[string, string]> = [[path.join(resourcesRoot, 'workflows'), 'bundled']];
  if (workspaceRoot) dirs.push([layoutPath(workspaceRoot, 'workflows'), 'workspace']);
  for (const [dir, origin] of dirs) {
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort(); } catch { continue; }
    for (const f of files) {
      let raw: unknown;
      try { raw = parseYaml(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (err) { errors.push(`${origin} ${f}: not valid YAML (${err instanceof Error ? err.message : String(err)}).`); continue; }
      const r = parseTemplate(raw, origin === 'bundled' ? 'bundled' : path.join(dir, f));
      if (r.template) byId.set(r.template.id, r.template); else errors.push(...r.errors.map((e) => `${origin} ${f}: ${e}`));
    }
  }
  return { templates: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), errors };
}

/** Which template fits a specification best, by its `suggestWhen` keywords and the estate (a suggestion only). */
export function suggestTemplate(templates: readonly WorkflowTemplate[], specText: string, facts: Partial<ConditionFacts>): { id: string; reason: string } | undefined {
  const text = specText.toLowerCase();
  let best: { id: string; score: number; hits: string[] } | undefined;
  for (const t of templates) {
    const hits = t.suggestWhen.filter((w) => text.includes(w.toLowerCase()));
    let score = hits.length;
    if (t.id === 'estate-merge' && (facts['estate.sources'] ?? 0) > 1) score += 1;
    if (!best || score > best.score) best = { id: t.id, score, hits };
  }
  if (!best || best.score === 0) return templates.some((t) => t.id === 'greenfield') ? { id: 'greenfield', reason: 'no signal for a modernization or a merge in the specification' } : undefined;
  return { id: best.id, reason: best.hits.length ? `the specification mentions ${best.hits.map((h) => `"${h}"`).join(', ')}` : 'several source systems in the estate' };
}
