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

/**
 * Historical Tier-2 primitive revisions, keyed by kind then version (Phase
 * 2B-iv version pinning). Populated separately from `TRANSFORM_PRIMITIVES`
 * (the live, latest-published catalog) — a caller that loads a primitive's
 * `history/` archive (see `webviewProvider.ts::ensurePrimitivesLoaded`)
 * registers each archived revision here via `registerPrimitiveVersion`,
 * without it ever appearing in the live catalog listing.
 */
const VERSIONED_PRIMITIVES = new Map<string, Map<number, TransformPrimitive<any>>>();

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ValidateFunction>();

function validatorCacheKey(kind: string, version: number | undefined): string {
  return version === undefined ? kind : `${kind}@${version}`;
}

function getValidator(kind: string, version: number | undefined, primitive: TransformPrimitive<any>): ValidateFunction {
  const cacheKey = validatorCacheKey(kind, version);
  let validate = validators.get(cacheKey);
  if (!validate) {
    validate = ajv.compile(primitive.paramSchema);
    validators.set(cacheKey, validate);
  }
  return validate;
}

export function getPrimitive(kind: string): TransformPrimitive<any> | undefined {
  return TRANSFORM_PRIMITIVES[kind];
}

/**
 * Registers one historical revision of a Tier-2 primitive for version
 * pinning (Phase 2B-iv) — distinct from `registerPrimitives`, which governs
 * the *live* catalog. A primitive with no `version` is ignored (nothing to
 * pin to).
 */
export function registerPrimitiveVersion(primitive: TransformPrimitive<any>): void {
  if (primitive.version === undefined) return;
  if (!VERSIONED_PRIMITIVES.has(primitive.kind)) {
    VERSIONED_PRIMITIVES.set(primitive.kind, new Map());
  }
  VERSIONED_PRIMITIVES.get(primitive.kind)!.set(primitive.version, primitive);
}

/** Clears all registered historical revisions (e.g. before a fresh reload) — leaves the live catalog untouched. */
export function resetVersionedPrimitives(): void {
  VERSIONED_PRIMITIVES.clear();
}

/**
 * Resolves which primitive a spec actually compiles against. With no
 * `primitiveVersion` pin, that's whatever's currently live (latest
 * published) — unchanged behavior from Phase 2. With a pin, prefers an
 * exact-version match from `VERSIONED_PRIMITIVES`; if that specific
 * revision was never archived/loaded (e.g. a Tier-1 kind, which has no
 * versioning concept, or a version that predates history tracking), falls
 * back to the live entry rather than failing outright.
 */
function resolvePrimitive(spec: TransformSpec): TransformPrimitive<any> | undefined {
  if (spec.primitiveVersion !== undefined) {
    const pinned = VERSIONED_PRIMITIVES.get(spec.kind)?.get(spec.primitiveVersion);
    if (pinned) return pinned;
  }
  return TRANSFORM_PRIMITIVES[spec.kind];
}

/** Every registered primitive, Tier 1 and Tier 2 alike — the UI's catalog listing (Phase 2B-iii). */
export function listPrimitives(): TransformPrimitive<any>[] {
  return Object.values(TRANSFORM_PRIMITIVES);
}

/**
 * A primitive is selectable (offered to the LLM as a candidate kind) unless
 * it's a Tier-2 primitive explicitly in `draft`, `deprecated`, or `retired`.
 * Tier 1 (code) primitives and any Tier-2 primitive without a status are
 * always selectable. Selectability only gates the LLM's *choice* — a
 * deprecated/retired primitive still compiles when explicitly referenced
 * (e.g. by an already-approved Pipeline Spec); see `compileTransformSpec`.
 */
export function isSelectable(primitive: TransformPrimitive<any>): boolean {
  return !primitive.status || primitive.status === 'published';
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
    registerPrimitiveVersion(primitive); // so pinning to the currently-live version also resolves consistently
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
  const primitive = resolvePrimitive(spec);
  if (!primitive) {
    return { valid: false, errors: [`Unknown primitive kind "${spec.kind}".`] };
  }
  const validate = getValidator(spec.kind, spec.primitiveVersion, primitive);
  const valid = validate(spec.params) as boolean;
  const errors = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
  return { valid, errors };
}

/** Validates then compiles. Throws on invalid params — callers that want a non-throwing path should call `validateTransformSpec` first. */
export function compileTransformSpec(spec: TransformSpec, target: TargetEnvironmentSummary, dialect: SqlDialect): CompiledArtifact {
  const primitive = resolvePrimitive(spec);
  if (!primitive) {
    throw new Error(`Unknown primitive kind "${spec.kind}".`);
  }
  const { valid, errors } = validateTransformSpec(spec);
  if (!valid) {
    throw new Error(`Invalid params for primitive "${spec.kind}": ${errors.join('; ')}`);
  }
  return primitive.compile(spec.params, target, dialect);
}
