import type * as vscodeTypes from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConnectionEntry, loadConnectionsConfig, standInEnv } from '../engine/platform/connectionsConfig';

/**
 * How other agents reach the AutoDE server from VS Code (docs/mcp-engine-
 * requirements.md §7.5; PA2, phase 5):
 * - `AutoDE: Configure MCP for Claude Code` writes the project's `.mcp.json`
 *   entry. It prefers the installed `autode mcp`; otherwise it uses a copy of
 *   the server in the extension's global storage, which AutoDE refreshes when
 *   the extension updates, so the entry survives updates either way.
 * - VS Code's own agent mode (Copilot) gets the server through the MCP server
 *   definition provider API, with the secrets of `resolver: vscode`
 *   connections added only when VS Code starts it.
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
  /** `installed`: `autode` on PATH. `stable`: AutoDE's copy in global storage, kept current. `extension`: this extension's bundle, whose folder changes with every update. */
  source: 'installed' | 'stable' | 'extension';
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
export function chooseMcpEntry(options: { extensionPath: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; execPath?: string; stableBundle?: string }): McpEntryChoice {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const serverArgs = ['mcp', '--workspace', '.'];
  if (findOnPath('autode', env, platform)) {
    // Native Windows clients can't start an npm .cmd shim directly.
    const entry = platform === 'win32' ? { command: 'cmd', args: ['/c', 'autode', ...serverArgs] } : { command: 'autode', args: serverArgs };
    return { entry, source: 'installed', note: 'Uses the installed autode command, so the entry keeps working after extension updates.' };
  }
  const bundle = options.stableBundle ?? path.join(options.extensionPath, 'dist', 'autode.js');
  const source = options.stableBundle ? 'stable' : 'extension';
  const why = options.stableBundle
    ? 'autode is not installed, so this runs AutoDE\'s own copy of the server in VS Code\'s global storage, which AutoDE refreshes when the extension updates.'
    : 'autode is not installed (npm install -g autode-<version>.tgz, see docs/cli.md), so this points at the extension\'s own copy, whose folder changes with every update; run the command again after updating, or install autode.';
  if (findOnPath('node', env, platform)) return { entry: { command: 'node', args: [bundle, ...serverArgs] }, source, note: why };
  return { entry: { command: options.execPath ?? process.execPath, args: [bundle, ...serverArgs], env: { ELECTRON_RUN_AS_NODE: '1' } }, source, note: `${why} Node.js isn't on PATH, so VS Code's own runtime runs it.` };
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

export async function configureMcpForClaudeCode(vscode: VsCode, options: { workspaceRoot: string | undefined; extensionPath: string; storagePath: string | undefined; version: string; log: (line: string) => void }): Promise<void> {
  if (!options.workspaceRoot) { void vscode.window.showWarningMessage('Open a folder first: .mcp.json is written to the project root.'); return; }
  const file = path.join(options.workspaceRoot, '.mcp.json');
  let stableBundle: string | undefined;
  if (options.storagePath && !findOnPath('autode')) {
    try { stableBundle = ensureStableServer(options.extensionPath, options.storagePath, options.version); } catch (err) { options.log(`Could not copy the server to global storage (${err instanceof Error ? err.message : String(err)}); using the extension's own copy.`); }
  }
  const choice = chooseMcpEntry({ extensionPath: options.extensionPath, stableBundle });
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
  options.log(`.mcp.json: autode → ${commandLine} (${choice.source === 'installed' ? 'installed autode' : choice.source === 'stable' ? 'AutoDE\'s copy in global storage' : 'extension bundle'}).`);
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

// ── The stable copy (phase 5, §7.5) ──────────────────────────────────────────

/** What the server needs next to it, relative to the extension root; the same as the `autode` package (scripts/pack-cli.cjs). */
export const SERVER_FILES: readonly string[] = ['dist/autode.js', 'dist/mcp-server.js', 'dist/THIRD-PARTY-NOTICES.md', 'skills', 'primitive-definitions', 'workflows', 'media/autode-icon-64.png', 'LICENSE'];

export function stableServerDir(storagePath: string): string {
  return path.join(storagePath, 'autode-server');
}

function copyInto(from: string, to: string): void {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from)) copyInto(path.join(from, e), path.join(to, e));
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

/**
 * Copies the server into global storage when that copy is missing or from another
 * version; returns its `dist/autode.js`. The copy carries a `package.json` named
 * `autode`, so the server finds its bundled resources there.
 */
export function ensureStableServer(extensionPath: string, storagePath: string, version: string): string {
  const dir = stableServerDir(storagePath);
  const bundle = path.join(dir, 'dist', 'autode.js');
  if (stableServerVersion(storagePath) === version && fs.existsSync(bundle)) return bundle;
  const staging = `${dir}.${process.pid}.tmp`;
  fs.rmSync(staging, { recursive: true, force: true });
  for (const rel of SERVER_FILES) {
    const from = path.join(extensionPath, ...rel.split('/'));
    if (!fs.existsSync(from)) continue;
    if (rel === 'skills') {
      for (const f of fs.readdirSync(from).filter((x) => x.endsWith('.json'))) copyInto(path.join(from, f), path.join(staging, 'skills', f));
      continue;
    }
    copyInto(from, path.join(staging, ...rel.split('/')));
  }
  if (!fs.existsSync(path.join(staging, 'dist', 'autode.js'))) { fs.rmSync(staging, { recursive: true, force: true }); throw new Error(`no server bundle in ${extensionPath}`); }
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: 'autode', version, private: true, description: 'AutoDE MCP server, copied here by the AutoDE extension so MCP client configurations survive extension updates.' }, null, 2) + '\n');
  // Swap in one step, so a client starting meanwhile sees the old copy or the new one.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
  return bundle;
}

export function stableServerVersion(storagePath: string): string | undefined {
  try { return (JSON.parse(fs.readFileSync(path.join(stableServerDir(storagePath), 'package.json'), 'utf8')) as { version?: string }).version; } catch { return undefined; }
}

/** At activation: refresh an existing stable copy left by an older version (never creates one). Returns whether it copied. */
export function refreshStableServer(extensionPath: string, storagePath: string, version: string): boolean {
  const current = stableServerVersion(storagePath);
  if (current === undefined || current === version) return false;
  ensureStableServer(extensionPath, storagePath, version);
  return true;
}

// ── VS Code agent mode (phase 5, §7.5) ───────────────────────────────────────

export const MCP_PROVIDER_ID = 'autode';

/** Whether this VS Code has the MCP server definition provider API (1.101+). */
export function supportsMcpProvider(vscode: VsCode): boolean {
  const lm = (vscode as unknown as { lm?: { registerMcpServerDefinitionProvider?: unknown } }).lm;
  return typeof lm?.registerMcpServerDefinitionProvider === 'function' && typeof (vscode as unknown as { McpStdioServerDefinition?: unknown }).McpStdioServerDefinition === 'function';
}

/**
 * Registers the AutoDE server with VS Code's agent mode: VS Code's own runtime
 * runs the extension's bundle, so neither Node nor a configuration file is
 * needed. `secretEnv` runs only when VS Code starts the server, so secrets are
 * never part of the listed definition. On an older VS Code this does nothing.
 */
export function registerMcpProvider(vscode: VsCode, options: { extensionPath: string; version: string; workspaceRoot: () => string | undefined; secretEnv: () => Promise<Record<string, string>>; log: (line: string) => void }): vscodeTypes.Disposable | undefined {
  if (!supportsMcpProvider(vscode)) { options.log('This VS Code has no MCP server provider API (1.101+); AutoDE\'s tools reach agent mode through .vscode/mcp.json instead.'); return undefined; }
  const changed = new vscode.EventEmitter<void>();
  const provider: vscodeTypes.McpServerDefinitionProvider<vscodeTypes.McpStdioServerDefinition> = {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => {
      const root = options.workspaceRoot();
      if (!root) return [];
      const def = new vscode.McpStdioServerDefinition('AutoDE', process.execPath, [path.join(options.extensionPath, 'dist', 'autode.js'), 'mcp', '--workspace', root], { ELECTRON_RUN_AS_NODE: '1' }, options.version);
      def.cwd = vscode.Uri.file(root);
      return [def];
    },
    resolveMcpServerDefinition: async (server) => {
      try {
        const env = await options.secretEnv();
        server.env = { ...server.env, ...env };
        if (Object.keys(env).length) options.log(`AutoDE MCP server for agent mode: secrets of ${Object.keys(env).length} VS Code–stored credential field(s) passed to it.`);
      } catch (err) {
        options.log(`AutoDE MCP server for agent mode starts without VS Code–stored secrets: ${err instanceof Error ? err.message : String(err)}`);
      }
      return server;
    }
  };
  const registration = vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, provider);
  const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire());
  return { dispose: () => { registration.dispose(); folders.dispose(); changed.dispose(); } };
}

/**
 * The stand-in `AUTODE_*` variables for every `resolver: vscode` connection of the
 * workspace, from VS Code's secret storage (phase 5) — for a server VS Code starts.
 */
export async function vscodeSecretEnv(workspaceRoot: string | undefined, resolve: (entry: ConnectionEntry) => Promise<Record<string, string> | undefined>): Promise<Record<string, string>> {
  if (!workspaceRoot) return {};
  const env: Record<string, string> = {};
  for (const entry of loadConnectionsConfig(workspaceRoot).connections.filter((c) => c.credentials.resolver === 'vscode')) {
    const secrets = await resolve(entry);
    if (secrets) Object.assign(env, standInEnv(entry, secrets));
  }
  return env;
}
