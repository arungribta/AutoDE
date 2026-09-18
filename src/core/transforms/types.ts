/**
 * Deterministic transform primitives (Phase 2, "spec compiles to code").
 *
 * Kept fully self-contained (no imports from core/types.ts or dqm/types.ts)
 * so this module has no vscode dependency and can't participate in an
 * import cycle with core/types.ts, which imports `TransformSpec` from here
 * for the optional `AgentExecutionContext.transformSpec` bypass field.
 */

/**
 * The `& {}` on the string branch is the standard TS "open union" trick: it
 * keeps autocomplete/literal-checking for the 3 known Tier-1 kinds below
 * while still accepting any other string — needed since Phase 2B's Tier-2
 * declarative primitives introduce `kind` values that don't exist at compile
 * time (they're loaded from YAML files at runtime). Plain `string` would
 * lose the autocomplete; a closed union couldn't represent a runtime-loaded
 * kind at all.
 */
// eslint-disable-next-line @typescript-eslint/ban-types -- deliberate "open union" idiom, not an accidental empty-object type
export type PrimitiveKind = 'rename_cast' | 'dedup' | 'incremental_load' | (string & {});

/** Mirrors dqm/types.ts's `SqlDialect` — duplicated rather than imported to keep this module dependency-free. */
export type SqlDialect = 'snowflake' | 'spark_sql' | 'google_sql' | 'postgres' | 'tsql' | 'ansi';

/** The minimal target-location info a primitive's `compile()` needs — not the full `TargetEnvironment`. */
export interface TargetEnvironmentSummary {
  /** e.g. 'snowflake' | 'databricks' | ... — kept as `string` here, not `DataPlatformProvider`, for the same dependency-free reason as `SqlDialect` above. */
  platform: string;
  database: string;
  schema: string;
}

export interface CompiledArtifact {
  language: 'sql' | 'yaml' | 'markdown';
  content: string;
  /** Human-readable summary of what was compiled, for artifact review UI / logs. */
  summary: string;
}

/** What the LLM is allowed to produce: a primitive kind plus its parameters — never code. */
export interface TransformSpec {
  kind: PrimitiveKind;
  params: Record<string, unknown>;
}

/**
 * A Tier-2 (declarative) primitive's publication lifecycle (Phase 2B-iii):
 * `draft` -> `published` -> `deprecated` -> `retired`. Tier-1 (code)
 * primitives omit this entirely — reviewed code is always selectable, there
 * is no draft/publish ceremony for it.
 */
export type PrimitiveLifecycleStatus = 'draft' | 'published' | 'deprecated' | 'retired';

export interface TransformPrimitive<TParams = Record<string, unknown>> {
  kind: PrimitiveKind;
  /** Shown to the LLM during primitive selection, and used as documentation. */
  description: string;
  /** Ajv-compatible JSON Schema describing valid parameters for this primitive. */
  paramSchema: object;
  /** Tier-2 only — see `PrimitiveLifecycleStatus`. `undefined` (Tier 1, or a Tier-2 primitive omitting it) is treated as always-selectable. */
  status?: PrimitiveLifecycleStatus;
  /** Pure function: validated params + target + dialect -> generated code. Never calls an LLM. */
  compile(params: TParams, target: TargetEnvironmentSummary, dialect: SqlDialect): CompiledArtifact;
}
