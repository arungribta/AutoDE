import * as vscode from 'vscode';
import { registerCredentialResolver } from './registry';
import { EnvVarCredentialResolver } from './EnvVarCredentialResolver';
import { CliConfigResolver } from './CliConfigResolver';
import { VsCodeSecretStorageResolver } from './VsCodeSecretStorageResolver';

export * from './types';
export * from './registry';
export { EnvVarCredentialResolver } from './EnvVarCredentialResolver';
export { CliConfigResolver } from './CliConfigResolver';
export { VsCodeSecretStorageResolver, secretStorageKey } from './VsCodeSecretStorageResolver';
export { PlatformCliDescriptor, CliDetectionResult } from './PlatformCliDescriptor';
export { SnowflakeCli } from './SnowflakeCli';
export { DatabricksCli } from './DatabricksCli';
export { getCliDescriptor } from './cliRegistry';
export { readDatabricksCfgProfiles, databricksConfigPath, DatabricksCfgProfile } from './databricksCfg';

/**
 * Registers the resolvers AutoDE ships out of the box (`env`, `cli`,
 * `vscode-secret-storage`). Called once from `activate()`. A production deployment
 * or a test registers additional resolvers (an enterprise secrets manager, a fake)
 * via `registerCredentialResolver()` directly — this function only wires up the
 * built-ins, it isn't the extension point itself.
 */
export function registerDefaultCredentialResolvers(secrets: vscode.SecretStorage): void {
  registerCredentialResolver(new EnvVarCredentialResolver());
  registerCredentialResolver(new CliConfigResolver());
  registerCredentialResolver(new VsCodeSecretStorageResolver(secrets));
}
