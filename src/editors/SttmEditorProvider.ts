import * as vscode from 'vscode';
import * as fs from 'node:fs';

export class SttmEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'autoDE.sttmEditor';

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
    const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editors', 'sttmEditor.html');
    let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
    html = html.replace('{{CONTENT}}', content.replace(/`/g, '\\`').replace(/\$/g, '\\$'));
    html = html.replace('{{FILENAME}}', document.fileName.split(/[/\\]/).pop() || 'sttm-mapping.yaml');
    return html;
  }
}