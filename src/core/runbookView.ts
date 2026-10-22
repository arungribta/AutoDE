import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkflowScope } from '../engine/workflows/service';
import { layoutPath } from '../engine/workspaceLayout';
import { loadConnectionsConfig } from '../engine/platform/connectionsConfig';
import { loadRunbookPolicy } from '../engine/runner/policy';
import { approveRunbook, readRunbook, runLogFile } from '../engine/runner/runbook';
import { runRemaining, runStep } from '../engine/runner/run';
import { createRunnerHost } from '../mcp/runnerHost';
import { buildRunbookModel, listRunbookItems } from './runbookViewModel';

/**
 * The Runbook tab (v0.45.6): the wizard for platform changes. A person reviews
 * each step as the engine classified it, approves (as the panel channel),
 * dry-runs, runs a step at a time — or the rest at once where the team's
 * policy allows — and rolls back. Every click is confirmed for anything that
 * changes the platform, and every action lands in the runbook's log.
 */

export interface RunbookViewHost {
  scope(): WorkflowScope | undefined;
  user(): string;
  /** Resolves a decision as the person in the panel (and applies it). */
  resolve(id: string, decision: 'approved' | 'rejected', note?: string): Promise<void>;
  allowCli(): boolean;
  driversRoot(): string | undefined;
  log(line: string): void;
  onChange(): void;
}

type Msg = { type: string; step?: string };

export class RunbookPanel {
  private static readonly open = new Map<string, RunbookPanel>();
  private busy = false;

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly id: string, private readonly host: RunbookViewHost) {
    panel.onDidDispose(() => RunbookPanel.open.delete(id));
    panel.webview.onDidReceiveMessage((m: Msg) => void this.onMessage(m));
  }

  public static show(context: vscode.ExtensionContext, host: RunbookViewHost, id: string): void {
    let p = RunbookPanel.open.get(id);
    if (!p) {
      const panel = vscode.window.createWebviewPanel('autodeRunbook', `Runbook: ${id}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] });
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'autode-icon-64.png');
      const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
      panel.webview.html = fs.readFileSync(path.join(context.extensionUri.fsPath, 'media', 'runbook.html'), 'utf8').replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{cspSource\}\}/g, panel.webview.cspSource);
      p = new RunbookPanel(panel, id, host);
      RunbookPanel.open.set(id, p);
    }
    p.panel.reveal();
    p.post();
  }

  public static refreshAll(): void { for (const p of RunbookPanel.open.values()) p.post(); }

  private ctx() {
    const scope = this.host.scope();
    if (!scope) return undefined;
    const problemRoot = layoutPath(scope.workspaceRoot, 'problems', scope.problemId);
    return { scope, problemRoot, connections: loadConnectionsConfig(scope.workspaceRoot).connections, policy: loadRunbookPolicy(scope.workspaceRoot) };
  }

  private post(note?: { ok: boolean; text: string; output?: string }): void {
    const c = this.ctx();
    const model = c ? buildRunbookModel({ workspaceRoot: c.scope.workspaceRoot, problemRoot: c.problemRoot, problemId: c.scope.problemId, id: this.id, connections: c.connections, policy: c.policy }) : undefined;
    void this.panel.webview.postMessage({ type: 'model', model: model ?? null, note, busy: this.busy, user: this.host.user() });
  }

  private async confirm(title: string, detail: string, action: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(title, { modal: true, detail }, action)) === action;
  }

  private async onMessage(m: Msg): Promise<void> {
    if (m.type === 'ready') { this.post(); return; }
    const c = this.ctx();
    if (!c || this.busy) return;
    const model = buildRunbookModel({ workspaceRoot: c.scope.workspaceRoot, problemRoot: c.problemRoot, problemId: c.scope.problemId, id: this.id, connections: c.connections, policy: c.policy });
    if (!model) return;
    const who = this.host.user();
    try {
      if (m.type === 'approve' || m.type === 'reject') {
        const verb = m.type === 'approve' ? 'Approve' : 'Reject';
        const changes = model.steps.filter((s) => s.class !== 'read');
        if (!(await this.confirm(`${verb} runbook ${model.id} for ${model.environment.name} as ${who}?`, `${model.steps.length} step(s) on ${model.connectionId}: ${changes.length} change the platform${model.steps.some((s) => s.class === 'destructive') ? ', including destructive ones' : ''}. Your approval is recorded with your name (the panel channel) and binds to this exact content.`, verb))) return;
        if (model.pendingDecisionId) await this.host.resolve(model.pendingDecisionId, m.type === 'approve' ? 'approved' : 'rejected');
        else if (m.type === 'approve') {
          const record = readRunbook(c.problemRoot, this.id)!;
          const r = approveRunbook(c.problemRoot, record, who, 'panel', c.policy);
          if (!r.record) { void vscode.window.showErrorMessage(r.problem ?? 'Not approved.'); return; }
        }
        this.post(); this.host.onChange(); return;
      }
      if (m.type === 'openLog') { await vscode.window.showTextDocument(vscode.Uri.file(runLogFile(c.problemRoot, this.id))); return; }
      const step = model.steps.find((s) => s.id === m.step);
      if (m.type === 'runStep' && step && step.class !== 'read' && !(await this.confirm(`Run ${step.id} on ${model.connectionId} (${model.environment.name})?`, `${step.class === 'destructive' ? 'DESTRUCTIVE. ' : ''}${step.title}\n\nRuns: ${step.runs}\n\nExpected: ${step.expect}${step.rollback ? `\n\nRollback: ${step.rollback}` : ''}`, 'Run'))) return;
      if (m.type === 'runRemaining' && !(await this.confirm(`Run the remaining steps of ${model.id} on ${model.connectionId} (${model.environment.name})?`, `${model.steps.filter((s) => s.state !== 'done').map((s) => `${s.id} [${s.class}] ${s.title}`).join('\n')}\n\nIt stops at the first failure.`, 'Run all'))) return;
      if (m.type === 'rollback' && step && !(await this.confirm(`Roll back ${step.id}?`, `Runs: ${step.rollback ?? 'nothing'}`, 'Roll back'))) return;
      this.busy = true; this.post();
      const { host, dispose } = createRunnerHost({ workspaceRoot: c.scope.workspaceRoot, allowCli: this.host.allowCli(), driversRoot: this.host.driversRoot(), log: this.host.log });
      try {
        const base = { workspaceRoot: c.scope.workspaceRoot, problemRoot: c.problemRoot, runbookId: this.id, who, channel: 'panel', host, connections: c.connections, policy: c.policy };
        const r = m.type === 'runRemaining' ? await runRemaining(base)
          : await runStep({ ...base, action: m.type === 'dryRun' ? 'dry-run' : m.type === 'rollback' ? 'rollback' : 'run', stepId: m.step });
        this.host.log(`Runbook ${this.id}: ${r.message}`);
        this.busy = false;
        this.post({ ok: r.ok, text: r.message, output: r.output });
        this.host.onChange();
      } finally { dispose(); this.busy = false; }
    } catch (err) {
      this.busy = false;
      this.post({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** The command that opens a runbook: by id, or picked from the problem's runbooks. */
export function registerRunbookView(context: vscode.ExtensionContext, host: RunbookViewHost): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('autoDataEngineeringHub.openRunbook', async (id?: unknown) => {
      const scope = host.scope();
      if (!scope) { void vscode.window.showInformationMessage('Start or open a business problem first.'); return; }
      let pick = typeof id === 'string' ? id : undefined;
      if (!pick) {
        const items = listRunbookItems(scope.workspaceRoot, layoutPath(scope.workspaceRoot, 'problems', scope.problemId), scope.problemId);
        if (!items.length) { void vscode.window.showInformationMessage('This problem has no runbooks yet. An agent proposes them (deploy and platform-setup stages); a person approves them here.'); return; }
        const q = await vscode.window.showQuickPick(items.map((i) => ({ label: i.id, description: `${i.status}${i.environment ? ` · ${i.environment}` : ''}`, detail: i.title })), { title: 'Open a runbook' });
        pick = q?.label;
      }
      if (pick) RunbookPanel.show(context, host, pick);
    })
  ];
}
