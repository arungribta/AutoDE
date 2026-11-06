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
          sql: { type: 'string', minLength: 1, description: 'A statement; {param} binds a parameter, {param:literal} binds it as a quoted value, and [[ … ]] is kept only when the parameters inside it have values.' },
          cli: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'An argument list, never a shell line.' },
          http: {
            type: 'object', additionalProperties: false, required: ['method', 'path'],
            properties: {
              method: { enum: ['GET', 'POST'] }, path: { type: 'string', description: 'After the connection\'s base URL; {param} is encoded as one path segment.' },
              query: { type: 'object', additionalProperties: { type: 'string' } }, body: { description: 'A JSON template: "{param}" alone keeps the value\'s type; an optional parameter with no value drops the key.' },
              readOnly: { type: 'boolean', description: 'A POST that changes nothing (a search).' }, results: { type: 'string', description: 'A JSON path to the result rows; absent: the response is the rows.' },
              paging: {
                type: 'object', additionalProperties: false, required: ['style'], description: 'How the pages are followed.',
                properties: {
                  style: { enum: ['offset', 'page', 'cursor', 'link'] }, param: { type: 'string', description: 'offset, page, cursor: the query parameter that says where to read from.' },
                  sizeParam: { type: 'string' }, size: { type: 'number', minimum: 1 }, start: { type: 'number' },
                  next: { type: 'string', description: 'cursor, link: the path to the next cursor or link in the response.' }, total: { type: 'string', description: 'offset, page: the path to the total count.' }
                }
              }
            }
          },
          file: { type: 'object', additionalProperties: false, required: ['glob', 'parse'], properties: { glob: { type: 'string', description: 'Relative to the connection\'s folder: *, **, ?, {a,b}; {param} is bound.' }, parse: { enum: ['yaml', 'json', 'csv'] }, results: { type: 'string', description: 'yaml, json: the path to the rows in each file; absent: one row per file.' } } },
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

/** POP5b: one platform's implementation of an operation another file holds. */
export const IMPLEMENTATION_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://autode.dev/schemas/platform-implementation.schema.json',
  title: 'AutoDE platform implementation',
  description: 'One platform\'s implementation of an operation another file holds: the operation stays as it is, for every other platform.',
  type: 'object',
  additionalProperties: false,
  required: ['formatVersion', 'implements', 'platform', 'implementation'],
  properties: {
    formatVersion: { const: 1 },
    implements: OPERATION_SCHEMA.properties.id,
    platform: { type: 'string', pattern: '^[a-z][a-z0-9_-]*$' },
    implementation: OPERATION_SCHEMA.properties.platforms.additionalProperties,
    example: { type: 'object', additionalProperties: false, required: ['params', 'rows'], description: 'What the platform returned when it ran.', properties: { params: { type: 'object' }, rows: { type: 'array', items: { type: 'object' } } } }
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
            readCommands: { type: 'array', items: strings, description: 'The sub-commands that only read, such as [tables, list]: a cli read must start with one of them. A read over the CLI is refused without this list.' },
            browserSignIn: { ...strings, description: 'Regular expressions for what the CLI prints while it waits on a browser sign-in: AutoDE stops it and says so.' },
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
        api: {
          type: 'object', additionalProperties: false, required: ['name'],
          properties: {
            name: { type: 'string' }, baseUrlField: { type: 'string', description: 'The connection field holding the base URL.' },
            auth: {
              type: 'array', description: 'The ways to sign in: the first whose fields the connection has is used.',
              items: {
                type: 'object', additionalProperties: false, required: ['method'],
                properties: {
                  method: { enum: ['bearer', 'basic', 'oauth_client_credentials'], description: 'The fixed sign-in methods; a new one is code.' },
                  tokenField: { type: 'string' }, header: { type: 'string' }, scheme: { type: 'string' }, usernameField: { type: 'string' }, passwordField: { type: 'string' },
                  clientIdField: { type: 'string' }, clientSecretField: { type: 'string' }, tokenPath: { type: 'string' }, scope: { type: 'string' }
                }
              }
            },
            headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Headers sent on every call (never a secret).' }
          }
        },
        file: { type: 'object', additionalProperties: false, required: ['rootField'], properties: { rootField: { type: 'string', description: 'The connection field naming the folder file operations read (it may be a Git checkout).' } } }
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
        fragments: { type: 'object', additionalProperties: { type: 'string' } },
        compile: { enum: ['snowflake', 'spark_sql', 'google_sql', 'postgres', 'tsql', 'redshift', 'ansi'], description: 'The SQL dialect AutoDE compiles deliverables (Pipeline Specs, primitives) to for this platform, where it is a target.' }
      }
    },
    scopeLevel: { enum: ['database', 'schema'], description: 'What a read\'s databases parameter names here: databases or catalogs (default), or schemas (Oracle\'s owners).' },
    capabilities: {
      type: 'object',
      description: 'For each AutoDE capability: supported, partly or not applicable; its operations; the privileges it needs.',
      additionalProperties: {
        type: 'object', additionalProperties: false, required: ['support'],
        properties: { support: { enum: ['supported', 'partly', 'not_applicable'] }, operations: { type: 'array', items: { type: 'string' } }, privileges: { type: 'string' }, grants: { type: 'array', items: { type: 'string' }, description: 'The change operations that grant these privileges (Request access drafts a runbook from them), in the order they apply.' }, note: { type: 'string' } }
      }
    },
    objectKinds: { type: 'array', items: { type: 'string' }, description: 'The kinds of object it has (table, view, dynamic_table …): a kind its estate reads report that is not here raises a maintenance item.' },
    errors: {
      type: 'object', additionalProperties: false,
      description: 'How the platform words its errors, so AutoDE tells drift from other failures.',
      properties: { missingObject: { type: 'array', items: { type: 'string' }, description: 'Regular expressions (case-insensitive) for an error that says a table, view or column is missing.' } }
    }
  }
} as const;
