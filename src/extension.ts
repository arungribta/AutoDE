import * as vscode from 'vscode';
import { EXTENSION_ID, EXTENSION_VIEW_ID, EXTENSION_PANEL_VIEW_ID } from './core/extensionIdentity';
import { DataAgentHubHub } from './core/agentHub';
import { ConfigurationManager } from './core/configManager';
import { DataAgentHubWebviewProvider } from './core/webviewProvider';
import { DataAgentHubPanelProvider } from './core/panelProvider';
import { ConnectionManager } from './dqm/ConnectionManager';
import { ProjectManager } from './context/ProjectManager';

export function activate(context: vscode.ExtensionContext): void {
  const configManager = new ConfigurationManager(context);
  const hub = new DataAgentHubHub(configManager);
  const sidebarProvider = new DataAgentHubWebviewProvider(context, configManager, hub);
  const panelProvider = new DataAgentHubPanelProvider(context, hub);

  let copilotAdapter: any = undefined;
  let connectionManager: ConnectionManager | undefined;

  // Initialize ProjectManager
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? context.extensionUri;
  const projectManager = new ProjectManager(workspaceRoot, (msg: string) => {
    console.log(`[AutoDE Project] ${msg}`);
  });
  projectManager.initialize().then(() => {
    sidebarProvider.setProjectManager(projectManager);
  });
  context.subscriptions.push(projectManager);

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
    await hub.generatePlan(objective.trim());
  });

  const executePlan = vscode.commands.registerCommand(`${EXTENSION_ID}.executePlan`, async () => {
    await hub.executePlan();
  });

  const resetSession = vscode.commands.registerCommand(`${EXTENSION_ID}.resetSession`, async () => {
    await hub.resetPlan();
  });

  const testCopilot = vscode.commands.registerCommand(`${EXTENSION_ID}.testCopilot`, async () => {
    try {
      if (!copilotAdapter) {
        try {
          const { CopilotAdapter } = require('./core/copilotAdapter') as typeof import('./core/copilotAdapter');
          const { info, adapter } = await CopilotAdapter.detect(context);
          copilotAdapter = adapter;
          if (!info.found) { vscode.window.showInformationMessage('GitHub Copilot Chat extension not found.'); return; }
          if (!info.hasAccess) { vscode.window.showInformationMessage(info.error || 'GitHub Copilot not available. Sign in and try again.'); return; }
          if (info.consentRequired) {
            const choice = await vscode.window.showInformationMessage('Copilot available. Open handoff editor?', 'Open Handoff', 'Cancel');
            if (choice === 'Open Handoff') { await vscode.commands.executeCommand(`${EXTENSION_ID}.copilotHandoff`); }
            return;
          }
        } catch (detErr) {
          vscode.window.showErrorMessage('Error detecting Copilot: ' + (detErr instanceof Error ? detErr.message : String(detErr)));
          return;
        }
      }
      if (!copilotAdapter) { vscode.window.showInformationMessage('GitHub Copilot not available.'); return; }
      if (typeof copilotAdapter.testCall !== 'function') { vscode.window.showInformationMessage('Copilot adapter has no test capability.'); return; }
      const out = await copilotAdapter.testCall();
      if (out.ok) { vscode.window.showInformationMessage('Copilot test succeeded: ' + (out.text ? out.text.slice(0, 120) : '[no-text]')); }
      else { vscode.window.showErrorMessage('Copilot test failed: ' + (out.error ?? 'unknown')); }
    } catch (err) {
      vscode.window.showErrorMessage('Copilot test error: ' + (err instanceof Error ? err.message : String(err)));
    }
  });

  const listCopilotInfo = vscode.commands.registerCommand(`${EXTENSION_ID}.listCopilotInfo`, async () => {
    try {
      const { CopilotAdapter } = require('./core/copilotAdapter') as typeof import('./core/copilotAdapter');
      const { info } = await CopilotAdapter.detect(context);
      const modelSummary = info.models.slice(0, 5).map((m) => `${m.family} (${m.name})`).join(', ');
      const msg = info.error || `Copilot Chat installed=${info.found} hasAccess=${info.hasAccess} models=${info.models.length}${modelSummary ? ` [${modelSummary}]` : ''}${info.consentRequired ? ' consent required' : ''}`;
      vscode.window.showInformationMessage(msg);
    } catch (err) {
      vscode.window.showErrorMessage('Error listing Copilot info: ' + (err instanceof Error ? err.message : String(err)));
    }
  });

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

  const newProject = vscode.commands.registerCommand(`${EXTENSION_ID}.newProject`, async () => {
    const objective = await vscode.window.showInputBox({ prompt: 'Describe your data engineering project objective.', placeHolder: 'Build a sales analytics pipeline in Snowflake using dbt...' });
    if (!objective || objective.trim().length === 0) { return; }
    const project = await hub.createProject(objective.trim());
    if (project) { vscode.window.showInformationMessage(`Project created: ${project.name}`); }
  });

  // ── Register all providers and commands ──
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EXTENSION_VIEW_ID, sidebarProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider(EXTENSION_PANEL_VIEW_ID, panelProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    openSidebar, generatePlan, executePlan, resetSession,
    testCopilot, listCopilotInfo, debugListExtensions, copilotHandoff,
    testConnection, sourceAssessment, syncMetadata, reindex,
    newProject
  );
}

export function deactivate(): void {
  // Intentionally empty.
}