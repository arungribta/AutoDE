import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { capabilityMatrix, conformanceRun, operationPage, platformPage, skillPage } from '../engine/platform/operations/catalogView';
import { loadCatalog, operationById, platformById } from '../engine/platform/operations/load';
import { bindOperation } from '../engine/platform/operations/execute';
import { ConnectionTarget, OperationError, runOnConnection } from '../engine/platform/operations/service';
import { loadConnectionsConfig } from '../engine/platform/connectionsConfig';

/**
 * The Platform catalog tab (POP4a; docs/specs/platform-operations.md §6.3): the capability matrix, each platform's
 * page, operation and skill pages, Try it and conformance runs. Everything it shows comes from the engine's
 * catalog (the same answers as `autode platform catalog` and `autode_platform_catalog`); this file only hosts it.
 */

export interface PlatformCatalogHost {
  workspaceRoot(): string | undefined;
  /** The panel's live connections: what Try it and a conformance run use. */
  liveConnections(): Array<{ id: string; platform: string; target: ConnectionTarget }>;
}

type Message =
  | { type: 'ready' } | { type: 'matrix' }
  | { type: 'platform'; id: string } | { type: 'operation'; id: string } | { type: 'skill'; id: string }
  | { type: 'conformance'; connection: string } | { type: 'preview'; operation: string; platform: string; params: Record<string, string> }
  | { type: 'try'; operation: string; connection: string; params: Record<string, string> }
  | { type: 'openFile'; file: string } | { type: 'customise'; id: string } | { type: 'openTab'; tab: string };

export class PlatformCatalogPanel {
  private static current: PlatformCatalogPanel | undefined;

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly host: PlatformCatalogHost, private readonly resourcesRoot: string) {
    panel.onDidDispose(() => { PlatformCatalogPanel.current = undefined; });
    panel.webview.onDidReceiveMessage((m: Message) => void this.onMessage(m));
  }

  public static show(context: vscode.ExtensionContext, host: PlatformCatalogHost, open?: { platform?: string; operation?: string }): void {
    if (!PlatformCatalogPanel.current) {
      const panel = vscode.window.createWebviewPanel('autodePlatformCatalog', 'AutoDE · Platform catalog', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'autode-icon-64.png');
      const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
      panel.webview.html = fs.readFileSync(path.join(context.extensionUri.fsPath, 'media', 'platforms.html'), 'utf8').replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, panel.webview.cspSource);
      PlatformCatalogPanel.current = new PlatformCatalogPanel(panel, host, context.extensionUri.fsPath);
    }
    const c = PlatformCatalogPanel.current;
    c.panel.reveal();
    if (open?.platform) void c.onMessage({ type: 'platform', id: open.platform });
    else if (open?.operation) void c.onMessage({ type: 'operation', id: open.operation });
  }

  private scope() { return { resourcesRoot: this.resourcesRoot, workspaceRoot: this.host.workspaceRoot() }; }

  private post(m: Record<string, unknown>): void { void this.panel.webview.postMessage(m); }

  private async onMessage(m: Message): Promise<void> {
    try {
      switch (m.type) {
        case 'ready': case 'matrix':
          this.post({ type: 'matrix', matrix: capabilityMatrix(this.scope()), live: this.host.liveConnections().map((c) => ({ id: c.id, platform: c.platform })) });
          return;
        case 'platform': this.post({ type: 'platform', page: platformPage(this.scope(), m.id) ?? null, live: this.host.liveConnections().filter((c) => c.platform === m.id).map((c) => c.id) }); return;
        case 'operation': this.post({ type: 'operation', page: operationPage(this.scope(), m.id) ?? null, live: this.host.liveConnections().map((c) => ({ id: c.id, platform: c.platform })) }); return;
        case 'skill': this.post({ type: 'skill', page: skillPage(this.scope(), m.id) ?? null }); return;
        case 'conformance': {
          const c = this.host.liveConnections().find((x) => x.id === m.connection);
          if (!c) { this.post({ type: 'notice', text: `${m.connection} isn't connected: connect it in Settings → Connections first.` }); return; }
          const root = this.host.workspaceRoot();
          const fields = root ? loadConnectionsConfig(root).connections.find((x) => x.id === c.id)?.fields ?? {} : {};
          const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `AutoDE: conformance run on ${c.id}` }, () => conformanceRun(this.scope(), c.target, fields));
          this.post({ type: 'notice', text: r.summary });
          await this.onMessage({ type: 'platform', id: c.platform });
          return;
        }
        case 'preview': {
          // You see the bound statement before it runs; a change operation shows the runbook step it would be.
          const catalog = loadCatalog(this.scope());
          const op = operationById(catalog, m.operation)?.item;
          if (!op) { this.post({ type: 'preview', error: `No approved operation ${m.operation}.` }); return; }
          const b = bindOperation(op, m.platform, coerce(op, m.params), platformById(catalog, m.platform));
          this.post({ type: 'preview', operation: m.operation, kind: op.kind, statement: b.statement ?? (b.argv ? b.argv.join(' ') : '') });
          return;
        }
        case 'try': {
          const c = this.host.liveConnections().find((x) => x.id === m.connection);
          if (!c) { this.post({ type: 'tried', error: `${m.connection} isn't connected.` }); return; }
          const catalog = loadCatalog(this.scope());
          const op = operationById(catalog, m.operation)?.item;
          try {
            const r = await runOnConnection({ ...this.scope(), catalog }, c.target, m.operation, op ? coerce(op, m.params) : m.params, { maxRows: 50, via: 'catalog: try it' });
            // Names (metadata) are shown; row values stay with `autode platform run`, which applies the sample-data consent and masking.
            this.post({ type: 'tried', ok: r.ok && !r.gap, gap: r.gap, statement: r.statement ?? r.argv?.join(' '), count: r.rows.length, rows: op?.content === 'metadata' ? r.rows : undefined, withheld: op?.content !== 'metadata' });
          } catch (err) {
            if (err instanceof OperationError && err.code === 'CHANGE') { this.post({ type: 'tried', change: true, message: err.message, step: err.step }); return; }
            this.post({ type: 'tried', error: err instanceof Error ? err.message : String(err) });
          }
          await this.onMessage({ type: 'operation', id: m.operation });
          return;
        }
        case 'openFile': {
          const root = this.host.workspaceRoot();
          const full = path.isAbsolute(m.file) ? m.file : path.resolve(root && fs.existsSync(path.resolve(root, m.file)) ? root : this.resourcesRoot, m.file);
          await vscode.window.showTextDocument(vscode.Uri.file(full), { preview: true });
          return;
        }
        case 'customise': await vscode.commands.executeCommand('autoDataEngineeringHub.customisePlatformOperation', m.id); return;
        case 'openTab': await vscode.commands.executeCommand(m.tab === 'workflow' ? 'autoDataEngineeringHub.openWorkflow' : 'autoDataEngineeringHub.openKnowledgeExplorer'); return;
      }
    } catch (err) {
      this.post({ type: 'notice', text: err instanceof Error ? err.message : String(err), error: true });
    }
  }
}

/** Form values are text: numbers, booleans and lists as the operation's parameters declare them. */
function coerce(op: { params: Array<{ name: string; type: string }> }, values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of op.params) {
    const v = values[p.name];
    if (v === undefined || v === '') continue;
    out[p.name] = p.type === 'number' ? Number(v) : p.type === 'boolean' ? v === 'true' : p.type.endsWith('_list') ? v.split(',').map((x) => x.trim()).filter(Boolean) : v;
  }
  return out;
}
