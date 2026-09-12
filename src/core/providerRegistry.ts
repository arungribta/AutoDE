import { DataPlatformProvider, LlmProvider, SnowflakeAuthMode } from './types';
import { LLM_ADAPTERS } from './llmProviders';

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

export function getSupportedProviders(): DataPlatformProvider[] {
  return Object.keys(PROVIDER_REGISTRY) as DataPlatformProvider[];
}

/**
 * @deprecated (Phase C, v0.9.0) LLM provider metadata now lives on the adapters
 * themselves in `src/core/llmProviders.ts` (`LLM_ADAPTERS`) — that is the single
 * source of truth `callConfiguredLlm` actually dispatches through. This function
 * is kept only so any pre-existing caller of the old `LLM_PROVIDER_REGISTRY`
 * still resolves correctly; it was previously a second, disconnected copy of
 * this metadata that had already drifted stale (e.g. still labeling `claude`
 * "Claude (VS Code)" after that provider became the Claude Code CLI).
 */
export function getSupportedLlmProviders(): LlmProvider[] {
  return Object.keys(LLM_ADAPTERS) as LlmProvider[];
}

export function getProviderDefinition(provider: DataPlatformProvider): ProviderDefinition {
  return PROVIDER_REGISTRY[provider] ?? PROVIDER_REGISTRY.other;
}

/** @deprecated See the note on `getSupportedLlmProviders` — reads from `LLM_ADAPTERS` now. */
export function getLlmProviderDefinition(provider: LlmProvider): { displayName: string; supportsCustomEndpoint: boolean; requiresApiKey: boolean } {
  const adapter = LLM_ADAPTERS[provider] ?? LLM_ADAPTERS.openai;
  return { displayName: adapter.displayName, supportsCustomEndpoint: adapter.supportsCustomEndpoint, requiresApiKey: adapter.requiresApiKey };
}
