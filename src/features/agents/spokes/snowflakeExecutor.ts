import { AgentExecutionContext, AgentExecutionResult, PlanStep } from '../../../core/types';
import { buildSnowflakeConnectionOptions, validateSnowflakeSettings } from '../../providers/snowflake/snowflakeConnectionManager';

export async function executeSnowflakeAgent(step: PlanStep, context: AgentExecutionContext): Promise<AgentExecutionResult> {
  const settings = context.settings;
  const validation = validateSnowflakeSettings(settings);
  const password = await context.configManager.getSecret('autoDataEngineeringHub.snowflakePassword');
  const privateKeyPassphrase = await context.configManager.getSecret('autoDataEngineeringHub.snowflakePrivateKeyPassphrase');

  if (!validation.valid) {
    return {
      success: false,
      message: 'Snowflake connection settings are incomplete or invalid.',
      error: validation.errors.join(' ')
    };
  }

  if (settings.defaultSnowflakeAuthMode === 'username-password' && (!password || password.trim().length === 0)) {
    return {
      success: false,
      message: 'Snowflake password is missing.',
      error: 'Username + password authentication requires a saved password in SecretStorage.'
    };
  }

  if (settings.defaultSnowflakeAuthMode === 'key-pair') {
    context.log(`Using key-pair authentication for Snowflake step ${step.id}.`);
  }

  let snowflake: any;
  try {
    snowflake = require('snowflake-sdk');
  } catch (err) {
    return {
      success: false,
      message: 'Snowflake SDK is not available in this installation.',
      error: `Missing dependency: snowflake-sdk - ${err instanceof Error ? err.message : String(err)}`
    };
  }

  const connectionConfig = buildSnowflakeConnectionOptions(settings, password, privateKeyPassphrase);
  const connection = snowflake.createConnection(connectionConfig);

  try {
    await new Promise<void>((resolve, reject) => {
      connection.connect((error: Error | undefined) => {
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
        complete: (error: Error | null, _statement?: unknown, resultRows?: unknown) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(Array.isArray(resultRows) ? (resultRows as Array<Record<string, unknown>>).slice(0, 50) : []);
        }
      });
    });

    return {
      success: true,
      message: `Snowflake execution completed for step ${step.id}.`,
      details: {
        sql,
        rows,
        rowLimit: 50,
        validationWarnings: validation.warnings
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
    try {
      connection.destroy(() => undefined);
    } catch (_e) {
      // ignore cleanup failures
    }
  }
}
