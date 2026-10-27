import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml, stringifyYaml } from '../context/Yaml';
import { Assertion, AssertionKind, isLive } from '../context/assertions';
import { AssertionLedger, NewAssertion } from '../context/ledger';
import { isMirror } from '../context/projection';
import { parseBusinessProblemSpec, readProblemDocument } from './problemDocuments';
import { layoutPath } from '../workspaceLayout';

/**
 * Exploration mode (C4c; docs/context-layer-requirements.md §7.4): most
 * AutoDE work is exploration, a proof of concept or a proof of value. A
 * business problem in exploration mode proceeds on the model's recorded
 * assumptions instead of pausing, takes model proposals at `assumed` trust,
 * warns where governed mode refuses, and approves gates in one click, under a
 * disclaimer a person acknowledged. Platform safety never relaxes: runbooks,
 * production policy (an exploration problem targets non-production
 * environments only), sample-data consent, secrets and rollbacks behave the
 * same in both modes. Switching back to governed lists everything to harden.
 *
 * The mode lives in `<problem>/mode.yaml`, beside the specification rather
 * than in it, so switching never makes approved stages stale.
 */

export type ProblemMode = 'governed' | 'exploration';

export const EXPLORATION_DISCLAIMER = 'Exploration mode: AutoDE proceeds on the model\'s recommendations and records them as assumptions. Results may be completely wrong: assumptions are not verified, and failed checks only warn. Platform changes still need approved runbooks, and only non-production environments may be targeted.';

/** The one-line label for deliverables, manifests and assignments. */
export const EXPLORATION_LABEL = 'AutoDE exploration mode: built on unverified assumptions; results may be completely wrong.';

export interface ModeChange { mode: ProblemMode; at: string; by: string; channel: string }

export interface ModeRecord {
  mode: ProblemMode;
  since: string;
  by: string;
  /** The disclaimer the person acknowledged (exploration only). */
  acknowledged?: string;
  history: ModeChange[];
}

export function modeFile(problemRoot: string): string {
  return path.join(problemRoot, 'mode.yaml');
}

export function readModeRecord(problemRoot: string): ModeRecord | undefined {
  try {
    const raw = parseYaml(fs.readFileSync(modeFile(problemRoot), 'utf8')) as Partial<ModeRecord> | null;
    if (!raw || (raw.mode !== 'exploration' && raw.mode !== 'governed')) return undefined;
    return { mode: raw.mode, since: String(raw.since ?? ''), by: String(raw.by ?? ''), acknowledged: raw.acknowledged, history: Array.isArray(raw.history) ? raw.history : [] };
  } catch { return undefined; }
}

/** The problem's mode; governed unless a person switched it. */
export function problemMode(problemRoot: string | undefined): ProblemMode {
  return problemRoot ? readModeRecord(problemRoot)?.mode ?? 'governed' : 'governed';
}

export const isExploration = (problemRoot: string | undefined): boolean => problemMode(problemRoot) === 'exploration';

/**
 * A person's act: switches the problem's mode. Exploration needs the
 * disclaimer acknowledged. Returns the hardening list when switching to
 * governed (what was assumed, model-only, or only warned).
 */
export function setProblemMode(
  problemRoot: string,
  mode: ProblemMode,
  who: { by: string; channel: string; acknowledged?: boolean },
  options: { workspaceRoot?: string; now?: Date } = {}
): { record: ModeRecord; changed: boolean; hardening?: HardeningReport } {
  if (mode === 'exploration' && !who.acknowledged) throw new Error(`Exploration mode needs the disclaimer acknowledged: ${EXPLORATION_DISCLAIMER}`);
  if (!who.by.trim()) throw new Error('Say who is switching the mode.');
  const before = readModeRecord(problemRoot);
  const current = before?.mode ?? 'governed';
  const at = (options.now ?? new Date()).toISOString();
  if (current === mode && before) return { record: before, changed: false };
  const record: ModeRecord = {
    mode, since: at, by: who.by,
    ...(mode === 'exploration' ? { acknowledged: EXPLORATION_DISCLAIMER } : {}),
    history: [...(before?.history ?? []), { mode, at, by: who.by, channel: who.channel }]
  };
  fs.mkdirSync(problemRoot, { recursive: true });
  fs.writeFileSync(modeFile(problemRoot), '# AutoDE problem mode: switched by a person (panel, `autode problems mode`).\n' + stringifyYaml(record as unknown as Record<string, unknown>));
  const hardening = mode === 'governed' && current === 'exploration' ? hardeningReport(problemRoot, options.workspaceRoot) : undefined;
  return { record, changed: current !== mode, hardening };
}

// ── Checks that only warned ──────────────────────────────────────────────────

export interface WarnedCheck { at: string; check: string; stage?: string; detail: string }

function warningsFile(problemRoot: string): string {
  return path.join(problemRoot, 'exploration-warnings.jsonl');
}

/** Records a check that would have refused in governed mode; hardening lists it. */
export function recordWarnedCheck(problemRoot: string, w: Omit<WarnedCheck, 'at'> & { at?: string }): void {
  fs.mkdirSync(problemRoot, { recursive: true });
  fs.appendFileSync(warningsFile(problemRoot), JSON.stringify({ at: w.at ?? new Date().toISOString(), check: w.check, stage: w.stage, detail: w.detail }) + '\n');
}

export function warnedChecks(problemRoot: string): WarnedCheck[] {
  try {
    return fs.readFileSync(warningsFile(problemRoot), 'utf8').split(/\r?\n/).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as WarnedCheck]; } catch { return []; } });
  } catch { return []; }
}

// ── Facts ───────────────────────────────────────────────────────────────────

/**
 * What exploration mode does to a proposal that isn't a person's: it counts
 * at once, live at `assumed` trust (a verified one stays verified), flagged
 * `exploration`. Governed mode leaves it proposed for the Context Inbox.
 */
export function admitForMode<T extends NewAssertion>(candidate: T, mode: ProblemMode): T {
  if (mode !== 'exploration' || (candidate.status ?? 'proposed') !== 'proposed') return candidate;
  const trust = (candidate.trust ?? 'inferred') === 'inferred' ? 'assumed' : candidate.trust;
  return { ...candidate, status: 'active', trust, flags: [...new Set([...(candidate.flags ?? []), 'exploration'])] };
}

/** The specification id of the problem, for facts recorded on its behalf. */
export function problemSpecId(problemRoot: string): string | undefined {
  try {
    const text = readProblemDocument(problemRoot, 'spec');
    return text ? parseBusinessProblemSpec(text).id : undefined;
  } catch { return undefined; }
}

export interface AssumptionInput {
  kind: AssertionKind;
  subject: string[];
  predicate: string;
  value: unknown;
  statement: string;
  /** The model whose best guess this is. */
  model: string;
  /** The stage (or step) that needed it. */
  stepId?: string;
  /** Why the model guessed this. */
  reason: string;
  specId?: string;
  createdBy?: string;
}

/**
 * Assume and continue (§7.4): where a stage would pause on a context gap, the
 * model's best guess is recorded as a live fact of the kind the gap needs, at
 * `assumed` trust and flagged `assumption`, with the model, the stage and the
 * reason as its evidence. Refused in a governed problem.
 */
export async function recordAssumption(ledger: AssertionLedger, problemRoot: string, input: AssumptionInput): Promise<Assertion> {
  if (!isExploration(problemRoot)) throw new Error('This problem is governed: a context gap is closed by a person (Context Inbox), not by an assumption. Switch it to exploration mode to proceed on assumptions.');
  if (!input.model.trim()) throw new Error('An assumption records the model that made it.');
  if (!input.reason.trim()) throw new Error('An assumption records why the model guessed it.');
  return ledger.assert({
    kind: input.kind, subject: input.subject, predicate: input.predicate, value: input.value, statement: input.statement,
    evidence: [{ type: 'model', ref: `model:${input.model}${input.stepId ? `@${input.stepId}` : ''}`, excerpt: input.reason }],
    trust: 'assumed', status: 'active', specId: input.specId ?? problemSpecId(problemRoot), model: input.model,
    createdBy: input.createdBy ?? `model:${input.model}`, flags: ['assumption', 'exploration']
  });
}

// ── Hardening ───────────────────────────────────────────────────────────────

export interface HardeningReport {
  /** Best guesses recorded at a context gap. */
  assumptions: Array<Pick<Assertion, 'id' | 'kind' | 'statement' | 'model'>>;
  /** Model proposals admitted without a person (`assumed` trust). */
  modelOnly: Array<Pick<Assertion, 'id' | 'kind' | 'statement' | 'model'>>;
  /** Checks that warned instead of refusing. */
  warned: WarnedCheck[];
}

function ledgerFor(workspaceRoot: string | undefined, problemRoot: string): AssertionLedger {
  const root = workspaceRoot ?? path.resolve(problemRoot, '..', '..', '..');
  const ledger = new AssertionLedger(layoutPath(root, 'ledger'));
  ledger.loadSync();
  return ledger;
}

/**
 * What switching to governed leaves to confirm or replace: the problem's
 * assumptions, its model-only facts and the checks that only warned. Governed
 * mode then blocks where it normally would until they are.
 */
export function hardeningReport(problemRoot: string, workspaceRoot?: string, assertions?: readonly Assertion[]): HardeningReport {
  const specId = problemSpecId(problemRoot);
  const all = assertions ?? ledgerFor(workspaceRoot, problemRoot).assertions();
  const mine = all.filter((a) => !isMirror(a) && isLive(a.status) && a.trust === 'assumed' && (!specId || !a.specId || a.specId === specId));
  const pick = (a: Assertion) => ({ id: a.id, kind: a.kind, statement: a.statement, ...(a.model ? { model: a.model } : {}) });
  return {
    assumptions: mine.filter((a) => (a.flags ?? []).includes('assumption')).map(pick),
    modelOnly: mine.filter((a) => !(a.flags ?? []).includes('assumption')).map(pick),
    warned: warnedChecks(problemRoot)
  };
}

export function renderHardening(r: HardeningReport): string {
  const lines = ['# Hardening: what exploration mode left to confirm', ''];
  const total = r.assumptions.length + r.modelOnly.length + r.warned.length;
  if (!total) return [...lines, 'Nothing: no assumptions, no model-only facts, no checks that only warned.'].join('\n');
  lines.push('Governed mode blocks where it normally would until each is confirmed or replaced (Context Inbox, `autode facts`).', '');
  if (r.assumptions.length) lines.push(`## Assumptions (${r.assumptions.length})`, ...r.assumptions.map((a) => `- ${a.id} [${a.kind}] ${a.statement}${a.model ? ` (guessed by ${a.model})` : ''}`), '');
  if (r.modelOnly.length) lines.push(`## Model-only facts (${r.modelOnly.length})`, ...r.modelOnly.map((a) => `- ${a.id} [${a.kind}] ${a.statement}${a.model ? ` (${a.model})` : ''}`), '');
  if (r.warned.length) lines.push(`## Checks that only warned (${r.warned.length})`, ...r.warned.map((w) => `- ${w.at.slice(0, 16)} ${w.check}${w.stage ? ` (${w.stage})` : ''}: ${w.detail}`), '');
  return lines.join('\n').trimEnd();
}

// ── Never relaxed ───────────────────────────────────────────────────────────

/** An exploration problem targets non-production environments only (§7.4). */
export function explorationEnvironmentProblem(problemRoot: string, environment: string): string | undefined {
  if (!isExploration(problemRoot) || environment !== 'prod') return undefined;
  return 'This problem is in exploration mode, which targets non-production environments only, and this connection is production (a connection no environment lists in .autode/config/approvals.yaml counts as prod). List it under dev, sandbox or test, or switch the problem to governed.';
}

/** The header every generated deliverable of an exploration problem carries, in the file's comment syntax. */
export function explorationHeader(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.sql') return `-- ${EXPLORATION_LABEL}\n`;
  if (ext === '.yaml' || ext === '.yml' || ext === '.py' || ext === '.sh') return `# ${EXPLORATION_LABEL}\n`;
  if (ext === '.md') return `> **${EXPLORATION_LABEL}**\n\n`;
  return '';
}
