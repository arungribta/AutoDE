import * as path from 'node:path';
import { AgentExecutionContext, AgentExecutionResult, PlanStep, ToolExecutionMode, ToolSkillDefinition } from '../../engine/types';
import { resolveAllowedToolNames, toolModeCeiling } from '../../engine/skills/toolAllowList';
import { TrustTier, isClaudeCliEligible, minMode, notRunnableReason, resolveSkillVersion, tierModeCeiling } from '../../engine/skills/lifecycle';
import { layoutPath, layoutRel } from '../../engine/workspaceLayout';

/**
 * Runs an imported Claude Agent Skill (`SKILL.md` + resources) with real tool
 * access (Phase D; one path for every provider since v0.28.0 — Phase S1 of
 * docs/mcp-engine-requirements.md).
 *
 * The run goes through `context.runWithTools`, i.e. the configured provider's own
 * tool loop (`getLlmAdapter(provider).complete` with a tool mode), so a skill works
 * on any of AutoDE's seven providers with no skill-level changes:
 * - copilot / openai / azure-openai / anthropic / gemini / ollama run AutoDE's own
 *   loop over `core/agenticTools.ts`: every write/exec call is approved individually,
 *   and every call is audited (`ToolCallAuditEntry`), returned with the result.
 * - claude runs Claude Code's own opaque loop. AutoDE can't see or block individual
 *   calls there, so the run is approved once as a whole, and the approval text says
 *   so; the allow-list still applies, through the CLI's `--tools` list.
 *
 * What the skill may use is capped twice: its declared `allowed-tools` narrow the
 * tool catalog (`resolveAllowedToolNames`), and `resolveToolExecutionMode` never
 * grants `'full'` to a skill that declared only read tools. Phase S2 (v0.34.0) caps
 * it by trust tier too — reviewed skills run read-only at most and never through
 * Claude Code; unreviewed, draft and retired skills don't run — and resolves a
 * pinned `skillVersion` from the skill's version history.
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

  const toolSkillsDir = layoutPath(workspaceRoot, 'toolSkills');
  const pinned = step.skillVersion ?? context.skillVersion;
  const state = resolveSkillVersion(toolSkillsDir, skillId, pinned);
  if (!state) {
    return pinned === undefined
      ? { success: false, message: `Skill "${skillId}" was not found under ${layoutRel('toolSkills')}/.`, error: 'skill not found' }
      : { success: false, message: `Version ${pinned} of skill "${skillId}" was not found (it was never published, or its history was removed).`, error: 'skill version not found' };
  }
  const notRunnable = notRunnableReason(state, { pinned: pinned !== undefined });
  if (notRunnable) {
    return { success: false, message: notRunnable, error: 'skill not runnable' };
  }
  const skill = state.skill;
  const tier = state.effectiveTier;

  const instruction = (step.taskDescription || context.skillInstruction || context.objective || '').trim();
  if (!instruction) {
    return { success: false, message: 'No instruction was given for the skill to act on.', error: 'missing instruction' };
  }

  if (!context.runWithTools) {
    return { success: false, message: 'Tool-executing skills need a host that can run an LLM with tools.', error: 'runWithTools unavailable' };
  }

  const allowed = resolveAllowedToolNames(skill.declaredTools);
  const mode = resolveToolExecutionMode(skill, allowed, tier);
  const provider = context.settings.activeLlmProvider;
  if (provider === 'claude' && !isClaudeCliEligible(tier)) {
    return {
      success: false,
      message: `Skill "${skill.name}" is ${tier}, not trusted: it cannot run through Claude Code, whose tool calls AutoDE cannot audit one by one. Choose another provider, or trust the skill ("AutoDE: Review Tool Skill").`,
      error: 'skill not eligible for the Claude CLI path'
    };
  }
  const toolsLabel = allowed === undefined ? 'all workspace tools' : allowed.length === 0 ? 'no tools' : allowed.join(', ');

  try {
    const { text, audit } = await context.runWithTools(instruction, {
      systemPrompt: buildSkillSystemPrompt(skill, context),
      toolExecutionMode: mode,
      allowedToolNames: allowed,
      justification: `Run imported skill "${skill.name}"`,
      approvalPrompt: provider === 'claude'
        ? `Run skill "${skill.name}" via Claude Code with ${mode === 'full' ? 'file write and command' : 'read-only'} access (${toolsLabel}) in this workspace? ` +
          'Claude Code runs its own tool loop: you approve this whole run once, and AutoDE cannot audit or block individual tool calls — it can only limit which tools are available.'
        : undefined
    });
    context.log(`Skill "${skill.name}" v${state.sidecar.version} (${tier}) completed via ${provider} (mode ${mode}, tools: ${toolsLabel}) after ${audit.length} audited tool call(s).`);
    return {
      success: true,
      message: text || `Skill "${skill.name}" completed (${audit.length} tool call(s), no final text).`,
      details: { provider, skillId: skill.id, skillVersion: state.sidecar.version, trustTier: tier, contentChecksum: state.checksum, mode, allowedTools: allowed ?? 'unrestricted', audit: audit as unknown as Record<string, unknown> }
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.log(`Skill "${skill.name}" failed via ${provider}: ${message}`);
    return { success: false, message: `Skill run failed: ${message}`, error: message };
  }
}

/** The mode a skill runs in: the lower of its declared-tools ceiling (S1) and its trust tier's ceiling (S2). */
export function resolveToolExecutionMode(_skill: ToolSkillDefinition, allowed: readonly string[] | undefined, tier: TrustTier = 'trusted'): ToolExecutionMode {
  return minMode(toolModeCeiling(allowed), tierModeCeiling(tier));
}

function buildSkillSystemPrompt(skill: ToolSkillDefinition, context: AgentExecutionContext): string {
  const lines = [`You are executing the imported skill "${skill.name}".`];
  if (skill.description) { lines.push(skill.description); }
  if (context.schemaContext && context.schemaContext.trim().length > 0) {
    lines.push('\n' + context.schemaContext.trim());
  }
  lines.push('\n## Skill instructions\n' + skill.instructions);
  lines.push('\nFollow the instructions above to satisfy the user\'s request. Tool access is sandboxed to the current workspace.');
  return lines.join('\n');
}
