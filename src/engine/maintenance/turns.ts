import * as fs from 'node:fs';
import * as path from 'node:path';
import { Assertion } from '../context/assertions';
import { UnrecordedStatement, dismissedStatements, unrecordedStatements } from '../context/sessionReview';
import { layoutPath } from '../workspaceLayout';

/**
 * Chat turns recorded for review (MM2; docs/specs/context-layer.md
 * §5.6). In Claude Code, AutoDE's plugin hook records each message the user
 * submits: it runs no model, it only makes sure the turn can't be forgotten.
 * A turn that reads like a fact (the C4c cues) is *unreviewed* until a fact
 * cites it or someone dismisses it; the context curator works through them.
 * Per engineer (`.autode/local/turns/`), never committed.
 */

export interface RecordedTurn {
  /** `chat:<host>-<session>#<n>`: the ref a fact's evidence cites. */
  ref: string;
  text: string;
  at: string;
  host: string;
  session: string;
}

const MAX_TEXT = 4000;
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'session';

function turnsFile(workspaceRoot: string, host: string, session: string): string {
  return path.join(layoutPath(workspaceRoot, 'turns'), `${safe(host)}-${safe(session)}.jsonl`);
}

function readFile(file: string): RecordedTurn[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as RecordedTurn]; } catch { return []; } });
  } catch { return []; }
}

/** Records one user message; a slash command or an empty message is not a turn. */
export function recordTurn(workspaceRoot: string, input: { host: string; session: string; text: string; at?: Date }): RecordedTurn | undefined {
  const text = input.text.trim();
  if (!text || text.startsWith('/')) return undefined;
  const file = turnsFile(workspaceRoot, input.host, input.session);
  const n = readFile(file).length + 1;
  const turn: RecordedTurn = { ref: `chat:${safe(input.host)}-${safe(input.session)}#${n}`, text: text.slice(0, MAX_TEXT), at: (input.at ?? new Date()).toISOString(), host: input.host, session: input.session };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(turn) + '\n');
  return turn;
}

export function listTurns(workspaceRoot: string): RecordedTurn[] {
  const dir = layoutPath(workspaceRoot, 'turns');
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return []; }
  return names.flatMap((f) => readFile(path.join(dir, f)));
}

/** Recorded turns that read like facts and that no fact cites, minus those dismissed. */
export function unreviewedTurns(workspaceRoot: string, assertions: readonly Assertion[]): Array<UnrecordedStatement & Pick<RecordedTurn, 'at' | 'host' | 'session'>> {
  const turns = listTurns(workspaceRoot);
  const byRef = new Map(turns.map((t) => [t.ref, t] as const));
  return unrecordedStatements(turns, assertions, dismissedStatements(workspaceRoot)).map((s) => ({ ...s, at: byRef.get(s.ref)!.at, host: byRef.get(s.ref)!.host, session: byRef.get(s.ref)!.session }));
}

/** The folder above `cwd` that has an `.autode` folder: the workspace a hook's turn belongs to. */
export function workspaceOf(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.autode'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/**
 * Claude Code's `UserPromptSubmit` event (`session_id`, `cwd`, `prompt`),
 * recorded in the workspace it was submitted in. Anything else, or a folder
 * that isn't an AutoDE workspace, records nothing.
 */
export function recordHookTurn(event: unknown, fallbackCwd: string, at?: Date): RecordedTurn | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const e = event as { session_id?: unknown; cwd?: unknown; prompt?: unknown; hook_event_name?: unknown };
  if (e.hook_event_name !== undefined && e.hook_event_name !== 'UserPromptSubmit') return undefined;
  if (typeof e.prompt !== 'string') return undefined;
  const root = workspaceOf(typeof e.cwd === 'string' && e.cwd ? e.cwd : fallbackCwd);
  if (!root) return undefined;
  return recordTurn(root, { host: 'claude-code', session: typeof e.session_id === 'string' && e.session_id ? e.session_id : 'session', text: e.prompt, at });
}
