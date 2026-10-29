/**
 * The JSON Schemas of platform operations and platform definitions (POP1).
 * Flat and labelled so a form can edit them (the planned catalog, POP4).
 * `docs/schemas/platform-operation.schema.json` and `platform.schema.json`
 * are these, written out (a test keeps them equal).
 */

const name = { type: 'string', pattern: '^[a-z][a-z0-9_]*$', description: 'Lower case, digits and _.' };
const version = { type: 'string', pattern: '^\\d+(\\.\\d+){0,3}$', description: 'A version such as 8.0 or 3.5.1.' };

export const OPERATION_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://autode.dev/schemas/platform-operation.schema.json',
  title: 'AutoDE platform operation',
  description: 'One interaction with a platform: typed parameters, an implementation per platform, a typed result and a recorded example.',
  type: 'object',
  additionalProperties: false,
  required: ['formatVersion', 'id', 'title', 'description', 'kind', 'area', 'params', 'returns', 'platforms'],
  properties: {
    formatVersion: { const: 1, description: 'The format version of this file.' },
    id: { type: 'string', pattern: '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$', description: 'area.name, for example lineage.access_history.' },
    title: { type: 'string', minLength: 3, description: 'What it does, in a few words.' },
    description: { type: 'string', minLength: 10, description: 'What it does and what it returns, in plain language.' },
    kind: { enum: ['read', 'change'], description: 'read runs; change only becomes a runbook step a person approves.' },
    content: { enum: ['metadata', 'data'], description: 'metadata: object and column names only; data: row values (gated by the sample-data setting).' },
    area: { type: 'string', pattern: '^[a-z][a-z0-9_]*$', description: 'estate, lineage, quality, governance, deployment, platform.' },
    params: {
      type: 'array',
      description: 'The values a caller supplies.',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'type', 'label'],
        properties: {
          name, label: { type: 'string', minLength: 1 }, description: { type: 'string' },
          type: { enum: ['identifier', 'identifier_list', 'literal', 'literal_list', 'number', 'boolean', 'statement'], description: 'How the value is bound: never pasted in as text.' },
          required: { type: 'boolean' }, default: {}, min: { type: 'number' }, max: { type: 'number' }
        }
      }
    },
    returns: {
      type: 'array',
      description: 'The result, one entry per column.',
      items: {
        type: 'object', additionalProperties: false, required: ['name'],
        properties: { name, from: { type: 'string', minLength: 1 }, as: { enum: ['string', 'number', 'yes_no', 'boolean', 'json'] }, label: { type: 'string' } }
      }
    },
    platforms: {
      type: 'object', minProperties: 1,
      description: 'One implementation per platform id (snowflake, databricks, oracle, redshift …).',
      propertyNames: { pattern: '^[a-z][a-z0-9_-]*$' },
      additionalProperties: {
        type: 'object', additionalProperties: false,
        properties: {
          sql: { type: 'string', minLength: 1, description: 'A statement; {param} binds a parameter, {param:literal} binds it as a quoted value.' },
          cli: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'An argument list, never a shell line.' },
          http: {
            type: 'object', additionalProperties: false, required: ['method', 'path'],
            properties: { method: { enum: ['GET', 'POST'] }, path: { type: 'string' }, query: { type: 'object', additionalProperties: { type: 'string' } }, body: {}, readOnly: { type: 'boolean' }, results: { type: 'string', description: 'A JSON path to the result rows.' } }
          },
          file: { type: 'object', additionalProperties: false, required: ['glob', 'parse'], properties: { glob: { type: 'string' }, parse: { enum: ['yaml', 'json', 'csv'] } } },
          parse: { enum: ['json', 'table'] },
          since: version, until: version
        },
        oneOf: [{ required: ['sql'] }, { required: ['cli'] }, { required: ['http'] }, { required: ['file'] }]
      }
    },
    example: {
      type: 'object', additionalProperties: false, required: ['params', 'rows'],
      description: 'A recorded result, so binding and mapping are checked without an account.',
      properties: { params: { type: 'object' }, rows: { type: 'array', items: { type: 'object' } }, platform: { type: 'string' } }
    }
  }
} as const;

export const PLATFORM_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://autode.dev/schemas/platform.schema.json',
  title: 'AutoDE platform definition',
  description: 'What a platform is and what AutoDE can do with it: category, access, dialect, capabilities.',
  type: 'object',
  additionalProperties: false,
  required: ['formatVersion', 'id', 'title', 'category', 'transports', 'capabilities'],
  properties: {
    formatVersion: { const: 1 },
    id: { type: 'string', pattern: '^[a-z][a-z0-9_-]*$', description: 'The connection platform id: snowflake, databricks, oracle, redshift …' },
    title: { type: 'string', minLength: 2 },
    category: { enum: ['warehouse', 'lakehouse', 'semantic', 'catalog', 'orchestration', 'bi'] },
    transports: { type: 'array', minItems: 1, items: { enum: ['sql', 'cli', 'http', 'file'] } },
    access: {
      type: 'object', additionalProperties: false,
      properties: {
        cli: { type: 'object', additionalProperties: false, required: ['command'], properties: { command: { type: 'string' }, minVersion: version, install: { type: 'string' } } },
        api: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } }
      }
    },
    versionOperation: { type: 'string' },
    dialect: {
      type: 'object', additionalProperties: false,
      properties: {
        identifierQuote: { enum: ['"', '`'] },
        unquotedCase: { enum: ['upper', 'lower', 'preserve'] },
        booleans: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string' } },
        fragments: { type: 'object', additionalProperties: { type: 'string' } }
      }
    },
    capabilities: {
      type: 'object',
      description: 'For each AutoDE capability: supported, partly or not applicable; its operations; the privileges it needs.',
      additionalProperties: {
        type: 'object', additionalProperties: false, required: ['support'],
        properties: { support: { enum: ['supported', 'partly', 'not_applicable'] }, operations: { type: 'array', items: { type: 'string' } }, privileges: { type: 'string' }, note: { type: 'string' } }
      }
    },
    objectKinds: { type: 'array', items: { type: 'string' } }
  }
} as const;
