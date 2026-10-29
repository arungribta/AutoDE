import { StepEvent, ToolCallAuditEntry } from '../engine/types';
import { stepText, toolResultSummary } from '../engine/agents/answerTrace';

/**
 * Claude Code's streamed events (`-p --output-format stream-json --verbose`),
 * read as they arrive (v0.52.3): each tool call becomes a progress line in
 * AutoDE's log and an audit entry — the same record AutoDE's own loop keeps
 * for every other model — so a Claude run is no longer a black box and its
 * reply's trace has its steps. The final `result` event is the reply.
 *
 * Events used (one JSON object per line):
 * - `assistant` with `message.content[]` items of type `tool_use` {id, name, input};
 * - `user` with `message.content[]` items of type `tool_result` {tool_use_id, content, is_error};
 * - `result` {subtype, is_error, result}.
 * Anything else (system/init, text, thinking) is ignored; a line that isn't JSON is skipped.
 */

const AUTODE_MCP = /^mcp__autode__/;

/** Claude Code's built-in tools as AutoDE's own loop names them, so a trace reads the same whatever the model. */
const BUILT_IN: Record<string, (i: Record<string, unknown>) => [string, Record<string, unknown>]> = {
  Read: (i) => ['autode_read_file', { path: i.file_path ?? i.path }],
  Grep: (i) => ['autode_search_files', { query: i.pattern }],
  Glob: (i) => ['autode_list_dir', { path: i.pattern ?? i.path }],
  Edit: (i) => ['autode_write_file', { path: i.file_path }],
  Write: (i) => ['autode_write_file', { path: i.file_path }],
  Bash: (i) => ['autode_run_command', { command: i.command }]
};

interface Pending { name: string; input: Record<string, unknown>; at: string }

export class ClaudeStreamParser {
  private buffer = '';
  private readonly pending = new Map<string, Pending>();
  private final: { text?: string; error?: string } | undefined;
  public readonly audit: ToolCallAuditEntry[] = [];

  /** `onStep` hears each tool call as `running`, then `ok` or `error` (v0.52.5: the chat's activity card, the same as AutoDE's own loop gives). */
  constructor(private readonly onStep: (e: StepEvent) => void = () => undefined, private readonly now: () => Date = () => new Date()) {}

  public feed(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (line) this.line(line);
    }
  }

  /** The reply, once the stream has ended (a trailing line without a newline is read too). */
  public result(): { text?: string; error?: string } {
    if (this.buffer.trim()) { this.line(this.buffer.trim()); this.buffer = ''; }
    // A tool call with no result (the run was cut short) is still a step.
    for (const [, p] of this.pending) this.audit.push({ tool: p.name, input: p.input, outcome: 'error', detail: 'no result (the run ended first)', at: p.at });
    this.pending.clear();
    return this.final ?? { error: 'Claude Code ended without a result' };
  }

  private line(text: string): void {
    let ev: { type?: string; subtype?: string; is_error?: boolean; result?: unknown; message?: { content?: unknown } };
    try { ev = JSON.parse(text); } catch { return; }
    const content = Array.isArray(ev.message?.content) ? ev.message!.content as Array<Record<string, unknown>> : [];
    if (ev.type === 'assistant') {
      for (const c of content) {
        if (c.type !== 'tool_use' || typeof c.id !== 'string' || typeof c.name !== 'string') continue;
        const raw = (c.input && typeof c.input === 'object' ? c.input : {}) as Record<string, unknown>;
        const [name, input] = BUILT_IN[c.name] ? BUILT_IN[c.name](raw) : [c.name.replace(AUTODE_MCP, ''), raw];
        this.pending.set(c.id, { name, input, at: this.now().toISOString() });
        this.onStep({ id: c.id, tool: name, text: stepText(name, input), status: 'running' });
      }
    } else if (ev.type === 'user') {
      for (const c of content) {
        if (c.type !== 'tool_result' || typeof c.tool_use_id !== 'string') continue;
        const p = this.pending.get(c.tool_use_id);
        if (!p) continue;
        this.pending.delete(c.tool_use_id);
        const body = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? (c.content as Array<{ type?: string; text?: string }>).filter((x) => x.type === 'text').map((x) => x.text ?? '').join('\n') : '';
        const isError = c.is_error === true;
        const entry: ToolCallAuditEntry = { tool: p.name, input: p.input, outcome: isError ? 'error' : 'ok', ...(isError ? { detail: body.slice(0, 500) } : toolResultSummary(p.name, body)), at: p.at };
        this.audit.push(entry);
        this.onStep({ id: c.tool_use_id, tool: p.name, text: stepText(p.name, p.input), status: isError ? 'error' : 'ok', ...(entry.found ? { found: entry.found } : {}), ...(isError && entry.detail ? { detail: entry.detail.slice(0, 200) } : {}) });
      }
    } else if (ev.type === 'result') {
      if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) this.final = { error: typeof ev.result === 'string' && ev.result ? ev.result : ev.subtype || 'Claude Code reported an error' };
      else this.final = typeof ev.result === 'string' ? { text: ev.result.trim() } : { error: 'Claude Code returned no result text' };
    }
  }
}
