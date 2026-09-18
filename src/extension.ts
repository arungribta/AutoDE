import * as vscode from 'vscode';
import { EXTENSION_ID, EXTENSION_VIEW_ID, EXTENSION_PANEL_VIEW_ID } from './core/extensionIdentity';
import { DataAgentHubHub } from './core/agentHub';
import { ConfigurationManager } from './core/configManager';
import { DataAgentHubWebviewProvider } from './core/webviewProvider';
import { DataAgentHubPanelProvider } from './core/panelProvider';
import { ConnectionManager } from './dqm/ConnectionManager';
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

  const testConnection = vscode.commands.registerCommand(`${EXTENSION_ID}.testConnection`, async () => {
    try {
      const settings = configManager.getSettings();
      const platform = settings.defaultProvider ?? 'snowflake';
      const credentials = ConnectionManager.getCredentialsFromSettings(platform, settings as unknown as Record<string, unknown>);
      if (platform === 'snowflake') {
        const password = await configManager.getSnowflakePassword(); if (password) credentials['password'] = password;
        const passphrase = await configManager.getSnowflakePrivateKeyPassphrase(); if (passphrase) credentials['passphrase'] = passphrase;
      }
      const missing: string[] = [];
      if (platform === 'snowflake') { if (!credentials['account']) missing.push('Account'); if (!credentials['username']) missing.push('Username'); if (!credentials['warehouse']) missing.push('Warehouse'); if (!credentials['database']) missing.push('Database'); }
      else if (platform === 'databricks') { if (!credentials['workspaceUrl']) missing.push('Workspace URL'); if (!credentials['catalog']) missing.push('Catalog'); }
      if (missing.length > 0) { vscode.window.showErrorMessage(`Missing credentials for ${platform}: ${missing.join(', ')}`); return; }
      if (connectionManager) { connectionManager.dispose(); }
      connectionManager = new ConnectionManager((msg: string) => { console.log(`[AutoDE Connection] ${msg}`); });
      const info = await connectionManager.connect(platform, credentials);
      vscode.window.showInformationMessage(`Connected to ${platform}: ${info.databaseName}.${info.schemaName} (v${info.version})`);
    } catch (err) { vscode.window.showErrorMessage(`Connection failed: ${err instanceof Error ? err.message : String(err)}`); }
  });

  const sourceAssessment = vscode.commands.registerCommand(`${EXTENSION_ID}.sourceAssessment`, async () => {
    try {
      if (!connectionManager || !connectionManager.isConnected()) { await vscode.commands.executeCommand(`${EXTENSION_ID}.testConnection`); if (!connectionManager || !connectionManager.isConnected()) { vscode.window.showErrorMessage('Not connected to a data platform.'); return; } }
      vscode.window.showInformationMessage('Running source assessment...');
      const snapshot = await connectionManager.extractMetadata({ includeProfiling: true });
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (wsRoot) { await connectionManager.persistSchemaContext(snapshot, wsRoot); }
      vscode.window.showInformationMessage(`Source assessment complete: ${snapshot.tables.length} tables, ${snapshot.views.length} views.`);
    } catch (err) { vscode.window.showErrorMessage(`Source assessment failed: ${err instanceof Error ? err.message : String(err)}`); }
  });

  const syncMetadata = vscode.commands.registerCommand(`${EXTENSION_ID}.syncMetadata`, async () => {
    try {
      if (!connectionManager || !connectionManager.isConnected()) { vscode.window.showErrorMessage('Not connected. Connect first via Settings → Connections.'); return; }
      vscode.window.showInformationMessage('Syncing metadata...');
      const snapshot = await connectionManager.extractMetadata({ includeProfiling: false });
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (wsRoot) { await connectionManager.persistSchemaContext(snapshot, wsRoot); }
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
      const { loadToolSkill } = require('./core/toolSkills') as typeof import('./core/toolSkills');
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
    const { loadToolSkillsFromDirectory } = require('./core/toolSkills') as typeof import('./core/toolSkills');
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
    testConnection, sourceAssessment, syncMetadata, reindex,
    importToolSkill, runToolSkill,
    newChat, chatHistory, discardChat
  );
}

export function deactivate(): void {
  disposableRegistry.disposeAll();
}