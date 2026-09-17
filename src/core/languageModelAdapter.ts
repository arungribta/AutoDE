import * as vscode from 'vscode';
import { ToolCallAuditEntry, ToolExecutionMode } from './types';
import { AgenticToolCall, READ_ONLY_TOOL_SPECS, WRITE_TOOL_SPECS, executeAgenticTool } from './agenticTools';
import { LlmHistoryTurn } from './llmAdapter';

const MAX_TOOL_LOOP_TURNS = 12;

/** Real alternating User/Assistant messages for prior turns — `vscode.lm` has no distinct
 *  "history" concept, just a message array, so this is the whole of the wiring. */
function buildHistoryMessages(history?: LlmHistoryTurn[]): vscode.LanguageModelChatMessage[] {
  if (!history || history.length === 0) { return []; }
  return history.map((turn) =>
    turn.role === 'user' ? vscode.LanguageModelChatMessage.User(turn.content) : vscode.LanguageModelChatMessage.Assistant(turn.content)
  );
}

/**
 * Which vendor family this adapter targets. Today only GitHub Copilot is served
 * through the VS Code Language Model API (`vscode.lm`); Claude is handled
 * separately by `claudeCodeAdapter.ts` (the Claude Code CLI). The enum is kept
 * so a future first-party Claude `vscode.lm` provider can be slotted in.
 */
export type LanguageModelProviderKind = 'copilot';

export interface LanguageModelInfo {
  provider: LanguageModelProviderKind;
  found: boolean;
  isActive: boolean;
  hasAccess: boolean;
  canSendRequest: boolean | undefined;
  consentRequired: boolean;
  models: LanguageModelDescriptor[];
  /** Distinct `vscode.lm` vendor ids that matched (e.g. `copilot`). */
  vendors: string[];
  error?: string;
}

export interface LanguageModelDescriptor {
  name: string;
  id: string;
  family: string;
  vendor: string;
  version: string;
  maxInputTokens: number;
}

/** Back-compat alias — earlier code and tests referenced `CopilotModelInfo`. */
export type CopilotModelInfo = LanguageModelDescriptor;
/** Back-compat alias — earlier code and tests referenced `CopilotInfo`. */
export type CopilotInfo = LanguageModelInfo;

/**
 * Thin wrapper over the VS Code Language Model API (`vscode.lm`) that lets AutoDE
 * route LLM calls to GitHub Copilot without an API key.
 */
export class LanguageModelAdapter {
  private constructor(private readonly model: vscode.LanguageModelChat) {}

  /**
   * List every chat model currently exposed through `vscode.lm`, across all
   * vendors. Used by the `listLanguageModels` command so users can see exactly
   * what is available (Claude typically shows up under vendor `copilot`, which
   * is why the `claude` provider uses the Claude Code CLI instead).
   */
  public static async listAll(): Promise<LanguageModelDescriptor[]> {
    if (!('lm' in vscode) || typeof (vscode.lm as any)?.selectChatModels !== 'function') {
      return [];
    }
    let models: vscode.LanguageModelChat[] = [];
    try {
      models = await vscode.lm.selectChatModels();
    } catch {
      return [];
    }
    return models.map((model) => ({
      name: model.name,
      id: model.id,
      family: model.family,
      vendor: model.vendor,
      version: model.version,
      maxInputTokens: model.maxInputTokens
    }));
  }

  public static async detect(
    context?: vscode.ExtensionContext,
    opts?: { provider?: LanguageModelProviderKind; model?: string }
  ): Promise<{ info: LanguageModelInfo; adapter?: LanguageModelAdapter }> {
    void opts?.provider; // only 'copilot' today
    const info: LanguageModelInfo = {
      provider: 'copilot',
      found: false,
      isActive: false,
      hasAccess: false,
      canSendRequest: undefined,
      consentRequired: false,
      models: [],
      vendors: []
    };

    const chatExt =
      vscode.extensions.getExtension('github.copilot-chat') ??
      vscode.extensions.getExtension('GitHub.copilot-chat') ??
      vscode.extensions.getExtension('github.copilot-chat-nightly') ??
      vscode.extensions.getExtension('GitHub.copilot-chat-nightly');
    if (!chatExt) {
      info.error = 'github.copilot-chat is not installed.';
      return { info };
    }
    info.found = true;

    if (!('lm' in vscode) || typeof (vscode.lm as any)?.selectChatModels !== 'function') {
      info.error = 'Language Model API (vscode.lm) is not available in this VS Code version.';
      return { info };
    }

    let candidates: vscode.LanguageModelChat[] = [];
    try {
      candidates = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    } catch (err) {
      info.error = err instanceof Error ? err.message : String(err);
      return { info };
    }

    if (candidates.length === 0) {
      info.error = 'No Copilot language models are available yet. Sign in to GitHub Copilot and try again.';
      return { info };
    }

    info.isActive = true;
    info.hasAccess = true;
    info.models = candidates.map((model) => ({
      name: model.name,
      id: model.id,
      family: model.family,
      vendor: model.vendor,
      version: model.version,
      maxInputTokens: model.maxInputTokens
    }));
    info.vendors = Array.from(new Set(candidates.map((m) => m.vendor)));

    const preferred = pickPreferred(candidates, opts?.model);

    try {
      const accessInfo = context?.languageModelAccessInformation;
      if (accessInfo && typeof accessInfo.canSendRequest === 'function') {
        info.canSendRequest = accessInfo.canSendRequest(preferred);
        info.consentRequired = info.canSendRequest !== true;
      }
    } catch (_err) {
      // Non-fatal.
    }

    return { info, adapter: new LanguageModelAdapter(preferred) };
  }

  public getModel(): vscode.LanguageModelChat {
    return this.model;
  }

  public async complete(
    prompt: string,
    opts?: {
      model?: string;
      timeoutMs?: number;
      systemPrompt?: string;
      justification?: string;
      history?: LlmHistoryTurn[];
      cancellationToken?: vscode.CancellationToken;
    }
  ): Promise<string> {
    const timeoutMs = opts?.timeoutMs ?? 30000;
    const model = opts?.model ? await this.selectModel(opts.model) : this.model;

    // The Language Model API has no "system" role. Per the VS Code guidance,
    // system-style instructions are supplied as a leading Assistant message.
    const messages: vscode.LanguageModelChatMessage[] = [];
    if (opts?.systemPrompt && opts.systemPrompt.trim().length > 0) {
      messages.push(vscode.LanguageModelChatMessage.Assistant(opts.systemPrompt.trim()));
    }
    messages.push(...buildHistoryMessages(opts?.history));
    messages.push(vscode.LanguageModelChatMessage.User(prompt));

    const request = model.sendRequest(
      messages,
      {
        justification:
          opts?.justification ??
          'Generate structured data-engineering output used by the Auto Data Engineering Hub extension.'
      },
      opts?.cancellationToken
    );

    const timeout = new Promise<never>((_resolve, reject) => {
      const id = setTimeout(() => {
        clearTimeout(id);
        reject(new Error('Language model call timed out'));
      }, timeoutMs);
    });

    const response = await Promise.race([request, timeout]);

    let text = '';
    for await (const part of response.text) {
      text += part;
    }

    if (!text || text.trim().length === 0) {
      throw new Error('The language model returned an empty response.');
    }
    return text.trim();
  }

  /**
   * Like `complete()`, but runs an AutoDE-owned tool-calling loop using `vscode.lm`'s
   * native tool API (`LanguageModelChatRequestOptions.tools`,
   * `LanguageModelToolCallPart`/`LanguageModelToolResultPart`) — this is what lets
   * a Copilot-backed chat actually read (and, in `'full'` mode, write) files, unlike
   * plain `complete()` which is pure text-in/text-out. Generalized from the loop
   * `ToolSkillAgent.runOnCopilot` originally built for Phase D tool-executing Skills.
   */
  public async completeWithTools(
    prompt: string,
    opts: {
      model?: string;
      systemPrompt?: string;
      justification?: string;
      mode: ToolExecutionMode;
      workspaceRoot?: string;
      history?: LlmHistoryTurn[];
      cancellationToken?: vscode.CancellationToken;
    }
  ): Promise<{ text: string; audit: ToolCallAuditEntry[] }> {
    if (opts.mode === 'none') {
      const text = await this.complete(prompt, { model: opts.model, systemPrompt: opts.systemPrompt, justification: opts.justification, history: opts.history, cancellationToken: opts.cancellationToken });
      return { text, audit: [] };
    }
    if (!opts.workspaceRoot) {
      throw new Error('A workspace folder is required for tool execution.');
    }
    const workspaceRoot = opts.workspaceRoot;
    const model = opts.model ? await this.selectModel(opts.model) : this.model;

    const toolSpecs = opts.mode === 'full' ? [...READ_ONLY_TOOL_SPECS, ...WRITE_TOOL_SPECS] : READ_ONLY_TOOL_SPECS;
    const tools: vscode.LanguageModelChatTool[] = toolSpecs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));

    const messages: vscode.LanguageModelChatMessage[] = [];
    if (opts.systemPrompt && opts.systemPrompt.trim().length > 0) {
      messages.push(vscode.LanguageModelChatMessage.Assistant(opts.systemPrompt.trim()));
    }
    messages.push(...buildHistoryMessages(opts.history));
    messages.push(vscode.LanguageModelChatMessage.User(prompt));

    const audit: ToolCallAuditEntry[] = [];
    let finalText = '';

    for (let turn = 0; turn < MAX_TOOL_LOOP_TURNS; turn++) {
      const response = await model.sendRequest(
        messages,
        { justification: opts.justification ?? 'Answer a data engineering question in the Auto Data Engineering Hub sidebar chat.', tools },
        opts.cancellationToken
      );

      const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
      const toolCalls: vscode.LanguageModelToolCallPart[] = [];
      let turnText = '';
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(part);
          assistantParts.push(part);
        } else if (part instanceof vscode.LanguageModelTextPart) {
          turnText += part.value;
          assistantParts.push(part);
        }
      }
      finalText += turnText;

      if (toolCalls.length === 0) {
        break;
      }

      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
      const resultParts: vscode.LanguageModelToolResultPart[] = [];
      for (const call of toolCalls) {
        const toolCall: AgenticToolCall = { id: call.callId, name: call.name, input: (call.input ?? {}) as Record<string, unknown> };
        const outcome = await executeAgenticTool(toolCall, workspaceRoot, audit);
        resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(outcome)]));
      }
      messages.push(vscode.LanguageModelChatMessage.User(resultParts));
    }

    if (!finalText.trim() && audit.length === 0) {
      throw new Error('The language model returned an empty response.');
    }
    return { text: finalText.trim(), audit };
  }

  public async testCall(): Promise<{ ok: boolean; text?: string; error?: string }> {
    try {
      const text = await this.complete(
        '/* AutoDE language model test: generate a one-line comment saying hello */\n',
        { timeoutMs: 20000 }
      );
      return { ok: true, text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  private async selectModel(familyOrId: string): Promise<vscode.LanguageModelChat> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    const chosen = pickPreferred(models, familyOrId);
    if (chosen) {
      return chosen;
    }
    throw new Error('No Copilot language models are available.');
  }
}

function pickPreferred(
  models: vscode.LanguageModelChat[],
  familyOrId?: string
): vscode.LanguageModelChat {
  const normalized = (familyOrId || '').trim();
  if (normalized) {
    const exactFamily = models.find((m) => m.family === normalized);
    if (exactFamily) {
      return exactFamily;
    }
    const byId = models.find((m) => m.id === normalized);
    if (byId) {
      return byId;
    }
    const byName = models.find((m) => m.name === normalized);
    if (byName) {
      return byName;
    }
    const partial = models.find(
      (m) => m.family.includes(normalized) || m.id.includes(normalized)
    );
    if (partial) {
      return partial;
    }
  }
  return models[0];
}

/**
 * Back-compat alias. Earlier code (and `test/functional.test.cjs`) imported
 * `CopilotAdapter` from `./copilotAdapter`. The alias keeps those call sites
 * working.
 */
export const CopilotAdapter = LanguageModelAdapter;
export type CopilotAdapter = LanguageModelAdapter;
