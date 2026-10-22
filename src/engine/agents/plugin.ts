import * as fs from 'node:fs';
import * as path from 'node:path';
import { PackSkill, RoleTemplate, loadRoles, loadSkillPack } from './definitions';

/**
 * AutoDE for agent hosts (PA3b): the role templates and skills, rendered in
 * each host's own format, with the MCP server wired in. One source
 * (`agents/`, `skills/`); `autode plugin path` builds the plugin folder that
 * Claude Code and Cortex Code load, and `autode plugin install` copies the
 * same files into a host's project or user folders (the Copilot CLI's agents
 * only this way: its `*.agent.md` files would be read twice by Claude Code in
 * one folder).
 *
 * Folders, as the hosts document them (checked 2026-10-21):
 * - Claude Code: `.claude/{agents,skills,commands}`, `~/.claude/…`; MCP in the project's `.mcp.json`, or `claude mcp add --scope user`.
 * - Cortex Code: skills in `.cortex/skills` or `~/.snowflake/cortex/skills`; MCP in `~/.snowflake/cortex/mcp.json` (no project file); sub-agents come from plugins.
 * - Copilot CLI: `.github/agents/*.agent.md`, `.github/skills`, `~/.copilot/{agents,skills}`; MCP added with `/mcp add`.
 * Where a host has no documented file for something, AutoDE prints the step instead of guessing a file.
 */

export type PluginHost = 'claude' | 'cortex' | 'copilot';
export const PLUGIN_HOSTS: readonly PluginHost[] = ['claude', 'cortex', 'copilot'];

export interface ServerEntry { command: string; args: string[] }

/** Engine tools as each host names them. */
const CLAUDE_MCP = (t: string) => `mcp__autode__${t}`;
const COPILOT_MCP = (t: string) => `autode/${t}`;

function onPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  return dirs.some((d) => exts.some((e) => { try { return fs.statSync(path.join(d, name + e)).isFile(); } catch { return false; } }));
}

/** `autode mcp` when it is installed; otherwise node on this package's own bundle. */
export function serverEntry(resourcesRoot: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ServerEntry {
  const args = ['mcp', '--workspace', '.'];
  if (onPath('autode', env, platform)) return platform === 'win32' ? { command: 'cmd', args: ['/c', 'autode', ...args] } : { command: 'autode', args };
  return { command: 'node', args: [path.join(resourcesRoot, 'dist', 'autode.js'), ...args] };
}

const yamlList = (xs: readonly string[]) => `[${xs.map((x) => JSON.stringify(x)).join(', ')}]`;

function roleBody(r: RoleTemplate, skills: readonly PackSkill[]): string {
  const own = skills.filter((k) => r.skills.includes(k.id));
  return [
    r.instructions.trim(),
    '## How you get work',
    'AutoDE\'s workflow assigns your work: the `autode-orchestrator` skill gives you an assignment from `autode_workflow_next` (its stage, brief, permission tier and the AutoDE tools you may call, in `assignment.text`). Follow it; record each deliverable with `autode_record_artifact`; then reply with a short summary. Never start another agent, hand stages in or approve anything.',
    own.length ? `Skills: ${own.map((k) => `\`${k.id}\` (${k.description})`).join('; ')}.` : ''
  ].filter(Boolean).join('\n\n') + '\n';
}

/** A Claude Code (and Cortex Code) sub-agent file. */
export function claudeAgent(r: RoleTemplate, skills: readonly PackSkill[]): string {
  const tools = ['Read', 'Grep', 'Glob', ...r.tools.map(CLAUDE_MCP)];
  return `---\nname: ${r.name}\ndescription: ${JSON.stringify(r.description)}\ntools: ${tools.join(', ')}\n---\n${roleBody(r, skills)}`;
}

/** A GitHub Copilot custom agent (`*.agent.md`). */
export function copilotAgent(r: RoleTemplate, skills: readonly PackSkill[]): string {
  const tools = ['read', 'search', ...r.tools.map(COPILOT_MCP)];
  return `---\nname: ${r.name}\ndescription: ${JSON.stringify(r.description)}\ntools: ${yamlList(tools)}\n---\n${roleBody(r, skills)}`;
}

/** Slash commands (Claude Code). Approving stays a person's act: the command says how, it never approves. */
export const COMMANDS: Record<string, string> = {
  'autode-status': '---\ndescription: Show the AutoDE workflow of the active business problem\n---\nCall `autode_workflow_status` and show each stage with its state, then what comes next and who (or what approval) it waits for. Use `autode_workflow_history` if the user asks who did what.\n',
  'autode-next': '---\ndescription: Do the next stage of the AutoDE workflow\n---\nUse the `autode-orchestrator` skill: take the next assignment from `autode_workflow_next`, have the named AutoDE agent do it, and hand the stage in. Stop at anything that needs a person\'s approval and tell the user how to give it.\n',
  'autode-approve': '---\ndescription: What waits for approval in AutoDE, and how to approve it\n---\nCall `autode_workflow_status` and `autode_list_decisions` (status pending). For each item that waits, tell the user what it is and how to approve it: `autode workflow approve [<stage>]` or `autode decisions approve <id>` in their own terminal, the AutoDE panel in VS Code, or the decision file under `.autode/decisions/`. You never approve it yourself.\n'
};

function write(file: string, text: string, written: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  written.push(file);
}

function copyDir(from: string, to: string, written: string[]): void {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b, written);
    else { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(a, b); written.push(b); }
  }
}

function definitions(resourcesRoot: string, workspaceRoot?: string): { roles: RoleTemplate[]; skills: PackSkill[]; errors: string[] } {
  const r = loadRoles(resourcesRoot, workspaceRoot);
  const s = loadSkillPack(resourcesRoot);
  return { roles: r.roles, skills: s.skills, errors: [...r.errors, ...s.errors] };
}

/** The plugin folder (Claude Code's layout, which Cortex Code also reads). Replaces `outDir`. */
export function buildPlugin(input: { resourcesRoot: string; outDir: string; version: string; entry: ServerEntry }): { dir: string; files: string[]; errors: string[] } {
  const { roles, skills, errors } = definitions(input.resourcesRoot);
  fs.rmSync(input.outDir, { recursive: true, force: true });
  const files: string[] = [];
  const manifest = { name: 'autode', version: input.version, description: 'AutoDE: data-engineering workflows (greenfield, modernization, estate merge) with grounded, approved deliverables. Your host supplies the model; AutoDE\'s MCP server supplies the engine.', author: { name: 'AutoDE' } };
  write(path.join(input.outDir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n', files);
  write(path.join(input.outDir, '.mcp.json'), JSON.stringify({ mcpServers: { autode: input.entry } }, null, 2) + '\n', files);
  for (const r of roles) write(path.join(input.outDir, 'agents', `${r.name}.md`), claudeAgent(r, skills), files);
  for (const k of skills) copyDir(k.dir, path.join(input.outDir, 'skills', k.id), files);
  for (const [name, text] of Object.entries(COMMANDS)) write(path.join(input.outDir, 'commands', `${name}.md`), text, files);
  return { dir: input.outDir, files, errors };
}

export interface InstallResult { written: string[]; mcp: { file?: string; changed?: boolean; instruction?: string }; errors: string[]; notes: string[] }

/** The `.mcp.json`-style text with the `autode` server set; other servers and keys are kept. */
export function mergeServers(existing: string | undefined, entry: ServerEntry): { text: string; changed: boolean } {
  let doc: Record<string, unknown> = {};
  if (existing?.trim()) {
    const parsed: unknown = JSON.parse(existing);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the MCP configuration is not a JSON object.');
    doc = parsed as Record<string, unknown>;
  }
  const servers = (doc.mcpServers && typeof doc.mcpServers === 'object' && !Array.isArray(doc.mcpServers) ? doc.mcpServers : {}) as Record<string, unknown>;
  const changed = JSON.stringify(servers.autode) !== JSON.stringify(entry);
  return { text: JSON.stringify({ ...doc, mcpServers: { ...servers, autode: entry } }, null, 2) + '\n', changed };
}

const shellLine = (e: ServerEntry) => [e.command, ...e.args].map((a) => /\s/.test(a) ? JSON.stringify(a) : a).join(' ');

/** Copies the agents, skills and commands into the host's folders and wires the server where the host has a documented file. */
export function installPlugin(input: { host: PluginHost; scope: 'project' | 'user'; resourcesRoot: string; workspaceRoot: string; home: string; entry: ServerEntry }): InstallResult {
  const { roles, skills, errors } = definitions(input.resourcesRoot, input.workspaceRoot);
  const written: string[] = [];
  const notes: string[] = [];
  const base = input.scope === 'project' ? input.workspaceRoot : input.home;
  let mcp: InstallResult['mcp'];
  if (input.host === 'claude') {
    const dir = path.join(base, '.claude');
    for (const r of roles) write(path.join(dir, 'agents', `${r.name}.md`), claudeAgent(r, skills), written);
    for (const k of skills) copyDir(k.dir, path.join(dir, 'skills', k.id), written);
    for (const [name, text] of Object.entries(COMMANDS)) write(path.join(dir, 'commands', `${name}.md`), text, written);
    if (input.scope === 'project') {
      const file = path.join(input.workspaceRoot, '.mcp.json');
      const m = mergeServers(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined, input.entry);
      if (m.changed) write(file, m.text, written);
      mcp = { file, changed: m.changed };
    } else mcp = { instruction: `claude mcp add --scope user autode -- ${shellLine(input.entry)}` };
  } else if (input.host === 'cortex') {
    const dir = input.scope === 'project' ? path.join(base, '.cortex', 'skills') : path.join(input.home, '.snowflake', 'cortex', 'skills');
    for (const k of skills) copyDir(k.dir, path.join(dir, k.id), written);
    notes.push('Cortex Code takes sub-agents from plugins: for AutoDE\'s agents as sub-agents, install the plugin folder (`autode plugin path`). Without it, the orchestrator skill follows each assignment itself.');
    mcp = { instruction: `Add AutoDE's server to ${path.join(input.home, '.snowflake', 'cortex', 'mcp.json')} under "mcpServers": ${JSON.stringify({ autode: input.entry })}` };
  } else {
    const dir = input.scope === 'project' ? path.join(base, '.github') : path.join(input.home, '.copilot');
    for (const r of roles) write(path.join(dir, 'agents', `${r.name}.agent.md`), copilotAgent(r, skills), written);
    for (const k of skills) copyDir(k.dir, path.join(dir, 'skills', k.id), written);
    mcp = { instruction: `In the Copilot CLI: /mcp add — name autode, type local, command: ${shellLine(input.entry)}` };
  }
  return { written, mcp, errors, notes };
}
