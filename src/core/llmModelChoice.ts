import { LlmProvider } from '../engine/types';

/**
 * The model each LLM provider uses (v0.52.4). Until now one setting,
 * `activeLlmModel` (default `gpt-4o-mini`), served every provider: the LLM
 * tab copied it into every card, so the Claude Code card showed an OpenAI
 * model, and Copilot had no choice at all. Now each provider has its own
 * entry in `llmModels`; the active provider's is what runs.
 *
 * An empty choice means the provider's own default: Claude Code's configured
 * model, or the first model VS Code offers through Copilot. The old
 * `activeLlmModel` is still honoured where it fits the provider (a person set
 * it explicitly), so nobody's working setup changes on upgrade.
 */

export type LlmModels = Partial<Record<LlmProvider, string>>;

/** When nothing is chosen: the model each provider used before, or its own default (''). */
export const PROVIDER_DEFAULT_MODEL: Readonly<Record<LlmProvider, string>> = {
  copilot: 'gpt-4o-mini',
  claude: '',
  openai: 'gpt-4o-mini',
  'azure-openai': '',
  anthropic: 'claude-sonnet-5-5',
  gemini: 'gemini-1.5-pro',
  ollama: 'llama3'
};

/** Claude Code takes an alias or a full Claude model id (the same rule its adapter applies). */
export const CLAUDE_CODE_MODEL = /^(claude[-\w.]*|sonnet|opus|haiku)([-\w.]*)?$/i;

const FITS: Readonly<Record<LlmProvider, RegExp>> = {
  copilot: /.+/,
  claude: CLAUDE_CODE_MODEL,
  openai: /^(gpt|o\d|chatgpt)/i,
  'azure-openai': /.+/,
  anthropic: /^claude/i,
  gemini: /^gemini/i,
  ollama: /.+/
};

export function fitsProvider(provider: LlmProvider, model: string): boolean {
  return (FITS[provider] ?? /.+/).test(model.trim());
}

/**
 * The model the provider runs: its own choice in `llmModels` (an empty string is a choice: the provider's
 * default), else the old shared setting when a person set it and it fits this provider, else the default.
 */
export function modelFor(provider: LlmProvider, models: LlmModels | undefined, legacy?: { value?: string; explicit: boolean }): string {
  const own = models?.[provider];
  if (typeof own === 'string') return own.trim();
  const old = legacy?.value?.trim();
  if (legacy?.explicit && old && fitsProvider(provider, old)) return old;
  return PROVIDER_DEFAULT_MODEL[provider] ?? '';
}

/** Only known providers and string values survive (the webview's payload is untrusted). */
export function sanitizeModels(raw: unknown): LlmModels | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: LlmModels = {};
  for (const p of Object.keys(PROVIDER_DEFAULT_MODEL) as LlmProvider[]) {
    const v = (raw as Record<string, unknown>)[p];
    if (typeof v === 'string') out[p] = v.trim().slice(0, 200);
  }
  return out;
}
