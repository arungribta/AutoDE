/**
 * Deterministic transform primitives (Phase 2, "spec compiles to code").
 *
 * Kept fully self-contained (no imports from core/types.ts or dqm/types.ts)
 * so this module has no vscode dependency and can't participate in an
 * import cycle with core/types.ts, which imports `TransformSpec` from here
 * for the optional `AgentExecutionContext.transformSpec` bypass field.
 */

export type PrimitiveKind = 'rename_cast' | 'dedup' | 'incremental_load';

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

export interface TransformPrimitive<TParams = Record<string, unknown>> {
  kind: PrimitiveKind;
  /** Shown to the LLM during primitive selection, and used as documentation. */
  description: string;
  /** Ajv-compatible JSON Schema describing valid parameters for this primitive. */
  paramSchema: object;
  /** Pure function: validated params + target + dialect -> generated code. Never calls an LLM. */
  compile(params: TParams, target: TargetEnvironmentSummary, dialect: SqlDialect): CompiledArtifact;
}
