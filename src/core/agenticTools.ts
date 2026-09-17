import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { exec as execCb } from 'node:child_process';
import { ToolCallAuditEntry } from './types';

/**
 * Provider-agnostic tool layer shared by every LLM adapter's tool-calling loop
 * (Copilot's native `vscode.lm` tools, and the OpenAI/Anthropic/Gemini/Ollama
 * function-calling loops in `llmProviders.ts`). Claude Code CLI is the one
 * exception — it runs its own opaque agentic loop and never calls into this
 * module; it's gated by `toolMode` in `claudeCodeAdapter.ts` instead.
 *
 * Originally built (and still functionally identical) for Phase D tool-executing
 * Skills in `agents/build/ToolSkillAgent.ts`; extracted here so grounded chat
 * (`AgentHub.chat`) and every provider's loop can reuse the same tool set,
 * sandboxing, and approval flow instead of each reimplementing it.
 */

export interface AgenticToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface JsonSchemaToolSpec {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

export const MAX_TOOL_OUTPUT_CHARS = 20_000;
const MAX_SEARCH_FILES_SCANNED = 500;
const MAX_SEARCH_MATCHES = 100;
const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', '.ai-context']);

export const READ_ONLY_TOOL_SPECS: JsonSchemaToolSpec[] = [
  {
    name: 'autode_read_file',
    description: 'Read a UTF-8 text file at a path relative to the workspace root.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'autode_list_dir',
    description: 'List files and directories at a path relative to the workspace root.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'autode_search_files',
    description: 'Search text files under the workspace root for a substring or regex pattern. Returns matching file paths and line numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Substring or regular expression to search for.' },
        path: { type: 'string', description: 'Directory to search under, relative to the workspace root. Defaults to the workspace root.' }
      },
      required: ['pattern']
    }
  }
];

export const WRITE_TOOL_SPECS: JsonSchemaToolSpec[] = [
  {
    name: 'autode_write_file',
    description: 'Write (create or overwrite) a UTF-8 text file at a path relative to the workspace root. Requires user approval.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
  },
  {
    name: 'autode_run_command',
    description: 'Run a shell command in the workspace root. Requires user approval.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
  }
];

/** Resolves a model-supplied relative path against the workspace root, rejecting any escape (`..`, absolute paths elsewhere). */
export function resolveSandboxedPath(workspaceRoot: string, requestedPath: string): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, requestedPath || '.');
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path "${requestedPath}" escapes the workspace root — denied.`);
  }
  return resolved;
}

async function confirmToolCall(message: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Approve');
  return choice === 'Approve';
}

function runShellCommand(command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execCb(command, { cwd, timeout: 60_000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      const exitNote = err ? `\n[command exited with an error: ${err.message}]` : '';
      resolve(`${stdout}${stderr}${exitNote}`);
    });
  });
}

function searchFiles(root: string, startDir: string, pattern: string): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    // Not a valid regex — treat as a literal substring.
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }

  const matches: string[] = [];
  let scanned = 0;

  const walk = (dir: string): void => {
    if (matches.length >= MAX_SEARCH_MATCHES || scanned >= MAX_SEARCH_FILES_SCANNED) { return; }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= MAX_SEARCH_MATCHES || scanned >= MAX_SEARCH_FILES_SCANNED) { return; }
      if (SEARCH_SKIP_DIRS.has(entry.name)) { continue; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) { continue; }
      scanned++;
      let content: string;
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch {
        continue; // binary or unreadable — skip
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${path.relative(root, full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (matches.length >= MAX_SEARCH_MATCHES) { break; }
        }
      }
    }
  };

  walk(startDir);
  if (matches.length === 0) { return '(no matches)'; }
  const suffix = matches.length >= MAX_SEARCH_MATCHES ? `\n... capped at ${MAX_SEARCH_MATCHES} matches` : '';
  return matches.join('\n') + suffix;
}

/**
 * Executes one tool call against the sandboxed workspace, prompting for approval
 * on writes/commands. Shared by every provider's tool-calling loop.
 */
export async function executeAgenticTool(
  call: AgenticToolCall,
  workspaceRoot: string,
  audit: ToolCallAuditEntry[]
): Promise<string> {
  const input = call.input ?? {};
  const at = new Date().toISOString();
  try {
    switch (call.name) {
      case 'autode_read_file': {
        const resolved = resolveSandboxedPath(workspaceRoot, String(input.path ?? ''));
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(resolved));
        audit.push({ tool: call.name, input, outcome: 'ok', at });
        return Buffer.from(bytes).toString('utf8').slice(0, MAX_TOOL_OUTPUT_CHARS);
      }
      case 'autode_list_dir': {
        const resolved = resolveSandboxedPath(workspaceRoot, String(input.path ?? '.'));
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(resolved));
        audit.push({ tool: call.name, input, outcome: 'ok', at });
        return entries.map(([name, type]) => `${type === vscode.FileType.Directory ? 'dir ' : 'file'} ${name}`).join('\n') || '(empty directory)';
      }
      case 'autode_search_files': {
        const startDir = resolveSandboxedPath(workspaceRoot, String(input.path ?? '.'));
        const pattern = String(input.pattern ?? '');
        if (!pattern) { throw new Error('A search pattern is required.'); }
        const result = searchFiles(path.resolve(workspaceRoot), startDir, pattern);
        audit.push({ tool: call.name, input, outcome: 'ok', at });
        return result.slice(0, MAX_TOOL_OUTPUT_CHARS);
      }
      case 'autode_write_file': {
        const targetPath = String(input.path ?? '');
        const approved = await confirmToolCall(`Allow the assistant to write "${targetPath}"?`);
        if (!approved) {
          audit.push({ tool: call.name, input: { path: targetPath }, outcome: 'denied', at });
          return 'The user denied this file write.';
        }
        const resolved = resolveSandboxedPath(workspaceRoot, targetPath);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(resolved)));
        await vscode.workspace.fs.writeFile(vscode.Uri.file(resolved), Buffer.from(String(input.content ?? ''), 'utf8'));
        audit.push({ tool: call.name, input: { path: targetPath }, outcome: 'approved', at });
        return `Wrote ${targetPath}.`;
      }
      case 'autode_run_command': {
        const command = String(input.command ?? '');
        const approved = await confirmToolCall(`Allow the assistant to run this command in the workspace?\n\n${command}`);
        if (!approved) {
          audit.push({ tool: call.name, input, outcome: 'denied', at });
          return 'The user denied this command.';
        }
        const output = await runShellCommand(command, workspaceRoot);
        audit.push({ tool: call.name, input, outcome: 'approved', detail: output.slice(0, 500), at });
        return output.slice(0, MAX_TOOL_OUTPUT_CHARS);
      }
      default:
        audit.push({ tool: call.name, input, outcome: 'error', detail: 'unknown tool', at });
        return `Unknown tool: ${call.name}`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    audit.push({ tool: call.name, input, outcome: 'error', detail: message, at });
    return `Error: ${message}`;
  }
}
