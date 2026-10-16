import * as vscode from 'vscode';
import { CONFIG_SECTION, SECRET_KEYS } from './extensionIdentity';
import { DataAgentHubSettings, DataPlatformProvider, LlmProvider, SnowflakeAuthMode } from '../engine/types';

export class ConfigurationManager {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public getExtensionContext(): vscode.ExtensionContext {
    return this.context;
  }

  public getSettings(): DataAgentHubSettings {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

    return {
      extensionDisplayName: config.get<string>('extensionDisplayName', 'Auto Data Engineering Hub'),
      extensionDescription: config.get<string>('extensionDescription', 'Plan and execute AI-powered data engineering workflows with Snowflake and modern data platform orchestration.'),
      defaultProvider: config.get<DataPlatformProvider>('defaultProvider', 'snowflake'),
      defaultSnowflakeAccount: config.get<string>('defaultSnowflakeAccount', ''),
      defaultSnowflakeUsername: config.get<string>('defaultSnowflakeUsername', ''),
      defaultSnowflakeWarehouse: config.get<string>('defaultSnowflakeWarehouse', ''),
      defaultSnowflakeDatabase: config.get<string>('defaultSnowflakeDatabase', ''),
      defaultSnowflakeSchema: config.get<string>('defaultSnowflakeSchema', 'PUBLIC'),
      defaultSnowflakeRole: config.get<string>('defaultSnowflakeRole', 'SYSADMIN'),
      defaultSnowflakeAuthMode: config.get<SnowflakeAuthMode>('defaultSnowflakeAuthMode', 'key-pair'),
      snowflakePrivateKeyPath: config.get<string>('snowflakePrivateKeyPath', ''),
      metadataCachingDurationMinutes: config.get<number>('metadataCachingDurationMinutes', 15),
      queryTimeoutSeconds: config.get<number>('queryTimeoutSeconds', 120),
      readOnlyMode: config.get<boolean>('readOnlyMode', true),
      enableSessionReuse: config.get<boolean>('enableSessionReuse', true),
      autoDocumentationEnabled: config.get<boolean>('autoDocumentationEnabled', true),
      telemetryEnabled: config.get<boolean>('telemetryEnabled', false),
      activeLlmProvider: config.get<LlmProvider>('activeLlmProvider', 'copilot'),
      activeLlmModel: config.get<string>('activeLlmModel', 'gpt-4o-mini'),
      llmEndpoint: config.get<string>('llmEndpoint', ''),
      artifactDirectory: config.get<string>('artifactDirectory', 'artifacts'),
      languageModelProgrammaticConsent: config.get<boolean>('languageModelProgrammaticConsent', false),
      copilotProgrammaticConsent: config.get<boolean>('copilotProgrammaticConsent', false),
      claudeCodePath: config.get<string>('claudeCodePath', ''),
      primitiveManagementEnabled: config.get<boolean>('primitiveManagementEnabled', false),
      toolSkillManagementEnabled: config.get<boolean>('toolSkillManagementEnabled', false),
      dataPlatformCliConsent: config.get<boolean>('dataPlatformCliConsent', false),
      snowflakeCliPath: config.get<string>('snowflakeCliPath', ''),
      databricksCliPath: config.get<string>('databricksCliPath', ''),
      serviceAccountCredentialRef: config.get<string>('serviceAccountCredentialRef', ''),
      defaultDatabricksWorkspaceUrl: config.get<string>('defaultDatabricksWorkspaceUrl', ''),
      defaultDatabricksHttpPath: config.get<string>('defaultDatabricksHttpPath', ''),
      defaultDatabricksCatalog: config.get<string>('defaultDatabricksCatalog', 'main'),
      defaultDatabricksSchema: config.get<string>('defaultDatabricksSchema', 'default'),
      defaultDatabricksCatalogType: config.get<'auto' | 'unity' | 'hive_metastore'>('defaultDatabricksCatalogType', 'auto'),

      // ── Target connection (v0.19.0) — see DataAgentHubSettings' own doc comment ──
      defaultTargetProvider: config.get<DataPlatformProvider>('defaultTargetProvider', 'snowflake'),
      defaultTargetSnowflakeAccount: config.get<string>('defaultTargetSnowflakeAccount', ''),
      defaultTargetSnowflakeUsername: config.get<string>('defaultTargetSnowflakeUsername', ''),
      defaultTargetSnowflakeWarehouse: config.get<string>('defaultTargetSnowflakeWarehouse', ''),
      defaultTargetSnowflakeDatabase: config.get<string>('defaultTargetSnowflakeDatabase', ''),
      defaultTargetSnowflakeSchema: config.get<string>('defaultTargetSnowflakeSchema', 'PUBLIC'),
      defaultTargetSnowflakeRole: config.get<string>('defaultTargetSnowflakeRole', 'SYSADMIN'),
      defaultTargetSnowflakeAuthMode: config.get<SnowflakeAuthMode>('defaultTargetSnowflakeAuthMode', 'key-pair'),
      targetSnowflakePrivateKeyPath: config.get<string>('targetSnowflakePrivateKeyPath', ''),
      targetSnowflakeCliPath: config.get<string>('targetSnowflakeCliPath', ''),
      targetDatabricksCliPath: config.get<string>('targetDatabricksCliPath', ''),
      defaultTargetDatabricksWorkspaceUrl: config.get<string>('defaultTargetDatabricksWorkspaceUrl', ''),
      defaultTargetDatabricksHttpPath: config.get<string>('defaultTargetDatabricksHttpPath', ''),
      defaultTargetDatabricksCatalog: config.get<string>('defaultTargetDatabricksCatalog', 'main'),
      defaultTargetDatabricksSchema: config.get<string>('defaultTargetDatabricksSchema', 'default'),
      defaultTargetDatabricksCatalogType: config.get<'auto' | 'unity' | 'hive_metastore'>('defaultTargetDatabricksCatalogType', 'auto')
    };
  }

  public async updateSettings(settings: Partial<DataAgentHubSettings>): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

    const updates: Array<readonly [string, unknown]> = [
     ['extensionDisplayName', settings.extensionDisplayName],
     ['extensionDescription', settings.extensionDescription],
     ['defaultProvider', settings.defaultProvider],
     ['defaultSnowflakeAccount', settings.defaultSnowflakeAccount],
     ['defaultSnowflakeUsername', settings.defaultSnowflakeUsername],
     ['defaultSnowflakeWarehouse', settings.defaultSnowflakeWarehouse],
     ['defaultSnowflakeDatabase', settings.defaultSnowflakeDatabase],
     ['defaultSnowflakeSchema', settings.defaultSnowflakeSchema],
     ['defaultSnowflakeRole', settings.defaultSnowflakeRole],
     ['defaultSnowflakeAuthMode', settings.defaultSnowflakeAuthMode],
     ['snowflakePrivateKeyPath', settings.snowflakePrivateKeyPath],
     ['metadataCachingDurationMinutes', settings.metadataCachingDurationMinutes],
     ['queryTimeoutSeconds', settings.queryTimeoutSeconds],
     ['readOnlyMode', settings.readOnlyMode],
     ['enableSessionReuse', settings.enableSessionReuse],
     ['autoDocumentationEnabled', settings.autoDocumentationEnabled],
     ['telemetryEnabled', settings.telemetryEnabled],
     ['activeLlmProvider', settings.activeLlmProvider],
     ['activeLlmModel', settings.activeLlmModel],
     ['llmEndpoint', settings.llmEndpoint],
     ['artifactDirectory', settings.artifactDirectory],
     ['languageModelProgrammaticConsent', settings.languageModelProgrammaticConsent],
     ['copilotProgrammaticConsent', settings.copilotProgrammaticConsent],
     ['claudeCodePath', settings.claudeCodePath],
     ['primitiveManagementEnabled', settings.primitiveManagementEnabled],
     ['toolSkillManagementEnabled', settings.toolSkillManagementEnabled],
     ['dataPlatformCliConsent', settings.dataPlatformCliConsent],
     ['snowflakeCliPath', settings.snowflakeCliPath],
     ['databricksCliPath', settings.databricksCliPath],
     ['serviceAccountCredentialRef', settings.serviceAccountCredentialRef],
     ['defaultDatabricksWorkspaceUrl', settings.defaultDatabricksWorkspaceUrl],
     ['defaultDatabricksHttpPath', settings.defaultDatabricksHttpPath],
     ['defaultDatabricksCatalog', settings.defaultDatabricksCatalog],
     ['defaultDatabricksSchema', settings.defaultDatabricksSchema],
     ['defaultDatabricksCatalogType', settings.defaultDatabricksCatalogType],
     ['defaultTargetProvider', settings.defaultTargetProvider],
     ['defaultTargetSnowflakeAccount', settings.defaultTargetSnowflakeAccount],
     ['defaultTargetSnowflakeUsername', settings.defaultTargetSnowflakeUsername],
     ['defaultTargetSnowflakeWarehouse', settings.defaultTargetSnowflakeWarehouse],
     ['defaultTargetSnowflakeDatabase', settings.defaultTargetSnowflakeDatabase],
     ['defaultTargetSnowflakeSchema', settings.defaultTargetSnowflakeSchema],
     ['defaultTargetSnowflakeRole', settings.defaultTargetSnowflakeRole],
     ['defaultTargetSnowflakeAuthMode', settings.defaultTargetSnowflakeAuthMode],
     ['targetSnowflakePrivateKeyPath', settings.targetSnowflakePrivateKeyPath],
     ['targetSnowflakeCliPath', settings.targetSnowflakeCliPath],
     ['targetDatabricksCliPath', settings.targetDatabricksCliPath],
     ['defaultTargetDatabricksWorkspaceUrl', settings.defaultTargetDatabricksWorkspaceUrl],
     ['defaultTargetDatabricksHttpPath', settings.defaultTargetDatabricksHttpPath],
     ['defaultTargetDatabricksCatalog', settings.defaultTargetDatabricksCatalog],
     ['defaultTargetDatabricksSchema', settings.defaultTargetDatabricksSchema],
     ['defaultTargetDatabricksCatalogType', settings.defaultTargetDatabricksCatalogType]
    ];

    for (const [name, value] of updates) {
      if (value !== undefined && value !== null) {
        await config.update(name, value, vscode.ConfigurationTarget.Global);
      }
    }
  }

  public async setSecret(secretKey: string, value: string): Promise<void> {
    if (!value || value.trim().length === 0) {
      await this.context.secrets.delete(secretKey);
      return;
    }

    await this.context.secrets.store(secretKey, value);
  }

  public async deleteSecret(secretKey: string): Promise<void> {
    await this.context.secrets.delete(secretKey);
  }

  public async getSecret(secretKey: string): Promise<string | undefined> {
    return this.context.secrets.get(secretKey);
  }

  public async setLlmApiKey(value: string): Promise<void> {
    await this.setSecret(SECRET_KEYS.llmApiKey, value);
  }

  public async getLlmApiKey(): Promise<string | undefined> {
    return this.getSecret(SECRET_KEYS.llmApiKey);
  }

  public async setSnowflakePassword(value: string): Promise<void> {
    await this.setSecret(SECRET_KEYS.snowflakePassword, value);
  }

  public async getSnowflakePassword(): Promise<string | undefined> {
    return this.getSecret(SECRET_KEYS.snowflakePassword);
  }

  public async setSnowflakePrivateKeyPassphrase(value: string): Promise<void> {
    await this.setSecret(SECRET_KEYS.snowflakePrivateKeyPassphrase, value);
  }

  public async getSnowflakePrivateKeyPassphrase(): Promise<string | undefined> {
    return this.getSecret(SECRET_KEYS.snowflakePrivateKeyPassphrase);
  }

  public async setDatabricksToken(value: string): Promise<void> {
    await this.setSecret(SECRET_KEYS.databricksToken, value);
  }

  public async getDatabricksToken(): Promise<string | undefined> {
    return this.getSecret(SECRET_KEYS.databricksToken);
  }

  // ── Target connection secrets (v0.19.0) — mirror the source-side methods above exactly ──

  public async setTargetSnowflakePassword(value: string): Promise<void> {
    await this.setSecret(SECRET_KEYS.targetSnowflakePassword, value);
  }

  public async getTargetSnowflakePassword(): Promise<string | undefined> {
    return this.getSecret(SECRET_KEYS.targetSnowflakePassword);
  }

  public async setTargetSnowflakePrivateKeyPassphrase(value: string): Promise<void> {
    await this.setSecret(SECRET_KEYS.targetSnowflakePrivateKeyPassphrase, value);
  }

  public async getTargetSnowflakePrivateKeyPassphrase(): Promise<string | undefined> {
    return this.getSecret(SECRET_KEYS.targetSnowflakePrivateKeyPassphrase);
  }

  public async setTargetDatabricksToken(value: string): Promise<void> {
    await this.setSecret(SECRET_KEYS.targetDatabricksToken, value);
  }

  public async getTargetDatabricksToken(): Promise<string | undefined> {
    return this.getSecret(SECRET_KEYS.targetDatabricksToken);
  }
}