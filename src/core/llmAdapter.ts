import * as vscode from 'vscode';
import { DataAgentHubSettings, LlmProvider } from './types';

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

export interface LlmCompleteOptions {
  model: string;
  systemPrompt: string;
  justification?: string;
  /** Grounded chat only; ignored by adapters that don't support tool execution. */
  allowTools?: boolean;
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
