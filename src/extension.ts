import * as vscode from 'vscode';
import { EXTENSION_ID, EXTENSION_VIEW_ID } from './core/extensionIdentity';
import { DataAgentHubHub } from './core/agentHub';
import { ConfigurationManager } from './core/configManager';
import { DataAgentHubWebviewProvider } from './core/webviewProvider';
import { ConnectionManager } from './dqm/ConnectionManager';

export function activate(context: vscode.ExtensionContext): void {
  const configManager = new ConfigurationManager(context);
  const hub = new DataAgentHubHub(configManager);
  const provider = new DataAgentHubWebviewProvider(context, configManager, hub);

  // Deliberately NO eager Copilot detection here. selectChatModels is invoked
  // later, in response to user actions (testCopilot, listCopilotInfo, the sidebar
  // webview, or plan generation). This avoids races with other Copilot tabs at
  // extension startup. The local variable is populated lazily by those commands.
  let copilotAdapter: any = undefined;

  // ConnectionManager is created on-demand for testConnection and sourceAssessment
  let connectionManager: ConnectionManager | undefined;

  const openSidebar = vscode.commands.registerCommand(`${EXTENSION_ID}.openSidebar`, async () => {
    await vscode.commands.executeCommand(`workbench.view.extension.${EXTENSION_ID}`);
  });

  const generatePlan = vscode.commands.registerCommand(`${EXTENSION_ID}.generatePlan`, async () => {
    const objective = await vscode.window.showInputBox({
      prompt: 'Describe the data engineering objective to plan.',
      placeHolder: 'Load daily sales events into a curated model and validate row counts.'
    });

    if (!objective || objective.trim().length === 0) {
      return;
    }

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
      // If adapter wasn't detected earlier (race), do on-demand detection
      if (!copilotAdapter) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { CopilotAdapter } = require('./core/copilotAdapter') as typeof import('./core/copilotAdapter');
          const { info, adapter } = await CopilotAdapter.detect(context);
          copilotAdapter = adapter;
          if (!info.found) {
            vscode.window.showInformationMessage('GitHub Copilot Chat extension not found in this VS Code instance.');
            return;
          }
          if (!info.hasAccess) {
            vscode.window.showInformationMessage(info.error || 'GitHub Copilot language models are not available. Sign in to GitHub Copilot and try again.');
            return;
          }
          if (info.consentRequired) {
            const choice = await vscode.window.showInformationMessage(
              'GitHub Copilot is available. VS Code will ask for consent on the first request. Open the Copilot handoff editor as an alternative?',
              'Open Handoff',
              'Cancel'
            );
            if (choice === 'Open Handoff') {
              await vscode.commands.executeCommand(`${EXTENSION_ID}.copilotHandoff`);
            }
            return;
          }
        } catch (detErr) {
          // detection failed
          const dmsg = detErr instanceof Error ? detErr.message : String(detErr);
          vscode.window.showErrorMessage('Error detecting Copilot extension: ' + dmsg);
          return;
        }
      }

      if (!copilotAdapter) {
        vscode.window.showInformationMessage('GitHub Copilot not available.');
        return;
      }

      if (typeof copilotAdapter.testCall !== 'function') {
        vscode.window.showInformationMessage('Copilot adapter has no test capability.');
        return;
      }

      const out = await copilotAdapter.testCall();
      if (out.ok) {
        vscode.window.showInformationMessage('Copilot test succeeded: ' + (out.text ? out.text.slice(0, 120) : '[no-text]'));
      } else {
        vscode.window.showErrorMessage('Copilot test failed: ' + (out.error ?? 'unknown'));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage('Copilot test error: ' + msg);
    }
  });

  const listCopilotInfo = vscode.commands.registerCommand(`${EXTENSION_ID}.listCopilotInfo`, async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { CopilotAdapter } = require('./core/copilotAdapter') as typeof import('./core/copilotAdapter');
      const { info } = await CopilotAdapter.detect(context);
      const modelSummary = info.models
        .slice(0, 5)
        .map((m) => `${m.family} (${m.name})`)
        .join(', ');
      const msg =
        info.error ||
        `Copilot Chat installed=${info.found} hasAccess=${info.hasAccess} models=${info.models.length}${modelSummary ? ` [${modelSummary}]` : ''}${info.consentRequired ? ' consent required' : ''}`;
      vscode.window.showInformationMessage(msg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage('Error listing Copilot info: ' + msg);
    }
  });

  const debugListExtensions = vscode.commands.registerCommand(`${EXTENSION_ID}.debugListExtensions`, async () => {
    const out = vscode.window.createOutputChannel('autoDE:extensions-debug');
    out.show(true);
    out.appendLine('Enumerating installed extensions (dev host):');
    try {
      const all = vscode.extensions.all || [];
      for (const ext of all) {
        try {
          const id = ext.id || '<no-id>';
          const name = (ext.packageJSON && (ext.packageJSON.displayName || ext.packageJSON.name)) || '<no-name>';
          out.appendLine(`- ${id} :: ${String(name)} :: active=${String(ext.isActive)}`);
        } catch (e) {
          out.appendLine(`- ${ext.id} :: <error reading packageJSON>`);
        }
      }
      out.appendLine('--- End of extension list');
    } catch (err) {
      out.appendLine('Error enumerating extensions: ' + (err instanceof Error ? err.message : String(err)));
    }
  });

  const copilotHandoff = vscode.commands.registerCommand(`${EXTENSION_ID}.copilotHandoff`, async (seedPrompt?: string) => {
    // Create a seeded, untitled editor with a test prompt and trigger inline suggestions
    const defaultPrompt = `/* Copilot interactive handoff: test prompt.\nGenerate a one-line friendly comment that says hello and mentions this is a Copilot interactive suggestion. */\n`;
    const prompt = typeof seedPrompt === 'string' && seedPrompt.trim().length > 0 ? seedPrompt : defaultPrompt;
    try {
      const doc = await vscode.workspace.openTextDocument({ content: prompt, language: 'plaintext' });
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      // Place cursor at end
      const lastLine = doc.lineCount - 1;
      const lastChar = doc.lineAt(lastLine).text.length;
      editor.selection = new vscode.Selection(new vscode.Position(lastLine, lastChar), new vscode.Position(lastLine, lastChar));

      // Trigger inline suggestions (Copilot provides inline suggestions on typing)
      try {
        await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
      } catch (e) {
        // fallback to trigger general suggestions
        await vscode.commands.executeCommand('editor.action.triggerSuggest');
      }

      vscode.window.showInformationMessage('Opened handoff editor for Copilot interactive suggestions. Accept suggestions using Tab or Enter as normal.');
    } catch (err) {
      vscode.window.showErrorMessage('Failed to open Copilot handoff editor: ' + (err instanceof Error ? err.message : String(err)));
    }
  });

  // ── Phase 3a: Connection & Source Assessment Commands ──

  const testConnection = vscode.commands.registerCommand(`${EXTENSION_ID}.testConnection`, async () => {
    try {
      const settings = configManager.getSettings();
      const platform = settings.defaultProvider ?? 'snowflake';

      const credentials = ConnectionManager.getCredentialsFromSettings(platform, settings as unknown as Record<string, unknown>);

      // Retrieve secrets
      if (platform === 'snowflake') {
        const password = await configManager.getSnowflakePassword();
        if (password) {
          credentials['password'] = password;
        }
        const passphrase = await configManager.getSnowflakePrivateKeyPassphrase();
        if (passphrase) {
          credentials['passphrase'] = passphrase;
        }
      }

      // Validate required fields
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
        vscode.window.showErrorMessage(
          `Missing required credentials for ${platform}: ${missing.join(', ')}. Configure them in Settings → Connections.`
        );
        return;
      }

      // Dispose previous connection manager
      if (connectionManager) {
        connectionManager.dispose();
      }

      connectionManager = new ConnectionManager((msg: string) => {
        console.log(`[AutoDE Connection] ${msg}`);
      });

      const info = await connectionManager.connect(platform, credentials);
      vscode.window.showInformationMessage(
        `Connected to ${platform}: ${info.databaseName}.${info.schemaName} (v${info.version})`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Connection failed: ${msg}`);
    }
  });

  const sourceAssessment = vscode.commands.registerCommand(`${EXTENSION_ID}.sourceAssessment`, async () => {
    try {
      if (!connectionManager || !connectionManager.isConnected()) {
        // Try to connect first
        await vscode.commands.executeCommand(`${EXTENSION_ID}.testConnection`);
        if (!connectionManager || !connectionManager.isConnected()) {
          vscode.window.showErrorMessage('Cannot run source assessment: not connected to a data platform.');
          return;
        }
      }

      vscode.window.showInformationMessage('Running source assessment — extracting metadata...');

      const snapshot = await connectionManager.extractMetadata({
        includeProfiling: true
      });

      // Persist to .ai-context/
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (workspaceRoot) {
        await connectionManager.persistSchemaContext(snapshot, workspaceRoot);
      }

      vscode.window.showInformationMessage(
        `Source assessment complete: ${snapshot.tables.length} tables, ${snapshot.views.length} views discovered. ` +
        `Schema context saved to .ai-context/schema-graph.json.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Source assessment failed: ${msg}`);
    }
  });

  const syncMetadata = vscode.commands.registerCommand(`${EXTENSION_ID}.syncMetadata`, async () => {
    try {
      if (!connectionManager || !connectionManager.isConnected()) {
        vscode.window.showErrorMessage('Cannot sync metadata: not connected to a data platform. Connect first via Settings → Connections.');
        return;
      }

      vscode.window.showInformationMessage('Syncing database metadata...');

      const snapshot = await connectionManager.extractMetadata({
        includeProfiling: false
      });

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (workspaceRoot) {
        await connectionManager.persistSchemaContext(snapshot, workspaceRoot);
      }

      vscode.window.showInformationMessage(
        `Metadata sync complete: ${snapshot.tables.length} tables, ${snapshot.views.length} views.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Metadata sync failed: ${msg}`);
    }
  });

  const reindex = vscode.commands.registerCommand(`${EXTENSION_ID}.reindex`, async () => {
    vscode.window.showInformationMessage('Context re-index triggered. Rebuild the context layer from the sidebar.');
    // The actual re-index is handled by the webview provider's sourceAssessment handler
    // which re-initializes the ContextFileManager
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EXTENSION_VIEW_ID, provider),
    openSidebar,
    generatePlan,
    executePlan,
    resetSession,
    testCopilot,
    listCopilotInfo,
    debugListExtensions,
    copilotHandoff,
    testConnection,
    sourceAssessment,
    syncMetadata,
    reindex
  );
}

export function deactivate(): void {
  // Intentionally empty.
}