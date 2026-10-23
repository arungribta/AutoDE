import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml, stringifyYaml } from '../context/Yaml';
import { AttachmentExtract, BusinessProblemSpec, IntakeAnswer, IntakeAttachment, IntakeSession, SkillDefinition, SpecIntakeQuestion } from '../types';
import { SpecOpsEngine, createIntakeSession } from './specOps';

/**
 * The requirements interview on disk (v0.45.12, mcp-engine §9.2 PA3 §7; BPS-7):
 * `.autode/problems/<id>/interview/state.yaml` holds the questions asked, each
 * answer with who gave it and through which surface, the coverage of the
 * specification's fields, the attachments and the specification it fed. Any
 * surface continues it: the panel after a reload, an MCP host, a terminal.
 * Answers are the user's own statements, so recording them needs no decision;
 * the specification they produce stays a proposal and a gate.
 */

export type InterviewChannel = NonNullable<IntakeAnswer['channel']>;

const MAX_ATTACHMENT_CHARS = 200_000;

export function interviewFile(problemRoot: string): string {
  return path.join(problemRoot, 'interview', 'state.yaml');
}

/** The problem's interview, if it has one. Attachment text is read again from the file it came from (bounded). */
export function readInterview(problemRoot: string, workspaceRoot?: string): IntakeSession | undefined {
  let raw: unknown;
  try { raw = parseYaml(fs.readFileSync(interviewFile(problemRoot), 'utf8')); } catch { return undefined; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const s = raw as IntakeSession;
  if (!Array.isArray(s.questions) || !Array.isArray(s.answers) || typeof s.problemStatement !== 'string') return undefined;
  s.insights = Array.isArray(s.insights) ? s.insights : [];
  s.coverage = s.coverage && typeof s.coverage === 'object' ? s.coverage : {};
  for (const a of s.attachments ?? []) {
    if (a.content) continue;
    try { a.content = fs.readFileSync(path.resolve(workspaceRoot ?? '.', a.path), 'utf8').slice(0, MAX_ATTACHMENT_CHARS); } catch { a.content = ''; }
  }
  return s;
}

/** Writes the interview; attachment text stays in its file. */
export function writeInterview(problemRoot: string, session: IntakeSession): void {
  const file = interviewFile(problemRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stored = { ...session, attachments: session.attachments?.map(({ content: _content, ...rest }) => rest) };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, '# AutoDE requirements interview: any surface continues it (panel, MCP, `autode interview`).\n' + stringifyYaml(stored as unknown as Record<string, unknown>));
  fs.renameSync(tmp, file);
}

/** Still being asked: not yet turned into a specification (one caught mid-synthesis, by a reload say, is resumed too). */
export function isOpenInterview(s: IntakeSession | undefined): boolean {
  return !!s && !s.feeds && (s.state === 'discovery' || s.state === 'synthesizing');
}

/**
 * What the attachments contributed, for later stages (Pipeline Spec synthesis): the extracts kept in the
 * interview, and those of attachments saved before v0.45.12 (`<problem>/attachments/*.yaml`).
 */
export function attachmentExtracts(problemRoot: string): AttachmentExtract[] {
  const out: AttachmentExtract[] = [];
  for (const a of readInterview(problemRoot)?.attachments ?? []) if (a.extract) out.push(a.extract);
  const legacy = path.join(problemRoot, 'attachments');
  let files: string[] = [];
  try { files = fs.readdirSync(legacy).filter((f) => f.endsWith('.yaml')); } catch { /* none */ }
  for (const f of files) {
    try {
      const a = parseYaml(fs.readFileSync(path.join(legacy, f), 'utf8')) as IntakeAttachment | null;
      if (a?.extract && !out.some((e) => e.attachmentId === a.extract!.attachmentId)) out.push(a.extract);
    } catch { /* an unreadable file doesn't block the rest */ }
  }
  return out;
}

export function openQuestions(s: IntakeSession): SpecIntakeQuestion[] {
  const answered = new Set(s.answers.map((a) => a.questionId));
  return s.questions.filter((q) => !answered.has(q.id));
}

/** Starts the problem's interview (or returns the open one). */
export function startInterview(problemRoot: string, statement: string, skills: readonly SkillDefinition[], opts: { previousSpec?: BusinessProblemSpec; now?: string } = {}): IntakeSession {
  const existing = readInterview(problemRoot);
  if (existing && isOpenInterview(existing)) return existing;
  const fields = [...new Set(skills.flatMap((k) => k.specFields))];
  const session = createIntakeSession(statement, { fields, previousSpec: opts.previousSpec, now: opts.now });
  writeInterview(problemRoot, session);
  return session;
}

export interface QuestionInput { field: string; prompt: string; kind?: string; options?: string[]; rationale?: string; skill?: string }
export interface AnswerInput { questionId?: string; field?: string; prompt?: string; value: string }

/**
 * Records questions asked and answers given by any surface, checked: a question's field must be one
 * the interview covers, an answer must name its question or a field. An answer with only a field
 * answers that field's latest open question, else it is recorded with the question it answers.
 */
export function recordInterview(session: IntakeSession, input: { questions?: QuestionInput[]; answers?: AnswerInput[] }, who: { by: string; channel: InterviewChannel }, now = new Date().toISOString()): { session: IntakeSession; asked: string[]; answered: string[]; errors: string[] } {
  const engine = new SpecOpsEngine(session);
  const errors: string[] = [];
  const known = new Set(Object.keys(session.coverage));
  const fieldOk = (f: string) => known.size === 0 || known.has(f);
  const asked: string[] = [];
  const toAsk: Array<Omit<SpecIntakeQuestion, 'id' | 'askedAt'>> = [];
  for (const [i, q] of (input.questions ?? []).entries()) {
    try {
      const v = SpecOpsEngine.validateQuestion({ kind: 'text', ...q }, `questions[${i}]`);
      if (!fieldOk(v.field)) { errors.push(`questions[${i}]: "${v.field}" is not a field this interview covers (${[...known].join(', ')}).`); continue; }
      toAsk.push(v);
    } catch (err) { errors.push(err instanceof Error ? err.message : String(err)); }
  }
  if (toAsk.length) asked.push(...engine.applyAction(toAsk.length === 1 ? { action: 'ask', question: toAsk[0] } : { action: 'ask_many', questions: toAsk }, now));
  const answered: string[] = [];
  for (const [i, a] of (input.answers ?? []).entries()) {
    const value = String(a.value ?? '').trim();
    if (!value) { errors.push(`answers[${i}]: the answer is empty.`); continue; }
    const current = engine.getSession();
    let q = a.questionId ? current.questions.find((x) => x.id === a.questionId) : undefined;
    if (a.questionId && !q) { errors.push(`answers[${i}]: no question ${a.questionId} in this interview.`); continue; }
    if (!q && a.field) {
      if (!fieldOk(a.field)) { errors.push(`answers[${i}]: "${a.field}" is not a field this interview covers.`); continue; }
      q = openQuestions(current).filter((x) => x.field === a.field).pop();
      if (!q) {
        const [id] = engine.applyAction({ action: 'ask', question: { field: a.field, prompt: (a.prompt ?? '').trim() || `(answered without a recorded question: ${a.field})`, kind: 'text' } }, now);
        q = engine.getSession().questions.find((x) => x.id === id);
      }
    }
    if (!q) { errors.push(`answers[${i}]: name the question (questionId) or the field it answers.`); continue; }
    engine.answer({ questionId: q.id, field: q.field, value, answeredAt: now, by: who.by, channel: who.channel });
    answered.push(q.id);
  }
  return { session: engine.getSession(), asked, answered, errors };
}

export interface InterviewSummary {
  id: string;
  status: 'open' | 'synthesizing' | 'done';
  problemStatement: string;
  changeRequest?: string;
  turn: { asked: number; budget: number };
  parts: Array<{ skill: string; name: string; specFields: string[]; status: 'addressed' | 'partial' | 'not-started' }>;
  open: Array<Pick<SpecIntakeQuestion, 'id' | 'field' | 'prompt' | 'kind' | 'options'>>;
  answered: Array<{ questionId: string; field: string; prompt: string; value: string; by?: string; channel?: string; answeredAt: string }>;
  attachments: Array<{ path: string; packDocument?: string; summary?: string }>;
  feeds?: IntakeSession['feeds'];
}

/** What any surface shows: the parts covered, what is still open, what was answered by whom. */
export function summarizeInterview(s: IntakeSession, skills: readonly SkillDefinition[]): InterviewSummary {
  const parts = skills.filter((k) => k.specFields.length).map((k) => {
    const covered = k.specFields.filter((f) => s.coverage[f] !== undefined && s.coverage[f] !== 'missing').length;
    return { skill: k.id, name: k.name, specFields: k.specFields, status: (covered === 0 ? 'not-started' : covered === k.specFields.length ? 'addressed' : 'partial') as InterviewSummary['parts'][number]['status'] };
  });
  const prompt = new Map(s.questions.map((q) => [q.id, q.prompt]));
  return {
    id: s.id,
    status: s.feeds || s.state === 'approved' ? 'done' : s.state === 'synthesizing' ? 'synthesizing' : 'open',
    problemStatement: s.problemStatement, changeRequest: s.changeRequest,
    turn: { asked: s.turnCount, budget: s.turnBudget },
    parts,
    open: openQuestions(s).map(({ id, field, prompt: p, kind, options }) => ({ id, field, prompt: p, kind, options })),
    answered: s.answers.map((a) => ({ questionId: a.questionId, field: a.field, prompt: prompt.get(a.questionId) ?? '', value: a.value, by: a.by, channel: a.channel, answeredAt: a.answeredAt })),
    attachments: (s.attachments ?? []).map((a) => ({ path: a.path, packDocument: a.packDocument, summary: a.extract?.rawSummary })),
    feeds: s.feeds
  };
}

/** Marks the interview as having produced this specification version: it is no longer resumed. */
export function markInterviewFed(problemRoot: string, spec: { id: string; version: number }, channel: InterviewChannel, now = new Date().toISOString()): boolean {
  const s = readInterview(problemRoot);
  if (!s || !isOpenInterview(s)) return false;
  writeInterview(problemRoot, { ...s, state: 'draft', feeds: { specId: spec.id, version: spec.version, at: now, channel }, updatedAt: now });
  return true;
}
