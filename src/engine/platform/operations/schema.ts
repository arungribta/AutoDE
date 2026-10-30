/**
 * The JSON Schemas of platform operations and platform definitions (POP1).
 * Flat and labelled so a form can edit them (the planned catalog, POP4).
 * `docs/schemas/platform-operation.schema.json` and `platform.schema.json`
 * are these, written out (a test keeps them equal).
 */

const name = { type: 'string', pattern: '^[a-z][a-z0-9_]*$', description: 'Lower case, digits and _.' };
const version = { type: 'string', pattern: '^\\d+(\\.\\d+){0,3}$', description: 'A version such as 8.0 or 3.5.1.' };
const strings = { type: 'array', items: { type: 'string' } };

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
    id: { type: 'string', pattern: '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$', description: 'area.name, for example lineage.columns.' },
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
        cli: {
          type: 'object', additionalProperties: false, required: ['command'],
          properties: {
            command: { type: 'string' }, minVersion: version, install: { type: 'string' },
            credentialEnv: { type: 'string', pattern: '^[A-Z][A-Z0-9_]*$', description: 'The environment variable the CLI reads a password or token from: AutoDE passes the credential there, never as an argument.' },
            binary: { type: 'object', additionalProperties: false, properties: { win32: { type: 'string' }, default: { type: 'string' } }, description: 'The executable\'s name per OS, when it differs from command.' },
            wellKnownDirs: { type: 'object', additionalProperties: false, properties: { win32: strings, default: strings }, description: 'Folders the vendor\'s installer uses, looked in when the CLI isn\'t on PATH.' },
            versionArgs: strings,
            env: { type: 'object', additionalProperties: { type: 'string' }, propertyNames: { pattern: '^[A-Z][A-Z0-9_]*$' }, description: 'Environment variables set on every call (never a secret): for example turning the CLI\'s pager off.' },
            listProfiles: { ...strings, description: 'The arguments that list the CLI\'s own profiles, one per line.' },
            statement: {
              type: 'object', additionalProperties: false, required: ['mode'],
              description: 'How a statement runs through the CLI, for a platform without an adapter class: {sql} and {id} are filled in, and the connection\'s arguments added.',
              properties: {
                mode: { enum: ['sync', 'async'] },
                run: { type: 'object', additionalProperties: false, required: ['args'], properties: { args: strings, rows: { type: 'string' } } },
                submit: { type: 'object', additionalProperties: false, required: ['args', 'id'], properties: { args: strings, id: { type: 'string' } } },
                poll: { type: 'object', additionalProperties: false, required: ['args', 'status', 'finished', 'failed'], properties: { args: strings, status: { type: 'string' }, finished: strings, failed: strings, error: { type: 'string' }, hasResult: { type: 'string' } } },
                fetch: { type: 'object', additionalProperties: false, required: ['args', 'rows'], properties: { args: strings, rows: { type: 'string' }, columns: { type: 'string' }, columnName: { type: 'string' }, nextToken: { type: 'string' }, nextTokenArg: { type: 'string' }, cells: { enum: ['plain', 'typed'] } } },
                cancel: { type: 'object', additionalProperties: false, required: ['args'], properties: { args: strings } }
              }
            }
          }
        },
        api: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } }
      }
    },
    versionOperation: { type: 'string' },
    connection: {
      type: 'object', additionalProperties: false, required: ['fields'],
      description: 'What a connection to the platform is made of, for a platform whose card is drawn from this file.',
      properties: {
        fields: {
          type: 'array', minItems: 1,
          items: {
            type: 'object', additionalProperties: false, required: ['name', 'label'],
            properties: {
              name: { type: 'string', pattern: '^[a-z][A-Za-z0-9]*$' }, label: { type: 'string', minLength: 1 }, description: { type: 'string' },
              required: { type: 'boolean' }, personal: { type: 'boolean' }, secret: { type: 'boolean' },
              cliArg: { type: 'string', pattern: '^--?[a-z][a-z0-9-]*$' }, cliScope: { enum: ['every', 'submit'] },
              env: { type: 'string', pattern: '^[A-Z][A-Z0-9_]*$' }
            }
          }
        },
        idFields: strings,
        exactlyOne: { type: 'array', items: strings },
        authModes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['mode', 'label'], properties: { mode: { type: 'string' }, label: { type: 'string' }, requires: strings, note: { type: 'string' } } } },
        cliProfileField: { type: 'string' },
        roles: { type: 'array', items: { enum: ['source', 'target'] } },
        targetNote: { type: 'string' }
      }
    },
    dialect: {
      type: 'object', additionalProperties: false,
      properties: {
        identifierQuote: { enum: ['"', '`'] },
        unquotedCase: { enum: ['upper', 'lower', 'preserve'] },
        booleans: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'string' } },
        fragments: { type: 'object', additionalProperties: { type: 'string' } }
      }
    },
    scopeLevel: { enum: ['database', 'schema'], description: 'What a read\'s databases parameter names here: databases or catalogs (default), or schemas (Oracle\'s owners).' },
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
