
export const EXTENSION_ID = 'autoDataEngineeringHub';
export const EXTENSION_VIEW_ID = 'autoDataEngineeringHubSidebar';
export const CONFIG_SECTION = 'autoDataEngineeringHub';

// Custom Editor View Types
export const EDITOR_DATA_MODEL = 'autoDE.dataModelEditor';
export const EDITOR_STTM = 'autoDE.sttmEditor';
export const EDITOR_GRAPH = 'autoDE.graphEditor';
export const EDITOR_PROFILE = 'autoDE.profileEditor';
export const EDITOR_DOC = 'autoDE.docEditor';
export const EDITOR_SEMANTIC = 'autoDE.semanticModelEditor';

export const SECRET_KEYS = {
  llmApiKey: 'autoDataEngineeringHub.llmApiKey',
  snowflakePassword: 'autoDataEngineeringHub.snowflakePassword',
  snowflakePrivateKeyPassphrase: 'autoDataEngineeringHub.snowflakePrivateKeyPassphrase',
  databricksToken: 'autoDataEngineeringHub.databricksToken',
  // ── Target connection secrets (v0.19.0) — see DataAgentHubSettings' doc comment ──
  targetSnowflakePassword: 'autoDataEngineeringHub.targetSnowflakePassword',
  targetSnowflakePrivateKeyPassphrase: 'autoDataEngineeringHub.targetSnowflakePrivateKeyPassphrase',
  targetDatabricksToken: 'autoDataEngineeringHub.targetDatabricksToken',
  // ── Oracle source (v0.38.0) ──
  oraclePassword: 'autoDataEngineeringHub.oraclePassword',
  oracleWalletPassword: 'autoDataEngineeringHub.oracleWalletPassword'
} as const;