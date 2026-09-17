import { TransformPrimitive, CompiledArtifact, TargetEnvironmentSummary } from '../types';

export interface IncrementalLoadParams {
  sourceObject: string;
  targetObject: string;
  /** Match/merge key column(s). */
  keyColumns: string[];
  /** Non-key columns to update on match and insert on no-match. */
  updateColumns: string[];
}

const paramSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceObject', 'targetObject', 'keyColumns', 'updateColumns'],
  properties: {
    sourceObject: { type: 'string', minLength: 1 },
    targetObject: { type: 'string', minLength: 1 },
    keyColumns: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    updateColumns: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }
  }
};

function compile(params: IncrementalLoadParams, _target: TargetEnvironmentSummary): CompiledArtifact {
  const onClause = params.keyColumns.map((k) => `tgt.${k} = src.${k}`).join(' AND ');
  const updateSet = params.updateColumns.map((c) => `tgt.${c} = src.${c}`).join(',\n    ');
  const insertColumns = [...params.keyColumns, ...params.updateColumns];
  const insertValues = insertColumns.map((c) => `src.${c}`).join(', ');
  const content = [
    `MERGE INTO ${params.targetObject} AS tgt`,
    `USING ${params.sourceObject} AS src`,
    `ON ${onClause}`,
    'WHEN MATCHED THEN UPDATE SET',
    `    ${updateSet}`,
    `WHEN NOT MATCHED THEN INSERT (${insertColumns.join(', ')})`,
    `  VALUES (${insertValues});`,
    ''
  ].join('\n');
  return {
    language: 'sql',
    content,
    summary: `Incrementally merged ${params.sourceObject} into ${params.targetObject} on (${params.keyColumns.join(', ')}).`
  };
}

export const incrementalLoadPrimitive: TransformPrimitive<IncrementalLoadParams> = {
  kind: 'incremental_load',
  description: 'Merges new/changed rows from a source object into a target table by key columns (upsert) — for incremental loads.',
  paramSchema,
  compile
};
