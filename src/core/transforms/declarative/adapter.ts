import { TransformPrimitive, CompiledArtifact, TargetEnvironmentSummary, SqlDialect } from '../types';
import { PrimitiveDefinition } from './types';
import { renderTemplate } from './templateEngine';

function selectTemplate(definition: PrimitiveDefinition, dialect: SqlDialect): string {
  return definition.platformTemplates[dialect] ?? definition.platformTemplates.default;
}

/** Runs a definition's `outputChecks` against rendered output. Throws on the first failure — same "invalid compile is a bug, not a coverage gap" posture as `compileTransformSpec`'s own validation. */
function runOutputChecks(definition: PrimitiveDefinition, rendered: string, params: Record<string, unknown>): void {
  for (const check of definition.outputChecks ?? []) {
    if (check.mustContain) {
      const expected = renderTemplate(check.mustContain, params);
      if (!rendered.includes(expected)) {
        throw new Error(`Primitive "${definition.kind}" output failed an outputCheck: expected output to contain "${expected}".`);
      }
    }
    if (check.mustNotContain) {
      const forbidden = renderTemplate(check.mustNotContain, params);
      if (forbidden.length > 0 && rendered.includes(forbidden)) {
        throw new Error(`Primitive "${definition.kind}" output failed an outputCheck: output must not contain "${forbidden}".`);
      }
    }
  }
}

/**
 * Wraps a loaded `PrimitiveDefinition` into the same `TransformPrimitive`
 * interface Tier 1 (TypeScript) primitives already implement — every
 * existing consumer (`selectTransformSpec`, `compileTransformSpec`, the
 * Pipeline Spec compiler) works identically regardless of which tier a
 * `kind` resolves to.
 */
export function createDeclarativePrimitive(definition: PrimitiveDefinition): TransformPrimitive<Record<string, unknown>> {
  return {
    kind: definition.kind,
    description: definition.description,
    paramSchema: definition.paramSchema,
    status: definition.status,
    compile(params: Record<string, unknown>, _target: TargetEnvironmentSummary, dialect: SqlDialect): CompiledArtifact {
      const template = selectTemplate(definition, dialect);
      const rendered = renderTemplate(template, params);
      runOutputChecks(definition, rendered, params);
      return {
        language: 'sql',
        content: rendered,
        summary: `Compiled via declarative primitive "${definition.kind}" v${definition.version}.`
      };
    }
  };
}
