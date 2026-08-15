import { AgentExecutionContext, AgentExecutionResult, PlanStep } from '../../../core/types';

export async function executeIngestionAgent(step: PlanStep, context: AgentExecutionContext): Promise<AgentExecutionResult> {
  const task = step.taskDescription.trim();
  const schema = context.settings.defaultSnowflakeSchema || 'PUBLIC';
  const database = context.settings.defaultSnowflakeDatabase || 'RAW_DB';
  const tableName = `${step.id.replace(/[^a-zA-Z0-9_]/g, '_')}_landing`;

  const sql = `CREATE OR REPLACE TABLE ${database}.${schema}.${tableName} (
    id STRING,
    source_file STRING,
    ingested_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

COPY INTO ${database}.${schema}.${tableName}
FROM @STAGE/${step.id}
FILE_FORMAT = (TYPE = CSV FIELD_OPTIONALLY_ENCLOSED_BY = '"')
ON_ERROR = 'CONTINUE';`;

  context.log(`Ingestion spoke for ${step.id} generated SQL statement for task: ${task}`);

  return {
    success: true,
    message: `Ingestion step ${step.id} generated a valid COPY statement.`,
    details: {
      sql,
      generatedTable: `${database}.${schema}.${tableName}`,
      sourceTask: task
    }
  };
}
