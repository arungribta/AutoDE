import { AgentExecutionContext, AgentExecutionResult, PlanStep } from '../types';

export async function executeSttmAgent(step: PlanStep, context: AgentExecutionContext): Promise<AgentExecutionResult> {
  const task = step.taskDescription.trim();
  const tokens = task.split(/\s+/).filter(Boolean).slice(0, 8);
  const mappings = tokens.map((token, index) => ({
    sourceField: token.replace(/[^a-zA-Z0-9_]/g, ''),
    targetField: `mapped_${index + 1}`
  }));

  const targetView = `${step.id.replace(/[^a-zA-Z0-9_]/g, '_')}_mapped`;
  const sourceTable = context.settings.defaultSnowflakeDatabase ? `${context.settings.defaultSnowflakeDatabase}.${context.settings.defaultSnowflakeSchema || 'PUBLIC'}.landing` : 'RAW_DB.PUBLIC.landing';

  const sql = `CREATE OR REPLACE VIEW ${sourceTable.replace(/\.landing$/, '')}.${targetView} AS
SELECT
  ${mappings.map((mapping) => `${mapping.sourceField} AS ${mapping.targetField}`).join(',\n  ')}
FROM ${sourceTable};`;

  context.log(`STTM spoke for ${step.id} created a transformation mapping.`);

  return {
    success: true,
    message: `STTM step ${step.id} calculated a source-to-target mapping.`,
    details: {
      sql,
      targetView,
      mappings
    }
  };
}
