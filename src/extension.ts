import { emptyEstate, resolveIdentity, serializeEstate } from './engine/context/estate';
import * as vscode from 'vscode';
import { EXTENSION_ID, EXTENSION_VIEW_ID, EXTENSION_PANEL_VIEW_ID } from './core/extensionIdentity';
import { DataAgentHubHub } from './core/agentHub';
import { ConfigurationManager } from './core/configManager';
import { DataAgentHubWebviewProvider } from './core/webviewProvider';
import { DataAgentHubPanelProvider } from './core/panelProvider';
import { ConnectionManager } from './engine/platform/ConnectionManager';
import { ArtifactWriter } from './context/ArtifactWriter';
import { PlanManager } from './context/PlanManager';
import { TargetConfigManager } from './context/TargetConfigManager';
import { DataModelEditorProvider } from './editors/DataModelEditorProvider';
import { SttmEditorProvider } from './editors/SttmEditorProvider';
import { GraphEditorProvider } from './editors/GraphEditorProvider';
import { ProfileEditorProvider } from './editors/ProfileEditorProvider';
import { DocEditorProvider } from './editors/DocEditorProvider';
import { EDITOR_DATA_MODEL, EDITOR_STTM, EDITOR_GRAPH, EDITOR_PROFILE, EDITOR_DOC } from './core/extensionIdentity';
import { createDisposableRegistry } from './core/disposables';
import { createVscodeFileIo } from './context/vscodeFileIo';
import { registerDefaultCredentialResolvers, resolveCredential } from './core/credentials';
import { DataPlatformProvider, DataAgentHubSettings } from './engine/types';
import { parseFile, detectFileFormat } from './engine/context/fileIngestion';
import * as path from 'node:path';

/**
 * Resources that outlive a single command (e.g. `connectionManager` below,
 * reassigned across "Test Connection" calls) live in `activate()`'s closure,
 * which `deactivate()` cannot see. Register anything here that needs to be
 * torn down on extension shutdown instead of relying on GC.
 */
const disposableRegistry = createDisposableRegistry();

/** Recursively copies a directory via vscode.workspace.fs (used to import a skill folder). */
async function copyDirectoryRecursive(source: vscode.Uri, target: vscode.Uri): Promise<void> {
  await vscode.workspace.fs.createDirectory(target);
  const entries = await vscode.workspace.fs.readDirectory(source);
  for (const [name, type] of entries) {
    const sourceChild = vscode.Uri.joinPath(source, name);
    const targetChild = vscode.Uri.joinPath(target, name);
    if (type === vscode.FileType.Directory) {
      await copyDirectoryRecursive(sourceChild, targetChild);
    } else if (type === vscode.FileType.File) {
      const bytes = await vscode.workspace.fs.readFile(sourceChild);
      await vscode.workspace.fs.writeFile(targetChild, bytes);
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const configManager = new ConfigurationManager(context);
  const hub = new DataAgentHubHub(configManager);
  registerDefaultCredentialResolvers(context.secrets);

  // Which VS Code Language Model provider the user has selected (Copilot or
  // Claude). Any other provider is API-key based and not exercised by these
  // detection/test commands; we fall back to 'copilot' for detection.
  const activeLmProvider = (): 'copilot' | 'claude' =>
    configManager.getSettings().activeLlmProvider === 'claude' ? 'claude' : 'copilot';

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? context.extensionUri;

  // PlanManager and ArtifactWriter are scoped to a business problem's own
  // folder (v0.12.0, `.ai-context/problems/<id>/`) — but they're also the two
  // managers the command-palette entry points (`autoDE.generatePlan`,
  // `autoDE.executePlan`) can reach *without* the sidebar ever resolving, so
  // ownership stays here rather than moving into `webviewProvider`. `applyProblemRoot`
  // (re)points both at a given context root and re-injects them into `hub` —
  // called once below with a safe fallback, then again by `webviewProvider`
  // the moment it determines the real active business problem (or the lack
  // of one). `hub.setPlanManager`/`setArtifactWriter` are plain setters, so a
  // later call transparently supersedes an earlier one; nothing needs to be
  // torn down.
  const applyProblemRoot = async (contextRoot: vscode.Uri): Promise<void> => {
    const artifactWriter = new ArtifactWriter(contextRoot, (msg: string) => {
      console.log(`[AutoDE Artifact] ${msg}`);
    });
    hub.setArtifactWriter(artifactWriter);

    const planManager = new PlanManager(contextRoot, (msg: string) => {
      console.log(`[AutoDE Plan] ${msg}`);
    });
    hub.setPlanManager(planManager);
    await planManager.initialize();
    const persisted = planManager.getPlan();
    if (persisted) {
      hub.loadPersistedPlan(persisted);
    }
  };

  // Fallback root for objective-only usage (command palette, no spec ever
  // drafted) that never resolves to a real business problem — kept separate
  // from any real problem folder so it can't be mistaken for one in the
  // business-problem picker.
  const unscopedRoot = vscode.Uri.joinPath(workspaceRoot, '.ai-context', 'problems', '_unscoped');
  void applyProblemRoot(unscopedRoot);

  const sidebarProvider = new DataAgentHubWebviewProvider(context, configManager, hub, applyProblemRoot);
  const panelProvider = new DataAgentHubPanelProvider(context, hub);

  let connectionManager: ConnectionManager | undefined;
  disposableRegistry.register({ dispose: () => connectionManager?.dispose() });
  // Target's own, independent live connection (v0.19.0) — both can be connected
  // simultaneously per the confirmed decision; a completely separate
  // ConnectionManager instance rather than reusing the source one.
  let targetConnectionManager: ConnectionManager | undefined;
  disposableRegistry.register({ dispose: () => targetConnectionManager?.dispose() });

  // Initialize TargetConfigManager (.ai-context/target-environment.yaml, profile
  // inheritance) — kept instantiated for future dev/staging/prod profile
  // switching, but (v0.11.0) its generic default profile is deliberately NOT
  // seeded into the hub anymore. Doing that previously meant every workspace
  // silently started with the same Snowflake/dimensional/dbt/Airflow
  // assumptions regardless of the approved spec, and permanently short-
  // circuited the one fallback that tried to infer target intent at all
  // (`extractTargetFromMessage`). The Target Context Q&A (built + approved
  // after spec approval, see requirements.md §8.10) is now the sole source of
  // `state.targetEnvironment` — see `webviewProvider.approveTargetContext`.
  const targetConfigManager = new TargetConfigManager(workspaceRoot, (msg: string) => {
    console.log(`[AutoDE Target] ${msg}`);
  });
  void targetConfigManager.initialize();

  // ── Commands ──

  const openSidebar = vscode.commands.registerCommand(`${EXTENSION_ID}.openSidebar`, async () => {
    await vscode.commands.executeCommand(`workbench.view.extension.${EXTENSION_ID}`);
  });

  const generatePlan = vscode.commands.registerCommand(`${EXTENSION_ID}.generatePlan`, async () => {
    const objective = await vscode.window.showInputBox({
      prompt: 'Describe the data engineering objective to plan.',
      placeHolder: 'Load daily sales events into a curated model and validate row counts.'
    });
    if (!objective || objective.trim().length === 0) { return; }
    try {
      await hub.generatePlan(objective.trim());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate a plan.';
      await vscode.window.showErrorMessage(message);
    }
  });

  const executePlan = vscode.commands.registerCommand(`${EXTENSION_ID}.executePlan`, async () => {
    try {
      await hub.executePlan();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to execute the plan.';
      await vscode.window.showErrorMessage(message);
    }
  });

  // Phase 2B-i — an additional, opt-in flow alongside Generate Plan/Execute Plan:
  // synthesizes a strictly-validated, machine-compilable Pipeline Spec from the
  // approved specification and its context. Delegates to the sidebar provider,
  // which owns the spec/context managers this needs (see webviewProvider.ts).
  const generatePipelineSpec = vscode.commands.registerCommand(`${EXTENSION_ID}.generatePipelineSpec`, async () => {
    try {
      await sidebarProvider.triggerGeneratePipelineSpec();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate the Pipeline Spec.';
      await vscode.window.showErrorMessage(message);
    }
  });

  const resetSession = vscode.commands.registerCommand(`${EXTENSION_ID}.resetSession`, async () => {
    await hub.resetPlan();
  });

  // Phase 3a-ii — interactive-developer onboarding: detects the platform's own
  // CLI, offers its configured connections, and resolves the chosen one down to a
  // Phase 3a-i `CredentialReference` instead of asking the user to re-type
  // settings. Delegates to the sidebar provider, which owns Target Context.
  const connectToDataPlatform = vscode.commands.registerCommand(`${EXTENSION_ID}.connectToDataPlatform`, async () => {
    try {
      await sidebarProvider.triggerConnectToDataPlatform();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to connect to the data platform.';
      await vscode.window.showErrorMessage(message);
    }
  });

  // Service-account path (Phase 3a-ii): deliberately un-fancy — no chat, no
  // QuickPicker, no CLI detection dialog. A platform team sets
  // "autoDataEngineeringHub.serviceAccountCredentialRef" once (JSON:
  // {platform, resolverId, ref}) and this command just proves it resolves,
  // with staged feedback matching testLanguageModelHandler's style.
  const testServiceAccountCredential = vscode.commands.registerCommand(`${EXTENSION_ID}.testServiceAccountCredential`, async () => {
    const raw = (configManager.getSettings().serviceAccountCredentialRef ?? '').trim();
    if (!raw) {
      vscode.window.showErrorMessage('"autoDataEngineeringHub.serviceAccountCredentialRef" is not set. Set it to {"platform":"snowflake","resolverId":"env","ref":"prod"} (or similar) first.');
      return;
    }
    let parsed: { platform?: string; resolverId?: string; ref?: string };
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      vscode.window.showErrorMessage(`"autoDataEngineeringHub.serviceAccountCredentialRef" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!parsed.platform || !parsed.resolverId) {
      vscode.window.showErrorMessage('"autoDataEngineeringHub.serviceAccountCredentialRef" must include at least "platform" and "resolverId".');
      return;
    }
    const reference = { platform: parsed.platform as DataPlatformProvider, principalType: 'service-account' as const, resolverId: parsed.resolverId, ref: parsed.ref ?? '' };
    vscode.window.showInformationMessage(`Resolving a service-account credential for ${parsed.platform} via resolver "${parsed.resolverId}"…`);
    try {
      const resolved = await resolveCredential(reference);
      if (!resolved) {
        vscode.window.showErrorMessage(`Resolver "${parsed.resolverId}" could not resolve this reference. Check the referenced env vars / CLI config / secret exist.`);
        return;
      }
      vscode.window.showInformationMessage(`Resolved fields: ${Object.keys(resolved).join(', ')}.`);
    } catch (err) {
      vscode.window.showErrorMessage(`Resolution error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const asLmProvider = (v: unknown): 'copilot' | 'claude' | undefined =>
    v === 'claude' || v === 'copilot' ? v : undefined;

  const testLanguageModelHandler = async (providerArg?: unknown) => {
    const provider = asLmProvider(providerArg) ?? activeLmProvider();
    try {
      if (provider === 'claude') {
        const { ClaudeCodeAdapter } = require('./core/claudeCodeAdapter') as typeof import('./core/claudeCodeAdapter');
        const { info, adapter } = await ClaudeCodeAdapter.detect(configManager.getSettings().claudeCodePath);
        if (!adapter) {
          vscode.window.showErrorMessage(info.error || 'Claude Code CLI not found.');
          return;
        }
        vscode.window.showInformationMessage(`Claude Code found (${info.cliSource}${info.version ? `, ${info.version}` : ''}). Testing…`);
        const out = await adapter.testCall();
        if (out.ok) { vscode.window.showInformationMessage('Claude Code test succeeded: ' + (out.text ? out.text.slice(0, 120) : '[no-text]')); }
        else { vscode.window.showErrorMessage('Claude Code test failed: ' + (out.error ?? 'unknown')); }
        return;
      }

      const { LanguageModelAdapter } = require('./core/languageModelAdapter') as typeof import('./core/languageModelAdapter');
      const model = configManager.getSettings().activeLlmModel;
      const { info, adapter } = await LanguageModelAdapter.detect(context, { provider: 'copilot', model });
      if (!info.found || !info.hasAccess || !adapter) {
        vscode.window.showInformationMessage(info.error || 'GitHub Copilot is not available. Sign in and try again.');
        return;
      }
      if (info.consentRequired) {
        const choice = await vscode.window.showInformationMessage('Copilot available. Open handoff editor?', 'Open Handoff', 'Cancel');
        if (choice === 'Open Handoff') { await vscode.commands.executeCommand(`${EXTENSION_ID}.copilotHandoff`); }
        return;
      }
      const out = await adapter.testCall();
      if (out.ok) { vscode.window.showInformationMessage('GitHub Copilot test succeeded: ' + (out.text ? out.text.slice(0, 120) : '[no-text]')); }
      else { vscode.window.showErrorMessage('GitHub Copilot test failed: ' + (out.error ?? 'unknown')); }
    } catch (err) {
      vscode.window.showErrorMessage('Language model test error: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const listLanguageModelInfoHandler = async (providerArg?: unknown) => {
    const provider = asLmProvider(providerArg) ?? activeLmProvider();
    try {
      if (provider === 'claude') {
        const { ClaudeCodeAdapter } = require('./core/claudeCodeAdapter') as typeof import('./core/claudeCodeAdapter');
        const { info } = await ClaudeCodeAdapter.detect(configManager.getSettings().claudeCodePath);
        const msg = info.error
          ? `Claude Code: ${info.error}`
          : `Claude Code: found via ${info.cliSource}${info.version ? ` (${info.version})` : ''} at ${info.cliPath}`;
        vscode.window.showInformationMessage(msg);
        return;
      }
      const { LanguageModelAdapter } = require('./core/languageModelAdapter') as typeof import('./core/languageModelAdapter');
      const { info } = await LanguageModelAdapter.detect(context, { provider: 'copilot', model: configManager.getSettings().activeLlmModel });
      const modelSummary = info.models.slice(0, 5).map((m) => `${m.family} (${m.name})`).join(', ');
      const msg = info.error || `Copilot: found=${info.found} hasAccess=${info.hasAccess} vendors=[${info.vendors.join(', ')}] models=${info.models.length}${modelSummary ? ` [${modelSummary}]` : ''}${info.consentRequired ? ' consent required' : ''}`;
      vscode.window.showInformationMessage(msg);
    } catch (err) {
      vscode.window.showErrorMessage('Error listing language model info: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  // Enumerate every chat model exposed through vscode.lm (across all vendors),
  // and report where the Claude Code CLI resolves from — the fastest way to see
  // what each provider will actually use.
  const listLanguageModels = vscode.commands.registerCommand(`${EXTENSION_ID}.listLanguageModels`, async () => {
    const out = vscode.window.createOutputChannel('autoDE:language-models');
    out.show(true);
    try {
      const { LanguageModelAdapter } = require('./core/languageModelAdapter') as typeof import('./core/languageModelAdapter');
      const models = await LanguageModelAdapter.listAll();
      out.appendLine(`vscode.lm exposes ${models.length} chat model(s):`);
      for (const m of models) {
        out.appendLine(`- vendor=${m.vendor} family=${m.family} id=${m.id} name="${m.name}" maxInputTokens=${m.maxInputTokens}`);
      }
      out.appendLine('');
      const { ClaudeCodeAdapter } = require('./core/claudeCodeAdapter') as typeof import('./core/claudeCodeAdapter');
      const r = ClaudeCodeAdapter.resolve(configManager.getSettings().claudeCodePath);
      out.appendLine(
        r.cliPath
          ? `Claude Code CLI: ${r.cliPath} (via ${r.source}${r.version ? `, ${r.version}` : ''}) — used by the "claude" provider.`
          : `Claude Code CLI: NOT FOUND. ${r.error ?? ''}`
      );
    } catch (err) {
      out.appendLine('Error: ' + (err instanceof Error ? err.message : String(err)));
    }
  });

  const testLanguageModel = vscode.commands.registerCommand(`${EXTENSION_ID}.testLanguageModel`, testLanguageModelHandler);
  const listLanguageModelInfo = vscode.commands.registerCommand(`${EXTENSION_ID}.listLanguageModelInfo`, listLanguageModelInfoHandler);
  // Back-compat command ids — now generalized to the active LM provider.
  const testCopilot = vscode.commands.registerCommand(`${EXTENSION_ID}.testCopilot`, testLanguageModelHandler);
  const listCopilotInfo = vscode.commands.registerCommand(`${EXTENSION_ID}.listCopilotInfo`, listLanguageModelInfoHandler);

  const debugListExtensions = vscode.commands.registerCommand(`${EXTENSION_ID}.debugListExtensions`, async () => {
    const out = vscode.window.createOutputChannel('autoDE:extensions-debug');
    out.show(true);
    out.appendLine('Enumerating installed extensions:');
    try {
      for (const ext of (vscode.extensions.all || [])) {
        try { out.appendLine(`- ${ext.id} :: ${ext.packageJSON?.displayName || ext.packageJSON?.name || '<no-name>'} :: active=${String(ext.isActive)}`); } catch { out.appendLine(`- ${ext.id} :: <error>`); }
      }
    } catch (err) { out.appendLine('Error: ' + (err instanceof Error ? err.message : String(err))); }
  });

  const copilotHandoff = vscode.commands.registerCommand(`${EXTENSION_ID}.copilotHandoff`, async (seedPrompt?: string) => {
    const prompt = typeof seedPrompt === 'string' && seedPrompt.trim().length > 0 ? seedPrompt : '/* Copilot interactive handoff */\n';
    try {
      const doc = await vscode.workspace.openTextDocument({ content: prompt, language: 'plaintext' });
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const lastLine = doc.lineCount - 1;
      editor.selection = new vscode.Selection(new vscode.Position(lastLine, doc.lineAt(lastLine).text.length), new vscode.Position(lastLine, doc.lineAt(lastLine).text.length));
      try { await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger'); } catch { await vscode.commands.executeCommand('editor.action.triggerSuggest'); }
      vscode.window.showInformationMessage('Opened handoff editor for Copilot suggestions.');
    } catch (err) { vscode.window.showErrorMessage('Failed to open handoff editor: ' + (err instanceof Error ? err.message : String(err))); }
  });

  /**
   * Shared by `testConnection`/`testTargetConnection` (v0.19.0) — same logic,
   * parameterized by role, so source and target don't drift into two
   * independently-maintained copies. Reads/writes the role-appropriate
   * `ConnectionManager` handle and settings/secrets (see
   * `ConnectionManager.getCredentialsFromSettings()`'s `role` param).
   */
  async function runConnectionTest(role: 'source' | 'target'): Promise<void> {
    const commandId = role === 'target' ? `${EXTENSION_ID}.testTargetConnection` : `${EXTENSION_ID}.testConnection`;
    try {
      const settings = configManager.getSettings();
      const platform = (role === 'target' ? settings.defaultTargetProvider : settings.defaultProvider) ?? 'snowflake';
      const credentials = ConnectionManager.getCredentialsFromSettings(platform, settings as unknown as Record<string, unknown>, role);
      if (platform === 'snowflake') {
        const password = role === 'target' ? await configManager.getTargetSnowflakePassword() : await configManager.getSnowflakePassword();
        if (password) credentials['password'] = password;
        const passphrase = role === 'target' ? await configManager.getTargetSnowflakePrivateKeyPassphrase() : await configManager.getSnowflakePrivateKeyPassphrase();
        if (passphrase) credentials['privateKeyPassphrase'] = passphrase;
      } else if (platform === 'databricks') {
        const token = role === 'target' ? await configManager.getTargetDatabricksToken() : await configManager.getDatabricksToken();
        if (token) credentials['token'] = token;
      }
      // Only what every Snowflake execution path genuinely requires up front —
      // Warehouse/Database used to be hardcoded here too, but that drifted out of
      // sync with SnowflakeAdapter's real requirements (Database is REST-tier-only;
      // Warehouse isn't required by any path, since Snowflake falls back to the
      // account's default warehouse). Anything else missing is surfaced by
      // SnowflakeAdapter.connect() itself with a path-specific, accurate message.
      const missing: string[] = [];
      if (platform === 'snowflake') { if (!credentials['account']) missing.push('Account'); if (!credentials['username']) missing.push('Username'); }
      else if (platform === 'databricks') { if (!credentials['workspaceUrl']) missing.push('Workspace URL'); if (!credentials['httpPath']) missing.push('SQL Warehouse HTTP Path'); if (!credentials['token']) missing.push('Token'); }
      if (missing.length > 0) {
        const msg = `Missing ${role} credentials for ${platform}: ${missing.join(', ')}`;
        vscode.window.showErrorMessage(msg);
        sidebarProvider.logToChat(msg);
        return;
      }
      const newManager = new ConnectionManager(
        (msg: string) => { console.log(`[AutoDE ${role} Connection] ${msg}`); sidebarProvider.logToChat(msg); },
        { cliConsent: () => configManager.getSettings().dataPlatformCliConsent === true }
      );
      // Phase K1: extractions are tagged with the estate system this connection feeds.
      newManager.setEstateResolver((id) => sidebarProvider.resolveConnectionIdentity(id, role));
      if (role === 'target') { targetConnectionManager?.dispose(); targetConnectionManager = newManager; } else { connectionManager?.dispose(); connectionManager = newManager; }
      const info = await newManager.connect(platform, credentials);
      const successMsg = `Connected to ${role} ${platform}: ${info.databaseName}.${info.schemaName} (v${info.version})`;
      vscode.window.showInformationMessage(successMsg);
      sidebarProvider.logToChat(successMsg);
      // This only proves connectivity — it does NOT extract schema (that's
      // "Source Assessment", a source-only, separate step), so the status
      // pill/chat context should say "connected" without implying tables are
      // already known.
      sidebarProvider.notifyConnectionStatus(role, { connected: true, platform, detail: `${info.databaseName}.${info.schemaName}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // CLI-execution consent is an easy first-connection trip-up now that
      // username/password auth also routes through the CLI (it needs the same
      // consent a CLI-derived connection already required) — offer to flip the
      // one setting and retry immediately, rather than sending the user hunting
      // through Settings JSON for a boolean they may not know exists.
      if (message.includes('dataPlatformCliConsent')) {
        const choice = await vscode.window.showErrorMessage(`Connection failed: ${message}`, 'Enable CLI Consent & Retry');
        if (choice === 'Enable CLI Consent & Retry') {
          await configManager.updateSettings({ dataPlatformCliConsent: true });
          sidebarProvider.logToChat('Enabled "autoDataEngineeringHub.dataPlatformCliConsent" — retrying connection…');
          await vscode.commands.executeCommand(commandId);
          return;
        }
      }
      const failMsg = `Connection failed: ${message}`;
      vscode.window.showErrorMessage(failMsg);
      sidebarProvider.logToChat(failMsg);
      sidebarProvider.notifyConnectionStatus(role, { connected: false });
    }
  }

  const testConnection = vscode.commands.registerCommand(`${EXTENSION_ID}.testConnection`, () => runConnectionTest('source'));
  const testTargetConnection = vscode.commands.registerCommand(`${EXTENSION_ID}.testTargetConnection`, () => runConnectionTest('target'));

  // Returns its real outcome (not just void) so webviewProvider.ts's webview handler
  // can react to what actually happened instead of duplicating this logic itself or
  // guessing — the exact bug class this command previously fell into with a second,
  // parallel "sourceAssessment" webview case that only reloaded already-on-disk
  // context and unconditionally reported success without ever touching a live
  // connection at all.
  const sourceAssessment = vscode.commands.registerCommand(
    `${EXTENSION_ID}.sourceAssessment`,
    async (): Promise<{ success: boolean; tableCount?: number; viewCount?: number; error?: string }> => {
      try {
        if (!connectionManager || !connectionManager.isConnected()) {
          await vscode.commands.executeCommand(`${EXTENSION_ID}.testConnection`);
          if (!connectionManager || !connectionManager.isConnected()) {
            const msg = 'Not connected to a data platform.';
            vscode.window.showErrorMessage(msg);
            sidebarProvider.logToChat(msg);
            return { success: false, error: msg };
          }
        }
        vscode.window.showInformationMessage('Running source assessment...');
        sidebarProvider.logToChat('Running source assessment…');
        const snapshot = await connectionManager.extractMetadata({ includeProfiling: true });
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (wsRoot) { await connectionManager.persistSchemaContext(snapshot, wsRoot.fsPath, createVscodeFileIo(vscode)); }
        const doneMsg = `Source assessment complete: ${snapshot.tables.length} tables, ${snapshot.views.length} views.`;
        vscode.window.showInformationMessage(doneMsg);
        sidebarProvider.logToChat(doneMsg);
        const platform = configManager.getSettings().defaultProvider ?? 'snowflake';
        sidebarProvider.notifyConnectionStatus('source', { connected: true, platform, detail: `${snapshot.tables.length} tables, ${snapshot.views.length} views extracted` });
        return { success: true, tableCount: snapshot.tables.length, viewCount: snapshot.views.length };
      } catch (err) {
        const failMsg = `Source assessment failed: ${err instanceof Error ? err.message : String(err)}`;
        vscode.window.showErrorMessage(failMsg);
        sidebarProvider.logToChat(failMsg);
        return { success: false, error: failMsg };
      }
    }
  );

  /**
   * Step 7 (governance layer) — the explicit, never-silent "re-verify" action
   * the architecture review called for: nothing today re-validates captured
   * context against a live source after the fact, so an unnoticed drift
   * becomes a real correctness risk once specs/pipelines are generated off
   * stale context. Re-runs the real Source Assessment extraction (the same
   * one `sourceAssessment` already does) and — the part that's actually new —
   * diffs the source-tagged table set before/after and reports the drift in
   * plain terms, rather than silently overwriting context with no visible
   * signal that anything changed. Never removes a table from context on its
   * own initiative even if it's missing from the fresh extraction: a table
   * temporarily inaccessible (a permissions change, a network blip) should
   * surface as a flag for the user to investigate, not silently vanish.
   */
  const reVerifySourceSchema = vscode.commands.registerCommand(`${EXTENSION_ID}.reVerifySourceSchema`, async () => {
    const before = new Set(sidebarProvider.listSourceTableFqns());
    const result = await vscode.commands.executeCommand<{ success: boolean; tableCount?: number; viewCount?: number; error?: string }>(
      `${EXTENSION_ID}.sourceAssessment`
    );
    if (!result?.success) return; // sourceAssessment already reported its own error
    const after = new Set(sidebarProvider.listSourceTableFqns());
    const added = [...after].filter((fqn) => !before.has(fqn));
    const removed = [...before].filter((fqn) => !after.has(fqn));
    const unchanged = [...after].filter((fqn) => before.has(fqn)).length;

    const lines = [`Re-verified source schema: ${unchanged} table(s)/view(s) confirmed still present.`];
    if (added.length > 0) lines.push(`${added.length} new: ${added.join(', ')}`);
    if (removed.length > 0) lines.push(`${removed.length} no longer found in this extraction (may lack access, or may have been dropped — review before assuming they're gone): ${removed.join(', ')}`);
    if (added.length === 0 && removed.length === 0 && before.size > 0) lines.push('No drift detected.');
    const msg = lines.join(' ');
    vscode.window.showInformationMessage(msg);
    sidebarProvider.logToChat(msg);
  });

  /** Shared by `disconnectDataPlatform`/`disconnectTargetDataPlatform` (v0.19.0) — same logic, parameterized by role. */
  async function runDisconnect(role: 'source' | 'target'): Promise<void> {
    const mgr = role === 'target' ? targetConnectionManager : connectionManager;
    if (!mgr || !mgr.isConnected()) {
      const msg = `Not currently connected to a ${role} data platform.`;
      vscode.window.showInformationMessage(msg);
      sidebarProvider.logToChat(msg);
      return;
    }
    try {
      await mgr.disconnect();
      const msg = `Disconnected from the ${role} data platform.`;
      vscode.window.showInformationMessage(msg);
      sidebarProvider.logToChat(msg);
    } catch (err) {
      const failMsg = `Disconnect failed: ${err instanceof Error ? err.message : String(err)}`;
      vscode.window.showErrorMessage(failMsg);
      sidebarProvider.logToChat(failMsg);
    } finally {
      // Reported unconditionally, even if the adapter's own disconnect() threw —
      // the local ConnectionManager handle is gone either way (isConnected() will
      // report false from here on), so chat/the status pill must not keep
      // claiming a connection that no longer exists on AutoDE's side.
      sidebarProvider.notifyConnectionStatus(role, { connected: false });
    }
  }

  const disconnectDataPlatform = vscode.commands.registerCommand(`${EXTENSION_ID}.disconnectDataPlatform`, () => runDisconnect('source'));
  const disconnectTargetDataPlatform = vscode.commands.registerCommand(`${EXTENSION_ID}.disconnectTargetDataPlatform`, () => runDisconnect('target'));

  /**
   * Step 4 of the Source & Target Context Architecture plan — "don't assume
   * the whole account is relevant." Connects (if not already), lists the real
   * databases/catalogs and schemas via the adapter's new `listDatabases()`/
   * `listSchemas()`, and lets the user pick from what's actually there via a
   * native QuickPick rather than typing a name blindly. Writes the selection
   * straight into settings (bypassing the webview's own save flow, since this
   * runs from a command/button, not a form submit) and pushes a refresh so
   * the panel's displayed fields don't go stale.
   */
  async function browseDatabaseAndSchema(role: 'source' | 'target'): Promise<void> {
    let mgr = role === 'target' ? targetConnectionManager : connectionManager;
    if (!mgr || !mgr.isConnected()) {
      await runConnectionTest(role);
      mgr = role === 'target' ? targetConnectionManager : connectionManager;
      if (!mgr || !mgr.isConnected()) { return; } // runConnectionTest already reported why
    }
    try {
      const databases = await mgr.listDatabases();
      if (databases.length === 0) {
        const msg = `No databases/catalogs found for the ${role} connection.`;
        vscode.window.showInformationMessage(msg);
        sidebarProvider.logToChat(msg);
        return;
      }
      const database = await vscode.window.showQuickPick(databases, { title: `Choose a ${role} database/catalog`, placeHolder: `${databases.length} found` });
      if (!database) return;

      const schemas = await mgr.listSchemas(database);
      let schema: string | undefined;
      let picked: string[] = [];
      if (schemas.length > 0) {
        // Phase K1: several schemas per connection. The first becomes the connection's
        // default schema; all of them are recorded on the connection's estate binding
        // and extracted by Source Assessment.
        picked = (await vscode.window.showQuickPick(schemas, { title: `Choose ${role} schema(s)`, placeHolder: `${schemas.length} found in ${database} — pick one or more`, canPickMany: true })) ?? [];
        if (picked.length === 0) return; // cancel means cancel
        schema = picked[0];
      }

      const platform = (role === 'target' ? configManager.getSettings().defaultTargetProvider : configManager.getSettings().defaultProvider) ?? 'snowflake';
      const patch: Partial<DataAgentHubSettings> = {};
      if (platform === 'snowflake') {
        if (role === 'target') { patch.defaultTargetSnowflakeDatabase = database; if (schema) patch.defaultTargetSnowflakeSchema = schema; }
        else { patch.defaultSnowflakeDatabase = database; if (schema) patch.defaultSnowflakeSchema = schema; }
      } else if (platform === 'databricks') {
        if (role === 'target') { patch.defaultTargetDatabricksCatalog = database; if (schema) patch.defaultTargetDatabricksSchema = schema; }
        else { patch.defaultDatabricksCatalog = database; if (schema) patch.defaultDatabricksSchema = schema; }
      } else {
        vscode.window.showInformationMessage(`Database/schema browsing isn't wired up for "${platform}" yet.`);
        return;
      }
      await configManager.updateSettings(patch);
      await sidebarProvider.refreshSettingsInWebview();
      const connId = mgr.activeConnectionId();
      if (connId && picked.length > 0) {
        const r = sidebarProvider.resolveConnectionIdentity(connId, role);
        if (r) sidebarProvider.bindToSystem({ connection: connId, system: r.identity.system, environment: r.identity.environment, schemas: picked.map((s) => `${database}.${s}`) }, undefined, role);
      }
      const msg = `Selected ${role} ${platform} scope: ${database}.${picked.length > 1 ? `{${picked.join(', ')}}` : (schema ?? '')}.`;
      vscode.window.showInformationMessage(msg);
      sidebarProvider.logToChat(msg);
    } catch (err) {
      const msg = `Could not list ${role} databases/schemas: ${err instanceof Error ? err.message : String(err)}`;
      vscode.window.showErrorMessage(msg);
      sidebarProvider.logToChat(msg);
    }
  }

  const browseSourceDatabase = vscode.commands.registerCommand(`${EXTENSION_ID}.browseSourceDatabase`, () => browseDatabaseAndSchema('source'));
  const browseTargetDatabase = vscode.commands.registerCommand(`${EXTENSION_ID}.browseTargetDatabase`, () => browseDatabaseAndSchema('target'));

  /**
   * Step 5 of the Source & Target Context Architecture plan — real,
   * structural file-based ingestion (CSV/JSON/DDL) for when live connectivity
   * isn't available (security restrictions, network boundaries, third-party-
   * managed systems). Deliberately source-only: the reviewed proposal lists
   * file ingestion under the Source Panel's responsibilities, not Target's.
   * Writes directly into the same shared schema graph a live connection's
   * Source Assessment does, via `ingestFileIntoGraph()` — so it's visible
   * everywhere `ContextFileManager.buildContextPrompt()` already is, with no
   * new rendering path needed. Consistent with the same known, documented gap
   * as `testConnection`/`sourceAssessment`: this does not also write a
   * `SourceContext` record, since that's spec-scoped and this command (like
   * those two) runs without necessarily having an active business problem.
   */
  const ingestFileAsSourceContext = vscode.commands.registerCommand(`${EXTENSION_ID}.ingestFileAsSourceContext`, async () => {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'Structured data files (CSV, JSON, DDL)': ['csv', 'json', 'sql', 'ddl'] },
      title: 'Select a CSV, JSON, or DDL (.sql) file to ingest as Source Context'
    });
    if (!picked || picked.length === 0) return;
    const fileUri = picked[0];
    const fileName = path.basename(fileUri.fsPath);
    const format = detectFileFormat(fileUri.fsPath);
    if (!format) {
      const msg = `Unsupported file type: ${fileName}. Supported: .csv, .json, .sql, .ddl.`;
      vscode.window.showErrorMessage(msg);
      sidebarProvider.logToChat(msg);
      return;
    }
    // Phase K1: which system (and environment) does this file describe?
    const estate = sidebarProvider.getEstate();
    const suggested = resolveIdentity(estate ?? emptyEstate(), { file: fileUri.fsPath }).identity; // a suggestion only — nothing is saved until the user picks
    const systemPick = await vscode.window.showQuickPick(
      [
        ...(suggested ? [{ label: suggested.system ?? '', description: `environment ${suggested.environment ?? 'default'} (suggested)`, system: suggested.system ?? '', environment: suggested.environment }] : []),
        ...(estate?.systems ?? []).filter((s) => s.id !== suggested?.system).map((s) => ({ label: s.id, description: `${s.name} · ${s.role}`, system: s.id, environment: undefined as string | undefined }))
      ],
      { title: `Which system does ${fileName} describe?`, placeHolder: 'Pick a system (edit .ai-context/estate.yaml to add systems, environments or roles)' }
    );
    if (!systemPick) return;
    sidebarProvider.bindToSystem({ file: fileName, system: systemPick.system, ...(systemPick.environment ? { environment: systemPick.environment } : {}) });
    try {
      const contentBytes = await vscode.workspace.fs.readFile(fileUri);
      const content = Buffer.from(contentBytes).toString('utf8');
      const result = parseFile(content, fileUri.fsPath, { system: systemPick.system, environment: systemPick.environment });
      if (result.tableCount === 0) {
        const msg = `Could not parse any tables from ${fileName}: ${result.warnings.join(' ') || 'unknown reason'}`;
        vscode.window.showErrorMessage(msg);
        sidebarProvider.logToChat(msg);
        return;
      }
      await sidebarProvider.ingestFileIntoGraph(result.nodes, result.edges);
      const doneMsg = `Ingested ${fileName}: ${result.tableCount} table(s), ${result.columnCount} column(s).${result.warnings.length > 0 ? ' (' + result.warnings.join(' ') + ')' : ''}`;
      vscode.window.showInformationMessage(doneMsg);
      sidebarProvider.logToChat(doneMsg);
    } catch (err) {
      const msg = `File ingestion failed for ${fileName}: ${err instanceof Error ? err.message : String(err)}`;
      vscode.window.showErrorMessage(msg);
      sidebarProvider.logToChat(msg);
    }
  });

  /**
   * Step 6 of the Source & Target Context Architecture plan — a QuickPick-
   * driven flow to record one source→target `EntityMapping` into the active
   * spec's Mapping Context. Both sides are picked from the same shared graph
   * (`listMappableTables()`), per the architecture review's unified-graph
   * decision — there's no separate "target graph" to pick from. A target
   * table can also be typed freehand for Greenfield work, where no target
   * node exists yet. Column mappings are auto-matched by case-insensitive
   * name; per this codebase's QuickPick-only UX convention (no bespoke visual
   * mapping editor), fine-grained column edits happen by editing the saved
   * `context/mapping-context.yaml` directly.
   */
  const createMapping = vscode.commands.registerCommand(`${EXTENSION_ID}.createMapping`, async () => {
    const specInfo = sidebarProvider.getMappingSpecInfo();
    if (!specInfo) { vscode.window.showErrorMessage('No active business problem — approve a specification first.'); return; }

    const tables = sidebarProvider.listMappableTables();
    if (tables.length === 0) { vscode.window.showErrorMessage('No tables in context yet — connect a data platform or ingest a file first.'); return; }

    const sourcePick = await vscode.window.showQuickPick(
      tables.map((t) => ({ label: t.label, description: t.fqn, id: t.id })),
      { title: 'Create Mapping — choose the SOURCE table', placeHolder: `${tables.length} table(s) available` }
    );
    if (!sourcePick) return;

    const targetChoice = await vscode.window.showQuickPick(
      [
        { label: '$(edit) Enter target table name manually…', pickKind: 'manual' as const },
        ...tables.map((t) => ({ label: t.label, description: t.fqn, id: t.id, pickKind: 'graph' as const }))
      ],
      { title: 'Create Mapping — choose the TARGET table', placeHolder: 'Pick an existing table, or enter a new one for Greenfield work' }
    );
    if (!targetChoice) return;

    let targetEntityId: string | undefined;
    let targetName: string;
    let targetColumns: Array<{ id: string; label: string }> = [];
    if (targetChoice.pickKind === 'manual') {
      const typed = await vscode.window.showInputBox({ title: 'Target table name', placeHolder: 'e.g. dim_customer', validateInput: (v) => (v.trim() ? undefined : 'Required') });
      if (!typed) return;
      targetName = typed.trim();
    } else {
      targetEntityId = (targetChoice as { id: string }).id;
      targetName = targetChoice.label;
      targetColumns = sidebarProvider.listTableColumns(targetEntityId);
    }

    const sourceColumns = sidebarProvider.listTableColumns(sourcePick.id);
    const columns = sourceColumns.map((sc) => {
      const match = targetColumns.find((tc) => tc.label.toLowerCase() === sc.label.toLowerCase());
      return { sourceColumn: sc.label, targetColumn: match ? match.label : sc.label };
    });

    const notes = await vscode.window.showInputBox({ title: 'Notes (optional)', placeHolder: 'Any mapping notes — leave blank to skip' });

    const mapping = {
      id: `map-${sourcePick.id}-${targetEntityId ?? targetName}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
      sourceEntityId: sourcePick.id,
      sourceFqn: sourcePick.description ?? sourcePick.label,
      targetEntityId,
      targetName,
      columns,
      notes: notes?.trim() || undefined
    };

    try {
      await sidebarProvider.upsertEntityMapping(mapping);
      const msg = `Mapping saved: ${sourcePick.label} → ${targetName} (${columns.length} column(s)).`;
      vscode.window.showInformationMessage(msg);
      sidebarProvider.logToChat(msg);
    } catch (err) {
      const msg = `Could not save mapping: ${err instanceof Error ? err.message : String(err)}`;
      vscode.window.showErrorMessage(msg);
      sidebarProvider.logToChat(msg);
    }
  });

  /**
   * The second half of Step 6 — an explicit, spec-pinned snapshot of the
   * already-unified semantic graph (per the architecture review's Q3, the
   * graph itself doesn't need a second modeling system; this just captures
   * its state at a point in time, mirroring the version-pinning
   * `PipelineSpec`/primitive-versioning already use elsewhere). Never runs
   * automatically — a real snapshot action, not a background sync.
   */
  const buildSemanticLayer = vscode.commands.registerCommand(`${EXTENSION_ID}.buildSemanticLayer`, async () => {
    try {
      const snapshot = await sidebarProvider.buildSemanticLayer();
      if (!snapshot) {
        vscode.window.showErrorMessage('No active business problem — approve a specification first.');
        return;
      }
      const msg = `Unified Semantic Layer snapshot built: spec v${snapshot.specVersion} rev${snapshot.version} (${snapshot.nodeCount} node(s), ${snapshot.edgeCount} edge(s)).`;
      vscode.window.showInformationMessage(msg);
      sidebarProvider.logToChat(msg);
    } catch (err) {
      const msg = `Could not build the Unified Semantic Layer snapshot: ${err instanceof Error ? err.message : String(err)}`;
      vscode.window.showErrorMessage(msg);
      sidebarProvider.logToChat(msg);
    }
  });

  // Phase K1 (v0.31.0): the estate — systems, environments, roles and which
  // connections/files feed them — lives in .ai-context/estate.yaml.
  const openEstate = vscode.commands.registerCommand(`${EXTENSION_ID}.openEstate`, async () => {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!wsRoot) { vscode.window.showErrorMessage('Open a workspace folder first.'); return; }
    const uri = vscode.Uri.joinPath(wsRoot, '.ai-context', 'estate.yaml');
    try { await vscode.workspace.fs.stat(uri); } catch {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(serializeEstate(sidebarProvider.getEstate() ?? emptyEstate()), 'utf8'));
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  });

  // C3 (v0.30.0, docs/context-layer-requirements.md §7.1): the exact context a
  // plan step, chat reply or spec call was given, with its manifest.
  const whatTheAgentSaw = vscode.commands.registerCommand(`${EXTENSION_ID}.whatTheAgentSaw`, async () => {
    const packs = sidebarProvider.getRecentContextPacks();
    if (packs.length === 0) { vscode.window.showInformationMessage('No context has been sent to an LLM in this session yet.'); return; }
    const pick = await vscode.window.showQuickPick(
      packs.map((p, i) => ({ label: p.title, description: `${p.pack.manifest.purpose} · ${p.pack.manifest.tokenCount} tokens · ${p.pack.manifest.assertions.length} assertions`, detail: p.at, index: i })),
      { title: 'What the agent saw', placeHolder: 'Pick an LLM call (newest first)' }
    );
    if (!pick) return;
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: sidebarProvider.renderContextPack(packs[pick.index]) });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  // C3 (v0.30.0, §8.3): artifact → decisions → assertions → evidence, from its grounding manifest.
  const explainArtifact = vscode.commands.registerCommand(`${EXTENSION_ID}.explainArtifact`, async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) { vscode.window.showErrorMessage('Open a generated artifact first.'); return; }
    const text = await sidebarProvider.explainArtifact(target);
    if (!text) { vscode.window.showInformationMessage(`${path.basename(target.fsPath)} has no grounding manifest — it was not generated by an AutoDE plan step (or predates v0.30.0).`); return; }
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: text });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  });

  // C2 (v0.29.0, docs/context-layer-requirements.md §4.2): snapshot the assertion
  // ledger. History is kept unless the user explicitly picks the prune option.
  const compactContextLedger = vscode.commands.registerCommand(`${EXTENSION_ID}.compactContextLedger`, async () => {
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Compact', description: 'Write a snapshot; keep the full event history', prune: false },
        { label: 'Compact and prune history', description: 'Write a snapshot, then delete the event files it replaces (cannot be undone)', prune: true }
      ],
      { title: 'Compact Context Ledger' }
    );
    if (!choice) return;
    try {
      const result = await sidebarProvider.compactContextLedger(choice.prune);
      if (!result) { vscode.window.showErrorMessage('The context layer is not initialized yet — open the AutoDE panel first.'); return; }
      const msg = `Context ledger compacted: ${result.assertions} assertion(s) in snapshot.json${choice.prune ? `, ${result.prunedFiles} event file(s) pruned` : ''}.`;
      vscode.window.showInformationMessage(msg);
      sidebarProvider.logToChat(msg);
    } catch (err) {
      vscode.window.showErrorMessage(`Could not compact the context ledger: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const syncMetadata = vscode.commands.registerCommand(`${EXTENSION_ID}.syncMetadata`, async () => {
    try {
      if (!connectionManager || !connectionManager.isConnected()) { vscode.window.showErrorMessage('Not connected. Connect first via Settings → Connections.'); return; }
      vscode.window.showInformationMessage('Syncing metadata...');
      const snapshot = await connectionManager.extractMetadata({ includeProfiling: false });
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (wsRoot) { await connectionManager.persistSchemaContext(snapshot, wsRoot.fsPath, createVscodeFileIo(vscode)); }
      vscode.window.showInformationMessage(`Metadata sync complete: ${snapshot.tables.length} tables, ${snapshot.views.length} views.`);
    } catch (err) { vscode.window.showErrorMessage(`Metadata sync failed: ${err instanceof Error ? err.message : String(err)}`); }
  });

  const reindex = vscode.commands.registerCommand(`${EXTENSION_ID}.reindex`, async () => {
    vscode.window.showInformationMessage('Context re-index triggered.');
  });

  // Imports a Claude Agent Skill (a folder containing SKILL.md + optional
  // resources) into .ai-context/skills/tool-skills/<id>/ — Phase D.
  const importToolSkill = vscode.commands.registerCommand(`${EXTENSION_ID}.importToolSkill`, async () => {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!wsRoot) { vscode.window.showErrorMessage('Open a workspace folder first.'); return; }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
      openLabel: 'Import as a tool skill', title: 'Select a skill folder (must contain SKILL.md)'
    });
    const sourceUri = picked?.[0];
    if (!sourceUri) { return; }
    try {
      const skillMdUri = vscode.Uri.joinPath(sourceUri, 'SKILL.md');
      await vscode.workspace.fs.stat(skillMdUri); // throws if missing
      const id = sourceUri.fsPath.split(/[\\/]/).filter(Boolean).pop()?.replace(/[^a-zA-Z0-9_-]+/g, '_') || `skill-${Date.now().toString(36)}`;
      const targetDir = vscode.Uri.joinPath(wsRoot, '.ai-context', 'skills', 'tool-skills', id);
      await copyDirectoryRecursive(sourceUri, targetDir);
      const { loadToolSkill } = require('./engine/skills/toolSkills') as typeof import('./engine/skills/toolSkills');
      const skill = loadToolSkill(targetDir.fsPath, id);
      const toolsNote = skill.declaredTools?.length ? ` Declares tools: ${skill.declaredTools.join(', ')}.` : '';
      vscode.window.showInformationMessage(
        `Imported skill "${skill.name}" (id: ${id}, ${skill.resourceFiles.length} resource file(s)).${toolsNote} Run it with the "▶ Run Skill" action or /skill ${id} <instruction> in chat.`
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}. Make sure the folder contains a SKILL.md file.`);
    }
  });

  // Lists imported tool skills and runs the chosen one with real tool access
  // (file write / command execution, gated by consent + approval dialogs).
  const runToolSkill = vscode.commands.registerCommand(`${EXTENSION_ID}.runToolSkill`, async () => {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!wsRoot) { vscode.window.showErrorMessage('Open a workspace folder first.'); return; }
    const { loadToolSkillsFromDirectory } = require('./engine/skills/toolSkills') as typeof import('./engine/skills/toolSkills');
    const toolSkillsDir = vscode.Uri.joinPath(wsRoot, '.ai-context', 'skills', 'tool-skills').fsPath;
    const skills = loadToolSkillsFromDirectory(toolSkillsDir);
    if (skills.length === 0) { vscode.window.showInformationMessage('No tool skills imported yet. Run "AutoDE: Import Tool Skill" first.'); return; }
    const picked = await vscode.window.showQuickPick(
      skills.map((s) => ({ label: s.name, description: s.id, detail: s.description })),
      { title: 'Run a tool-executing skill', placeHolder: 'Choose a skill' }
    );
    if (!picked) { return; }
    const instruction = await vscode.window.showInputBox({ title: `Instruction for "${picked.label}"`, placeHolder: 'What should this run do?' });
    if (!instruction || !instruction.trim()) { return; }
    vscode.window.showInformationMessage(`Running skill "${picked.label}"…`);
    const result = await hub.runToolSkill(picked.description!, instruction.trim());
    if (result.success) { vscode.window.showInformationMessage(`Skill "${picked.label}" completed: ${result.message.slice(0, 200)}`); }
    else { vscode.window.showErrorMessage(`Skill "${picked.label}" failed: ${result.error || result.message}`); }
  });

  // ── Chat sessions (Phase D5... Phase F, v0.9.0) ──

  const newChat = vscode.commands.registerCommand(`${EXTENSION_ID}.newChat`, async () => {
    await sidebarProvider.triggerNewChat();
  });

  const chatHistory = vscode.commands.registerCommand(`${EXTENSION_ID}.chatHistory`, async () => {
    const manager = sidebarProvider.getChatSessionManager();
    if (!manager) { vscode.window.showInformationMessage('Open the AutoDE sidebar first.'); return; }
    const sessions = await manager.listSessions();
    if (sessions.length === 0) { vscode.window.showInformationMessage('No chat sessions yet.'); return; }
    const picked = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: (s.title || '(no messages yet)') + (s.status === 'active' ? ' — active' : ''),
        description: `${s.status} · ${new Date(s.updatedAt).toLocaleString()}`,
        detail: s.specId ? `spec ${s.specId} v${s.specVersion}` : undefined,
        chatId: s.id
      })),
      { title: 'Chat History', placeHolder: 'Select a chat to view its transcript' }
    );
    if (!picked) { return; }
    const transcript = await manager.loadTranscript(picked.chatId);
    const text = transcript.length === 0
      ? '(empty chat)'
      : transcript.map((m) => `[${m.at}] ${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
    const doc = await vscode.workspace.openTextDocument({ content: `# Chat ${picked.chatId}\n\n${text}`, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  const discardChat = vscode.commands.registerCommand(`${EXTENSION_ID}.discardChat`, async () => {
    const manager = sidebarProvider.getChatSessionManager();
    if (!manager) { vscode.window.showInformationMessage('Open the AutoDE sidebar first.'); return; }
    const sessions = await manager.listSessions();
    if (sessions.length === 0) { vscode.window.showInformationMessage('No chat sessions yet.'); return; }
    const picked = await vscode.window.showQuickPick(
      sessions.map((s) => ({ label: (s.title || '(no messages yet)') + (s.status === 'active' ? ' — active' : ''), description: s.status, chatId: s.id })),
      { title: 'Discard a chat', placeHolder: 'Select a chat to permanently discard' }
    );
    if (!picked) { return; }
    const confirm = await vscode.window.showWarningMessage(`Permanently discard "${picked.label}"? This cannot be undone.`, { modal: true }, 'Discard');
    if (confirm !== 'Discard') { return; }
    await manager.discardSession(picked.chatId);
    vscode.window.showInformationMessage('Chat discarded.');
  });

  // ── Register all providers and commands ──
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EXTENSION_VIEW_ID, sidebarProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider(EXTENSION_PANEL_VIEW_ID, panelProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerCustomEditorProvider(EDITOR_DATA_MODEL, new DataModelEditorProvider(context)),
    vscode.window.registerCustomEditorProvider(EDITOR_STTM, new SttmEditorProvider(context)),
    vscode.window.registerCustomEditorProvider(EDITOR_GRAPH, new GraphEditorProvider(context)),
    vscode.window.registerCustomEditorProvider(EDITOR_PROFILE, new ProfileEditorProvider(context)),
    vscode.window.registerCustomEditorProvider(EDITOR_DOC, new DocEditorProvider(context)),
    openSidebar, generatePlan, executePlan, generatePipelineSpec, resetSession,
    testLanguageModel, listLanguageModelInfo, listLanguageModels,
    testCopilot, listCopilotInfo, debugListExtensions, copilotHandoff,
    testConnection, testTargetConnection, sourceAssessment, reVerifySourceSchema, disconnectDataPlatform, disconnectTargetDataPlatform, browseSourceDatabase, browseTargetDatabase, ingestFileAsSourceContext, createMapping, buildSemanticLayer, compactContextLedger, whatTheAgentSaw, explainArtifact, openEstate, syncMetadata, reindex,
    importToolSkill, runToolSkill,
    newChat, chatHistory, discardChat,
    connectToDataPlatform, testServiceAccountCredential
  );
}

export function deactivate(): void {
  disposableRegistry.disposeAll();
}