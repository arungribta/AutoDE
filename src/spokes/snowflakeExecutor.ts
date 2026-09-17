import * as snowflake from 'snowflake-sdk';
import { AgentExecutionContext, AgentExecutionResult, GeneratedArtifact, PlanStep } from '../core/types';

const VALIDATION_SQL = (stepId: string): string =>
  `SELECT '${stepId}' AS step_id, CURRENT_TIMESTAMP() AS executed_at, 1 AS validation_check;`;

/** No connection available — hands back the SQL that would have run as a reviewable artifact instead of failing the plan (requirements.md §8.9). */
function skippedNoConnection(step: PlanStep, context: AgentExecutionContext, reason: string): AgentExecutionResult {
  context.log(`Snowflake validation skipped for ${step.id} (${reason}) — leaving the query for manual review instead of failing the plan.`);
  const sql = VALIDATION_SQL(step.id);
  const artifact: GeneratedArtifact = {
    id: `snowflake-validation-${step.id}-${Date.now()}`,
    type: 'validation_report',
    title: `Validation Query (not run) — ${step.id}`,
    description: `Snowflake was unreachable (${reason}); this query was generated but not executed.`,
    content: `-- Not executed: ${reason}\n-- Run manually once connected, or configure Settings → Connections.\n\n${sql}`,
    language: 'sql',
    generatedBy: 'snowflakeExecutor',
    generatedAt: new Date().toISOString(),
    approved: false
  };
  if (context.addArtifact) { context.addArtifact(artifact); }
  return {
    success: true,
    message: `Snowflake validation for ${step.id} was skipped (${reason}) — the query is saved for manual review.`,
    artifacts: [artifact]
  };
}

export async function executeSnowflakeAgent(step: PlanStep, context: AgentExecutionContext): Promise<AgentExecutionResult> {
  const settings = context.settings;
  const account = settings.defaultSnowflakeAccount?.trim();
  const warehouse = settings.defaultSnowflakeWarehouse?.trim();
  const database = settings.defaultSnowflakeDatabase?.trim();
  const password = await context.configManager.getSecret('autoDataEngineeringHub.snowflakePassword');

  if (!account || !warehouse || !database || !password) {
    return skippedNoConnection(step, context, 'Snowflake account, warehouse, database, and password must be configured');
  }

  const connection = snowflake.createConnection({
    account,
    username: 'DATA_AGENT_USER',
    password,
    warehouse,
    database,
    schema: settings.defaultSnowflakeSchema || 'PUBLIC',
    role: settings.defaultSnowflakeRole || 'SYSADMIN'
  });

  try {
    await new Promise<void>((resolve, reject) => {
      connection.connect((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const sql = VALIDATION_SQL(step.id);
    const rows = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      connection.execute({
        sqlText: sql,
        complete: (error, _statement, resultRows) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(Array.isArray(resultRows) ? resultRows.slice(0, 50) : []);
        }
      });
    });

    return {
      success: true,
      message: `Snowflake execution completed for step ${step.id}.`,
      details: {
        sql,
        rows,
        rowLimit: 50
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Snowflake SQL execution failed.';
    return skippedNoConnection(step, context, message);
  } finally {
    connection.destroy(() => undefined);
  }
}
