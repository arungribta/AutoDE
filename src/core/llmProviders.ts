import * as vscode from 'vscode';
import { LlmAdapter, LlmAdapterContext, LlmCompleteOptions, LlmHistoryTurn, extractJsonText } from './llmAdapter';
import { LlmProvider, ToolCallAuditEntry, ToolExecutionMode } from './types';
import { AgenticToolCall, JsonSchemaToolSpec, READ_ONLY_TOOL_SPECS, WRITE_TOOL_SPECS, executeAgenticTool } from './agenticTools';

const MAX_TOOL_LOOP_TURNS = 12;

/** Read-only tools for `'read-only'`, read-only + write/exec for `'full'`, none otherwise. */
function toolSpecsForMode(mode: ToolExecutionMode | undefined): JsonSchemaToolSpec[] {
  if (mode === 'full') { return [...READ_ONLY_TOOL_SPECS, ...WRITE_TOOL_SPECS]; }
  if (mode === 'read-only') { return READ_ONLY_TOOL_SPECS; }
  return [];
}

interface OpenAiStyleToolCall {
  id?: string;
  function: { name: string; arguments: string | Record<string, unknown> };
}

interface OpenAiStyleMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAiStyleToolCall[];
  tool_call_id?: string;
}

/**
 * Shared tool-calling loop for the OpenAI Chat Completions `tools` shape
 * (OpenAI, Azure OpenAI, and Ollama's `/api/chat` all use a compatible
 * request/response shape). Each adapter supplies its own `sendChat` that
 * knows the endpoint/headers/model, and gets back the finished text.
 */
function historyToOpenAiStyle(history?: LlmHistoryTurn[]): OpenAiStyleMessage[] {
  return (history ?? []).map((turn) => ({ role: turn.role, content: turn.content }));
}

async function runOpenAiStyleToolLoop(
  systemPrompt: string,
  userPrompt: string,
  mode: ToolExecutionMode,
  workspaceRoot: string | undefined,
  history: LlmHistoryTurn[] | undefined,
  sendChat: (messages: OpenAiStyleMessage[], tools: unknown[]) => Promise<{ content?: string | null; tool_calls?: OpenAiStyleToolCall[] }>
): Promise<string> {
  const toolSpecs = toolSpecsForMode(mode);
  if (toolSpecs.length === 0) {
    const message = await sendChat(
      [{ role: 'system', content: systemPrompt }, ...historyToOpenAiStyle(history), { role: 'user', content: userPrompt }],
      []
    );
    return extractJsonText(message.content ?? '');
  }
  if (!workspaceRoot) {
    throw new Error('A workspace folder is required for tool execution.');
  }

  const tools = toolSpecs.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const messages: OpenAiStyleMessage[] = [
    { role: 'system', content: systemPrompt },
    ...historyToOpenAiStyle(history),
    { role: 'user', content: userPrompt }
  ];
  const audit: ToolCallAuditEntry[] = [];

  for (let turn = 0; turn < MAX_TOOL_LOOP_TURNS; turn++) {
    const message = await sendChat(messages, tools);
    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return extractJsonText(message.content ?? '');
    }
    messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: toolCalls });
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      const id = call.id ?? `call-${turn}-${i}`;
      let input: Record<string, unknown> = {};
      if (typeof call.function.arguments === 'string') {
        try { input = JSON.parse(call.function.arguments || '{}'); } catch { /* leave empty on malformed JSON */ }
      } else {
        input = call.function.arguments ?? {};
      }
      const toolCall: AgenticToolCall = { id, name: call.function.name, input };
      const output = await executeAgenticTool(toolCall, workspaceRoot, audit);
      messages.push({ role: 'tool', tool_call_id: id, content: output });
    }
  }
  throw new Error('Tool loop exceeded the maximum number of turns without a final answer.');
}

/**
 * `fetch()` has no built-in timeout — an unreachable endpoint (a placeholder Azure OpenAI
 * hostname, a corporate proxy that swallows the request, a local Ollama server that isn't
 * running) hangs the request forever with zero feedback to the user, indistinguishable from
 * a slow-but-working call. Every fetch-based adapter below routes through this so a bad
 * endpoint fails with a clear, bounded error instead of hanging the whole plan/spec generation.
 */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 45000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

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
  readonly supportsToolExecution = true;

  async complete(prompt: string, opts: LlmCompleteOptions, ctx: LlmAdapterContext): Promise<string> {
    try {
      requireLocalConsent(ctx);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { LanguageModelAdapter } = require('./languageModelAdapter') as typeof import('./languageModelAdapter');
      const { adapter, info } = await LanguageModelAdapter.detect(ctx.getExtensionContext(), { provider: 'copilot', model: opts.model });
      if (!adapter) {
        throw new Error(info.error || 'GitHub Copilot is not available through the VS Code Language Model API.');
      }
      const mode = opts.toolExecutionMode ?? 'none';
      if (mode === 'none') {
        return await adapter.complete(prompt, { model: opts.model, timeoutMs: 60000, systemPrompt: opts.systemPrompt, justification: opts.justification, history: opts.history });
      }
      const result = await adapter.completeWithTools(prompt, { model: opts.model, systemPrompt: opts.systemPrompt, justification: opts.justification, mode, workspaceRoot: ctx.getWorkspaceRoot(), history: opts.history });
      return result.text;
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
  readonly supportsToolExecution = true;

  async complete(prompt: string, opts: LlmCompleteOptions, ctx: LlmAdapterContext): Promise<string> {
    try {
      requireLocalConsent(ctx);
      const mode: ToolExecutionMode = opts.toolExecutionMode ?? 'none';
      if (mode === 'full') {
        const proceed = await vscode.window.showWarningMessage(
          'Allow the assistant to write files and run commands in this workspace for this request? Claude Code will ask again only once per request, not per file.',
          { modal: true },
          'Allow'
        );
        if (proceed !== 'Allow') {
          throw new Error('File write / command access was not approved.');
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ClaudeCodeAdapter } = require('./claudeCodeAdapter') as typeof import('./claudeCodeAdapter');
      const { adapter, info } = await ClaudeCodeAdapter.detect(ctx.getSettings().claudeCodePath);
      if (!adapter) {
        throw new Error(info.error || 'Claude Code CLI is not available.');
      }
      return await adapter.complete(prompt, {
        model: opts.model,
        systemPrompt: opts.systemPrompt,
        toolMode: mode,
        cwd: ctx.getWorkspaceRoot(),
        sessionId: opts.claudeSessionId,
        isNewSession: opts.isNewClaudeSession
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
  readonly supportsToolExecution = true;

  async complete(prompt: string, opts: LlmCompleteOptions, ctx: LlmAdapterContext): Promise<string> {
    const apiKey = await ctx.getLlmApiKey();
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('OpenAI API key is missing. Add it in the settings panel.');
    }
    return runOpenAiStyleToolLoop(opts.systemPrompt, prompt, opts.toolExecutionMode ?? 'none', ctx.getWorkspaceRoot(), opts.history, async (messages, tools) => {
      const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: opts.model, temperature: 0, messages, ...(tools.length > 0 ? { tools } : {}) })
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI request failed: ${response.status} ${text}`);
      }
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: OpenAiStyleToolCall[] } }> };
      return data.choices?.[0]?.message ?? {};
    });
  }
}

class AnthropicLlmAdapter implements LlmAdapter {
  readonly id: LlmProvider = 'anthropic';
  readonly displayName = 'Anthropic';
  readonly requiresApiKey = true;
  readonly supportsCustomEndpoint = false;
  readonly supportsToolExecution = true;

  async complete(prompt: string, opts: LlmCompleteOptions, ctx: LlmAdapterContext): Promise<string> {
    const apiKey = await ctx.getLlmApiKey();
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('Anthropic API key is missing. Add it in the settings panel.');
    }

    const toolSpecs = toolSpecsForMode(opts.toolExecutionMode);
    const tools = toolSpecs.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    const workspaceRoot = ctx.getWorkspaceRoot();
    if (toolSpecs.length > 0 && !workspaceRoot) {
      throw new Error('A workspace folder is required for tool execution.');
    }

    type AnthropicBlock = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: string };
    const messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicBlock[] }> = [
      ...(opts.history ?? []).map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user' as const, content: prompt }
    ];
    const audit: ToolCallAuditEntry[] = [];

    for (let turn = 0; turn < MAX_TOOL_LOOP_TURNS; turn++) {
      const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: opts.model, max_tokens: 4096, temperature: 0, system: opts.systemPrompt, messages,
          ...(tools.length > 0 ? { tools } : {})
        })
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Anthropic request failed: ${response.status} ${text}`);
      }
      const data = (await response.json()) as { content?: AnthropicBlock[] };
      const blocks = data.content ?? [];
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      if (toolUses.length === 0) {
        return extractJsonText(text);
      }
      messages.push({ role: 'assistant', content: blocks });
      const resultBlocks: AnthropicBlock[] = [];
      for (const tu of toolUses) {
        const output = await executeAgenticTool({ id: tu.id ?? tu.name ?? 'tool', name: tu.name ?? '', input: tu.input ?? {} }, workspaceRoot!, audit);
        resultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: output });
      }
      messages.push({ role: 'user', content: resultBlocks });
    }
    throw new Error('Tool loop exceeded the maximum number of turns without a final answer.');
  }
}

class AzureOpenAiLlmAdapter implements LlmAdapter {
  readonly id: LlmProvider = 'azure-openai';
  readonly displayName = 'Azure OpenAI';
  readonly requiresApiKey = true;
  readonly supportsCustomEndpoint = true;
  readonly supportsToolExecution = true;

  async complete(prompt: string, opts: LlmCompleteOptions, ctx: LlmAdapterContext): Promise<string> {
    const apiKey = await ctx.getLlmApiKey();
    const endpoint = ctx.getSettings().llmEndpoint;
    const url = endpoint && endpoint.trim().length > 0
      ? endpoint.trim()
      : `https://<your-resource>.openai.azure.com/openai/deployments/${opts.model}/chat/completions?api-version=2024-02-01`;
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('Azure OpenAI API key is missing. Add it in the settings panel.');
    }
    return runOpenAiStyleToolLoop(opts.systemPrompt, prompt, opts.toolExecutionMode ?? 'none', ctx.getWorkspaceRoot(), opts.history, async (messages, tools) => {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify({ model: opts.model, temperature: 0, messages, ...(tools.length > 0 ? { tools } : {}) })
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Azure OpenAI request failed: ${response.status} ${text}`);
      }
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: OpenAiStyleToolCall[] } }> };
      return data.choices?.[0]?.message ?? {};
    });
  }
}

class GeminiLlmAdapter implements LlmAdapter {
  readonly id: LlmProvider = 'gemini';
  readonly displayName = 'Google Gemini';
  readonly requiresApiKey = true;
  readonly supportsCustomEndpoint = false;
  readonly supportsToolExecution = true;

  async complete(prompt: string, opts: LlmCompleteOptions, ctx: LlmAdapterContext): Promise<string> {
    const apiKey = await ctx.getLlmApiKey();
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('Gemini API key is missing. Add it in the settings panel.');
    }

    const toolSpecs = toolSpecsForMode(opts.toolExecutionMode);
    const tools = toolSpecs.length > 0 ? [{ functionDeclarations: toolSpecs.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }] : undefined;
    const workspaceRoot = ctx.getWorkspaceRoot();
    if (toolSpecs.length > 0 && !workspaceRoot) {
      throw new Error('A workspace folder is required for tool execution.');
    }

    type GeminiPart = { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; functionResponse?: { name: string; response: { result: string } } };
    const contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = [
      ...(opts.history ?? []).map((turn) => ({ role: (turn.role === 'assistant' ? 'model' : 'user') as 'user' | 'model', parts: [{ text: turn.content }] })),
      { role: 'user', parts: [{ text: prompt }] }
    ];
    const audit: ToolCallAuditEntry[] = [];

    for (let turn = 0; turn < MAX_TOOL_LOOP_TURNS; turn++) {
      const response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: opts.systemPrompt }] },
          contents,
          generationConfig: { temperature: 0 },
          ...(tools ? { tools } : {})
        })
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gemini request failed: ${response.status} ${text}`);
      }
      const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> };
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const funcCalls = parts.filter((p) => p.functionCall);
      const text = parts.filter((p) => p.text).map((p) => p.text ?? '').join('');
      if (funcCalls.length === 0) {
        return extractJsonText(text);
      }
      contents.push({ role: 'model', parts });
      const responseParts: GeminiPart[] = [];
      for (const p of funcCalls) {
        const call = p.functionCall!;
        const output = await executeAgenticTool({ id: call.name, name: call.name, input: call.args ?? {} }, workspaceRoot!, audit);
        responseParts.push({ functionResponse: { name: call.name, response: { result: output } } });
      }
      contents.push({ role: 'user', parts: responseParts });
    }
    throw new Error('Tool loop exceeded the maximum number of turns without a final answer.');
  }
}

class OllamaLlmAdapter implements LlmAdapter {
  readonly id: LlmProvider = 'ollama';
  readonly displayName = 'Ollama';
  readonly requiresApiKey = false;
  readonly supportsCustomEndpoint = false;
  /** Best-effort: tool-calling support depends on the local model (e.g. llama3.1, qwen2.5
   *  support it; many others silently ignore `tools` and just answer in prose — that
   *  degrades gracefully rather than failing the request). */
  readonly supportsToolExecution = true;

  async complete(prompt: string, opts: LlmCompleteOptions, ctx: LlmAdapterContext): Promise<string> {
    const mode = opts.toolExecutionMode ?? 'none';
    if (mode === 'none') {
      const response = await fetchWithTimeout('http://localhost:11434/api/chat', {
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

    return runOpenAiStyleToolLoop(opts.systemPrompt, prompt, mode, ctx.getWorkspaceRoot(), opts.history, async (messages, tools) => {
      const response = await fetchWithTimeout('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: opts.model, stream: false, messages, ...(tools.length > 0 ? { tools } : {}) })
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Ollama request failed: ${response.status} ${text}`);
      }
      const data = (await response.json()) as { message?: { content?: string | null; tool_calls?: OpenAiStyleToolCall[] } };
      return data.message ?? {};
    });
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
