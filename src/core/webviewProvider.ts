import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { ConfigurationManager } from './configManager';
import { DataAgentHubHub } from './agentHub';
import { WebviewMessage, PlanState, DataAgentHubSettings, SpecEngineAction, SpecIntakeQuestion, SkillDefinition, BusinessProblemSpec, IntakeSession, IntakeAttachment, ContextQuestion, TargetContext, SourceContext, SourceContextEntry, DataPlatformProvider, ToolExecutionMode, EntityMapping, MappingContext } from '../engine/types';
import { EXTENSION_ID } from './extensionIdentity';
import { SpecOpsEngine, createIntakeSession } from './specOps';
import { SkillRegistry, loadSkillsFromDirectory } from '../engine/skills/skillRegistry';
import { composeSynthesisPrompt } from './specOpsPrompts';
import { buildDiscoveryProgress as buildDiscoveryProgressPure, skillNameForField, DiscoveryProgress } from './discoveryProgress';
import { GraphManager } from '../context/GraphManager';
import { BaseNode, GraphEdge } from '../engine/context/types';
import { ContextFileManager } from '../context/ContextFileManager';
import type { CatalogFetcher } from '../engine/context/catalog';
import { ContextValidator } from '../engine/context/ContextValidator';
import { SourceRegistry } from '../context/SourceRegistry';
import { SynthesisPipeline } from '../context/SynthesisPipeline';
import { SpecManager } from '../context/SpecManager';
import { ArtifactWriter } from '../context/ArtifactWriter';
import { scanArtifactStaleness } from '../context/ArtifactStalenessScanner';
import { ChatSessionManager } from '../context/ChatSessionManager';
import { TargetContextManager } from '../context/TargetContextManager';
import { SourceContextManager } from '../context/SourceContextManager';
import { MappingContextManager } from '../context/MappingContextManager';
import { SemanticLayerManager } from '../context/SemanticLayerManager';
import { ActiveProblemManager } from '../context/ActiveProblemManager';
import { AttachmentStore } from '../context/AttachmentStore';
import { BusinessPackManager } from '../context/BusinessPackManager';
import { DOCUMENT_ROLES, DocumentRole } from '../engine/context/pack';
import type { ProbeExecutor } from '../engine/context/probes';
import { filterInterviewQuestions, knownFacts, knownFactsBlock } from '../engine/context/discoveryGaps';
import { PipelineSpecManager } from '../context/PipelineSpecManager';
import { ContextFileWatcher, normalizeFsPath } from '../context/ContextFileWatcher';
import { createVscodeFileIo } from '../context/vscodeFileIo';
import { RevisionConflictError, setRevisionConflictHandler } from '../engine/context/contextStore';
import { ContextPack, ContextPackProvider, PackPurpose, renderPackManifest } from '../engine/context/contextPack';
import { explainManifest, GroundingManifest, manifestStaleReasons } from '../engine/grounding/manifest';
import { createHash } from 'node:crypto';
import { generateDesignDoc } from '../engine/pipelineSpec/designDocGenerator';
import { generateProblemSlug } from './problemSlug';
import { listPrimitives, isSelectable, registerPrimitives, resetDeclarativePrimitives, registerPrimitiveVersion, resetVersionedPrimitives, compileTransformSpec } from '../engine/transforms/registry';
import { loadPrimitiveDefinitionsFromDirectory, mergePrimitiveDefinitions } from '../engine/transforms/declarative/loader';
import { createDeclarativePrimitive } from '../engine/transforms/declarative/adapter';
import { publishPrimitiveDefinition, deprecatePrimitiveDefinition } from '../engine/transforms/declarative/lifecycle';
import { PrimitiveDefinition } from '../engine/transforms/declarative/types';
import { ConnectionManager } from '../engine/platform/ConnectionManager';
import { getCliDescriptor, resolveCredential, CredentialReference } from './credentials';
import { applyCspNonce } from './webviewSecurity';
import { classifyImplementationType } from './implementationType';
import { buildTargetContextQuestions } from './targetContextQuestions';
import { buildSourceContextQuestions } from './sourceContextQuestions';

export class DataAgentHubWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'autoDataEngineeringHubSidebar';

  private view?: vscode.WebviewView;
  private graphManager: GraphManager;
  private contextFileManager?: ContextFileManager;
  private catalogFetcher: CatalogFetcher | undefined;
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
  private mappingContextManager?: MappingContextManager;
  private semanticLayerManager?: SemanticLayerManager;
  /**
   * The most recent live connection outcome, per role — brownfield work
   * routinely needs both a source (to read from) and a target (to write to),
   * and `ConnectionManager` itself only ever holds one live connection at a
   * time, so this is the one place both roles' last-known status lives for the
   * UI. Drives the top status pills; the LLM-facing side of the same event
   * goes through `ContextFileManager.setRuntimeFact()` instead (see
   * `notifyConnectionStatus()`), so a UI concern and a prompt-content concern
   * don't have to be kept in sync by hand at each call site.
   */
  private connectionStatus: Record<'source' | 'target', { connected: boolean; platform?: string; detail?: string }> = {
    source: { connected: false },
    target: { connected: false }
  };
  private pipelineSpecManager?: PipelineSpecManager;
  private attachmentStore?: AttachmentStore;
  /** Phase C4a: the active problem's business-problem pack. */
  private packManager?: BusinessPackManager;
  private problemRoot?: vscode.Uri;
  /** Phase C4a: probes on the source connection (set by extension.ts when it connects). */
  private liveProbes?: ProbeExecutor;
  private activeProblemManager?: ActiveProblemManager;
  /** `undefined` = no active business problem yet (fresh workspace, or "Start New" before the first draft). */
  private activeProblemId?: string;
  private workspaceRoot?: vscode.Uri;
  private contextFileWatcher?: ContextFileWatcher;

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

  /** "AutoDE: Connect to Data Platform" command proxy (Phase 3a-ii). */
  public async triggerConnectToDataPlatform(): Promise<void> {
    await this.connectToDataPlatform();
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
        contextLayerText: this.contextPackText('spec', [spec.problemStatement, ...(spec.objectives ?? [])].join('\n'), 'Pipeline Spec synthesis'),
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
    // v0.25.0 (docs/mcp-engine-requirements.md §8): keep every cached spec/context
    // document in step with the file on disk when another process edits it, and
    // never silently overwrite such an edit from a stale in-memory copy.
    setRevisionConflictHandler((conflict) => { void this.handleRevisionConflict(conflict); });
    if (!this.contextFileWatcher) {
      this.contextFileWatcher = new ContextFileWatcher(workspaceRoot, (uri) => { void this.onContextFileChanged(uri); });
      this.context.subscriptions.push(this.contextFileWatcher);
    }
    this.contextFileManager = new ContextFileManager(
      workspaceRoot,
      this.graphManager,
      (msg: string) => this.postLog(msg),
      this.createContextValidator()
    );
    this.configureContextFileManager(this.contextFileManager);
    try {
      await this.contextFileManager.initialize();
      this.postContextUpdate();
    } catch (err) {
      this.postLog(`Context initialization failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // C3 (v0.30.0): plan steps get task-scoped context packs and grounding manifests.
    this.hub.setContextProvider(this.createContextPackProvider(), (title, pack) => this.contextFileManager?.recordPack(title, pack));

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

    this.postMessage('settingsLoaded', await this.buildSettingsMessagePayload());
  }

  /**
   * Assembles the `settingsLoaded` payload: plain settings, active-LLM-provider
   * status, and (non-secret) flags for whether a given secret is already stored —
   * never the secret value itself — so the webview can prepopulate what's safe to
   * show (account/username/etc., already handled below) while still letting a
   * write-only secret field indicate "already saved" without ever round-tripping
   * the actual password/token back into the page.
   */
  private async buildSettingsMessagePayload(): Promise<Record<string, unknown>> {
    const settings = this.configManager.getSettings();
    let merged: Record<string, unknown> = { ...settings };
    try {
      const info = await this.detectLanguageModel();
      if (info) { merged = { ...merged, copilotInfo: info, languageModelInfo: info }; }
    } catch { /* best-effort — language model status is a nice-to-have here */ }
    try {
      merged.snowflakeHasPassword = !!(await this.configManager.getSnowflakePassword());
    } catch { /* best-effort */ }
    try {
      merged.targetSnowflakeHasPassword = !!(await this.configManager.getTargetSnowflakePassword());
    } catch { /* best-effort */ }
    try {
      merged.databricksHasToken = !!(await this.configManager.getDatabricksToken());
    } catch { /* best-effort */ }
    try {
      merged.targetDatabricksHasToken = !!(await this.configManager.getTargetDatabricksToken());
    } catch { /* best-effort */ }
    return merged;
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
      this.contextFileManager?.setActiveSpecId(undefined);
      this.specManager = undefined;
      this.targetContextManager = undefined;
      this.sourceContextManager = undefined;
      this.mappingContextManager = undefined;
      this.semanticLayerManager = undefined;
      this.pipelineSpecManager = undefined;
      this.attachmentStore = undefined;
      this.packManager = undefined;
      this.problemRoot = undefined;
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
    this.mappingContextManager = new MappingContextManager(contextRoot, (msg: string) => this.postLog(msg));
    this.semanticLayerManager = new SemanticLayerManager(contextRoot, this.graphManager, (msg: string) => this.postLog(msg));
    this.pipelineSpecManager = new PipelineSpecManager(contextRoot, (msg: string) => this.postLog(msg));
    this.attachmentStore = new AttachmentStore(contextRoot);
    this.problemRoot = contextRoot;
    this.packManager = this.contextFileManager ? this.createPackManager(contextRoot) : undefined;
    try {
      await this.packManager?.load();
    } catch (err) {
      this.postLog(`Business-problem pack could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await this.specManager.initialize();
      await this.targetContextManager.initialize();
      await this.sourceContextManager.initialize();
      await this.mappingContextManager.initialize();
      await this.semanticLayerManager.initialize();
      await this.pipelineSpecManager.initialize();
      const existingSpec = this.specManager.getSpec();
      this.contextFileManager?.setActiveSpecId(existingSpec?.id);
      if (existingSpec) {
        this.hub.setSpec(existingSpec.id, existingSpec.version);
        if (existingSpec.status === 'approved') {
          if (this.synthesisPipeline) {
            await this.synthesisPipeline.synthesizeFromSpec(existingSpec);
            await this.contextFileManager?.persistCompiledGraph();
          }
          this.hub.inferPhasesFromSpec(existingSpec, this.contextPackText('spec', existingSpec.problemStatement, 'Phase inference'));
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

            // Connection status (both roles) reaches this for free via
            // ContextFileManager's runtime facts — see notifyConnectionStatus().
            // Phase K2: load (query-through) and promote what the message is about before its pack is built.
            try { await this.contextFileManager?.prepareContext({ purpose: 'chat', query: chatMessage }); } catch (err) { this.postLog(`Loading context failed (the pack reports what is missing): ${err instanceof Error ? err.message : String(err)}`); }
            const combinedContext = this.contextPackText('chat', chatMessage, `Chat: ${chatMessage.slice(0, 60)}`);
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
          if (!objective.trim()) { this.postLog('A plan requires a user objective.'); return; }
          // Same shared source as chat — connection status (both roles) is
          // included automatically via ContextFileManager's runtime facts.
          const combinedContext = this.contextPackText('plan', objective, 'Plan generation');
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
            snowflakeCliPath: typeof settings.snowflakeCliPath === 'string' ? settings.snowflakeCliPath : undefined,
            // Pre-existing gap, closed in passing: the source Databricks settings were
            // never in this whitelist at all (the Databricks card has never been fully
            // wired to save), unlike Snowflake's. Added here for consistency with the
            // new target-side fields below, which need the same shape either way.
            defaultDatabricksWorkspaceUrl: typeof settings.defaultDatabricksWorkspaceUrl === 'string' ? settings.defaultDatabricksWorkspaceUrl : undefined,
            defaultDatabricksHttpPath: typeof settings.defaultDatabricksHttpPath === 'string' ? settings.defaultDatabricksHttpPath : undefined,
            defaultDatabricksCatalog: typeof settings.defaultDatabricksCatalog === 'string' ? settings.defaultDatabricksCatalog : undefined,
            defaultDatabricksSchema: typeof settings.defaultDatabricksSchema === 'string' ? settings.defaultDatabricksSchema : undefined,
            defaultDatabricksCatalogType: settings.defaultDatabricksCatalogType === 'auto' || settings.defaultDatabricksCatalogType === 'unity' || settings.defaultDatabricksCatalogType === 'hive_metastore' ? settings.defaultDatabricksCatalogType : undefined,
            databricksCliPath: typeof settings.databricksCliPath === 'string' ? settings.databricksCliPath : undefined,
            // ── Target connection (v0.19.0) — mirrors the source fields above exactly ──
            defaultTargetProvider: settings.defaultTargetProvider === 'snowflake' || settings.defaultTargetProvider === 'databricks' || settings.defaultTargetProvider === 'bigquery' || settings.defaultTargetProvider === 'redshift' || settings.defaultTargetProvider === 'synapse' || settings.defaultTargetProvider === 'other' ? settings.defaultTargetProvider : undefined,
            defaultTargetSnowflakeAccount: typeof settings.defaultTargetSnowflakeAccount === 'string' ? settings.defaultTargetSnowflakeAccount : undefined,
            defaultTargetSnowflakeUsername: typeof settings.defaultTargetSnowflakeUsername === 'string' ? settings.defaultTargetSnowflakeUsername : undefined,
            defaultTargetSnowflakeWarehouse: typeof settings.defaultTargetSnowflakeWarehouse === 'string' ? settings.defaultTargetSnowflakeWarehouse : undefined,
            defaultTargetSnowflakeDatabase: typeof settings.defaultTargetSnowflakeDatabase === 'string' ? settings.defaultTargetSnowflakeDatabase : undefined,
            defaultTargetSnowflakeSchema: typeof settings.defaultTargetSnowflakeSchema === 'string' ? settings.defaultTargetSnowflakeSchema : undefined,
            defaultTargetSnowflakeRole: typeof settings.defaultTargetSnowflakeRole === 'string' ? settings.defaultTargetSnowflakeRole : undefined,
            defaultTargetSnowflakeAuthMode: settings.defaultTargetSnowflakeAuthMode === 'username-password' || settings.defaultTargetSnowflakeAuthMode === 'oauth' || settings.defaultTargetSnowflakeAuthMode === 'key-pair' || settings.defaultTargetSnowflakeAuthMode === 'external-browser' || settings.defaultTargetSnowflakeAuthMode === 'mcp' ? settings.defaultTargetSnowflakeAuthMode : undefined,
            targetSnowflakePrivateKeyPath: typeof settings.targetSnowflakePrivateKeyPath === 'string' ? settings.targetSnowflakePrivateKeyPath : undefined,
            targetSnowflakeCliPath: typeof settings.targetSnowflakeCliPath === 'string' ? settings.targetSnowflakeCliPath : undefined,
            defaultTargetDatabricksWorkspaceUrl: typeof settings.defaultTargetDatabricksWorkspaceUrl === 'string' ? settings.defaultTargetDatabricksWorkspaceUrl : undefined,
            defaultTargetDatabricksHttpPath: typeof settings.defaultTargetDatabricksHttpPath === 'string' ? settings.defaultTargetDatabricksHttpPath : undefined,
            defaultTargetDatabricksCatalog: typeof settings.defaultTargetDatabricksCatalog === 'string' ? settings.defaultTargetDatabricksCatalog : undefined,
            defaultTargetDatabricksSchema: typeof settings.defaultTargetDatabricksSchema === 'string' ? settings.defaultTargetDatabricksSchema : undefined,
            defaultTargetDatabricksCatalogType: settings.defaultTargetDatabricksCatalogType === 'auto' || settings.defaultTargetDatabricksCatalogType === 'unity' || settings.defaultTargetDatabricksCatalogType === 'hive_metastore' ? settings.defaultTargetDatabricksCatalogType : undefined,
            targetDatabricksCliPath: typeof settings.targetDatabricksCliPath === 'string' ? settings.targetDatabricksCliPath : undefined,
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
          if (typeof message.targetSnowflakePassword === 'string') { await this.configManager.setTargetSnowflakePassword(message.targetSnowflakePassword); }
          if (typeof message.targetSnowflakePrivateKeyPassphrase === 'string') { await this.configManager.setTargetSnowflakePrivateKeyPassphrase(message.targetSnowflakePrivateKeyPassphrase); }
          // Previously dead: setDatabricksToken() existed but nothing in the UI ever
          // called it, since the Databricks card had no real token field.
          if (typeof message.databricksToken === 'string') { await this.configManager.setDatabricksToken(message.databricksToken); }
          if (typeof message.targetDatabricksToken === 'string') { await this.configManager.setTargetDatabricksToken(message.targetDatabricksToken); }
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
        case 'testConnection': { this.postLog('Connecting to source database...'); try { await vscode.commands.executeCommand(`${EXTENSION_ID}.testConnection`); } catch { this.postLog('Connect command not yet registered.'); } break; }
        case 'disconnectDataPlatform': { try { await vscode.commands.executeCommand(`${EXTENSION_ID}.disconnectDataPlatform`); } catch { this.postLog('Disconnect command not yet registered.'); } break; }
        case 'testTargetConnection': { this.postLog('Connecting to target database...'); try { await vscode.commands.executeCommand(`${EXTENSION_ID}.testTargetConnection`); } catch { this.postLog('Test target connection command not yet registered.'); } break; }
        case 'disconnectTargetDataPlatform': { try { await vscode.commands.executeCommand(`${EXTENSION_ID}.disconnectTargetDataPlatform`); } catch { this.postLog('Disconnect target command not yet registered.'); } break; }
        case 'browseSourceDatabase': { try { await vscode.commands.executeCommand(`${EXTENSION_ID}.browseSourceDatabase`); } catch { this.postLog('Browse source database command not yet registered.'); } break; }
        case 'browseTargetDatabase': { try { await vscode.commands.executeCommand(`${EXTENSION_ID}.browseTargetDatabase`); } catch { this.postLog('Browse target database command not yet registered.'); } break; }
        case 'ingestFileAsSourceContext': { try { await vscode.commands.executeCommand(`${EXTENSION_ID}.ingestFileAsSourceContext`); } catch { this.postLog('File ingestion command not yet registered.'); } break; }
        case 'sourceAssessment': {
          // Previously a second, parallel implementation that only reloaded
          // whatever was already on disk and unconditionally reported success —
          // it never connected to anything or extracted anything live, which is
          // exactly why "Source Assessment" could report "complete" while chat
          // still had zero real schema. Delegate to the one real command instead
          // (same pattern `testConnection`'s case already uses), then force an
          // immediate reindex so the freshly-written schema-graph.json is picked
          // up now rather than waiting on the debounced file watcher.
          this.postLog('Running source assessment...');
          const result = await vscode.commands.executeCommand<{ success: boolean; tableCount?: number; viewCount?: number; error?: string }>(
            `${EXTENSION_ID}.sourceAssessment`
          );
          if (result?.success && this.contextFileManager) {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri;
            const activeSpecId = this.contextFileManager.getActiveSpecId();
            this.contextFileManager.dispose();
            this.contextFileManager = new ContextFileManager(workspaceRoot, this.graphManager, (msg: string) => this.postLog(msg), this.createContextValidator());
            this.configureContextFileManager(this.contextFileManager);
            this.contextFileManager.setActiveSpecId(activeSpecId);
            await this.contextFileManager.initialize();
            this.postContextUpdate();
          }
          this.postMessage('sourceAssessmentComplete', result ?? { success: false, error: 'Source Assessment command is not available.' });
          break;
        }
        case 'syncMetadata': { this.postLog('Syncing database metadata...'); try { await vscode.commands.executeCommand(`${EXTENSION_ID}.syncMetadata`); } catch { this.postLog('Sync metadata command not yet registered.'); } break; }
        case 'runToolSkill': {
          const skillId = typeof message.skillId === 'string' ? message.skillId.trim() : '';
          const instruction = typeof message.instruction === 'string' ? message.instruction.trim() : '';
          if (!skillId || !instruction) { this.postLog('Usage: /skill <skillId> <instruction>'); break; }
          this.postLog(`Running skill "${skillId}"…`);
          try {
            const result = await this.hub.runToolSkill(skillId, instruction, this.contextPackText('step', instruction, `Skill ${skillId}: ${instruction.slice(0, 50)}`));
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
              this.hub.setTargetEnvironment(targetConfig as import('../engine/types').TargetEnvironment);
              this.postLog('Target environment updated.');
              this.postMessage('targetConfigUpdated', { success: true });
            } catch (err) { this.postLog(`Failed to update target config: ${err instanceof Error ? err.message : String(err)}`); }
          }
          break;
        }
        case 'settingsLoaded': {
          this.postMessage('settingsLoaded', await this.buildSettingsMessagePayload());
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
            const contextSummary = this.contextPackText('spec', approved.problemStatement, 'Phase inference');
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
            this.hub.inferPhasesFromSpec(spec, this.contextPackText('spec', spec.problemStatement, 'Phase inference'));
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
            specId: spec.id, specVersion: spec.version, status: 'built',
            sources: [{
              connectionId: 'described',
              method: 'described',
              sourceType: (answerMap.sourceType as SourceContextEntry['sourceType']) || undefined,
              description: description || undefined
            }],
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
          if (existing?.sources.some((s) => s.method === 'connected')) { await this.runSourceConnectionCheck(spec); break; }
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
          await this.reportFactStaleness();
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

  /**
   * A `.ai-context` file changed on disk (debounced by `ContextFileWatcher`).
   * Our own writes are filtered out by each manager's `reload()` — the file's
   * revision still matches what that manager last wrote, so it reports
   * "unchanged" and nothing below runs.
   */
  private async onContextFileChanged(uri: vscode.Uri): Promise<void> {
    try {
      const key = normalizeFsPath(uri.fsPath);
      if (this.activeProblemManager && key === normalizeFsPath(this.activeProblemManager.getPointerUri().fsPath)) {
        const problemId = await this.activeProblemManager.getActiveProblemId();
        if (problemId !== this.activeProblemId) {
          this.postLog(`Active business problem changed on disk (${problemId ?? 'none'}) — switching.`);
          await this.activateProblem(problemId);
        }
        return;
      }
      await this.reloadContextFile(key);
    } catch (err) {
      this.postLog(`Reloading ${path.basename(uri.fsPath)} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Routes a changed path to the manager that owns it, reloads, and refreshes whatever depends on it. Returns false when no manager owns the path. */
  private async reloadContextFile(key: string): Promise<boolean> {
    const owners: Array<{ uri?: vscode.Uri; reload?: () => Promise<boolean>; after: () => Promise<void> | void }> = [
      { uri: this.specManager?.getSpecUri(), reload: () => this.specManager!.reload(), after: () => this.afterSpecReloaded() },
      {
        uri: this.pipelineSpecManager?.getSpecUri(), reload: () => this.pipelineSpecManager!.reload(),
        after: () => { this.hub.pauseForExternalChange('The Pipeline Spec changed on disk during execution'); this.postContextGateStatus(); }
      },
      { uri: this.sourceContextManager?.getFileUri(), reload: () => this.sourceContextManager!.reload(), after: () => this.postContextGateStatus() },
      { uri: this.targetContextManager?.getFileUri(), reload: () => this.targetContextManager!.reload(), after: () => this.postContextGateStatus() },
      { uri: this.mappingContextManager?.getFileUri(), reload: () => this.mappingContextManager!.reload(), after: () => this.postContextGateStatus() },
      { uri: this.semanticLayerManager?.getFileUri(), reload: () => this.semanticLayerManager!.reload(), after: () => undefined }
    ];
    const owner = owners.find((o) => o.uri && normalizeFsPath(o.uri.fsPath) === key);
    if (!owner || !owner.reload) return false;
    if (await owner.reload()) {
      await owner.after();
    }
    return true;
  }

  private async afterSpecReloaded(): Promise<void> {
    const spec = this.specManager?.getSpec();
    if (spec) this.hub.setSpec(spec.id, spec.version);
    this.hub.pauseForExternalChange('The Business Problem Specification changed on disk during execution');
    this.postSpec();
    this.postContextGateStatus();
    if (this.workspaceRoot) {
      const report = await scanArtifactStaleness(this.workspaceRoot, spec ? { id: spec.id, version: spec.version } : undefined);
      this.postMessage('artifactStaleness', { report });
      await this.reportFactStaleness();
    }
  }

  /**
   * Fact-level staleness (C3, §8.3): every artifact whose grounding manifest
   * relies on an assertion that has since been superseded, rejected or sent
   * to review, with the reason — e.g. "stg_orders.sql is stale: grain changed".
   */
  public async reportFactStaleness(): Promise<Array<{ artifact: string; reasons: string[] }>> {
    const root = this.artifactRootForProblem();
    const ledger = this.contextFileManager?.getLedger();
    if (!root || !ledger) return [];
    const stale: Array<{ artifact: string; reasons: string[] }> = [];
    for (const uri of await findManifests(root)) {
      try {
        const manifest = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')) as GroundingManifest;
        const reasons = manifestStaleReasons(manifest, (id) => ledger.get(id));
        if (reasons.length) stale.push({ artifact: manifest.artifact, reasons });
      } catch { /* unreadable manifest — skipped */ }
    }
    for (const s of stale) this.postLog(`${s.artifact} is stale: ${s.reasons.join('; ')}`);
    if (stale.length) this.postMessage('artifactFactStaleness', { stale });
    return stale;
  }

  /** The active problem's artifact directory (where manifests live). */
  private artifactRootForProblem(): vscode.Uri | undefined {
    const contextRoot = this.activeProblemId && this.activeProblemManager ? this.activeProblemManager.problemRoot(this.activeProblemId) : this.workspaceRoot;
    return contextRoot ? ArtifactWriter.resolveArtifactDirectory(contextRoot) : undefined;
  }

  /** Estate bridges for `extension.ts` (Phase K1). */
  public getEstate() {
    return this.contextFileManager?.getEstate();
  }

  public resolveConnectionIdentity(connectionId: string, role: 'source' | 'target' = 'source') {
    const r = this.contextFileManager?.resolveConnection(connectionId);
    return r ? { ...r, identity: { ...r.identity, role: this.contextFileManager?.getEstate().systems.find((s) => s.id === r.identity.system)?.role ?? role } } : undefined;
  }

  public resolveFileIdentity(filePath: string) {
    return this.contextFileManager?.resolveFile(filePath);
  }

  public bindToSystem(binding: import('../engine/context/estate').EstateBinding, systemName?: string, role: 'source' | 'target' | 'both' = 'source'): void {
    this.contextFileManager?.bindToSystem(binding, systemName, role);
  }

  /** "AutoDE: What the Agent Saw" — the recent context packs, newest first. */
  public getRecentContextPacks(): ReadonlyArray<{ title: string; at: string; pack: ContextPack }> {
    return this.contextFileManager?.getRecentPacks() ?? [];
  }

  public renderContextPack(entry: { title: string; pack: ContextPack }): string {
    return renderPackManifest(entry.pack, entry.title);
  }

  /** "AutoDE: Explain This Artifact" for a file: its manifest, as a readable chain. Undefined when it has none. */
  public async explainArtifact(fileUri: vscode.Uri): Promise<string | undefined> {
    const manifestUri = fileUri.fsPath.endsWith('.grounding.json') ? fileUri : vscode.Uri.file(`${fileUri.fsPath}.grounding.json`);
    let manifest: GroundingManifest;
    try {
      manifest = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(manifestUri)).toString('utf8')) as GroundingManifest;
    } catch {
      return undefined;
    }
    const ledger = this.contextFileManager?.getLedger();
    return explainManifest(manifest, (id) => ledger?.get(id));
  }

  /**
   * A save was refused because the file changed on disk first. The change the
   * user just made was not written; offer to load the disk version, or to write
   * theirs over it — never decide silently.
   */
  private async handleRevisionConflict(conflict: RevisionConflictError): Promise<void> {
    const name = path.basename(conflict.filePath);
    this.postLog(`${conflict.label} (${name}) changed on disk since AutoDE loaded it — your change was not saved.`);
    const choice = await vscode.window.showWarningMessage(
      `${conflict.label} (${name}) changed on disk since AutoDE loaded it. Your latest change was not saved.`,
      'Reload from Disk',
      'Overwrite'
    );
    const key = normalizeFsPath(conflict.filePath);
    if (choice === 'Overwrite') {
      await conflict.overwrite();
      this.postLog(`Overwrote ${name} with AutoDE's version — the external change was discarded.`);
      await this.reloadContextFile(key);
    } else if (choice === 'Reload from Disk') {
      await this.reloadContextFile(key);
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

  /** Lets `extension.ts`'s command handlers (e.g. `testConnection`) surface progress/results into the chat log, not just a native VS Code notification the webview never sees. */
  public logToChat(message: string): void {
    this.postLog(message);
  }

  /**
   * Lets `extension.ts`'s command handlers (e.g. the database/schema browse
   * picker, Step 4) push a fresh `settingsLoaded` payload after changing
   * settings directly via `ConfigurationManager`, bypassing the webview's own
   * `updateSettings` message — otherwise the panel's displayed fields would
   * silently go stale until the next manual reload.
   */
  public async refreshSettingsInWebview(): Promise<void> {
    this.postMessage('settingsLoaded', await this.buildSettingsMessagePayload());
  }

  /**
   * Adds file-derived nodes/edges (Step 5 — CSV/JSON/DDL ingestion, run from
   * `extension.ts` since it owns the file-picker/parsing flow) into the same
   * shared `GraphManager` live-connection extraction already writes to, then
   * persists and refreshes the palette — so an ingested file's tables render
   * everywhere `ContextFileManager.buildContextPrompt()` already does, with
   * zero special-casing needed downstream.
   */
  public async ingestFileIntoGraph(nodes: BaseNode[], edges: GraphEdge[]): Promise<void> {
    if (this.contextFileManager) {
      // Phase K2: into the catalog; into the working set as far as it fits.
      await this.contextFileManager.ingestParsed(nodes, edges);
    } else {
      for (const node of nodes) { await this.graphManager.addNode(node); }
      for (const edge of edges) { await this.graphManager.addEdge(edge); }
    }
    this.postContextUpdate();
  }

  /** Phase K2: the source connection's live lookups (query-through, refresh on use); `undefined` when disconnected. */
  public setCatalogFetcher(fetcher: CatalogFetcher | undefined): void {
    this.catalogFetcher = fetcher;
    this.contextFileManager?.setCatalogFetcher(fetcher);
  }

  /** Phase C4a: probes over the source connection; `undefined` when disconnected. */
  public setLiveProbes(executor: ProbeExecutor | undefined): void {
    this.liveProbes = executor;
  }

  private createPackManager(contextRoot: vscode.Uri): BusinessPackManager {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri;
    return new BusinessPackManager(path.join(contextRoot.fsPath, 'pack'), workspaceRoot.fsPath, () => this.contextFileManager!, (m) => this.postLog(m),
      (system, user, purpose) => this.hub.completeJson(system, user, purpose));
  }

  private requirePack(): BusinessPackManager | undefined {
    if (!this.packManager && this.problemRoot && this.contextFileManager) this.packManager = this.createPackManager(this.problemRoot);
    if (!this.packManager) void vscode.window.showErrorMessage('Start or open a business problem first — the pack belongs to a problem.');
    return this.packManager;
  }

  /** `AutoDE: Add Document to Business-Problem Pack` — pick a file, say what it is, and read it in. */
  public async runAddPackDocument(): Promise<void> {
    const pm = this.requirePack();
    if (!pm) return;
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Add to pack', title: 'Add a document that describes this business problem' });
    const file = picked?.[0];
    if (!file) return;
    const role = await vscode.window.showQuickPick(DOCUMENT_ROLES.map((r) => ({ label: r })), { title: 'What is this document?', placeHolder: 'contract, BRD, KPI definitions, mapping, data dictionary, a sample of a table…' });
    if (!role) return;
    let table: string | undefined;
    if (role.label === 'sample') {
      const t = await vscode.window.showQuickPick(this.listMappableTables().map((x) => ({ label: x.label, description: x.fqn, id: x.id })), { title: 'Which table are these rows a sample of?' });
      if (!t) return;
      table = t.id;
    }
    const authority = await vscode.window.showQuickPick([{ label: 'signed', description: 'the customer stands behind it — facts enter as confirmed' }, { label: 'draft', description: 'facts enter as documented' }], { title: 'How authoritative is it?' });
    if (!authority) return;
    const version = await vscode.window.showInputBox({ title: 'Document version', value: '1' });
    if (version === undefined) return;
    const doc = await pm.addDocument({ path: file.fsPath, role: role.label as DocumentRole, authority: authority.label as 'signed' | 'draft', version: version.trim() || '1', table });
    this.postLog(`Added ${doc.path} to the business-problem pack (${doc.role}, ${doc.authority}, v${doc.version}).`);
    await this.applyPackDocument(pm, doc.id);
  }

  private async applyPackDocument(pm: BusinessPackManager, id: string): Promise<void> {
    const r = await pm.applyDocument(id);
    const doc = pm.getPack().documents.find((d) => d.id === id);
    switch (r.status) {
      case 'applied': this.postLog(`${doc?.path}: read with profile "${r.profileId}" — ${r.reconcile.asserted} new clause(s), ${r.reconcile.superseded} changed, ${r.reconcile.retracted} removed, ${r.reconcile.unchanged} unchanged.${r.warnings.length ? ` Not read: ${r.warnings.join('; ')}` : ''}`); break;
      case 'profile_proposed': {
        this.postLog(`${doc?.path}: AutoDE proposed a reading profile. Check it, set "status: confirmed", then run "AutoDE: Apply Business-Problem Pack".`);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(r.profilePath)));
        break;
      }
      case 'extracted': this.postLog(`${doc?.path}: ${r.proposed} fact(s) proposed for review${r.dropped.length ? `; ${r.dropped.length} dropped (${r.dropped.slice(0, 3).join('; ')})` : ''}.`); break;
      case 'registered': this.postLog(`${doc?.path}: registered as a sample — probes will use it.`); break;
      default: this.postLog(`${doc?.path}: ${r.reason}`);
    }
    this.postContextUpdate();
  }

  /** `AutoDE: Apply Business-Problem Pack` — re-read every document (after a profile was confirmed, or a document changed). */
  public async runApplyPack(): Promise<void> {
    const pm = this.requirePack();
    if (!pm) return;
    await pm.load();
    if (!pm.getPack().documents.length) { this.postLog('The business-problem pack is empty — add documents first.'); return; }
    for (const d of pm.getPack().documents) await this.applyPackDocument(pm, d.id);
  }

  /** `AutoDE: Run Conformance Check` — each source against the pack's contracts; written as a discover-phase artifact. */
  public async runConformanceCheck(): Promise<void> {
    const pm = this.requirePack();
    if (!pm || !this.problemRoot) return;
    const { reports, markdown } = await pm.conformance(pm.probeExecutor(this.liveProbes));
    if (!reports.length) { this.postLog('No contract in the pack has a confirmed profile yet — nothing to check.'); return; }
    const spec = this.specManager?.getSpec();
    const uri = await new ArtifactWriter(this.problemRoot, (m) => this.postLog(m)).write({
      id: `conformance-${Date.now().toString(36)}`, type: 'validation_report', title: 'Conformance Report', description: 'Source systems against the business-problem pack\'s contracts', content: markdown,
      language: 'markdown', generatedBy: 'sourceAssessmentAgent', generatedAt: new Date().toISOString(), approved: false, filePath: 'conformance-report.md', phase: 'discover', specId: spec?.id, specVersion: spec?.version
    });
    const fails = reports.reduce((n, r) => n + r.tables.reduce((m, t) => m + t.results.filter((x) => x.status === 'fail').length, 0), 0);
    this.postLog(`Conformance report written: ${fails} failing clause(s) across ${reports.reduce((n, r) => n + r.tables.length, 0)} table(s).`);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  }

  /** `AutoDE: Verify Claims with Probes` — keys, grains, joins and expectations checked against data (aggregates only). */
  public async runVerifyClaims(): Promise<void> {
    const pm = this.requirePack();
    if (!pm) return;
    const executor = pm.probeExecutor(this.liveProbes);
    if (!executor) { this.postLog('Nothing to probe with: connect the source, or add a sample of the table to the pack.'); return; }
    const out = await pm.verifyClaims(executor);
    const decided = out.filter((o) => o.result && o.result.pass !== undefined);
    for (const o of decided) this.postLog(`${o.result!.pass ? '✓ verified' : '✗ failed'}: ${o.statement} — ${o.result!.detail}`);
    this.postLog(`Probes: ${decided.filter((o) => o.result!.pass).length} verified, ${decided.filter((o) => !o.result!.pass).length} failed (now under review), ${out.length - decided.length} not verified.`);
    this.postContextUpdate();
  }

  /** `AutoDE: Propose Vocabulary` — abbreviations mined from names and comments, plus the LLM's reading of the pack; the engineer picks. */
  public async runProposeVocabulary(): Promise<void> {
    const pm = this.requirePack();
    if (!pm) return;
    const proposals = await pm.proposeVocabulary();
    if (!proposals.length) { this.postLog('No vocabulary to propose.'); return; }
    const picked = await vscode.window.showQuickPick(
      proposals.map((p) => ({ label: p.kind === 'abbreviation' ? `${p.from.toUpperCase()} = ${p.to}` : `${p.from} means ${p.to}`, description: p.source === 'comments' ? `from ${p.support} comment(s)` : 'proposed from documents', detail: p.example, picked: p.source === 'comments' && p.support > 1, proposal: p })),
      { canPickMany: true, title: 'Add to the vocabulary (.ai-context/context/vocabulary.yaml)', placeHolder: 'Select the entries that are right for this customer' });
    if (!picked?.length) return;
    await pm.acceptVocabulary(picked.map((x) => x.proposal));
    this.postLog(`Vocabulary: ${picked.length} entr${picked.length === 1 ? 'y' : 'ies'} added; retrieval re-indexed.`);
  }

  /** Applies the working-set settings and the current connection to a (re)created ContextFileManager. */
  private configureContextFileManager(cfm: ContextFileManager): void {
    const cfg = vscode.workspace.getConfiguration('autoDataEngineeringHub');
    cfm.setWorkingSetPolicy({
      maxTables: cfg.get<number>('context.workingSetMaxTables'),
      evictAfterDays: cfg.get<number>('context.evictAfterDays'),
      schemaTtlDays: cfg.get<number>('context.schemaTtlDays')
    });
    cfm.setCatalogFetcher(this.catalogFetcher);
  }

  /**
   * Lists graph `table`/`semantic_view` nodes as mapping candidates for
   * `extension.ts`'s "Create Mapping" QuickPick (Step 6) — deliberately
   * platform-agnostic (source and target connections both write into the same
   * shared `GraphManager`, per the architecture review's unified-graph
   * decision), so both sides of a mapping are picked from one list.
   */
  public listMappableTables(): Array<{ id: string; label: string; fqn?: string }> {
    const tables = [...this.graphManager.getNodesByType('table'), ...this.graphManager.getNodesByType('semantic_view')];
    const listed = tables.map((t) => ({ id: t.id, label: t.label, fqn: (t as unknown as { fqn?: string }).fqn }));
    // Phase K2: tables known to the catalog but outside the working set can be mapped too.
    const inGraph = new Set(listed.map((t) => t.id));
    const catalogued = (this.contextFileManager?.getCatalog().all() ?? [])
      .filter((e) => e.tier > 0 && !inGraph.has(e.id))
      .map((e) => ({ id: e.id, label: e.table.label, fqn: e.table.fqn }));
    return [...listed, ...catalogued];
  }

  /** Columns of a given table node, via its `contains` edges — for the same "Create Mapping" QuickPick. */
  public listTableColumns(tableId: string): Array<{ id: string; label: string }> {
    const snapshot = this.graphManager.serializeSnapshot();
    const columnIds = new Set(snapshot.edges.filter((e) => e.type === 'contains' && e.source === tableId).map((e) => e.target));
    const inGraph = snapshot.nodes.filter((n) => columnIds.has(n.id)).map((n) => ({ id: n.id, label: n.label }));
    if (inGraph.length > 0) return inGraph;
    // Phase K2: a catalog table picked for a mapping is in scope — it enters the working set.
    const entry = this.contextFileManager?.getCatalog().get(tableId);
    if (!entry?.columns) return [];
    void this.contextFileManager?.promote([tableId]).catch((err) => this.postLog(`Working-set promotion failed: ${err instanceof Error ? err.message : String(err)}`));
    return entry.columns.map((c) => ({ id: c.id, label: c.label }));
  }

  /** The active spec identity a new Mapping Context entry should be filed under, if any. */
  public getMappingSpecInfo(): { specId: string; specVersion: number } | undefined {
    const spec = this.specManager?.getSpec();
    return spec ? { specId: spec.id, specVersion: spec.version } : undefined;
  }

  public getMappingContext(): MappingContext | undefined {
    return this.mappingContextManager?.getContext();
  }

  /**
   * Adds/replaces one `EntityMapping` in the active spec's Mapping Context,
   * auto-resetting to a fresh record first if the container belongs to a
   * different (or no) spec lineage yet — mirrors how Source/Target Context
   * get reset onto the current spec elsewhere in this file.
   */
  public async upsertEntityMapping(mapping: EntityMapping): Promise<MappingContext | undefined> {
    if (!this.mappingContextManager) return undefined;
    const spec = this.specManager?.getSpec();
    if (spec) {
      const current = this.mappingContextManager.getContext();
      if (!current || current.specId !== spec.id || current.specVersion !== spec.version) {
        await this.mappingContextManager.reset(spec.id, spec.version);
      }
    }
    return this.mappingContextManager.upsertMapping(mapping);
  }

  public getSemanticLayerSnapshot() {
    return this.semanticLayerManager?.getSnapshot();
  }

  /**
   * Step 7 (governance layer) — the current set of source-tagged table/view
   * FQNs in the shared graph, for `extension.ts`'s `reVerifySourceSchema`
   * command to diff against a fresh extraction. Never mutates anything; a
   * pure read so the diff itself stays the one place drift becomes visible.
   */
  public listSourceTableFqns(): string[] {
    const tables = [...this.graphManager.getNodesByType('table'), ...this.graphManager.getNodesByType('semantic_view')];
    return tables
      .filter((t) => t.origin?.environment === 'source')
      .map((t) => (t as unknown as { fqn?: string }).fqn ?? t.label);
  }

  /**
   * `AutoDE: Compact Context Ledger` (C2, v0.29.0): writes the ledger's folded
   * state to `.ai-context/ledger/snapshot.json`. With `prune`, the event files
   * folded into it are deleted — the only operation that removes history.
   */
  public async compactContextLedger(prune: boolean): Promise<{ assertions: number; prunedFiles: number } | undefined> {
    return this.contextFileManager?.compactLedger(prune);
  }

  /**
   * The one explicit "Build Semantic Layer" action (Step 6, second half) —
   * captures the live shared graph's current content/counts as a spec-pinned,
   * versioned snapshot. Never runs implicitly; called only from
   * `extension.ts`'s `buildSemanticLayer` command.
   */
  public async buildSemanticLayer() {
    if (!this.semanticLayerManager) return undefined;
    const spec = this.specManager?.getSpec();
    if (!spec) return undefined;
    return this.semanticLayerManager.build(spec.id, spec.version);
  }

  /**
   * Records the latest connection outcome for one role (source or target) and
   * propagates it two ways: to the webview's status pills (UI concern), and to
   * `ContextFileManager`'s runtime facts (LLM-prompt concern) via
   * `connection:<role>` — the single shared object every prompt-building call
   * site that already calls `buildContextPrompt()` picks this up from, with no
   * per-call-site wiring needed. Called from `extension.ts`'s `testConnection`/
   * `sourceAssessment` commands (a different module/scope, hence public) and
   * from `runSourceConnectionCheck()`/`connectToDataPlatform()` below.
   */
  public notifyConnectionStatus(role: 'source' | 'target', status: { connected: boolean; platform?: string; detail?: string }): void {
    this.connectionStatus[role] = status;
    this.postMessage('connectionStatus', this.connectionStatus);

    const factKey = `connection:${role}`;
    if (!status.connected) {
      this.contextFileManager?.setRuntimeFact(factKey, null);
      return;
    }
    const roleLabel = role === 'source' ? 'Source Connection' : 'Target Connection';
    const platformText = status.platform ?? 'a data platform';
    const detailText = status.detail ? ` (${status.detail})` : '';
    const noSchemaHint = role === 'source' && (this.contextFileManager?.getContextStats().tables ?? 0) === 0
      ? ' No schema has been extracted into context yet — if asked about specific tables/columns, suggest running "Source Assessment" (next to Connect in Settings → Connections), or offer to run it.'
      : '';
    this.contextFileManager?.setRuntimeFact(factKey, {
      label: roleLabel,
      text: `Connected to ${platformText}${detailText}.${noSchemaHint}`
    });
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
    const base = this.contextPackText('plan', [spec.problemStatement, ...(spec.objectives ?? [])].join('\n'), 'Plan generation');
    if (base) parts.push(base);
    const supplementary = this.buildSupplementaryContext(spec);
    if (supplementary) parts.push(supplementary);
    return parts.join('\n\n');
  }

  /**
   * The text of a task-scoped context pack (C3, v0.30.0), recorded for
   * "What the agent saw". With nothing to scope by it is the project
   * overview — what every call received before C3.
   */
  private contextPackText(purpose: PackPurpose, query: string | undefined, title: string): string {
    return this.contextFileManager?.buildContextPack({ purpose, query }, title).text ?? '';
  }

  private createContextPackProvider(): ContextPackProvider {
    return {
      buildPack: (request) => this.contextFileManager!.buildContextPack(request),
      prepare: async (request) => { await this.contextFileManager?.prepareContext(request); },
      beforeRun: async () => {
        const r = await this.contextFileManager?.refreshWorkingSet();
        if (r && r.checked > 0) this.postLog(`Refreshed the working set before the run: ${r.checked} object(s) re-checked, ${r.fetched} re-read.`);
      },
      sources: () => this.contextFileManager!.getPackSources(),
      supplementary: () => {
        const spec = this.specManager?.getSpec();
        return spec ? this.buildSupplementaryContext(spec) : '';
      },
      specRevision: () => {
        const spec = this.specManager?.getSpec();
        return spec ? 'sha256:' + createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16) : undefined;
      },
      plannedObjects: () => {
        const ps = this.pipelineSpecManager?.getSpec();
        return ps && ps.status === 'approved' ? ps.entities.map((e) => e.target.object) : [];
      }
    };
  }

  /** Approved Source and Target Context for the given spec revision — the non-graph context every step gets. */
  private buildSupplementaryContext(spec: BusinessProblemSpec): string {
    const parts: string[] = [];
    const sc = this.sourceContextManager?.getContext();
    if (sc && sc.specId === spec.id && sc.specVersion === spec.version && sc.status !== 'not_applicable') {
      const lines = ['## Source Context'];
      for (const entry of sc.sources) {
        if (entry.description) lines.push(entry.description);
        if (entry.connectionSummary) {
          lines.push(`Live connection: ${entry.platform ?? entry.connectionId} — ${entry.connectionSummary.database}.${entry.connectionSummary.schema} (${entry.connectionSummary.tableCount} tables, ${entry.connectionSummary.viewCount} views)`);
        }
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
  private targetContextToEnvironment(tc: TargetContext): import('../engine/types').TargetEnvironment {
    const platform: DataPlatformProvider = tc.platform ?? 'snowflake';
    const pc = tc.platformConfig ?? {};
    let platformConfig: import('../engine/types').TargetEnvironment['platformConfig'];
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
        const password = await this.configManager.getSnowflakePassword();
        if (password) credentials['password'] = password;
        const passphrase = await this.configManager.getSnowflakePrivateKeyPassphrase();
        if (passphrase) credentials['privateKeyPassphrase'] = passphrase;
      } else if (platform === 'databricks') {
        const token = await this.configManager.getDatabricksToken();
        if (token) credentials['token'] = token;
      }
    } catch { /* best-effort — connect() will surface a clear error if a required secret is missing */ }

    // Only what every Snowflake execution path genuinely requires up front — see
    // the matching comment in extension.ts's `testConnection` command for why
    // Warehouse/Database were dropped from this list.
    const missing: string[] = [];
    if (platform === 'snowflake') {
      if (!credentials['account']) missing.push('Account');
      if (!credentials['username']) missing.push('Username');
    } else if (platform === 'databricks') {
      if (!credentials['workspaceUrl']) missing.push('Workspace URL');
      if (!credentials['httpPath']) missing.push('SQL Warehouse HTTP Path');
      if (!credentials['token']) missing.push('Token');
    }
    if (missing.length > 0) {
      this.postMessage('error', { message: `Missing connection settings for ${platform}: ${missing.join(', ')}. Configure them in Settings → Connections, or choose "Describe source" instead.` });
      return;
    }

    const connectionManager = new ConnectionManager((msg: string) => this.postLog(msg), { cliConsent: () => this.configManager.getSettings().dataPlatformCliConsent === true });
    connectionManager.setEstateResolver((id) => this.resolveConnectionIdentity(id));
    try {
      this.postLog(`Connecting to ${platform} to build Source Context…`);
      const info = await connectionManager.connect(platform, credentials);
      const snapshot = await connectionManager.extractMetadata({ includeProfiling: false });
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (workspaceRoot) { await connectionManager.persistSchemaContext(snapshot, workspaceRoot.fsPath, createVscodeFileIo(vscode)); }
      const record: SourceContext = {
        specId: spec.id, specVersion: spec.version, status: 'built',
        sources: [{
          connectionId: snapshot.connectionId ?? platform,
          platform,
          method: 'connected',
          connectionSummary: { database: info.databaseName, schema: info.schemaName, tableCount: snapshot.tables.length, viewCount: snapshot.views.length },
          extractedAt: snapshot.extractedAt
        }],
        answers: {}, builtAt: new Date().toISOString()
      };
      await this.sourceContextManager.save(record);
      this.postMessage('sourceContextBuilt', { context: this.sourceContextManager.getContext() });
      this.postLog(`Source Context built from a live connection: ${snapshot.tables.length} tables, ${snapshot.views.length} views.`);
      this.postContextGateStatus();
      this.notifyConnectionStatus('source', { connected: true, platform, detail: `${info.databaseName}.${info.schemaName} — ${snapshot.tables.length} tables, ${snapshot.views.length} views extracted` });
    } catch (err) {
      this.postMessage('error', { message: `Could not connect to build Source Context: ${err instanceof Error ? err.message : String(err)}. You can choose "Describe source" instead.` });
      this.notifyConnectionStatus('source', { connected: false });
    } finally {
      connectionManager.dispose();
    }
  }

  /**
   * "AutoDE: Connect to Data Platform" (Phase 3a-ii) — the interactive-developer
   * onboarding flow: detect the platform's own CLI, offer its configured
   * connections, resolve the chosen one down to a `CredentialReference` (via the
   * Phase 3a-i `cli` resolver — never a raw secret), test it, and populate the
   * existing Target Context model. Staged feedback goes through the same
   * `postLog`/`postMessage` channel every other chat-visible flow in this class
   * uses; platform/connection *choices* use native QuickPicks rather than a new
   * bespoke webview wizard.
   */
  private async connectToDataPlatform(): Promise<void> {
    const spec = this.specManager?.getSpec();
    if (!spec || !this.targetContextManager) {
      this.postLog('No active business problem — start or open one first, then run "AutoDE: Connect to Data Platform" again.');
      return;
    }

    const settings = this.configManager.getSettings();
    const platformChoices: { label: string; platform: DataPlatformProvider; displayName: string }[] = [
      { label: 'Snowflake', platform: 'snowflake', displayName: 'Snowflake' },
      { label: 'Databricks', platform: 'databricks', displayName: 'Databricks' }
    ];
    platformChoices.sort((a, b) => (a.platform === settings.defaultProvider ? -1 : b.platform === settings.defaultProvider ? 1 : 0));
    const platformPicked = await vscode.window.showQuickPick(platformChoices, { title: 'AutoDE: Connect to Data Platform', placeHolder: 'Choose a data platform' });
    if (!platformPicked) return;
    const { platform, displayName } = platformPicked;

    const descriptor = getCliDescriptor(platform);
    if (!descriptor) {
      this.postLog(`No CLI-reuse support for ${displayName} yet. Enter credentials manually in Settings → Connections, then run "AutoDE: Test Connection".`);
      return;
    }

    this.postLog(`Detecting the ${displayName} CLI…`);
    const cliPathSetting = platform === 'snowflake' ? settings.snowflakeCliPath : settings.databricksCliPath;
    const detection = await descriptor.detect(cliPathSetting);
    if (!detection.found || !detection.cliPath) {
      this.postLog(`${displayName} CLI not found. ${detection.error ?? ''}`.trim());
      this.postLog('Enter credentials manually in Settings → Connections, then run "AutoDE: Test Connection" — or install the CLI and run "AutoDE: Connect to Data Platform" again.');
      return;
    }
    this.postLog(`${displayName} CLI found via ${detection.source} (${detection.cliPath}${detection.version ? `, ${detection.version}` : ''}).`);

    // Shelling out to list real connections/profiles is gated by explicit consent —
    // detection above (a version check) is exempt, same as ClaudeCodeAdapter's own.
    // Databricks reads `.databrickscfg` directly (no CLI shell-out), so it needs no gate.
    if (platform === 'snowflake' && !settings.dataPlatformCliConsent) {
      const consent = await vscode.window.showInformationMessage(
        `AutoDE wants to run "snow connection list" to show your configured Snowflake connections. Allow AutoDE to invoke the Snowflake CLI?`,
        'Allow', 'Not now'
      );
      if (consent !== 'Allow') {
        this.postLog('Skipped connection enumeration (CLI consent not given). Enter credentials manually in Settings → Connections, or allow CLI use and try again.');
        return;
      }
      await this.configManager.updateSettings({ dataPlatformCliConsent: true });
    }

    this.postLog(`Looking up configured ${displayName} connections…`);
    const connections = await descriptor.listConnections(detection.cliPath);
    if (connections.length === 0) {
      this.postLog(`No configured ${displayName} connections found. Enter credentials manually in Settings → Connections, then run "AutoDE: Test Connection".`);
      return;
    }

    const connectionItems = [
      ...connections.map((c) => ({ label: `Use existing ${displayName} CLI connection "${c.name}"`, connectionName: c.name })),
      { label: 'Enter credentials manually instead', connectionName: undefined }
    ];
    const connectionPicked = await vscode.window.showQuickPick(connectionItems, { title: `Choose a ${displayName} connection`, placeHolder: `Found ${connections.length} configured connection(s)` });
    if (!connectionPicked) return;
    if (!connectionPicked.connectionName) {
      this.postLog('Enter credentials manually in Settings → Connections, then run "AutoDE: Test Connection".');
      return;
    }

    const reference: CredentialReference = { platform, principalType: 'interactive-user', ref: connectionPicked.connectionName, resolverId: 'cli' };
    const resolved = await resolveCredential(reference);
    if (!resolved) {
      this.postMessage('error', { message: `Could not confirm connection "${connectionPicked.connectionName}" — it may have been removed. Try again.` });
      return;
    }

    this.postLog(`Testing the connection "${connectionPicked.connectionName}"…`);
    const connectionManager = new ConnectionManager((msg: string) => this.postLog(msg), { cliConsent: () => this.configManager.getSettings().dataPlatformCliConsent === true });
    connectionManager.setEstateResolver((id) => this.resolveConnectionIdentity(id));
    try {
      const info = await connectionManager.connect(platform, resolved);
      this.postLog(`Connected: ${info.databaseName}.${info.schemaName} (${info.version}).`);

      const existing = this.targetContextManager.getContext();
      const record: TargetContext = {
        ...(existing && existing.specId === spec.id && existing.specVersion === spec.version ? existing : { specId: spec.id, specVersion: spec.version, answers: {} }),
        specId: spec.id,
        specVersion: spec.version,
        status: 'built',
        platform,
        credentialRef: { resolverId: 'cli', ref: connectionPicked.connectionName },
        builtAt: new Date().toISOString()
      };
      await this.targetContextManager.save(record);
      this.postMessage('targetContextBuilt', { context: this.targetContextManager.getContext() });
      this.postLog(`Target Context updated: platform=${platform}, connection="${connectionPicked.connectionName}". Review and approve it to use this as your target platform.`);
      this.postContextGateStatus();
      this.notifyConnectionStatus('target', { connected: true, platform, detail: `${info.databaseName}.${info.schemaName}` });
    } catch (err) {
      this.postMessage('error', { message: `Connected via the CLI reference, but the test connection failed: ${err instanceof Error ? err.message : String(err)}` });
      this.notifyConnectionStatus('target', { connected: false });
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
      this.contextFileManager?.setActiveSpecId(spec.id);
      const result = await this.synthesisPipeline.synthesizeFromSpec(spec);
      // C2 (v0.29.0): record the spec's facts in the ledger — a changed field supersedes.
      await this.contextFileManager?.persistCompiledGraph();
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
    const spec = await this.hub.generateSpec(prompt, previous, this.contextPackText('spec', prompt, 'Specification draft'));
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
    const spec = await this.hub.generateSpec(refinement, previous, this.contextPackText('spec', refinement, 'Specification refinement'));
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
      // Phase C4a: discover → validate → ask — tell the interviewer what discovery
      // established, and drop any question it already answers.
      const pack = this.contextFileManager?.buildContextPack({ purpose: 'interview', query: engine.getSession().problemStatement }, 'Interview turn');
      const sources = this.contextFileManager?.getPackSources();
      const known = pack && sources ? knownFactsBlock(knownFacts(sources.graph, sources.assertions, pack.manifest.nodeIds)) : '';
      const extraContext = [pack?.text ?? '', known].filter((x) => x.trim()).join('\n\n');
      let action: SpecEngineAction = await this.hub.discoverNextAction(engine.getSession(), this.ensureSkills(), extraContext);
      if ((action.action === 'ask' || action.action === 'ask_many') && sources) {
        const asked = action.action === 'ask' ? [action.question] : action.questions;
        const { ask, answered } = filterInterviewQuestions(asked, sources.graph, sources.assertions);
        for (const a of answered) this.postLog(`Not asking "${a.question.prompt}" — discovery already answers it: ${a.reason}.`);
        if (answered.length) action = ask.length === 0 ? { action: 'synthesize' } : ask.length === 1 ? { action: 'ask', question: ask[0] } : { action: 'ask_many', questions: ask };
      }
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
      const extraContext = [this.contextPackText('spec', engine.getSession().problemStatement, 'Specification synthesis'), this.packManager?.summary() ?? ''].filter((x) => x.trim()).join('\n\n');
      const spec = await this.hub.synthesizeComprehensiveSpec(engine.getSession(), previous, extraContext);
      const packRefs = this.packManager?.clauseIds() ?? [];
      if (packRefs.length) spec.packRefs = packRefs;
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

/** Every `*.grounding.json` under a directory, skipping `history/` archives. */
async function findManifests(dir: vscode.Uri): Promise<vscode.Uri[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return [];
  }
  const out: vscode.Uri[] = [];
  for (const [name, type] of entries) {
    const uri = vscode.Uri.joinPath(dir, name);
    if (type === vscode.FileType.Directory) {
      if (name !== 'history') out.push(...(await findManifests(uri)));
    } else if (name.endsWith('.grounding.json')) {
      out.push(uri);
    }
  }
  return out;
}
