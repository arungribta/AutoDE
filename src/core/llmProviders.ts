import { LlmAdapter, LlmAdapterContext, LlmCompleteOptions, extractJsonText } from './llmAdapter';
import { LlmProvider } from './types';

/** Shared consent check for the two providers that run a local model with no API key. */
function requireLocalConsent(ctx: LlmAdapterContext): void {
  const settings = ctx.getSettings();
  const consented = settings.languageModelProgrammaticConsent || settings.copilotProgrammaticConsent;
  if (!consented) {
    throw new Error(
      'Programmatic use of a local language model is not enabled. ' +
      'Open Settings (⚙) → LLM Provider → check "Allow programmatic use" and try again.'
    );
  }
}

class CopilotLlmAdapter implements LlmAdapter {
  readonly id: LlmProvider = 'copilot';
  readonly displayName = 'GitHub Copilot';
  readonly requiresApiKey = false;
  readonly supportsCustomEndpoint = false;

  async complete(prompt: string, opts: LlmCompleteOptions, ctx: LlmAdapterContext): Promise<string> {
    try {
      requireLocalConsent(ctx);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { LanguageModelAdapter } = require('./languageModelAdapter') as typeof import('./languageModelAdapter');
      const { adapter, info } = await LanguageModelAdapter.detect(ctx.getExtensionContext(), { provider: 'copilot', model: opts.model });
      if (!adapter) {
        throw new Error(info.error || 'GitHub Copilot is not available through the VS Code Language Model API.');
      }
      return await adapter.complete(prompt, { model: opts.model, timeoutMs: 60000, systemPrompt: opts.systemPrompt, justification: opts.justification });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`GitHub Copilot request failed: ${message}`);
      throw new Error(message);
    }
  }
}

class ClaudeLlmAdapter implements LlmAdapter {
  readonly id: LlmProvider = 'claude';
  readonly displayName = 'Claude Code';
  readonly requiresApiKey = false;
  readonly supportsCustomEndpoint = false;

  async complete(prompt: string, opts: LlmCompleteOptions, ctx: LlmAdapterContext): Promise<string> {
    try {
      requireLocalConsent(ctx);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ClaudeCodeAdapter } = require('./claudeCodeAdapter') as typeof import('./claudeCodeAdapter');
      const { adapter, info } = await ClaudeCodeAdapter.detect(ctx.getSettings().claudeCodePath);
      if (!adapter) {
        throw new Error(info.error || 'Claude Code CLI is not available.');
      }
      return await adapter.complete(prompt, {
        model: opts.model,
        systemPrompt: opts.systemPrompt,
        allowTools: !!opts.allowTools,
        cwd: ctx.getWorkspaceRoot()
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`Claude Code request failed: ${message}`);
      throw new Error(message);
    }
  }
}

class OpenAiLlmAdapter implements LlmAdapter {
  readonly id: LlmProvider = 'openai';
  readonly displayName = 'OpenAI';
  readonly requiresApiKey = true;
  readonly supportsCustomEndpoint = false;

  async complete(prompt: string, opts: LlmCompleteOptions, ctx: LlmAdapterContext): Promise<string> {
    const apiKey = await ctx.getLlmApiKey();
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('OpenAI API key is missing. Add it in the settings panel.');
    }
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0,
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: prompt }
        ]
      })
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI request failed: ${response.status} ${text}`);
    }
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return extractJsonText(data.choices?.[0]?.message?.content ?? '');
  }
}

class AnthropicLlmAdapter implements LlmAdapter {
  readonly id: LlmProvider = 'anthropic';
  readonly displayName = 'Anthropic';
  readonly requiresApiKey = true;
  readonly supportsCustomEndpoint = false;

  async complete(prompt: string, opts: LlmCompleteOptions, ctx: LlmAdapterContext): Promise<string> {
    const apiKey = await ctx.getLlmApiKey();
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('Anthropic API key is missing. Add it in the settings panel.');
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: opts.model, max_tokens: 4096, temperature: 0, system: opts.systemPrompt, messages: [{ role: 'user', content: prompt }] })
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic request failed: ${response.status} ${text}`);
    }
    const data = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = data.content?.map((part) => (part.type === 'text' ? part.text ?? '' : '')).join('') ?? '';
    return extractJsonText(text);
  }
}

class AzureOpenAiLlmAdapter implements LlmAdapter {
  readonly id: LlmProvider = 'azure-openai';
  readonly displayName = 'Azure OpenAI';
  readonly requiresApiKey = true;
  readonly supportsCustomEndpoint = true;

  async complete(prompt: string, opts: LlmCompleteOptions, ctx: LlmAdapterContext): Promise<string> {
    const apiKey = await ctx.getLlmApiKey();
    const endpoint = ctx.getSettings().llmEndpoint;
    const url = endpoint && endpoint.trim().length > 0
      ? endpoint.trim()
      : `https://<your-resource>.openai.azure.com/openai/deployments/${opts.model}/chat/completions?api-version=2024-02-01`;
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('Azure OpenAI API key is missing. Add it in the settings panel.');
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0,
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: prompt }
        ]
      })
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Azure OpenAI request failed: ${response.status} ${text}`);
    }
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return extractJsonText(data.choices?.[0]?.message?.content ?? '');
  }
}

class GeminiLlmAdapter implements LlmAdapter {
  readonly id: LlmProvider = 'gemini';
  readonly displayName = 'Google Gemini';
  readonly requiresApiKey = true;
  readonly supportsCustomEndpoint = false;

  async complete(prompt: string, opts: LlmCompleteOptions, ctx: LlmAdapterContext): Promise<string> {
    const apiKey = await ctx.getLlmApiKey();
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('Gemini API key is missing. Add it in the settings panel.');
    }
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.systemPrompt }] },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0 }
      })
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gemini request failed: ${response.status} ${text}`);
    }
    const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const content = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    return extractJsonText(content);
  }
}

class OllamaLlmAdapter implements LlmAdapter {
  readonly id: LlmProvider = 'ollama';
  readonly displayName = 'Ollama';
  readonly requiresApiKey = false;
  readonly supportsCustomEndpoint = false;

  async complete(prompt: string, opts: LlmCompleteOptions): Promise<string> {
    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        messages: [
          { role: 'system', content: opts.systemPrompt },
          { role: 'user', content: prompt }
        ],
        format: 'json'
      })
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama request failed: ${response.status} ${text}`);
    }
    const data = (await response.json()) as { message?: { content?: string } };
    return extractJsonText(data.message?.content ?? '');
  }
}

/** The single source of truth for "which LLM providers exist" — add a provider by adding one entry here. */
export const LLM_ADAPTERS: Record<LlmProvider, LlmAdapter> = {
  copilot: new CopilotLlmAdapter(),
  claude: new ClaudeLlmAdapter(),
  openai: new OpenAiLlmAdapter(),
  anthropic: new AnthropicLlmAdapter(),
  'azure-openai': new AzureOpenAiLlmAdapter(),
  gemini: new GeminiLlmAdapter(),
  ollama: new OllamaLlmAdapter()
};

export function getLlmAdapter(provider: LlmProvider): LlmAdapter {
  return LLM_ADAPTERS[provider] ?? LLM_ADAPTERS.ollama;
}
