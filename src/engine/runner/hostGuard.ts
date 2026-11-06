import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifySql } from './runbook';

/**
 * The host guard (v0.45.11, mcp-engine §9.2 PA3 §8b): the AutoDE plugin's
 * hook in agent hosts that have hooks (Claude Code; Cortex Code reads the same
 * plugin layout). Before the host runs a shell command for its agent, the guard
 * finds every `snow` and `databricks` invocation in it and blocks the ones that
 * change a platform: those go into a runbook, which a person approves and
 * AutoDE's runner runs. Reads (listing, describing, validating, read-only
 * `snow sql`) pass, as does anything that only touches the local CLI setup.
 *
 * The guard also protects the approval record: an agent's file-writing tools
 * (Write, Edit, MultiEdit, NotebookEdit) are refused on `.autode/decisions/` and
 * `.autode/config/platform-approvals.json`, and so is a shell command that names
 * those paths with an obvious write (a redirect, `tee`, `sed -i`, `cp`, `mv`,
 * `rm`, Set-Content, Out-File and the like). Approving is a person's act.
 *
 * A guard against an agent's mistakes, not a sandbox: a command it can't read
 * (a script, an alias, a `snow sql` file it can't open) is blocked rather than
 * guessed, and a command that doesn't name the CLI (a Python script calling the
 * connector) is outside what it sees. The same holds for the protected paths: a
 * script, or a path built at run time, gets past it. The engine does not rely
 * on it alone (the MCP server never applies a high-stakes file resolution, and a
 * proposal changed after its decision was created is never applied). Hosts
 * without hooks keep this as a convention, stated in the skills.
 */

export interface GuardedCommand { argv: string[]; class: 'read' | 'local' | 'change'; why: string }
export interface GuardVerdict { block: boolean; commands: GuardedCommand[]; reason?: string }

/** Words, honouring quotes; `&&`, `||`, `;`, `|`, `&` and newlines become separator tokens. */
export function shellWords(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  const flush = () => { if (has) out.push(cur); cur = ''; has = false; };
  while (i < command.length) {
    const c = command[i];
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      const stop = end < 0 ? command.length : end;
      cur += command.slice(i + 1, stop); has = true; i = stop + 1; continue;
    }
    // A backslash escapes a quote, a space, a backslash or `$`; before anything else it is a Windows path separator.
    if (c === '\\' && i + 1 < command.length && /["' \\$`]/.test(command[i + 1])) { cur += command[i + 1]; has = true; i += 2; continue; }
    if (/\s/.test(c) && c !== '\n') { flush(); i++; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '$(') { flush(); out.push(';'); i += 2; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '`' || c === '(' || c === ')') { flush(); out.push(';'); i++; continue; }
    cur += c; has = true; i++;
  }
  flush();
  return out;
}

/** Wrappers that run the next word as the command. */
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup', 'npx', 'uvx', 'pipx', 'call']);
/** Flags of the two CLIs that take a value (so the value isn't read as a subcommand). */
const VALUE_FLAGS = new Set(['-c', '--connection', '-p', '--profile', '-o', '--output', '--format', '-t', '--target', '--var', '--log-level', '--log-file', '--config-file', '--account', '--user', '--role', '--warehouse', '--database', '--schema', '--host', '--temporary-connection', '--query', '-q', '--filename', '-f', '--key', '--json', '-e', '--environment']);
/** Subcommand words that only read. */
const READ_VERBS = new Set(['list', 'ls', 'get', 'describe', 'show', 'status', 'cat', 'test', 'list-files', 'list-pipelines', 'validate', 'summary', 'me', 'export', 'logs', 'events', 'version', 'help', 'get-permissions', 'get-permission-levels', 'list-runs', 'get-run', 'get-run-output', 'list-versions', 'diff']);
/** Groups that touch only the local CLI setup or scaffold local files. */
const LOCAL: Record<'snow' | 'databricks', Set<string>> = {
  snow: new Set(['connection', 'init', 'helpers', '--version', '--help', '--info', 'help']),
  databricks: new Set(['auth', 'configure', 'version', 'completion', 'help', '--version', '--help'])
};

function cliOf(word: string): 'snow' | 'databricks' | undefined {
  const base = word.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  return base === 'snow' || base === 'databricks' ? base : undefined;
}

function valueOf(args: readonly string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n) return args[i + 1];
      if (args[i].startsWith(`${n}=`)) return args[i].slice(n.length + 1);
    }
  }
  return undefined;
}

function classifySnowSql(args: readonly string[], cwd: string): GuardedCommand['class'] | string {
  const query = valueOf(args, ['-q', '--query']);
  let text = query;
  if (text === undefined) {
    const file = valueOf(args, ['-f', '--filename']);
    if (!file) return 'snow sql without --query or --filename reads statements from the terminal, which the guard can\'t see';
    try { text = fs.readFileSync(path.resolve(cwd, file), 'utf8'); } catch { return `${file} can't be read, so its statements can't be checked`; }
  }
  const statements = text.split(';').map((x) => x.trim()).filter((x) => x && !/^--[^\n]*$/.test(x));
  for (const st of statements) {
    const c = classifySql(st);
    if (!c.class) return `a statement couldn't be read (${c.problem})`;
    if (c.class !== 'read') return 'change';
  }
  return 'read';
}

function classifyCli(cli: 'snow' | 'databricks', args: readonly string[], cwd: string): GuardedCommand {
  const argv = [cli, ...args];
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) { if (VALUE_FLAGS.has(a) && !a.includes('=')) i++; if (words.length === 0 && LOCAL[cli].has(a)) words.push(a); continue; }
    words.push(a.toLowerCase());
  }
  if (!words.length || LOCAL[cli].has(words[0])) return { argv, class: 'local', why: 'local CLI setup' };
  if (args.includes('--help') || args.includes('-h')) return { argv, class: 'local', why: 'help' };
  if (cli === 'snow' && words[0] === 'sql') {
    const c = classifySnowSql(args, cwd);
    return c === 'read' ? { argv, class: 'read', why: 'read-only SQL' } : { argv, class: 'change', why: c === 'change' ? 'the SQL changes the platform' : c };
  }
  if (cli === 'databricks' && words[0] === 'api') return words[1] === 'get' ? { argv, class: 'read', why: 'GET request' } : { argv, class: 'change', why: `an API ${words[1] ?? ''} request` };
  if (cli === 'databricks' && words[0] === 'bundle' && (words[1] === 'init' || words[1] === 'generate')) return { argv, class: 'local', why: 'writes local bundle files' };
  const verb = words.slice(0, 3).find((w) => READ_VERBS.has(w));
  return verb ? { argv, class: 'read', why: verb } : { argv, class: 'change', why: `\`${[cli, ...words.slice(0, 2)].join(' ')}\` changes the platform, or the guard can't tell that it doesn't` };
}

/** A path with forward slashes, lower case and `.`/`..` folded: how protected paths are compared (Windows paths are case-insensitive). */
function normalisePath(p: string): string {
  return path.posix.normalize(p.replace(/\\/g, '/').toLowerCase());
}

const PROTECTED_PATH = /(^|\/)\.autode\/(decisions(\/|$)|config\/platform-approvals\.json$)/;
/** For a command line (not one path): the protected paths anywhere in the text. */
const PROTECTED_IN_TEXT = /\.autode\/(decisions(\/|\b)|config\/platform-approvals\.json)/;
/** Shell words and cmdlets that write, move or delete a file, and the usual ways a script writes one. */
const WRITE_WORDS = /\b(tee|cp|mv|rm|del|erase|rmdir|rd|ln|touch|truncate|dd|install|copy|move|ren|rename|xcopy|robocopy|(set|add|out|clear|remove|copy|move|rename|new)-(content|item|itemproperty|file)|writealltext|writeallbytes|writefile\w*|write_text|write_bytes)\b|\bsed\b[^|;&\n]*\s-[a-z]*i|\bopen\([^)]*,\s*['"][wa+]|\bwrite\(/;

/** Whether a file path is one an agent must not write: a decision file or the platform approvals. */
export function isProtectedPath(file: string): boolean {
  return PROTECTED_PATH.test(normalisePath(file));
}

/** A reason when the shell command names a protected path together with an obvious write; otherwise undefined. */
function protectedWriteReason(command: string): string | undefined {
  const text = command.replace(/\\/g, '/').toLowerCase();
  if (!PROTECTED_IN_TEXT.test(text)) return undefined;
  // `2>/dev/null` and `2>&1` are not writes to a file.
  const bare = text.replace(/\d*>&\d+|\d*>>?\s*\/dev\/null|\d*>>?\s*\$null|\d*>>?\s*nul\b/g, ' ');
  if (!(/>/.test(bare) || WRITE_WORDS.test(bare))) return undefined;
  return PROTECTED_REASON;
}

const PROTECTED_REASON = 'AutoDE blocks writes to its decision files (.autode/decisions/) and to .autode/config/platform-approvals.json: approving is a person\'s act. Propose with the autode_propose_* tools; a person approves in the AutoDE panel, with `autode decisions approve <id>`, or by editing the decision file themselves.';

/** The guard's verdict on one shell command, as the host would run it in `cwd`. */
export function guardShellCommand(command: string, cwd: string, depth = 0): GuardVerdict {
  const protectedReason = depth === 0 ? protectedWriteReason(String(command ?? '')) : undefined;
  const words = shellWords(String(command ?? ''));
  const commands: GuardedCommand[] = [];
  let seg: string[] = [];
  const segments: string[][] = [];
  for (const w of words) { if (w === ';') { if (seg.length) segments.push(seg); seg = []; } else seg.push(w); }
  if (seg.length) segments.push(seg);
  for (const s of segments) {
    let i = 0;
    while (i < s.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s[i]) || WRAPPERS.has(s[i].toLowerCase()) || s[i] === '&' || s[i] === '.')) i++;
    const head = s[i];
    if (!head) continue;
    // `bash -c "…"`, `sh -c`, `pwsh -Command`: check the inner command too.
    if (depth < 3 && /^(ba|z|)sh$|^pwsh$|^powershell(\.exe)?$|^cmd(\.exe)?$/i.test(head)) {
      const k = s.findIndex((x, j) => j > i && /^(-c|-command|\/c)$/i.test(x));
      if (k > 0 && s[k + 1]) commands.push(...guardShellCommand(s.slice(k + 1).join(' '), cwd, depth + 1).commands);
      continue;
    }
    const cli = cliOf(head);
    if (cli) commands.push(classifyCli(cli, s.slice(i + 1), cwd));
  }
  const blocked = commands.filter((c) => c.class === 'change');
  if (!blocked.length && !protectedReason) return { block: false, commands };
  const platformReason = blocked.length
    ? `AutoDE blocks platform-changing commands outside its runner: ${blocked.map((c) => `\`${c.argv.slice(0, 4).join(' ')}\` (${c.why})`).join('; ')}. `
      + 'Put the change in a runbook instead (autode_propose_runbook): a person approves it, and AutoDE\'s runner runs it with dry runs, rollback and a log. Reads (list, describe, validate, read-only SQL) are allowed.'
    : undefined;
  return { block: true, commands, reason: [platformReason, protectedReason].filter(Boolean).join(' ') };
}

/** Tools that write a file, by the hosts' names; the path is in `file_path` (`notebook_path` for notebooks). */
const FILE_WRITE_TOOLS = /^(write|edit|multiedit|notebookedit)$/i;

/** The verdict on a host's PreToolUse event (Claude Code's JSON on stdin): shell tools, and file-writing tools on protected paths. */
export function guardHookEvent(event: unknown, fallbackCwd: string): GuardVerdict {
  const e = (event && typeof event === 'object' ? event : {}) as { tool_name?: unknown; tool_input?: { command?: unknown; file_path?: unknown; notebook_path?: unknown }; cwd?: unknown };
  const tool = String(e.tool_name ?? '');
  if (FILE_WRITE_TOOLS.test(tool)) {
    const files = [e.tool_input?.file_path, e.tool_input?.notebook_path].filter((x): x is string => typeof x === 'string');
    return files.some(isProtectedPath) ? { block: true, commands: [], reason: PROTECTED_REASON } : { block: false, commands: [] };
  }
  const command = e.tool_input?.command;
  if (!/^(bash|powershell|shell|run_shell_command|terminal)$/i.test(tool) || typeof command !== 'string') return { block: false, commands: [] };
  return guardShellCommand(command, typeof e.cwd === 'string' ? e.cwd : fallbackCwd);
}
