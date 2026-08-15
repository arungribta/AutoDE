import * as vscode from 'vscode';
import { EXTENSION_ID, EXTENSION_VIEW_ID } from './core/extensionIdentity';
import { DataAgentHubHub } from './core/agentHub';
import { ConfigurationManager } from './core/configManager';
import { DataAgentHubWebviewProvider } from './core/webviewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const configManager = new ConfigurationManager(context);
  const hub = new DataAgentHubHub(configManager);
  const provider = new DataAgentHubWebviewProvider(context, configManager, hub);

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

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EXTENSION_VIEW_ID, provider),
    openSidebar,
    generatePlan,
    executePlan,
    resetSession
  );
}

export function deactivate(): void {
  // Intentionally empty.
}
