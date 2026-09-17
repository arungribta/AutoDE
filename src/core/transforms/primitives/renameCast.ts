import { TransformPrimitive, CompiledArtifact, TargetEnvironmentSummary } from '../types';

export interface RenameCastColumn {
  source: string;
  target: string;
  /** SQL type to cast to, e.g. 'STRING', 'DECIMAL(10,2)'. Omit to pass the column through untyped. */
  type?: string;
}

export interface RenameCastParams {
  /**
   * 'view'/'table': a fully-qualified source object (e.g. "RAW_DB.PUBLIC.raw_orders").
   * 'dbt_model': "schema_name.table_name" — used to build a dbt `{{ source(...) }}` reference.
   */
  sourceObject: string;
  /**
   * 'view'/'table': a fully-qualified target object.
   * 'dbt_model': the target model's name — used only in the header comment (the file path is
   * decided by the caller, not this primitive).
   */
  targetObject: string;
  columns: RenameCastColumn[];
  objectKind?: 'view' | 'table' | 'dbt_model';
}

const paramSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceObject', 'targetObject', 'columns'],
  properties: {
    sourceObject: { type: 'string', minLength: 1 },
    targetObject: { type: 'string', minLength: 1 },
    objectKind: { type: 'string', enum: ['view', 'table', 'dbt_model'] },
    columns: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'target'],
        properties: {
          source: { type: 'string', minLength: 1 },
          target: { type: 'string', minLength: 1 },
          type: { type: 'string', minLength: 1 }
        }
      }
    }
  }
};

function selectList(columns: RenameCastColumn[], indent: string): string {
  return columns
    .map((c) => (c.type ? `${c.source}::${c.type} AS ${c.target}` : `${c.source} AS ${c.target}`))
    .join(`,\n${indent}`);
}

/** Splits "schema.table" for a dbt `{{ source(...) }}` reference; tolerates a bare table name. */
function splitSourceRef(sourceObject: string): { schemaName: string; tableName: string } {
  const parts = sourceObject.split('.');
  if (parts.length >= 2) {
    return { schemaName: parts[parts.length - 2], tableName: parts[parts.length - 1] };
  }
  return { schemaName: 'staging', tableName: sourceObject };
}

function compile(params: RenameCastParams, _target: TargetEnvironmentSummary): CompiledArtifact {
  const columnCount = params.columns.length;

  if (params.objectKind === 'dbt_model') {
    const { schemaName, tableName } = splitSourceRef(params.sourceObject);
    const content = [
      `-- Staging model: ${params.sourceObject} -> ${params.targetObject}`,
      '',
      'WITH source AS (',
      `    SELECT * FROM {{ source('${schemaName}', '${tableName}') }}`,
      '),',
      '',
      'renamed AS (',
      `    SELECT`,
      `        ${selectList(params.columns, '        ')}`,
      '    FROM source',
      ')',
      '',
      'SELECT * FROM renamed',
      ''
    ].join('\n');
    return {
      language: 'sql',
      content,
      summary: `Renamed/cast ${columnCount} column(s) from ${params.sourceObject} into dbt staging model ${params.targetObject}.`
    };
  }

  const objectKind = params.objectKind === 'table' ? 'TABLE' : 'VIEW';
  const content = `CREATE OR REPLACE ${objectKind} ${params.targetObject} AS\nSELECT\n  ${selectList(params.columns, '  ')}\nFROM ${params.sourceObject};\n`;
  return {
    language: 'sql',
    content,
    summary: `Renamed/cast ${columnCount} column(s) from ${params.sourceObject} into ${params.targetObject}.`
  };
}

export const renameCastPrimitive: TransformPrimitive<RenameCastParams> = {
  kind: 'rename_cast',
  description: 'Renames and optionally type-casts columns from a source object into a target view/table (or a dbt staging model) — for landing/staging layers.',
  paramSchema,
  compile
};
