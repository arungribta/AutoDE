import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The workflow's history (v0.44.1): an append-only log of everything that
 * happened to a problem's workflow and its stages — who, through which
 * channel, when, why, with the decision or files involved. The runtime keeps
 * only the current state; this is what makes it traceable. Written by the
 * engine only; one JSON object per line in
 * `.autode/problems/<id>/workflow-events.jsonl` (committed with the problem).
 */

export type WorkflowEventType =
  | 'suggested'      // the engine's rule suggested a template
  | 'drafted'        // a draft was made (by the engine, from a template)
  | 'proposed'       // proposed for approval (the plan gate)
  | 'approved'       // a workflow or stage approval
  | 'rejected'
  | 'started' | 'handed-in' | 'done' | 'stale' | 'skipped' | 'reopened';

/** Who did it: the engine's deterministic rules, a person, or an agent. */
export type Actor = { kind: 'engine'; rule?: string } | { kind: 'person'; name: string } | { kind: 'agent'; name: string; host?: string };

export interface WorkflowEvent {
  at: string;
  type: WorkflowEventType;
  /** Absent for events about the whole workflow. */
  stage?: string;
  actor: Actor;
  /** panel, cli, file, tool, elicitation, document (approved in its own document), engine. */
  channel?: string;
  reason?: string;
  decisionId?: string;
  files?: string[];
  template?: string;
}

export function eventsFile(problemRoot: string): string {
  return path.join(problemRoot, 'workflow-events.jsonl');
}

export function appendEvent(problemRoot: string, e: WorkflowEvent): void {
  fs.mkdirSync(problemRoot, { recursive: true });
  fs.appendFileSync(eventsFile(problemRoot), JSON.stringify(e) + '\n');
}

/** The log, oldest first; with `stage`, only that stage's events (and workflow-wide ones when `withWorkflow`). Unreadable lines are skipped. */
export function readEvents(problemRoot: string, filter: { stage?: string; withWorkflow?: boolean } = {}): WorkflowEvent[] {
  let text = '';
  try { text = fs.readFileSync(eventsFile(problemRoot), 'utf8'); } catch { return []; }
  const out: WorkflowEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as WorkflowEvent); } catch { /* a torn line */ }
  }
  return filter.stage === undefined ? out : out.filter((e) => e.stage === filter.stage || (filter.withWorkflow === true && e.stage === undefined));
}

/** "the engine (rule: …)", "priya", "agent Claude Code" — for any surface. */
export function actorLabel(a: Actor): string {
  if (a.kind === 'engine') return `the engine${a.rule ? ` (rule: ${a.rule})` : ''}`;
  if (a.kind === 'person') return a.name;
  return `agent ${a.name}${a.host ? ` via ${a.host}` : ''}`;
}

/** An actor from a decision's proposer or resolver string: hosts `mcp` are agents, everything else a person. */
export function actorFrom(name: string | undefined, host?: string): Actor {
  if (host === 'mcp') return { kind: 'agent', name: name || 'MCP client', host: 'MCP' };
  return { kind: 'person', name: name || 'unknown' };
}
