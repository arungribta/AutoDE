import { ClaudeStreamParser } from './claudeStream';
import * as vscode from 'vscode';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Routes AutoDE's LLM calls through the locally-installed **Claude Code** CLI
 * (the `claude` binary that ships with the "Claude Code for VS Code" extension,
 * or a standalone install). Used when `activeLlmProvider === 'claude'`.
 *
 * This is deliberately *not* the VS Code Language Model API — Claude Code does
 * not register a `vscode.lm` provider, and routing through Copilot's Claude
 * models is exactly what we want to avoid here. We shell out to `claude -p`
 * (headless / print mode) and read its JSON result.
 */

export interface ClaudeCodeResolution {
  cliPath?: string;
  /** Where the CLI was found: `setting` | `path` | `extension` | `none`. */
  source: 'setting' | 'path' | 'extension' | 'none';
  version?: string;
  error?: string;
}

export interface ClaudeCodeInfo {
  provider: 'claude';
  found: boolean;
  hasAccess: boolean;
  consentRequired: boolean;
  /** Human-readable note about where the CLI came from. */
  cliSource: string;
  cliPath?: string;
  version?: string;
  models: never[];
  vendors: string[];
  error?: string;
}

const EXTENSION_ID_CANDIDATES = ['Anthropic.claude-code', 'anthropic.claude-code'];
/** AutoDE tool → the Claude Code CLI tools that provide the same capability (v0.28.0 allow-list mapping). */
const CLAUDE_TOOLS_FOR_AUTODE_TOOL: Record<string, string[]> = {
  autode_read_file: ['Read'],
  autode_search_files: ['Grep'],
  autode_list_dir: ['Glob'],
  autode_write_file: ['Edit', 'Write'],
  autode_run_command: ['Bash']
};
const CLAUDE_MODEL_HINT = /^(claude[-\w.]*|sonnet|opus|haiku)([-\w.]*)?$/i;

function binName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

function tryVersion(cliPath: string): string | undefined {
  try {
    const res = spawnSync(cliPath, ['--version'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true
    });
    if (res.status === 0 && typeof res.stdout === 'string' && res.stdout.trim().length > 0) {
      return res.stdout.trim().split(/\r?\n/)[0];
    }
  } catch {
    /* not runnable */
  }
  return undefined;
}

/**
 * Resolve a bare command name to an absolute path via `where` / `which`, so the
 * actual completion `spawn` never needs a shell (safer with a multi-line
 * `--append-system-prompt` argument).
 */
function resolveOnPath(command: string): string | undefined {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const res = spawnSync(finder, [command], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (res.status === 0 && typeof res.stdout === 'string') {
      const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first && fs.existsSync(first)) {
        return first;
      }
    }
  } catch {
    /* not found */
  }
  return undefined;
}

/** Locate the bundled CLI inside the installed Claude Code extension, if any. */
function extensionBinaryPath(): string | undefined {
  for (const id of EXTENSION_ID_CANDIDATES) {
    const ext = vscode.extensions.getExtension(id);
    if (ext?.extensionPath) {
      const candidate = path.join(ext.extensionPath, 'resources', 'native-binary', binName());
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  // Fall back to scanning all extensions (id casing / suffix differences).
  for (const ext of vscode.extensions.all) {
    if (/anthropic\.claude-code/i.test(ext.id) && ext.extensionPath) {
      const candidate = path.join(ext.extensionPath, 'resources', 'native-binary', binName());
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * v0.53.1: ends the CLI and what it started. On Windows `kill()` ends only the CLI's own process, leaving
 * children such as AutoDE's MCP server running; `taskkill /T` ends the tree.
 */
function endProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    if (!r.error && r.status === 0) return;
  }
  child.kill();
}

export class ClaudeCodeAdapter {
  private constructor(private readonly cliPath: string) {}

  /**
   * Resolve the Claude Code CLI: explicit `claudeCodePath` setting → `claude`
   * on `PATH` → the binary bundled with the Claude Code extension.
   */
  public static resolve(claudeCodePath?: string): ClaudeCodeResolution {
    // 1) Explicit setting.
    const configured = (claudeCodePath ?? '').trim();
    if (configured) {
      if (fs.existsSync(configured)) {
        return { cliPath: configured, source: 'setting', version: tryVersion(configured) };
      }
      // A bare command name — resolve it via PATH.
      const abs = resolveOnPath(configured);
      if (abs) {
        return { cliPath: abs, source: 'setting', version: tryVersion(abs) };
      }
      return { source: 'none', error: `claudeCodePath is set to "${configured}" but no runnable CLI was found there.` };
    }

    // 2) On PATH — resolve to an absolute path so the completion spawn needs no shell.
    for (const cmd of [binName(), 'claude']) {
      const abs = resolveOnPath(cmd);
      if (abs) {
        const v = tryVersion(abs);
        if (v) {
          return { cliPath: abs, source: 'path', version: v };
        }
      }
    }

    // 3) Bundled with the Claude Code extension.
    const bundled = extensionBinaryPath();
    if (bundled) {
      return { cliPath: bundled, source: 'extension', version: tryVersion(bundled) };
    }

    return {
      source: 'none',
      error:
        'Claude Code CLI not found. Install the "Claude Code for VS Code" extension (or the standalone CLI), or set the "autoDataEngineeringHub.claudeCodePath" setting to the claude binary.'
    };
  }

  public static async detect(claudeCodePath?: string): Promise<{ info: ClaudeCodeInfo; adapter?: ClaudeCodeAdapter }> {
    const r = ClaudeCodeAdapter.resolve(claudeCodePath);
    const sourceLabel: Record<ClaudeCodeResolution['source'], string> = {
      setting: 'claudeCodePath setting',
      path: 'PATH',
      extension: 'bundled with the Claude Code extension',
      none: 'not found'
    };
    const info: ClaudeCodeInfo = {
      provider: 'claude',
      found: !!r.cliPath,
      hasAccess: !!r.cliPath,
      consentRequired: false,
      cliSource: sourceLabel[r.source],
      cliPath: r.cliPath,
      version: r.version,
      models: [],
      vendors: r.cliPath ? ['claude-code'] : [],
      error: r.error
    };
    if (!r.cliPath) {
      return { info };
    }
    return { info, adapter: new ClaudeCodeAdapter(r.cliPath) };
  }

  /**
   * Run a single headless completion.
   * @param opts.toolMode `'none'` (default) permits no tools and caps the run at 1 turn;
   *   `'read-only'` allows Read/Grep/Glob so Claude Code can inspect the workspace (used by
   *   grounded chat by default); `'full'` (chat's opt-in "allow edits" mode, and Phase D
   *   tool-executing Skills) additionally allows Edit/Write/Bash — Claude Code's own tool loop
   *   still runs (AutoDE doesn't reimplement it), scoped to `opts.cwd`.
   * @param opts.sessionId / opts.isNewSession Claude Code headless (`-p`) sessions persist to
   *   disk and can be resumed — empirically verified: `--session-id <uuid>` on a first call,
   *   then `--resume <uuid>` on a later call in the same `cwd`, correctly recalls prior turns,
   *   served from server-side cache rather than a re-sent transcript. When `sessionId` is set,
   *   this is used instead of AutoDE building its own history text — see `AgentHub.chat`.
   */
  public async complete(
    prompt: string,
    opts?: {
      systemPrompt?: string;
      model?: string;
      toolMode?: 'none' | 'read-only' | 'full';
      timeoutMs?: number;
      cwd?: string;
      sessionId?: string;
      isNewSession?: boolean;
      /** AutoDE tool names this run may use (a skill's `allowed-tools`); narrows the CLI's `--tools` list. */
      allowedTools?: string[];
      /** v0.52.3: AutoDE's MCP server for this run (a temp config file) and the `mcp__autode__…` tools pre-approved. */
      mcp?: { configFile: string; allowedTools: string[] };
      /** v0.52.3: reads streamed events (progress and tool calls) instead of the single final JSON. */
      stream?: ClaudeStreamParser;
      /** v0.52.3: added to the CLI's environment (AUTODE_PANEL_RUN marks AutoDE's own runs for its hooks). */
      env?: Record<string, string>;
      cancellationToken?: vscode.CancellationToken;
    }
  ): Promise<string> {
    const mode = opts?.toolMode ?? 'none';
    // An agent's stage or maintenance run calls AutoDE's tools many times: more time and more turns than a chat reply.
    const timeoutMs = opts?.timeoutMs ?? (opts?.mcp ? 900000 : mode === 'none' ? 90000 : 180000);
    const args = ['-p', '--output-format', 'json'];

    // v0.52.4: the instructions go in a file, never on the command line. An agent's assignment (role, skills, brief)
    // runs to tens of thousands of characters, past Windows' 32,767-character command-line limit (spawn ENAMETOOLONG).
    let promptFile: string | undefined;
    if (opts?.systemPrompt && opts.systemPrompt.trim().length > 0) {
      promptFile = path.join(os.tmpdir(), `autode-prompt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
      fs.writeFileSync(promptFile, opts.systemPrompt.trim(), 'utf8');
      args.push('--append-system-prompt-file', promptFile);
    }

    const model = (opts?.model ?? '').trim();
    if (model && CLAUDE_MODEL_HINT.test(model)) {
      args.push('--model', model);
    }

    if (opts?.sessionId) {
      args.push(opts.isNewSession ? '--session-id' : '--resume', opts.sessionId);
    }

    const narrow = (cliTools: string[]): string[] => {
      if (!opts?.allowedTools) return cliTools;
      const permitted = new Set(opts.allowedTools.flatMap((t) => CLAUDE_TOOLS_FOR_AUTODE_TOOL[t] ?? []));
      return cliTools.filter((t) => permitted.has(t));
    };
    const fullTools = narrow(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);
    const readTools = narrow(['Read', 'Grep', 'Glob']);

    if (mode === 'full' && fullTools.some((t) => t === 'Edit' || t === 'Write' || t === 'Bash')) {
      // 'default' permission-mode blocks Edit/Write/Bash outright in headless (-p) runs — there is
      // no interactive session to answer the prompt, and no permission-prompt-tool is wired up (see
      // the design note on ToolSkillAgent). 'acceptEdits' auto-approves file edits unattended;
      // verified empirically against the real CLI. Bash/command execution's behavior under it is
      // NOT verified — in local testing the model described the command as text rather than
      // invoking the tool, for reasons not fully diagnosed (Windows tool-name/session quirk, or
      // model choice) — treat command execution via this path as best-effort, not guaranteed.
      args.push('--tools', ...fullTools, '--permission-mode', 'acceptEdits', '--max-turns', opts?.mcp ? '60' : '30');
    } else if (mode !== 'none' && readTools.length > 0) {
      args.push('--tools', ...readTools, '--permission-mode', 'default', '--max-turns', opts?.mcp ? '60' : '16');
    } else {
      args.push('--tools', '', '--max-turns', opts?.mcp ? '60' : '1');
    }
    if (opts?.mcp) {
      // Only AutoDE's server (not the user's other MCP servers), and only the run's AutoDE tools: headless runs
      // can't ask, so a tool not pre-approved here is refused, never prompted for.
      args.push('--mcp-config', opts.mcp.configFile, '--strict-mcp-config', '--allowedTools', ...opts.mcp.allowedTools);
    }

    if (opts?.stream) { args[2] = 'stream-json'; args.push('--verbose'); }
    try {
      return await this.run(args, prompt, timeoutMs, opts?.cwd, opts?.cancellationToken, opts?.stream, opts?.env);
    } finally {
      if (promptFile) { try { fs.rmSync(promptFile, { force: true }); } catch { /* a temp file */ } }
    }
  }

  public async testCall(): Promise<{ ok: boolean; text?: string; error?: string }> {
    try {
      const text = await this.complete('Reply with exactly the word: PONG', { timeoutMs: 60000 });
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private run(
    args: string[],
    stdinPrompt: string,
    timeoutMs: number,
    cwd?: string,
    cancellationToken?: vscode.CancellationToken,
    stream?: ClaudeStreamParser,
    env?: Record<string, string>
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.cliPath, args, {
        cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
        windowsHide: true,
        ...(env ? { env: { ...process.env, ...env } } : {}),
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const done = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        sub?.dispose();
        fn();
      };

      const timer = setTimeout(() => {
        endProcessTree(child);
        done(() => reject(new Error(`Claude Code call timed out after ${Math.round(timeoutMs / 1000)}s`)));
      }, timeoutMs);

      const sub = cancellationToken?.onCancellationRequested(() => {
        endProcessTree(child);
        done(() => reject(new Error('Claude Code call was cancelled')));
      });

      child.stdout.on('data', (d) => { const t = d.toString(); if (stream) stream.feed(t); else stdout += t; });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('error', (err) => {
        done(() => reject(new Error(`Failed to launch Claude Code CLI: ${err.message}`)));
      });

      child.on('close', (code) => {
        done(() => {
          const parsed = stream ? stream.result() : parseResult(stdout);
          if (parsed.text !== undefined) {
            resolve(parsed.text);
            return;
          }
          const detail =
            parsed.error ||
            stderr.trim() ||
            stdout.trim().slice(0, 500) ||
            `exited with code ${code}`;
          reject(new Error(`Claude Code CLI failed: ${detail}`));
        });
      });

      try {
        child.stdin.on('error', () => { /* ignore EPIPE if the CLI exits early */ });
        child.stdin.write(stdinPrompt);
        child.stdin.end();
      } catch {
        /* 'error' event will reject */
      }
    });
  }
}

interface ClaudeCodeResultShape {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  error?: unknown;
}

function parseResult(stdout: string): { text?: string; error?: string } {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { error: 'no output' };
  }
  let obj: ClaudeCodeResultShape | undefined;
  try {
    obj = JSON.parse(trimmed) as ClaudeCodeResultShape;
  } catch {
    // Sometimes a stray line precedes the JSON — grab the last {...} block.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        obj = JSON.parse(trimmed.slice(start, end + 1)) as ClaudeCodeResultShape;
      } catch {
        /* fall through */
      }
    }
  }
  if (!obj) {
    return { error: `unparseable output: ${trimmed.slice(0, 300)}` };
  }
  if (obj.is_error || (obj.subtype && obj.subtype !== 'success')) {
    const msg = typeof obj.result === 'string' ? obj.result : typeof obj.error === 'string' ? obj.error : obj.subtype;
    return { error: msg || 'Claude Code reported an error' };
  }
  if (typeof obj.result === 'string') {
    return { text: obj.result.trim() };
  }
  return { error: 'Claude Code returned no result text' };
}
