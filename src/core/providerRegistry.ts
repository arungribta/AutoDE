import { DataPlatformProvider, LlmProvider, SnowflakeAuthMode } from './types';

export interface ProviderDefinition {
  displayName: string;
  capabilities: string[];
  configKeys: string[];
  authModes: string[];
}

export const PROVIDER_REGISTRY: Record<DataPlatformProvider, ProviderDefinition> = {
  snowflake: {
    displayName: 'Snowflake',
    capabilities: ['metadata', 'query-execution', 'ddl-generation', 'cdc', 'warehouse-insights'],
    configKeys: ['defaultSnowflakeAccount', 'defaultSnowflakeWarehouse', 'defaultSnowflakeDatabase', 'defaultSnowflakeSchema', 'defaultSnowflakeRole'],
    authModes: ['username-password', 'oauth', 'key-pair', 'external-browser', 'mcp']
  },
  databricks: {
    displayName: 'Databricks',
    capabilities: ['metadata', 'query-execution', 'unity-catalog', 'jobs'],
    configKeys: ['workspaceUrl', 'catalog', 'schema'],
    authModes: ['oauth', 'token']
  },
  bigquery: {
    displayName: 'BigQuery',
    capabilities: ['metadata', 'query-execution', 'warehouse-insights'],
    configKeys: ['projectId', 'dataset', 'location'],
    authModes: ['oauth', 'service-account']
  },
  redshift: {
    displayName: 'Redshift',
    capabilities: ['metadata', 'query-execution'],
    configKeys: ['clusterId', 'database', 'schema'],
    authModes: ['username-password', 'iam']
  },
  synapse: {
    displayName: 'Azure Synapse',
    capabilities: ['metadata', 'query-execution', 'warehouse-insights'],
    configKeys: ['server', 'database', 'schema'],
    authModes: ['username-password', 'oauth']
  },
  other: {
    displayName: 'Other Provider',
    capabilities: ['custom'],
    configKeys: ['customProviderConfig'],
    authModes: ['generic']
  }
};

export const LLM_PROVIDER_REGISTRY: Record<LlmProvider, { displayName: string; supportsCustomEndpoint: boolean; requiresApiKey: boolean }> = {
  'azure-openai': { displayName: 'Azure OpenAI', supportsCustomEndpoint: true, requiresApiKey: true },
  openai: { displayName: 'OpenAI', supportsCustomEndpoint: false, requiresApiKey: true },
  anthropic: { displayName: 'Anthropic', supportsCustomEndpoint: false, requiresApiKey: true },
  gemini: { displayName: 'Google Gemini', supportsCustomEndpoint: false, requiresApiKey: true },
  ollama: { displayName: 'Ollama', supportsCustomEndpoint: false, requiresApiKey: false },
  copilot: { displayName: 'GitHub Copilot', supportsCustomEndpoint: false, requiresApiKey: false }
};

export function getSupportedProviders(): DataPlatformProvider[] {
  return Object.keys(PROVIDER_REGISTRY) as DataPlatformProvider[];
}

export function getSupportedLlmProviders(): LlmProvider[] {
  return Object.keys(LLM_PROVIDER_REGISTRY) as LlmProvider[];
}

export function getProviderDefinition(provider: DataPlatformProvider): ProviderDefinition {
  return PROVIDER_REGISTRY[provider] ?? PROVIDER_REGISTRY.other;
}

export function getLlmProviderDefinition(provider: LlmProvider): { displayName: string; supportsCustomEndpoint: boolean; requiresApiKey: boolean } {
  return LLM_PROVIDER_REGISTRY[provider] ?? LLM_PROVIDER_REGISTRY.openai;
}
