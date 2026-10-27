import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PortSkillHost, PortSkillMsg, PortSkillSession } from './portSkillSession';

/**
 * The Port a Skill tab (PA4): bring a skill written for any agent into AutoDE — from a Git repository, a
 * folder or a dbt package — with its capability report, the model's proposal where a model is configured,
 * and import, review and publish, each confirmed. The wizard's logic is in PortSkillSession.
 */

export type PortSkillPanelHost = Omit<PortSkillHost, 'post' | 'pickFolder' | 'confirm' | 'resourcesRoot'>;

export class PortSkillPanel {
  private static current: PortSkillPanel | undefined;
  private readonly session: PortSkillSession;

  private constructor(private readonly panel: vscode.WebviewPanel, context: vscode.ExtensionContext, host: PortSkillPanelHost) {
    this.session = new PortSkillSession({
      ...host,
      resourcesRoot: context.extensionPath,
      post: (model) => void panel.webview.postMessage({ type: 'model', model }),
      pickFolder: async (title) => (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Analyse', title }))?.[0]?.fsPath,
      confirm: async (title, detail, action) => (await vscode.window.showWarningMessage(title, { modal: true, detail }, action)) === action
    });
    panel.onDidDispose(() => { this.session.dispose(); PortSkillPanel.current = undefined; });
    panel.webview.onDidReceiveMessage((m: PortSkillMsg) => void this.session.onMessage(m));
  }

  public static show(context: vscode.ExtensionContext, host: PortSkillPanelHost): void {
    if (!PortSkillPanel.current) {
      const panel = vscode.window.createWebviewPanel('autodePortSkill', 'Port a Skill', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] });
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'autode-icon-64.png');
      const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
      panel.webview.html = fs.readFileSync(path.join(context.extensionUri.fsPath, 'media', 'port-skill.html'), 'utf8').replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, panel.webview.cspSource);
      PortSkillPanel.current = new PortSkillPanel(panel, context, host);
    }
    PortSkillPanel.current.panel.reveal();
  }
}
