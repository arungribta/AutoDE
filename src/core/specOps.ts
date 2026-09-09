import {
  IntakeAnswer,
  IntakeSession,
  SpecCoverageStatus,
  SpecEngineAction,
  SpecEngineState,
  SpecIntakeQuestion,
  SpecQuestionKind
} from './types';

export const DEFAULT_TURN_BUDGET = 12;

const QUESTION_KINDS = new Set<SpecQuestionKind>(['text', 'single-select', 'multi-select', 'boolean']);

/**
 * Creates a fresh intake session for an agentic specification conversation.
 * The coverage map is seeded with every field the registered skills own, so the
 * engine's stop condition can observe which areas remain unexplored.
 */
export function createIntakeSession(
  problemStatement: string,
  opts: { id?: string; turnBudget?: number; fields?: string[]; now?: string } = {}
): IntakeSession {
  const trimmed = (problemStatement ?? '').trim();
  if (!trimmed) {
    throw new Error('A problem statement is required to start a specification conversation.');
  }
  const now = opts.now ?? new Date().toISOString();
  const coverage: Record<string, SpecCoverageStatus> = {};
  for (const field of opts.fields ?? []) {
    coverage[field] = 'missing';
  }
  return {
    id: opts.id ?? `intake-${Date.now().toString(36)}`,
    problemStatement: trimmed,
    state: 'discovery',
    questions: [],
    answers: [],
    insights: [],
    coverage,
    turnCount: 0,
    turnBudget: opts.turnBudget ?? DEFAULT_TURN_BUDGET,
    createdAt: now,
    updatedAt: now
  };
}

function cloneSession(session: IntakeSession): IntakeSession {
  return {
    ...session,
    questions: session.questions.map((q) => ({ ...q, options: q.options ? [...q.options] : undefined })),
    answers: session.answers.map((a) => ({ ...a })),
    insights: [...session.insights],
    coverage: { ...session.coverage }
  };
}

/**
 * The deterministic state machine behind agentic spec generation. It owns the
 * conversation state, the per-field coverage used as the stop condition, and
 * validation of the prompt-schema actions the LLM produces each turn.
 */
export class SpecOpsEngine {
  private readonly session: IntakeSession;

  public constructor(session: IntakeSession) {
    this.session = session;
  }

  public getSession(): IntakeSession {
    return cloneSession(this.session);
  }

  public getState(): SpecEngineState {
    return this.session.state;
  }

  public getCoverage(): Record<string, SpecCoverageStatus> {
    return { ...this.session.coverage };
  }

  public setState(state: SpecEngineState): void {
    this.session.state = state;
    this.touch();
  }

  /** Registers questions the engine is asking and advances the turn counter. */
  public ask(questions: SpecIntakeQuestion[]): void {
    for (const question of questions) {
      this.session.questions.push({
        ...question,
        options: question.options ? [...question.options] : undefined
      });
      this.session.turnCount += 1;
      if (!(question.field in this.session.coverage)) {
        this.session.coverage[question.field] = 'missing';
      }
    }
    this.touch();
  }

  /** Records an answer and marks its target field as at least partially covered. */
  public answer(answer: IntakeAnswer): void {
    this.session.answers.push({ ...answer });
    const current = this.session.coverage[answer.field];
    if (current === undefined || current === 'missing') {
      this.session.coverage[answer.field] = 'partial';
    }
    this.touch();
  }

  public setCoverage(field: string, status: SpecCoverageStatus): void {
    this.session.coverage[field] = status;
    this.touch();
  }

  /** Marks the given fields complete (invoked when synthesis finalizes them). */
  public completeFields(fields: string[]): void {
    for (const field of fields) {
      this.session.coverage[field] = 'complete';
    }
    this.touch();
  }

  public addInsight(insight: string): void {
    const trimmed = (insight ?? '').trim();
    if (trimmed) this.session.insights.push(trimmed);
    this.touch();
  }

  public coverageComplete(): boolean {
    const fields = Object.keys(this.session.coverage);
    return fields.length > 0 && fields.every((field) => this.session.coverage[field] !== 'missing');
  }

  /** True when the discovery loop should stop and synthesize the specification. */
  public shouldSynthesize(): boolean {
    return this.session.turnCount >= this.session.turnBudget || this.coverageComplete();
  }

  // ── Prompt-schema action validation (deterministic) ──

  public static validateQuestion(raw: unknown, label = 'question'): Omit<SpecIntakeQuestion, 'id' | 'askedAt'> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`The ${label} must be a JSON object.`);
    }
    const record = raw as Record<string, unknown>;

    const field = typeof record.field === 'string' ? record.field.trim() : '';
    if (!field) throw new Error(`The ${label} requires a "field".`);

    const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
    if (!prompt) throw new Error(`The ${label} requires a non-empty "prompt".`);

    const rawKind = typeof record.kind === 'string' ? record.kind : '';
    const kind = rawKind as SpecQuestionKind;
    if (!QUESTION_KINDS.has(kind)) throw new Error(`The ${label} has an invalid "kind": ${rawKind || '(empty)'}`);

    const options = Array.isArray(record.options)
      ? record.options.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : undefined;

    return {
      field,
      prompt,
      kind,
      options: options && options.length > 0 ? options : undefined,
      rationale: typeof record.rationale === 'string' ? record.rationale.trim() : undefined,
      skill: typeof record.skill === 'string' ? record.skill.trim() : undefined
    };
  }

  /** Validates an LLM-produced action, throwing a clear error when malformed. */
  public static validateAction(raw: unknown): SpecEngineAction {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('A spec engine action must be a JSON object.');
    }
    const record = raw as Record<string, unknown>;
    const action = typeof record.action === 'string' ? record.action : '';

    switch (action) {
      case 'ask':
        return { action: 'ask', question: SpecOpsEngine.validateQuestion(record.question, 'question') };
      case 'ask_many': {
        if (!Array.isArray(record.questions) || record.questions.length === 0) {
          throw new Error('"ask_many" requires a non-empty "questions" array.');
        }
        const questions = record.questions.map((value, index) =>
          SpecOpsEngine.validateQuestion(value, `questions[${index}]`)
        );
        return { action: 'ask_many', questions };
      }
      case 'synthesize':
        return { action: 'synthesize' };
      case 'done':
        return { action: 'done' };
      default:
        throw new Error(`Unknown spec engine action: ${action || '(empty)'}`);
    }
  }

  private touch(): void {
    this.session.updatedAt = new Date().toISOString();
  }
}
