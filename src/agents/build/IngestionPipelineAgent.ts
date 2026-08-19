import { AgentExecutionContext, AgentExecutionResult, PlanStep, GeneratedArtifact } from '../../core/types';

export async function executeIngestionAgent(step: PlanStep, context: AgentExecutionContext): Promise<AgentExecutionResult> {
  const task = step.taskDescription.trim();
  const target = context.targetEnvironment;
  const pc = target?.platformConfig as unknown as Record<string, string> | undefined;

  const schema = pc?.['schema'] || context.settings.defaultSnowflakeSchema || 'PUBLIC';
  const database = pc?.['database'] || context.settings.defaultSnowflakeDatabase || 'RAW_DB';
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

  context.log(`Ingestion agent for ${step.id} generated SQL for target: ${database}.${schema}.${tableName}`);

  const artifact: GeneratedArtifact = {
    id: `ingestion-${step.id}-${Date.now()}`,
    type: 'sql_script',
    title: `Ingestion: ${tableName}`,
    description: `COPY INTO statement for ${database}.${schema}.${tableName}`,
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
    message: `Ingestion step ${step.id} generated a valid COPY statement for ${database}.${schema}.${tableName}.`,
    details: {
      sql,
      generatedTable: `${database}.${schema}.${tableName}`,
      sourceTask: task
    },
    artifacts: [artifact]
  };
}