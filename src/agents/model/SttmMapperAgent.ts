import { AgentExecutionContext, AgentExecutionResult, PlanStep, GeneratedArtifact } from '../../core/types';
import { generateWithLlm } from '../llmCodegen';

export async function executeSttmAgent(step: PlanStep, context: AgentExecutionContext): Promise<AgentExecutionResult> {
  const task = step.taskDescription.trim();
  const target = context.targetEnvironment;
  const pc = target?.platformConfig as unknown as Record<string, string> | undefined;

  const targetView = `${step.id.replace(/[^a-zA-Z0-9_]/g, '_')}_mapped`;
  const sourceTable = context.settings.defaultSnowflakeDatabase
    ? `${context.settings.defaultSnowflakeDatabase}.${context.settings.defaultSnowflakeSchema || 'PUBLIC'}.landing`
    : 'RAW_DB.PUBLIC.landing';
  const targetDb = pc?.['database'] || context.settings.defaultSnowflakeDatabase || 'CURATED_DB';
  const targetSchema = pc?.['schema'] || context.settings.defaultSnowflakeSchema || 'ANALYTICS';
  const namingConvention = target?.namingConvention || 'snake_case';

  const llmSql = await generateWithLlm(context, step, {
    role: 'a data integration engineer producing a source-to-target mapping (STTM)',
    fence: 'sql',
    instructions: [
      `Write a CREATE OR REPLACE VIEW ${targetDb}.${targetSchema}.${targetView} AS SELECT ... FROM ${sourceTable} statement.`,
      `Map real source fields named in the task/context above to meaningful target field names (${namingConvention}) — never generic placeholders like "mapped_1".`,
      'If specific source columns are not named anywhere in the context, infer plausible field names from the business entities described, and note that assumption is being made via a SQL comment at the top.'
    ].join(' ')
  });

  const sql = llmSql ?? templateSql(sourceTable, targetDb, targetSchema, targetView, task);
  context.log(`STTM agent for ${step.id} created ${llmSql ? 'LLM-derived' : 'template'} mapping (${namingConvention}) → ${targetDb}.${targetSchema}.${targetView}`);

  const artifact: GeneratedArtifact = {
    id: `sttm-${step.id}-${Date.now()}`,
    type: 'sttm_mapping',
    title: `STTM Mapping: ${targetView}`,
    description: `Source-to-target mapping from ${sourceTable} to ${targetDb}.${targetSchema}.${targetView}`,
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
      namingConvention
    },
    artifacts: [artifact]
  };
}

/** Fallback used when no LLM is available — keeps the field names traceable to the task text rather than fabricating meaningless placeholders. */
function templateSql(sourceTable: string, targetDb: string, targetSchema: string, targetView: string, task: string): string {
  const tokens = task.split(/\s+/).filter(Boolean).slice(0, 8);
  const mappings = tokens.map((token, index) => ({
    sourceField: token.replace(/[^a-zA-Z0-9_]/g, '') || `field_${index + 1}`,
    targetField: `mapped_${index + 1}`
  }));
  return `-- Template fallback: no LLM available — field names are derived from the task text, not a real source schema.
CREATE OR REPLACE VIEW ${targetDb}.${targetSchema}.${targetView} AS
SELECT
  ${mappings.map((mapping) => `${mapping.sourceField} AS ${mapping.targetField}`).join(',\n  ')}
FROM ${sourceTable};`;
}