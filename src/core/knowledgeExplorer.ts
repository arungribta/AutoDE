import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { EngineWorkspace } from '../mcp/workspace';
import { ExploreSources } from '../engine/explore/explore';
import { exploreSources } from '../engine/explore/sources';
import { activeProblemId } from '../engine/documents/problems';
import { ContextPackSources } from '../engine/context/contextPack';
import { ExplorerAction, ExplorerMessage, answerExplorerMessage } from './knowledgeExplorerModel';

/**
 * The Knowledge Explorer (C5b; docs/context-layer-requirements.md §6.10): an
 * editor tab for exploring what AutoDE knows — search, asset pages, the graph,
 * facts and the estate. It reads through the engine's workspace, the same one
 * the CLI and the MCP server read, so every surface shows the same thing.
 */

export interface KnowledgeExplorerHost {
  workspaceRoot(): string | undefined;
  /** Shows the Context Inbox in the sidebar. */
  openInbox(): void;
}

class ExploreSourceCache {
  private ws: EngineWorkspace | undefined;
  private last: { context: ContextPackSources; at: number; sources: ExploreSources } | undefined;

  constructor(private readonly resourcesRoot: string) {}

  public async get(root: string): Promise<ExploreSources> {
    if (!this.ws || this.ws.options.workspaceRoot !== root) { this.ws = new EngineWorkspace({ workspaceRoot: root, resourcesRoot: this.resourcesRoot }); this.last = undefined; }
    const context = await this.ws.contextSources();
    // The context sources are re-read only when their files change; manifests and the semantic layer are re-read at most every two seconds.
    if (!this.last || this.last.context !== context || Date.now() - this.last.at > 2000) this.last = { context, at: Date.now(), sources: exploreSources(root, context, activeProblemId(root)) };
    return this.last.sources;
  }
}

export class KnowledgeExplorerPanel {
  private static current: KnowledgeExplorerPanel | undefined;
  private readonly cache: ExploreSourceCache;

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly host: KnowledgeExplorerHost, extensionPath: string) {
    this.cache = new ExploreSourceCache(extensionPath);
    panel.onDidDispose(() => { KnowledgeExplorerPanel.current = undefined; });
    panel.webview.onDidReceiveMessage((m: ExplorerMessage) => void this.onMessage(m));
  }

  public static show(context: vscode.ExtensionContext, host: KnowledgeExplorerHost, asset?: string): void {
    if (!KnowledgeExplorerPanel.current) {
      const panel = vscode.window.createWebviewPanel('autodeKnowledgeExplorer', 'Knowledge Explorer', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')] });
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'autode-icon-64.png');
      const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const cytoscape = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'cytoscape.min.js')).toString();
      panel.webview.html = fs.readFileSync(path.join(context.extensionUri.fsPath, 'media', 'explorer.html'), 'utf8')
        .replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, panel.webview.cspSource).replace(/\{\{cytoscapeUri\}\}/g, cytoscape);
      KnowledgeExplorerPanel.current = new KnowledgeExplorerPanel(panel, host, context.extensionUri.fsPath);
    }
    KnowledgeExplorerPanel.current.panel.reveal();
    if (asset) void KnowledgeExplorerPanel.current.panel.webview.postMessage({ type: 'showAsset', id: asset });
  }

  private async onMessage(m: ExplorerMessage): Promise<void> {
    const answer = await answerExplorerMessage(m, { workspaceRoot: () => this.host.workspaceRoot(), sources: async () => { const root = this.host.workspaceRoot(); return root ? this.cache.get(root) : undefined; } });
    if (answer.reply) void this.panel.webview.postMessage(answer.reply);
    if (answer.action) await this.act(answer.action);
  }

  private async act(a: ExplorerAction): Promise<void> {
    switch (a.kind) {
      case 'openFile': await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(a.file)); return;
      case 'openInbox': this.host.openInbox(); return;
      case 'openWorkflow': await vscode.commands.executeCommand('autoDataEngineeringHub.openWorkflow'); return;
      case 'copy': await vscode.env.clipboard.writeText(a.text); return;
      case 'save': {
        const target = await vscode.window.showSaveDialog({ filters: a.format === 'svg' ? { SVG: ['svg'] } : { PNG: ['png'] }, defaultUri: this.host.workspaceRoot() ? vscode.Uri.file(path.join(this.host.workspaceRoot()!, `knowledge-graph.${a.format}`)) : undefined });
        if (!target) return;
        const bytes = a.data.startsWith('data:') ? Buffer.from(a.data.slice(a.data.indexOf(',') + 1), a.data.includes(';base64,') ? 'base64' : 'utf8') : Buffer.from(a.data, 'utf8');
        await vscode.workspace.fs.writeFile(target, a.format === 'svg' && a.data.startsWith('data:') && !a.data.includes(';base64,') ? Buffer.from(decodeURIComponent(a.data.slice(a.data.indexOf(',') + 1)), 'utf8') : bytes);
        void vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}.`);
        return;
      }
    }
  }
}

export function registerKnowledgeExplorer(context: vscode.ExtensionContext, host: KnowledgeExplorerHost): vscode.Disposable[] {
  return [vscode.commands.registerCommand('autoDataEngineeringHub.openKnowledgeExplorer', (asset?: unknown) => KnowledgeExplorerPanel.show(context, host, typeof asset === 'string' ? asset : undefined))];
}
