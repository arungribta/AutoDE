import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { ConfigurationManager } from './configManager';
import { DataAgentHubHub } from './agentHub';
import { WebviewMessage, PlanState, DataAgentHubSettings, SpecEngineAction, SpecIntakeQuestion, SkillDefinition, BusinessProblemSpec } from './types';
import { EXTENSION_ID } from './extensionIdentity';
import { SpecOpsEngine, createIntakeSession } from './specOps';
import { SkillRegistry, loadSkillsFromDirectory } from './skillRegistry';
import { composeSynthesisPrompt } from './specOpsPrompts';
import { GraphManager } from '../context/GraphManager';
import { ContextFileManager } from '../context/ContextFileManager';
import { ContextValidator } from '../context/ContextValidator';
import { SourceRegistry } from '../context/SourceRegistry';
import { SynthesisPipeline } from '../context/SynthesisPipeline';
import { SpecManager } from '../context/SpecManager';
import { ArtifactWriter } from '../context/ArtifactWriter';
import { scanArtifactStaleness } from '../context/ArtifactStalenessScanner';
import { applyCspNonce } from './webviewSecurity';

export class DataAgentHubWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'autoDataEngineeringHubSidebar';

  private view?: vscode.WebviewView;
  private graphManager: GraphManager;
  private contextFileManager?: ContextFileManager;
  private sourceRegistry?: SourceRegistry;
  private synthesisPipeline?: SynthesisPipeline;
  private specManager?: SpecManager;
  private specOpsEngine?: SpecOpsEngine;
  private skillRegistry?: SkillRegistry;
  private pendingSpecQuestions: SpecIntakeQuestion[] = [];
  /** Armed by the spec card's "Revise" action; consumed by the next chat message. */
  private pendingRevision = false;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configManager: ConfigurationManager,
    private readonly hub: DataAgentHubHub
  ) {
    this.hub.setStateListener((state: PlanState) => this.postState(state));
    this.hub.setLogListener((message: string) => this.postLog(message));
    this.graphManager = new GraphManager();
  }

  /** Builds an AJV envelope validator from the bundled context-envelope JSON Schema. */
  private createContextValidator(): ContextValidator | undefined {
    try {
      const schemaPath = path.join(this.context.extensionUri.fsPath, 'docs', 'schemas', 'context-envelope.schema.json');
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as object;
      return new ContextValidator(schema);
    } catch {
      return undefined;
    }
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
      (msg: string) => this.postLog(msg),
      this.createContextValidator()
    );
    try {
      await this.contextFileManager.initialize();
      this.postContextUpdate();
    } catch (err) {
      this.postLog(`Context initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Initialize source registry + synthesis pipeline
    this.sourceRegistry = new SourceRegistry(workspaceRoot, (msg: string) => this.postLog(msg));
    this.synthesisPipeline = new SynthesisPipeline(workspaceRoot, this.graphManager, (msg: string) => this.postLog(msg));
    try {
      await this.sourceRegistry.initialize();
      this.postSourcesList();
    } catch (err) {
      this.postLog(`Source registry initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Initialize business problem specification manager
    this.specManager = new SpecManager(workspaceRoot, (msg: string) => this.postLog(msg));
    try {
      await this.specManager.initialize();
      const existingSpec = this.specManager.getSpec();
      if (existingSpec) {
        this.hub.setSpec(existingSpec.id, existingSpec.version);
        if (existingSpec.status === 'approved') {
          this.hub.inferPhasesFromSpec(existingSpec);
        }
      }
      this.postSpec();
    } catch (err) {
      this.postLog(`Spec manager initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Detect the active local-LLM provider (Copilot / Claude Code) and include
    // its status in the settings payload.
    try {
      const info = await this.detectLanguageModel();
      const settings = this.configManager.getSettings();
      const merged = Object.assign({}, settings, info ? { copilotInfo: info, languageModelInfo: info } : {});
      this.postMessage('settingsLoaded', merged);
    } catch {
      this.postMessage('settingsLoaded', this.configManager.getSettings());
    }
  }

  /**
   * Detect status for the active provider — only Copilot (`vscode.lm`) and
   * Claude Code (CLI) have a detectable local status; every other provider is
   * API-key based and returns `undefined` here.
   */
  private async detectLanguageModel(provider?: string): Promise<unknown> {
    const settings = this.configManager.getSettings();
    const active = provider ?? settings.activeLlmProvider;
    if (active === 'claude') {
      const { ClaudeCodeAdapter } = require('./claudeCodeAdapter') as typeof import('./claudeCodeAdapter');
      const { info } = await ClaudeCodeAdapter.detect(settings.claudeCodePath);
      return info;
    }
    if (active === 'copilot') {
      const { LanguageModelAdapter } = require('./languageModelAdapter') as typeof import('./languageModelAdapter');
      const { info } = await LanguageModelAdapter.detect(this.context, { provider: 'copilot', model: settings.activeLlmModel });
      return info;
    }
    return undefined;
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'chat': {
          const chatMessage = typeof message.message === 'string' ? message.message : '';
          const schemaContext = typeof message.schemaContext === 'string' ? message.schemaContext : '';
          if (!chatMessage.trim()) { this.postLog('A message is required.'); return; }
          try {
            // ── Spec-driven conversation ──
            //   discovery/revision in progress -> this message continues it (an answer, or the
            //                                      opening change-request message)
            //   no spec yet                    -> agentic requirements discovery (adaptive questioning)
            //   draft spec                     -> the message refines it in place (quick single-shot edit)
            //   approved spec + "Revise" armed -> start a full revision interview (same rigor as
            //                                      the original: agentic discovery, seeded with the
            //                                      approved spec, ending in re-approval)
            //   approved spec, otherwise       -> conversational answer grounded in the specification
            const currentSpec = this.specManager?.getSpec();
            if (this.specOpsEngine) {
              await this.handleSpecDiscovery(chatMessage);
              break;
            }
            if (this.specManager && !currentSpec) {
              await this.handleSpecDiscovery(chatMessage);
              break;
            }
            if (this.specManager && currentSpec && currentSpec.status === 'draft') {
              await this.reviseSpec(chatMessage);
              break;
            }
            if (this.specManager && currentSpec && currentSpec.status === 'approved' && this.pendingRevision) {
              this.pendingRevision = false;
              await this.handleSpecDiscovery(chatMessage, currentSpec);
              break;
            }

            const repositoryContext = this.contextFileManager?.buildContextPrompt() ?? '';
            const combinedContext = [repositoryContext, schemaContext]
              .filter((part) => part && part.trim().length > 0)
              .join('\n\n');
            const response = await this.hub.chat(chatMessage, combinedContext);
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
          if (!objective.trim()) { this.postLog('A plan requires a user objective.'); return; }
          const plan = await this.hub.generatePlan(objective, schemaContext);
          this.postPlan(plan);
          break;
        }
        case 'executePlan': { await this.hub.executePlan(); break; }
        case 'pausePlan': { await this.hub.pauseExecution(); break; }
        case 'resetPlan': {
          await this.hub.resetPlan();
          const existingSpec = this.specManager?.getSpec();
          if (existingSpec && existingSpec.status === 'approved') {
            this.hub.inferPhasesFromSpec(existingSpec);
          }
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
            activeLlmProvider: settings.activeLlmProvider === 'azure-openai' || settings.activeLlmProvider === 'openai' || settings.activeLlmProvider === 'anthropic' || settings.activeLlmProvider === 'gemini' || settings.activeLlmProvider === 'ollama' || settings.activeLlmProvider === 'copilot' || settings.activeLlmProvider === 'claude' ? settings.activeLlmProvider : undefined,
            activeLlmModel: typeof settings.activeLlmModel === 'string' ? settings.activeLlmModel : undefined,
            llmEndpoint: typeof settings.llmEndpoint === 'string' ? settings.llmEndpoint : undefined,
            languageModelProgrammaticConsent: typeof settings.languageModelProgrammaticConsent === 'boolean' ? settings.languageModelProgrammaticConsent : undefined,
            copilotProgrammaticConsent: typeof settings.copilotProgrammaticConsent === 'boolean' ? settings.copilotProgrammaticConsent : undefined,
            claudeCodePath: typeof settings.claudeCodePath === 'string' ? settings.claudeCodePath : undefined
          };
          await this.configManager.updateSettings(typedSettings);
          if (typeof message.llmApiKey === 'string') { await this.configManager.setLlmApiKey(message.llmApiKey); }
          if (typeof message.snowflakePassword === 'string') { await this.configManager.setSnowflakePassword(message.snowflakePassword); }
          if (typeof message.snowflakePrivateKeyPassphrase === 'string') { await this.configManager.setSnowflakePrivateKeyPassphrase(message.snowflakePrivateKeyPassphrase); }
          this.postMessage('settingsSaved', { success: true });
          this.postLog('Settings saved securely to VS Code secrets.');
          // Refresh the active-provider status pill (e.g. after switching LLM card).
          try {
            const info = await this.detectLanguageModel();
            if (info) { this.postMessage('languageModelStatus', { info }); }
          } catch { /* non-fatal */ }
          break;
        }
        case 'testCopilot':
        case 'testLanguageModel': {
          const p = message.provider === 'claude' || message.provider === 'copilot' ? message.provider : undefined;
          try { await vscode.commands.executeCommand(`${EXTENSION_ID}.testLanguageModel`, p); } catch { this.postLog('Failed to execute language model test command.'); }
          break;
        }
        case 'listLanguageModels': {
          const p = message.provider === 'claude' || message.provider === 'copilot' ? message.provider : undefined;
          try { await vscode.commands.executeCommand(`${EXTENSION_ID}.listLanguageModels`, p); } catch { this.postLog('Failed to execute list language models command.'); }
          break;
        }
        case 'openCopilotHandoff': { try { const prompt = typeof (message.prompt) === 'string' ? message.prompt : undefined; await vscode.commands.executeCommand(`${EXTENSION_ID}.copilotHandoff`, prompt); } catch { this.postLog('Failed to open Copilot handoff editor.'); } break; }
        case 'reindex': { this.postLog('Re-index requested from webview.'); try { await vscode.commands.executeCommand(`${EXTENSION_ID}.reindex`); } catch { this.postLog('Re-index command not yet registered.'); } break; }
        case 'openContextFolder': {
          const contextUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri, '.ai-context');
          try { await vscode.commands.executeCommand('revealFileInOS', contextUri); } catch { await vscode.commands.executeCommand('workbench.files.action.showActiveFileInExplorer'); }
          break;
        }
        case 'testConnection': { this.postLog('Connecting to database...'); try { await vscode.commands.executeCommand(`${EXTENSION_ID}.testConnection`); } catch { this.postLog('Connect command not yet registered.'); } break; }
        case 'sourceAssessment': {
          this.postLog('Running source assessment...');
          try {
            if (this.contextFileManager) {
              const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri;
              this.contextFileManager.dispose();
              this.contextFileManager = new ContextFileManager(workspaceRoot, this.graphManager, (msg: string) => this.postLog(msg), this.createContextValidator());
              await this.contextFileManager.initialize();
              this.postContextUpdate();
              this.postLog('Source assessment complete.');
              this.postMessage('sourceAssessmentComplete', { success: true });
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.postLog(`Source assessment failed: ${errMsg}`);
            this.postMessage('sourceAssessmentComplete', { success: false, error: errMsg });
          }
          break;
        }
        case 'syncMetadata': { this.postLog('Syncing database metadata...'); try { await vscode.commands.executeCommand(`${EXTENSION_ID}.syncMetadata`); } catch { this.postLog('Sync metadata command not yet registered.'); } break; }
        case 'runToolSkill': {
          const skillId = typeof message.skillId === 'string' ? message.skillId.trim() : '';
          const instruction = typeof message.instruction === 'string' ? message.instruction.trim() : '';
          if (!skillId || !instruction) { this.postLog('Usage: /skill <skillId> <instruction>'); break; }
          this.postLog(`Running skill "${skillId}"…`);
          try {
            const result = await this.hub.runToolSkill(skillId, instruction);
            this.postMessage('chatResponse', { message: result.success ? result.message : `Skill failed: ${result.error || result.message}`, error: !result.success });
          } catch (err) {
            const message2 = err instanceof Error ? err.message : String(err);
            this.postMessage('chatResponse', { message: `Skill failed: ${message2}`, error: true });
          }
          break;
        }
        case 'runAgent': {
          const agentType = typeof message.agent === 'string' ? message.agent : '';
          if (!agentType) { this.postLog('No agent specified for runAgent.'); return; }
          this.postLog(`Running agent: ${agentType}...`);
          try {
            switch (agentType) {
              case 'sourceAssessmentAgent': await vscode.commands.executeCommand(`${EXTENSION_ID}.sourceAssessment`); break;
              default: this.postLog(`Agent ${agentType} is available via plan execution. Use /plan to create a workflow.`); break;
            }
          } catch (e) { this.postLog(`Agent execution failed: ${e instanceof Error ? e.message : String(e)}`); }
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
            } catch (err) { this.postLog(`Failed to update target config: ${err instanceof Error ? err.message : String(err)}`); }
          }
          break;
        }
        case 'settingsLoaded': {
          try {
            const info = await this.detectLanguageModel();
            const settings = this.configManager.getSettings();
            const merged = Object.assign({}, settings, info ? { copilotInfo: info, languageModelInfo: info } : {});
            this.postMessage('settingsLoaded', merged);
          } catch { this.postMessage('settingsLoaded', this.configManager.getSettings()); }
          break;
        }
        case 'registerSource': {
          const path = typeof message.path === 'string' ? message.path.trim() : '';
          const kind = (message.kind === 'business_context' || message.kind === 'verified_queries' || message.kind === 'data_definitions') ? message.kind : 'business_context';
          const owner = typeof message.owner === 'string' ? message.owner.trim() : undefined;
          if (!path) { this.postLog('A source file path is required.'); break; }
          await this.sourceRegistry?.addSource(path, kind, owner);
          this.postSourcesList();
          this.postLog(`Registered source: ${path} (${kind})`);
          break;
        }
        case 'listSources': { this.postSourcesList(); break; }
        case 'removeSource': {
          const path = typeof message.path === 'string' ? message.path : '';
          if (!path) break;
          await this.sourceRegistry?.removeSource(path);
          this.postSourcesList();
          this.postLog(`Removed source: ${path}`);
          break;
        }
        case 'synthesize': {
          if (!this.sourceRegistry || !this.synthesisPipeline) { this.postLog('Context services are not initialized.'); break; }
          this.postLog('Synthesizing context from registered sources...');
          const result = await this.synthesisPipeline.synthesize(this.sourceRegistry.getSources());
          this.postContextUpdate();
          this.postLog(`Synthesis produced ${result.nodes} node(s) and ${result.edges} edge(s).`);
          break;
        }
        case 'generateSpec': {
          const prompt = typeof message.prompt === 'string' ? message.prompt.trim() : '';
          if (!prompt) { this.postLog('Describe the business problem before generating a specification.'); break; }
          await this.draftSpec(prompt);
          break;
        }
        case 'refineSpec': {
          const refinement = typeof message.refinement === 'string' ? message.refinement.trim() : '';
          if (!refinement) { this.postLog('Describe the change you want applied to the specification.'); break; }
          const spec = this.specManager?.getSpec();
          if (spec && spec.status === 'approved') {
            // Same rule as chat: an approved spec is never edited in place — this
            // starts a full revision interview instead of the old single-shot rewrite.
            await this.handleSpecDiscovery(refinement, spec);
          } else {
            await this.reviseSpec(refinement);
          }
          break;
        }
        case 'approveSpec': {
          if (!this.specManager) { this.postLog('Spec manager is not initialized.'); break; }
          const approved = await this.specManager.approve();
          this.postSpec();
          if (approved) {
            this.hub.setSpec(approved.id, approved.version);
            this.hub.inferPhasesFromSpec(approved);
            this.postMessage('specApproved', { spec: approved });
            this.postLog(`Business Problem Specification v${approved.version} approved. Generate the workflow plan to start solving it.`);
          }
          break;
        }
        case 'generatePlanFromSpec': {
          const spec = this.specManager?.getSpec();
          if (!spec) { this.postLog('No Business Problem Specification exists yet — describe your business problem in the chat first.'); break; }
          if (spec.status !== 'approved') { this.postLog('Approve the Business Problem Specification before generating the workflow plan.'); break; }
          await this.hub.generatePlanFromSpec(spec);
          break;
        }
        case 'submitSpecAnswers': {
          const answers = Array.isArray(message.answers) ? message.answers : [];
          if (!this.specOpsEngine || answers.length === 0) { break; }
          const session = this.specOpsEngine.getSession();
          for (const item of answers) {
            if (!item || typeof item !== 'object') { continue; }
            const record = item as Record<string, unknown>;
            const questionId = typeof record.questionId === 'string' ? record.questionId : '';
            const value = typeof record.value === 'string' ? record.value.trim() : '';
            if (!questionId || !value) { continue; }
            const question = session.questions.find((candidate) => candidate.id === questionId);
            const field = question?.field ?? 'scope';
            this.specOpsEngine.answer({ questionId, field, value, answeredAt: new Date().toISOString() });
          }
          this.pendingSpecQuestions = [];
          await this.runDiscoveryTurn();
          break;
        }
        case 'openSpecFile': {
          if (!this.specManager) { this.postLog('Spec manager is not initialized.'); break; }
          const specDoc = await vscode.workspace.openTextDocument(this.specManager.getSpecUri());
          await vscode.window.showTextDocument(specDoc, { preview: false });
          break;
        }
        case 'startRevision': {
          const spec = this.specManager?.getSpec();
          if (spec && spec.status === 'approved') {
            this.pendingRevision = true;
            this.postLog('Describe the requested change — your next message starts a specification revision (same review/approval cycle as the original).');
          }
          // A draft spec is already revisable via the next chat message; nothing to arm.
          break;
        }
        case 'attachSpecFile': {
          if (!this.specOpsEngine) {
            this.postLog('Start a specification conversation (or a revision) before attaching a file.');
            break;
          }
          try {
            const picked = await vscode.window.showOpenDialog({
              canSelectMany: false,
              openLabel: 'Attach as reference material',
              title: 'Attach supplementary information'
            });
            const fileUri = picked?.[0];
            if (!fileUri) { break; }
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            const MAX_ATTACHMENT_BYTES = 200_000; // keep prompts bounded
            const content = Buffer.from(bytes).toString('utf8').slice(0, MAX_ATTACHMENT_BYTES);
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
            const displayPath = workspaceRoot ? path.relative(workspaceRoot.fsPath, fileUri.fsPath) : fileUri.fsPath;
            this.specOpsEngine.addAttachment({ path: displayPath, content, attachedAt: new Date().toISOString() });
            this.postLog(`Attached ${displayPath} as reference material for this conversation.`);
          } catch (err) {
            this.postLog(`Failed to attach file: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
        case 'openArtifactFolder': {
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri;
          const artifactUri = ArtifactWriter.resolveArtifactDirectory(workspaceRoot);
          try { await vscode.commands.executeCommand('revealFileInOS', artifactUri); } catch { await vscode.commands.executeCommand('workbench.files.action.showActiveFileInExplorer'); }
          break;
        }
        case 'checkArtifactStaleness': {
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
          if (!workspaceRoot) { break; }
          const spec = this.specManager?.getSpec();
          const report = await scanArtifactStaleness(workspaceRoot, spec ? { id: spec.id, version: spec.version } : undefined);
          this.postMessage('artifactStaleness', { report });
          break;
        }
        case 'viewSpecHistory': {
          if (!this.specManager) { this.postLog('Spec manager is not initialized.'); break; }
          try {
            const text = await this.getSpecGitHistory();
            this.postMessage('specHistory', { text });
          } catch (err) {
            this.postMessage('specHistory', { error: err instanceof Error ? err.message : String(err) });
          }
          break;
        }
        default: this.postLog(`Unknown message type: ${String(message.type)}`); break;
      }
    } catch (error) {
      const observed = error instanceof Error ? error.message : 'Unexpected webview error.';
      this.postLog(`Webview error: ${observed}`);
      this.postMessage('error', { message: observed });
    }
  }

  private postState(state: PlanState): void {
    this.view?.webview.postMessage({ type: 'stateUpdate', state });
  }

  private postPlan(plan: unknown): void {
    this.view?.webview.postMessage({ type: 'planUpdated', plan });
  }

  private postLog(message: string): void {
    this.view?.webview.postMessage({ type: 'logEntry', message });
  }

  private postContextUpdate(): void {
    if (!this.contextFileManager) return;
    const stats = this.contextFileManager.getContextStats();
    const entities = this.contextFileManager.getMentionableEntities();
    const dbEntities = entities.filter((e) => e.type === 'table').map((e) => e.label);
    const bizTerms = entities.filter((e) => e.type === 'business_term').map((e) => e.label);
    const queries = entities.filter((e) => e.type === 'verified_query').map((e) => e.label);
    this.view?.webview.postMessage({ type: 'contextUpdate', stats, dbEntities, bizTerms, queries });
  }

  private postSourcesList(): void {
    const sources = this.sourceRegistry?.getSources() ?? [];
    this.view?.webview.postMessage({ type: 'sourcesList', sources });
  }

  private postSpec(): void {
    const spec = this.specManager?.getSpec();
    this.view?.webview.postMessage({ type: 'specLoaded', spec });
  }

  /**
   * Renders the spec file's git history as readable text — AutoDE leans on git
   * as the version/audit log (`.ai-context/spec/` is meant to be committed)
   * rather than maintaining a parallel in-app version store.
   */
  private getSpecGitHistory(): Promise<string> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot || !this.specManager) {
      return Promise.reject(new Error('No workspace or specification is open.'));
    }
    const specPath = this.specManager.getSpecUri().fsPath;
    const args = ['log', '--follow', '--date=short', '--pretty=format:%C(auto)%h %ad %d %s', '-p', '--', specPath];
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd: workspaceRoot.fsPath, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || err.message || 'git log failed. Is this workspace a git repository?'));
          return;
        }
        resolve(stdout);
      });
    });
  }

  /**
   * Drafts a new Business Problem Specification from a natural-language description.
   * This is the first responsibility of AutoDE in the spec-driven flow.
   */
  private async draftSpec(prompt: string, previous?: BusinessProblemSpec): Promise<void> {
    if (!this.specManager) { this.postLog('Spec manager is not initialized.'); return; }
    const spec = await this.hub.generateSpec(prompt, previous);
    await this.specManager.saveSpec(spec);
    this.hub.setSpec(spec.id, spec.version);
    this.postSpec();
    this.postMessage('specDrafted', { spec, revised: previous?.status === 'approved' });
    this.postLog(
      previous
        ? `Draft revision v${spec.version} created. Review it in the Workflow Palette (🧰) and approve it, or reply with a further change.`
        : 'Draft Business Problem Specification created. Review it in the Workflow Palette (🧰) and approve it, ' +
          'or reply with a change and I will revise the specification.'
    );
  }

  /** Revises the current specification in response to user feedback. */
  private async reviseSpec(refinement: string): Promise<void> {
    if (!this.specManager) { this.postLog('Spec manager is not initialized.'); return; }
    const previous = this.specManager.getSpec();
    const spec = await this.hub.generateSpec(refinement, previous);
    await this.specManager.saveSpec(spec);
    this.hub.setSpec(spec.id, spec.version);
    this.postSpec();
    this.postMessage('specDrafted', { spec, revised: true });
    this.postLog(
      previous?.status === 'approved'
        ? `Specification revised as v${spec.version} (draft). Approve it to continue.`
        : `Specification v${spec.version} revised. Review it in the Workflow Palette (🧰).`
    );
  }

  // ── Agentic Specification Discovery (SpecOps) ──

  /** Lazily loads bundled + workspace skill definitions into a registry. */
  private ensureSkills(): SkillDefinition[] {
    if (this.skillRegistry) {
      return this.skillRegistry.list();
    }
    const bundledDir = vscode.Uri.joinPath(this.context.extensionUri, 'skills').fsPath;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri;
    const overrideDir = vscode.Uri.joinPath(workspaceRoot, '.ai-context', 'skills').fsPath;
    const bundled = loadSkillsFromDirectory(bundledDir);
    const overrides = loadSkillsFromDirectory(overrideDir);
    this.skillRegistry = new SkillRegistry([...bundled, ...overrides]);
    return this.skillRegistry.list();
  }

  /**
   * Handles a user message during an agentic specification conversation — either
   * starting fresh (no spec exists yet) or revising an approved one when
   * `previousSpec` is supplied (armed via the spec card's "Revise" action).
   */
  private async handleSpecDiscovery(message: string, previousSpec?: BusinessProblemSpec): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed) { return; }

    if (!this.specOpsEngine) {
      const fields = new SkillRegistry(this.ensureSkills()).allSpecFields();
      this.specOpsEngine = new SpecOpsEngine(createIntakeSession(trimmed, { fields, previousSpec }));
      this.postLog(previousSpec
        ? `Starting a revision of specification v${previousSpec.version} — answer the questions to refine the change.`
        : 'Starting agentic requirements discovery — answer the questions to refine the specification.');
    } else if (this.pendingSpecQuestions.length > 0) {
      const current = this.pendingSpecQuestions[0];
      this.specOpsEngine.answer({ questionId: current.id, field: current.field, value: trimmed, answeredAt: new Date().toISOString() });
      this.pendingSpecQuestions.shift();
      if (this.pendingSpecQuestions.length > 0) {
        this.postSpecQuestion(this.pendingSpecQuestions[0]);
        return;
      }
    }

    await this.runDiscoveryTurn();
  }

  private async runDiscoveryTurn(): Promise<void> {
    const engine = this.specOpsEngine;
    if (!engine) { return; }

    if (engine.shouldSynthesize()) {
      await this.synthesizeFromSession();
      return;
    }

    try {
      const extraContext = this.contextFileManager?.buildContextPrompt();
      const action: SpecEngineAction = await this.hub.discoverNextAction(engine.getSession(), this.ensureSkills(), extraContext);
      if (action.action === 'ask' || action.action === 'ask_many') {
        const ids = engine.applyAction(action);
        this.pendingSpecQuestions = engine.getSession().questions.filter((question) => ids.includes(question.id));
        if (this.pendingSpecQuestions.length > 1) {
          this.postMessage('specQuestions', { questions: this.pendingSpecQuestions });
        } else if (this.pendingSpecQuestions.length === 1) {
          this.postSpecQuestion(this.pendingSpecQuestions[0]);
        }
      } else {
        await this.synthesizeFromSession();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.postLog(`Requirements discovery failed (${message}); synthesizing from what was collected.`);
      await this.synthesizeFromSession();
    }
  }

  private async synthesizeFromSession(): Promise<void> {
    const engine = this.specOpsEngine;
    if (!engine) { return; }
    const isRevision = !!engine.getSession().previousSpec;
    engine.setState('synthesizing');
    this.postLog(isRevision
      ? 'Change clarified. Synthesizing the revised Business Problem Specification...'
      : 'Requirements collected. Synthesizing the comprehensive Business Problem Specification...');
    try {
      const previous = this.specManager?.getSpec();
      const extraContext = this.contextFileManager?.buildContextPrompt();
      const spec = await this.hub.synthesizeComprehensiveSpec(engine.getSession(), previous, extraContext);
      if (this.specManager) {
        await this.specManager.saveSpec(spec);
        this.hub.setSpec(spec.id, spec.version);
        this.postSpec();
      }
      this.postMessage('specDrafted', { spec, revised: isRevision });
      this.postLog(isRevision
        ? `Specification revised as v${spec.version} (draft). Review it in the Workflow Palette (🧰) and approve it to continue.`
        : 'Comprehensive Business Problem Specification drafted. Review it in the Workflow Palette (🧰) and approve it.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.postLog(`Synthesis failed (${message}); falling back to a basic draft.`);
      // Known limitation: this emergency fallback uses the older single-shot
      // generateSpec()/parseSpecResponse(), which only knows the v1 field shape.
      // `previous` still carries id/version/status correctly through it, but v2
      // fields (dataFlows, businessRequirements, etc.) are NOT preserved here —
      // only the primary path above (parseComprehensiveSpec) guarantees that.
      await this.draftSpec(composeSynthesisPrompt(engine.getSession()), engine.getSession().previousSpec);
    } finally {
      this.specOpsEngine = undefined;
      this.pendingSpecQuestions = [];
    }
  }

  private postSpecQuestion(question: SpecIntakeQuestion): void {
    this.postMessage('specQuestion', { question });
  }

  private postMessage(type: string, payload: object = {}): void {
    const recordPayload = payload as Record<string, unknown>;
    this.view?.webview.postMessage({ type, ...recordPayload });
  }

  private getHtmlForSidebar(webview: vscode.Webview): string {
    const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sidebar.html');
    return applyCspNonce(fs.readFileSync(htmlPath.fsPath, 'utf8'), webview.cspSource);
  }
}