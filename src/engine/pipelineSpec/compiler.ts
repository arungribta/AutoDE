import { PipelineSpec } from './types';
import { SqlDialect } from '../transforms/types';
import { compileTransformSpec } from '../transforms/registry';

export interface CompiledTransform {
  kind: string;
  content: string;
  summary: string;
}

export interface CompiledEntity {
  name: string;
  artifacts: CompiledTransform[];
}

/**
 * Deterministically compiles an approved Pipeline Spec — the AutoDE analogue
 * of the sibling framework's `interpreter.py`. Zero LLM calls. Deliberately
 * stricter than Phase 2's `generateViaPrimitiveOrFallback`: there is no
 * freehand fallback here. `compileTransformSpec()` throws on an invalid
 * transform step, and that throw is left to propagate — a compile failure at
 * this stage is a bug in an already-approved, already-Ajv-validated spec,
 * not a coverage gap to paper over silently.
 */
export function compilePipelineSpec(spec: PipelineSpec, dialect: SqlDialect): CompiledEntity[] {
  return spec.entities.map((entity) => {
    const artifacts = entity.transforms.map((step) => {
      const compiled = compileTransformSpec(
        { kind: step.kind, params: step.params, primitiveVersion: step.primitiveVersion },
        { platform: spec.targetPlatform, database: '', schema: '' },
        dialect
      );
      return { kind: step.kind, content: compiled.content, summary: compiled.summary };
    });
    return { name: entity.name, artifacts };
  });
}
