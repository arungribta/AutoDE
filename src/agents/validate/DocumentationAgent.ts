import { AgentExecutionContext, AgentExecutionResult, PlanStep } from '../../core/types';

export async function executeArchitectureAgent(step: PlanStep, context: AgentExecutionContext): Promise<AgentExecutionResult> {
  const schema = context.settings.defaultSnowflakeSchema || 'PUBLIC';
  const database = context.settings.defaultSnowflakeDatabase || 'CURATED_DB';
  const tableName = `${step.id.replace(/[^a-zA-Z0-9_]/g, '_')}_curated`;

  const ddl = `CREATE OR REPLACE TABLE ${database}.${schema}.${tableName} (
    id STRING,
    run_id STRING,
    created_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    payload VARIANT
);

CREATE OR REPLACE VIEW ${database}.${schema}.${tableName}_view AS
SELECT * FROM ${database}.${schema}.${tableName};`;

  context.log(`Architecture agent for ${step.id} produced Snowflake DDL.`);

  return {
    success: true,
    message: `Architecture step ${step.id} generated Snowflake DDL successfully.`,
    details: {
      ddl,
      tableName: `${database}.${schema}.${tableName}`
    }
  };
}