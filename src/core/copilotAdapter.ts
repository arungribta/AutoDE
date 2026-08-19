import * as vscode from 'vscode';

export interface CopilotModelInfo {
  name: string;
  id: string;
  family: string;
  vendor: string;
  version: string;
  maxInputTokens: number;
}

export interface CopilotInfo {
  found: boolean;
  isActive: boolean;
  hasAccess: boolean;
  canSendRequest: boolean | undefined;
  consentRequired: boolean;
  models: CopilotModelInfo[];
  error?: string;
}

export class CopilotAdapter {
  private constructor(private readonly model: vscode.LanguageModelChat) {}

  public static async detect(context?: vscode.ExtensionContext): Promise<{ info: CopilotInfo; adapter?: CopilotAdapter }> {
    const info: CopilotInfo = {
      found: false,
      isActive: false,
      hasAccess: false,
      canSendRequest: undefined,
      consentRequired: false,
      models: []
    };

    // 1) Check that the Copilot Chat extension is present.
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

    // 2) Verify the Language Model API is available in this VS Code version.
    if (!('lm' in vscode) || typeof (vscode.lm as any)?.selectChatModels !== 'function') {
      info.error = 'Language Model API (vscode.lm) is not available in this VS Code version.';
      return { info };
    }

    // 3) Select chat models provided by the "copilot" vendor.
    let models: vscode.LanguageModelChat[] = [];
    try {
      models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    } catch (err) {
      info.error = err instanceof Error ? err.message : String(err);
      return { info };
    }

    if (models.length === 0) {
      info.error = 'No Copilot language models are available yet. Sign in to GitHub Copilot and try again.';
      return { info };
    }

    info.isActive = true;
    info.hasAccess = true;
    info.models = models.map((model) => ({
      name: model.name,
      id: model.id,
      family: model.family,
      vendor: model.vendor,
      version: model.version,
      maxInputTokens: model.maxInputTokens
    }));

    // Determine whether the model is usable (consent/access gate).
    try {
      const accessInfo = context?.languageModelAccessInformation;
      if (accessInfo && typeof accessInfo.canSendRequest === 'function') {
        info.canSendRequest = accessInfo.canSendRequest(models[0]);
        info.consentRequired = info.canSendRequest !== true;
      }
    } catch (_err) {
      // Non-fatal: leave consentRequired/access unspecified.
    }

    const adapter = new CopilotAdapter(models[0]);
    return { info, adapter };
  }

  public getModel(): vscode.LanguageModelChat {
    return this.model;
  }

  public async complete(
    prompt: string,
    opts?: { model?: string; timeoutMs?: number; cancellationToken?: vscode.CancellationToken }
  ): Promise<string> {
    const timeoutMs = opts?.timeoutMs ?? 30000;
    const model = opts?.model ? await this.selectModel(opts.model) : this.model;

    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const request = model.sendRequest(
      messages,
      { justification: 'Generate structured data-engineering plan JSON used by the Auto Data Engineering Hub extension.' },
      opts?.cancellationToken
    );

    const timeout = new Promise<never>((_resolve, reject) => {
      const id = setTimeout(() => {
        clearTimeout(id);
        reject(new Error('Copilot call timed out'));
      }, timeoutMs);
    });

    const response = await Promise.race([request, timeout]);

    let text = '';
    for await (const part of response.text) {
      text += part;
    }

    if (!text || text.trim().length === 0) {
      throw new Error('Copilot returned an empty response.');
    }
    return text.trim();
  }

  public async testCall(): Promise<{ ok: boolean; text?: string; error?: string }> {
    try {
      const text = await this.complete(
        '/* Copilot test: generate a one-line comment saying hello */\n',
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
    const normalized = (familyOrId || '').trim();

    if (normalized) {
      // Try to match by family first, then by id or name.
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
      const partial = models.find((m) => m.family.includes(normalized) || m.id.includes(normalized));
      if (partial) {
        return partial;
      }
    }

    if (models[0]) {
      return models[0];
    }

    throw new Error('No Copilot language models are available.');
  }
}