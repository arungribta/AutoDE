import { toolResultSummary } from '../engine/agents/answerTrace';
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { exec as execCb } from 'node:child_process';
import { EngineToolSet, ToolCallAuditEntry, ToolExecutionMode } from '../engine/types';
export { resolveAllowedToolNames } from '../engine/skills/toolAllowList';

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
const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', '.autode', '.ai-context']);

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

/** Narrows a tool catalog to an allow-list; `undefined` leaves it unchanged. */
export function filterToolSpecsByAllowList(specs: JsonSchemaToolSpec[], allowed: readonly string[] | undefined): JsonSchemaToolSpec[] {
  if (!allowed) return specs;
  const set = new Set(allowed);
  return specs.filter((s) => set.has(s.name));
}

/**
 * Read-only tools for `'read-only'`, read-only + write/exec for `'full'`, none otherwise — then narrowed to `allowed`.
 * The run's engine tools (phase 5; already narrowed by their caller) follow whenever the mode allows tools.
 */
export function toolSpecsForMode(mode: ToolExecutionMode | undefined, allowed?: readonly string[], engine?: EngineToolSet): JsonSchemaToolSpec[] {
  const base = mode === 'full' ? [...READ_ONLY_TOOL_SPECS, ...WRITE_TOOL_SPECS] : mode === 'read-only' ? READ_ONLY_TOOL_SPECS : [];
  const files = filterToolSpecsByAllowList(base, allowed);
  if (!engine || mode === undefined || mode === 'none') return files;
  return [...files, ...engine.specs.map((s) => ({ name: s.name, description: s.description, parameters: s.parameters as unknown as JsonSchemaToolSpec['parameters'] }))];
}

/**
 * A JSON Schema reduced to what Gemini's function declarations accept (an OpenAPI subset):
 * type, description, enum, items, properties, required. Other providers take the schema as is.
 */
export function geminiSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof s.type === 'string') out.type = s.type;
  if (typeof s.description === 'string') out.description = s.description;
  if (Array.isArray(s.enum)) out.enum = s.enum.map(String);
  if (s.items) out.items = geminiSchema(s.items);
  if (s.properties && typeof s.properties === 'object') {
    out.properties = Object.fromEntries(Object.entries(s.properties as Record<string, unknown>).map(([k, v]) => [k, geminiSchema(v)]));
  }
  if (Array.isArray(s.required)) out.required = s.required;
  if (out.type === 'object' && !out.properties) out.properties = {};
  if (!out.type) out.type = out.properties ? 'object' : 'string';
  return out;
}

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
  audit: ToolCallAuditEntry[],
  /** The tool names this run was offered. A call to anything else is refused and audited as denied (v0.28.0) —
   *  models normally only call offered tools, but an allow-list must not depend on that. */
  offered?: ReadonlySet<string>,
  /** The run's engine tools (phase 5): calls to them go through the engine client, audited like any other. */
  engine?: EngineToolSet
): Promise<string> {
  const input = call.input ?? {};
  const at = new Date().toISOString();
  if (offered && !offered.has(call.name)) {
    audit.push({ tool: call.name, input, outcome: 'denied', detail: 'tool not offered to this run', at });
    return `Error: the tool "${call.name}" is not available in this run.`;
  }
  if (engine && engine.specs.some((s) => s.name === call.name)) {
    try {
      const r = await engine.call(call.name, input);
      audit.push({ tool: call.name, input, outcome: r.isError ? 'error' : 'ok', detail: r.isError ? r.text.slice(0, 500) : undefined, at, ...(r.isError ? {} : toolResultSummary(call.name, r.text)) });
      return r.text.slice(0, MAX_TOOL_OUTPUT_CHARS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit.push({ tool: call.name, input, outcome: 'error', detail: message, at });
      return `Error: ${message}`;
    }
  }
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
