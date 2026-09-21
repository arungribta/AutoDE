import { AuthModeDescriptor, DataPlatformProvider, LlmProvider, PrincipalType } from './types';
import { LLM_ADAPTERS } from './llmProviders';

export interface ProviderDefinition {
  displayName: string;
  capabilities: string[];
  configKeys: string[];
  authModes: AuthModeDescriptor[];
}

export const PROVIDER_REGISTRY: Record<DataPlatformProvider, ProviderDefinition> = {
  snowflake: {
    displayName: 'Snowflake',
    capabilities: ['metadata', 'query-execution', 'ddl-generation', 'cdc', 'warehouse-insights'],
    configKeys: ['defaultSnowflakeAccount', 'defaultSnowflakeWarehouse', 'defaultSnowflakeDatabase', 'defaultSnowflakeSchema', 'defaultSnowflakeRole'],
    authModes: [
      { mode: 'username-password', principalTypes: ['interactive-user'] },
      { mode: 'external-browser', principalTypes: ['interactive-user'] },
      { mode: 'mcp', principalTypes: ['interactive-user'] },
      // Snowflake's own recommended default for service accounts; also usable interactively.
      { mode: 'key-pair', principalTypes: ['interactive-user', 'service-account'] },
      { mode: 'oauth', principalTypes: ['service-account'] }
    ]
  },
  databricks: {
    displayName: 'Databricks',
    capabilities: ['metadata', 'query-execution', 'unity-catalog', 'jobs'],
    configKeys: ['workspaceUrl', 'catalog', 'schema'],
    authModes: [
      // OAuth U2M (browser) and a personal access token are the interactive-developer paths.
      { mode: 'oauth-u2m', principalTypes: ['interactive-user'] },
      { mode: 'personal-access-token', principalTypes: ['interactive-user'] },
      // OAuth M2M (service-principal client id/secret) and a service-principal-scoped
      // token are Databricks' own recommended paths for headless/automated access.
      { mode: 'oauth-m2m', principalTypes: ['service-account'] },
      { mode: 'service-principal-token', principalTypes: ['service-account'] }
    ]
  },
  bigquery: {
    displayName: 'BigQuery',
    capabilities: ['metadata', 'query-execution', 'warehouse-insights'],
    configKeys: ['projectId', 'dataset', 'location'],
    authModes: [
      { mode: 'oauth', principalTypes: ['interactive-user'] },
      { mode: 'service-account', principalTypes: ['service-account'] }
    ]
  },
  redshift: {
    displayName: 'Redshift',
    capabilities: ['metadata', 'query-execution'],
    configKeys: ['clusterId', 'database', 'schema'],
    authModes: [
      { mode: 'username-password', principalTypes: ['interactive-user'] },
      { mode: 'iam', principalTypes: ['interactive-user', 'service-account'] }
    ]
  },
  synapse: {
    displayName: 'Azure Synapse',
    capabilities: ['metadata', 'query-execution', 'warehouse-insights'],
    configKeys: ['server', 'database', 'schema'],
    authModes: [
      { mode: 'username-password', principalTypes: ['interactive-user'] },
      { mode: 'oauth', principalTypes: ['interactive-user', 'service-account'] }
    ]
  },
  other: {
    displayName: 'Other Provider',
    capabilities: ['custom'],
    configKeys: ['customProviderConfig'],
    authModes: [
      { mode: 'generic', principalTypes: ['interactive-user', 'service-account'] }
    ]
  }
};

/** Auth modes for `provider` usable by `principalType`, in the order declared. */
export function getAuthModesForPrincipal(provider: DataPlatformProvider, principalType: PrincipalType): AuthModeDescriptor[] {
  return getProviderDefinition(provider).authModes.filter((m) => m.principalTypes.includes(principalType));
}

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
