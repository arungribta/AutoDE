import * as vscode from 'vscode';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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
   * @param opts.allowTools shorthand for `toolMode: 'read-only'` (kept for the existing grounded-chat
   *   caller). @param opts.toolMode takes precedence when given: `'none'` (default) permits no tools
   *   and caps the run at 1 turn; `'read-only'` allows Read/Grep/Glob so Claude Code can inspect the
   *   workspace; `'full'` (Phase D, tool-executing Skills) additionally allows Edit/Write/Bash — Claude
   *   Code's own tool loop still runs (AutoDE doesn't reimplement it), scoped to `opts.cwd`.
   */
  public async complete(
    prompt: string,
    opts?: {
      systemPrompt?: string;
      model?: string;
      allowTools?: boolean;
      toolMode?: 'none' | 'read-only' | 'full';
      timeoutMs?: number;
      cwd?: string;
      cancellationToken?: vscode.CancellationToken;
    }
  ): Promise<string> {
    const mode = opts?.toolMode ?? (opts?.allowTools ? 'read-only' : 'none');
    const timeoutMs = opts?.timeoutMs ?? (mode === 'none' ? 90000 : 180000);
    const args = ['-p', '--output-format', 'json'];

    if (opts?.systemPrompt && opts.systemPrompt.trim().length > 0) {
      args.push('--append-system-prompt', opts.systemPrompt.trim());
    }

    const model = (opts?.model ?? '').trim();
    if (model && CLAUDE_MODEL_HINT.test(model)) {
      args.push('--model', model);
    }

    if (mode === 'full') {
      // 'default' permission-mode blocks Edit/Write/Bash outright in headless (-p) runs — there is
      // no interactive session to answer the prompt, and no permission-prompt-tool is wired up (see
      // the design note on ToolSkillAgent). 'acceptEdits' auto-approves file edits unattended;
      // verified empirically against the real CLI. Bash/command execution's behavior under it is
      // NOT verified — in local testing the model described the command as text rather than
      // invoking the tool, for reasons not fully diagnosed (Windows tool-name/session quirk, or
      // model choice) — treat command execution via this path as best-effort, not guaranteed.
      args.push('--tools', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', '--permission-mode', 'acceptEdits', '--max-turns', '30');
    } else if (mode === 'read-only') {
      args.push('--tools', 'Read', 'Grep', 'Glob', '--permission-mode', 'default', '--max-turns', '16');
    } else {
      args.push('--tools', '', '--max-turns', '1');
    }

    return await this.run(args, prompt, timeoutMs, opts?.cwd, opts?.cancellationToken);
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
    cancellationToken?: vscode.CancellationToken
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.cliPath, args, {
        cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
        windowsHide: true,
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
        child.kill();
        done(() => reject(new Error(`Claude Code call timed out after ${Math.round(timeoutMs / 1000)}s`)));
      }, timeoutMs);

      const sub = cancellationToken?.onCancellationRequested(() => {
        child.kill();
        done(() => reject(new Error('Claude Code call was cancelled')));
      });

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('error', (err) => {
        done(() => reject(new Error(`Failed to launch Claude Code CLI: ${err.message}`)));
      });

      child.on('close', (code) => {
        done(() => {
          const parsed = parseResult(stdout);
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
