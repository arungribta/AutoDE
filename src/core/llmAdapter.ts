import * as vscode from 'vscode';
import { DataAgentHubSettings, LlmProvider, ToolCallAuditEntry, ToolExecutionMode, EngineToolSet, StepEvent } from '../engine/types';

/**
 * The provider-agnostic contract every LLM provider implements (Phase C).
 * `AgentHub.callConfiguredLlm` used to be a single ~90-line if/else chain that
 * mixed dispatch, consent-gating, and per-provider request/response shaping.
 * That's now one lookup (`getLlmAdapter(provider).complete(...)`) — adding a
 * provider means adding one adapter object here, not editing the dispatcher.
 *
 * This does not attempt to make every provider identical: `copilot` (in-process
 * `vscode.lm`), `claude` (a subprocess CLI with tool-execution flags), and the
 * five `fetch()`-based REST providers are different enough in kind that forcing
 * them through one generic "REST template" would hide real capability
 * differences (tool access, streaming, timeouts). This interface unifies the
 * *dispatch and metadata*, not the transport.
 */
export interface LlmAdapter {
  readonly id: LlmProvider;
  readonly displayName: string;
  readonly requiresApiKey: boolean;
  readonly supportsCustomEndpoint: boolean;
  /** Can this provider run a tool-using agentic loop (Phase D)? Defaults to false when omitted. */
  readonly supportsToolExecution?: boolean;
  complete(prompt: string, opts: LlmCompleteOptions, ctx: LlmAdapterContext): Promise<string>;
}

export interface LlmHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmCompleteOptions {
  model: string;
  systemPrompt: string;
  justification?: string;
  /** 'none' (default when omitted), 'read-only' (file read/list/search), or 'full'
   *  (also write/exec, gated by per-call or whole-run approval). Ignored by
   *  adapters that don't support tool execution (`supportsToolExecution` false). */
  toolExecutionMode?: ToolExecutionMode;
  /** Prior conversation turns, oldest first, already windowed to the caller's token budget
   *  (see `core/tokenBudget.ts`). Adapters thread this into their own native message format —
   *  ignored by the Claude adapter when `claudeSessionId` is set, since the CLI's own resumed
   *  session already carries this server-side. */
  history?: LlmHistoryTurn[];
  /** Claude-only: Claude Code CLI's own session id for this chat. When set, the adapter passes
   *  `--session-id` (new session) or `--resume` (continuing one) instead of relying on `history`. */
  claudeSessionId?: string;
  /** Claude-only: true when `claudeSessionId` was just minted and hasn't been used yet (first
   *  call for this chat) — selects `--session-id` over `--resume`. */
  isNewClaudeSession?: boolean;
  /** Narrows the mode's tool catalog to these AutoDE tool names (v0.28.0 — a skill's resolved
   *  `allowed-tools`, see `resolveAllowedToolNames`). Omitted = the mode's full catalog. Enforced by
   *  every AutoDE-owned tool loop, and by the Claude adapter through the CLI's `--tools` list. */
  allowedToolNames?: string[];
  /** When given, every tool call the adapter's loop makes is appended here, so the caller gets the
   *  audit trail instead of it being discarded. The Claude CLI runs its own loop and appends nothing. */
  auditSink?: ToolCallAuditEntry[];
  /** Claude-only: replaces the generic whole-run approval text in `'full'` mode, so the caller can say
   *  what is being approved (e.g. which skill). */
  approvalPrompt?: string;
  /** The engine's MCP tools for this run (phase 5), offered next to the file tools by every AutoDE-owned
   *  loop when the mode allows tools. The Claude adapter (v0.52.3) attaches AutoDE's MCP server to its
   *  CLI instead and pre-approves exactly these tools. */
  engineTools?: EngineToolSet;
  /** v0.52.3: who the run is for (an agent role), recorded by AutoDE's server when the CLI calls its tools. */
  agentName?: string;
  /** v0.52.5: each tool call as it happens, from every adapter (Claude Code's from its event stream). */
  onStep?: (e: StepEvent) => void;
}

/**
 * The narrow slice of extension-host services an adapter needs — decoupled from
 * `DataAgentHubHub` itself so adapters are constructible and testable in
 * isolation. `AgentHub` builds one of these per call from its own `configManager`.
 */
export interface LlmAdapterContext {
  getSettings(): DataAgentHubSettings;
  getLlmApiKey(): Promise<string | undefined>;
  getExtensionContext(): vscode.ExtensionContext | undefined;
  getWorkspaceRoot(): string | undefined;
  log(message: string): void;
}

/**
 * Strips ```json fences from an LLM response, but only when the payload looks
 * like JSON — so prose/markdown chat responses keep their formatting intact.
 */
export function extractJsonText(content: string): string {
  const trimmed = (content ?? '').trim();
  if (!trimmed) { throw new Error('The LLM returned an empty response.'); }
  const looksLikeJson = /^```(?:json)?\s*[[{]/i.test(trimmed) || /^[[{]/.test(trimmed);
  if (!looksLikeJson) { return trimmed; }
  const normalized = trimmed.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  if (!normalized) { throw new Error('The LLM returned an empty response.'); }
  return normalized;
}
