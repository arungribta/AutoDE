import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { accessRunbook, capabilityMatrix, conformanceRun, lintSkillText, operationPage, platformPage, skillPage } from '../engine/platform/operations/catalogView';
import { checksumOf, loadCatalog, operationById, platformById } from '../engine/platform/operations/load';
import { OperationEdit, checkOperationEdit, operationForm, saveOperationEdit } from '../engine/platform/operations/form';
import { SkillFrontmatterEdit, customiseSkill, keepTeamCopy, resetSkill, setSkillFrontmatter, teamCopy } from '../engine/skills/customise';
import { installPlugin, pluginStatus, serverEntry } from '../engine/agents/plugin';
import { DecisionStore } from '../engine/decisions/decisionStore';
import { ProposalValidationError, propose } from '../engine/decisions/proposals';
import { activeProblemId } from '../engine/documents/problems';
import { layoutPath } from '../engine/workspaceLayout';
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
  /** Who acts, for the skills' lifecycle and decisions. */
  actor(): string;
}

type Message =
  | { type: 'ready' } | { type: 'matrix' }
  | { type: 'platform'; id: string } | { type: 'operation'; id: string } | { type: 'skill'; id: string }
  | { type: 'conformance'; connection: string } | { type: 'preview'; operation: string; platform: string; params: Record<string, string> }
  | { type: 'try'; operation: string; connection: string; params: Record<string, string> }
  | { type: 'openFile'; file: string } | { type: 'customise'; id: string } | { type: 'openTab'; tab: string }
  | { type: 'skillAction'; id: string; action: 'customise' | 'edit' | 'review' | 'publish' | 'keep' | 'reset' }
  | { type: 'checkMeta' | 'saveMeta'; id: string; edit: SkillFrontmatterEdit }
  | { type: 'operationForm' | 'proposeOperation'; id: string } | { type: 'checkOperation' | 'saveOperation'; id: string; edit: OperationEdit }
  | { type: 'requestAccess'; connection: string; role?: string; schemas: string[]; capabilities: string[] };

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

  private workspace(): { resourcesRoot: string; workspaceRoot: string } {
    const root = this.host.workspaceRoot();
    if (!root) throw new Error('Open a workspace folder first.');
    return { resourcesRoot: this.resourcesRoot, workspaceRoot: root };
  }

  /** POP4b: Customise, edit, review, publish, keep and reset a skill; each a person's click (reset and keep confirmed). */
  private async skillAction(id: string, action: 'customise' | 'edit' | 'review' | 'publish' | 'keep' | 'reset'): Promise<void> {
    const ws = this.workspace();
    const open = async (file: string) => { await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false }); };
    if (action === 'customise') {
      const r = customiseSkill(ws, id, this.host.actor());
      await open(path.join(r.dir, 'SKILL.md'));
      this.post({ type: 'notice', text: `${r.created ? 'Made' : 'Opened'} the team copy of ${id} (a draft). Edit it here: the editor checks as you type. AutoDE's stays in effect until a person reviews and publishes the copy.` });
    } else if (action === 'edit') {
      const file = skillPage(ws, id)?.meta?.file;
      if (file) await open(file);
    } else if (action === 'review') {
      await vscode.commands.executeCommand('autoDataEngineeringHub.reviewToolSkill', id);
    } else if (action === 'publish') {
      await vscode.commands.executeCommand('autoDataEngineeringHub.publishToolSkill', id);
    } else if (action === 'keep') {
      const c = teamCopy(ws, id);
      const ok = await vscode.window.showWarningMessage(`Keep the team copy of ${id}? AutoDE's v${c?.autodeVersion ?? '?'} becomes what it is compared with; merge anything you want from it first.`, { modal: true, detail: c?.autodeChanges.map((x) => `${x.path} ${x.change}`).join('\n') }, 'Keep');
      if (ok !== 'Keep') return;
      keepTeamCopy(ws, id, this.host.actor());
    } else {
      const c = teamCopy(ws, id);
      const ok = await vscode.window.showWarningMessage(`Reset ${id} to AutoDE's? The team copy (v${c?.state.sidecar.version ?? '?'}) is removed and archived under .autode/local/reset-skills/.`, { modal: true }, 'Reset');
      if (ok !== 'Reset') return;
      resetSkill(ws, id);
    }
    await this.onMessage({ type: 'skill', id });
    if (action === 'publish' || action === 'reset') await this.offerPluginUpdate();
  }

  /** After the skills in effect change: say when a host's installed skills are behind, and offer the install. */
  private async offerPluginUpdate(): Promise<void> {
    const ws = this.workspace();
    const s = pluginStatus({ ...ws, home: os.homedir() });
    if (!s.behind) return;
    const claude = s.folders.find((f) => f.behind.length && f.host === 'claude' && f.scope === 'project');
    const pick = await vscode.window.showInformationMessage(s.summary, ...(claude ? ['Update Claude Code (project)'] : []));
    if (pick) {
      const r = installPlugin({ host: 'claude', scope: 'project', resourcesRoot: this.resourcesRoot, workspaceRoot: ws.workspaceRoot, home: os.homedir(), entry: serverEntry(this.resourcesRoot) });
      vscode.window.showInformationMessage(r.errors.length ? `Installed with problems: ${r.errors.join(' ')}` : `Claude Code now has the skills in effect (${r.written.length} files).`);
    }
  }

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
        case 'skillAction': await this.skillAction(m.id, m.action); return;
        case 'checkMeta': case 'saveMeta': {
          const file = skillPage(this.scope(), m.id)?.meta?.file;
          if (!file) { this.post({ type: 'notice', text: `${m.id} has no editable copy: customise it first.`, error: true }); return; }
          const text = setSkillFrontmatter(fs.readFileSync(file, 'utf8'), m.edit);
          const findings = lintSkillText(text, m.id, loadCatalog(this.scope()));
          if (m.type === 'checkMeta' || findings.some((f) => f.severity === 'error')) { this.post({ type: 'metaChecks', findings }); return; }
          fs.writeFileSync(file, text);
          this.post({ type: 'notice', text: `Saved ${m.id}'s metadata. ${teamCopy(this.workspace(), m.id) ? 'The copy changed, so it waits for a review and publish before it is in effect.' : 'Review and publish it to use it.'}` });
          await this.onMessage({ type: 'skill', id: m.id });
          return;
        }
        case 'operationForm': this.post({ type: 'operationForm', form: operationForm(this.workspace(), m.id) }); return;
        case 'checkOperation': this.post({ type: 'opChecks', problems: checkOperationEdit(this.workspace(), m.id, m.edit) }); return;
        case 'saveOperation': {
          const r = saveOperationEdit(this.workspace(), m.id, m.edit);
          this.post({ type: 'opChecks', ...r });
          return;
        }
        case 'proposeOperation': {
          const ws = this.workspace();
          const full = layoutPath(ws.workspaceRoot, 'platformOperations', `${m.id}.yaml`);
          if (!fs.existsSync(full)) { this.post({ type: 'opChecks', problems: ['Save the form first: there is no team draft of this operation yet.'] }); return; }
          const file = path.relative(ws.workspaceRoot, full).split(path.sep).join('/');
          const d = propose(new DecisionStore(ws.workspaceRoot), { workspaceRoot: ws.workspaceRoot, resourcesRoot: this.resourcesRoot }, 'platform_operation', { file, checksum: checksumOf(fs.readFileSync(full, 'utf8')) }, { proposedBy: { host: 'vscode', client: this.host.actor() } });
          this.post({ type: 'notice', text: `Proposed ${file} as ${d.id}. A person approves it in Decisions; until then it is a draft and never runs.` });
          return;
        }
        case 'requestAccess': {
          const ws = this.workspace();
          let draft: ReturnType<typeof accessRunbook>;
          try { draft = accessRunbook(ws, { connection: m.connection, role: m.role || undefined, schemas: m.schemas, capabilities: m.capabilities }); }
          catch (err) { this.post({ type: 'access', error: err instanceof Error ? err.message : String(err) }); return; }
          const problemId = activeProblemId(ws.workspaceRoot);
          if (!problemId) { this.post({ type: 'access', ...draft, next: 'No active problem: a runbook is proposed within a problem. Start or select one and draft it again, or give these steps to whoever administers the platform.' }); return; }
          try {
            const d = propose(new DecisionStore(ws.workspaceRoot), { workspaceRoot: ws.workspaceRoot, problemRoot: layoutPath(ws.workspaceRoot, 'problems', problemId), problemId, connections: loadConnectionsConfig(ws.workspaceRoot).connections, resourcesRoot: this.resourcesRoot }, 'runbook', draft.runbook, { proposedBy: { host: 'vscode', client: this.host.actor() } });
            this.post({ type: 'access', ...draft, next: `Proposed as ${d.id} in ${problemId}. A person who administers the platform approves it in Decisions, then runs it in AutoDE's runner.` });
          } catch (err) {
            this.post({ type: 'access', error: err instanceof ProposalValidationError ? `The runbook did not pass its checks: ${err.report.errors.join('; ')}` : err instanceof Error ? err.message : String(err) });
          }
          return;
        }
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
