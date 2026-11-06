import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { applyCspNonce, scriptValue, escapeHtmlText } from '../core/webviewSecurity';

export class GraphEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'autoDE.graphEditor';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview, document);
  }

  private getHtml(webview: vscode.Webview, document: vscode.TextDocument): string {
    const content = document.getText();
    const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editors', 'graphEditor.html');
    let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
    html = html.replace('{{CONTENT}}', () => scriptValue(content));
    html = html.replace('{{FILENAME}}', () => escapeHtmlText(document.fileName.split(/[/\\]/).pop() || 'knowledge-graph.json'));
    return applyCspNonce(html, webview.cspSource);
  }
}