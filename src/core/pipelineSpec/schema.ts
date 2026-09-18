/**
 * `additionalProperties: false` at every nesting level — top-level, each
 * entity, and every entity sub-block (source/target/transforms/quality/
 * governance) — following the recursive-strict precedent already proven in
 * `src/core/transforms/primitives/renameCast.ts`'s `paramSchema`, not the
 * deliberately-open `context-envelope.schema.json` family (the wrong
 * lineage for a machine-compile contract).
 */
export const PIPELINE_SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['specVersion', 'id', 'version', 'status', 'derivedFromBpsId', 'derivedFromBpsVersion', 'targetPlatform', 'entities'],
  properties: {
    specVersion: { type: 'integer', minimum: 1 },
    id: { type: 'string', minLength: 1 },
    version: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: ['draft', 'approved'] },
    derivedFromBpsId: { type: 'string', minLength: 1 },
    derivedFromBpsVersion: { type: 'integer', minimum: 1 },
    targetPlatform: { type: 'string', minLength: 1 },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    approvedAt: { type: 'string' },
    approvedBy: { type: 'string' },
    entities: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'source', 'transforms', 'target'],
        properties: {
          name: { type: 'string', minLength: 1 },
          source: {
            type: 'object',
            additionalProperties: false,
            required: ['object', 'type'],
            properties: {
              object: { type: 'string', minLength: 1 },
              type: { type: 'string', enum: ['table', 'view', 'file', 'stream', 'api', 'other'] }
            }
          },
          transforms: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'params'],
              properties: {
                kind: { type: 'string', minLength: 1 },
                params: { type: 'object' },
                primitiveVersion: { type: 'integer', minimum: 1 }
              }
            }
          },
          target: {
            type: 'object',
            additionalProperties: false,
            required: ['object', 'materialization'],
            properties: {
              object: { type: 'string', minLength: 1 },
              materialization: { type: 'string', enum: ['table', 'view'] }
            }
          },
          quality: {
            type: 'object',
            additionalProperties: false,
            required: ['rules'],
            properties: {
              rules: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['description'],
                  properties: { description: { type: 'string', minLength: 1 } }
                }
              }
            }
          },
          governance: {
            type: 'object',
            additionalProperties: false,
            required: ['columns'],
            properties: {
              columns: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['column', 'classification'],
                  properties: {
                    column: { type: 'string', minLength: 1 },
                    classification: { type: 'string', enum: ['none', 'pii', 'sensitive-pii', 'confidential'] }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
};
