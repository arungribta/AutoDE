import { TransformPrimitive, CompiledArtifact, TargetEnvironmentSummary, SqlDialect } from '../types';

export interface DedupParams {
  sourceObject: string;
  targetObject: string;
  partitionByColumns: string[];
  orderByColumn: string;
  orderDirection?: 'ASC' | 'DESC';
  objectKind?: 'view' | 'table';
}

const paramSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceObject', 'targetObject', 'partitionByColumns', 'orderByColumn'],
  properties: {
    sourceObject: { type: 'string', minLength: 1 },
    targetObject: { type: 'string', minLength: 1 },
    objectKind: { type: 'string', enum: ['view', 'table'] },
    partitionByColumns: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    orderByColumn: { type: 'string', minLength: 1 },
    orderDirection: { type: 'string', enum: ['ASC', 'DESC'] }
  }
};

/** Snowflake supports `EXCLUDE`; most other dialects (Spark SQL, BigQuery, Postgres) use `EXCEPT`. */
function excludeClause(dialect: SqlDialect, column: string): string {
  return dialect === 'snowflake' ? `* EXCLUDE (${column})` : `* EXCEPT (${column})`;
}

function compile(params: DedupParams, _target: TargetEnvironmentSummary, dialect: SqlDialect): CompiledArtifact {
  const objectKind = params.objectKind === 'table' ? 'TABLE' : 'VIEW';
  const direction = params.orderDirection ?? 'DESC';
  const rankColumn = '__dedup_rn';
  const content = [
    `CREATE OR REPLACE ${objectKind} ${params.targetObject} AS`,
    'WITH ranked AS (',
    '  SELECT *,',
    `    ROW_NUMBER() OVER (PARTITION BY ${params.partitionByColumns.join(', ')} ORDER BY ${params.orderByColumn} ${direction}) AS ${rankColumn}`,
    `  FROM ${params.sourceObject}`,
    ')',
    `SELECT ${excludeClause(dialect, rankColumn)} FROM ranked WHERE ${rankColumn} = 1;`,
    ''
  ].join('\n');
  return {
    language: 'sql',
    content,
    summary: `Deduplicated ${params.sourceObject} into ${params.targetObject}, keeping one row per (${params.partitionByColumns.join(', ')}) ordered by ${params.orderByColumn} ${direction}.`
  };
}

export const dedupPrimitive: TransformPrimitive<DedupParams> = {
  kind: 'dedup',
  description: 'Deduplicates rows from a source object by a partition key, keeping one row per partition ordered by a given column (e.g. latest by updated_at).',
  paramSchema,
  compile
};
