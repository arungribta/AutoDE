import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkflowModel, StageModel, STATUS_ICON, buildWorkflowModel, statusBarText } from './workflowViewModel';
import { stageDetail, WorkflowScope } from '../engine/workflows/service';
import { actorLabel } from '../engine/workflows/events';
import { layoutPath } from '../engine/workspaceLayout';

/**
 * The Workflow view (v0.44.1): a tree in AutoDE's activity bar, a full editor
 * tab, and a status-bar item, all over the engine's workflow runtime and its
 * history — so progress and who did what are always visible. Actions go
 * through the panel's own handlers (the person at the keyboard is the panel
 * channel); nothing here bypasses a gate.
 */

export interface WorkflowViewHost {
  scope(): WorkflowScope | undefined;
  resolve(id: string, decision: 'approved' | 'rejected', note?: string): Promise<void>;
  workflowAction(action: string, stage?: string, arg?: string): Promise<void>;
  user(): string;
}

type Node = { kind: 'problem'; model: WorkflowModel } | { kind: 'stage'; stage: StageModel; model: WorkflowModel } | { kind: 'task'; label: string; done?: boolean } | { kind: 'empty'; label: string };

export class WorkflowTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  public readonly onDidChangeTreeData = this.changed.event;
  private model: WorkflowModel | undefined;
  private error: string | undefined;

  public constructor(private readonly host: WorkflowViewHost) {}

  public refresh(): WorkflowModel | undefined {
    const scope = this.host.scope();
    this.error = undefined;
    try { this.model = scope ? buildWorkflowModel(scope) : undefined; } catch (err) { this.model = undefined; this.error = err instanceof Error ? err.message : String(err); }
    this.changed.fire(undefined);
    return this.model;
  }

  public getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'empty') { const t = new vscode.TreeItem(n.label); t.iconPath = new vscode.ThemeIcon('info'); return t; }
    if (n.kind === 'task') { const t = new vscode.TreeItem(n.label); t.iconPath = new vscode.ThemeIcon(n.done ? 'check' : 'circle-small'); return t; }
    if (n.kind === 'problem') {
      const m = n.model;
      const t = new vscode.TreeItem(m.problemId, vscode.TreeItemCollapsibleState.Expanded);
      t.description = `${m.template} · ${m.progress.done}/${m.progress.total}${m.approved ? '' : ' · not approved'}`;
      t.tooltip = new vscode.MarkdownString([`**${m.problemId}** — ${m.statement || 'no statement yet'}`, '', ...m.provenance.map((x) => `- ${x}`)].join('\n'));
      t.iconPath = new vscode.ThemeIcon('project');
      t.command = { command: 'autoDataEngineeringHub.openWorkflow', title: 'Open workflow' };
      t.contextValue = 'workflowProblem';
      return t;
    }
    const s = n.stage;
    const t = new vscode.TreeItem(s.title, s.tasks.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    t.description = s.status === 'done' || s.status === 'skipped' ? `${s.status}${s.why ? ` — ${s.why}` : ''}` : s.guide;
    t.iconPath = new vscode.ThemeIcon(STATUS_ICON[s.status] ?? 'circle-outline', s.status === 'stale' ? new vscode.ThemeColor('problemsWarningIcon.foreground') : s.status === 'done' ? new vscode.ThemeColor('testing.iconPassed') : undefined);
    t.tooltip = new vscode.MarkdownString([
      `**${s.title}** (${s.kind}, ${s.inclusion}${s.origin === 'added' ? ', added' : ''})`, '',
      `Status: ${s.status}${s.why ? ` — ${s.why}` : ''}`,
      `Next: ${s.guide}`,
      s.runner ? `Run agent: ${s.runner}` : '',
      s.role ? `Role: ${s.role}${s.tier ? ` · tier ${s.tier}` : ''} (ceiling ${s.ceiling})` : '',
      s.after.length ? `After: ${s.after.join(', ')}` : '',
      s.approvedBy ? `Approved by ${s.approvedBy}${s.approvedVia ? ` via ${s.approvedVia}` : ''}${s.approvedAt ? ` on ${s.approvedAt.slice(0, 16).replace('T', ' ')}` : ''}` : ''
    ].filter(Boolean).join('\n\n'));
    t.contextValue = ['workflowStage', ...s.actions].join(' ');
    t.command = { command: 'autoDataEngineeringHub.openWorkflow', title: 'Open workflow', arguments: [s.id] };
    return t;
  }

  public getChildren(n?: Node): Node[] {
    if (!n) {
      if (this.error) return [{ kind: 'empty', label: this.error }];
      if (!this.model) return [{ kind: 'empty', label: 'Start or open a business problem to see its workflow.' }];
      return [{ kind: 'problem', model: this.model }];
    }
    if (n.kind === 'problem') return n.model.stages.map((s) => ({ kind: 'stage', stage: s, model: n.model }));
    if (n.kind === 'stage') return n.stage.tasks.map((t) => ({ kind: 'task', label: t.title, done: t.done }));
    return [];
  }
}

export class WorkflowPanel {
  private static current: WorkflowPanel | undefined;
  private selected: string | undefined;

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly context: vscode.ExtensionContext, private readonly host: WorkflowViewHost, private readonly onChange: () => void) {
    panel.onDidDispose(() => { WorkflowPanel.current = undefined; });
    panel.webview.onDidReceiveMessage((m: { type: string; stage?: string; decisionId?: string; template?: string; action?: string; file?: string }) => void this.onMessage(m));
  }

  public static show(context: vscode.ExtensionContext, host: WorkflowViewHost, onChange: () => void, stage?: string): void {
    if (!WorkflowPanel.current) {
      const panel = vscode.window.createWebviewPanel('autodeWorkflow', 'AutoDE Workflow', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] });
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'autode-icon-64.png');
      const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const html = fs.readFileSync(path.join(context.extensionUri.fsPath, 'media', 'workflow.html'), 'utf8').replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, panel.webview.cspSource);
      panel.webview.html = html;
      WorkflowPanel.current = new WorkflowPanel(panel, context, host, onChange);
    }
    if (stage) WorkflowPanel.current.selected = stage;
    WorkflowPanel.current.panel.reveal();
    WorkflowPanel.current.post();
  }

  public static refresh(): void { WorkflowPanel.current?.post(); }

  private post(): void {
    const scope = this.host.scope();
    if (!scope) { void this.panel.webview.postMessage({ type: 'model', model: null }); return; }
    let model: WorkflowModel;
    try { model = buildWorkflowModel(scope); } catch (err) { void this.panel.webview.postMessage({ type: 'model', model: null, error: err instanceof Error ? err.message : String(err) }); return; }
    const details = Object.fromEntries(model.stages.map((s) => {
      const d = stageDetail(scope, s.id);
      return [s.id, d ? { ...d, history: d.history.map((e) => ({ ...e, who: actorLabel(e.actor) })), decision: d.decision ? { ...d.decision, events: d.decision.events } : undefined } : undefined];
    }));
    void this.panel.webview.postMessage({ type: 'model', model, details, selected: this.selected ?? model.next?.id ?? model.stages[0]?.id });
  }

  private async onMessage(m: { type: string; stage?: string; decisionId?: string; template?: string; action?: string; file?: string }): Promise<void> {
    const scope = this.host.scope();
    try {
      switch (m.type) {
        case 'ready': this.post(); return;
        case 'select': this.selected = m.stage; return;
        case 'approve': case 'reject': {
          if (!m.decisionId) return;
          const verb = m.type === 'approve' ? 'Approve' : 'Reject';
          const ok = await vscode.window.showWarningMessage(`${verb} this as ${this.host.user()}?`, { modal: true, detail: 'You are approving as a person in VS Code (the panel channel). It is recorded with your name in the decision and the workflow history.' }, verb);
          if (ok !== verb) return;
          await this.host.resolve(m.decisionId, m.type === 'approve' ? 'approved' : 'rejected');
          break;
        }
        case 'run': case 'approve-document': case 'produce': case 'open-document': await this.host.workflowAction(m.type, m.stage); break;
        case 'hand-in': case 'approve-again': await this.host.workflowAction('complete', m.stage); break;
        case 'skip': await this.host.workflowAction('skip', m.stage); break;
        case 'reopen': await this.host.workflowAction('reopen', m.stage); break;
        case 'propose': await this.host.workflowAction('propose', undefined, m.template); break;
        case 'openDecision': if (scope && m.decisionId) await vscode.window.showTextDocument(vscode.Uri.file(path.join(layoutPath(scope.workspaceRoot, 'decisions'), `${m.decisionId}.yaml`))); return;
        case 'openFile': if (scope && m.file) await vscode.window.showTextDocument(vscode.Uri.file(path.resolve(scope.workspaceRoot, m.file))); return;
        case 'openRunbook': if (m.file) await vscode.commands.executeCommand('autoDataEngineeringHub.openRunbook', m.file); return;
        case 'openHistory': if (scope) await vscode.window.showTextDocument(vscode.Uri.file(path.join(layoutPath(scope.workspaceRoot, 'problems', scope.problemId), 'workflow-events.jsonl'))); return;
      }
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
    this.onChange();
  }
}

/** Registers the tree, the editor tab, the status-bar item, the watchers and the commands; returns what to dispose. */
export function registerWorkflowView(context: vscode.ExtensionContext, host: WorkflowViewHost): vscode.Disposable[] {
  const tree = new WorkflowTreeProvider(host);
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.command = 'autoDataEngineeringHub.openWorkflow';
  let timer: NodeJS.Timeout | undefined;
  const refreshNow = () => {
    // Never throws: this runs from timers and file watchers.
    try {
      const m = tree.refresh();
      if (m) { bar.text = `$(checklist) ${statusBarText(m)}`; bar.tooltip = m.provenance.join('\n') || 'AutoDE workflow'; bar.show(); } else bar.hide();
      WorkflowPanel.refresh();
    } catch (err) { console.warn('AutoDE: workflow view refresh failed', err); }
  };
  const refresh = () => { if (timer) clearTimeout(timer); timer = setTimeout(refreshNow, 300); };
  const disposables: vscode.Disposable[] = [bar, vscode.window.registerTreeDataProvider('autoDataEngineeringHubWorkflow', tree)];
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (root) {
    for (const glob of ['.autode/problems/**/*.{yaml,yml,jsonl}', '.autode/decisions/*.yaml', '.autode/local/active-problem.json', '.autode/knowledge/estate.yaml']) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, glob));
      w.onDidChange(refresh); w.onDidCreate(refresh); w.onDidDelete(refresh);
      disposables.push(w);
    }
  }
  const act = (action: string) => async (n?: { stage?: StageModel }) => {
    const id = n?.stage?.id;
    if (!id) return;
    if (action === 'approve') { if (n?.stage?.decisionId) { WorkflowPanel.show(context, host, refresh, id); } return; }
    await host.workflowAction(action === 'hand-in' || action === 'approve-again' ? 'complete' : action, id);
    refresh();
  };
  disposables.push(
    vscode.commands.registerCommand('autoDataEngineeringHub.openWorkflow', (stage?: string) => WorkflowPanel.show(context, host, refresh, typeof stage === 'string' ? stage : undefined)),
    vscode.commands.registerCommand('autoDataEngineeringHub.refreshWorkflow', refreshNow),
    vscode.commands.registerCommand('autoDataEngineeringHub.workflowRun', act('run')),
    vscode.commands.registerCommand('autoDataEngineeringHub.workflowApproveDocument', act('approve-document')),
    vscode.commands.registerCommand('autoDataEngineeringHub.workflowProduce', act('produce')),
    vscode.commands.registerCommand('autoDataEngineeringHub.workflowOpenDocument', act('open-document')),
    vscode.commands.registerCommand('autoDataEngineeringHub.workflowHandIn', act('hand-in')),
    vscode.commands.registerCommand('autoDataEngineeringHub.workflowApproveAgain', act('approve-again')),
    vscode.commands.registerCommand('autoDataEngineeringHub.workflowSkip', act('skip')),
    vscode.commands.registerCommand('autoDataEngineeringHub.workflowReopen', act('reopen')),
    vscode.commands.registerCommand('autoDataEngineeringHub.workflowApprove', act('approve'))
  );
  setTimeout(refreshNow, 1500);
  return disposables;
}
