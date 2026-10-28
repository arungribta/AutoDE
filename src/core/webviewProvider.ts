import * as path from 'node:path';
import { buildSchemaIndex } from '../engine/grounding/sqlGrounding';
import { Classification, GovernanceCandidate, classifyColumn, governanceCandidates, governanceFacts, sameTable } from '../engine/governance/governance';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { ConfigurationManager } from './configManager';
import { DataAgentHubHub } from './agentHub';
import { WebviewMessage, DataAgentHubSettings, SpecEngineAction, SpecIntakeQuestion, SkillDefinition, BusinessProblemSpec, IntakeAttachment, TargetContext, SourceContext, SourceContextEntry, DataPlatformProvider, ToolExecutionMode, EntityMapping, MappingContext } from '../engine/types';
import { EXTENSION_ID } from './extensionIdentity';
import { SpecOpsEngine, createIntakeSession } from '../engine/interview/specOps';
import { SkillRegistry, interviewSkills } from '../engine/skills/skillRegistry';
import { loadSkillPack } from '../engine/agents/definitions';
import { composeSynthesisPrompt } from './specOpsPrompts';
import { buildDiscoveryProgress as buildDiscoveryProgressPure, skillNameForField, DiscoveryProgress } from './discoveryProgress';
import { GraphManager } from '../context/GraphManager';
import { BaseNode, GraphEdge } from '../engine/context/types';
import { ContextFileManager, KnowledgeWatcher } from '../context/ContextFileManager';
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
import { ActiveProblemManager } from '../context/ActiveProblemManager';
import { isOpenInterview, markInterviewFed, openQuestions, readInterview, startInterview, writeInterview } from '../engine/interview/state';
import { BusinessPackManager } from '../context/BusinessPackManager';
import { DOCUMENT_ROLES, DocumentRole } from '../engine/context/pack';
import type { ProbeExecutor } from '../engine/context/probes';
import { filterInterviewQuestions, knownFacts, knownFactsBlock } from '../engine/context/discoveryGaps';
import { PipelineSpecManager } from '../context/PipelineSpecManager';
import { ContextFileWatcher, normalizeFsPath } from '../context/ContextFileWatcher';
import { RevisionConflictError, setRevisionConflictHandler } from '../engine/context/contextStore';
import { ContextPack, PackPurpose, renderPackManifest } from '../engine/context/contextPack';
import { explainManifest, GroundingManifest, manifestStaleReasons } from '../engine/grounding/manifest';
import { generateProblemSlug } from './problemSlug';
import { listPrimitives, isSelectable, registerPrimitives, resetDeclarativePrimitives, registerPrimitiveVersion, resetVersionedPrimitives, compileTransformSpec } from '../engine/transforms/registry';
import { loadPrimitiveDefinitionsFromDirectory, mergePrimitiveDefinitions } from '../engine/transforms/declarative/loader';
import { createDeclarativePrimitive } from '../engine/transforms/declarative/adapter';
import { publishPrimitiveDefinition, deprecatePrimitiveDefinition } from '../engine/transforms/declarative/lifecycle';
import { PrimitiveDefinition } from '../engine/transforms/declarative/types';
import { ConnectionManager } from '../engine/platform/ConnectionManager';
import type { PlatformOnboarding } from './platformOnboarding';
import * as os from 'node:os';
import { Decision, DecisionStore } from '../engine/decisions/decisionStore';
import { ApplyResult, ProposalContext, applyDecision, processResolved } from '../engine/decisions/proposals';
import { layoutPath } from '../engine/workspaceLayout';
import { ChatTurn, citedFactIds, extractFromTurn, parseCaptureCommand } from '../engine/context/chatExtraction';
import { EXPLORATION_DISCLAIMER, admitForMode, problemMode, renderHardening, setProblemMode } from '../engine/documents/problemMode';
import type { GraphView } from '../engine/context/retrieval';
import { problemCandidates, problemCoverage } from '../engine/context/capture';
import { renderCoverage } from '../engine/context/coverage';
import { describeFinding } from '../engine/context/dataCandidates';
import { dismissStatements, dismissedStatements, renderUnrecorded, unrecordedStatements } from '../engine/context/sessionReview';
import { createSubjectResolver } from '../engine/context/projection';
import { createProbeResolver, verifyAssertions } from '../engine/context/probes';
import { Assertion } from '../engine/context/assertions';
import { backendFor } from './platformOnboarding';
import { getCliDescriptor, resolveCredential, CredentialReference } from './credentials';
import { applyCspNonce } from './webviewSecurity';
import { classifyImplementationType } from './implementationType';
import { NO_CONNECTION, buildTargetContextQuestions } from './targetContextQuestions';
import { sourceEntryForSystem, sourceSystemChoices, targetConnectionChoices, targetDefaults, writeTargetContextDraft } from '../engine/context/problemContexts';
import { writeSourceContextDraft } from '../engine/agents/sourceContextDraft';
import { findSourceFiles } from '../engine/context/sourceFiles';
import { ingestFile } from '../engine/context/estateIngest';
import { buildSourceContextQuestions } from './sourceContextQuestions';
import { LAYOUT, UNSCOPED_PROBLEM, layoutRel } from '../engine/workspaceLayout';

/** Tool-action memory (C4b): the meaningful actions of a chat turn — files written, commands run — in one line each. */
export function describeActions(audit: ReadonlyArray<{ tool: string; input: Record<string, unknown>; outcome: string }> | undefined): string[] {
  const out: string[] = [];
  for (const e of audit ?? []) {
    if (e.outcome !== 'ok' && e.outcome !== 'approved') continue;
    if (/write/i.test(e.tool)) out.push(`wrote ${String(e.input.path ?? e.input.file ?? '')}`.trim());
    else if (/command|run/i.test(e.tool)) out.push(`ran ${String(e.input.command ?? '').slice(0, 120)}`.trim());
  }
  return out;
}


import { bulkConfirmDocumented, inbox, reviewFact } from '../engine/context/factReview';
import { WorkflowScope, ensureWorkflow, proposeWorkflow, redraft } from '../engine/workflows/service';
import { WorkflowError, completeStage, reopenStage, skipStage } from '../engine/workflows/runtime';
import { runStage } from './agentExecutor';
import { WaitingItem, waitingForYou } from '../engine/approvals/waiting';
import { approveStageDocument, stageDocumentFile } from '../engine/workflows/documentApproval';
import { readWorkflow } from '../engine/workflows/instance';
/** VS Code's watcher for `.autode/knowledge/` edits, injected into the engine's ContextFileManager (v0.43.2). */
const watchKnowledge: KnowledgeWatcher = (dir, onChange) => {
  const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '*.{yaml,yml,json}'));
  w.onDidChange(onChange); w.onDidCreate(onChange); w.onDidDelete(onChange);
  return w;
};

/** Who answered in the panel, for the interview's record. */
function safeUser(): string {
  try { return os.userInfo().username; } catch { return 'unknown'; }
}

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
  /** Phase C4a: the active problem's business-problem pack. */
  private packManager?: BusinessPackManager;
  private problemRoot?: vscode.Uri;
  /** Phase C4a: probes on the source connection (set by extension.ts when it connects). */
  private liveProbes?: ProbeExecutor;
  /** C4c: exploration chosen (by this person) before the new problem's folder exists. */
  private pendingExploration?: string;
  private platformOnboarding?: PlatformOnboarding;
  private activeProblemManager?: ActiveProblemManager;
  /** `undefined` = no active business problem yet (fresh workspace, or "Start New" before the first draft). */
  private activeProblemId?: string;
  private workspaceRoot?: vscode.Uri;
  private contextFileWatcher?: ContextFileWatcher;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configManager: ConfigurationManager,
    private readonly hub: DataAgentHubHub
  ) {
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

  /** "AutoDE: Connect to Data Platform" command proxy (Phase 3a-ii). */
  public async triggerConnectToDataPlatform(): Promise<void> {
    await this.connectToDataPlatform();
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
      this.createContextValidator(),
      watchKnowledge
    );
    this.configureContextFileManager(this.contextFileManager);
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
        this.postPendingSpecQuestions();
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
    try {
      merged.oracleHasPassword = !!(await this.configManager.getOraclePassword());
      merged.oracleHasWalletPassword = !!(await this.configManager.getOracleWalletPassword());
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
    const previousSpecId = this.hub.currentSpecId();
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
      this.pipelineSpecManager = undefined;
      this.packManager = undefined;
      this.specOpsEngine = undefined;
      this.pendingSpecQuestions = [];
      this.problemRoot = undefined;
      this.postSpec();
      this.postContextGateStatus();
      this.postContextUpdate();
      this.postMessage('activeProblemChanged', { problemId: undefined });
      this.postProblemMode();
      return;
    }

    const contextRoot = this.activeProblemManager.problemRoot(problemId);

    this.specManager = new SpecManager(contextRoot, (msg: string) => this.postLog(msg));
    this.targetContextManager = new TargetContextManager(contextRoot, (msg: string) => this.postLog(msg));
    this.sourceContextManager = new SourceContextManager(contextRoot, (msg: string) => this.postLog(msg));
    this.mappingContextManager = new MappingContextManager(contextRoot, (msg: string) => this.postLog(msg));
    this.pipelineSpecManager = new PipelineSpecManager(contextRoot, (msg: string) => this.postLog(msg));
    this.problemRoot = contextRoot;
    // Another problem's interview isn't this one's; this problem's open interview is resumed below.
    this.specOpsEngine = undefined;
    this.pendingSpecQuestions = [];
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
          // A previously-approved Target Context becomes the chat's live target
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
      this.postProblemMode();
      this.resumeInterview();
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
    if (this.pendingExploration && this.problemRoot) {
      setProblemMode(this.problemRoot.fsPath, 'exploration', { by: this.pendingExploration, channel: 'panel', acknowledged: true });
      this.pendingExploration = undefined;
      this.postProblemMode();
    }
  }

  /** C4c: the active problem's mode, for the panel's banner. */
  private postProblemMode(): void {
    this.postMessage('problemMode', { mode: this.problemRoot ? problemMode(this.problemRoot.fsPath) : this.pendingExploration ? 'exploration' : 'governed', pending: !this.problemRoot && !!this.pendingExploration });
  }

  /** The model facts are extracted with, recorded on each (§5.5 item 5). */
  private modelLabel(): string {
    const s = this.configManager.getSettings();
    return `${s.activeLlmProvider}${s.activeLlmModel ? `:${s.activeLlmModel}` : ''}`;
  }

  /** A person's act: switches the active problem's mode (exploration needs the disclaimer acknowledged). */
  private async switchProblemMode(mode: 'exploration' | 'governed'): Promise<void> {
    const by = this.panelUser();
    if (mode === 'exploration') {
      const ok = await vscode.window.showWarningMessage('Run this business problem in exploration mode?', { modal: true, detail: EXPLORATION_DISCLAIMER }, 'I understand: explore');
      if (ok !== 'I understand: explore') return;
      if (!this.problemRoot) { this.pendingExploration = by; this.postLog('The new business problem will start in exploration mode.'); this.postProblemMode(); return; }
      setProblemMode(this.problemRoot.fsPath, 'exploration', { by, channel: 'panel', acknowledged: true });
      this.postLog(`Exploration mode on, acknowledged by ${by}.`);
    } else {
      if (!this.problemRoot) { this.pendingExploration = undefined; this.postProblemMode(); return; }
      const ok = await vscode.window.showWarningMessage('Switch this business problem to governed?', { modal: true, detail: 'Failed checks block again, and what exploration mode assumed must be confirmed or replaced. AutoDE lists it.' }, 'Switch to governed');
      if (ok !== 'Switch to governed') return;
      const r = setProblemMode(this.problemRoot.fsPath, 'governed', { by, channel: 'panel' }, { workspaceRoot: this.workspaceRoot?.fsPath });
      this.postLog(`Governed mode on (${by}).`);
      if (r.hardening) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'markdown', content: renderHardening(r.hardening) }));
    }
    this.postProblemMode();
    this.postDecisions();
  }

  /** `/review`: messages of this chat that read like facts and aren't recorded; `record <n>` reads one again, `dismiss <n>|all` drops them. */
  private async reviewSession(text: string): Promise<void> {
    const ledger = this.ledger();
    const root = this.workspaceRoot?.fsPath;
    if (!ledger || !root || !this.chatSessionManager || !this.activeChatId) { this.postMessage('chatResponse', { message: 'Open a workspace and a chat to review it.', error: true }); return; }
    const chatId = this.activeChatId;
    const transcript = await this.chatSessionManager.loadTranscript(chatId);
    const turns = transcript.map((m, i) => ({ m, i })).filter(({ m }) => m.role === 'user').map(({ m, i }) => ({ ref: `chat:${chatId}#${i}`, text: m.content }));
    const list = unrecordedStatements(turns, ledger.assertions(), dismissedStatements(root));
    const [, verb, arg] = /^\/review\s*(record|dismiss)?\s*(\S+)?/i.exec(text.trim()) ?? [];
    const picked = arg === 'all' ? list : list.filter((_, n) => String(n + 1) === arg);
    if (verb && !picked.length) { this.postMessage('chatResponse', { message: `No item "${arg ?? ''}" to ${verb}.\n\n${renderUnrecorded(list)}`, error: true }); return; }
    if (verb?.toLowerCase() === 'dismiss') { dismissStatements(root, picked.map((p) => p.ref)); this.postMessage('chatResponse', { message: `Dismissed ${picked.length}.` }); return; }
    if (verb?.toLowerCase() === 'record') {
      let n = 0;
      for (const p of picked) {
        const run = await extractFromTurn({ turn: { ref: p.ref, text: p.text, source: 'chat' }, ledger, resolve: createSubjectResolver(this.contextFileManager!.getPackSources().graph as Parameters<typeof createSubjectResolver>[0]), complete: (system, user, purpose) => this.hub.completeJson(system, user, purpose), model: this.modelLabel(), admit: this.admitter() });
        n += run.recorded.length;
      }
      this.postMessage('chatResponse', { message: n ? `Recorded ${n} fact(s); they are in the Context Inbox.` : 'The model found no fact in it: record it yourself with /define, /rule, /decide or /assume, or dismiss it.' });
      this.postDecisions();
      return;
    }
    this.postMessage('chatResponse', { message: renderUnrecorded(list) });
  }

  /** The active problem's mode applied to a proposal (exploration admits it at once). */
  private admitter(): ((a: Parameters<typeof admitForMode>[0]) => Parameters<typeof admitForMode>[0]) {
    const mode = problemMode(this.problemRoot?.fsPath);
    return (a) => admitForMode(a, mode);
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
          // C4b: /define, /rule, /decide, /assume — straight to a proposed fact, no model.
          if (await this.captureFact(chatMessage, priorHistory.length)) break;
          // C4c: /review — what this chat said that may be a fact and isn't recorded.
          if (/^\/review\b/i.test(chatMessage.trim())) { await this.reviewSession(chatMessage); break; }
          const turnRef = `chat:${this.activeChatId ?? 'none'}#${priorHistory.length}`;
          const previousReply = [...priorHistory].reverse().find((m) => m.role === 'ai')?.content;
          const extractionSource: ChatTurn['source'] = this.specOpsEngine || !this.specManager?.getSpec() ? 'interview' : 'chat';
          let turnActions: string[] = [];
          // Runs after the turn, never awaited by it: extraction must not block or fail a chat (C4b).
          const scheduleExtraction = () => { void this.extractFactsFromTurn({ ref: turnRef, text: chatMessage, source: extractionSource, previousReply, actions: turnActions }); };
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
              scheduleExtraction();
              break;
            }
            if (this.specManager && !currentSpec) {
              await this.handleSpecDiscovery(chatMessage);
              scheduleExtraction();
              break;
            }
            if (this.specManager && currentSpec && currentSpec.status === 'draft') {
              await this.reviseSpec(chatMessage);
              scheduleExtraction();
              break;
            }
            if (this.specManager && currentSpec && currentSpec.status === 'approved' && this.pendingRevision) {
              this.pendingRevision = false;
              await this.handleSpecDiscovery(chatMessage, currentSpec);
              scheduleExtraction();
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
            // C4b tool-action memory: what the turn did goes into the transcript (and later turns' history).
            turnActions = describeActions(result.actions);
            if (turnActions.length && this.chatSessionManager && this.activeChatId) {
              this.chatSessionManager.appendMessage(this.activeChatId, { role: 'log', content: turnActions.join('; '), at: new Date().toISOString() }).catch(() => { /* best-effort */ });
            }
            this.postMessage('chatResponse', { message: result.message, citations: this.citationsFor(result.message), actions: turnActions });
            scheduleExtraction();
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.postMessage('chatResponse', { message: errMsg, error: true });
          }
          break;
        }
        case 'updateSettings': {
          const settings = (message.settings ?? {}) as Partial<DataAgentHubSettings>;
          const typedSettings: Partial<DataAgentHubSettings> = {
            extensionDisplayName: typeof settings.extensionDisplayName === 'string' ? settings.extensionDisplayName : undefined,
            extensionDescription: typeof settings.extensionDescription === 'string' ? settings.extensionDescription : undefined,
            defaultProvider: settings.defaultProvider === 'snowflake' || settings.defaultProvider === 'databricks' || settings.defaultProvider === 'oracle' || settings.defaultProvider === 'bigquery' || settings.defaultProvider === 'redshift' || settings.defaultProvider === 'synapse' || settings.defaultProvider === 'other' ? settings.defaultProvider : undefined,
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
            // Phase DRV2: the Oracle source card.
            defaultOracleConnectString: typeof settings.defaultOracleConnectString === 'string' ? settings.defaultOracleConnectString : undefined,
            defaultOracleUsername: typeof settings.defaultOracleUsername === 'string' ? settings.defaultOracleUsername : undefined,
            oracleConfigDir: typeof settings.oracleConfigDir === 'string' ? settings.oracleConfigDir : undefined,
            oracleWalletLocation: typeof settings.oracleWalletLocation === 'string' ? settings.oracleWalletLocation : undefined,
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
          if (typeof message.oraclePassword === 'string') { await this.configManager.setOraclePassword(message.oraclePassword); }
          if (typeof message.oracleWalletPassword === 'string') { await this.configManager.setOracleWalletPassword(message.oracleWalletPassword); }
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
          const contextUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri, ...LAYOUT.root);
          try { await vscode.commands.executeCommand('revealFileInOS', contextUri); } catch { await vscode.commands.executeCommand('workbench.files.action.showActiveFileInExplorer'); }
          break;
        }
        case 'testConnection': { this.postLog('Connecting to source database...'); try { await vscode.commands.executeCommand(`${EXTENSION_ID}.testConnection`); } catch { this.postLog('Connect command not yet registered.'); } break; }
        case 'platformsState':
        case 'checkPrerequisites':
        case 'prerequisiteAction':
        case 'findExistingConnections':
        case 'saveNamedConnection':
        case 'useConnection':
        case 'stopUsingConnection':
        case 'recheckConnection':
        case 'removeConnection': { await this.handlePlatformMessage(message); break; }
        case 'disconnectDataPlatform': { try { await vscode.commands.executeCommand(`${EXTENSION_ID}.disconnectDataPlatform`); } catch { this.postLog('Disconnect command not yet registered.'); } break; }
        case 'testTargetConnection': { this.postLog('Connecting to target database...'); try { await vscode.commands.executeCommand(`${EXTENSION_ID}.testTargetConnection`); } catch { this.postLog('Test target connection command not yet registered.'); } break; }
        case 'disconnectTargetDataPlatform': { try { await vscode.commands.executeCommand(`${EXTENSION_ID}.disconnectTargetDataPlatform`); } catch { this.postLog('Disconnect target command not yet registered.'); } break; }
        case 'browseSourceDatabase': { try { await vscode.commands.executeCommand(`${EXTENSION_ID}.browseSourceDatabase`); } catch { this.postLog('Browse source database command not yet registered.'); } break; }
        case 'browseTargetDatabase': { try { await vscode.commands.executeCommand(`${EXTENSION_ID}.browseTargetDatabase`); } catch { this.postLog('Browse target database command not yet registered.'); } break; }
        case 'ingestFileAsSourceContext': { try { await vscode.commands.executeCommand(`${EXTENSION_ID}.ingestFileAsSourceContext`); } catch { this.postLog('File ingestion command not yet registered.'); } break; }
        case 'sourceAssessment': {
          // The command brings a named connection's schemas into the estate and reloads the context layer (reloadContextLayer).
          this.postLog('Running source assessment...');
          await vscode.commands.executeCommand(`${EXTENSION_ID}.sourceAssessment`);
          break;
        }
        case 'syncMetadata': { this.postLog('Syncing database metadata...'); try { await vscode.commands.executeCommand(`${EXTENSION_ID}.syncMetadata`); } catch { this.postLog('Sync metadata command not yet registered.'); } break; }
        case 'runToolSkill': {
          // `/skill <id>[@<version>] <instruction>` — a version pins a published revision (Phase S2).
          const [, skillId = '', pinned] = /^([^@\s]*)(?:@(\d+))?$/.exec(typeof message.skillId === 'string' ? message.skillId.trim() : '') ?? [];
          const instruction = typeof message.instruction === 'string' ? message.instruction.trim() : '';
          if (!skillId || !instruction) { this.postLog('Usage: /skill <skillId>[@<version>] <instruction>'); break; }
          this.postLog(`Running skill "${skillId}"${pinned ? ` v${pinned}` : ''}…`);
          try {
            const result = await this.hub.runToolSkill(skillId, instruction, this.contextPackText('step', instruction, `Skill ${skillId}: ${instruction.slice(0, 50)}`), pinned ? Number(pinned) : undefined);
            this.postMessage('chatResponse', { message: result.success ? result.message : `Skill failed: ${result.message}`, error: !result.success });
          } catch (err) {
            const message2 = err instanceof Error ? err.message : String(err);
            this.postMessage('chatResponse', { message: `Skill failed: ${message2}`, error: true });
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
        case 'approveSpec': { await this.approveCurrentSpec(); break; }
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
          const questions = buildTargetContextQuestions(spec, this.targetQuestionOptions());
          this.postMessage('targetContextQuestions', { questions, answers: sameVersion ? existing!.answers : {} });
          break;
        }
        case 'submitTargetContextAnswers': {
          const spec = this.specManager?.getSpec();
          const problemRoot = this.currentProblemRoot()?.fsPath;
          if (!spec || !this.targetContextManager || !problemRoot || !this.workspaceRoot) break;
          const rawAnswers = Array.isArray(message.answers) ? message.answers as Array<{ questionId: string; value: string }> : [];
          const answers: Record<string, string> = {};
          for (const a of rawAnswers) { if (a.value) answers[a.questionId] = a.value; }
          // v0.45.10: the engine writes it (the same as autode_record_target_context and `autode context target`); a chosen connection decides the platform.
          const connectionId = answers.connectionId && answers.connectionId !== NO_CONNECTION ? answers.connectionId : undefined;
          try {
            writeTargetContextDraft(this.workspaceRoot.fsPath, problemRoot, {
              connectionId, platform: connectionId ? undefined : answers.platform,
              modelingApproach: answers.modelingApproach, transformationTool: answers.transformationTool, orchestrationTool: answers.orchestrationTool,
              namingConvention: answers.namingConvention, database: answers.database, schema: answers.schema
            }, answers);
          } catch (err) { this.postMessage('error', { message: `Target Context not saved: ${err instanceof Error ? err.message : String(err)}` }); break; }
          await this.targetContextManager.reload();
          this.postMessage('targetContextBuilt', { context: this.targetContextManager.getContext() });
          this.postLog('Target Context built — review it and approve it.');
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
          const questions = buildTargetContextQuestions(spec, this.targetQuestionOptions());
          this.postMessage('targetContextQuestions', { questions, answers: existing?.answers ?? {} });
          break;
        }
        case 'chooseSourceContextMethod': {
          const spec = this.specManager?.getSpec();
          if (!spec || spec.status !== 'approved' || !this.sourceContextManager || !this.workspaceRoot) { this.postMessage('error', { message: 'Approve the specification before building Source Context.' }); break; }
          const method = message.method === 'estate' || message.method === 'connected' ? 'estate' : message.method === 'estate-systems' ? 'estate-systems' : message.method === 'described' ? 'described' : undefined;
          if (!method) break;
          const existing = this.sourceContextManager.getContext();
          const sameVersion = !!existing && existing.specId === spec.id && existing.specVersion === spec.version;
          if (method === 'described') {
            if (!sameVersion) { await this.sourceContextManager.reset(spec.id, spec.version); }
            const questions = buildSourceContextQuestions(spec);
            this.postMessage('sourceContextQuestions', { questions, answers: sameVersion ? existing!.answers : {} });
          } else {
            // Source files shared in the workspace (DDL, CSV, JSON) not yet in the estate: offer to bring them in first.
            const files = method === 'estate' ? findSourceFiles(this.workspaceRoot.fsPath).filter((f) => f.kind !== 'load-script' && !f.ingested) : [];
            if (files.length) {
              this.postMessage('sourceContextQuestions', {
                questions: [{ id: 'files', field: 'files', kind: 'multi-select', prompt: 'These source files in the workspace are not in the estate yet. Bring the ticked ones in (each as the system shown)?', options: files.map((f) => f.path), rationale: files.map((f) => `${f.path} → ${f.suggestedSystem}${f.tables ? ` (${f.tables} tables)` : ''}`).join(' · ') }],
                answers: { files: files.map((f) => f.path).join(',') },
                submit: 'ingestSourceFiles'
              });
              break;
            }
            // v0.45.10: the source context lists estate systems; their tables and bindings stay in the estate.
            const systems = sourceSystemChoices(this.workspaceRoot.fsPath);
            if (!systems.length) { this.postMessage('error', { message: 'There are no source systems in the estate yet. Bring them in first (Ingest File, Browse Source Database, or `autode estate ingest` / `autode estate extract`), or choose "Describe source" for a source with no connection.' }); break; }
            const chosen = sameVersion ? (existing!.sources.map((x) => x.system).filter((x): x is string => !!x)) : [];
            this.postMessage('sourceContextQuestions', {
              questions: [{ id: 'systems', field: 'systems', kind: 'multi-select', prompt: 'Which of the estate\'s source systems does this problem draw on?', options: systems.map((x) => x.id), rationale: systems.map((x) => `${x.id}: ${x.bindings.join(', ') || 'no bindings'}`).join(' · ') }],
              answers: { systems: chosen.length ? chosen.join(',') : systems.map((x) => x.id).join(',') },
              submit: 'submitSourceSystems'
            });
          }
          break;
        }
        case 'ingestSourceFiles': {
          if (!this.workspaceRoot || !this.contextFileManager) break;
          const raw = Array.isArray(message.answers) ? message.answers as Array<{ questionId: string; value: string }> : [];
          const picked = new Set((raw.find((x) => x.questionId === 'files')?.value ?? '').split(',').map((x) => x.trim()).filter(Boolean));
          const found = findSourceFiles(this.workspaceRoot.fsPath).filter((f) => picked.has(f.path));
          for (const f of found) {
            try {
              const r = await ingestFile(this.contextFileManager, path.join(this.workspaceRoot.fsPath, ...f.path.split('/')), { system: f.suggestedSystem });
              this.postLog(`Brought ${f.path} into the estate as ${r.system}: ${r.tables} table(s), ${r.columns} column(s).`);
            } catch (err) { this.postLog(`Could not bring ${f.path} in: ${err instanceof Error ? err.message : String(err)}`); }
          }
          await this.contextFileManager.persistCompiledGraph();
          this.postContextUpdate();
          // Files not ticked stay out; the systems are offered next.
          await this.handleMessage({ type: 'chooseSourceContextMethod', method: found.length ? 'estate-systems' : 'estate' } as WebviewMessage);
          break;
        }
        case 'submitSourceSystems': {
          const spec = this.specManager?.getSpec();
          const problemRoot = this.currentProblemRoot()?.fsPath;
          if (!spec || !this.sourceContextManager || !problemRoot || !this.workspaceRoot) break;
          const raw = Array.isArray(message.answers) ? message.answers as Array<{ questionId: string; value: string }> : [];
          const ids = (raw.find((x) => x.questionId === 'systems')?.value ?? '').split(',').map((x) => x.trim()).filter(Boolean);
          const entries = ids.map((id) => sourceEntryForSystem(this.workspaceRoot!.fsPath, id)).filter((e): e is NonNullable<typeof e> => !!e);
          try { writeSourceContextDraft(problemRoot, entries, {}, new Date(), this.workspaceRoot.fsPath); } catch (err) { this.postMessage('error', { message: `Source Context not saved: ${err instanceof Error ? err.message : String(err)}` }); break; }
          await this.sourceContextManager.reload();
          this.postMessage('sourceContextBuilt', { context: this.sourceContextManager.getContext() });
          this.postLog(`Source Context built from ${entries.length} estate system(s) — review it and approve it.`);
          this.postContextGateStatus();
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
          this.postLog('Source Context built — review it and approve it.');
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
          if (existing?.sources.some((s) => s.method !== 'described')) { await this.handleMessage({ type: 'chooseSourceContextMethod', method: 'estate' } as WebviewMessage); break; }
          const questions = buildSourceContextQuestions(spec);
          this.postMessage('sourceContextQuestions', { questions, answers: existing?.answers ?? {} });
          break;
        }
        case 'listDecisions':
        case 'openWorkflowView': { await vscode.commands.executeCommand('autoDataEngineeringHub.openWorkflow'); break; }
        case 'openKnowledgeExplorer': { await vscode.commands.executeCommand('autoDataEngineeringHub.openKnowledgeExplorer'); break; }
        case 'workflowAction': {
          const m = message as unknown as { action?: unknown; stage?: unknown; arg?: unknown };
          if (typeof m.action === 'string') await this.workflowAction(m.action, typeof m.stage === 'string' ? m.stage : undefined, typeof m.arg === 'string' ? m.arg : undefined);
          break;
        }
        case 'reviewFact': {
          const m = message as unknown as { id?: unknown; action?: unknown; statement?: unknown; value?: unknown; note?: unknown };
          if (typeof m.id === 'string' && (m.action === 'confirm' || m.action === 'reject' || m.action === 'edit')) await this.reviewFact(m.id, m.action, { statement: typeof m.statement === 'string' ? m.statement : undefined, value: typeof m.value === 'string' ? m.value : undefined, note: typeof m.note === 'string' ? m.note : undefined });
          break;
        }
        case 'verifyFact': { const id = (message as unknown as { id?: unknown }).id; if (typeof id === 'string') await this.verifyFacts([id]); break; }
        case 'bulkConfirmFacts': { const src = (message as unknown as { createdBy?: unknown }).createdBy; if (typeof src === 'string') await this.bulkConfirm(src); break; }
        case 'resolveDecision': {
          const m = message as unknown as { id?: unknown; decision?: unknown; note?: unknown };
          if (typeof m.id === 'string' && (m.decision === 'approved' || m.decision === 'rejected')) await this.resolveDecisionInPanel(m.id, m.decision, typeof m.note === 'string' ? m.note : undefined);
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
            this.specOpsEngine.answer({ questionId, field, value, answeredAt: new Date().toISOString(), by: safeUser(), channel: 'panel' });
            if (this.chatSessionManager && this.activeChatId) {
              this.chatSessionManager.appendMessage(this.activeChatId, { role: 'user', content: `[Answer: ${field}] ${value}`, at: new Date().toISOString() }).catch(() => { /* best-effort */ });
            }
          }
          this.saveInterview();
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
          await this.noteUnrecorded();
          await this.startNewChat();
          break;
        }
        case 'setProblemMode': {
          await this.switchProblemMode(message.mode === 'exploration' ? 'exploration' : 'governed');
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
            // v0.45.12: an attachment is a document of the business-problem pack, so every surface and teammate
            // sees it. A file from outside the workspace is copied into the pack first.
            let fileFsPath = fileUri.fsPath;
            const inside = workspaceRoot && !path.relative(workspaceRoot.fsPath, fileFsPath).startsWith('..') && !path.isAbsolute(path.relative(workspaceRoot.fsPath, fileFsPath));
            if (!inside && this.problemRoot) {
              const copy = vscode.Uri.joinPath(this.problemRoot, 'pack', 'files', path.basename(fileFsPath));
              await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.problemRoot, 'pack', 'files'));
              await vscode.workspace.fs.writeFile(copy, bytes);
              fileFsPath = copy.fsPath;
            }
            const displayPath = workspaceRoot ? path.relative(workspaceRoot.fsPath, fileFsPath).split(path.sep).join('/') : fileFsPath;
            const doc = this.packManager ? await this.packManager.addDocument({ path: fileFsPath, role: 'other', authority: 'draft', version: '1' }) : undefined;
            const attachment: IntakeAttachment = {
              id: `att-${Date.now().toString(36)}`,
              path: displayPath,
              content,
              attachedAt: new Date().toISOString(),
              packDocument: doc?.id
            };
            this.postLog(`Attached ${displayPath}${doc ? ` (pack document ${doc.id}; set its role and authority in the Pack view)` : ''} — extracting structured facts…`);
            attachment.extract = await this.hub.extractAttachmentFacts(attachment);
            this.specOpsEngine.addAttachment(attachment);
            this.saveInterview();
            this.postLog(`Attached ${displayPath} as reference material for this interview (confidence: ${attachment.extract.confidence}).`);
          } catch (err) {
            this.postLog(`Failed to attach file: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
        case 'checkArtifactStaleness': {
          const problemRoot = this.currentProblemRoot();
          if (!problemRoot) { break; }
          const spec = this.specManager?.getSpec();
          const report = await scanArtifactStaleness(problemRoot, spec ? { id: spec.id, version: spec.version } : undefined);
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
   * A `.autode` file changed on disk (debounced by `ContextFileWatcher`).
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
      const root = this.workspaceRoot?.fsPath;
      if (root && key.startsWith(normalizeFsPath(layoutPath(root, 'decisions')))) {
        if (key.endsWith('.yaml')) await this.processDecisionFiles();
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
        after: () => this.postContextGateStatus()
      },
      { uri: this.sourceContextManager?.getFileUri(), reload: () => this.sourceContextManager!.reload(), after: () => this.postContextGateStatus() },
      { uri: this.targetContextManager?.getFileUri(), reload: () => this.targetContextManager!.reload(), after: () => this.postContextGateStatus() },
      { uri: this.mappingContextManager?.getFileUri(), reload: () => this.mappingContextManager!.reload(), after: () => this.postContextGateStatus() }
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
    this.postSpec();
    this.postContextGateStatus();
    const problemRoot = this.currentProblemRoot();
    if (problemRoot) {
      const report = await scanArtifactStaleness(problemRoot, spec ? { id: spec.id, version: spec.version } : undefined);
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
    return stale;
  }

  /** The active problem's artifact directory (where manifests live). */
  private artifactRootForProblem(): vscode.Uri | undefined {
    const problemRoot = this.currentProblemRoot();
    return problemRoot ? ArtifactWriter.resolveArtifactDirectory(problemRoot) : undefined;
  }

  /** The active business problem's folder, or the unscoped one when none is active. */
  private currentProblemRoot(): vscode.Uri | undefined {
    const ws = this.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!ws) return undefined;
    return this.activeProblemId && this.activeProblemManager ? this.activeProblemManager.problemRoot(this.activeProblemId) : vscode.Uri.joinPath(ws, ...LAYOUT.problems, UNSCOPED_PROBLEM);
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

  private postLog(message: string): void {
    this.view?.webview.postMessage({ type: 'logEntry', message });
  }

  /** Lets `extension.ts`'s command handlers (e.g. `testConnection`) surface progress/results into the chat log, not just a native VS Code notification the webview never sees. */
  // ── Context Inbox and facts from conversation (Phase C4b) ───────────────

  private ledger() { return this.contextFileManager?.getLedger(); }

  /** Facts to review (proposed, needs review), conflicts, and the step waiting for context. */
  private inboxState(): Record<string, unknown> {
    const ledger = this.ledger();
    const { facts, conflicts } = ledger ? inbox(ledger) : { facts: [], conflicts: [] };
    return { facts, conflicts, live: !!this.liveProbes };
  }

  /** `/define`, `/rule`, `/decide`, `/assume`: returns true when the message was a capture command. */
  private async captureFact(text: string, turnIndex: number): Promise<boolean> {
    const ledger = this.ledger();
    if (!/^\/(define|rule|decide|assume)\b/i.test(text.trim())) return false;
    if (!ledger) { this.postMessage('chatResponse', { message: 'Open a workspace to record facts.', error: true }); return true; }
    const resolve = createSubjectResolver(this.contextFileManager!.getPackSources().graph as Parameters<typeof createSubjectResolver>[0]);
    const parsed = parseCaptureCommand(text, `chat:${this.activeChatId ?? 'none'}#${turnIndex}`, resolve);
    if (!parsed) return false;
    if ('error' in parsed) { this.postMessage('chatResponse', { message: parsed.error, error: true }); return true; }
    const a = await ledger.assert(this.admitter()(parsed));
    this.postMessage('chatResponse', { message: a.status === 'active' ? `Recorded as an assumed ${a.kind.replace('_', ' ')} (exploration mode): "${a.statement}".` : `Recorded as a proposed ${a.kind.replace('_', ' ')}: "${a.statement}". Confirm it in the Context Inbox.` });
    this.postDecisions();
    return true;
  }

  /** Background extraction after a turn; never throws, never blocks the reply. */
  private async extractFactsFromTurn(turn: ChatTurn): Promise<void> {
    const ledger = this.ledger();
    if (!ledger || !this.contextFileManager) return;
    try {
      const resolve = createSubjectResolver(this.contextFileManager.getPackSources().graph as Parameters<typeof createSubjectResolver>[0]);
      const run = await extractFromTurn({ turn, ledger, resolve, complete: (system, user, purpose) => this.hub.completeJson(system, user, purpose), model: this.modelLabel(), admit: this.admitter() });
      if (run.error) { console.log(`[AutoDE] fact extraction skipped: ${run.error}`); return; }
      if (run.dropped.length) console.log(`[AutoDE] fact extraction dropped ${run.dropped.length}: ${run.dropped.join('; ')}`);
      if (!run.recorded.length) return;
      this.postLog(`${run.recorded.length} fact(s) from this message are waiting in the Context Inbox${run.corrections.length ? ` (${run.corrections.length} correcting an earlier fact)` : ''}.`);
      // §5.3: probes run on proposed keys, grain and relationships when a connection is live and AutoDE is read-only.
      if (this.liveProbes && this.configManager.getSettings().readOnlyMode !== false) {
        const probeable = run.recorded.filter((a) => ['key', 'grain', 'relationship', 'quality_expectation'].includes(a.kind) && !(a.flags ?? []).includes('unresolved_subject'));
        if (probeable.length) await this.verifyFacts(probeable.map((a) => a.id), true);
      }
      await this.contextFileManager.persistCompiledGraph();
      this.postDecisions();
    } catch (err) {
      console.log(`[AutoDE] fact extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private citationsFor(text: string): Record<string, string> {
    const ledger = this.ledger();
    const out: Record<string, string> = {};
    if (!ledger) return out;
    for (const id of citedFactIds(text)) { const a = ledger.get(id); if (a) out[id] = `${a.statement} (${a.status === 'proposed' ? 'proposed' : a.trust})`; }
    return out;
  }

  private async reviewFact(id: string, action: 'confirm' | 'reject' | 'edit', edit: { statement?: string; value?: string; note?: string }): Promise<void> {
    const ledger = this.ledger();
    if (!ledger || !this.contextFileManager) return;
    const a = ledger.get(id);
    if (!a) { this.postMessage('error', { message: `No fact ${id}.` }); return; }
    const actor = `user:${this.panelUser()}`;
    try {
      this.postLog(await reviewFact(ledger, id, action, actor, edit));
      await this.contextFileManager.persistCompiledGraph();
    } catch (err) {
      this.postMessage('error', { message: err instanceof Error ? err.message : String(err) });
    }
    this.postDecisions();
  }

  private async verifyFacts(ids: string[], quiet = false): Promise<void> {
    const ledger = this.ledger();
    if (!ledger || !this.contextFileManager) return;
    if (!this.liveProbes) { if (!quiet) this.postLog('Not verified — no live source connection. Connect the source, then Verify now.'); return; }
    const facts = ids.map((id) => ledger.get(id)).filter((a): a is Assertion => !!a);
    const outcomes = await verifyAssertions(ledger, facts, this.liveProbes, createProbeResolver(this.contextFileManager.getPackSources().graph as Parameters<typeof createProbeResolver>[0]));
    for (const o of outcomes) this.postLog(o.result ? `${o.result.pass ? 'Verified' : 'Failed verification'}: ${o.statement} — ${o.result.detail}` : `Not verified: ${o.statement} — ${o.skipped ?? 'no probe applies'}`);
    await this.contextFileManager.persistCompiledGraph();
    this.postDecisions();
  }

  /** Bulk confirmation, allowed only for documented facts from one source (§5.4). */
  private async bulkConfirm(createdBy: string): Promise<void> {
    const ledger = this.ledger();
    if (!ledger || !this.contextFileManager) return;
    const n = await bulkConfirmDocumented(ledger, createdBy, `user:${this.panelUser()}`);
    this.postLog(`Confirmed ${n} documented fact(s) from ${createdBy}.`);
    await this.contextFileManager.persistCompiledGraph();
    this.postDecisions();
  }

  // ── Decisions (Phase PA1: docs/mcp-engine-requirements.md §9.2) ──────────

  private decisionStore(): DecisionStore | undefined {
    const root = this.workspaceRoot?.fsPath;
    return root ? new DecisionStore(root) : undefined;
  }

  private decisionContext(): ProposalContext | undefined {
    const root = this.workspaceRoot?.fsPath;
    if (!root) return undefined;
    return { workspaceRoot: root, problemRoot: this.currentProblemRoot()?.fsPath, problemId: this.activeProblemId };
  }

  /** Who resolves in the panel: the OS user (the panel is a person at the keyboard; D6). */
  private panelUser(): string {
    try { return os.userInfo().username || 'user'; } catch { return 'user'; }
  }

  private postDecisions(): void {
    const store = this.decisionStore();
    if (!store) return;
    this.postMessage('inboxState', this.inboxState());
    const all = store.list();
    const pending = all.filter((d) => d.status === 'pending' || d.status === 'approved');
    const recent = all.filter((d) => d.status !== 'pending' && d.status !== 'approved').slice(-10).reverse();
    const view = (d: Decision) => ({ id: d.id, kind: d.kind, title: d.title, summary: d.summary, stakes: d.stakes, status: d.status, proposedBy: d.proposedBy, proposedAt: d.proposedAt, validation: d.validation, evidence: d.evidence, resolution: d.resolution, lastNote: d.events[d.events.length - 1]?.note });
    this.postMessage('decisionsList', { pending: pending.map(view), recent: recent.map(view) });
  }

  /** Refreshes whatever an applied decision changed; from the panel, a spec or Pipeline Spec revision then goes through its usual approval (one click, not two). */
  private async afterDecisionApplied(result: ApplyResult, fromPanel: boolean): Promise<void> {
    this.postLog(result.message);
    if (!result.applied) return;
    const kind = result.decision.kind;
    if (kind === 'spec_revision' && this.specManager) {
      await this.reloadContextFile(normalizeFsPath(this.specManager.getSpecUri().fsPath));
      if (fromPanel && this.specManager.getSpec()?.problemStatementApproved) await this.approveCurrentSpec(false);
      else this.postLog('The specification draft was updated; review and approve it in the panel.');
    } else if (kind === 'pipeline_spec' && this.pipelineSpecManager) {
      await this.reloadContextFile(normalizeFsPath(this.pipelineSpecManager.getSpecUri().fsPath));
      if (fromPanel) await this.approveCurrentPipelineSpec();
    } else if (kind === 'mapping' && this.mappingContextManager) {
      await this.reloadContextFile(normalizeFsPath(this.mappingContextManager.getFileUri().fsPath));
    } else if (kind === 'assertion' && this.contextFileManager) {
      await this.contextFileManager.getLedger().load();
      await this.contextFileManager.persistCompiledGraph();
    }
  }

  private async resolveDecisionInPanel(id: string, decision: 'approved' | 'rejected', note?: string): Promise<void> {
    const store = this.decisionStore();
    const ctx = this.decisionContext();
    if (!store || !ctx) return;
    try {
      const resolved = store.resolve(id, { decision, by: this.panelUser(), channel: 'panel', note });
      if (resolved.status === 'approved') {
        const result = await applyDecision(store, id, ctx);
        await this.afterDecisionApplied(result, true);
      } else {
        this.postLog(`Rejected: ${resolved.title}.`);
      }
      if (resolved.kind === 'workflow' || resolved.kind === 'gate') this.postContextGateStatus();
    } catch (err) {
      this.postMessage('error', { message: err instanceof Error ? err.message : String(err) });
    }
    this.postDecisions();
  }

  /** Decisions resolved by editing their files (the file channel), and approvals made elsewhere: apply what this process can. */
  private async processDecisionFiles(): Promise<void> {
    const store = this.decisionStore();
    const ctx = this.decisionContext();
    if (!store || !ctx) return;
    const { applied, incomplete } = await processResolved(store, ctx);
    for (const r of applied) await this.afterDecisionApplied(r, false);
    for (const id of incomplete) this.postLog(`Decision ${id}: resolution is set in its file but "by" is empty — fill in who decided.`);
    this.postDecisions();
  }

  private async approveCurrentSpec(record = true): Promise<boolean> {
    if (!this.specManager) { this.postLog('Spec manager is not initialized.'); return false; }
    const draft = this.specManager.getSpec();
    if (draft && !draft.problemStatementApproved) {
      this.postMessage('error', { message: 'Confirm the inferred business problem before approving the full specification.' });
      return false;
    }
    const approved = await this.specManager.approve();
    this.postSpec();
    if (!approved) return false;
    if (record) this.decisionStore()?.recordResolved({ kind: 'spec_approval', title: `Approve the Business Problem Specification v${approved.version}`, summary: approved.problemStatement, proposal: { id: approved.id, version: approved.version }, proposedBy: { host: 'vscode' }, problemId: this.activeProblemId, by: this.panelUser(), channel: 'panel' });
    this.hub.setSpec(approved.id, approved.version);
    await this.syncContextFromApprovedSpec(approved);
    await this.initializeContextForApprovedSpec(approved);
    this.postMessage('specApproved', { spec: approved });
    this.postLog(approved.implementationType === 'brownfield'
      ? `Business Problem Specification v${approved.version} approved. Build the Target Context and Source Context, then work through the workflow's stages.`
      : `Business Problem Specification v${approved.version} approved. Build the Target Context (no source system — Greenfield), then work through the workflow's stages.`);
    this.postContextGateStatus();
    return true;
  }

  private async approveCurrentPipelineSpec(): Promise<boolean> {
    if (!this.pipelineSpecManager) return false;
    const approved = await this.pipelineSpecManager.approve();
    if (!approved) return false;
    this.postLog(`Pipeline Spec v${approved.version} approved.`);
    return true;
  }

  /** Phase DRV2: named-connection onboarding in the settings cards (built in extension.ts). */
  public setPlatformOnboarding(onboarding: PlatformOnboarding): void {
    this.platformOnboarding = onboarding;
  }

  private postPlatformsState(): void {
    if (this.platformOnboarding) this.postMessage('platformsState', { state: this.platformOnboarding.state() });
  }

  private async setActiveConnection(role: 'source' | 'target', id: string): Promise<void> {
    await this.configManager.updateSettings(role === 'target' ? { activeTargetConnection: id } : { activeSourceConnection: id });
  }

  /** The platform-card messages: prerequisites, existing CLI connections/aliases, saved connections. */
  private async handlePlatformMessage(message: WebviewMessage): Promise<void> {
    const onboarding = this.platformOnboarding;
    if (!onboarding) return;
    const m = message as unknown as Record<string, unknown>;
    const platform = String(m.platform ?? '') as DataPlatformProvider;
    const role = m.role === 'target' ? 'target' : 'source';
    const id = typeof m.id === 'string' ? m.id : '';
    switch (message.type) {
      case 'platformsState': this.postPlatformsState(); break;
      case 'checkPrerequisites': {
        const list = await onboarding.prerequisites(platform);
        this.postMessage('prerequisites', { platform, list, backend: backendFor(platform, typeof m.authMode === 'string' ? m.authMode : undefined) });
        break;
      }
      case 'prerequisiteAction': {
        const action = String(m.action ?? '');
        if (action === 'install' && platform === 'oracle') await vscode.commands.executeCommand(`${EXTENSION_ID}.installOracleDriver`);
        else if (action === 'verify' && platform === 'oracle') await vscode.commands.executeCommand(`${EXTENSION_ID}.verifyOracleDriver`);
        else if (action === 'guide' && typeof m.url === 'string' && /^https:\/\//.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
        const list = await onboarding.prerequisites(platform);
        this.postMessage('prerequisites', { platform, list, backend: backendFor(platform) });
        break;
      }
      case 'findExistingConnections': this.postMessage('existingConnections', { platform, role, result: await onboarding.existing(platform) }); break;
      case 'saveNamedConnection': {
        const cliRef = typeof m.cliRef === 'string' && m.cliRef ? m.cliRef : undefined;
        const scope = m.scope === 'personal' ? 'personal' : 'team';
        let result = await onboarding.saveFromCard(platform, role, { cliRef, scope });
        // Same in-place fix as the Connect button: the CLI path needs the consent setting.
        if (!result.ok && result.message.includes('dataPlatformCliConsent')) {
          const pick = await vscode.window.showErrorMessage(result.message, 'Enable CLI Consent & Retry');
          if (pick === 'Enable CLI Consent & Retry') {
            await this.configManager.updateSettings({ dataPlatformCliConsent: true });
            result = await onboarding.saveFromCard(platform, role, { cliRef, scope });
          }
        }
        if (result.ok && result.id) await this.setActiveConnection(role, result.id);
        this.postLog(result.ok ? `${result.message} Connect now uses it for the ${role}.` : result.message);
        this.postMessage('namedConnectionResult', { ...result, platform, role });
        this.postPlatformsState();
        break;
      }
      case 'useConnection': {
        await this.setActiveConnection(role, id);
        this.postPlatformsState();
        await vscode.commands.executeCommand(role === 'target' ? `${EXTENSION_ID}.testTargetConnection` : `${EXTENSION_ID}.testConnection`);
        this.postPlatformsState();
        break;
      }
      case 'stopUsingConnection': {
        await this.setActiveConnection(role, '');
        this.postLog(`Connect now uses the ${role} card's fields.`);
        this.postPlatformsState();
        break;
      }
      case 'recheckConnection': {
        const result = await onboarding.recheck(id);
        this.postLog(result.message);
        this.postPlatformsState();
        break;
      }
      case 'removeConnection': {
        const pick = await vscode.window.showWarningMessage(`Remove the connection "${id}"?`, { modal: true, detail: 'It is removed from .autode/config/connections.yaml (the team file: commit the change) and .autode/local/connections.yaml, together with its secrets in VS Code\'s secret storage.' }, 'Remove');
        if (pick !== 'Remove') break;
        const result = await onboarding.remove(id);
        const settings = this.configManager.getSettings();
        if (settings.activeSourceConnection === id) await this.setActiveConnection('source', '');
        if (settings.activeTargetConnection === id) await this.setActiveConnection('target', '');
        this.postLog(result.message);
        this.postPlatformsState();
        break;
      }
      default: break;
    }
  }

  // ── For the Workflow view (v0.44.1): it shows the runtime and acts through the panel's own handlers ──

  /** Approves or rejects a decision as the person at the keyboard (the panel channel). */
  public async resolveFromView(id: string, decision: 'approved' | 'rejected', note?: string): Promise<void> {
    await this.resolveDecisionInPanel(id, decision, note);
  }

  /** Workflow actions from the Workflow view: the same code as the palette used. */
  public async workflowActionFromView(action: string, stage?: string, arg?: string): Promise<void> {
    await this.workflowAction(action, stage, arg);
  }

  /** SIMP-1: everything that waits for a person, from the panel's own ledger and the workspace. */
  public waitingForYou(): WaitingItem[] {
    const root = this.workspaceRoot?.fsPath;
    if (!root) return [];
    const ledger = this.ledger();
    return waitingForYou({ workspaceRoot: root, resourcesRoot: this.context.extensionPath, problemId: this.workflowScope()?.problemId, facts: ledger ? inbox(ledger).facts : [] });
  }

  public currentWorkflowScope(): WorkflowScope | undefined {
    return this.workflowScope();
  }

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
      (system, user, purpose) => this.hub.completeJson(system, user, purpose),
      { model: () => this.modelLabel(), doubleExtraction: () => vscode.workspace.getConfiguration('autoDataEngineeringHub').get<boolean>('capture.doubleExtraction', false) });
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
      { canPickMany: true, title: `Add to the vocabulary (${layoutRel('vocabulary')})`, placeHolder: 'Select the entries that are right for this customer' });
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

  /** GOV: personal-data candidates in the working set (the mapped sources first), for *Classify Personal Data…*. */
  /** The active business problem's id (the Semantic Model commands). */
  public getActiveProblemId(): string | undefined {
    return this.activeProblemId;
  }

  /** C5a: what the Semantic Model editor checks against — the workspace's estate and facts. */
  public semanticEditorContext(): { workspaceRoot: string; graph: GraphView; assertions: readonly Assertion[] } | undefined {
    if (!this.contextFileManager || !this.workspaceRoot) return undefined;
    const s = this.contextFileManager.getPackSources();
    return { workspaceRoot: this.workspaceRoot.fsPath, graph: s.graph, assertions: s.assertions };
  }

  public governanceCandidates(): GovernanceCandidate[] {
    if (!this.contextFileManager) return [];
    const sources = this.contextFileManager.getPackSources();
    const index = buildSchemaIndex(sources.graph.nodes, sources.graph.edges);
    const mapped = (this.getMappingContext()?.mappings ?? []).map((m) => m.sourceFqn.toLowerCase());
    const tables = index.tables.filter((t) => !mapped.length || mapped.some((w) => sameTable(t.fqn, w)));
    return governanceCandidates(tables.map((t) => ({ fqn: t.fqn, columns: [...t.columns.keys()] })), governanceFacts(sources.assertions));
  }

  /** C4c: the completeness checklist for the active problem, as Markdown. */
  public captureCoverageMarkdown(): string | undefined {
    if (!this.contextFileManager || !this.problemRoot || !this.workspaceRoot) return undefined;
    const report = problemCoverage({ workspaceRoot: this.workspaceRoot.fsPath, problemRoot: this.problemRoot.fsPath, sources: this.contextFileManager.getPackSources() }, { probesAvailable: !!(this.liveProbes || this.packManager?.sampleExecutor()) });
    return renderCoverage(report);
  }

  /** C4c: candidates from the data, probed (live where connected, else the pack's samples); those that pass are recorded. */
  public async findCandidatesFromData(): Promise<string | undefined> {
    if (!this.contextFileManager || !this.problemRoot || !this.workspaceRoot) return undefined;
    const executor = this.packManager ? this.packManager.probeExecutor(this.liveProbes) : this.liveProbes;
    const { findings, recorded } = await problemCandidates({ workspaceRoot: this.workspaceRoot.fsPath, problemRoot: this.problemRoot.fsPath, sources: this.contextFileManager.getPackSources() }, executor, { record: this.contextFileManager.getLedger() });
    if (recorded.length) await this.contextFileManager.persistCompiledGraph();
    this.postDecisions();
    return ['# Candidates from the data', '', ...findings.map((f) => `- ${describeFinding(f)}`), '', executor ? `${recorded.length} fact(s) recorded${recorded.some((a) => a.status === 'proposed') ? ': confirm them in the Context Inbox' : ''}. Personal-data findings are classified by a person (AutoDE: Classify Personal Data…).` : 'Nothing to probe with: connect the source, or add a sample of the table to the pack.'].join('\n');
  }

  /** GOV: the person in the panel classifies a column (a confirmed fact). */
  public async classifyColumn(input: { table: string; column: string; classification: Classification; strategy?: 'hash' | 'redact'; by: string }): Promise<string> {
    if (!this.contextFileManager) throw new Error('The context layer is not initialized yet: open the AutoDE panel first.');
    const sources = this.contextFileManager.getPackSources();
    const a = await classifyColumn(this.contextFileManager.getLedger(), sources.graph.nodes.map((n) => n.id), { ...input, channel: 'panel' });
    await this.contextFileManager.persistCompiledGraph();
    return a.statement;
  }

  /**
   * `AutoDE: Compact Context Ledger` (C2, v0.29.0): writes the ledger's folded
   * state to `.autode/knowledge/ledger/snapshot.json`. With `prune`, the event files
   * folded into it are deleted — the only operation that removes history.
   */
  public async compactContextLedger(prune: boolean): Promise<{ assertions: number; prunedFiles: number } | undefined> {
    return this.contextFileManager?.compactLedger(prune);
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

  /** C5b: the Knowledge Explorer's "Review in the Inbox" — the palette, where the Context Inbox is. */
  public openInbox(): void {
    this.postDecisions();
    void this.view?.webview.postMessage({ type: 'openInbox' });
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
   * one. Since v0.45.12 the requirements interview belongs to the problem, not
   * the chat: it is saved with the problem and its open questions are asked
   * again in the new chat.
   */
  /** End of a session (C4c): say how many of its messages may be facts that weren't recorded. */
  private async noteUnrecorded(): Promise<void> {
    const ledger = this.ledger();
    const root = this.workspaceRoot?.fsPath;
    if (!ledger || !root || !this.chatSessionManager || !this.activeChatId) return;
    try {
      const chatId = this.activeChatId;
      const transcript = await this.chatSessionManager.loadTranscript(chatId);
      const turns = transcript.map((m, i) => ({ m, i })).filter(({ m }) => m.role === 'user').map(({ m, i }) => ({ ref: `chat:${chatId}#${i}`, text: m.content }));
      const n = unrecordedStatements(turns, ledger.assertions(), dismissedStatements(root)).length;
      if (n) this.postLog(`The chat you closed has ${n} message(s) that read like facts and aren't recorded: reopen it (Chat History) and type /review.`);
    } catch { /* best-effort */ }
  }

  private async startNewChat(): Promise<void> {
    if (!this.chatSessionManager) { this.postLog('Chat sessions are not initialized.'); return; }
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
    this.postPendingSpecQuestions();
  }

  /**
   * Renders the spec file's git history as readable text — AutoDE leans on git
   * as the version/audit log (`.autode/spec/` is meant to be committed)
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

  /** Whether the specification and its contexts are approved (the Pipeline Spec needs them) — computed fresh, never cached. */
  private computeContextGateStatus(spec: BusinessProblemSpec | undefined): {
    targetStatus: string; targetApplicable: boolean; sourceApplicable: boolean; sourceStatus: string; canGeneratePlan: boolean; blockingReasons: string[];
  } {
    if (!spec || spec.status !== 'approved') {
      return { targetStatus: 'none', targetApplicable: true, sourceApplicable: false, sourceStatus: 'none', canGeneratePlan: false, blockingReasons: ['Approve the specification first.'] };
    }
    const tc = this.targetContextManager?.getContext();
    const targetForThisVersion = !!tc && tc.specId === spec.id && tc.specVersion === spec.version;
    // PA3a: the workflow decides whether there is a source stage (it used to be the brownfield flag), and the plan gate comes first.
    // Since v0.45.10 it decides the target the same way: a workflow with no target stage needs no target context.
    const wf = this.workflowGate();
    const targetApplicable = wf ? wf.targetIncluded : true;
    const targetReady = !targetApplicable || !!this.targetContextManager?.isApprovedFor(spec.id, spec.version);
    const sourceApplicable = wf ? wf.sourcesIncluded : spec.implementationType === 'brownfield';
    const sc = this.sourceContextManager?.getContext();
    const sourceForThisVersion = !!sc && sc.specId === spec.id && sc.specVersion === spec.version;
    const sourceReady = !sourceApplicable || !!this.sourceContextManager?.isReadyFor(spec.id, spec.version);
    const reasons: string[] = [];
    // Business Problem checkpoint (v0.13.0, §8.12) — approveSpec already requires this, but
    // it's included here too so the palette's gate messaging always matches what the
    // orchestrator will actually enforce, in case a spec somehow reaches 'approved' status
    // without it (e.g. an older persisted spec from before this field existed).
    if (!spec.problemStatementApproved) reasons.push('Confirm the inferred business problem.');
    if (wf && !wf.approved) reasons.push('Plan the workflow and approve it (Workflow Palette → Workflow).');
    if (!targetReady) reasons.push('Target Context needs to be built and approved.');
    if (sourceApplicable && !sourceReady) reasons.push('Source Context needs to be built and approved (or marked Not Applicable).');
    return {
      targetStatus: targetForThisVersion ? tc!.status : 'none',
      targetApplicable,
      sourceApplicable,
      sourceStatus: sourceForThisVersion ? sc!.status : 'none',
      canGeneratePlan: !!spec.problemStatementApproved && targetReady && sourceReady && (!wf || wf.approved),
      blockingReasons: reasons
    };
  }

  // ── Workflow (PA3a): the runtime is the hub; the panel shows it and acts through the same engine functions as the CLI and MCP ──

  private workflowScope(): WorkflowScope | undefined {
    const root = this.workspaceRoot?.fsPath;
    return root && this.activeProblemId ? { workspaceRoot: root, resourcesRoot: this.context.extensionUri.fsPath, problemId: this.activeProblemId } : undefined;
  }

  /** The plan gate as the runtime sees it, once the specification exists. */
  private workflowGate(): { approved: boolean; sourcesIncluded: boolean; targetIncluded: boolean } | undefined {
    const scope = this.workflowScope();
    if (!scope) return undefined;
    try {
      const w = ensureWorkflow(scope);
      const included = (kind: string) => w.stages.some((x) => x.kind === kind && x.included && x.record.status !== 'skipped');
      return { approved: w.status === 'approved', sourcesIncluded: included('source-assessment'), targetIncluded: included('target-context') };
    } catch { return undefined; }
  }

  private async workflowAction(action: string, stage: string | undefined, arg: string | undefined): Promise<void> {
    const scope = this.workflowScope();
    if (!scope) { this.postLog('Start or open a business problem first.'); return; }
    const rctx = { workspaceRoot: scope.workspaceRoot, problemRoot: path.join(scope.workspaceRoot, ...LAYOUT.problems, scope.problemId), problemId: scope.problemId };
    const by = this.panelUser();
    try {
      if (action === 'propose') {
        const current = readWorkflow(rctx.problemRoot);
        if (current && current.status === 'approved') { this.postLog('The workflow is approved. To re-plan, ask an agent to propose a revision, or run `autode workflow plan` in a terminal.'); return; }
        const w = redraft(scope, arg || undefined);
        const d = proposeWorkflow(scope, w, { host: 'vscode' });
        this.postLog(d.validation.ok ? `Workflow drafted from ${w.template.id}: ${d.title}. Approve it in the Context Inbox.` : `The workflow draft has problems: ${d.validation.errors.join(' ')}`);
        this.postDecisions();
      } else if (action === 'skip' && stage) {
        const reason = arg ?? await vscode.window.showInputBox({ title: `Skip ${stage}`, prompt: 'Why is this stage not needed for this problem? (recorded)', ignoreFocusOut: true });
        if (!reason) return;
        skipStage(rctx, stage, reason, { kind: 'person', name: by }, 'panel');
        this.postLog(`Stage ${stage} skipped: ${reason}`);
      } else if (action === 'reopen' && stage) {
        const reason = arg ?? await vscode.window.showInputBox({ title: `Re-open ${stage}`, prompt: 'What needs to change? Everything downstream becomes stale.', ignoreFocusOut: true });
        if (!reason) return;
        const r = reopenStage(rctx, stage, { kind: 'person', name: by }, reason, 'panel');
        this.postLog(`Stage ${stage} re-opened${r.stale.length ? `; now stale: ${r.stale.join(', ')}` : ''}.`);
      } else if (action === 'run' && stage) {
        this.postLog(`Running the agent for stage ${stage}…`);
        // Refresh on use (K2): tables the agent will work with that are past their refresh age, before it starts.
        try {
          const fr = await this.contextFileManager?.refreshWorkingSet();
          if (fr?.fetched) this.postLog(`Refreshed ${fr.fetched} table(s) past their refresh age before the run.`);
        } catch (err) { this.postLog(`The refresh before the run failed; the agent works with what AutoDE has: ${err instanceof Error ? err.message : String(err)}`); }
        const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `AutoDE: running ${stage}`, cancellable: false },
          () => runStage({ createEngine: (n) => this.hub.createEngine(n), runAgentWithTools: (p, o) => this.hub.runAgentWithTools(p, o), activeProvider: () => this.hub.activeProvider(), log: (l) => this.postLog(l) },
            { workspaceRoot: scope.workspaceRoot, resourcesRoot: this.context.extensionPath, problemId: scope.problemId }, stage));
        this.postLog(r.ok ? `${r.message}${r.outputs.length ? ` Recorded: ${r.outputs.join(', ')}.` : ''}` : r.message);
        if (!r.ok) void vscode.window.showWarningMessage(r.message.split('\n')[0]);
        this.postDecisions();
      } else if ((action === 'approve-document' || action === 'produce' || action === 'open-document') && stage) {
        const s = readWorkflow(rctx.problemRoot)?.stages.find((x) => x.id === stage);
        const file = s ? stageDocumentFile(rctx.problemRoot, s.kind) : undefined;
        if (!s || !file) { this.postLog(`Stage ${stage} has no document of its own.`); return; }
        if (action === 'open-document') { await vscode.window.showTextDocument(vscode.Uri.file(file)); return; }
        if (action === 'approve-document') {
          // C4c: in exploration mode a stage's document is approved in one click.
          if (problemMode(rctx.problemRoot) !== 'exploration') {
            const ok = await vscode.window.showWarningMessage(`Approve ${s.title} as ${by}?`, { modal: true, detail: `This approves ${path.relative(scope.workspaceRoot, file)} (the panel channel) and completes the stage. It is recorded with your name in the document and the workflow history.` }, 'Approve');
            if (ok !== 'Approve') return;
          }
          const r = approveStageDocument(rctx, stage, { kind: 'person', name: by }, 'panel');
          await this.reloadContextFile(normalizeFsPath(file));
          this.postLog(r.message);
        } else {
          // How each document is made in VS Code: the panel's own flows.
          if (s.kind === 'mapping') await vscode.commands.executeCommand('autoDataEngineeringHub.createMapping');
          else if (s.kind === 'build') await this.workflowAction('run', stage, undefined);
          else {
            await vscode.commands.executeCommand('autoDataEngineeringHubSidebar.focus');
            this.postLog(s.kind === 'specify' ? 'The specification is in the panel: answer the interview, then approve it there or from the Workflow view.'
              : s.kind === 'target-context' ? 'Build the target context in the panel (Target Context), then approve it there or from the Workflow view.'
              : 'Build the source context in the panel (Source Context: Pick from the Estate, which also brings in source files found in the workspace, or Describe Source), then approve it there or from the Workflow view.');
          }
        }
      } else if (action === 'complete' && stage) {
        const files = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Hand in', title: `What did stage ${stage} produce?`, defaultUri: this.workspaceRoot });
        if (!files) return;
        const summary = await vscode.window.showInputBox({ title: `Hand in ${stage}`, prompt: 'What was done (for the approver)', ignoreFocusOut: true }) ?? '';
        const r = completeStage(rctx, stage, { outputs: files.map((f) => path.relative(scope.workspaceRoot, f.fsPath).split(path.sep).join('/')), summary, who: { kind: 'person', name: by }, channel: 'panel' });
        this.postLog(r.message);
        this.postDecisions();
      }
    } catch (err) {
      const message = err instanceof WorkflowError || err instanceof Error ? err.message : String(err);
      this.postMessage('error', { message });
      // The Workflow view has no log of its own: say it where the person is looking.
      void vscode.window.showErrorMessage(message);
    }
    this.postContextGateStatus();
  }

  private postContextGateStatus(): void {
    const status = this.computeContextGateStatus(this.specManager?.getSpec());
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


  /** Approved Source and Target Context for the given spec revision — the non-graph context every step gets. */
  private buildSupplementaryContext(spec: BusinessProblemSpec): string {
    const parts: string[] = [];
    const sc = this.sourceContextManager?.getContext();
    if (sc && sc.specId === spec.id && sc.specVersion === spec.version && sc.status !== 'not_applicable') {
      const lines = ['## Source Context'];
      for (const entry of sc.sources) {
        if (entry.system) lines.push(`Estate system ${entry.system} (${entry.method === 'connected' ? `connected: ${entry.connectionId}` : `from ${entry.connectionId}`}).`);
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
        `Platform: ${tc.platform}${tc.connectionId ? ` (connection ${tc.connectionId})` : ''}.`,
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
      modelingApproach: tc.modelingApproach ?? 'dimensional',
      namingConvention: tc.namingConvention ?? 'snake_case',
      transformationTool: tc.transformationTool ?? 'dbt',
      orchestrationTool: tc.orchestrationTool ?? 'airflow',
      platformConfig
    };
  }

  /** The workspace's target connections and the team's defaults, for the target questions (v0.45.10). */
  private targetQuestionOptions(): Parameters<typeof buildTargetContextQuestions>[1] {
    const ws = this.workspaceRoot?.fsPath;
    if (!ws) return {};
    return { connections: targetConnectionChoices(ws), defaults: targetDefaults({ assertions: this.contextFileManager?.getPackSources().assertions ?? [], workspaceRoot: ws, problemId: this.activeProblemId }) };
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
   * `.autode/knowledge/snapshots/<specId>.v<version>.md` — committed
   * alongside the spec, unlike the transient compiled graph
   * (`.autode/local/derived/graph.json`, gitignored).
   */
  private async writeContextSnapshot(spec: BusinessProblemSpec): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri;
    const snapshotDir = vscode.Uri.joinPath(workspaceRoot, ...LAYOUT.snapshots);
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
    this.postLog(`Context snapshot written: ${layoutRel('snapshots', fileName)}`);
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
    // v0.45.12: the interview's parts are AutoDE's interview skills; a team's JSON parts replace them by id.
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri;
    const overrideDir = vscode.Uri.joinPath(workspaceRoot, ...LAYOUT.skills).fsPath;
    this.skillRegistry = new SkillRegistry(interviewSkills(loadSkillPack(this.context.extensionUri.fsPath).skills, overrideDir));
    return this.skillRegistry.list();
  }

  /** `.autode/config/primitives/` — the workspace override directory for Tier-2 primitive definitions (Phase 2B-ii/iii). */
  private primitivesOverrideDir(): string | undefined {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) return undefined;
    return vscode.Uri.joinPath(workspaceRoot, ...LAYOUT.primitives).fsPath;
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
      // v0.45.12: the interview belongs to the problem and lives on disk, so the problem starts with it.
      if (!previousSpec) await this.ensureActiveProblem(trimmed);
      const root = this.problemRoot?.fsPath;
      const session = root
        ? startInterview(root, trimmed, this.ensureSkills(), { previousSpec })
        : createIntakeSession(trimmed, { fields: new SkillRegistry(this.ensureSkills()).allSpecFields(), previousSpec });
      this.specOpsEngine = new SpecOpsEngine(session);
      this.postLog(previousSpec
        ? `Starting a revision of specification v${previousSpec.version} — answer the questions to refine the change.`
        : 'Starting agentic requirements discovery — answer the questions to refine the specification. You can stop at any time; the interview is saved with the problem.');
    } else if (this.pendingSpecQuestions.length > 0) {
      const current = this.pendingSpecQuestions[0];
      this.specOpsEngine.answer({ questionId: current.id, field: current.field, value: trimmed, answeredAt: new Date().toISOString(), by: safeUser(), channel: 'panel' });
      this.saveInterview();
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
        this.saveInterview();
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
    this.saveInterview();
    const before = this.specManager?.getSpec()?.updatedAt;
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
      // The interview fed this specification version: it is kept as the record and no longer resumed.
      // If no specification came out, it stays open and resumes.
      const saved = this.specManager?.getSpec();
      const root = this.problemRoot?.fsPath;
      if (root && saved && saved.updatedAt !== before) markInterviewFed(root, saved, 'panel');
      else { engine.setState('discovery'); this.saveInterview(); }
      this.specOpsEngine = undefined;
      this.pendingSpecQuestions = [];
    }
  }

  /** Re-reads the context layer from disk (after the engine wrote to the estate from outside this panel, e.g. source assessment). */
  public async reloadContextLayer(): Promise<void> {
    if (!this.contextFileManager) return;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri;
    const activeSpecId = this.contextFileManager.getActiveSpecId();
    this.contextFileManager.dispose();
    this.contextFileManager = new ContextFileManager(workspaceRoot, this.graphManager, (msg: string) => this.postLog(msg), this.createContextValidator(), watchKnowledge);
    this.configureContextFileManager(this.contextFileManager);
    this.contextFileManager.setActiveSpecId(activeSpecId);
    await this.contextFileManager.initialize();
    this.postContextUpdate();
  }

  /** Saves the interview with the problem (v0.45.12): any surface, or this panel after a reload, continues it. */
  private saveInterview(): void {
    const root = this.problemRoot?.fsPath;
    if (!root || !this.specOpsEngine) return;
    try { writeInterview(root, this.specOpsEngine.getSession()); } catch (err) { this.postLog(`The interview could not be saved: ${err instanceof Error ? err.message : String(err)}`); }
  }

  /** Continues the problem's open interview, wherever it was left: its open questions are asked again. */
  private resumeInterview(): void {
    const root = this.problemRoot?.fsPath;
    const session = root ? readInterview(root, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) : undefined;
    if (!session || !isOpenInterview(session)) return;
    if (session.state === 'synthesizing') session.state = 'discovery';
    this.specOpsEngine = new SpecOpsEngine(session);
    this.pendingSpecQuestions = openQuestions(session);
    const last = session.answers[session.answers.length - 1];
    this.postLog(`Resumed the requirements interview: ${session.answers.length} answer(s) so far${last?.channel ? `, the last through ${last.channel === 'panel' ? 'this panel' : last.channel === 'mcp' ? 'an agent host' : 'the terminal'}` : ''}; ${this.pendingSpecQuestions.length} question(s) open.`);
    this.postPendingSpecQuestions();
  }

  private postPendingSpecQuestions(): void {
    if (this.pendingSpecQuestions.length > 1) {
      this.postMessage('specQuestions', { questions: this.pendingSpecQuestions.map((q) => ({ ...q, skillLabel: skillNameForField(q.field, this.ensureSkills()) })), progress: this.buildDiscoveryProgress() });
    } else if (this.pendingSpecQuestions.length === 1) {
      this.postSpecQuestion(this.pendingSpecQuestions[0]);
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
