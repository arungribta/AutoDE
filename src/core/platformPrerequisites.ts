import type * as vscodeTypes from 'vscode';
import * as fs from 'node:fs';
import { DRIVERS, DriverId, driverStatus, driversRoot, installCommand, verifyDriver } from '../engine/platform/driverStore';
import { Prerequisite, checkPrerequisites, detectNpm } from '../engine/platform/prerequisites';

/**
 * The extension's side of moderated driver installation (docs/mcp-engine-
 * requirements.md §9.1 Phase DRV1): commands that show what each platform
 * needs, run an install command in a visible "AutoDE" terminal **only when the
 * user clicks**, and verify the result. Nothing here runs at activation; the
 * VS Code API is passed in so tests can supply their own.
 */

type VsCode = typeof vscodeTypes;

export interface PrerequisiteHost {
  /** The `driversDirectory` setting (empty = default). */
  driversDirectory: () => string | undefined;
  snowflakeCliPath: () => string | undefined;
  databricksCliPath: () => string | undefined;
  log: (line: string) => void;
  /** Where `prerequisites.yaml` is, and the workspace whose override applies (v0.45.6). */
  resourcesRoot?: () => string | undefined;
  workspaceRoot?: () => string | undefined;
}

const ICONS: Record<Prerequisite['state'], string> = { ready: '$(check)', missing: '$(circle-slash)', unverified: '$(question)', changed: '$(warning)', unsupported: '$(error)' };

/** The terminal AutoDE runs install commands in: reused while open, so the user sees one history (commands use absolute paths, so its folder doesn't matter). */
function autodeTerminal(vscode: VsCode, cwd: string): vscodeTypes.Terminal {
  return vscode.window.terminals.find((t) => t.name === 'AutoDE') ?? vscode.window.createTerminal({ name: 'AutoDE', cwd });
}

export async function verifyDriverCommand(vscode: VsCode, host: PrerequisiteHost, id: DriverId): Promise<void> {
  const status = verifyDriver(driversRoot(host.driversDirectory()), id);
  host.log(`Driver ${id}: ${status.state} — ${status.detail}`);
  if (status.state === 'ready') {
    await vscode.window.showInformationMessage(`${DRIVERS[id].title} is ready: ${status.detail}`);
  } else if (status.state === 'missing' || status.state === 'unsupported') {
    const pick = await vscode.window.showWarningMessage(status.detail, 'Install');
    if (pick === 'Install') await installDriverCommand(vscode, host, id);
  } else {
    await vscode.window.showErrorMessage(`${DRIVERS[id].title} could not be verified: ${status.detail}`);
  }
}

/**
 * Explains the install (what, where, size, licence, why), then — on the
 * user's click — runs the command in the AutoDE terminal. AutoDE never fetches
 * anything itself: npm does, with the user's own configuration.
 */
export async function installDriverCommand(vscode: VsCode, host: PrerequisiteHost, id: DriverId): Promise<void> {
  const spec = DRIVERS[id];
  const root = driversRoot(host.driversDirectory());
  const current = driverStatus(root, id);
  if (current.state === 'ready') {
    await vscode.window.showInformationMessage(`${spec.title} is already installed and verified (${current.detail})`);
    return;
  }
  const npm = detectNpm();
  if (!npm.found) {
    const pick = await vscode.window.showWarningMessage(`${spec.title} is installed with npm. ${npm.detail}`, { modal: true }, 'Get Node.js', 'Open setting');
    if (pick === 'Get Node.js') await vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/'));
    if (pick === 'Open setting') await vscode.commands.executeCommand('workbench.action.openSettings', 'autoDataEngineeringHub.driversDirectory');
    return;
  }
  const { command, cwd } = installCommand(root, id);
  const detail = [
    spec.why,
    '',
    `Runs, in a terminal named "AutoDE":`,
    command,
    '',
    `Folder: ${cwd}`,
    `Size: ${spec.size}. Licence: ${spec.licence}.`,
    ...spec.notes.map((n) => `• ${n}`)
  ].join('\n');
  const pick = await vscode.window.showInformationMessage(`Install the ${spec.title}?`, { modal: true, detail }, 'Run in AutoDE terminal', 'Copy command');
  if (pick === 'Copy command') {
    await vscode.env.clipboard.writeText(command);
    await vscode.window.showInformationMessage('Command copied. Run it, then use "AutoDE: Verify Oracle Driver".');
    return;
  }
  if (pick !== 'Run in AutoDE terminal') return;
  fs.mkdirSync(cwd, { recursive: true });
  const terminal = autodeTerminal(vscode, cwd);
  terminal.show();
  terminal.sendText(command, true);
  host.log(`Driver ${id}: install command sent to the AutoDE terminal (${command}).`);
  const next = await vscode.window.showInformationMessage(`When npm has finished in the AutoDE terminal, verify the ${spec.title}.`, 'Verify');
  if (next === 'Verify') await verifyDriverCommand(vscode, host, id);
}

/** Every platform's prerequisites, with their state; picking one offers its next step. */
export async function checkPrerequisitesCommand(vscode: VsCode, host: PrerequisiteHost): Promise<void> {
  const list = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AutoDE: checking platform prerequisites…' }, () => checkPrerequisites({
    driversRoot: driversRoot(host.driversDirectory()), snowflakeCliPath: host.snowflakeCliPath(), databricksCliPath: host.databricksCliPath(),
    resourcesRoot: host.resourcesRoot?.(), workspaceRoot: host.workspaceRoot?.()
  }));
  const items = list.map((p) => ({
    label: `${ICONS[p.state]} ${p.title}`,
    description: `${p.platform} · ${p.state}${p.version ? ` · ${p.version}` : ''}${p.required ? '' : ' · optional'}`,
    detail: p.state === 'ready' ? p.detail : `${p.detail} ${p.why}`,
    prerequisite: p
  }));
  const picked = await vscode.window.showQuickPick(items, { title: 'Platform prerequisites', placeHolder: 'Pick one to install, verify or read how to get it', matchOnDescription: true });
  if (!picked) return;
  const p = picked.prerequisite;
  if (p.kind === 'driver') {
    const id = p.platform as DriverId;
    if (p.state === 'missing' || p.state === 'unsupported') await installDriverCommand(vscode, host, id);
    else await verifyDriverCommand(vscode, host, id);
    return;
  }
  if (p.state === 'ready' || !p.install) return;
  // v0.45.6: the options are data (prerequisites.yaml), probed on this machine; one runs only on a click.
  const options = (p.install.options ?? []).filter((o) => o.available);
  const choices = [
    ...options.map((o) => ({ label: `$(terminal) ${o.manager}`, description: o.commands.map((c) => c.join(' ')).join(' && '), detail: o.needs, option: o })),
    ...(p.install.options ?? []).filter((o) => !o.available).map((o) => ({ label: `$(circle-slash) ${o.manager}`, description: o.reason, detail: undefined, option: undefined })),
    ...(p.install.docs ? [{ label: '$(link-external) Open the vendor\'s install guide', description: p.install.docs, detail: p.install.notes.join(' '), option: undefined }] : [])
  ];
  const chosen = await vscode.window.showQuickPick(choices, { title: `Install ${p.title}`, placeHolder: `${p.why}${p.install.verifiedAt ? ` (AutoDE last checked these on ${p.install.verifiedAt})` : ''}` });
  if (!chosen) return;
  if (!chosen.option) { if (p.install.docs && chosen.label.includes('install guide')) await vscode.env.openExternal(vscode.Uri.parse(p.install.docs)); return; }
  const lines = chosen.option.commands.map((c) => c.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' '));
  const ok = await vscode.window.showInformationMessage(`Install ${p.title} with ${chosen.option.manager}?`, { modal: true, detail: [`Runs, in a terminal named "AutoDE":`, ...lines, '', chosen.option.needs ? `Needs: ${chosen.option.needs}.` : '', `From ${p.install.docs ?? 'the vendor'}${p.install.verifiedAt ? `, last checked ${p.install.verifiedAt}` : ''}.`].filter(Boolean).join('\n') }, 'Run in AutoDE terminal');
  if (ok !== 'Run in AutoDE terminal') return;
  const terminal = autodeTerminal(vscode, host.workspaceRoot?.() ?? process.cwd());
  terminal.show();
  for (const l of lines) terminal.sendText(l, true);
  host.log(`${p.title}: install commands sent to the AutoDE terminal (${lines.join('; ')}). Check again when they finish.`);
}
