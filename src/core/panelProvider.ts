import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { DataAgentHubHub } from './agentHub';
import { PlanState, WebviewMessage } from './types';
import { EXTENSION_ID } from './extensionIdentity';

/**
 * WebviewViewProvider for the bottom panel dashboard.
 * Provides a persistent view of project progress, stats, and artifacts.
 */
export class DataAgentHubPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'autoDataEngineeringHubPanelView';

  private view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly hub: DataAgentHubHub
  ) {
    this.hub.setStateListener((state: PlanState) => this.postState(state));
    this.hub.setLogListener((message: string) => this.postLog(message));
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    webviewView.webview.html = this.getHtmlForPanel(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      await this.handleMessage(message);
    });

    // Send initial data
    this.postProjectList();
    this.postState(this.hub.getPlan());
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'testConnection':
          await vscode.commands.executeCommand(`${EXTENSION_ID}.testConnection`);
          break;
        case 'sourceAssessment':
          await vscode.commands.executeCommand(`${EXTENSION_ID}.sourceAssessment`);
          break;
        case 'generatePlan':
          await vscode.commands.executeCommand(`${EXTENSION_ID}.generatePlan`);
          break;
        case 'executePlan':
          await vscode.commands.executeCommand(`${EXTENSION_ID}.executePlan`);
          break;
        case 'openPalette':
          // Signal the sidebar to open the palette
          this.view?.webview.postMessage({ type: 'logEntry', message: 'Open the Workflow Palette from the sidebar (🧰 icon).' });
          break;
        case 'openProjectFolder': {
          const project = this.hub.getActiveProject();
          if (project) {
            const projectUri = vscode.Uri.joinPath(
              vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri,
              '.auto-de', 'projects', project.id
            );
            await vscode.commands.executeCommand('revealFileInOS', projectUri);
          }
          break;
        }
        case 'openPhaseFolder': {
          const project = this.hub.getActiveProject();
          const phase = typeof message.phase === 'string' ? message.phase : undefined;
          if (project && phase) {
            const phaseDirs: Record<string, string> = {
              discover: '01-discover', model: '02-model', build: '03-build', validate: '04-validate'
            };
            const dir = phaseDirs[phase] || phase;
            const phaseUri = vscode.Uri.joinPath(
              vscode.workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri,
              '.auto-de', 'projects', project.id, dir
            );
            await vscode.commands.executeCommand('revealFileInOS', phaseUri);
          }
          break;
        }
        case 'getProjects':
          this.postProjectList();
          break;
        case 'settingsLoaded':
          // Panel doesn't need settings, just acknowledge
          break;
        default:
          break;
      }
    } catch (error) {
      const observed = error instanceof Error ? error.message : 'Unexpected panel error.';
      this.view?.webview.postMessage({ type: 'error', message: observed });
    }
  }

  private postState(state: PlanState): void {
    this.view?.webview.postMessage({ type: 'stateUpdate', state });
  }

  private postLog(message: string): void {
    this.view?.webview.postMessage({ type: 'logEntry', message });
  }

  private postProjectList(): void {
    const projects = this.hub.getProjects();
    const activeId = this.hub.getActiveProject()?.id ?? null;
    this.view?.webview.postMessage({ type: 'projectList', projects, activeProjectId: activeId });
  }

  private getHtmlForPanel(webview: vscode.Webview): string {
    const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.html');
    return fs.readFileSync(htmlPath.fsPath, 'utf8');
  }
}