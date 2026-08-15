import * as vscode from 'vscode';
import { CONFIG_SECTION, SECRET_KEYS } from './extensionIdentity';
import { DataAgentHubSettings, DataPlatformProvider, LlmProvider, SnowflakeAuthMode } from './types';

export class ConfigurationManager {
  public constructor(private readonly context: vscode.ExtensionContext) {}

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
      llmEndpoint: config.get<string>('llmEndpoint', '')
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
      ['llmEndpoint', settings.llmEndpoint]
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
}
