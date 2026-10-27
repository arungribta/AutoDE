import * as fs from 'node:fs';
import * as path from 'node:path';
import { Assertion } from './assertions';
import { layoutPath } from '../workspaceLayout';

/**
 * The conversation, reviewed (C4c; docs/context-layer-requirements.md §5.5
 * item 4). The raw message stays as evidence; at the end of a session AutoDE
 * lists what the user said that reads like a fact but has no fact citing it,
 * for the user to record or dismiss. Deterministic: fixed cues, no model, so
 * a model that missed a fact while extracting can't also miss it here.
 */

export interface ReviewTurn {
  /** `chat:<chatId>#<n>` or `interview:<problem>#<question>`, as fact evidence cites it. */
  ref: string;
  text: string;
}

export interface UnrecordedStatement extends ReviewTurn {
  /** The phrase that makes it read like a fact. */
  cue: string;
}

const CUES: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:is|are)\s+(?:always\s+)?(?:unique|the (?:primary |natural |business )?key|never null|required|mandatory)\b/i, 'a key or data property'],
  [/\bone row per\b|\bgrain\b/i, 'a grain'],
  [/\b(?:means|is defined as|defined as|refers to|stands for|is calculated as|is computed as)\b/i, 'a definition'],
  [/\b(?:joins?|links?|references?|maps? to|matches)\b/i, 'a relationship'],
  [/\b(?:must|must not|always|never|only|exclud(?:e|es|ing)|includ(?:e|es|ing)|should not)\b/i, 'a rule'],
  [/\b(?:we use|we decided|decided|let's go with|we'll use|we will use|assume|assuming)\b/i, 'a decision or assumption'],
  [/\b\d+\s*(?:days?|hours?|minutes?|months?|%|percent)\b/i, 'a threshold']
];

/** The cue a message carries, if it reads like a statement of fact (not a question, not a command). */
export function factCue(text: string): string | undefined {
  const t = text.trim();
  if (t.length < 12 || t.startsWith('/') || /\?\s*$/.test(t)) return undefined;
  return CUES.find(([re]) => re.test(t))?.[1];
}

/**
 * Messages that read like facts and that no fact cites (in any status: a
 * rejected fact was still recorded and decided), minus those the user
 * dismissed.
 */
export function unrecordedStatements(turns: readonly ReviewTurn[], assertions: readonly Assertion[], dismissed: ReadonlySet<string> = new Set()): UnrecordedStatement[] {
  const cited = new Set(assertions.flatMap((a) => a.evidence.map((e) => e.ref)));
  return turns.flatMap((t) => {
    if (cited.has(t.ref) || dismissed.has(t.ref)) return [];
    const cue = factCue(t.text);
    return cue ? [{ ...t, cue }] : [];
  });
}

function dismissedFile(workspaceRoot: string): string {
  return path.join(path.dirname(layoutPath(workspaceRoot, 'activeProblem')), 'session-review.json');
}

/** Statements the user dismissed (this engineer's, in `.autode/local/`). */
export function dismissedStatements(workspaceRoot: string): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(dismissedFile(workspaceRoot), 'utf8')) as { dismissed?: unknown };
    return new Set(Array.isArray(raw.dismissed) ? raw.dismissed.map(String) : []);
  } catch { return new Set(); }
}

export function dismissStatements(workspaceRoot: string, refs: readonly string[]): void {
  const all = [...new Set([...dismissedStatements(workspaceRoot), ...refs])];
  const file = dismissedFile(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ dismissed: all }, null, 2));
}

export function renderUnrecorded(list: readonly UnrecordedStatement[]): string {
  if (!list.length) return 'Nothing to review: every message that reads like a fact is recorded.';
  return [
    `${list.length} message(s) read like facts but aren't recorded:`,
    ...list.map((s, i) => `${i + 1}. (${s.cue}) "${s.text.replace(/\s+/g, ' ').slice(0, 160)}"`),
    '',
    'Record one with `/review record <n>` (the model reads it again), or yourself with /define, /rule, /decide or /assume; dismiss with `/review dismiss <n>` or `/review dismiss all`.'
  ].join('\n');
}
