import * as vscode from 'vscode';
import { AgentExecutionContext, AgentExecutionResult, PlanStep } from '../../core/types';
import { ConnectionManager } from '../../dqm/ConnectionManager';
import { SchemaSnapshot } from '../../dqm/types';

/**
 * Source Assessment Agent
 *
 * Extracts schema metadata from the connected data platform and persists it
 * to the .ai-context/ knowledge graph. This agent is the entry point for
 * the Discover phase of the data engineering workflow.
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
    const msg = `Missing required credentials for ${platform}: ${missingFields.join(', ')}. Configure them in Settings → Connections.`;
    context.log(msg);
    return {
      success: false,
      message: msg,
      error: msg
    };
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
    context.log(`Source assessment failed: ${msg}`);
    return {
      success: false,
      message: `Source assessment failed: ${msg}`,
      error: msg
    };
  } finally {
    connectionManager.dispose();
  }
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