import * as vscode from 'vscode';
import * as os from 'node:os';
import { CatalogEntry, CatalogGroup, probeInstaller, skillCatalog } from '../engine/agents/skillCatalog';

/**
 * The Skills view (v0.45.5): every skill AutoDE has or works with, in one
 * place — AutoDE's own, this workspace's imported ones, the interview packs,
 * and the vendor and community skills (references only, with their licence
 * and whether they are installed). Installing an external skill probes the
 * vendor's command first and runs it only after the person confirms, in the
 * visible "AutoDE" terminal, as for drivers.
 */

type Node = { kind: 'group'; group: CatalogGroup; entries: CatalogEntry[] } | { kind: 'skill'; entry: CatalogEntry } | { kind: 'note'; label: string };

const GROUP_TITLE: Record<CatalogGroup, string> = { autode: 'AutoDE skills', workspace: 'Imported in this workspace', interview: 'Interview packs', external: 'External skills (references)' };

export class SkillsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  public readonly onDidChangeTreeData = this.changed.event;
  private entries: CatalogEntry[] = [];
  private errors: string[] = [];

  public constructor(private readonly resourcesRoot: string, private readonly workspaceRoot: () => string | undefined) {}

  public refresh(): void {
    const root = this.workspaceRoot();
    try {
      const r = skillCatalog({ resourcesRoot: this.resourcesRoot, workspaceRoot: root ?? this.resourcesRoot, home: process.env.AUTODE_HOME ?? os.homedir() });
      this.entries = root ? r.entries : r.entries.filter((e) => e.group !== 'workspace');
      this.errors = r.errors;
    } catch (err) { this.entries = []; this.errors = [err instanceof Error ? err.message : String(err)]; }
    this.changed.fire(undefined);
  }

  public entry(name: string): CatalogEntry | undefined { return this.entries.find((e) => e.name === name); }

  public getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'note') { const t = new vscode.TreeItem(n.label); t.iconPath = new vscode.ThemeIcon('warning'); return t; }
    if (n.kind === 'group') {
      const t = new vscode.TreeItem(GROUP_TITLE[n.group], n.group === 'autode' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      t.description = String(n.entries.length);
      t.contextValue = `skillsGroup ${n.group}`;
      return t;
    }
    const e = n.entry;
    const t = new vscode.TreeItem(e.name);
    if (e.group === 'external') {
      const found = (e.installed ?? []).length > 0;
      t.description = `${e.owner ?? ''} · ${e.availability === 'installable' ? (found ? 'installed' : 'not installed') : e.availability === 'host-only' ? (found ? 'available' : 'inside its host only') : 'importable (check licence)'}`;
      t.iconPath = new vscode.ThemeIcon(found ? 'pass' : e.availability === 'installable' ? 'cloud-download' : 'link-external');
    } else {
      t.description = [e.stageKinds.join(', '), e.platforms.length && !e.platforms.includes('any') ? e.platforms.join(', ') : '', e.maturity, e.status].filter(Boolean).join(' · ');
      t.iconPath = new vscode.ThemeIcon(e.group === 'workspace' ? 'package' : e.group === 'interview' ? 'comment-discussion' : 'symbol-method');
    }
    t.tooltip = new vscode.MarkdownString([
      `**${e.name}**${e.owner ? ` — ${e.owner}` : ''}`, '', e.summary,
      e.stageKinds.length ? `Stage kinds: ${e.stageKinds.join(', ')}` : '', e.platforms.length ? `Platforms: ${e.platforms.join(', ')}` : '',
      e.roles?.length ? `Used by: ${e.roles.join(', ')}` : '', e.version !== undefined ? `Version ${e.version}${e.maturity ? ` (${e.maturity})` : ''}` : '',
      e.licence ? `Licence: ${e.licence.name}. ${e.licence.summary ?? ''}` : '', e.installed?.length ? `Found: ${e.installed.join(', ')}` : '',
      e.installer ? `Install: \`${e.installer.command.join(' ')}\` (last verified ${e.installer.verifiedAt ?? '—'})` : ''
    ].filter(Boolean).join('\n\n'));
    t.contextValue = ['skill', e.group, e.installer && !(e.installed ?? []).length ? 'installable' : '', e.source ? 'hasSource' : ''].filter(Boolean).join(' ');
    return t;
  }

  public getChildren(n?: Node): Node[] {
    if (!n) {
      const groups = (['autode', 'workspace', 'interview', 'external'] as CatalogGroup[]).map((g) => ({ kind: 'group' as const, group: g, entries: this.entries.filter((e) => e.group === g) })).filter((g) => g.entries.length);
      return [...this.errors.map((label) => ({ kind: 'note' as const, label })), ...groups];
    }
    if (n.kind === 'group') return n.entries.map((entry) => ({ kind: 'skill' as const, entry }));
    return [];
  }
}

const quote = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

export function registerSkillsView(context: vscode.ExtensionContext, workspaceRoot: () => string | undefined): vscode.Disposable[] {
  const tree = new SkillsTreeProvider(context.extensionPath, workspaceRoot);
  tree.refresh();
  const nameOf = (n?: { entry?: CatalogEntry }) => n?.entry?.name;
  return [
    vscode.window.registerTreeDataProvider('autoDataEngineeringHubSkills', tree),
    vscode.commands.registerCommand('autoDataEngineeringHub.refreshSkills', () => tree.refresh()),
    vscode.commands.registerCommand('autoDataEngineeringHub.openSkillSource', async (n?: { entry?: CatalogEntry }) => {
      const e = n?.entry;
      // An imported skill's source can be a local folder (PA4): reveal it instead.
      if (e?.source) {
        if (/^https?:\/\//.test(e.source)) await vscode.env.openExternal(vscode.Uri.parse(e.source));
        else await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(e.source));
      }
    }),
    vscode.commands.registerCommand('autoDataEngineeringHub.installSkill', async (n?: { entry?: CatalogEntry }) => {
      const e = tree.entry(nameOf(n) ?? '');
      if (!e?.installer) return;
      const probe = probeInstaller(e.installer);
      if (!probe.ok) {
        const pick = await vscode.window.showWarningMessage(probe.reason, ...(e.installer.docs ? ['Open vendor docs'] : []));
        if (pick && e.installer.docs) await vscode.env.openExternal(vscode.Uri.parse(e.installer.docs));
        return;
      }
      const command = e.installer.command.map(quote).join(' ');
      const detail = [
        `Runs the vendor's own command in a terminal named "AutoDE":`, command, '',
        e.licence ? `Licence: ${e.licence.name}. ${e.licence.summary ?? ''}` : '',
        `AutoDE last verified this command on ${e.installer.verifiedAt ?? '—'}; it was probed on this machine just now (${probe.reason}).`,
        ...Object.entries(e.installer.hostAlternatives ?? {}).map(([h, t]) => `Or, in ${h}: ${t}`)
      ].filter(Boolean).join('\n');
      const pick = await vscode.window.showInformationMessage(`Install ${e.installer.title ?? e.name}?`, { modal: true, detail }, 'Run in AutoDE terminal', 'Copy command');
      if (pick === 'Copy command') { await vscode.env.clipboard.writeText(command); return; }
      if (pick !== 'Run in AutoDE terminal') return;
      const terminal = vscode.window.terminals.find((t) => t.name === 'AutoDE') ?? vscode.window.createTerminal({ name: 'AutoDE', cwd: workspaceRoot() });
      terminal.show();
      terminal.sendText(command, true);
      const next = await vscode.window.showInformationMessage('When the install has finished in the AutoDE terminal, check that the skills were found.', 'Check');
      if (next === 'Check') {
        tree.refresh();
        const after = tree.entry(e.name);
        void vscode.window.showInformationMessage((after?.installed ?? []).length ? `${e.name} is installed: ${after!.installed!.join(', ')}.` : `${e.name} wasn't found in a host's skills folder yet. Check the terminal's output.`);
      }
    })
  ];
}
