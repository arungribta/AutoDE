import { AttachmentExtract, BusinessProblemSpec, SourceContext, TargetContext } from '../core/types';
import { CURRENT_PIPELINE_SPEC_VERSION, PipelineSpec } from '../core/pipelineSpec/types';
import { validatePipelineSpec } from '../core/pipelineSpec/validator';
import { TRANSFORM_PRIMITIVES } from '../core/transforms/registry';

/**
 * Pure prompt-building + response-parsing for Pipeline Spec synthesis —
 * mirrors the specOpsPrompts.ts / specSynthesis.ts split for the Business
 * Problem Specification. The LLM call and retry loop live in AgentHub
 * (`synthesizePipelineSpec`), same architecture as everywhere else in this
 * codebase: pure logic here, LLM invocation there.
 *
 * Grounded in the full set of context AutoDE already builds, not just the
 * BPS: the approved Target Context (platform/naming/transformation tool
 * feed the spec directly, rather than the LLM re-guessing them), the
 * approved Source Context, the Context Layer graph, any attachment
 * `AttachmentExtract`s, and the available transform-primitive catalog.
 */

export interface PipelineSpecSynthesisInputs {
  bps: BusinessProblemSpec;
  targetContext?: TargetContext;
  sourceContext?: SourceContext;
  contextLayerText?: string;
  attachmentExtracts?: AttachmentExtract[];
  previous?: PipelineSpec;
}

const SYSTEM_PROMPT = [
  'You are a senior data engineer producing a machine-executable Pipeline Specification from an approved Business Problem Specification and its surrounding context.',
  'Respond with a single valid JSON object only — no prose and no markdown fences, matching the Pipeline Spec shape shown below exactly.',
  'Every "transforms[].kind" MUST be one of the available primitive kinds listed below — never invent a kind, and never put SQL or code directly into "params".',
  'Base entity/column/object names on what the Business Problem Specification, Target/Source Context, and any attached-document extracts actually say — never invent tables or columns that are not evidenced there.',
  'Fields flagged below as sourced from an assumption (not a direct answer) are lower-confidence — reflect that by keeping the corresponding entity simple/conservative rather than over-specifying it.'
].join('\n');

function renderPrimitiveCatalog(): string {
  return Object.values(TRANSFORM_PRIMITIVES)
    .map((p) => `- "${p.kind}": ${p.description}\n  Parameter schema: ${JSON.stringify(p.paramSchema)}`)
    .join('\n');
}

function renderTargetContext(tc?: TargetContext): string {
  if (!tc) return '(no approved Target Context)';
  const parts: string[] = [];
  if (tc.platform) parts.push(`Platform: ${tc.platform}`);
  if (tc.modelingApproach) parts.push(`Modeling approach: ${tc.modelingApproach}`);
  if (tc.namingConvention) parts.push(`Naming convention: ${tc.namingConvention}`);
  if (tc.transformationTool) parts.push(`Transformation tool: ${tc.transformationTool}`);
  if (tc.platformConfig) parts.push(`Platform config: ${JSON.stringify(tc.platformConfig)}`);
  return parts.length > 0 ? parts.join('\n') : '(Target Context approved but empty)';
}

function renderSourceContext(sc?: SourceContext): string {
  if (!sc) return '(no approved Source Context)';
  const parts: string[] = [];
  if (sc.sourceType) parts.push(`Source type: ${sc.sourceType}`);
  if (sc.description) parts.push(`Description: ${sc.description}`);
  if (sc.connectionSummary) parts.push(`Connection: ${JSON.stringify(sc.connectionSummary)}`);
  return parts.length > 0 ? parts.join('\n') : '(Source Context approved but empty)';
}

function renderAssumptionFlags(bps: BusinessProblemSpec): string {
  const assumptions = (bps.provenance ?? []).filter((p) => p.source === 'assumption');
  if (assumptions.length === 0) return '';
  return `\n## Fields sourced from an assumption, not a direct answer (treat conservatively)\n${assumptions.map((p) => p.field).join(', ')}`;
}

function renderAttachmentExtracts(extracts?: AttachmentExtract[]): string {
  if (!extracts || extracts.length === 0) return '';
  const blocks = extracts.map((e) => {
    const lines = [`Confidence: ${e.confidence}`, e.rawSummary];
    if (e.entities && e.entities.length > 0) {
      lines.push(`Entities: ${e.entities.map((en) => `${en.name}(${(en.columns ?? []).map((c) => c.name).join(', ')})`).join('; ')}`);
    }
    return lines.join('\n');
  });
  return `\n## Structured facts extracted from attached documents\n${blocks.join('\n\n')}`;
}

/** Builds the synthesis prompt. When `validationErrors` is supplied (a prior attempt failed Ajv validation), they're fed back so the LLM can correct its next response. */
export function buildPipelineSpecSynthesisPrompt(
  inputs: PipelineSpecSynthesisInputs,
  validationErrors?: string[]
): { system: string; user: string } {
  const { bps, targetContext, sourceContext, contextLayerText, attachmentExtracts, previous } = inputs;
  const lines: string[] = [
    `## Approved Business Problem Specification (v${bps.version})`,
    `Problem statement: ${bps.problemStatement}`,
    `Objectives: ${bps.objectives.join('; ')}`,
    `In scope: ${bps.scope.in.join('; ')}`
  ];
  if (bps.sourceCatalog && bps.sourceCatalog.length > 0) {
    lines.push(`Source catalog: ${bps.sourceCatalog.map((s) => `${s.name} (${s.type})`).join('; ')}`);
  }
  if (bps.dataFlows && bps.dataFlows.length > 0) {
    lines.push(`Data flows: ${bps.dataFlows.map((f) => `${f.source} -> ${f.target}: ${f.description}`).join('; ')}`);
  }
  const assumptionFlags = renderAssumptionFlags(bps);
  if (assumptionFlags) lines.push(assumptionFlags);
  lines.push(`\n## Approved Target Context\n${renderTargetContext(targetContext)}`);
  lines.push(`\n## Approved Source Context\n${renderSourceContext(sourceContext)}`);
  if (contextLayerText && contextLayerText.trim().length > 0) {
    lines.push(`\n## Registered repository context\n${contextLayerText.trim()}`);
  }
  const attachmentsBlock = renderAttachmentExtracts(attachmentExtracts);
  if (attachmentsBlock) lines.push(attachmentsBlock);
  lines.push(`\n## Available transform primitives\n${renderPrimitiveCatalog()}`);

  if (previous) {
    lines.push(`\n## Existing Pipeline Spec (v${previous.version}) — revise it; do not discard entities that are still valid\n${JSON.stringify(previous, null, 2)}`);
  }

  if (validationErrors && validationErrors.length > 0) {
    lines.push(`\n## Your previous response was invalid — fix these errors and try again\n${validationErrors.join('\n')}`);
  }

  const exampleShape = {
    entities: [{
      name: '...',
      source: { object: '...', type: 'table' },
      transforms: [{ kind: '...', params: {} }],
      target: { object: '...', materialization: 'view' }
    }],
    targetPlatform: targetContext?.platform ?? 'snowflake'
  };
  lines.push('\nRespond with the Pipeline Spec JSON now, using this shape:', JSON.stringify(exampleShape, null, 2));

  return { system: SYSTEM_PROMPT, user: lines.join('\n') };
}

/**
 * Parses/validates the LLM's Pipeline Spec response. Identity/versioning
 * fields (`id`, `version`, `specVersion`, `derivedFromBps*`) are owned by
 * this code, not trusted from the LLM's output — same pattern as
 * `parseComprehensiveSpec()` for the BPS. Throws with the Ajv errors on an
 * invalid `entities` shape; the caller (AgentHub) retries with those errors
 * fed back into the next prompt attempt.
 */
export function parsePipelineSpecResponse(raw: unknown, inputs: PipelineSpecSynthesisInputs): PipelineSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('The LLM did not return a JSON object for the Pipeline Spec.');
  }
  const record = raw as Record<string, unknown>;
  const now = new Date().toISOString();
  const isRevisionOfApproved = inputs.previous?.status === 'approved';

  const candidate: PipelineSpec = {
    specVersion: CURRENT_PIPELINE_SPEC_VERSION,
    id: inputs.previous?.id ?? `pipeline-${Date.now().toString(36)}`,
    version: isRevisionOfApproved ? inputs.previous!.version + 1 : (inputs.previous?.version ?? 1),
    status: 'draft',
    derivedFromBpsId: inputs.bps.id,
    derivedFromBpsVersion: inputs.bps.version,
    targetPlatform: typeof record.targetPlatform === 'string' && record.targetPlatform.trim()
      ? record.targetPlatform.trim()
      : (inputs.targetContext?.platform ?? 'snowflake'),
    entities: Array.isArray(record.entities) ? (record.entities as PipelineSpec['entities']) : [],
    createdAt: inputs.previous?.createdAt ?? now,
    updatedAt: now
  };

  const { valid, errors } = validatePipelineSpec(candidate);
  if (!valid) {
    throw new Error(errors.join('; '));
  }
  return candidate;
}
