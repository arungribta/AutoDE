import type * as vscodeTypes from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `AutoDE: Configure MCP for Claude Code` (docs/mcp-engine-requirements.md
 * §9.2, PA2): writes the project's `.mcp.json` entry for the AutoDE server.
 * It prefers the installed `autode mcp`, whose path doesn't change with
 * extension updates, and falls back to the extension's own dist/autode.js.
 * The VS Code API is passed in so tests can supply their own.
 */

type VsCode = typeof vscodeTypes;

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpEntryChoice {
  entry: McpServerEntry;
  /** `installed`: `autode` on PATH. `extension`: this extension's bundle, whose folder changes with every update. */
  source: 'installed' | 'extension';
  note: string;
}

/** The `autode` executable on PATH, if any (no process is spawned). */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try { if (fs.statSync(file).isFile()) return file; } catch { /* next */ }
    }
  }
  return undefined;
}

/** What `.mcp.json` should run: the installed `autode mcp`, else node (or VS Code's runtime) on the extension's bundle. */
export function chooseMcpEntry(options: { extensionPath: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; execPath?: string }): McpEntryChoice {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const serverArgs = ['mcp', '--workspace', '.'];
  if (findOnPath('autode', env, platform)) {
    // Native Windows clients can't start an npm .cmd shim directly.
    const entry = platform === 'win32' ? { command: 'cmd', args: ['/c', 'autode', ...serverArgs] } : { command: 'autode', args: serverArgs };
    return { entry, source: 'installed', note: 'Uses the installed autode command, so the entry keeps working after extension updates.' };
  }
  const bundle = path.join(options.extensionPath, 'dist', 'autode.js');
  const why = 'autode is not installed (npm install -g autode-<version>.tgz, see docs/cli.md), so this points at the extension\'s own copy, whose folder changes with every update; run the command again after updating, or install autode.';
  if (findOnPath('node', env, platform)) return { entry: { command: 'node', args: [bundle, ...serverArgs] }, source: 'extension', note: why };
  return { entry: { command: options.execPath ?? process.execPath, args: [bundle, ...serverArgs], env: { ELECTRON_RUN_AS_NODE: '1' } }, source: 'extension', note: `${why} Node.js isn't on PATH either, so VS Code's own runtime runs it.` };
}

/** The `.mcp.json` text with the `autode` server set to `entry`; other servers and keys are kept. */
export function mergeMcpJson(existing: string | undefined, entry: McpServerEntry): { text: string; changed: boolean; previous?: McpServerEntry } {
  let doc: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim()) {
    const parsed: unknown = JSON.parse(existing);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('.mcp.json is not a JSON object.');
    doc = parsed as Record<string, unknown>;
  }
  const servers = (doc.mcpServers && typeof doc.mcpServers === 'object' && !Array.isArray(doc.mcpServers) ? doc.mcpServers : {}) as Record<string, unknown>;
  const previous = servers.autode as McpServerEntry | undefined;
  const next = { ...doc, mcpServers: { ...servers, autode: entry } };
  const text = JSON.stringify(next, null, 2) + '\n';
  return { text, changed: JSON.stringify(previous) !== JSON.stringify(entry), previous };
}

/** An `autode` entry that runs a bundle from an installed extension folder other than this one (left behind by an update). */
export function isStaleExtensionEntry(entry: McpServerEntry | undefined, extensionPath: string): boolean {
  if (!entry || !Array.isArray(entry.args)) return false;
  const norm = (p: string) => path.resolve(p).toLowerCase();
  const own = norm(extensionPath);
  return entry.args.some((a) => typeof a === 'string' && /auto-data-engineering-hub-\d/i.test(a) && /(mcp-server|autode)\.js$/i.test(a) && !norm(a).startsWith(own + path.sep.toLowerCase()) && norm(a) !== own);
}

export function readMcpJson(workspaceRoot: string): { text?: string; autode?: McpServerEntry } {
  try {
    const text = fs.readFileSync(path.join(workspaceRoot, '.mcp.json'), 'utf8');
    const doc = JSON.parse(text) as { mcpServers?: Record<string, McpServerEntry> };
    return { text, autode: doc.mcpServers?.autode };
  } catch {
    return {};
  }
}

export async function configureMcpForClaudeCode(vscode: VsCode, options: { workspaceRoot: string | undefined; extensionPath: string; log: (line: string) => void }): Promise<void> {
  if (!options.workspaceRoot) { void vscode.window.showWarningMessage('Open a folder first: .mcp.json is written to the project root.'); return; }
  const file = path.join(options.workspaceRoot, '.mcp.json');
  const choice = chooseMcpEntry({ extensionPath: options.extensionPath });
  let merged: ReturnType<typeof mergeMcpJson>;
  try {
    merged = mergeMcpJson(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined, choice.entry);
  } catch (err) {
    void vscode.window.showErrorMessage(`.mcp.json can't be read (${err instanceof Error ? err.message : String(err)}); fix or remove it, then run the command again.`);
    return;
  }
  if (!merged.changed) { void vscode.window.showInformationMessage(`.mcp.json already runs the AutoDE server: ${[choice.entry.command, ...choice.entry.args].join(' ')}`); return; }
  const commandLine = [choice.entry.command, ...choice.entry.args].join(' ');
  const pick = await vscode.window.showInformationMessage(
    `${merged.previous ? 'Update' : 'Add'} the AutoDE MCP server in .mcp.json?`,
    { modal: true, detail: `${commandLine}\n\n${choice.note}\n\nOther servers in the file are kept. Claude Code asks you to approve project servers the first time it starts.` },
    'Write .mcp.json'
  );
  if (pick !== 'Write .mcp.json') return;
  fs.writeFileSync(file, merged.text);
  options.log(`.mcp.json: autode → ${commandLine} (${choice.source === 'installed' ? 'installed autode' : 'extension bundle'}).`);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
}

/** At activation: a one-time hint when `.mcp.json` still points at an older extension folder. Never writes. */
export function hintStaleMcpJson(vscode: VsCode, options: { workspaceRoot: string | undefined; extensionPath: string; commandId: string }): void {
  if (!options.workspaceRoot) return;
  const { autode } = readMcpJson(options.workspaceRoot);
  if (!isStaleExtensionEntry(autode, options.extensionPath)) return;
  void vscode.window.showInformationMessage('.mcp.json runs the AutoDE MCP server from an older extension version.', 'Update .mcp.json').then((c) => {
    if (c) void vscode.commands.executeCommand(options.commandId);
  });
}
