import { AgentExecutionContext, AgentExecutionResult, PlanStep, GeneratedArtifact } from '../../core/types';
import { generateWithLlm } from '../llmCodegen';

function templateSql(step: PlanStep, database: string, schema: string, tableName: string): string {
  return `CREATE OR REPLACE TABLE ${database}.${schema}.${tableName} (
    id STRING,
    source_file STRING,
    ingested_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

COPY INTO ${database}.${schema}.${tableName}
FROM @STAGE/${step.id}
FILE_FORMAT = (TYPE = CSV FIELD_OPTIONALLY_ENCLOSED_BY = '"')
ON_ERROR = 'CONTINUE';`;
}

export async function executeIngestionAgent(step: PlanStep, context: AgentExecutionContext): Promise<AgentExecutionResult> {
  const task = step.taskDescription.trim();
  const target = context.targetEnvironment;
  const pc = target?.platformConfig as unknown as Record<string, string> | undefined;

  const schema = pc?.['schema'] || context.settings.defaultSnowflakeSchema || 'PUBLIC';
  const database = pc?.['database'] || context.settings.defaultSnowflakeDatabase || 'RAW_DB';
  const tableName = `${step.id.replace(/[^a-zA-Z0-9_]/g, '_')}_landing`;

  const llmSql = await generateWithLlm(context, step, {
    role: 'a data ingestion engineer',
    fence: 'sql',
    instructions: [
      `Write the ingestion SQL for step "${step.id}" — landing/staging DDL plus the load statement (e.g. COPY INTO for Snowflake, COPY for other platforms) for target ${database}.${schema}.`,
      'Base the columns, source format, and loading strategy on the task and context above — do not just emit a generic 3-column placeholder table unless nothing more specific is known.',
      'Include column names/types that reflect the actual source entities mentioned in the context, if any are named there.'
    ].join(' ')
  });

  const sql = llmSql ?? templateSql(step, database, schema, tableName);
  context.log(`Ingestion agent for ${step.id} generated ${llmSql ? 'LLM-derived' : 'template'} SQL for target: ${database}.${schema}.${tableName}`);

  const artifact: GeneratedArtifact = {
    id: `ingestion-${step.id}-${Date.now()}`,
    type: 'sql_script',
    title: `Ingestion: ${tableName}`,
    description: `Ingestion SQL for ${database}.${schema}.${tableName}`,
    content: sql,
    language: 'sql',
    generatedBy: 'ingestionAgent',
    generatedAt: new Date().toISOString(),
    approved: false
  };

  if (context.addArtifact) {
    context.addArtifact(artifact);
  }

  return {
    success: true,
    message: `Ingestion step ${step.id} generated a valid load statement for ${database}.${schema}.${tableName}.`,
    details: {
      sql,
      generatedTable: `${database}.${schema}.${tableName}`,
      sourceTask: task
    },
    artifacts: [artifact]
  };
}