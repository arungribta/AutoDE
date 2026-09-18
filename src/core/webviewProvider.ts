import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { ConfigurationManager } from './configManager';
import { DataAgentHubHub } from './agentHub';
import { WebviewMessage, PlanState, DataAgentHubSettings, SpecEngineAction, SpecIntakeQuestion, SkillDefinition, BusinessProblemSpec, IntakeSession, IntakeAttachment, ContextQuestion, TargetContext, SourceContext, DataPlatformProvider, ToolExecutionMode } from './types';
import { EXTENSION_ID } from './extensionIdentity';
import { SpecOpsEngine, createIntakeSession } from './specOps';
import { SkillRegistry, loadSkillsFromDirectory } from './skillRegistry';
import { composeSynthesisPrompt } from './specOpsPrompts';
import { buildDiscoveryProgress as buildDiscoveryProgressPure, skillNameForField, DiscoveryProgress } from './discoveryProgress';
import { GraphManager } from '../context/GraphManager';
import { ContextFileManager } from '../context/ContextFileManager';
import { ContextValidator } from '../context/ContextValidator';
import { SourceRegistry } from '../context/SourceRegistry';
import { SynthesisPipeline } from '../context/SynthesisPipeline';
import { SpecManager } from '../context/SpecManager';
import { ArtifactWriter } from '../context/ArtifactWriter';
import { scanArtifactStaleness } from '../context/ArtifactStalenessScanner';
import { ChatSessionManager } from '../context/ChatSessionManager';
import { TargetContextManager } from '../context/TargetContextManager';
import { SourceContextManager } from '../context/SourceContextManager';
import { ActiveProblemManager } from '../context/ActiveProblemManager';
import { AttachmentStore } from '../context/AttachmentStore';
import { PipelineSpecManager } from '../context/PipelineSpecManager';
import { generateDesignDoc } from './pipelineSpec/designDocGenerator';
import { generateProblemSlug } from './problemSlug';
import { listPrimitives, isSelectable, registerPrimitives, resetDeclarativePrimitives, registerPrimitiveVersion, resetVersionedPrimitives, compileTransformSpec } from './transforms/registry';
import { loadPrimitiveDefinitionsFromDirectory, mergePrimitiveDefinitions } from './transforms/declarative/loader';
import { createDeclarativePrimitive } from './transforms/declarative/adapter';
import { publishPrimitiveDefinition, deprecatePrimitiveDefinition } from './transforms/declarative/lifecycle';
import { PrimitiveDefinition } from './transforms/declarative/types';
import { ConnectionManager } from '../dqm/ConnectionManager';
import { applyCspNonce } from './webviewSecurity';
import { classifyImplementationType } from './implementationType';
import { buildTargetContextQuestions } from './targetContextQuestions';
import { buildSourceContextQuestions } from './sourceContextQuestions';

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
  private primitivesLoaded = false;
  /** Declarative (Tier-2) definitions by kind — carries `previewParams`, which isn't part of the shared `TransformPrimitive` interface. */
  private primitiveDefinitionsByKind = new Map<string, PrimitiveDefinition>();
  private pendingSpecQuestions: SpecIntakeQuestion[] = [];
  /** Armed by the spec card's "Revise" action; consumed by the next chat message. */
  private pendingRevision = false;
  private chatSessionManager?: ChatSessionManager;
  /** The chat session currently receiving persisted messages (Phase F) — independent of spec identity. */
  private activeChatId?: string;
  private targetContextManager?: TargetContextManager;
  private sourceContextManager?: SourceContextManager;
  private pipelineSpecManager?: PipelineSpecManager;
  private attachmentStore?: AttachmentStore;
  private activeProblemManager?: ActiveProblemManager;
  /** `undefined` = no active business problem yet (fresh workspace, or "Start New" before the first draft). */
  private activeProblemId?: string;
  private workspaceRoot?: vscode.Uri;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configManager: ConfigurationManager,
    private readonly hub: DataAgentHubHub,
    /** Re-points `hub`'s `PlanManager`/`ArtifactWriter` at a context root — owned by `extension.ts` so command-palette entry points keep working without the sidebar ever resolving. See `extension.ts#applyProblemRoot`. */
    private readonly applyProblemRoot: (contextRoot: vscode.Uri) => Promise<void>
  ) {
    this.hub.setStateListener((state: PlanState) => this.postState(state));
    this.hub.setLogListener((message: string) => this.postLog(message));
    this.graphManager = new GraphManager();
  }

  /** For command-driven chat-session management (`extension.ts`) — undefined until the sidebar has resolved at least once. */
  public getChatSessionManager(): ChatSessionManager | undefined {
    return this.chatSessionManager;
  }

  /** "AutoDE: New Chat" command proxy. */
  public async triggerNewChat(): Promise<void> {
    await this.startNewChat();
  }

  /** "AutoDE: Generate Pipeline Spec" command proxy (Phase 2B-i). */
  public async triggerGeneratePipelineSpec(): Promise<void> {
    await this.generatePipelineSpec();
  }

  /**
   * Phase 2B-i — an additional, opt-in flow alongside "Generate Plan": turns
   * the approved BPS + approved Target/Source Context + attachment extracts
   * into a strictly-validated, machine-compilable Pipeline Spec (YAML) plus
   * its deterministic Markdown design-doc projection.
   */
  private async generatePipelineSpec(): Promise<void> {
    const spec = this.specManager?.getSpec();
    if (!spec || !this.pipelineSpecManager) { this.postLog('No active business problem — approve a specification first.'); return; }
    const gate = this.computeContextGateStatus(spec);
    if (!gate.canGeneratePlan) {
      this.postMessage('error', { message: `Pipeline Spec generation needs the same readiness as Generate Plan: ${gate.blockingReasons.join(' ')}` });
      return;
    }
    try {
      this.postLog('Synthesizing Pipeline Spec…');
      const attachments = (await this.attachmentStore?.list()) ?? [];
      const draft = await this.hub.synthesizePipelineSpec({
        bps: spec,
        targetContext: this.targetContextManager?.getContext(),
        sourceContext: this.sourceContextManager?.getContext(),
        contextLayerText: this.contextFileManager?.buildContextPrompt(),
        attachmentExtracts: attachments.map((a) => a.extract).filter((e): e is NonNullable<typeof e> => !!e),
        previous: this.pipelineSpecManager.getSpec()
      });
      await this.pipelineSpecManager.saveSpec(draft);
      const designDoc = generateDesignDoc(draft);
      const designDocUri = vscode.Uri.joinPath(this.pipelineSpecManager.getSpecDir(), 'design.md');
      await vscode.workspace.fs.writeFile(designDocUri, Buffer.from(designDoc, 'utf8'));
      this.postMessage('pipelineSpecGenerated', { spec: draft, designDoc });
      this.postLog(`Pipeline Spec v${draft.version} drafted with ${draft.entities.length} entit${draft.entities.length === 1 ? 'y' : 'ies'} — review and approve it.`);
    } catch (err) {
      this.postMessage('error', { message: `Pipeline Spec generation failed: ${err instanceof Error ? err.message : String(err)}` });
    }
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
    this.workspaceRoot = workspaceRoot;
    this.activeProblemManager = new ActiveProblemManager(workspaceRoot, (msg: string) => this.postLog(msg));
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

    // Activate whichever business problem is current (v0.12.0) — resolves the
    // active-problem pointer and constructs every problem-scoped manager
    // pointed at that folder, or leaves them unset for a true "no active
    // problem" state. See `activateProblem` for the full sequence.
    const initialProblemId = await this.activeProblemManager.getActiveProblemId();
    await this.activateProblem(initialProblemId);

    // Initialize chat sessions (Phase F) — independent of spec identity.
    // v0.13.0 follow-up: a reload/restart no longer silently resumes the previous
    // conversation into view — dev-host testing found this confusing alongside the
    // "always reconstruct explicitly, never rely on residual session memory"
    // principle from the multi-business-problem work (§8.11/§9). Instead, any
    // session with actual content is folded (archived, never discarded — exactly
    // what an explicit "New Chat" already does) and a fresh empty one takes its
    // place; the folded session is resumable on demand via the sidebar's chat
    // history picker (`openChatSession`, now a real resume rather than a read-only
    // view — see §8a.4).
    this.chatSessionManager = new ChatSessionManager(workspaceRoot, (msg: string) => this.postLog(msg));
    try {
      await this.chatSessionManager.initialize();
      let active = await this.chatSessionManager.getActiveSession();
      if (!active) {
        active = await this.chatSessionManager.createSession({ llmProvider: this.configManager.getSettings().activeLlmProvider });
      }
      this.activeChatId = active.id;
      const transcript = await this.chatSessionManager.loadTranscript(active.id);
      if (transcript.length > 0) {
        await this.startNewChat();
      } else {
        this.postMessage('chatSessionLoaded', { meta: active, transcript });
      }
    } catch (err) {
      this.postLog(`Chat session initialization failed: ${err instanceof Error ? err.message : String(err)}`);
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
   * (Re)activates a business problem (v0.12.0) — used at startup and
   * whenever the user starts a new business problem or switches to an
   * existing one. Always runs `hub.resetForNewProblem()` first so nothing
   * from whichever problem was previously active can leak into this one
   * (the stale-state bug from requirements.md §8/§9's audit). Also swaps the
   * *shared* Context Layer graph's spec-derived layer (§10.2 of the audit):
   * removes the previously-active spec's nodes, then re-synthesizes the
   * newly-active one's — without this, switching problems would leak one
   * business problem's objectives/constraints into another's prompts, the
   * same class of bug this whole feature exists to close.
   */
  private async activateProblem(problemId: string | undefined): Promise<void> {
    if (!this.workspaceRoot || !this.activeProblemManager) return;
    const previousSpecId = this.hub.getPlan().specId;
    this.activeProblemId = problemId;
    this.hub.resetForNewProblem();
    if (previousSpecId) {
      await this.graphManager.removeNodesBySourceRef(`spec:${previousSpecId}`);
    }

    if (!problemId) {
      this.specManager = undefined;
      this.targetContextManager = undefined;
      this.sourceContextManager = undefined;
      this.pipelineSpecManager = undefined;
      this.attachmentStore = undefined;
      this.postSpec();
      this.postContextGateStatus();
      this.postContextUpdate();
      this.postMessage('activeProblemChanged', { problemId: undefined });
      return;
    }

    const contextRoot = this.activeProblemManager.problemRoot(problemId);
    await this.applyProblemRoot(contextRoot);

    this.specManager = new SpecManager(contextRoot, (msg: string) => this.postLog(msg));
    this.targetContextManager = new TargetContextManager(contextRoot, (msg: string) => this.postLog(msg));
    this.sourceContextManager = new SourceContextManager(contextRoot, (msg: string) => this.postLog(msg));
    this.pipelineSpecManager = new PipelineSpecManager(contextRoot, (msg: string) => this.postLog(msg));
    this.attachmentStore = new AttachmentStore(contextRoot);
    try {
      await this.specManager.initialize();
      await this.targetContextManager.initialize();
      await this.sourceContextManager.initialize();
      await this.pipelineSpecManager.initialize();
      const existingSpec = this.specManager.getSpec();
      if (existingSpec) {
        this.hub.setSpec(existingSpec.id, existingSpec.version);
        if (existingSpec.status === 'approved') {
          if (this.synthesisPipeline) { await this.synthesisPipeline.synthesizeFromSpec(existingSpec); }
          this.hub.inferPhasesFromSpec(existingSpec, this.contextFileManager?.buildContextPrompt());
          // A previously-approved Target Context becomes the plan's live target
          // environment again — closes the gap where a generic
          // TargetConfigManager default silently seeded it instead.
          const tc = this.targetContextManager.getContext();
          if (tc && this.targetContextManager.isApprovedFor(existingSpec.id, existingSpec.version)) {
            this.hub.setTargetEnvironment(this.targetContextToEnvironment(tc));
          }
        }
      }
      this.postSpec();
      this.postContextGateStatus();
      this.postContextUpdate();
      this.postMessage('activeProblemChanged', { problemId, spec: existingSpec });
    } catch (err) {
      this.postLog(`Spec manager initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Ensures a business problem is active before the first spec draft for it
   * is saved (v0.12.0). If one is already active, this is a revision of the
   * same problem and nothing happens. Otherwise a slug is derived from the
   * problem statement now that one finally exists, the folder is created,
   * recorded as active, and the problem-scoped managers are constructed —
   * this is the lazy, deferred half of "Start New Business Problem" (§10.3
   * of the audit): the folder can't be named before there's a problem
   * statement to name it from.
   */
  private async ensureActiveProblem(problemStatement: string): Promise<void> {
    if (this.activeProblemId || !this.activeProblemManager) return;
    const existing = await this.activeProblemManager.listProblems();
    const slug = generateProblemSlug(problemStatement, existing.map((p) => p.id));
    await this.activeProblemManager.setActiveProblemId(slug);
    await this.activateProblem(slug);
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
          const toolMode: ToolExecutionMode = message.toolMode === 'full' ? 'full' : 'read-only';
          if (!chatMessage.trim()) { this.postLog('A message is required.'); return; }
          const priorHistory = this.chatSessionManager && this.activeChatId
            ? await this.chatSessionManager.loadTranscript(this.activeChatId)
            : [];
          const priorMeta = this.chatSessionManager && this.activeChatId
            ? await this.chatSessionManager.getSessionMeta(this.activeChatId)
            : undefined;
          if (this.chatSessionManager && this.activeChatId) {
            this.chatSessionManager.appendMessage(this.activeChatId, { role: 'user', content: chatMessage, at: new Date().toISOString() }).catch(() => { /* best-effort */ });
          }
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
            const result = await this.hub.chat(chatMessage, combinedContext, toolMode, {
              history: priorHistory,
              priorSummary: priorMeta?.summary,
              claudeSessionId: priorMeta?.claudeSessionId
            });
            if (this.chatSessionManager && this.activeChatId && (result.updatedSummary !== undefined || result.newClaudeSessionId)) {
              const patch: { summary?: string; claudeSessionId?: string } = {};
              if (result.updatedSummary !== undefined) { patch.summary = result.updatedSummary; }
              if (result.newClaudeSessionId) { patch.claudeSessionId = result.newClaudeSessionId; }
              this.chatSessionManager.updateMeta(this.activeChatId, patch).catch(() => { /* best-effort */ });
            }
            this.postMessage('chatResponse', { message: result.message });
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
          const repositoryContext = this.contextFileManager?.buildContextPrompt() ?? '';
          const combinedContext = [repositoryContext, schemaContext]
            .filter((part) => part && part.trim().length > 0)
            .join('\n\n');
          const plan = await this.hub.generatePlan(objective, combinedContext);
          this.postPlan(plan);
          break;
        }
        case 'executePlan': { await this.hub.executePlan(); break; }
        case 'approvePlan': {
          this.hub.approvePlan();
          this.postLog('Plan approved. Confirm the applicable stages, then generate artifacts.');
          break;
        }
        case 'confirmStages': {
          this.hub.confirmStages();
          this.postLog('Applicable stages confirmed. Ready to generate artifacts.');
          break;
        }
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
        case 'startNewBusinessProblem': {
          await this.activeProblemManager?.clearActiveProblem();
          await this.activateProblem(undefined);
          await this.startNewChat();
          this.postLog('Started a new business problem. Describe it in the chat to begin.');
          break;
        }
        case 'listBusinessProblems': {
          const problems = (await this.activeProblemManager?.listProblems()) ?? [];
          this.postMessage('businessProblemsList', { problems });
          break;
        }
        case 'switchBusinessProblem': {
          const problemId = typeof message.problemId === 'string' ? message.problemId : '';
          if (!problemId) { this.postLog('A business problem id is required.'); break; }
          if (problemId === this.activeProblemId) { break; }
          await this.activeProblemManager?.setActiveProblemId(problemId);
          await this.activateProblem(problemId);
          await this.startNewChat();
          this.postLog(`Switched to business problem "${problemId}".`);
          break;
        }
        case 'approveBusinessProblem': {
          if (!this.specManager) { this.postLog('Spec manager is not initialized.'); break; }
          const spec = this.specManager.getSpec();
          if (!spec) { this.postMessage('error', { message: 'No Business Problem Specification exists yet.' }); break; }
          spec.problemStatementApproved = true;
          await this.specManager.saveSpec(spec);
          this.postSpec();
          this.postLog('Business problem confirmed. Review the full specification below and approve it to continue.');
          break;
        }
        case 'approveSpec': {
          if (!this.specManager) { this.postLog('Spec manager is not initialized.'); break; }
          const draft = this.specManager.getSpec();
          if (draft && !draft.problemStatementApproved) {
            this.postMessage('error', { message: 'Confirm the inferred business problem before approving the full specification.' });
            break;
          }
          const approved = await this.specManager.approve();
          this.postSpec();
          if (approved) {
            this.hub.setSpec(approved.id, approved.version);
            await this.syncContextFromApprovedSpec(approved);
            const contextSummary = this.contextFileManager?.buildContextPrompt();
            this.hub.inferPhasesFromSpec(approved, contextSummary);
            await this.initializeContextForApprovedSpec(approved);
            this.postMessage('specApproved', { spec: approved });
            this.postLog(approved.implementationType === 'brownfield'
              ? `Business Problem Specification v${approved.version} approved. Build the Target Context and Source Context before generating the workflow plan.`
              : `Business Problem Specification v${approved.version} approved. Build the Target Context before generating the workflow plan (no source system — Greenfield).`);
            this.postContextGateStatus();
          }
          break;
        }
        case 'setImplementationType': {
          const value = message.value === 'brownfield' ? 'brownfield' : message.value === 'greenfield' ? 'greenfield' : undefined;
          if (!value) { this.postLog('Implementation type must be "greenfield" or "brownfield".'); break; }
          const spec = this.specManager?.getSpec();
          if (!spec) { this.postMessage('error', { message: 'No Business Problem Specification exists yet.' }); break; }
          spec.implementationType = value;
          spec.implementationTypeReason = 'Manually set by user.';
          spec.implementationTypeOverridden = true;
          await this.specManager!.saveSpec(spec);
          this.postSpec();
          if (spec.status === 'approved') {
            this.hub.inferPhasesFromSpec(spec, this.contextFileManager?.buildContextPrompt());
            await this.initializeContextForApprovedSpec(spec);
          }
          this.postLog(`Implementation type set to ${value}.`);
          this.postContextGateStatus();
          break;
        }
        case 'startTargetContext': {
          const spec = this.specManager?.getSpec();
          if (!spec || spec.status !== 'approved' || !this.targetContextManager) { this.postMessage('error', { message: 'Approve the specification before building Target Context.' }); break; }
          const existing = this.targetContextManager.getContext();
          const sameVersion = !!existing && existing.specId === spec.id && existing.specVersion === spec.version;
          if (!sameVersion) { await this.targetContextManager.reset(spec.id, spec.version); }
          const questions = buildTargetContextQuestions(spec);
          this.postMessage('targetContextQuestions', { questions, answers: sameVersion ? existing!.answers : {} });
          break;
        }
        case 'submitTargetContextAnswers': {
          const spec = this.specManager?.getSpec();
          if (!spec || !this.targetContextManager) break;
          const rawAnswers = Array.isArray(message.answers) ? message.answers as Array<{ questionId: string; value: string }> : [];
          const questions = buildTargetContextQuestions(spec);
          const answerMap: Record<string, string> = {};
          const record: Record<string, unknown> = { specId: spec.id, specVersion: spec.version, status: 'built', builtAt: new Date().toISOString() };
          for (const a of rawAnswers) {
            const q = questions.find((qq) => qq.id === a.questionId);
            if (!q || !a.value) continue;
            answerMap[q.id] = a.value;
            this.applyAnswerToField(record, q.field, a.value);
          }
          record.answers = answerMap;
          await this.targetContextManager.save(record as unknown as TargetContext);
          this.postMessage('targetContextBuilt', { context: this.targetContextManager.getContext() });
          this.postLog('Target Context built — review it and approve to unlock Generate Plan.');
          this.postContextGateStatus();
          break;
        }
        case 'approveTargetContext': {
          const spec = this.specManager?.getSpec();
          const tc = this.targetContextManager?.getContext();
          if (!spec || !tc || !this.targetContextManager) break;
          if (tc.specId !== spec.id || tc.specVersion !== spec.version) { this.postMessage('error', { message: 'Target Context is out of date — rebuild it for the current specification version.' }); break; }
          const approved: TargetContext = { ...tc, status: 'approved', approvedAt: new Date().toISOString() };
          await this.targetContextManager.save(approved);
          this.hub.setTargetEnvironment(this.targetContextToEnvironment(approved));
          this.postMessage('targetContextApproved', { context: approved });
          this.postLog('Target Context approved.');
          this.postContextGateStatus();
          break;
        }
        case 'reviseTargetContext': {
          const spec = this.specManager?.getSpec();
          if (!spec || !this.targetContextManager) break;
          const existing = this.targetContextManager.getContext();
          const questions = buildTargetContextQuestions(spec);
          this.postMessage('targetContextQuestions', { questions, answers: existing?.answers ?? {} });
          break;
        }
        case 'chooseSourceContextMethod': {
          const spec = this.specManager?.getSpec();
          if (!spec || spec.status !== 'approved' || !this.sourceContextManager) { this.postMessage('error', { message: 'Approve the specification before building Source Context.' }); break; }
          const method = message.method === 'connected' ? 'connected' : message.method === 'described' ? 'described' : undefined;
          if (!method) break;
          if (method === 'described') {
            const existing = this.sourceContextManager.getContext();
            const sameVersion = !!existing && existing.specId === spec.id && existing.specVersion === spec.version;
            if (!sameVersion) { await this.sourceContextManager.reset(spec.id, spec.version); }
            const questions = buildSourceContextQuestions(spec);
            this.postMessage('sourceContextQuestions', { questions, answers: sameVersion ? existing!.answers : {} });
          } else {
            await this.runSourceConnectionCheck(spec);
          }
          break;
        }
        case 'runSourceConnectionCheck': {
          const spec = this.specManager?.getSpec();
          if (!spec || spec.status !== 'approved') { this.postMessage('error', { message: 'Approve the specification before building Source Context.' }); break; }
          await this.runSourceConnectionCheck(spec);
          break;
        }
        case 'submitSourceContextAnswers': {
          const spec = this.specManager?.getSpec();
          if (!spec || !this.sourceContextManager) break;
          const rawAnswers = Array.isArray(message.answers) ? message.answers as Array<{ questionId: string; value: string }> : [];
          const answerMap: Record<string, string> = {};
          for (const a of rawAnswers) { if (a.value) answerMap[a.questionId] = a.value; }
          const description = [answerMap.description, answerMap.dataContract ? `Data contract / interface notes: ${answerMap.dataContract}` : '']
            .filter((part) => part && part.trim().length > 0)
            .join('\n\n');
          const record: SourceContext = {
            specId: spec.id, specVersion: spec.version, status: 'built', method: 'described',
            sourceType: (answerMap.sourceType as SourceContext['sourceType']) || undefined,
            description: description || undefined,
            answers: answerMap, builtAt: new Date().toISOString()
          };
          await this.sourceContextManager.save(record);
          this.postMessage('sourceContextBuilt', { context: this.sourceContextManager.getContext() });
          this.postLog('Source Context built — review it and approve to unlock Generate Plan.');
          this.postContextGateStatus();
          break;
        }
        case 'approveSourceContext': {
          const spec = this.specManager?.getSpec();
          const sc = this.sourceContextManager?.getContext();
          if (!spec || !sc || !this.sourceContextManager) break;
          if (sc.specId !== spec.id || sc.specVersion !== spec.version) { this.postMessage('error', { message: 'Source Context is out of date — rebuild it for the current specification version.' }); break; }
          const approved: SourceContext = { ...sc, status: 'approved', approvedAt: new Date().toISOString() };
          await this.sourceContextManager.save(approved);
          this.postMessage('sourceContextApproved', { context: approved });
          this.postLog('Source Context approved.');
          this.postContextGateStatus();
          break;
        }
        case 'reviseSourceContext': {
          const spec = this.specManager?.getSpec();
          if (!spec || !this.sourceContextManager) break;
          const existing = this.sourceContextManager.getContext();
          if (existing?.method === 'connected') { await this.runSourceConnectionCheck(spec); break; }
          const questions = buildSourceContextQuestions(spec);
          this.postMessage('sourceContextQuestions', { questions, answers: existing?.answers ?? {} });
          break;
        }
        case 'generatePipelineSpec': {
          await this.generatePipelineSpec();
          break;
        }
        case 'approvePipelineSpec': {
          if (!this.pipelineSpecManager) break;
          const approved = await this.pipelineSpecManager.approve();
          if (approved) {
            this.postMessage('pipelineSpecApproved', { spec: approved });
            this.postLog(`Pipeline Spec v${approved.version} approved.`);
          }
          break;
        }
        case 'listPrimitives': {
          this.postPrimitivesList();
          break;
        }
        case 'previewPrimitive': {
          // A plain local compile — no LLM call, no agentic tool loop, just the same
          // deterministic compileTransformSpec() every real pipeline step already uses.
          const kind = typeof message.kind === 'string' ? message.kind : '';
          this.ensurePrimitivesLoaded();
          const primitive = listPrimitives().find((p) => p.kind === kind);
          if (!primitive) { this.postMessage('error', { message: `Unknown primitive "${kind}".` }); break; }
          const explicitParams = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : undefined;
          const previewParams = explicitParams ?? this.primitiveDefinitionsByKind.get(kind)?.previewParams;
          if (!previewParams) {
            this.postMessage('error', { message: `No preview parameters available for "${kind}" (a Tier-1 primitive with no params supplied — Tier-2 definitions carry their own previewParams).` });
            break;
          }
          try {
            const compiled = compileTransformSpec({ kind, params: previewParams }, { platform: 'snowflake', database: '', schema: '' }, 'snowflake');
            this.postMessage('primitivePreview', { kind, content: compiled.content, summary: compiled.summary });
          } catch (err) {
            this.postMessage('error', { message: `Preview failed for "${kind}": ${err instanceof Error ? err.message : String(err)}` });
          }
          break;
        }
        case 'publishPrimitive': {
          if (!this.configManager.getSettings().primitiveManagementEnabled) {
            this.postMessage('error', { message: 'Primitive management is disabled — enable "autoDataEngineeringHub.primitiveManagementEnabled" to publish primitives.' });
            break;
          }
          const kind = typeof message.kind === 'string' ? message.kind : '';
          const dir = this.primitivesOverrideDir();
          if (!dir) { this.postMessage('error', { message: 'No workspace folder — cannot publish a primitive definition.' }); break; }
          try {
            const result = publishPrimitiveDefinition(dir, kind, 'user');
            this.ensurePrimitivesLoaded(true);
            this.postPrimitivesList();
            this.postLog(`Primitive "${kind}" published${result.versionBumped ? ` as v${result.definition.version} (prior revision archived)` : ''}.`);
          } catch (err) {
            this.postMessage('error', { message: `Publish failed for "${kind}": ${err instanceof Error ? err.message : String(err)}` });
          }
          break;
        }
        case 'deprecatePrimitive': {
          if (!this.configManager.getSettings().primitiveManagementEnabled) {
            this.postMessage('error', { message: 'Primitive management is disabled — enable "autoDataEngineeringHub.primitiveManagementEnabled" to deprecate primitives.' });
            break;
          }
          const kind = typeof message.kind === 'string' ? message.kind : '';
          const dir = this.primitivesOverrideDir();
          if (!dir) { this.postMessage('error', { message: 'No workspace folder — cannot deprecate a primitive definition.' }); break; }
          try {
            deprecatePrimitiveDefinition(dir, kind);
            this.ensurePrimitivesLoaded(true);
            this.postPrimitivesList();
            this.postLog(`Primitive "${kind}" deprecated — still usable by existing specs, no longer offered for new ones.`);
          } catch (err) {
            this.postMessage('error', { message: `Deprecate failed for "${kind}": ${err instanceof Error ? err.message : String(err)}` });
          }
          break;
        }
        case 'setPhaseRequired': {
          const phase = typeof message.phase === 'string' ? message.phase : '';
          const required = message.required === true;
          if (phase !== 'discover' && phase !== 'model' && phase !== 'build' && phase !== 'validate') {
            this.postLog('A valid phase (discover/model/build/validate) is required.');
            break;
          }
          this.hub.setPhaseOverride(phase, required);
          break;
        }
        case 'generatePlanFromSpec': {
          const spec = this.specManager?.getSpec();
          if (!spec) { this.postMessage('error', { message: 'No Business Problem Specification exists yet — describe your business problem in the chat first.' }); break; }
          if (spec.status !== 'approved') { this.postMessage('error', { message: 'Approve the Business Problem Specification before generating the workflow plan.' }); break; }
          const gate = this.computeContextGateStatus(spec);
          if (!gate.canGeneratePlan) {
            this.postMessage('error', { message: `Generate Plan is blocked until context is ready: ${gate.blockingReasons.join(' ')}` });
            break;
          }
          await this.hub.generatePlanFromSpec(spec, this.buildContextSummaryForPlan(spec));
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
            if (this.chatSessionManager && this.activeChatId) {
              this.chatSessionManager.appendMessage(this.activeChatId, { role: 'user', content: `[Answer: ${field}] ${value}`, at: new Date().toISOString() }).catch(() => { /* best-effort */ });
            }
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
        case 'newChat': {
          await this.startNewChat();
          break;
        }
        case 'listChatSessions': {
          const sessions = (await this.chatSessionManager?.listSessions()) ?? [];
          this.postMessage('chatSessionsList', { sessions, activeChatId: this.activeChatId });
          break;
        }
        case 'openChatSession': {
          // Resumes a past chat session as the live, active one (v0.13.0 follow-up
          // to §8.11/§9's "reconstruct explicitly" principle) — the on-screen
          // counterpart to the startup fold above. Not a read-only preview: the
          // resumed session becomes exactly what "New Chat" would have started,
          // except pre-loaded with this transcript, and new messages append to it.
          const chatId = typeof message.chatId === 'string' ? message.chatId : '';
          if (!chatId || !this.chatSessionManager) { break; }
          if (chatId !== this.activeChatId) {
            if (this.activeChatId) {
              // Fold whatever's currently active rather than losing it — the same
              // "archive, never discard" rule the startup fold and New Chat follow.
              await this.chatSessionManager.archiveSession(this.activeChatId);
            }
            await this.chatSessionManager.updateMeta(chatId, { status: 'active' });
            this.activeChatId = chatId;
          }
          const [transcript, sessions] = await Promise.all([
            this.chatSessionManager.loadTranscript(chatId),
            this.chatSessionManager.listSessions()
          ]);
          const meta = sessions.find((s) => s.id === chatId);
          this.postMessage('chatSessionLoaded', { meta, transcript });
          this.postLog('Resumed chat session.');
          break;
        }
        case 'discardChat': {
          const chatId = typeof message.chatId === 'string' ? message.chatId : '';
          if (!chatId || !this.chatSessionManager) { break; }
          const choice = await vscode.window.showWarningMessage(
            'Permanently discard this chat? This cannot be undone.',
            { modal: true },
            'Discard'
          );
          if (choice !== 'Discard') { break; }
          await this.chatSessionManager.discardSession(chatId);
          if (chatId === this.activeChatId) {
            // The active chat can't discard itself out from under the open view — start a fresh one.
            await this.startNewChat();
          }
          const sessions = await this.chatSessionManager.listSessions();
          this.postMessage('chatSessionsList', { sessions, activeChatId: this.activeChatId });
          this.postLog('Chat discarded.');
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
            const attachment: IntakeAttachment = {
              id: `att-${Date.now().toString(36)}`,
              path: displayPath,
              content,
              attachedAt: new Date().toISOString()
            };
            this.postLog(`Attached ${displayPath} as reference material — extracting structured facts…`);
            attachment.extract = await this.hub.extractAttachmentFacts(attachment);
            this.specOpsEngine.addAttachment(attachment);
            if (this.attachmentStore) { await this.attachmentStore.save(attachment); }
            this.postLog(`Attached ${displayPath} as reference material for this conversation (confidence: ${attachment.extract.confidence}).`);
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
   * "New Chat" (Phase F). Archives the current chat session (never discards —
   * only an explicit `discardChat` action deletes anything) and starts a fresh
   * one. Any in-progress discovery/revision interview is not resumed as a live
   * Q&A later — its partial answers are folded into context instead, so the
   * information isn't lost even though the specific conversation is done.
   */
  private async startNewChat(): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!this.chatSessionManager || !workspaceRoot) { this.postLog('Chat sessions are not initialized.'); return; }

    if (this.specOpsEngine) {
      await this.carryOverPartialInterview(this.specOpsEngine.getSession(), workspaceRoot);
      this.specOpsEngine = undefined;
      this.pendingSpecQuestions = [];
    }
    this.pendingRevision = false;

    if (this.activeChatId) {
      await this.chatSessionManager.archiveSession(this.activeChatId);
    }
    const spec = this.specManager?.getSpec();
    const newSession = await this.chatSessionManager.createSession({
      specId: spec?.id,
      specVersion: spec?.version,
      llmProvider: this.configManager.getSettings().activeLlmProvider
    });
    this.activeChatId = newSession.id;
    this.postMessage('chatSessionLoaded', { meta: newSession, transcript: [] });
    this.postLog('Started a new chat.');
  }

  /**
   * Deterministic (no LLM call) — the answers are already validated Q&A pairs,
   * not freeform text needing judgment to extract — so this runs unconditionally
   * on New Chat rather than being gated behind the user-initiated "distill this
   * chat" action (requirements.md §9b), which is for freeform chat content.
   * Reuses the existing SourceRegistry/SynthesisPipeline machinery (registers a
   * `business_context`-shaped note) instead of a parallel extraction path.
   */
  private async carryOverPartialInterview(session: IntakeSession, workspaceRoot: vscode.Uri): Promise<void> {
    if (!this.sourceRegistry || !this.synthesisPipeline) { return; }
    if (session.answers.length === 0 && session.insights.length === 0) { return; }

    const lines: string[] = [
      `# Partial answers carried over from an abandoned specification conversation (${session.id})`,
      `# ${session.changeRequest ? 'Change request' : 'Business problem'}: ${session.changeRequest || session.problemStatement}`
    ];
    for (const answer of session.answers) { lines.push(`- ${answer.field}: ${answer.value}`); }
    for (const insight of session.insights) { lines.push(`- note: ${insight}`); }

    const relativePath = `.ai-context/chats/carryover/${session.id}.md`;
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceRoot, '.ai-context', 'chats', 'carryover'));
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(workspaceRoot, relativePath), Buffer.from(lines.join('\n') + '\n', 'utf8'));
      await this.sourceRegistry.addSource(relativePath, 'business_context', 'autode');
      const result = await this.synthesisPipeline.synthesize(this.sourceRegistry.getSources());
      this.postContextUpdate();
      this.postLog(`Carried forward ${session.answers.length} partial answer(s) into context (${result.nodes} node(s)).`);
    } catch (err) {
      this.postLog(`Failed to carry over partial interview data: ${err instanceof Error ? err.message : String(err)}`);
    }
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

  // ── Source & Target Context (v0.11.0) ──

  /**
   * Called after every spec approval (and every implementationType change on
   * an approved spec) to keep Target/Source Context aligned with the current
   * spec version: Target Context resets to `pending` for a genuinely new
   * version; Source Context resets to `pending` for Brownfield or is
   * auto-marked `not_applicable` for Greenfield — never left stale from a
   * prior spec version or a prior implementation type.
   */
  private async initializeContextForApprovedSpec(spec: BusinessProblemSpec): Promise<void> {
    if (this.targetContextManager) {
      const tc = this.targetContextManager.getContext();
      const sameVersion = !!tc && tc.specId === spec.id && tc.specVersion === spec.version;
      if (!sameVersion) { await this.targetContextManager.reset(spec.id, spec.version); }
    }
    if (this.sourceContextManager) {
      const sc = this.sourceContextManager.getContext();
      const sameVersion = !!sc && sc.specId === spec.id && sc.specVersion === spec.version;
      if (spec.implementationType === 'brownfield') {
        if (!sameVersion) { await this.sourceContextManager.reset(spec.id, spec.version); }
      } else if (!sameVersion || sc!.status !== 'not_applicable') {
        await this.sourceContextManager.markNotApplicable(spec.id, spec.version);
      }
    }
  }

  /** The single source of truth for whether Generate Plan is allowed to run — computed fresh, never cached. */
  private computeContextGateStatus(spec: BusinessProblemSpec | undefined): {
    targetStatus: string; sourceApplicable: boolean; sourceStatus: string; canGeneratePlan: boolean; blockingReasons: string[];
  } {
    if (!spec || spec.status !== 'approved') {
      return { targetStatus: 'none', sourceApplicable: false, sourceStatus: 'none', canGeneratePlan: false, blockingReasons: ['Approve the specification first.'] };
    }
    const tc = this.targetContextManager?.getContext();
    const targetForThisVersion = !!tc && tc.specId === spec.id && tc.specVersion === spec.version;
    const targetReady = !!this.targetContextManager?.isApprovedFor(spec.id, spec.version);
    const sourceApplicable = spec.implementationType === 'brownfield';
    const sc = this.sourceContextManager?.getContext();
    const sourceForThisVersion = !!sc && sc.specId === spec.id && sc.specVersion === spec.version;
    const sourceReady = !sourceApplicable || !!this.sourceContextManager?.isReadyFor(spec.id, spec.version);
    const reasons: string[] = [];
    // Business Problem checkpoint (v0.13.0, §8.12) — approveSpec already requires this, but
    // it's included here too so the palette's gate messaging always matches what the
    // orchestrator will actually enforce, in case a spec somehow reaches 'approved' status
    // without it (e.g. an older persisted spec from before this field existed).
    if (!spec.problemStatementApproved) reasons.push('Confirm the inferred business problem.');
    if (!targetReady) reasons.push('Target Context needs to be built and approved.');
    if (sourceApplicable && !sourceReady) reasons.push('Source Context needs to be built and approved (or marked Not Applicable).');
    return {
      targetStatus: targetForThisVersion ? tc!.status : 'none',
      sourceApplicable,
      sourceStatus: sourceForThisVersion ? sc!.status : 'none',
      canGeneratePlan: !!spec.problemStatementApproved && targetReady && sourceReady,
      blockingReasons: reasons
    };
  }

  private postContextGateStatus(): void {
    const status = this.computeContextGateStatus(this.specManager?.getSpec());
    // Pushes the same readiness signal into the orchestrator (AgentHub) so plan
    // generation is gated at its actual enforcement point, not just in the UI
    // that happens to call this method (v0.13.0, requirements.md §8.12/§11).
    this.hub.setContextGateReady(status.canGeneratePlan);
    this.postMessage('contextGateStatus', {
      ...status,
      targetContext: this.targetContextManager?.getContext(),
      sourceContext: this.sourceContextManager?.getContext()
    });
  }

  /** Merges the Context Layer, Source Context, and approved Target Context into one prompt block for plan generation. */
  private buildContextSummaryForPlan(spec: BusinessProblemSpec): string {
    const parts: string[] = [];
    const base = this.contextFileManager?.buildContextPrompt();
    if (base) parts.push(base);
    const sc = this.sourceContextManager?.getContext();
    if (sc && sc.specId === spec.id && sc.specVersion === spec.version && sc.status !== 'not_applicable') {
      const lines = ['## Source Context'];
      if (sc.description) lines.push(sc.description);
      if (sc.connectionSummary) {
        lines.push(`Live connection: ${sc.connectionSummary.platform} — ${sc.connectionSummary.database}.${sc.connectionSummary.schema} (${sc.connectionSummary.tableCount} tables, ${sc.connectionSummary.viewCount} views)`);
      }
      if (lines.length > 1) parts.push(lines.join('\n'));
    }
    const tc = this.targetContextManager?.getContext();
    if (tc && tc.specId === spec.id && tc.specVersion === spec.version && tc.status === 'approved') {
      const pc = tc.platformConfig ?? {};
      parts.push([
        '## Target Context',
        `Platform: ${tc.platform}. Environment: ${tc.environmentProfile}.`,
        `Modeling approach: ${tc.modelingApproach}. Naming convention: ${tc.namingConvention}.`,
        `Transformation tool: ${tc.transformationTool}. Orchestration tool: ${tc.orchestrationTool}.`,
        pc.database || pc.schema ? `Target location: ${pc.database ?? ''}${pc.schema ? '.' + pc.schema : ''}` : ''
      ].filter((line) => line.trim().length > 0).join('\n'));
    }
    return parts.join('\n\n');
  }

  /** Converts an approved Target Context into the `TargetEnvironment` shape `AgentHub` expects, filling reasonable defaults for anything left blank. */
  private targetContextToEnvironment(tc: TargetContext): import('./types').TargetEnvironment {
    const platform: DataPlatformProvider = tc.platform ?? 'snowflake';
    const pc = tc.platformConfig ?? {};
    let platformConfig: import('./types').TargetEnvironment['platformConfig'];
    switch (platform) {
      case 'databricks':
        platformConfig = { workspaceUrl: pc.workspaceUrl ?? '', catalog: pc.database ?? 'main', schema: pc.schema ?? 'default' };
        break;
      case 'bigquery':
        platformConfig = { projectId: pc.projectId ?? '', dataset: pc.database ?? pc.schema ?? 'analytics', region: pc.region ?? 'us-central1' };
        break;
      default:
        platformConfig = {
          account: pc.account ?? '',
          database: pc.database ?? 'CURATED_DB',
          schema: pc.schema ?? 'ANALYTICS',
          warehouse: pc.warehouse ?? 'WH_XS',
          role: pc.role ?? 'SYSADMIN'
        };
    }
    return {
      platform,
      environmentProfile: tc.environmentProfile ?? 'development',
      modelingApproach: tc.modelingApproach ?? 'dimensional',
      namingConvention: tc.namingConvention ?? 'snake_case',
      transformationTool: tc.transformationTool ?? 'dbt',
      orchestrationTool: tc.orchestrationTool ?? 'airflow',
      outputFormats: tc.outputFormats && tc.outputFormats.length > 0 ? tc.outputFormats : ['ddl', 'yaml', 'markdown'],
      platformConfig
    };
  }

  /** Assigns `value` onto a (possibly dotted, e.g. `platformConfig.database`) field path. */
  private applyAnswerToField(target: Record<string, unknown>, field: string, value: string): void {
    const parts = field.split('.');
    let obj = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (!obj[key] || typeof obj[key] !== 'object') { obj[key] = {}; }
      obj = obj[key] as Record<string, unknown>;
    }
    obj[parts[parts.length - 1]] = value;
  }

  /** Runs a live connection check + lightweight metadata extraction to build Source Context from an actual connection, instead of a guided description. */
  private async runSourceConnectionCheck(spec: BusinessProblemSpec): Promise<void> {
    if (!this.sourceContextManager) return;
    const settings = this.configManager.getSettings();
    const platform: DataPlatformProvider = settings.defaultProvider ?? 'snowflake';
    const credentials = ConnectionManager.getCredentialsFromSettings(platform, settings as unknown as Record<string, unknown>);
    try {
      if (platform === 'snowflake') {
        const password = await this.configManager.getSecret('autoDataEngineeringHub.snowflakePassword');
        if (password) credentials['password'] = password;
      } else if (platform === 'databricks') {
        const token = await this.configManager.getSecret('autoDataEngineeringHub.databricksToken');
        if (token) credentials['token'] = token;
      }
    } catch { /* best-effort — connect() will surface a clear error if a required secret is missing */ }

    const missing: string[] = [];
    if (platform === 'snowflake') {
      if (!credentials['account']) missing.push('Account');
      if (!credentials['username']) missing.push('Username');
      if (!credentials['warehouse']) missing.push('Warehouse');
      if (!credentials['database']) missing.push('Database');
    } else if (platform === 'databricks') {
      if (!credentials['workspaceUrl']) missing.push('Workspace URL');
      if (!credentials['catalog']) missing.push('Catalog');
    }
    if (missing.length > 0) {
      this.postMessage('error', { message: `Missing connection settings for ${platform}: ${missing.join(', ')}. Configure them in Settings → Connections, or choose "Describe source" instead.` });
      return;
    }

    const connectionManager = new ConnectionManager((msg: string) => this.postLog(msg));
    try {
      this.postLog(`Connecting to ${platform} to build Source Context…`);
      const info = await connectionManager.connect(platform, credentials);
      const snapshot = await connectionManager.extractMetadata({ includeProfiling: false });
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (workspaceRoot) { await connectionManager.persistSchemaContext(snapshot, workspaceRoot); }
      const record: SourceContext = {
        specId: spec.id, specVersion: spec.version, status: 'built', method: 'connected',
        connectionSummary: { platform, database: info.databaseName, schema: info.schemaName, tableCount: snapshot.tables.length, viewCount: snapshot.views.length },
        answers: {}, builtAt: new Date().toISOString()
      };
      await this.sourceContextManager.save(record);
      this.postMessage('sourceContextBuilt', { context: this.sourceContextManager.getContext() });
      this.postLog(`Source Context built from a live connection: ${snapshot.tables.length} tables, ${snapshot.views.length} views.`);
      this.postContextGateStatus();
    } catch (err) {
      this.postMessage('error', { message: `Could not connect to build Source Context: ${err instanceof Error ? err.message : String(err)}. You can choose "Describe source" instead.` });
    } finally {
      connectionManager.dispose();
    }
  }

  /**
   * Classifies Greenfield vs. Brownfield on `spec` (mutating it in place, before
   * it's saved). A prior explicit user override (`implementationTypeOverridden`)
   * is carried forward unchanged across revisions rather than being silently
   * reclassified out from under the user.
   */
  private applyImplementationType(spec: BusinessProblemSpec, previous?: BusinessProblemSpec): void {
    // Every caller of this method just (re)synthesized a draft — a new or changed
    // business problem statement that needs its own Business Problem checkpoint
    // confirmation again (v0.13.0, requirements.md §8.12), regardless of whether
    // a prior version had already been confirmed.
    spec.problemStatementApproved = false;
    if (previous?.implementationTypeOverridden) {
      spec.implementationType = previous.implementationType;
      spec.implementationTypeReason = previous.implementationTypeReason;
      spec.implementationTypeOverridden = true;
      return;
    }
    const classification = classifyImplementationType(spec);
    spec.implementationType = classification.implementationType;
    spec.implementationTypeReason = classification.reason;
    spec.implementationTypeOverridden = false;
  }

  /**
   * Syncs the Context Layer from a newly-approved specification, then writes a
   * durable snapshot of it. Runs automatically inside `approveSpec` — Generate
   * Plan only becomes reachable after this, so the Context Layer is always
   * current for the spec version a plan is about to be generated from.
   */
  private async syncContextFromApprovedSpec(spec: BusinessProblemSpec): Promise<void> {
    if (!this.synthesisPipeline) { return; }
    try {
      const result = await this.synthesisPipeline.synthesizeFromSpec(spec);
      this.postContextUpdate();
      this.postLog(`Context Layer synced from approved specification v${spec.version} (${result.nodes} node(s)).`);
      await this.writeContextSnapshot(spec);
    } catch (err) {
      this.postLog(`Context sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Writes a durable, human-readable record of the Context Layer content that
   * fed (or will feed) plan generation for this spec version, to
   * `.ai-context/context/snapshots/<specId>.v<version>.md` — committed
   * alongside the spec, unlike the transient compiled graph
   * (`.ai-context/derived/graph.json`, gitignored).
   */
  private async writeContextSnapshot(spec: BusinessProblemSpec): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri;
    const snapshotDir = vscode.Uri.joinPath(workspaceRoot, '.ai-context', 'context', 'snapshots');
    const fileName = `${spec.id}.v${spec.version}.md`;
    const target = vscode.Uri.joinPath(snapshotDir, fileName);
    const contextBody = this.contextFileManager?.buildContextPrompt() || '_No context nodes were derived._';
    const lines = [
      `# Context Snapshot — ${spec.id} v${spec.version}`,
      '',
      `Generated: ${new Date().toISOString()}`,
      `Implementation type: ${spec.implementationType ?? 'unclassified'}${spec.implementationTypeReason ? ` — ${spec.implementationTypeReason}` : ''}`,
      '',
      'This is the durable record of what the Context Layer contained when this specification version was approved — the same content injected into plan generation prompts.',
      '',
      contextBody
    ];
    await vscode.workspace.fs.createDirectory(snapshotDir);
    const tempUri = vscode.Uri.joinPath(snapshotDir, `.${fileName}.tmp.${Date.now()}`);
    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(lines.join('\n') + '\n', 'utf8'));
    await vscode.workspace.fs.rename(tempUri, target, { overwrite: true });
    this.postLog(`Context snapshot written: .ai-context/context/snapshots/${fileName}`);
  }

  /**
   * Drafts a new Business Problem Specification from a natural-language description.
   * This is the first responsibility of AutoDE in the spec-driven flow.
   */
  private async draftSpec(prompt: string, previous?: BusinessProblemSpec): Promise<void> {
    const spec = await this.hub.generateSpec(prompt, previous);
    await this.ensureActiveProblem(spec.problemStatement);
    if (!this.specManager) { this.postLog('Spec manager is not initialized.'); return; }
    this.applyImplementationType(spec, previous);
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
    this.applyImplementationType(spec, previous);
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

  /** `.ai-context/primitives/` — the workspace override directory for Tier-2 primitive definitions (Phase 2B-ii/iii). */
  private primitivesOverrideDir(): string | undefined {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) return undefined;
    return vscode.Uri.joinPath(workspaceRoot, '.ai-context', 'primitives').fsPath;
  }

  /**
   * Loads Tier-2 primitive definitions (bundled + workspace override, later
   * wins — the same merge shape as `ensureSkills()`) and registers them into
   * the shared `TRANSFORM_PRIMITIVES` registry. Idempotent per sidebar
   * session unless `force` is set (used after a publish/deprecate action, so
   * the just-changed definition is reflected immediately).
   */
  private ensurePrimitivesLoaded(force = false): void {
    if (this.primitivesLoaded && !force) return;
    resetDeclarativePrimitives();
    resetVersionedPrimitives();
    const bundledDir = vscode.Uri.joinPath(this.context.extensionUri, 'primitive-definitions').fsPath;
    const overrideDir = this.primitivesOverrideDir();
    const bundled = loadPrimitiveDefinitionsFromDirectory(bundledDir);
    const overrides = overrideDir ? loadPrimitiveDefinitionsFromDirectory(overrideDir) : { definitions: [], errors: [] };
    const merged = mergePrimitiveDefinitions(bundled.definitions, overrides.definitions);
    this.primitiveDefinitionsByKind = new Map(merged.map((def) => [def.kind, def]));
    registerPrimitives(merged.map((def) => createDeclarativePrimitive(def)));
    for (const err of [...bundled.errors, ...overrides.errors]) {
      this.postLog(`Skipped an invalid primitive definition (${err.file}): ${err.error}`);
    }
    // Also load every archived revision under history/ so an approved Pipeline Spec's
    // TransformSpec.primitiveVersion pin can still resolve after a newer version is
    // published (Phase 2B-iv) — these are registered for version-pinned lookup only,
    // never added to the live catalog TRANSFORM_PRIMITIVES/postPrimitivesList shows.
    if (overrideDir) {
      const historyDir = vscode.Uri.joinPath(vscode.Uri.file(overrideDir), 'history').fsPath;
      const archived = loadPrimitiveDefinitionsFromDirectory(historyDir);
      for (const def of archived.definitions) {
        registerPrimitiveVersion(createDeclarativePrimitive(def));
      }
    }
    this.primitivesLoaded = true;
  }

  /** Posts the full Tier-1 + Tier-2 primitive catalog to the sidebar's Primitives palette section. */
  private postPrimitivesList(): void {
    this.ensurePrimitivesLoaded();
    const items = listPrimitives().map((p) => ({
      kind: p.kind,
      description: p.description,
      tier: p.status ? 'declarative' : 'core',
      status: p.status ?? 'published',
      selectable: isSelectable(p)
    }));
    this.postMessage('primitivesList', { items, managementEnabled: !!this.configManager.getSettings().primitiveManagementEnabled });
  }

  /** A live snapshot of discovery progress (v0.13.0 follow-up) — see `discoveryProgress.ts`. */
  private buildDiscoveryProgress(): DiscoveryProgress | undefined {
    const engine = this.specOpsEngine;
    if (!engine) { return undefined; }
    return buildDiscoveryProgressPure(engine.getSession(), this.ensureSkills());
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
          this.postMessage('specQuestions', {
            questions: this.pendingSpecQuestions.map((q) => ({ ...q, skillLabel: skillNameForField(q.field, this.ensureSkills()) })),
            progress: this.buildDiscoveryProgress()
          });
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
      await this.ensureActiveProblem(spec.problemStatement);
      this.applyImplementationType(spec, previous);
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
    this.postMessage('specQuestion', {
      question: { ...question, skillLabel: skillNameForField(question.field, this.ensureSkills()) },
      progress: this.buildDiscoveryProgress()
    });
  }

  private postMessage(type: string, payload: object = {}): void {
    const recordPayload = payload as Record<string, unknown>;
    this.recordAssistantMessage(type, recordPayload);
    this.view?.webview.postMessage({ type, ...recordPayload });
  }

  /**
   * Persists the assistant-visible content of select outbound message types
   * into the active chat session's transcript (Phase F). Fire-and-forget —
   * `postMessage` itself stays synchronous so no call site needs to change.
   */
  private recordAssistantMessage(type: string, payload: Record<string, unknown>): void {
    if (!this.chatSessionManager || !this.activeChatId) { return; }
    let content: string | undefined;
    if (type === 'chatResponse' && typeof payload.message === 'string') {
      content = payload.message;
    } else if (type === 'specDrafted' && payload.spec) {
      const spec = payload.spec as BusinessProblemSpec;
      content = `[Specification ${payload.revised ? 'revised' : 'drafted'} — v${spec.version}] ${spec.problemStatement}`;
    } else if (type === 'specApproved' && payload.spec) {
      content = `[Specification v${(payload.spec as BusinessProblemSpec).version} approved]`;
    } else if (type === 'specQuestion' && payload.question) {
      content = `[Question] ${(payload.question as SpecIntakeQuestion).prompt}`;
    } else if (type === 'specQuestions' && Array.isArray(payload.questions)) {
      content = `[Questions] ${(payload.questions as SpecIntakeQuestion[]).map((q) => q.prompt).join(' / ')}`;
    }
    if (!content) { return; }
    this.chatSessionManager.appendMessage(this.activeChatId, { role: 'ai', content, at: new Date().toISOString() }).catch(() => { /* best-effort */ });
  }

  private getHtmlForSidebar(webview: vscode.Webview): string {
    const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sidebar.html');
    return applyCspNonce(fs.readFileSync(htmlPath.fsPath, 'utf8'), webview.cspSource);
  }
}