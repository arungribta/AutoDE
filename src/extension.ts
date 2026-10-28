import { emptyEstate, resolveIdentity, serializeEstate } from './engine/context/estate';
import * as vscode from 'vscode';
import { EXTENSION_ID, EXTENSION_VIEW_ID } from './core/extensionIdentity';
import { DataAgentHubHub } from './core/agentHub';
import { ConfigurationManager } from './core/configManager';
import { DataAgentHubWebviewProvider } from './core/webviewProvider';
import { ConnectionManager } from './engine/platform/ConnectionManager';
import { loadConnectionsConfig, sampleDataConsentFromWorkspace } from './engine/platform/connectionsConfig';
import { checkPrerequisitesCommand, installDriverCommand, verifyDriverCommand, PrerequisiteHost } from './core/platformPrerequisites';
import { configureMcpForClaudeCode, hintStaleMcpJson, refreshStableServer, registerMcpProvider, vscodeSecretEnv } from './core/mcpConfig';
import { EngineClient } from './core/engineClient';
import { registerWorkflowView } from './core/workflowView';
import { registerKnowledgeExplorer } from './core/knowledgeExplorer';
import { registerSkillsView } from './core/skillsView';
import { PortSkillPanel } from './core/portSkillView';
import * as port from './engine/skills/port';
import type { Classification } from './engine/governance/governance';
import { registerRunbookView, RunbookPanel } from './core/runbookView';
import { getCredentialResolver } from './engine/platform/credentials';
import { VSCODE_SECRET_RESOLVER_ID } from './engine/platform/credentials/types';
import { PlatformOnboarding } from './core/platformOnboarding';
import { secretStorageKey } from './core/credentials/VsCodeSecretStorageResolver';
import { SECRET_KEYS } from './core/extensionIdentity';
import { DataModelEditorProvider } from './editors/DataModelEditorProvider';
import { SttmEditorProvider } from './editors/SttmEditorProvider';
import { GraphEditorProvider } from './editors/GraphEditorProvider';
import { ProfileEditorProvider } from './editors/ProfileEditorProvider';
import { DocEditorProvider } from './editors/DocEditorProvider';
import { EDITOR_DATA_MODEL, EDITOR_STTM, EDITOR_GRAPH, EDITOR_PROFILE, EDITOR_DOC, EDITOR_SEMANTIC } from './core/extensionIdentity';
import { SemanticModelEditorProvider } from './editors/SemanticModelEditorProvider';
import * as semanticStore from './engine/semantic/store';
import { newCompositeText } from './engine/semantic/editorState';
import { draftSemanticModel } from './engine/semantic/draft';
import { problemTableIds } from './engine/context/capture';
import { layoutPath } from './engine/workspaceLayout';
import { createDisposableRegistry } from './core/disposables';
import { createVscodeFileIo } from './context/vscodeFileIo';
import { registerDefaultCredentialResolvers, resolveCredential } from './core/credentials';
import { DataPlatformProvider, DataAgentHubSettings } from './engine/types';
import { parseFile, detectFileFormat } from './engine/context/fileIngestion';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as lifecycle from './engine/skills/lifecycle';
import { LAYOUT, layoutRel } from './engine/workspaceLayout';
import { describeMigration, migrateWorkspace } from './engine/workspaceMigration';
import { resolveAllowedToolNames } from './engine/skills/toolAllowList';

/**
 * Resources that outlive a single command (e.g. `connectionManager` below,
 * reassigned across "Test Connection" calls) live in `activate()`'s closure,
 * which `deactivate()` cannot see. Register anything here that needs to be
 * torn down on extension shutdown instead of relying on GC.
 */
const disposableRegistry = createDisposableRegistry();

export function activate(context: vscode.ExtensionContext): void {
  const configManager = new ConfigurationManager(context);
  const hub = new DataAgentHubHub(configManager);
  // Tool-skill imports, reviews and lifecycle transitions (Phase S2); the durable record is each skill's sidecar.
  const skillLog = vscode.window.createOutputChannel('AutoDE: Tool Skills');
  const skillActor = (): string => { try { return os.userInfo().username || 'user'; } catch { return 'user'; } };
  registerDefaultCredentialResolvers(context.secrets);

  // Which VS Code Language Model provider the user has selected (Copilot or
  // Claude). Any other provider is API-key based and not exercised by these
  // detection/test commands; we fall back to 'copilot' for detection.
  const activeLmProvider = (): 'copilot' | 'claude' =>
    configManager.getSettings().activeLlmProvider === 'claude' ? 'claude' : 'copilot';

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? context.extensionUri;

  // v0.36.0: a workspace from an earlier version keeps its state in .ai-context/.
  // Move it to the .autode/ layout (and its artifacts to the output folder) before
  // any manager reads a path. Only moves, never overwrites; reported to the user.
  if (vscode.workspace.workspaceFolders?.[0] && workspaceRoot.scheme === 'file') {
    try {
      const report = migrateWorkspace(workspaceRoot.fsPath, { artifactDirectory: configManager.getSettings().artifactDirectory });
      if (report.needed) {
        const summary = describeMigration(report);
        console.log(`[AutoDE] Workspace layout migrated: ${summary}`);
        void vscode.window.showInformationMessage(`AutoDE now keeps its working state in .autode/ and generated deliverables in a visible output folder. ${summary} Commit the move so teammates get it too.`);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`AutoDE could not move .ai-context/ to .autode/: ${err instanceof Error ? err.message : String(err)}. Nothing was deleted; move it by hand or retry after closing programs that hold its files.`);
    }
  }

  const sidebarProvider = new DataAgentHubWebviewProvider(context, configManager, hub);

  // Phase DRV2: named connections, onboarded from the settings cards.
  const managerOptions = () => ({
    cliConsent: () => configManager.getSettings().dataPlatformCliConsent === true,
    // Phase 4: row values reach prompts only if .autode/config/connections.yaml allows it for this connection.
    sampleDataConsent: sampleDataConsentFromWorkspace(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
    driversRoot: () => configManager.getSettings().driversDirectory
  });
  const cardSecrets: Record<string, string> = {
    'source.snowflake.password': SECRET_KEYS.snowflakePassword, 'source.snowflake.privateKeyPassphrase': SECRET_KEYS.snowflakePrivateKeyPassphrase,
    'target.snowflake.password': SECRET_KEYS.targetSnowflakePassword, 'target.snowflake.privateKeyPassphrase': SECRET_KEYS.targetSnowflakePrivateKeyPassphrase,
    'source.databricks.token': SECRET_KEYS.databricksToken, 'target.databricks.token': SECRET_KEYS.targetDatabricksToken,
    'source.oracle.password': SECRET_KEYS.oraclePassword, 'source.oracle.walletPassword': SECRET_KEYS.oracleWalletPassword
  };
  const onboarding = new PlatformOnboarding({
    resourcesRoot: () => context.extensionPath,
    workspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    settings: () => configManager.getSettings(),
    secrets: context.secrets,
    secretKey: (platform, ref, field) => secretStorageKey(platform, 'interactive-user', ref, field),
    cardSecretKey: (role, platform, field) => cardSecrets[`${role}.${platform}.${field}`],
    createManager: (log) => new ConnectionManager(log, managerOptions()),
    log: (line) => sidebarProvider.logToChat(line)
  });
  sidebarProvider.setPlatformOnboarding(onboarding);

  let connectionManager: ConnectionManager | undefined;
  disposableRegistry.register({ dispose: () => connectionManager?.dispose() });
  // Target's own, independent live connection (v0.19.0) — both can be connected
  // simultaneously per the confirmed decision; a completely separate
  // ConnectionManager instance rather than reusing the source one.
  let targetConnectionManager: ConnectionManager | undefined;
  disposableRegistry.register({ dispose: () => targetConnectionManager?.dispose() });

  // ── Commands ──

  const openSidebar = vscode.commands.registerCommand(`${EXTENSION_ID}.openSidebar`, async () => {
    await vscode.commands.executeCommand(`workbench.view.extension.${EXTENSION_ID}`);
  });

  // Phase 2B-i — an opt-in flow:
  // synthesizes a strictly-validated, machine-compilable Pipeline Spec from the
  // approved specification and its context. Delegates to the sidebar provider,
  // which owns the spec/context managers this needs (see webviewProvider.ts).

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

  // Phase DRV1: moderated driver installation — nothing runs until the user clicks.
  const prerequisiteHost: PrerequisiteHost = {
    driversDirectory: () => configManager.getSettings().driversDirectory,
    snowflakeCliPath: () => configManager.getSettings().snowflakeCliPath,
    databricksCliPath: () => configManager.getSettings().databricksCliPath,
    log: (line) => sidebarProvider.logToChat(line),
    resourcesRoot: () => context.extensionPath,
    workspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  };
  const checkPlatformPrerequisites = vscode.commands.registerCommand(`${EXTENSION_ID}.checkPlatformPrerequisites`, () => checkPrerequisitesCommand(vscode, prerequisiteHost));
  const installOracleDriver = vscode.commands.registerCommand(`${EXTENSION_ID}.installOracleDriver`, () => installDriverCommand(vscode, prerequisiteHost, 'oracle'));
  const verifyOracleDriver = vscode.commands.registerCommand(`${EXTENSION_ID}.verifyOracleDriver`, () => verifyDriverCommand(vscode, prerequisiteHost, 'oracle'));
  const setOraclePassword = vscode.commands.registerCommand(`${EXTENSION_ID}.setOraclePassword`, async () => {
    const value = await vscode.window.showInputBox({ title: 'Oracle password', prompt: `Password for ${configManager.getSettings().defaultOracleUsername || 'the Oracle user'} — stored in VS Code's secret storage, never in settings`, password: true, ignoreFocusOut: true });
    if (value === undefined) return;
    await configManager.setOraclePassword(value);
    vscode.window.showInformationMessage('Oracle password saved in secret storage.');
  });

  // Phase PA2: the project's .mcp.json entry for the AutoDE server (installed `autode mcp` preferred).
  const extensionVersion = String((context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '0.0.0');
  const firstFolder = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  // Always set by VS Code; absent only in hand-built test contexts.
  const storagePath: string | undefined = context.globalStorageUri?.fsPath;
  const configureMcpCommandId = `${EXTENSION_ID}.configureMcpClaudeCode`;
  const configureMcp = vscode.commands.registerCommand(configureMcpCommandId, () => configureMcpForClaudeCode(vscode, { workspaceRoot: firstFolder(), extensionPath: context.extensionPath, storagePath, version: extensionVersion, log: (line) => sidebarProvider.logToChat(line) }));
  hintStaleMcpJson(vscode, { workspaceRoot: firstFolder(), extensionPath: context.extensionPath, commandId: configureMcpCommandId });
  // Phase 5: keep an existing stable server copy current (it is created only by the command above); off the activation path.
  setTimeout(() => {
    try { if (storagePath && refreshStableServer(context.extensionPath, storagePath, extensionVersion)) sidebarProvider.logToChat(`AutoDE's MCP server copy in global storage updated to ${extensionVersion}.`); } catch (err) { console.warn('AutoDE: could not refresh the stable MCP server copy', err); }
  }, 3000);
  // Phase 5: VS Code agent mode lists AutoDE's tools with no configuration; VS Code starts the server itself.
  const vscodeSecrets = (entry: { platform: DataPlatformProvider; credentials: { ref: string } }) =>
    getCredentialResolver(VSCODE_SECRET_RESOLVER_ID)?.resolve({ platform: entry.platform, principalType: 'interactive-user', ref: entry.credentials.ref, resolverId: VSCODE_SECRET_RESOLVER_ID }) ?? Promise.resolve(undefined);
  const mcpProvider = registerMcpProvider(vscode, { extensionPath: context.extensionPath, version: extensionVersion, workspaceRoot: firstFolder, secretEnv: () => vscodeSecretEnv(firstFolder(), vscodeSecrets), log: (line) => console.log(line) });
  if (mcpProvider) context.subscriptions.push(mcpProvider);
  // v0.44.1: the Workflow view — tree, editor tab, status bar — over the engine's runtime and history.
  context.subscriptions.push(...registerSkillsView(context, () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath));
  // v0.45.6: the Runbook tab: approved platform changes, run step by step by AutoDE's runner.
  context.subscriptions.push(...registerRunbookView(context, {
    scope: () => sidebarProvider.currentWorkflowScope(),
    user: skillActor,
    resolve: async (id, decision, note) => { await sidebarProvider.resolveFromView(id, decision, note); RunbookPanel.refreshAll(); },
    allowCli: () => configManager.getSettings().dataPlatformCliConsent === true,
    driversRoot: () => configManager.getSettings().driversDirectory,
    log: (line) => sidebarProvider.logToChat(line),
    onChange: () => void vscode.commands.executeCommand('autoDataEngineeringHub.refreshWorkflow')
  }));
  context.subscriptions.push(...registerWorkflowView(context, {
    scope: () => sidebarProvider.currentWorkflowScope(),
    resolve: (id, decision, note) => sidebarProvider.resolveFromView(id, decision, note),
    workflowAction: (action, stage, arg) => sidebarProvider.workflowActionFromView(action, stage, arg),
    user: skillActor,
    waiting: () => sidebarProvider.waitingForYou()
  }));
  // C5b: the Knowledge Explorer — search, asset pages, graph, facts, estate — over the engine's workspace.
  context.subscriptions.push(...registerKnowledgeExplorer(context, {
    workspaceRoot: firstFolder,
    openInbox: () => { void vscode.commands.executeCommand(`${EXTENSION_ID}.openSidebar`).then(() => sidebarProvider.openInbox()); }
  }));
  // Phase 5: agents reach the engine's MCP tools through an in-process client, started on first use.
  hub.setEngineFactory((clientName?: string) => {
    const root = firstFolder();
    return root ? new EngineClient({ workspaceRoot: root, resourcesRoot: context.extensionPath, version: extensionVersion, log: (line) => console.log(`[engine] ${line}`), driversRoot: () => configManager.getSettings().driversDirectory, allowCli: () => configManager.getSettings().dataPlatformCliConsent === true, clientName }) : undefined;
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
    let named: Awaited<ReturnType<PlatformOnboarding['credentialsFor']>> | undefined;
    try {
      const settings = configManager.getSettings();
      // Phase DRV2: a named connection, when one is in use for this role, resolves
      // through the credential resolvers exactly as the MCP server does.
      const activeId = (role === 'target' ? settings.activeTargetConnection : settings.activeSourceConnection) ?? '';
      if (activeId) {
        named = await onboarding.credentialsFor(activeId);
        if (named.entry.role !== role) throw new Error(`Connection "${activeId}" is a ${named.entry.role} connection.`);
      }
      const platform = named ? named.entry.platform : (role === 'target' ? settings.defaultTargetProvider : settings.defaultProvider) ?? 'snowflake';
      const credentials = named ? named.credentials : ConnectionManager.getCredentialsFromSettings(platform, settings as unknown as Record<string, unknown>, role);
      if (!named) {
        if (platform === 'snowflake') {
          const password = role === 'target' ? await configManager.getTargetSnowflakePassword() : await configManager.getSnowflakePassword();
          if (password) credentials['password'] = password;
          const passphrase = role === 'target' ? await configManager.getTargetSnowflakePrivateKeyPassphrase() : await configManager.getSnowflakePrivateKeyPassphrase();
          if (passphrase) credentials['privateKeyPassphrase'] = passphrase;
        } else if (platform === 'databricks') {
          const token = role === 'target' ? await configManager.getTargetDatabricksToken() : await configManager.getDatabricksToken();
          if (token) credentials['token'] = token;
        } else if (platform === 'oracle' && role === 'source') {
          const password = await configManager.getOraclePassword();
          if (password) credentials['password'] = password;
          const walletPassword = await configManager.getOracleWalletPassword();
          if (walletPassword) credentials['walletPassword'] = walletPassword;
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
        else if (platform === 'oracle') {
          if (role === 'target') { const msg = 'Oracle is supported as a source only.'; vscode.window.showErrorMessage(msg); sidebarProvider.logToChat(msg); return; }
          if (!credentials['connectString']) missing.push('Connect string (defaultOracleConnectString)'); if (!credentials['username']) missing.push('Username (defaultOracleUsername)'); if (!credentials['password']) missing.push('Password (AutoDE: Set Oracle Password)');
        }
        if (missing.length > 0) {
          const msg = `Missing ${role} credentials for ${platform}: ${missing.join(', ')}`;
          vscode.window.showErrorMessage(msg);
          sidebarProvider.logToChat(msg);
          return;
        }
      }
      const newManager = new ConnectionManager(
        (msg: string) => { console.log(`[AutoDE ${role} Connection] ${msg}`); sidebarProvider.logToChat(msg); },
        managerOptions()
      );
      // Phase K1: extractions are tagged with the estate system this connection feeds.
      newManager.setEstateResolver((id) => sidebarProvider.resolveConnectionIdentity(id, role));
      if (role === 'target') { targetConnectionManager?.dispose(); targetConnectionManager = newManager; } else { connectionManager?.dispose(); connectionManager = newManager; }
      const info = await newManager.connect(platform, credentials);
      if (named) onboarding.markChecked(named.entry, true, `${info.databaseName}.${info.schemaName} (${info.version})`);
      const successMsg = `Connected to ${role} ${named ? named.entry.id : platform}: ${info.databaseName}.${info.schemaName} (v${info.version})`;
      vscode.window.showInformationMessage(successMsg);
      sidebarProvider.logToChat(successMsg);
      // This only proves connectivity — it does NOT extract schema (that's
      // "Source Assessment", a source-only, separate step), so the status
      // pill/chat context should say "connected" without implying tables are
      // already known.
      sidebarProvider.notifyConnectionStatus(role, { connected: true, platform, detail: `${info.databaseName}.${info.schemaName}` });
      // Phase K2: the source connection answers catalog query-through and refresh on use.
      if (role === 'source') sidebarProvider.setCatalogFetcher(newManager.catalogFetcher());
      // Phase C4a: probes (read-only, aggregates only) run on the source connection.
      if (role === 'source') sidebarProvider.setLiveProbes(newManager.probeExecutor());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (named) onboarding.markChecked(named.entry, false, message);
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

  // Source assessment from the platform card (code audit 2026-10: one way in). It brings a named
  // connection's schemas into the estate through the same engine tools agents and the CLI use
  // (autode_list_databases, autode_list_schemas, autode_ingest_metadata), instead of the single
  // connection in the settings. Returns its outcome so the panel can react to what happened.
  const sourceAssessment = vscode.commands.registerCommand(
    `${EXTENSION_ID}.sourceAssessment`,
    async (): Promise<{ success: boolean; tableCount?: number; viewCount?: number; error?: string }> => {
      const fail = (msg: string) => { vscode.window.showErrorMessage(msg); sidebarProvider.logToChat(msg); return { success: false, error: msg }; };
      const root = firstFolder();
      if (!root) return fail('Open a workspace folder first.');
      const connections = loadConnectionsConfig(root).connections;
      const sources = connections.filter((c) => c.role === 'source');
      const candidates = sources.length ? sources : connections;
      if (!candidates.length) return fail('No named connection yet: save one from a platform card (Save as named connection) or run `autode connections add`.');
      const picked = candidates.length === 1 ? candidates[0] : (await vscode.window.showQuickPick(
        candidates.map((c) => ({ label: c.id, description: `${c.platform} · ${c.role}`, entry: c })),
        { title: 'Source assessment: which connection?' }))?.entry;
      if (!picked) return { success: false, error: 'Cancelled.' };
      const engine = hub.createEngine('autode-panel');
      if (!engine?.call) return fail('The AutoDE engine is not available.');
      try {
        const dbs = ((await engine.call('autode_list_databases', { connectionId: picked.id })).databases ?? []) as string[];
        const database = dbs.length === 1 ? dbs[0] : await vscode.window.showQuickPick(dbs, { title: `Source assessment: which ${picked.platform === 'databricks' ? 'catalog' : 'database'} of ${picked.id}?` });
        if (!database) return { success: false, error: 'Cancelled.' };
        const all = ((await engine.call('autode_list_schemas', { connectionId: picked.id, database })).schemas ?? []) as string[];
        const schemas = await vscode.window.showQuickPick(all, { title: `Source assessment: which schemas of ${database}?`, canPickMany: true });
        if (!schemas?.length) return { success: false, error: 'Cancelled.' };
        sidebarProvider.logToChat(`Running source assessment on ${picked.id} (${schemas.length} schema(s))…`);
        const out = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AutoDE: source assessment' },
          () => engine.call!('autode_ingest_metadata', { connectionId: picked.id, schemas: schemas.map((x) => `${database}.${x}`), profile: true }));
        const r = (out.result ?? {}) as { tables?: number; system?: string; source?: string };
        const doneMsg = `Source assessment complete: ${r.tables ?? 0} tables and views from ${r.source ?? picked.id}${r.system ? `, in the estate as system ${r.system}` : ''}.`;
        vscode.window.showInformationMessage(doneMsg);
        sidebarProvider.logToChat(doneMsg);
        sidebarProvider.notifyConnectionStatus('source', { connected: true, platform: picked.platform, detail: `${r.tables ?? 0} tables and views in the estate` });
        await sidebarProvider.reloadContextLayer();
        return { success: true, tableCount: r.tables ?? 0 };
      } catch (err) {
        return fail(`Source assessment failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await engine.dispose();
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
      { title: `Which system does ${fileName} describe?`, placeHolder: `Pick a system (edit ${layoutRel('estate')} to add systems, environments or roles)` }
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

  // Phase K1 (v0.31.0): the estate — systems, environments, roles and which
  // connections/files feed them — lives in .autode/knowledge/estate.yaml.
  const openEstate = vscode.commands.registerCommand(`${EXTENSION_ID}.openEstate`, async () => {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!wsRoot) { vscode.window.showErrorMessage('Open a workspace folder first.'); return; }
    const uri = vscode.Uri.joinPath(wsRoot, ...LAYOUT.estate);
    try { await vscode.workspace.fs.stat(uri); } catch {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(serializeEstate(sidebarProvider.getEstate() ?? emptyEstate()), 'utf8'));
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  });

  // Phase C4a (docs/context-layer-requirements.md §11): the business-problem pack.
  const addPackDocument = vscode.commands.registerCommand(`${EXTENSION_ID}.addPackDocument`, () => sidebarProvider.runAddPackDocument());
  const applyPack = vscode.commands.registerCommand(`${EXTENSION_ID}.applyPack`, () => sidebarProvider.runApplyPack());
  const runConformance = vscode.commands.registerCommand(`${EXTENSION_ID}.runConformance`, () => sidebarProvider.runConformanceCheck());
  const verifyClaims = vscode.commands.registerCommand(`${EXTENSION_ID}.verifyClaims`, () => sidebarProvider.runVerifyClaims());
  const proposeVocabulary = vscode.commands.registerCommand(`${EXTENSION_ID}.proposeVocabulary`, () => sidebarProvider.runProposeVocabulary());

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

  // Port a Skill (PA4): the wizard imports a skill from a Git repository, a folder or a dbt package, with
  // its capability report; it replaced the plain folder import (Phase D), keeping its command id.
  const importToolSkill = vscode.commands.registerCommand(`${EXTENSION_ID}.importToolSkill`, () => {
    PortSkillPanel.show(context, {
      user: skillActor,
      workspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      managementEnabled: () => !!configManager.getSettings().toolSkillManagementEnabled,
      complete: async (system, user) => JSON.stringify(await hub.completeJson(system, user, 'Propose how a ported skill fits AutoDE.')),
      review: async (id) => { await vscode.commands.executeCommand(`${EXTENSION_ID}.reviewToolSkill`, id); },
      log: (line) => skillLog.appendLine(`${new Date().toISOString()} ${line}`),
      onChange: () => { void vscode.commands.executeCommand(`${EXTENSION_ID}.refreshSkills`); }
    });
  });

  // C4c: what a complete picture of the problem needs, and facts from the data before any model.
  const showMarkdown = async (content: string) => vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'markdown', content }));
  const captureCoverage = vscode.commands.registerCommand(`${EXTENSION_ID}.captureCoverage`, async () => {
    const md = sidebarProvider.captureCoverageMarkdown();
    if (!md) { vscode.window.showInformationMessage('Open a business problem in the AutoDE panel first.'); return; }
    await showMarkdown(md);
  });
  const findCandidates = vscode.commands.registerCommand(`${EXTENSION_ID}.findCandidates`, async () => {
    const md = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AutoDE: probing the data for keys, joins and personal data' }, () => sidebarProvider.findCandidatesFromData());
    if (!md) { vscode.window.showInformationMessage('Open a business problem in the AutoDE panel first.'); return; }
    await showMarkdown(md);
  });

  // GOV: the person classifies personal data (a confirmed fact); masking follows from it in the build.
  const classifyPersonalData = vscode.commands.registerCommand(`${EXTENSION_ID}.classifyPersonalData`, async () => {
    const candidates = sidebarProvider.governanceCandidates();
    if (!candidates.length) { vscode.window.showInformationMessage('No column in the working set looks like personal data by name. Bring the sources into the estate first, or classify a column with `autode governance classify`.'); return; }
    const picked = await vscode.window.showQuickPick(
      candidates.map((c) => ({ label: `${c.table}.${c.column}`, description: c.fact ? `${c.fact.classification}${c.fact.strategy ? ` (${c.fact.strategy})` : ''} · ${c.fact.status}` : `suggested ${c.suggested}${c.strategy ? ` (${c.strategy})` : ''}`, detail: c.why, c })),
      { title: 'Classify personal data', placeHolder: 'Choose a column' }
    );
    if (!picked) return;
    const cls = await vscode.window.showQuickPick([
      { label: 'sensitive-pii', detail: 'Must be masked: the build is refused until it is.' },
      { label: 'pii', detail: 'Personal data: mask it, or rely on the platform\'s masking policy (a warning otherwise).' },
      { label: 'confidential', detail: 'Business-confidential, not personal: recorded, not masked.' },
      { label: 'none', detail: 'Not personal data after all.' }
    ].map((x) => ({ ...x, picked: x.label === picked.c.suggested })), { title: `${picked.label}: classification` });
    if (!cls) return;
    let strategy: 'hash' | 'redact' | undefined;
    if (cls.label === 'pii' || cls.label === 'sensitive-pii') {
      const s = await vscode.window.showQuickPick([
        { label: 'hash', detail: 'SHA-256: equal values stay equal, so keys still join. Salt low-entropy values (phone numbers, dates).' },
        { label: 'redact', detail: 'A constant instead of the value (passwords, card security codes).' }
      ], { title: `${picked.label}: how to mask it`, placeHolder: picked.c.strategy });
      if (!s) return;
      strategy = s.label as 'hash' | 'redact';
    }
    const ok = await vscode.window.showWarningMessage(`Record ${picked.label} as ${cls.label}${strategy ? `, masked by ${strategy}` : ''}?`, { modal: true, detail: 'A confirmed fact. Primitive candidates mask it after staging, and a Pipeline Spec that reads it unmasked can\'t be approved when it is sensitive-pii.' }, 'Record');
    if (ok !== 'Record') return;
    try {
      const statement = await sidebarProvider.classifyColumn({ table: picked.c.table, column: picked.c.column, classification: cls.label as Classification, strategy, by: skillActor() });
      sidebarProvider.logToChat(`Recorded: ${statement}`);
      vscode.window.showInformationMessage(`Recorded: ${statement}`);
    } catch (err) { vscode.window.showErrorMessage(`Could not record it: ${err instanceof Error ? err.message : String(err)}`); }
  });

  // Update Skill (PA4): re-fetch an imported skill from its source, show what changed, apply after the person
  // confirms; the new content is unreviewed (S2 binds trust to content).
  const updateToolSkill = vscode.commands.registerCommand(`${EXTENSION_ID}.updateToolSkill`, async (skillId?: unknown) => {
    const state = await pickToolSkill('Update a skill from its source', (s) => s.sidecar.status !== 'retired', typeof skillId === 'string' ? skillId : (skillId as { entry?: { name?: string } } | undefined)?.entry?.name);
    if (!state) return;
    const dir = state.skill.sourceDir;
    let up: ReturnType<typeof port.stageUpdate>;
    try { up = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Fetching ${state.skill.id} from its source…` }, async () => port.stageUpdate(dir)); }
    catch (err) { vscode.window.showErrorMessage(`Update failed: ${err instanceof Error ? err.message : String(err)}`); return; }
    try {
      const diff = port.diffSkill(dir, up.freshDir);
      const commit = up.staged.provenance.resolvedCommit;
      if (!diff.length) { vscode.window.showInformationMessage(`${state.skill.id} is up to date with its source${commit ? ` (commit ${commit.slice(0, 12)})` : ''}.`); return; }
      const fresh = port.analyzeSkill(up.freshDir, state.sidecar.provenance.subpath ?? '', port.analysisContext(context.extensionPath, vscode.workspace.workspaceFolders![0].uri.fsPath, up.staged.dir));
      const doc = [`# Update ${state.skill.id}${commit ? ` to commit ${commit.slice(0, 12)}` : ''}`, '', ...diff.map((d) => `## ${d.change}: ${d.path}\n\n${d.diff ? '```diff\n' + d.diff + '\n```' : ''}`), '', port.capabilityReport(fresh, up.staged.provenance)].join('\n');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'markdown', content: doc }), { preview: true });
      if (fresh.problems.length) { vscode.window.showErrorMessage(`The new version can't be imported: ${fresh.problems.join(' ')}`); return; }
      const ok = await vscode.window.showWarningMessage(`Apply the update to ${state.skill.id}?`, { modal: true, detail: `${diff.length} file(s) change. The new content is unreviewed: it stops running, and leaves assignments and context packs, until you review it again.` }, 'Update');
      if (ok !== 'Update') return;
      port.applyUpdate(dir, up.staged, up.freshDir, fresh, skillActor());
      skillLog.appendLine(`${new Date().toISOString()} ${state.skill.id}: updated from its source${commit ? ` (${commit.slice(0, 12)})` : ''}; unreviewed.`);
      void vscode.commands.executeCommand(`${EXTENSION_ID}.refreshSkills`);
      const next = await vscode.window.showInformationMessage(`${state.skill.id} updated; it is unreviewed.`, 'Review Now');
      if (next === 'Review Now') await vscode.commands.executeCommand(`${EXTENSION_ID}.reviewToolSkill`, state.skill.id);
    } finally { up.staged.cleanup(); }
  });

  // Lists imported tool skills and runs the chosen one with real tool access
  // (file write / command execution, gated by consent + approval dialogs).
  const runToolSkill = vscode.commands.registerCommand(`${EXTENSION_ID}.runToolSkill`, async () => {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!wsRoot) { vscode.window.showErrorMessage('Open a workspace folder first.'); return; }
    const toolSkillsDir = vscode.Uri.joinPath(wsRoot, ...LAYOUT.toolSkills).fsPath;
    const all = lifecycle.loadToolSkillStates(toolSkillsDir, skillActor());
    if (all.length === 0) { vscode.window.showInformationMessage('No tool skills imported yet. Run "AutoDE: Import Tool Skill" first.'); return; }
    // The run gate (Phase S2): only published skills reviewed or trusted for their current content.
    const runnable = all.filter((s) => lifecycle.isSkillRunnable(s));
    const hidden = all.length - runnable.length;
    if (runnable.length === 0) { vscode.window.showInformationMessage(`None of the ${all.length} imported skill(s) can run yet. Run "AutoDE: Review Tool Skill" first.`); return; }
    const picked = await vscode.window.showQuickPick(
      runnable.map((s) => ({ label: s.skill.name, description: `${s.skill.id} · ${s.effectiveTier}`, detail: s.skill.description, id: s.skill.id })),
      { title: `Run a tool-executing skill${hidden ? ` (${hidden} unreviewed, draft, deprecated or retired — hidden)` : ''}`, placeHolder: 'Choose a skill' }
    );
    if (!picked) { return; }
    const instruction = await vscode.window.showInputBox({ title: `Instruction for "${picked.label}"`, placeHolder: 'What should this run do?' });
    if (!instruction || !instruction.trim()) { return; }
    vscode.window.showInformationMessage(`Running skill "${picked.label}"…`);
    const result = await hub.runToolSkill(picked.id, instruction.trim());
    if (result.success) { vscode.window.showInformationMessage(`Skill "${picked.label}" completed: ${result.message.slice(0, 200)}`); }
    else { vscode.window.showErrorMessage(`Skill "${picked.label}" failed: ${result.message}`); }
  });

  // ── Tool-skill review and lifecycle (Phase S2) ──

  const pickToolSkill = async (title: string, filter: (s: lifecycle.ToolSkillState) => boolean, preselected?: unknown) => {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!wsRoot) { vscode.window.showErrorMessage('Open a workspace folder first.'); return undefined; }
    const dir = vscode.Uri.joinPath(wsRoot, ...LAYOUT.toolSkills).fsPath;
    const states = lifecycle.loadToolSkillStates(dir, skillActor()).filter(filter);
    if (typeof preselected === 'string') { return states.find((s) => s.skill.id === preselected); }
    if (states.length === 0) { vscode.window.showInformationMessage('No matching tool skills.'); return undefined; }
    const picked = await vscode.window.showQuickPick(
      states.map((s) => ({ label: s.skill.name, description: `${s.skill.id} · ${s.sidecar.status} v${s.sidecar.version} · ${s.effectiveTier}${s.changedSinceReview ? ' (changed since review)' : ''}`, detail: s.skill.description, state: s })),
      { title }
    );
    return picked?.state;
  };

  const reviewToolSkill = vscode.commands.registerCommand(`${EXTENSION_ID}.reviewToolSkill`, async (skillId?: unknown) => {
    const state = await pickToolSkill('Review a tool skill', (s) => s.sidecar.status !== 'retired', skillId);
    if (!state) { return; }
    const doc = await vscode.workspace.openTextDocument({ content: lifecycle.buildSkillReviewDocument(state, resolveAllowedToolNames(state.skill.declaredTools)), language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: true });
    const choice = await vscode.window.showWarningMessage(
      `Review "${state.skill.name}" (now ${state.effectiveTier}). Read the opened page in full: the skill's instructions and resource files will act in this workspace.`,
      { modal: true, detail: 'Reviewed: read-only tools at most, not through Claude Code. Trusted: may write files and run commands (each approved), and may run through Claude Code. Unreviewed: does not run.' },
      'Reviewed (read-only)', 'Trusted (full access)', 'Unreviewed'
    );
    const tier = choice === 'Reviewed (read-only)' ? 'reviewed' : choice === 'Trusted (full access)' ? 'trusted' : choice === 'Unreviewed' ? 'unreviewed' : undefined;
    if (!tier) { return; }
    lifecycle.setTrustTier(state.skill.sourceDir, tier, skillActor());
    skillLog.appendLine(`${new Date().toISOString()} ${state.skill.id}: ${state.effectiveTier} → ${tier} (content ${state.checksum.slice(0, 12)}).`);
    vscode.window.showInformationMessage(`Skill "${state.skill.name}" is now ${tier}.${state.sidecar.status === 'draft' ? ' It is still a draft: publish it to run it.' : ''}`);
  });

  const lifecycleCommand = (action: 'publish' | 'deprecate' | 'retire') => async (skillId?: unknown) => {
    if (!configManager.getSettings().toolSkillManagementEnabled) {
      vscode.window.showErrorMessage('Tool-skill lifecycle management is off. Enable "autoDataEngineeringHub.toolSkillManagementEnabled".');
      return;
    }
    const from: Record<typeof action, string[]> = { publish: ['draft', 'published', 'deprecated'], deprecate: ['published'], retire: ['draft', 'published', 'deprecated'] };
    const state = await pickToolSkill(`${action[0].toUpperCase()}${action.slice(1)} a tool skill`, (s) => from[action].includes(s.sidecar.status), skillId);
    if (!state) { return; }
    if (action === 'retire') {
      const ok = await vscode.window.showWarningMessage(`Retire "${state.skill.name}"? It will never run again, including plan steps pinned to its versions.`, { modal: true }, 'Retire');
      if (ok !== 'Retire') { return; }
    }
    try {
      const by = skillActor();
      const sidecar = action === 'publish' ? lifecycle.publishToolSkill(state.skill.sourceDir, by).sidecar
        : action === 'deprecate' ? lifecycle.deprecateToolSkill(state.skill.sourceDir, by)
          : lifecycle.retireToolSkill(state.skill.sourceDir, by);
      skillLog.appendLine(`${new Date().toISOString()} ${state.skill.id}: ${action} → ${sidecar.status} v${sidecar.version}.`);
      const tierNote = action === 'publish' && sidecar.trustTier === 'unreviewed' ? ' This content is unreviewed: review it before it can run.' : '';
      vscode.window.showInformationMessage(`Skill "${state.skill.name}" is now ${sidecar.status} (v${sidecar.version}).${tierNote}`);
    } catch (err) {
      vscode.window.showErrorMessage(`${action} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const publishToolSkill = vscode.commands.registerCommand(`${EXTENSION_ID}.publishToolSkill`, lifecycleCommand('publish'));
  const deprecateToolSkill = vscode.commands.registerCommand(`${EXTENSION_ID}.deprecateToolSkill`, lifecycleCommand('deprecate'));
  const retireToolSkill = vscode.commands.registerCommand(`${EXTENSION_ID}.retireToolSkill`, lifecycleCommand('retire'));

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

  // C5a: the semantic layer — a new shared model drafted from knowledge, a new composite, opened in the Semantic Model editor.
  const semanticEditorHost = { context: () => sidebarProvider.semanticEditorContext(), user: () => { try { return os.userInfo().username || 'user'; } catch { return 'user'; } }, changed: () => void vscode.commands.executeCommand('autoDataEngineeringHub.refreshWorkflow') };
  const newSemanticModel = vscode.commands.registerCommand(`${EXTENSION_ID}.newSemanticModel`, async () => {
    const ctx = sidebarProvider.semanticEditorContext();
    if (!ctx) { vscode.window.showInformationMessage('Open the AutoDE panel first.'); return; }
    const name = await vscode.window.showInputBox({ title: 'New shared semantic model', prompt: 'Its subject area, e.g. sales, customer, finance', validateInput: (v) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(v.trim()) ? undefined : 'Letters, digits, _ and -' });
    if (!name) return;
    const problem = sidebarProvider.getActiveProblemId();
    const ids = problem ? problemTableIds({ workspaceRoot: ctx.workspaceRoot, problemRoot: layoutPath(ctx.workspaceRoot, 'problems', problem), sources: ctx }) : [];
    if (!ids.length) { vscode.window.showWarningMessage('No table to draft from: the active problem\'s specification names no table AutoDE knows.'); return; }
    try {
      const d = draftSemanticModel({ graph: ctx.graph, assertions: ctx.assertions, tableIds: ids, name: name.trim() });
      const e = semanticStore.writeDraft(ctx.workspaceRoot, name.trim(), d.model, d.backing, d.notes, d.binding);
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(e.file), EDITOR_SEMANTIC);
      if (d.notes.length) vscode.window.showInformationMessage(`Drafted from knowledge. Left out: ${d.notes.join('; ')}`);
    } catch (err) { vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err)); }
  });
  const newSemanticComposite = vscode.commands.registerCommand(`${EXTENSION_ID}.newSemanticComposite`, async () => {
    const ctx = sidebarProvider.semanticEditorContext();
    const problem = sidebarProvider.getActiveProblemId();
    if (!ctx || !problem) { vscode.window.showInformationMessage('Open a business problem in the AutoDE panel first: a composite belongs to one.'); return; }
    const shared = semanticStore.listShared(ctx.workspaceRoot);
    if (!shared.length) { vscode.window.showInformationMessage('There is no shared semantic model to compose yet: AutoDE: New Shared Semantic Model.'); return; }
    const picked = await vscode.window.showQuickPick(shared.map((s) => ({ label: s.name, description: s.status })), { canPickMany: true, title: 'Which shared models does the use case use?' });
    if (!picked?.length) return;
    const name = await vscode.window.showInputBox({ title: 'New composite', prompt: 'A name for the use case, e.g. revenue_by_channel', validateInput: (v) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()) ? undefined : 'Letters, digits and _' });
    if (!name) return;
    const dir = semanticStore.semanticPaths(ctx.workspaceRoot).compositeDir(problem);
    const file = path.join(dir, `${name.trim()}.yaml`);
    if (fs.existsSync(file)) { vscode.window.showErrorMessage(`${name} exists.`); return; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, newCompositeText(name.trim(), picked.map((p) => p.label)));
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), EDITOR_SEMANTIC);
  });

  // ── Register all providers and commands ──
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EXTENSION_VIEW_ID, sidebarProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerCustomEditorProvider(EDITOR_DATA_MODEL, new DataModelEditorProvider(context)),
    vscode.window.registerCustomEditorProvider(EDITOR_STTM, new SttmEditorProvider(context)),
    vscode.window.registerCustomEditorProvider(EDITOR_GRAPH, new GraphEditorProvider(context)),
    vscode.window.registerCustomEditorProvider(EDITOR_PROFILE, new ProfileEditorProvider(context)),
    vscode.window.registerCustomEditorProvider(EDITOR_DOC, new DocEditorProvider(context)),
    vscode.window.registerCustomEditorProvider(EDITOR_SEMANTIC, new SemanticModelEditorProvider(context, semanticEditorHost)),
    newSemanticModel, newSemanticComposite,
    openSidebar,
    testLanguageModel, listLanguageModelInfo, listLanguageModels,
    copilotHandoff,
    testConnection, testTargetConnection, sourceAssessment, reVerifySourceSchema, disconnectDataPlatform, disconnectTargetDataPlatform, browseSourceDatabase, browseTargetDatabase, ingestFileAsSourceContext, createMapping, compactContextLedger, whatTheAgentSaw, explainArtifact, openEstate, syncMetadata, reindex,
    addPackDocument, applyPack, runConformance, verifyClaims, proposeVocabulary,
    importToolSkill, updateToolSkill, classifyPersonalData, captureCoverage, findCandidates, runToolSkill, reviewToolSkill, publishToolSkill, deprecateToolSkill, retireToolSkill, skillLog,
    newChat, chatHistory, discardChat,
    connectToDataPlatform, testServiceAccountCredential,
    checkPlatformPrerequisites, installOracleDriver, verifyOracleDriver, setOraclePassword, configureMcp
  );
}

export function deactivate(): void {
  disposableRegistry.disposeAll();
}