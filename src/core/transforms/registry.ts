import Ajv, { ValidateFunction } from 'ajv';
import { PrimitiveKind, TransformPrimitive, TransformSpec, CompiledArtifact, TargetEnvironmentSummary, SqlDialect } from './types';
import { renameCastPrimitive } from './primitives/renameCast';
import { dedupPrimitive } from './primitives/dedup';
import { incrementalLoadPrimitive } from './primitives/incrementalLoad';

/**
 * The closed set of vetted transform primitives (Phase 2). An LLM's creative
 * surface when generating a pipeline step is a bounded, Ajv-validated
 * parameter object against one of these — never SQL/code directly. This is
 * deliberately a small, closed registry rather than an open plugin system:
 * adding a primitive is a reviewed code change, not something a spec or LLM
 * response can introduce on its own.
 */
export const TRANSFORM_PRIMITIVES: Record<PrimitiveKind, TransformPrimitive<any>> = {
  rename_cast: renameCastPrimitive,
  dedup: dedupPrimitive,
  incremental_load: incrementalLoadPrimitive
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<PrimitiveKind, ValidateFunction>();

function getValidator(kind: PrimitiveKind): ValidateFunction {
  let validate = validators.get(kind);
  if (!validate) {
    validate = ajv.compile(TRANSFORM_PRIMITIVES[kind].paramSchema);
    validators.set(kind, validate);
  }
  return validate;
}

export function getPrimitive(kind: string): TransformPrimitive<any> | undefined {
  return (TRANSFORM_PRIMITIVES as Record<string, TransformPrimitive<any>>)[kind];
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
