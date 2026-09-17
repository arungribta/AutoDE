import { AgentExecutionContext, PlanStep } from '../core/types';

/**
 * Shared LLM-generation helper for the codegen agents (v0.11.0).
 *
 * Previously these agents were pure string templates parameterized only by
 * `TargetEnvironment` — `step.taskDescription`, `context.objective`, and the
 * whole Context Layer (`context.schemaContext`) had no effect on the output
 * (requirements.md §8.9 finding). This builds one consistent prompt merging
 * all of that, and every agent falls back to its original template if
 * `context.callLlm` is unavailable or the call fails — generation must never
 * become a hard failure point.
 */

function buildTargetSummary(context: AgentExecutionContext): string {
  const t = context.targetEnvironment;
  if (!t) return '(no target environment established yet)';
  const pc = (t.platformConfig ?? {}) as unknown as Record<string, string>;
  const location = pc.database ?? pc.catalog ?? pc.projectId ?? '';
  const sublocation = pc.schema ?? pc.dataset ?? '';
  return [
    `Platform: ${t.platform}`,
    `Location: ${location}${sublocation ? '.' + sublocation : ''}`,
    `Modeling approach: ${t.modelingApproach}`,
    `Naming convention: ${t.namingConvention}`,
    `Transformation tool: ${t.transformationTool}`,
    `Orchestration tool: ${t.orchestrationTool}`
  ].join('\n');
}

function extractFencedContent(text: string): string | undefined {
  const match = text.match(/```[a-zA-Z]*\r?\n?([\s\S]*?)```/);
  return match ? match[1].trim() : undefined;
}

export interface LlmGenerationRequest {
  /** Short description of the agent's role, e.g. "a data ingestion engineer". */
  role: string;
  /** What this artifact needs to contain/accomplish — the agent-specific instructions. */
  instructions: string;
  /** Fence language hint for both the prompt and the extraction regex, e.g. 'sql', 'yaml', 'markdown'. */
  fence?: string;
}

/**
 * Calls the configured LLM with the step/objective/context merged in.
 * Returns `undefined` (never throws) when `context.callLlm` isn't available
 * or the call fails — the caller's own template is the fallback either way.
 */
export async function generateWithLlm(
  context: AgentExecutionContext,
  step: PlanStep,
  request: LlmGenerationRequest
): Promise<string | undefined> {
  if (!context.callLlm) return undefined;

  const prompt = [
    `You are ${request.role} working on a data engineering project.`,
    '',
    '## Business Objective',
    context.objective && context.objective.trim() ? context.objective.trim() : '(not specified)',
    '',
    "## This Step's Task",
    step.taskDescription,
    '',
    '## Available Context (specification, source system, target platform, semantic layer)',
    context.schemaContext && context.schemaContext.trim() ? context.schemaContext.trim() : '(no additional context registered — use judgment based on the objective and task above)',
    '',
    '## Target Environment',
    buildTargetSummary(context),
    '',
    request.instructions
  ].join('\n');

  const systemPrompt = `You are an expert data engineer. Respond with ONLY the requested content, inside a single fenced code block (\`\`\`${request.fence ?? ''} ... \`\`\`). No explanation before or after the block.`;

  try {
    const raw = await context.callLlm(prompt, systemPrompt);
    // Require the fenced block the system prompt asked for — an unfenced
    // response isn't a looser "good enough" answer, it's a sign the model
    // ignored the format instruction, and unfenced raw text (which could be
    // prose, an error message, or something unrelated) must never be treated
    // as artifact content. Falling back to the template is strictly safer.
    const extracted = extractFencedContent(raw);
    return extracted && extracted.length > 0 ? extracted : undefined;
  } catch (err) {
    context.log(`LLM generation failed for step ${step.id} (${err instanceof Error ? err.message : String(err)}) — falling back to a template.`);
    return undefined;
  }
}
