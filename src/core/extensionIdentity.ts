import * as vscode from 'vscode';

export const EXTENSION_ID = 'autoDataEngineeringHub';
export const EXTENSION_VIEW_ID = 'autoDataEngineeringHubSidebar';
export const EXTENSION_PANEL_ID = 'autoDataEngineeringHubPanel';
export const EXTENSION_PANEL_VIEW_ID = 'autoDataEngineeringHubPanelView';
export const EXTENSION_NAME = 'Auto Data Engineering Hub';
export const EXTENSION_DESCRIPTION = 'Plan and execute AI-powered data engineering workflows with Snowflake and modern data platform orchestration.';
export const CONFIG_SECTION = 'autoDataEngineeringHub';

// Custom Editor View Types
export const EDITOR_DATA_MODEL = 'autoDE.dataModelEditor';
export const EDITOR_STTM = 'autoDE.sttmEditor';
export const EDITOR_GRAPH = 'autoDE.graphEditor';
export const EDITOR_PROFILE = 'autoDE.profileEditor';
export const EDITOR_DOC = 'autoDE.docEditor';

export function getExtensionDisplayName(): string {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('extensionDisplayName', EXTENSION_NAME);
}

export function getExtensionDescription(): string {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('extensionDescription', EXTENSION_DESCRIPTION);
}

export const SECRET_KEYS = {
  llmApiKey: 'autoDataEngineeringHub.llmApiKey',
  snowflakePassword: 'autoDataEngineeringHub.snowflakePassword',
  snowflakePrivateKeyPassphrase: 'autoDataEngineeringHub.snowflakePrivateKeyPassphrase'
} as const;