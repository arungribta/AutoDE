import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { EngineWorkspace } from '../mcp/workspace';
import { ExploreSources } from '../engine/explore/explore';
import { exploreSources } from '../engine/explore/sources';
import { activeProblemId } from '../engine/documents/problems';
import { ContextPackSources } from '../engine/context/contextPack';
import { ExplorerAction, ExplorerMessage, answerExplorerMessage } from './knowledgeExplorerModel';
import { SetMetadataInput } from '../engine/metadata/record';
import { CERTIFICATIONS_SET, OWNER_ROLES, loadMetadataConfig } from '../engine/metadata/model';

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
  /** MM1: a person sets or removes an asset's metadata (returns the message to show). */
  recordMetadata?(input: SetMetadataInput, remove: boolean): Promise<string>;
  /** Who the person is. */
  user?(): string;
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
      case 'editMetadata': await editMetadata(this.host, this.panel, a.id, a.label); return;
      case 'maintenance': await vscode.commands.executeCommand(a.act === 'work' ? 'autoDataEngineeringHub.workOnMaintenanceItem' : 'autoDataEngineeringHub.dismissMaintenanceItem', a.key); return;
      case 'saveText': {
        const target = await vscode.window.showSaveDialog({ filters: a.format === 'csv' ? { CSV: ['csv'] } : { Markdown: ['md'] }, defaultUri: this.host.workspaceRoot() ? vscode.Uri.file(path.join(this.host.workspaceRoot()!, a.name)) : undefined });
        if (!target) return;
        await vscode.workspace.fs.writeFile(target, Buffer.from(a.text, 'utf8'));
        void vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}.`);
        return;
      }
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

/**
 * Set metadata… (MM1): VS Code's own pickers collect a tag, an owner, a
 * domain, a certification or a property; the person's choice is recorded as
 * a confirmed fact. Controlled tag values and property types come from the
 * team's configuration.
 */
async function editMetadata(host: KnowledgeExplorerHost, panel: vscode.WebviewPanel, id: string, label: string): Promise<void> {
  const root = host.workspaceRoot();
  if (!root || !host.recordMetadata) return;
  const config = loadMetadataConfig(root);
  const what = await vscode.window.showQuickPick([
    { label: 'Add a tag', p: 'tag' as const }, { label: 'Add an owner', p: 'owner' as const }, { label: 'Set the domain', p: 'domain' as const },
    { label: 'Certify', p: 'certification' as const }, { label: 'Set a custom property', p: 'property' as const }, { label: 'Remove a tag', p: 'tag' as const, remove: true }, { label: 'Remove an owner', p: 'owner' as const, remove: true }
  ], { title: `Metadata of ${label}` });
  if (!what) return;
  let value: Record<string, unknown> | undefined;
  if (what.p === 'tag') {
    const known = config.tagGroups.flatMap((g) => g.tags.map((t) => ({ label: t.key, description: `${g.name}${t.values ? `: ${t.values.join(', ')}` : ''}`, values: t.values })));
    const pick = known.length ? await vscode.window.showQuickPick([...known, { label: 'Another tag…', description: 'key or key=value', values: undefined }], { title: 'Tag' }) : { label: 'Another tag…', values: undefined };
    if (!pick) return;
    if (pick.label === 'Another tag…') {
      const raw = await vscode.window.showInputBox({ title: 'Tag', prompt: 'key or key=value (for example kpi, or tier=gold)', validateInput: (v) => (/^[A-Za-z_][A-Za-z0-9_.-]*(=.*)?$/.test(v.trim()) ? undefined : 'A key starts with a letter or _, then letters, digits, _ . -') });
      if (!raw) return;
      const i = raw.indexOf('=');
      value = i < 0 ? { key: raw.trim() } : { key: raw.slice(0, i).trim(), value: raw.slice(i + 1).trim() };
    } else if (pick.values?.length && !what.remove) {
      const v = await vscode.window.showQuickPick(pick.values, { title: `${pick.label} =` });
      if (!v) return;
      value = { key: pick.label, value: v };
    } else value = { key: pick.label };
  } else if (what.p === 'owner') {
    const role = await vscode.window.showQuickPick(OWNER_ROLES.map((r) => ({ label: r.replace(/_/g, ' '), r })), { title: 'Role' });
    if (!role) return;
    const person = await vscode.window.showInputBox({ title: `${role.label} of ${label}`, prompt: 'Who (a name or email)' });
    if (!person?.trim()) return;
    value = { role: role.r, person: person.trim() };
  } else if (what.p === 'domain') {
    const pick = await vscode.window.showQuickPick([...config.domains.map((d) => d.name), 'Another domain…'], { title: 'Domain (defined in .autode/config/domains.yaml)' });
    if (!pick) return;
    const name = pick === 'Another domain…' ? await vscode.window.showInputBox({ title: 'Domain name' }) : pick;
    if (!name?.trim()) return;
    value = { domain: name.trim() };
  } else if (what.p === 'certification') {
    const status = await vscode.window.showQuickPick([...CERTIFICATIONS_SET], { title: `Certify ${label}` });
    if (!status) return;
    const note = await vscode.window.showInputBox({ title: 'Note (optional)', prompt: 'Why' });
    value = { status, ...(note?.trim() ? { note: note.trim() } : {}) };
  } else {
    if (!config.properties.length) { void vscode.window.showInformationMessage('No custom properties are defined: add them to .autode/config/properties.yaml.'); return; }
    const def = await vscode.window.showQuickPick(config.properties.map((p) => ({ label: p.name, description: `${p.type}${p.values ? `: ${p.values.join(', ')}` : ''}`, def: p })), { title: 'Property' });
    if (!def) return;
    const raw = def.def.type === 'enum' ? await vscode.window.showQuickPick(def.def.values ?? [], { title: def.label }) : def.def.type === 'boolean' ? await vscode.window.showQuickPick(['true', 'false'], { title: def.label }) : await vscode.window.showInputBox({ title: def.label });
    if (raw === undefined) return;
    value = { name: def.label, value: def.def.type === 'number' ? Number(raw) : def.def.type === 'boolean' ? raw === 'true' : raw };
  }
  try {
    const message = await host.recordMetadata({ subject: id, label, predicate: what.p, value, by: host.user?.() ?? 'user', channel: 'panel' }, !!what.remove);
    void vscode.window.showInformationMessage(message);
    void panel.webview.postMessage({ type: 'showAsset', id });
  } catch (err) { void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err)); }
}

export function registerKnowledgeExplorer(context: vscode.ExtensionContext, host: KnowledgeExplorerHost): vscode.Disposable[] {
  return [vscode.commands.registerCommand('autoDataEngineeringHub.openKnowledgeExplorer', (asset?: unknown) => KnowledgeExplorerPanel.show(context, host, typeof asset === 'string' ? asset : undefined))];
}
