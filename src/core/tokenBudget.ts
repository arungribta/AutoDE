import { ChatMessage } from './types';

/**
 * Token-budget-aware history windowing (Phase 2). No official tokenizer is
 * wired into this project (only `ajv`/`snowflake-sdk`/`yaml` are dependencies)
 * — `estimateTokens` is a deliberate char/4 heuristic, not a precision
 * tokenizer, for every provider except Copilot (which has a real one, see
 * `LanguageModelChat.countTokens` in `languageModelAdapter.ts`). Budgets carry
 * a safety margin, so the approximation windows slightly conservatively
 * rather than ever overflowing a real context window.
 */

export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

/** Reserved headroom outside the history window: system prompt + context block + the response itself. */
export const RESERVED_PROMPT_TOKENS = 1500;
export const RESERVED_RESPONSE_TOKENS = 2000;

/** Known model context windows, matched by substring against the configured model id/name (case-insensitive, longest match wins). Unrecognized models — most local Ollama models included — fall back to a conservative 8k. */
const CONTEXT_WINDOW_BY_MODEL: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4.1': 1_000_000,
  'gpt-4-turbo': 128_000,
  'gpt-3.5': 16_000,
  'o1': 200_000,
  'o3': 200_000,
  'o4': 200_000,
  claude: 200_000,
  'gemini-1.5': 1_000_000,
  'gemini-2': 1_000_000,
  'gemini-1.0': 32_000,
  llama3: 128_000,
  'llama-3': 128_000,
  qwen2: 32_000,
  mistral: 32_000
};
const DEFAULT_CONTEXT_WINDOW = 8_000;

export function contextWindowForModel(model: string | undefined): number {
  const needle = (model || '').toLowerCase();
  let best: { key: string; window: number } | undefined;
  for (const [key, window] of Object.entries(CONTEXT_WINDOW_BY_MODEL)) {
    if (needle.includes(key) && (!best || key.length > best.key.length)) {
      best = { key, window };
    }
  }
  return best?.window ?? DEFAULT_CONTEXT_WINDOW;
}

export interface HistoryWindow {
  kept: ChatMessage[];
  dropped: ChatMessage[];
}

/**
 * Keeps as many of the most recent messages as fit under `budgetTokens`,
 * walking backward from the end of `history`. Whatever doesn't fit comes back
 * as `dropped`, in original (oldest-first) order, for Phase 3 to summarize
 * instead of silently discarding.
 */
export function windowHistoryToBudget(
  history: ChatMessage[],
  budgetTokens: number,
  estimateFn: (text: string) => number = estimateTokens
): HistoryWindow {
  if (history.length === 0 || budgetTokens <= 0) {
    return { kept: [], dropped: history.slice() };
  }
  const keptReversed: ChatMessage[] = [];
  let used = 0;
  let i = history.length - 1;
  for (; i >= 0; i--) {
    const cost = estimateFn(history[i].content);
    if (used + cost > budgetTokens && keptReversed.length > 0) {
      break;
    }
    used += cost;
    keptReversed.push(history[i]);
  }
  const kept = keptReversed.reverse();
  const dropped = history.slice(0, i + 1);
  return { kept, dropped };
}
