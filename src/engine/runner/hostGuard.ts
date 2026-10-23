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
 * A guard against an agent's mistakes, not a sandbox: a command it can't read
 * (a script, an alias, a `snow sql` file it can't open) is blocked rather than
 * guessed, and a command that doesn't name the CLI (a Python script calling the
 * connector) is outside what it sees. Hosts without hooks keep this as a
 * convention, stated in the skills.
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

/** The guard's verdict on one shell command, as the host would run it in `cwd`. */
export function guardShellCommand(command: string, cwd: string, depth = 0): GuardVerdict {
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
  if (!blocked.length) return { block: false, commands };
  return {
    block: true, commands,
    reason: `AutoDE blocks platform-changing commands outside its runner: ${blocked.map((c) => `\`${c.argv.slice(0, 4).join(' ')}\` (${c.why})`).join('; ')}. `
      + 'Put the change in a runbook instead (autode_propose_runbook): a person approves it, and AutoDE\'s runner runs it with dry runs, rollback and a log. Reads (list, describe, validate, read-only SQL) are allowed.'
  };
}

/** The verdict on a host's PreToolUse event (Claude Code's JSON on stdin): shell tools only. */
export function guardHookEvent(event: unknown, fallbackCwd: string): GuardVerdict {
  const e = (event && typeof event === 'object' ? event : {}) as { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown };
  const tool = String(e.tool_name ?? '');
  const command = e.tool_input?.command;
  if (!/^(bash|powershell|shell|run_shell_command|terminal)$/i.test(tool) || typeof command !== 'string') return { block: false, commands: [] };
  return guardShellCommand(command, typeof e.cwd === 'string' ? e.cwd : fallbackCwd);
}
