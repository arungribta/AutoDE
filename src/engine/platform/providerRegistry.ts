import { AuthModeDescriptor, DataPlatformProvider, PrincipalType } from '../types';

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
  oracle: {
    displayName: 'Oracle Database',
    capabilities: ['metadata', 'query-execution'],
    configKeys: ['defaultOracleConnectString', 'defaultOracleUsername', 'oracleConfigDir', 'oracleWalletLocation'],
    authModes: [
      // Thin mode (DRV1): database username and password; a TLS wallet is a transport option, not an auth mode.
      { mode: 'username-password', principalTypes: ['interactive-user', 'service-account'] }
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
    // v0.55.0: the connection's fields and sign-in are in platforms/redshift.yaml (the Data API takes no plain password).
    configKeys: ['workgroupName', 'clusterIdentifier', 'database', 'schema', 'region'],
    authModes: [
      { mode: 'secrets-manager', principalTypes: ['interactive-user', 'service-account'] },
      { mode: 'iam-temporary', principalTypes: ['interactive-user', 'service-account'] },
      { mode: 'aws-identity', principalTypes: ['interactive-user', 'service-account'] }
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

export function getProviderDefinition(provider: DataPlatformProvider): ProviderDefinition {
  return PROVIDER_REGISTRY[provider] ?? PROVIDER_REGISTRY.other;
}
