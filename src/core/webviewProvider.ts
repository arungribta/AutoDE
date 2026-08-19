import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { ConfigurationManager } from './configManager';
import { DataAgentHubHub } from './agentHub';
import { WebviewMessage, PlanState, DataAgentHubSettings } from './types';
import { EXTENSION_ID } from './extensionIdentity';
import { GraphManager } from '../context/GraphManager';
import { ContextFileManager } from '../context/ContextFileManager';

export class DataAgentHubWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'autoDataEngineeringHubSidebar';

  private view?: vscode.WebviewView;
  private graphManager: GraphManager;
  private contextFileManager?: ContextFileManager;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configManager: ConfigurationManager,
    private readonly hub: DataAgentHubHub
  ) {
    this.hub.setStateListener((state: PlanState) => this.postState(state));
    this.hub.setLogListener((message: string) => this.postLog(message));
    this.graphManager = new GraphManager();
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
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

    // Initialize context layer
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri;
    this.contextFileManager = new ContextFileManager(
      workspaceRoot,
      this.graphManager,
      (msg: string) => this.postLog(msg)
    );
    try {
      await this.contextFileManager.initialize();
      this.postContextUpdate();
    } catch (err) {
      this.postLog(`Context initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Detect Copilot and include status in settings payload
    try {
      // lazy import to avoid cycles and keep activation lightweight
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { CopilotAdapter } = require('./copilotAdapter') as typeof import('./copilotAdapter');
      const { info } = await CopilotAdapter.detect(this.context);
      const settings = this.configManager.getSettings();
      const merged = Object.assign({}, settings, { copilotInfo: info });
      this.postMessage('settingsLoaded', merged);
    } catch (err) {
      // fallback to sending settings only
      this.postMessage('settingsLoaded', this.configManager.getSettings());
    }
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'chat': {
          const chatMessage = typeof message.message === 'string' ? message.message : '';
          const schemaContext = typeof message.schemaContext === 'string' ? message.schemaContext : '';
          if (!chatMessage.trim()) {
            this.postLog('A message is required.');
            return;
          }
          try {
            const response = await this.hub.chat(chatMessage, schemaContext);
            this.postMessage('chatResponse', { message: response });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.postMessage('chatResponse', { message: errMsg, error: true });
          }
          break;
        }
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
            extensionDisplayName: typeof settings.extensionDisplayName === 'string' ? settings.extensionDisplayName : undefined,
            extensionDescription: typeof settings.extensionDescription === 'string' ? settings.extensionDescription : undefined,
            defaultProvider: settings.defaultProvider === 'snowflake' || settings.defaultProvider === 'databricks' || settings.defaultProvider === 'bigquery' || settings.defaultProvider === 'redshift' || settings.defaultProvider === 'synapse' || settings.defaultProvider === 'other' ? settings.defaultProvider : undefined,
            defaultSnowflakeAccount: typeof settings.defaultSnowflakeAccount === 'string' ? settings.defaultSnowflakeAccount : undefined,
            defaultSnowflakeUsername: typeof settings.defaultSnowflakeUsername === 'string' ? settings.defaultSnowflakeUsername : undefined,
            defaultSnowflakeWarehouse: typeof settings.defaultSnowflakeWarehouse === 'string' ? settings.defaultSnowflakeWarehouse : undefined,
            defaultSnowflakeDatabase: typeof settings.defaultSnowflakeDatabase === 'string' ? settings.defaultSnowflakeDatabase : undefined,
            defaultSnowflakeSchema: typeof settings.defaultSnowflakeSchema === 'string' ? settings.defaultSnowflakeSchema : undefined,
            defaultSnowflakeRole: typeof settings.defaultSnowflakeRole === 'string' ? settings.defaultSnowflakeRole : undefined,
            defaultSnowflakeAuthMode: settings.defaultSnowflakeAuthMode === 'username-password' || settings.defaultSnowflakeAuthMode === 'oauth' || settings.defaultSnowflakeAuthMode === 'key-pair' || settings.defaultSnowflakeAuthMode === 'external-browser' || settings.defaultSnowflakeAuthMode === 'mcp' ? settings.defaultSnowflakeAuthMode : undefined,
            snowflakePrivateKeyPath: typeof settings.snowflakePrivateKeyPath === 'string' ? settings.snowflakePrivateKeyPath : undefined,
            metadataCachingDurationMinutes: typeof settings.metadataCachingDurationMinutes === 'number' ? settings.metadataCachingDurationMinutes : undefined,
            queryTimeoutSeconds: typeof settings.queryTimeoutSeconds === 'number' ? settings.queryTimeoutSeconds : undefined,
            readOnlyMode: typeof settings.readOnlyMode === 'boolean' ? settings.readOnlyMode : undefined,
            enableSessionReuse: typeof settings.enableSessionReuse === 'boolean' ? settings.enableSessionReuse : undefined,
            autoDocumentationEnabled: typeof settings.autoDocumentationEnabled === 'boolean' ? settings.autoDocumentationEnabled : undefined,
            telemetryEnabled: typeof settings.telemetryEnabled === 'boolean' ? settings.telemetryEnabled : undefined,
            activeLlmProvider: settings.activeLlmProvider === 'azure-openai' || settings.activeLlmProvider === 'openai' || settings.activeLlmProvider === 'anthropic' || settings.activeLlmProvider === 'gemini' || settings.activeLlmProvider === 'ollama' || settings.activeLlmProvider === 'copilot' ? settings.activeLlmProvider : undefined,
            activeLlmModel: typeof settings.activeLlmModel === 'string' ? settings.activeLlmModel : undefined,
          llmEndpoint: typeof settings.llmEndpoint === 'string' ? settings.llmEndpoint : undefined,
          copilotProgrammaticConsent: typeof settings.copilotProgrammaticConsent === 'boolean' ? settings.copilotProgrammaticConsent : undefined
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

          const snowflakePrivateKeyPassphrase = typeof message.snowflakePrivateKeyPassphrase === 'string' ? message.snowflakePrivateKeyPassphrase : '';
          if (typeof message.snowflakePrivateKeyPassphrase === 'string') {
            await this.configManager.setSnowflakePrivateKeyPassphrase(snowflakePrivateKeyPassphrase);
          }
 
          this.postMessage('settingsSaved', { success: true });
          this.postLog('Settings saved securely to VS Code secrets.');
          break;
        }
        case 'testCopilot': {
          // Proxy to the registered command which performs a best-effort programmatic test
          try {
            await vscode.commands.executeCommand(`${EXTENSION_ID}.testCopilot`);
          } catch (e) {
            this.postLog('Failed to execute Copilot test command.');
          }
          break;
        }
        case 'openCopilotHandoff': {
          try {
            const prompt = typeof (message.prompt) === 'string' ? message.prompt : undefined;
            await vscode.commands.executeCommand(`${EXTENSION_ID}.copilotHandoff`, prompt);
          } catch (e) {
            this.postLog('Failed to open Copilot handoff editor.');
          }
          break;
        }
        case 'reindex': {
          this.postLog('Re-index requested from webview. Triggering context rebuild...');
          try {
            await vscode.commands.executeCommand(`${EXTENSION_ID}.reindex`);
          } catch (e) {
            this.postLog('Re-index command not yet registered. This will be wired in a future phase.');
          }
          break;
        }
        case 'openContextFolder': {
          const contextUri = vscode.Uri.joinPath(
            vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri,
            '.ai-context'
          );
          try {
            await vscode.commands.executeCommand('revealFileInOS', contextUri);
          } catch {
            // Fallback: open the folder in the explorer
            await vscode.commands.executeCommand('workbench.files.action.showActiveFileInExplorer');
          }
          break;
        }
        case 'testConnection': {
          this.postLog('Connecting to database...');
          try {
            await vscode.commands.executeCommand(`${EXTENSION_ID}.testConnection`);
          } catch (e) {
            this.postLog('Connect command not yet registered. This will be wired in a future phase.');
          }
          break;
        }
        case 'sourceAssessment': {
          this.postLog('Running source assessment — building context layer...');
          try {
            // Re-initialize the context file manager to pick up any new files
            if (this.contextFileManager) {
              const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri;
              // Re-create to force a full reload
              this.contextFileManager.dispose();
              this.contextFileManager = new ContextFileManager(
                workspaceRoot,
                this.graphManager,
                (msg: string) => this.postLog(msg)
              );
              await this.contextFileManager.initialize();
              this.postContextUpdate();
              this.postLog('Source assessment complete — context layer updated.');
              this.postMessage('sourceAssessmentComplete', { success: true });
            } else {
              this.postLog('Context file manager not initialized. Open the sidebar first.');
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.postLog(`Source assessment failed: ${errMsg}`);
            this.postMessage('sourceAssessmentComplete', { success: false, error: errMsg });
          }
          break;
        }
        case 'syncMetadata': {
          this.postLog('Syncing database metadata...');
          try {
            await vscode.commands.executeCommand(`${EXTENSION_ID}.syncMetadata`);
          } catch (e) {
            this.postLog('Sync metadata command not yet registered. This will be wired in a future phase.');
          }
          break;
        }
        case 'runAgent': {
          const agentType = typeof message.agent === 'string' ? message.agent : '';
          if (!agentType) {
            this.postLog('No agent specified for runAgent.');
            return;
          }
          this.postLog(`Running agent: ${agentType}...`);
          try {
            // Route to the appropriate command based on agent type
            switch (agentType) {
              case 'sourceAssessmentAgent':
                await vscode.commands.executeCommand(`${EXTENSION_ID}.sourceAssessment`);
                break;
              case 'ingestionAgent':
              case 'sttmAgent':
              case 'architectureAgent':
              case 'snowflakeExecutor':
                // These agents are executed via the plan execution flow
                // For direct invocation, generate a single-step plan and execute it
                this.postLog(`Agent ${agentType} is available via plan execution. Use /plan to create a workflow.`);
                break;
              default:
                this.postLog(`Unknown agent type: ${agentType}`);
                break;
            }
          } catch (e) {
            this.postLog(`Agent execution failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          break;
        }
        case 'updateTargetConfig': {
          const targetConfig = message.targetConfig;
          if (targetConfig && typeof targetConfig === 'object') {
            this.postLog('Updating target environment configuration...');
            try {
              this.hub.setTargetEnvironment(targetConfig as import('./types').TargetEnvironment);
              this.postLog('Target environment updated.');
              this.postMessage('targetConfigUpdated', { success: true });
            } catch (err) {
              this.postLog(`Failed to update target config: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          break;
        }
        case 'settingsLoaded': {
          // Webview requests settings on initial load — re-send the current settings payload
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { CopilotAdapter } = require('./copilotAdapter') as typeof import('./copilotAdapter');
            const { info } = await CopilotAdapter.detect(this.context);
            const settings = this.configManager.getSettings();
            const merged = Object.assign({}, settings, { copilotInfo: info });
            this.postMessage('settingsLoaded', merged);
          } catch (err) {
            this.postMessage('settingsLoaded', this.configManager.getSettings());
          }
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

  private postContextUpdate(): void {
    if (!this.contextFileManager) return;
    const stats = this.contextFileManager.getContextStats();
    const entities = this.contextFileManager.getMentionableEntities();
    const dbEntities = entities.filter((e) => e.type === 'table').map((e) => e.label);
    const bizTerms = entities.filter((e) => e.type === 'business_term').map((e) => e.label);
    const queries = entities.filter((e) => e.type === 'verified_query').map((e) => e.label);
    this.view?.webview.postMessage({
      type: 'contextUpdate',
      stats,
      dbEntities,
      bizTerms,
      queries
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
