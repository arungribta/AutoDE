import Ajv, { ValidateFunction } from 'ajv';
import { TransformPrimitive, TransformSpec, CompiledArtifact, TargetEnvironmentSummary, SqlDialect } from './types';
import { renameCastPrimitive } from './primitives/renameCast';
import { dedupPrimitive } from './primitives/dedup';
import { incrementalLoadPrimitive } from './primitives/incrementalLoad';

/**
 * Tier 1 — the closed set of vetted, code-reviewed transform primitives
 * (Phase 2). An LLM's creative surface when generating a pipeline step is a
 * bounded, Ajv-validated parameter object against one of these — never
 * SQL/code directly.
 *
 * Phase 2B-ii adds Tier 2: primitives loaded from `PrimitiveDefinition` YAML
 * (declarative/, see `registerPrimitives`) behind this exact same interface.
 * `TRANSFORM_PRIMITIVES` stays a plain, directly-indexable object — existing
 * call sites and tests that read `TRANSFORM_PRIMITIVES.rename_cast` keep
 * working unchanged — but it is no longer frozen to these 3 keys at module
 * load: Tier 2 kinds are added to it at runtime. On a `kind` collision, Tier
 * 1 (reviewed code, registered here at module load) always wins — a
 * declarative primitive is additive, never a silent override of core
 * behavior.
 */
export const TRANSFORM_PRIMITIVES: Record<string, TransformPrimitive<any>> = {
  rename_cast: renameCastPrimitive,
  dedup: dedupPrimitive,
  incremental_load: incrementalLoadPrimitive
};

/** The Tier-1 kinds present at module load — used by `resetDeclarativePrimitives()` to know what NOT to remove. */
const CORE_PRIMITIVE_KINDS = new Set(Object.keys(TRANSFORM_PRIMITIVES));

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ValidateFunction>();

function getValidator(kind: string): ValidateFunction {
  let validate = validators.get(kind);
  if (!validate) {
    validate = ajv.compile(TRANSFORM_PRIMITIVES[kind].paramSchema);
    validators.set(kind, validate);
  }
  return validate;
}

export function getPrimitive(kind: string): TransformPrimitive<any> | undefined {
  return TRANSFORM_PRIMITIVES[kind];
}

/**
 * Registers Tier-2 (declarative) primitives into the merged registry. A
 * `kind` that collides with an existing Tier-1 entry is skipped, not
 * overwritten — reported back so a caller (e.g. Phase 2B-iii's UI) can
 * surface it, rather than silently letting a workspace-authored definition
 * shadow reviewed code.
 */
export function registerPrimitives(primitives: TransformPrimitive<any>[]): { added: string[]; skipped: string[] } {
  const added: string[] = [];
  const skipped: string[] = [];
  for (const primitive of primitives) {
    if (CORE_PRIMITIVE_KINDS.has(primitive.kind)) {
      skipped.push(primitive.kind);
      continue;
    }
    TRANSFORM_PRIMITIVES[primitive.kind] = primitive;
    validators.delete(primitive.kind);
    added.push(primitive.kind);
  }
  return { added, skipped };
}

/** Removes every registered Tier-2 primitive (e.g. before a fresh directory reload), leaving Tier 1 untouched. */
export function resetDeclarativePrimitives(): void {
  for (const kind of Object.keys(TRANSFORM_PRIMITIVES)) {
    if (!CORE_PRIMITIVE_KINDS.has(kind)) {
      delete TRANSFORM_PRIMITIVES[kind];
      validators.delete(kind);
    }
  }
}

export function validateTransformSpec(spec: TransformSpec): { valid: boolean; errors: string[] } {
  const primitive = getPrimitive(spec.kind);
  if (!primitive) {
    return { valid: false, errors: [`Unknown primitive kind "${spec.kind}".`] };
  }
  const validate = getValidator(spec.kind);
  const valid = validate(spec.params) as boolean;
  const errors = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
  return { valid, errors };
}

/** Validates then compiles. Throws on invalid params — callers that want a non-throwing path should call `validateTransformSpec` first. */
export function compileTransformSpec(spec: TransformSpec, target: TargetEnvironmentSummary, dialect: SqlDialect): CompiledArtifact {
  const primitive = getPrimitive(spec.kind);
  if (!primitive) {
    throw new Error(`Unknown primitive kind "${spec.kind}".`);
  }
  const { valid, errors } = validateTransformSpec(spec);
  if (!valid) {
    throw new Error(`Invalid params for primitive "${spec.kind}": ${errors.join('; ')}`);
  }
  return primitive.compile(spec.params, target, dialect);
}
