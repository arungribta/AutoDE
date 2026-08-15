import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { ConfigurationManager } from './configManager';
import { DataAgentHubHub } from './agentHub';
import { WebviewMessage, PlanState, DataAgentHubSettings } from './types';

export class DataAgentHubWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'autoDataEngineeringHubSidebar';

  private view?: vscode.WebviewView;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configManager: ConfigurationManager,
    private readonly hub: DataAgentHubHub
  ) {
    this.hub.setStateListener((state: PlanState) => this.postState(state));
    this.hub.setLogListener((message: string) => this.postLog(message));
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    webviewView.webview.html = this.getHtmlForSidebar(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      await this.handleMessage(message);
    });

    this.postState(this.hub.getPlan());
    this.postMessage('settingsLoaded', this.configManager.getSettings());
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'generatePlan': {
          const objective = typeof message.objective === 'string' ? message.objective : '';
          const schemaContext = typeof message.schemaContext === 'string' ? message.schemaContext : '';
          if (!objective.trim()) {
            this.postLog('A plan requires a user objective.');
            return;
          }
          const plan = await this.hub.generatePlan(objective, schemaContext);
          this.postPlan(plan);
          break;
        }
        case 'executePlan': {
          await this.hub.executePlan();
          break;
        }
        case 'pausePlan': {
          await this.hub.pauseExecution();
          break;
        }
        case 'resetPlan': {
          await this.hub.resetPlan();
          break;
        }
        case 'updateSettings': {
          const settings = (message.settings ?? {}) as Partial<DataAgentHubSettings>;
          const typedSettings: Partial<DataAgentHubSettings> = {
            defaultSnowflakeAccount: typeof settings.defaultSnowflakeAccount === 'string' ? settings.defaultSnowflakeAccount : undefined,
            defaultSnowflakeWarehouse: typeof settings.defaultSnowflakeWarehouse === 'string' ? settings.defaultSnowflakeWarehouse : undefined,
            defaultSnowflakeDatabase: typeof settings.defaultSnowflakeDatabase === 'string' ? settings.defaultSnowflakeDatabase : undefined,
            defaultSnowflakeSchema: typeof settings.defaultSnowflakeSchema === 'string' ? settings.defaultSnowflakeSchema : undefined,
            defaultSnowflakeRole: typeof settings.defaultSnowflakeRole === 'string' ? settings.defaultSnowflakeRole : undefined,
            activeLlmProvider: settings.activeLlmProvider === 'anthropic' || settings.activeLlmProvider === 'ollama' || settings.activeLlmProvider === 'openai' ? settings.activeLlmProvider : undefined,
            activeLlmModel: typeof settings.activeLlmModel === 'string' ? settings.activeLlmModel : undefined
          };

          await this.configManager.updateSettings(typedSettings);

          const llmApiKey = typeof message.llmApiKey === 'string' ? message.llmApiKey : '';
          if (typeof message.llmApiKey === 'string') {
            await this.configManager.setLlmApiKey(llmApiKey);
          }

          const snowflakePassword = typeof message.snowflakePassword === 'string' ? message.snowflakePassword : '';
          if (typeof message.snowflakePassword === 'string') {
            await this.configManager.setSnowflakePassword(snowflakePassword);
          }

          this.postMessage('settingsSaved', { success: true });
          this.postLog('Settings saved securely to VS Code secrets.');
          break;
        }
        default:
          this.postLog(`Unknown message type: ${String(message.type)}`);
          break;
      }
    } catch (error) {
      const observed = error instanceof Error ? error.message : 'Unexpected webview error.';
      this.postLog(`Webview error: ${observed}`);
      this.postMessage('error', { message: observed });
    }
  }

  private postState(state: PlanState): void {
    this.view?.webview.postMessage({
      type: 'stateUpdate',
      state
    });
  }

  private postPlan(plan: unknown): void {
    this.view?.webview.postMessage({
      type: 'planUpdated',
      plan
    });
  }

  private postLog(message: string): void {
    this.view?.webview.postMessage({
      type: 'logEntry',
      message
    });
  }

  private postMessage(type: string, payload: object = {}): void {
    const recordPayload = payload as Record<string, unknown>;
    this.view?.webview.postMessage({
      type,
      ...recordPayload
    });
  }

  private getHtmlForSidebar(webview: vscode.Webview): string {
    const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sidebar.html');
    return fs.readFileSync(htmlPath.fsPath, 'utf8');
  }
}
