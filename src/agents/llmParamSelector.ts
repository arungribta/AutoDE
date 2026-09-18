import { AgentExecutionContext, PlanStep } from '../core/types';
import { PrimitiveKind, TransformSpec, TargetEnvironmentSummary, SqlDialect } from '../core/transforms/types';
import { TRANSFORM_PRIMITIVES, validateTransformSpec, compileTransformSpec, getPrimitive, isSelectable } from '../core/transforms/registry';

/**
 * Selects and parameterizes a deterministic transform primitive (Phase 2),
 * instead of letting the LLM freehand SQL/dbt code directly. The LLM's
 * entire creative surface here is a bounded, Ajv-validated JSON object
 * `{kind, params}` — never SQL, never any other code. Returns `undefined`
 * (never throws) on any parse/shape/validation failure, so the caller can
 * fall back to its existing freehand-LLM or template tiers unchanged.
 */

function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\r?\n?([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function isCandidateSpecShape(value: unknown): value is { kind: unknown; params: unknown } {
  return !!value && typeof value === 'object' && 'kind' in value && 'params' in value;
}

export async function selectTransformSpec(
  context: AgentExecutionContext,
  step: PlanStep,
  candidateKinds: PrimitiveKind[],
  /** Parameters the caller already knows deterministically (e.g. object names it computed from settings) — merged in AFTER the LLM's response, so the LLM cannot override them. */
  fixedParams?: Record<string, unknown>
): Promise<TransformSpec | undefined> {
  // A Tier-2 primitive in draft/deprecated/retired is never offered to the LLM as a
  // choice (Phase 2B-iii's lifecycle) — it can still be compiled directly (e.g. by an
  // already-approved Pipeline Spec referencing it), just never freshly selected here.
  const selectableKinds = candidateKinds.filter((kind) => {
    const primitive = getPrimitive(kind);
    return !!primitive && isSelectable(primitive);
  });
  if (!context.callLlm || selectableKinds.length === 0) return undefined;

  const catalog = selectableKinds
    .map((kind) => `- "${kind}": ${TRANSFORM_PRIMITIVES[kind].description}\n  Parameter schema: ${JSON.stringify(TRANSFORM_PRIMITIVES[kind].paramSchema)}`)
    .join('\n');

  const fixedNote = fixedParams && Object.keys(fixedParams).length > 0
    ? `\nThese parameters are already fixed — include them verbatim in "params": ${JSON.stringify(fixedParams)}. Only decide the remaining parameters the chosen primitive's schema requires.\n`
    : '';

  const prompt = [
    `Business objective: ${context.objective && context.objective.trim() ? context.objective.trim() : '(not specified)'}`,
    '',
    `This step's task: ${step.taskDescription}`,
    '',
    'Available context:',
    context.schemaContext && context.schemaContext.trim() ? context.schemaContext.trim() : '(none registered — use judgment based on the objective and task above)',
    '',
    'Available transform primitives — choose exactly one that fits this step:',
    catalog,
    fixedNote,
    'Base column/object names on entities actually named in the task/context above. Respond with ONLY a single JSON object of the shape {"kind": "<primitive kind>", "params": {...matching that primitive\'s parameter schema exactly...}} — no transform logic, no SQL, no code, no explanation.'
  ].join('\n');

  const systemPrompt = 'You are a data engineer selecting and parameterizing a pre-vetted transform primitive. Respond with ONLY a single fenced JSON object (```json ... ```) containing "kind" and "params" — never SQL, never prose, never any other code.';

  let raw: string;
  try {
    raw = await context.callLlm(prompt, systemPrompt);
  } catch (err) {
    context.log(`Transform primitive selection failed for step ${step.id} (${err instanceof Error ? err.message : String(err)}) — falling back.`);
    return undefined;
  }

  const parsed = extractJsonObject(raw);
  if (!isCandidateSpecShape(parsed) || typeof parsed.kind !== 'string' || typeof parsed.params !== 'object' || parsed.params === null) {
    return undefined;
  }
  if (!selectableKinds.includes(parsed.kind as PrimitiveKind)) {
    return undefined;
  }

  const spec: TransformSpec = {
    kind: parsed.kind as PrimitiveKind,
    params: { ...(parsed.params as Record<string, unknown>), ...(fixedParams ?? {}) }
  };
  const { valid } = validateTransformSpec(spec);
  return valid ? spec : undefined;
}

export interface TieredGenerationResult {
  content: string;
  source: 'primitive' | 'freehand' | 'template';
}

/**
 * The shared 3-tier fallback every codegen agent uses: try a deterministic
 * primitive first (tier 0, new in Phase 2); if the LLM doesn't pick a valid
 * one, fall back to the agent's existing freehand LLM call (tier 1); if that
 * also fails/is unavailable, fall back to the agent's existing hardcoded
 * template (tier 2). `context.transformSpec`, if set, bypasses selection
 * entirely and is compiled directly.
 */
export async function generateViaPrimitiveOrFallback(
  context: AgentExecutionContext,
  step: PlanStep,
  candidateKinds: PrimitiveKind[],
  target: TargetEnvironmentSummary,
  dialect: SqlDialect,
  freehandFallback: () => Promise<string | undefined>,
  template: () => string,
  fixedParams?: Record<string, unknown>
): Promise<TieredGenerationResult> {
  const spec = context.transformSpec ?? await selectTransformSpec(context, step, candidateKinds, fixedParams);
  if (spec) {
    try {
      const compiled = compileTransformSpec(spec, target, dialect);
      return { content: compiled.content, source: 'primitive' };
    } catch (err) {
      context.log(`Primitive compilation failed for step ${step.id} (${err instanceof Error ? err.message : String(err)}) — falling back.`);
    }
  }

  const freehand = await freehandFallback();
  if (freehand) {
    return { content: freehand, source: 'freehand' };
  }
  return { content: template(), source: 'template' };
}
