import { TransformPrimitive, CompiledArtifact, TargetEnvironmentSummary, SqlDialect } from '../types';

/**
 * `mask` (GOV, v0.47.0): masks personal-data columns, non-reversibly, in a
 * view or table over the source; the other columns pass through unchanged.
 *
 * - `hash`: SHA-256 as lowercase hex of the value as text, with an optional
 *   salt. Equal values stay equal, so keys still join and deduplicate. An
 *   unsalted hash of a low-entropy value (a phone number, a birth date) can
 *   be reversed by trying every value: salt it with a secret the platform
 *   holds (a Databricks secret, a Snowflake session variable).
 * - `redact`: a constant literal (default `'***'`), the column becomes text.
 *
 * Reversible strategies (tokenisation) need a vault and are out of scope.
 * NULL stays NULL. ANSI SQL has no hash function, so `hash` is refused for
 * the `ansi` dialect rather than guessed.
 *
 * Tier 1 (code), not a Tier-2 definition: the strategy is chosen per column
 * and the salt is optional, which the constrained template engine can't
 * express (it has no conditionals, on purpose).
 */

export type MaskStrategy = 'hash' | 'redact';

export interface MaskColumn {
  name: string;
  strategy: MaskStrategy;
  /** `redact` only: the literal written instead of the value. */
  redactValue?: string;
}

export interface MaskParams {
  sourceObject: string;
  targetObject: string;
  /** Columns copied unchanged, in order, before the masked ones. */
  passthrough: string[];
  columns: MaskColumn[];
  /**
   * `hash` only: a SQL expression giving the salt, e.g. `secret('pii', 'salt')`
   * (Databricks) or `$PII_SALT` (a Snowflake session variable). An identifier,
   * a variable or one function call with quoted arguments; never a literal secret.
   */
  saltExpression?: string;
  objectKind?: 'view' | 'table';
}

const IDENT = '^[A-Za-z_][A-Za-z0-9_$]*$';
/** An identifier, a `$`/`@`/`:` variable, or one function call whose arguments are quoted strings. */
export const SALT_EXPRESSION = /^([$@:]?[A-Za-z_][A-Za-z0-9_$.]*)(\(\s*('[^'\\]*'\s*(,\s*'[^'\\]*'\s*)*)?\))?$/;

const paramSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceObject', 'targetObject', 'passthrough', 'columns'],
  properties: {
    sourceObject: { type: 'string', minLength: 1 },
    targetObject: { type: 'string', minLength: 1 },
    objectKind: { type: 'string', enum: ['view', 'table'] },
    passthrough: { type: 'array', items: { type: 'string', pattern: IDENT } },
    columns: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'strategy'],
        properties: {
          name: { type: 'string', pattern: IDENT },
          strategy: { type: 'string', enum: ['hash', 'redact'] },
          redactValue: { type: 'string', maxLength: 64, pattern: "^[^']*$" }
        }
      }
    },
    saltExpression: { type: 'string', minLength: 1, maxLength: 200, pattern: SALT_EXPRESSION.source }
  }
};

const TEXT: Record<SqlDialect, string> = { snowflake: 'VARCHAR', spark_sql: 'STRING', google_sql: 'STRING', postgres: 'TEXT', tsql: 'VARCHAR(8000)', ansi: 'VARCHAR(4000)' };

/** SHA-256, lowercase hex, of a text expression. */
function sha256(text: string, dialect: SqlDialect): string {
  switch (dialect) {
    case 'snowflake': return `SHA2(${text}, 256)`;
    case 'spark_sql': return `sha2(${text}, 256)`;
    case 'google_sql': return `TO_HEX(SHA256(${text}))`;
    case 'postgres': return `encode(sha256(convert_to(${text}, 'UTF8')), 'hex')`;
    case 'tsql': return `LOWER(CONVERT(VARCHAR(64), HASHBYTES('SHA2_256', ${text}), 2))`;
    default: throw new Error('ANSI SQL has no hash function: compile the mask for a platform dialect (snowflake, spark_sql, google_sql, postgres, tsql).');
  }
}

export function maskExpression(c: MaskColumn, dialect: SqlDialect, salt?: string): string {
  if (c.strategy === 'redact') return `CASE WHEN ${c.name} IS NULL THEN NULL ELSE '${c.redactValue ?? '***'}' END`;
  const value = `CAST(${c.name} AS ${TEXT[dialect]})`;
  // Concatenation operators differ, and some treat NULL as empty: the CASE keeps NULL as NULL everywhere.
  const salted = salt ? `CONCAT(CAST(${salt} AS ${TEXT[dialect]}), ${value})` : value;
  return `CASE WHEN ${c.name} IS NULL THEN NULL ELSE ${sha256(salted, dialect)} END`;
}

function compile(params: MaskParams, _target: TargetEnvironmentSummary, dialect: SqlDialect = 'snowflake'): CompiledArtifact {
  const masked = new Set(params.columns.map((c) => c.name.toLowerCase()));
  const overlap = params.passthrough.filter((p) => masked.has(p.toLowerCase()));
  if (overlap.length) throw new Error(`Columns both passed through and masked: ${overlap.join(', ')}.`);
  const select = [...params.passthrough, ...params.columns.map((c) => `${maskExpression(c, dialect, params.saltExpression)} AS ${c.name}`)];
  const kind = params.objectKind === 'table' ? 'TABLE' : 'VIEW';
  const content = [
    `-- Masks ${params.columns.length} personal-data column(s) of ${params.sourceObject} (non-reversible).`,
    `CREATE OR REPLACE ${kind} ${params.targetObject} AS`,
    'SELECT',
    `  ${select.join(',\n  ')}`,
    `FROM ${params.sourceObject};`,
    ''
  ].join('\n');
  const how = (s: MaskStrategy) => params.columns.filter((c) => c.strategy === s).map((c) => c.name);
  const parts = [how('hash').length ? `hashed ${how('hash').join(', ')}${params.saltExpression ? ' (salted)' : ''}` : '', how('redact').length ? `redacted ${how('redact').join(', ')}` : ''].filter(Boolean);
  return { language: 'sql', content, summary: `Masked ${parts.join('; ')} from ${params.sourceObject} into ${params.targetObject}.` };
}

export const maskPrimitive: TransformPrimitive<MaskParams> = {
  kind: 'mask',
  description: 'Masks personal-data columns non-reversibly (hash: SHA-256 hex with an optional salt, keeps equality for joins; redact: a constant) in a view or table over the source; other columns pass through.',
  paramSchema,
  compile
};
