import Ajv, { ValidateFunction } from 'ajv';

/** Ajv meta-schema for a `PrimitiveDefinition` document itself — rejects a malformed definition at load time, before it's ever used to compile anything. */
export const PRIMITIVE_DEFINITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'version', 'status', 'description', 'paramSchema', 'platformTemplates', 'previewParams'],
  properties: {
    kind: { type: 'string', minLength: 1, pattern: '^[a-z][a-z0-9_]*$' },
    version: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: ['draft', 'published', 'deprecated', 'retired'] },
    description: { type: 'string', minLength: 1 },
    paramSchema: { type: 'object' },
    platformTemplates: {
      type: 'object',
      required: ['default'],
      minProperties: 1,
      additionalProperties: { type: 'string', minLength: 1 }
    },
    previewParams: { type: 'object' },
    outputChecks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          mustContain: { type: 'string', minLength: 1 },
          mustNotContain: { type: 'string', minLength: 1 }
        }
      }
    },
    publishedBy: { type: 'string' },
    publishedAt: { type: 'string' },
    changelog: { type: 'string' }
  }
};

const ajv = new Ajv({ allErrors: true, strict: false });
let validateFn: ValidateFunction | undefined;

export function validatePrimitiveDefinition(data: unknown): { valid: boolean; errors: string[] } {
  if (!validateFn) {
    validateFn = ajv.compile(PRIMITIVE_DEFINITION_SCHEMA);
  }
  const valid = validateFn(data) as boolean;
  const errors = (validateFn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
  return { valid, errors };
}
