import { AgentExecutionContext, AgentExecutionResult, GeneratedArtifact, PlanStep } from '../core/types';
import { SECRET_KEYS } from '../core/extensionIdentity';
import { ConnectionManager } from '../dqm/ConnectionManager';
import { SnowflakeAdapter } from '../dqm/adapters/SnowflakeAdapter';

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

/**
 * Runs a validation query against Snowflake for real (Phase 3b), via the same
 * `SnowflakeAdapter` — and its execution-backend cascade — every other Snowflake
 * caller uses, rather than duplicating connection logic against `snowflake-sdk`
 * directly. The username is now whatever's configured (`defaultSnowflakeUsername`),
 * never the previously-hardcoded `DATA_AGENT_USER`.
 */
export async function executeSnowflakeAgent(step: PlanStep, context: AgentExecutionContext): Promise<AgentExecutionResult> {
  const settings = context.settings;
  const credentials = ConnectionManager.getCredentialsFromSettings('snowflake', settings as unknown as Record<string, unknown>);
  const password = await context.configManager.getSecret(SECRET_KEYS.snowflakePassword);
  if (password) credentials['password'] = password;
  const passphrase = await context.configManager.getSecret(SECRET_KEYS.snowflakePrivateKeyPassphrase);
  if (passphrase) credentials['privateKeyPassphrase'] = passphrase;

  if (!credentials['account'] || !credentials['username'] || !credentials['database']) {
    return skippedNoConnection(step, context, 'Snowflake account, username, and database must be configured');
  }

  const adapter = new SnowflakeAdapter(credentials, (msg) => context.log(msg));
  try {
    await adapter.connect();
    const sql = VALIDATION_SQL(step.id);
    const result = await adapter.executeQuery(sql, { maxRows: 50 });

    return {
      success: true,
      message: `Snowflake execution completed for step ${step.id}.`,
      details: {
        sql,
        rows: result.rows,
        rowLimit: 50
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Snowflake SQL execution failed.';
    return skippedNoConnection(step, context, message);
  } finally {
    adapter.dispose();
  }
}
