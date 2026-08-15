import * as snowflake from 'snowflake-sdk';
import { AgentExecutionContext, AgentExecutionResult, PlanStep } from '../types';

export async function executeSnowflakeAgent(step: PlanStep, context: AgentExecutionContext): Promise<AgentExecutionResult> {
  const settings = context.settings;
  const account = settings.defaultSnowflakeAccount?.trim();
  const warehouse = settings.defaultSnowflakeWarehouse?.trim();
  const database = settings.defaultSnowflakeDatabase?.trim();
  const password = await context.configManager.getSecret('autoDataEngineeringHub.snowflakePassword');

  if (!account || !warehouse || !database || !password) {
    return {
      success: false,
      message: 'Snowflake connection settings are incomplete.',
      error: 'Snowflake account, warehouse, database, and password must be configured.'
    };
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

    const sql = `SELECT '${step.id}' AS step_id, CURRENT_TIMESTAMP() AS executed_at, 1 AS validation_check;`;
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
    return {
      success: false,
      message: `Snowflake query execution failed for step ${step.id}.`,
      error: message
    };
  } finally {
    connection.destroy(() => undefined);
  }
}
