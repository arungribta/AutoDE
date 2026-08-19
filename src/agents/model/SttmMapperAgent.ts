import { AgentExecutionContext, AgentExecutionResult, PlanStep, GeneratedArtifact } from '../../core/types';

export async function executeSttmAgent(step: PlanStep, context: AgentExecutionContext): Promise<AgentExecutionResult> {
  const task = step.taskDescription.trim();
  const tokens = task.split(/\s+/).filter(Boolean).slice(0, 8);
  const target = context.targetEnvironment;
  const pc = target?.platformConfig as unknown as Record<string, string> | undefined;

  const mappings = tokens.map((token, index) => ({
    sourceField: token.replace(/[^a-zA-Z0-9_]/g, ''),
    targetField: `mapped_${index + 1}`
  }));

  const targetView = `${step.id.replace(/[^a-zA-Z0-9_]/g, '_')}_mapped`;
  const sourceTable = context.settings.defaultSnowflakeDatabase
    ? `${context.settings.defaultSnowflakeDatabase}.${context.settings.defaultSnowflakeSchema || 'PUBLIC'}.landing`
    : 'RAW_DB.PUBLIC.landing';
  const targetDb = pc?.['database'] || context.settings.defaultSnowflakeDatabase || 'CURATED_DB';
  const targetSchema = pc?.['schema'] || context.settings.defaultSnowflakeSchema || 'ANALYTICS';

  const sql = `CREATE OR REPLACE VIEW ${targetDb}.${targetSchema}.${targetView} AS
SELECT
  ${mappings.map((mapping) => `${mapping.sourceField} AS ${mapping.targetField}`).join(',\n  ')}
FROM ${sourceTable};`;

  const namingConvention = target?.namingConvention || 'snake_case';
  context.log(`STTM agent for ${step.id} created mapping (${namingConvention}) → ${targetDb}.${targetSchema}.${targetView}`);

  const artifact: GeneratedArtifact = {
    id: `sttm-${step.id}-${Date.now()}`,
    type: 'sttm_mapping',
    title: `STTM Mapping: ${targetView}`,
    description: `Source-to-target mapping from ${sourceTable} to ${targetDb}.${targetSchema}.${targetView} (${mappings.length} columns)`,
    content: sql,
    language: 'sql',
    generatedBy: 'sttmAgent',
    generatedAt: new Date().toISOString(),
    approved: false
  };

  if (context.addArtifact) {
    context.addArtifact(artifact);
  }

  return {
    success: true,
    message: `STTM step ${step.id} calculated a source-to-target mapping for ${targetDb}.${targetSchema}.${targetView}.`,
    details: {
      sql,
      targetView,
      targetDb,
      targetSchema,
      mappings,
      namingConvention
    },
    artifacts: [artifact]
  };
}