import { ToolExecutionMode } from '../types';

/**
 * Which AutoDE tools a tool-executing skill may use (v0.28.0 — docs/specs/mcp-engine.md
 * Phase S1). Pure logic, in the engine so the MCP server can apply the same rules when it
 * exposes skills (Phase S2/3). The tool *implementations* live in `src/core/agenticTools.ts`;
 * a functional test keeps these names in step with that catalog.
 */

export const AUTODE_READ_TOOLS = ['autode_read_file', 'autode_list_dir', 'autode_search_files'] as const;
export const AUTODE_WRITE_TOOLS = ['autode_write_file', 'autode_run_command'] as const;

const ALL_TOOLS = new Set<string>([...AUTODE_READ_TOOLS, ...AUTODE_WRITE_TOOLS]);
const WRITE_TOOLS = new Set<string>(AUTODE_WRITE_TOOLS);

/**
 * Tool names third-party skills declare in `allowed-tools` (Claude Code / OSS `SKILL.md`
 * conventions) → AutoDE's tools. Keys are lower-cased; a declared `Bash(git:*)` is matched
 * on the part before `(`.
 */
const TOOL_NAME_ALIASES: Record<string, string[]> = {
  read: ['autode_read_file'],
  view: ['autode_read_file'],
  grep: ['autode_search_files'],
  search: ['autode_search_files'],
  glob: ['autode_list_dir'],
  ls: ['autode_list_dir'],
  list: ['autode_list_dir'],
  write: ['autode_write_file'],
  edit: ['autode_write_file'],
  multiedit: ['autode_write_file'],
  bash: ['autode_run_command'],
  shell: ['autode_run_command']
};

/**
 * Turns a skill's declared `allowed-tools` into the AutoDE tool names it may use.
 * `undefined` (nothing declared) means no extra restriction — back-compat for skills
 * that never declared tools. Unrecognized names are dropped, not fatal. If a skill
 * declared tools but none are recognized, the result is an empty list: the skill gets
 * no tools rather than every tool.
 */
export function resolveAllowedToolNames(declared: readonly string[] | undefined): string[] | undefined {
  if (!declared || declared.length === 0) return undefined;
  const names = new Set<string>();
  for (const raw of declared) {
    const name = raw.trim().split('(')[0].trim();
    if (ALL_TOOLS.has(name)) { names.add(name); continue; }
    for (const mapped of TOOL_NAME_ALIASES[name.toLowerCase()] ?? []) names.add(mapped);
  }
  return [...names];
}

/**
 * The most a skill may be granted, from what it declared: a skill whose allow-list has no
 * write/exec tool never runs in `'full'` mode. Phase S2 lowers this further by trust tier.
 * `declaresEngineWrite` (phase 5): the skill declared an engine tool that proposes a change,
 * which needs `'full'` even with no file write or command declared.
 */
export function toolModeCeiling(allowed: readonly string[] | undefined, declaresEngineWrite = false): ToolExecutionMode {
  if (allowed && !allowed.some((t) => WRITE_TOOLS.has(t)) && !declaresEngineWrite) return 'read-only';
  return 'full';
}
