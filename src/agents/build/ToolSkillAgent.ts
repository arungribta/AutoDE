import * as vscode from 'vscode';
import * as path from 'node:path';
import { AgentExecutionContext, AgentExecutionResult, PlanStep, ToolSkillDefinition } from '../../core/types';
import { loadToolSkillsFromDirectory } from '../../core/toolSkills';

/**
 * Runs an imported Claude Agent Skill (`SKILL.md` + resources) with real tool
 * access (Phase D). This is the one agent that breaks the "sub-agents import
 * only core/types" convention (see the note on `AgentExecutionContext` in
 * `core/types.ts`) — everything else in `src/agents/**` is a deterministic
 * template generator; this one runs an actual multi-turn agentic loop with
 * file I/O and command execution, so it genuinely needs `vscode` + `child_process`.
 *
 * Execution path depends on the active provider:
 * - `claude`  → Claude Code's own CLI tool loop (`ClaudeCodeAdapter`, toolMode:'full').
 *               AutoDE does not intercept individual tool calls here — Claude Code
 *               runs its own loop opaquely. Gated by ONE invocation-level
 *               confirmation dialog (not per-call — see the design note below).
 * - `copilot` → `LanguageModelAdapter.completeWithTools()`, a tool-calling loop
 *               AutoDE owns, built on `vscode.lm`'s documented tool-calling API
 *               (`LanguageModelChatRequestOptions.tools`,
 *               `LanguageModelToolCallPart`/`LanguageModelToolResultPart`) and the
 *               shared tool set in `core/agenticTools.ts`. Every write/exec call is
 *               gated by its own approval dialog and logged.
 * - anything else → unsupported *for tool-executing Skills specifically* (this
 *               agent stays scoped to the two providers with a real Skill-shaped
 *               tool loop). Grounded chat (`AgentHub.chat`) is not this restricted —
 *               it wires the same `core/agenticTools.ts` tool set into every
 *               provider's own native function-calling API; see `core/llmProviders.ts`.
 *
 * Design note on approval granularity: Claude Code's own permission-prompt
 * callback mechanism (`--permission-prompts host` + an external tool) is not
 * something this implementation wires up — the CLI's `--help` documents that
 * such a callback exists, but not the schema it expects, and guessing at an
 * undocumented contract risks silently not working. So the Claude path gets
 * one confirmation before the whole run, not per-call approval; only the
 * Copilot path (where AutoDE owns the loop) gets true per-tool-call approval.
 *
 * Verified empirically against the real Claude Code CLI (not just compiled):
 * `--permission-mode default` (the mode grounded chat's read-only path already
 * used) silently blocks Edit/Write in headless (`-p`) runs — there's no
 * interactive session to answer the prompt. `acceptEdits` auto-approves file
 * edits unattended and was confirmed to actually write a file end-to-end.
 * Bash/command execution's behavior under `acceptEdits` is NOT verified — in
 * local testing on this platform the model described the command as text
 * rather than invoking the tool (a Windows tool-availability quirk or a model
 * choice, not fully diagnosed) — treat command execution via the Claude path
 * as best-effort, not guaranteed, until observed working.
 */

export async function executeToolSkillAgent(step: PlanStep, context: AgentExecutionContext): Promise<AgentExecutionResult> {
  const skillId = step.skillId ?? context.skillId;
  if (!skillId) {
    return { success: false, message: 'No skill specified for this step.', error: 'toolSkillAgent requires a skillId.' };
  }
  const workspaceRoot = context.workspaceRoot;
  if (!workspaceRoot) {
    return { success: false, message: 'No workspace is open.', error: 'workspaceRoot is required to run a tool-executing skill.' };
  }

  const toolSkillsDir = path.join(workspaceRoot, '.ai-context', 'skills', 'tool-skills');
  const skill = loadToolSkillsFromDirectory(toolSkillsDir).find((s) => s.id === skillId);
  if (!skill) {
    return { success: false, message: `Skill "${skillId}" was not found under .ai-context/skills/tool-skills/.`, error: 'skill not found' };
  }

  const instruction = (step.taskDescription || context.skillInstruction || context.objective || '').trim();
  if (!instruction) {
    return { success: false, message: 'No instruction was given for the skill to act on.', error: 'missing instruction' };
  }

  const consented = context.settings.languageModelProgrammaticConsent || context.settings.copilotProgrammaticConsent;
  if (!consented) {
    return {
      success: false,
      message: 'Programmatic use of a local language model is not enabled.',
      error: 'Open Settings (⚙) → LLM Provider → check "Allow programmatic use" and try again.'
    };
  }

  const provider = context.settings.activeLlmProvider;
  if (provider === 'claude') {
    return runOnClaude(skill, instruction, context);
  }
  if (provider === 'copilot') {
    return runOnCopilot(skill, instruction, context);
  }
  return {
    success: false,
    message: `Tool-executing skills need a provider that can run tools. The active provider ("${provider}") can't — switch to "copilot" or "claude".`,
    error: 'unsupported provider for tool execution'
  };
}

function buildSkillSystemPrompt(skill: ToolSkillDefinition): string {
  const lines = [`You are executing the imported skill "${skill.name}".`];
  if (skill.description) { lines.push(skill.description); }
  lines.push('\n## Skill instructions\n' + skill.instructions);
  lines.push('\nFollow the instructions above to satisfy the user\'s request. Tool access is sandboxed to the current workspace.');
  return lines.join('\n');
}

// ── Claude Code execution path ──

async function runOnClaude(skill: ToolSkillDefinition, instruction: string, context: AgentExecutionContext): Promise<AgentExecutionResult> {
  const proceed = await vscode.window.showWarningMessage(
    `Run skill "${skill.name}" via Claude Code with file write and command execution access, scoped to this workspace?`,
    { modal: true },
    'Run'
  );
  if (proceed !== 'Run') {
    return { success: false, message: `Skill "${skill.name}" was not run — declined by the user.`, error: 'declined' };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ClaudeCodeAdapter } = require('../../core/claudeCodeAdapter') as typeof import('../../core/claudeCodeAdapter');
    const { adapter, info } = await ClaudeCodeAdapter.detect(context.settings.claudeCodePath);
    if (!adapter) {
      return { success: false, message: info.error || 'Claude Code CLI is not available.', error: info.error };
    }
    const result = await adapter.complete(instruction, {
      systemPrompt: buildSkillSystemPrompt(skill),
      model: context.settings.activeLlmModel,
      toolMode: 'full',
      cwd: context.workspaceRoot
    });
    context.log(`Skill "${skill.name}" completed via Claude Code.`);
    return { success: true, message: result.slice(0, 4000), details: { provider: 'claude', skillId: skill.id } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.log(`Skill "${skill.name}" failed via Claude Code: ${message}`);
    return { success: false, message: `Skill run failed: ${message}`, error: message };
  }
}

// ── Copilot execution path (AutoDE-owned tool loop, shared with chat — see `core/agenticTools.ts`) ──

async function runOnCopilot(skill: ToolSkillDefinition, instruction: string, context: AgentExecutionContext): Promise<AgentExecutionResult> {
  const workspaceRoot = context.workspaceRoot!;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LanguageModelAdapter } = require('../../core/languageModelAdapter') as typeof import('../../core/languageModelAdapter');
    const extensionContext = context.extensionContext as vscode.ExtensionContext | undefined;
    const { adapter, info } = await LanguageModelAdapter.detect(extensionContext, { provider: 'copilot', model: context.settings.activeLlmModel });
    if (!adapter) {
      return { success: false, message: info.error || 'GitHub Copilot is not available through the VS Code Language Model API.', error: info.error };
    }

    const { text, audit } = await adapter.completeWithTools(instruction, {
      model: context.settings.activeLlmModel,
      systemPrompt: buildSkillSystemPrompt(skill),
      justification: `Run imported skill "${skill.name}"`,
      mode: 'full',
      workspaceRoot
    });

    context.log(`Skill "${skill.name}" completed via Copilot after ${audit.length} tool call(s). Audit: ${JSON.stringify(audit).slice(0, 500)}`);
    return {
      success: true,
      message: text || `Skill "${skill.name}" completed (${audit.length} tool call(s), no final text).`,
      details: { provider: 'copilot', skillId: skill.id, audit: audit as unknown as Record<string, unknown> }
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.log(`Skill "${skill.name}" failed via Copilot: ${message}`);
    return { success: false, message: `Skill run failed: ${message}`, error: message };
  }
}
