import * as vscode from 'vscode';
import { AgentExecutionContext, AgentExecutionResult, GeneratedArtifact, PlanStep } from '../../core/types';
import { ConnectionManager } from '../../dqm/ConnectionManager';
import { SchemaSnapshot } from '../../dqm/types';

/**
 * Source Assessment Agent
 *
 * Extracts schema metadata from the connected data platform and persists it
 * to the .ai-context/ knowledge graph. This agent is the entry point for
 * the Discover phase of the data engineering workflow.
 *
 * A missing/unreachable connection does NOT fail the step outright — the
 * approved spec and synced Context Layer (`context.schemaContext`, merged in
 * by `generatePlan`/`generatePlanFromSpec`) usually already carry real source
 * information (a registered data contract, business context, source
 * catalog entries). This agent falls back to a context-derived assessment
 * artifact in that case rather than blocking the whole plan on connectivity —
 * see `requirements.md` §8.9 ("artifact generation should not be blocked
 * solely because a target platform connection is unavailable").
 */
export async function executeSourceAssessmentAgent(
  step: PlanStep,
  context: AgentExecutionContext
): Promise<AgentExecutionResult> {
  context.log(`Source Assessment agent starting for step ${step.id}...`);

  const settings = context.settings;
  const platform = settings.defaultProvider ?? 'snowflake';

  // Build credentials from settings
  const credentials = ConnectionManager.getCredentialsFromSettings(platform, settings as unknown as Record<string, unknown>);

  // Validate required credentials
  const missingFields = validateCredentials(platform, credentials);
  if (missingFields.length > 0) {
    return buildContextOnlyAssessment(step, context, platform, missingFields);
  }

  // Retrieve secrets for sensitive fields
  try {
    if (platform === 'snowflake') {
      const password = await context.configManager.getSecret('autoDataEngineeringHub.snowflakePassword');
      if (password) {
        credentials['password'] = password;
      }
      const passphrase = await context.configManager.getSecret('autoDataEngineeringHub.snowflakePrivateKeyPassphrase');
      if (passphrase) {
        credentials['passphrase'] = passphrase;
      }
    } else if (platform === 'databricks') {
      const token = await context.configManager.getSecret('autoDataEngineeringHub.databricksToken');
      if (token) {
        credentials['token'] = token;
      }
    }
  } catch (err) {
    context.log(`Warning: Could not retrieve secrets: ${err instanceof Error ? err.message : String(err)}`);
  }

  const connectionManager = new ConnectionManager((msg: string) => context.log(msg));

  try {
    // Connect to the platform
    context.log(`Connecting to ${platform}...`);
    const connectionInfo = await connectionManager.connect(platform, credentials);
    context.log(`Connected to ${platform}: ${connectionInfo.databaseName}.${connectionInfo.schemaName} (v${connectionInfo.version})`);

    // Extract metadata
    context.log(`Extracting metadata from ${platform}...`);
    const snapshot: SchemaSnapshot = await connectionManager.extractMetadata({
      includeProfiling: true
    });

    context.log(
      `Metadata extraction complete: ${snapshot.tables.length} tables, ` +
      `${snapshot.views.length} views, ${snapshot.foreignKeys.length} foreign keys` +
      (snapshot.lineage ? `, ${snapshot.lineage.length} lineage edges` : '')
    );

    // Persist to .ai-context/
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (workspaceRoot) {
      await connectionManager.persistSchemaContext(snapshot, workspaceRoot);
      context.log('Schema context persisted to .ai-context/schema-graph.json');
    } else {
      context.log('Warning: No workspace folder found. Schema context was not persisted to disk.');
    }

    // Build summary
    const tableNames = snapshot.tables.map((t) => t.fqn).slice(0, 20);
    const summary = {
      platform,
      database: connectionInfo.databaseName,
      schema: connectionInfo.schemaName,
      tableCount: snapshot.tables.length,
      viewCount: snapshot.views.length,
      fkCount: snapshot.foreignKeys.length,
      lineageCount: snapshot.lineage?.length ?? 0,
      sampleTables: tableNames,
      moreTablesAvailable: snapshot.tables.length > 20
    };

    return {
      success: true,
      message: `Source assessment complete: ${snapshot.tables.length} tables, ${snapshot.views.length} views discovered in ${connectionInfo.databaseName}.${connectionInfo.schemaName}.`,
      details: summary
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    context.log(`Could not connect to ${platform} (${msg}) — falling back to a context-derived assessment.`);
    return buildContextOnlyAssessment(step, context, platform, [], msg);
  } finally {
    connectionManager.dispose();
  }
}

/**
 * Produces a "Source Assessment (Context-Derived)" report from whatever the
 * approved spec and synced Context Layer already know, instead of failing
 * the step outright when live connectivity isn't available or didn't work.
 * Returns `success: true` — the plan can proceed, and the report tells the
 * user exactly what would sharpen it (connect, or register source context).
 */
function buildContextOnlyAssessment(
  step: PlanStep,
  context: AgentExecutionContext,
  platform: string,
  missingCredentialFields: string[],
  connectionError?: string
): AgentExecutionResult {
  const reason = connectionError
    ? `A connection to ${platform} was attempted but failed: ${connectionError}`
    : `Missing required credentials for ${platform}: ${missingCredentialFields.join(', ')}.`;
  context.log(`${reason} Proceeding with a context-derived source assessment instead of failing the plan.`);

  const knownContext = context.schemaContext && context.schemaContext.trim().length > 0
    ? context.schemaContext.trim()
    : '_No source-environment context has been registered or synthesized yet._';

  const content = [
    '# Source Assessment (Context-Derived)',
    '',
    `**Live connectivity to ${platform} was not available.** ${reason}`,
    '',
    'This assessment is based on the approved specification and the synced Context Layer only — not a live schema scan.',
    '',
    '## Known Source Context',
    knownContext,
    '',
    '## To Refine This Assessment',
    `- Connect to ${platform} in Settings → Connections for a live schema scan (tables, columns, foreign keys, lineage).`,
    '- Or register source-side context directly — a data contract / interface document (Context Sources → "Data Definitions"), or business context notes — so this report reflects it without needing a live connection.'
  ].join('\n');

  const artifact: GeneratedArtifact = {
    id: `source-assessment-${step.id}-${Date.now()}`,
    type: 'discovery_report',
    title: 'Source Assessment (Context-Derived)',
    description: `Source assessment for ${step.id}, derived from the approved specification and Context Layer (no live ${platform} connection).`,
    content,
    language: 'markdown',
    generatedBy: 'sourceAssessmentAgent',
    generatedAt: new Date().toISOString(),
    approved: false
  };

  if (context.addArtifact) {
    context.addArtifact(artifact);
  }

  return {
    success: true,
    message: `Source assessment completed from the approved specification and Context Layer (no live ${platform} connection).`,
    artifacts: [artifact]
  };
}

function validateCredentials(platform: string, credentials: Record<string, string>): string[] {
  const missing: string[] = [];

  switch (platform) {
    case 'snowflake':
      if (!credentials['account']) missing.push('Account');
      if (!credentials['username']) missing.push('Username');
      if (!credentials['warehouse']) missing.push('Warehouse');
      if (!credentials['database']) missing.push('Database');
      break;
    case 'databricks':
      if (!credentials['workspaceUrl']) missing.push('Workspace URL');
      if (!credentials['catalog']) missing.push('Catalog');
      break;
    default:
      break;
  }

  return missing;
}