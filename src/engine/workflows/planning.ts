import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml, stringifyYaml } from '../context/Yaml';
import { AssertionLedger } from '../context/ledger';
import { Evidence } from '../context/assertions';
import { parseBusinessProblemSpec, readProblemDocument } from '../documents/problemDocuments';
import { layoutPath } from '../workspaceLayout';
import { readWorkflow } from './instance';
import { Actor, appendEvent } from './events';

/**
 * PLN1b (docs/specs/workflow-planning.md §3.4, §3.6): the planner's clarification round and re-planning.
 *
 * - **The clarification round** is the interview's second round: only questions that block coverage, each
 *   naming the items it blocks and the planner's assumption for "assume and flag", at most seven per round.
 *   An answer clarifies (a fact on the items), accepts the assumption (a flagged assumption the items rest on),
 *   or changes scope (the coverage waits for a specification revision). A later round only follows an answered
 *   question that raised it.
 * - **Re-planning:** a stage reports what changes coverage (a source the specification didn't name, an item it
 *   can't deliver, a late answer); the planner proposes a revised coverage and workflow, approved like the first.
 *
 * Kept in `planning.yaml` beside the workflow. Deterministic: the planner and the person write through these
 * functions, and the coverage checks read them.
 */

export type PlanningOutcome = 'clarifies' | 'assumed' | 'scope-change';

export interface PlanningAnswer {
  value: string;
  outcome: PlanningOutcome;
  by: string;
  channel: string;
  at: string;
  /** The specification version it was given against: a scope change waits for a newer one. */
  specVersion: number;
  /** The fact it was recorded as (a decision, or an assumption). */
  factId?: string;
}

export interface PlanningQuestion {
  id: string;
  prompt: string;
  /** The coverage items it blocks. */
  items: string[];
  /** The planner's assumption, offered as "assume and flag". */
  assumption: string;
  kind?: 'text' | 'single-select' | 'multi-select' | 'boolean';
  options?: string[];
  /** In a later round: the answered question that raised it. */
  after?: string;
  answer?: PlanningAnswer;
}

export interface PlanningRound {
  n: number;
  openedAt: string;
  openedBy: string;
  specVersion: number;
  questions: PlanningQuestion[];
}

export type ReportKind = 'new-source' | 'cannot-deliver' | 'late-answer' | 'other';
export const REPORT_KINDS: readonly ReportKind[] = ['new-source', 'cannot-deliver', 'late-answer', 'other'];

export interface CoverageReport {
  id: string;
  stage: string;
  kind: ReportKind;
  items: string[];
  detail: string;
  by: string;
  channel: string;
  at: string;
  status: 'open' | 'resolved' | 'dismissed';
  resolution?: { by: string; at: string; decisionId?: string; reason?: string };
}

export interface PlanningFile { rounds: PlanningRound[]; reports: CoverageReport[] }

/** The most questions one round asks (§3.4: bounded, most important first). */
export const MAX_QUESTIONS = 7;
/** The most rounds a plan takes before the person places what is left. */
export const MAX_ROUNDS = 3;

export function planningFile(problemRoot: string): string {
  return path.join(problemRoot, 'planning.yaml');
}

export function readPlanning(problemRoot: string): PlanningFile {
  try {
    const raw = parseYaml(fs.readFileSync(planningFile(problemRoot), 'utf8')) as Partial<PlanningFile> | undefined;
    return { rounds: Array.isArray(raw?.rounds) ? raw!.rounds : [], reports: Array.isArray(raw?.reports) ? raw!.reports : [] };
  } catch { return { rounds: [], reports: [] }; }
}

function writePlanning(problemRoot: string, p: PlanningFile): void {
  fs.mkdirSync(problemRoot, { recursive: true });
  const file = planningFile(problemRoot);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `# AutoDE planning (PLN1b): the clarification rounds and the stages' reports. Changed through the workflow commands.\n${stringifyYaml(p)}`);
  fs.renameSync(tmp, file);
}

export const openQuestions = (p: PlanningFile): PlanningQuestion[] => p.rounds.flatMap((r) => r.questions).filter((q) => !q.answer);
export const openReports = (p: PlanningFile): CoverageReport[] => p.reports.filter((r) => r.status === 'open');

/** What the coverage checks read: items an open question blocks, scope changes awaiting a revision, items resting on an assumption. */
export function planningState(p: PlanningFile, specVersion: number | undefined): { blocked: Map<string, string>; scopeChanges: PlanningQuestion[]; assumed: Map<string, string[]> } {
  const blocked = new Map<string, string>();
  const assumed = new Map<string, string[]>();
  for (const q of p.rounds.flatMap((r) => r.questions)) {
    for (const item of q.items) {
      if (!q.answer && !blocked.has(item)) blocked.set(item, q.id);
      if (q.answer?.outcome === 'assumed') assumed.set(item, [...(assumed.get(item) ?? []), q.assumption]);
    }
  }
  const scopeChanges = p.rounds.flatMap((r) => r.questions).filter((q) => q.answer?.outcome === 'scope-change' && specVersion !== undefined && q.answer.specVersion >= specVersion);
  return { blocked, scopeChanges, assumed };
}

function specVersionOf(problemRoot: string): number {
  try { return parseBusinessProblemSpec(readProblemDocument(problemRoot, 'spec') ?? '').version ?? 1; } catch { return 1; }
}

export interface QuestionInput { prompt: string; items: string[]; assumption: string; kind?: PlanningQuestion['kind']; options?: string[]; after?: string }

/**
 * The planner opens a clarification round. Refused, question by question, when: a question has no prompt, no
 * item, an item that isn't in the coverage, or no assumption to offer; there are more than seven; the previous
 * round has unanswered questions; a later round's question doesn't name the answered question that raised it.
 */
export function openRound(problemRoot: string, input: { questions: readonly QuestionInput[]; knownItems: readonly string[]; by: Actor; channel: string }, now = new Date().toISOString()): PlanningRound {
  const p = readPlanning(problemRoot);
  const errors: string[] = [];
  const prev = p.rounds[p.rounds.length - 1];
  if (prev && prev.questions.some((q) => !q.answer)) errors.push(`Round ${prev.n} still has open questions (${prev.questions.filter((q) => !q.answer).map((q) => q.id).join(', ')}): they are answered first.`);
  if (p.rounds.length >= MAX_ROUNDS) errors.push(`${MAX_ROUNDS} rounds were asked already: a person places what is left.`);
  if (!input.questions.length) errors.push('A round asks at least one question.');
  if (input.questions.length > MAX_QUESTIONS) errors.push(`At most ${MAX_QUESTIONS} questions a round, most important first (${input.questions.length} given).`);
  const answered = new Set(prev ? prev.questions.map((q) => q.id) : []);
  const n = p.rounds.length + 1;
  const known = new Set(input.knownItems);
  input.questions.forEach((q, i) => {
    const where = `question ${i + 1}`;
    if (!q.prompt?.trim()) errors.push(`${where}: the question is empty.`);
    if (!q.items?.length) errors.push(`${where}: name the coverage items it blocks.`);
    for (const item of q.items ?? []) if (!known.has(item)) errors.push(`${where}: ${item} isn't a coverage item (autode_coverage lists them).`);
    if (!q.assumption?.trim()) errors.push(`${where}: give the assumption you would make, offered to the person as "assume and flag".`);
    if ((q.kind === 'single-select' || q.kind === 'multi-select') && !q.options?.length) errors.push(`${where}: a ${q.kind} question lists its options.`);
    if (n > 1 && (!q.after || !answered.has(q.after))) errors.push(`${where}: a later round only asks what an answer raised: name the answered question in "after" (${[...answered].join(', ') || 'none'}).`);
  });
  if (errors.length) throw new Error(errors.join(' '));
  const round: PlanningRound = {
    n, openedAt: now, openedBy: input.by.kind === 'engine' ? 'engine' : input.by.name, specVersion: specVersionOf(problemRoot),
    questions: input.questions.map((q, i) => ({ id: `r${n}q${i + 1}`, prompt: q.prompt.trim(), items: [...new Set(q.items)], assumption: q.assumption.trim(), ...(q.kind ? { kind: q.kind } : {}), ...(q.options?.length ? { options: q.options } : {}), ...(q.after ? { after: q.after } : {}) }))
  };
  writePlanning(problemRoot, { ...p, rounds: [...p.rounds, round] });
  appendEvent(problemRoot, { at: now, type: 'planning-round', stage: 'plan', actor: input.by, channel: input.channel, reason: `clarification round ${n}: ${round.questions.length} question(s)` });
  return round;
}

/**
 * A person's answer (recorded by them, or by the agent they told): a clarification becomes a confirmed decision
 * fact on the items; "assume" accepts the planner's assumption as a flagged assumption the items rest on; a scope
 * change makes the coverage wait for a specification revision. An answer after the coverage was approved is
 * also reported for re-planning (§3.6).
 */
export async function answerQuestion(workspaceRoot: string, problemRoot: string, input: { question: string; value?: string; outcome: PlanningOutcome; by: Actor; channel: string; coverageApproved?: boolean }, now = new Date().toISOString()): Promise<{ question: PlanningQuestion; report?: CoverageReport }> {
  const p = readPlanning(problemRoot);
  const q = p.rounds.flatMap((r) => r.questions).find((x) => x.id === input.question);
  if (!q) throw new Error(`No planning question ${input.question} (${p.rounds.flatMap((r) => r.questions).map((x) => x.id).join(', ') || 'none asked'}).`);
  if (q.answer) throw new Error(`${q.id} was answered already (${q.answer.outcome}, by ${q.answer.by}).`);
  if (input.by.kind !== 'person') throw new Error('A planning question is answered by a person (an agent records what the person said, as them).');
  const value = (input.outcome === 'assumed' ? q.assumption : input.value ?? '').trim();
  if (!value) throw new Error(`Give the answer to ${q.id}, or accept its assumption.`);
  const by = input.by.name;
  const ledger = new AssertionLedger(layoutPath(workspaceRoot, 'ledger'));
  await ledger.load();
  const subject = q.items.map((i) => `coverage:${i}`);
  const evidence: Evidence[] = [{ type: 'interview_answer', ref: `planning:${q.id}`, excerpt: q.prompt.slice(0, 300) }];
  const fact = input.outcome === 'scope-change' ? undefined : await ledger.assert(input.outcome === 'assumed'
    ? { kind: 'assumption', subject, predicate: 'assumption', value: { text: value }, statement: `Assumed for planning: ${value}`, evidence, trust: 'confirmed', status: 'active', createdBy: `user:${by}`, flags: ['assumption', 'planning'] }
    : { kind: 'decision', subject, predicate: 'clarifies', value: { text: value, question: q.prompt }, statement: `${q.prompt} ${value}`, evidence, trust: 'confirmed', status: 'active', createdBy: `user:${by}` });
  q.answer = { value, outcome: input.outcome, by, channel: input.channel, at: now, specVersion: specVersionOf(problemRoot), ...(fact ? { factId: fact.id } : {}) };
  let report: CoverageReport | undefined;
  if (input.coverageApproved) {
    report = { id: `rep-${p.reports.length + 1}`, stage: 'plan', kind: 'late-answer', items: q.items, detail: `${q.id} answered after the coverage was approved: ${value}`, by, channel: input.channel, at: now, status: 'open' };
    p.reports.push(report);
  }
  writePlanning(problemRoot, p);
  appendEvent(problemRoot, { at: now, type: 'planning-answer', stage: 'plan', actor: input.by, channel: input.channel, reason: `${q.id} ${input.outcome}: ${value}` });
  return { question: q, report };
}

/** A stage reports what changes coverage (§3.6): the planner re-plans, a person approves the revision. */
export function reportChange(problemRoot: string, input: { stage: string; kind: ReportKind; items?: string[]; detail: string; knownItems: readonly string[]; by: Actor; channel: string }, now = new Date().toISOString()): CoverageReport {
  const w = readWorkflow(problemRoot);
  const errors: string[] = [];
  if (!w?.stages.some((s) => s.id === input.stage && s.included)) errors.push(`No stage ${input.stage} in the workflow.`);
  if (!REPORT_KINDS.includes(input.kind)) errors.push(`The kind is ${REPORT_KINDS.join(', ')}.`);
  if (!input.detail?.trim()) errors.push('Say what was found.');
  for (const i of input.items ?? []) if (!input.knownItems.includes(i)) errors.push(`${i} isn't a coverage item.`);
  if (input.kind === 'cannot-deliver' && !input.items?.length) errors.push('Name the items the stage can\'t deliver.');
  if (errors.length) throw new Error(errors.join(' '));
  const p = readPlanning(problemRoot);
  const report: CoverageReport = { id: `rep-${p.reports.length + 1}`, stage: input.stage, kind: input.kind, items: input.items ?? [], detail: input.detail.trim(), by: input.by.kind === 'engine' ? 'engine' : input.by.name, channel: input.channel, at: now, status: 'open' };
  writePlanning(problemRoot, { ...p, reports: [...p.reports, report] });
  appendEvent(problemRoot, { at: now, type: 'coverage-report', stage: input.stage, actor: input.by, channel: input.channel, reason: `${input.kind}: ${report.detail}` });
  return report;
}

/** A person dismisses a report that changes nothing, with the reason. */
export function dismissReport(problemRoot: string, id: string, reason: string, by: string, now = new Date().toISOString()): CoverageReport {
  const p = readPlanning(problemRoot);
  const r = p.reports.find((x) => x.id === id);
  if (!r) throw new Error(`No report ${id}.`);
  if (r.status !== 'open') throw new Error(`${id} is ${r.status}.`);
  if (!reason.trim()) throw new Error('Say why the plan doesn\'t change.');
  r.status = 'dismissed';
  r.resolution = { by, at: now, reason: reason.trim() };
  writePlanning(problemRoot, p);
  return r;
}

/** The revised workflow approved: the reports open before it was proposed are resolved by it. */
export function resolveReports(problemRoot: string, decisionId: string, by: string, proposedAt: string, now = new Date().toISOString()): number {
  const p = readPlanning(problemRoot);
  const open = p.reports.filter((r) => r.status === 'open' && r.at <= proposedAt);
  for (const r of open) { r.status = 'resolved'; r.resolution = { by, at: now, decisionId }; }
  if (open.length) writePlanning(problemRoot, p);
  return open.length;
}
