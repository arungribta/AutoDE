import * as vscode from 'vscode';
import { registerBuiltInCredentialResolvers, registerCredentialResolver } from '../../engine/platform/credentials';
import { VsCodeSecretStorageResolver } from './VsCodeSecretStorageResolver';

export * from '../../engine/platform/credentials';
export { VsCodeSecretStorageResolver, secretStorageKey } from './VsCodeSecretStorageResolver';

/**
 * Registers every resolver the extension ships: the engine's host-agnostic
 * built-ins (`env`, `cli`) plus `vscode-secret-storage`, which only exists
 * inside VS Code (v0.26.0 engine boundary). Called once from `activate()`.
 */
export function registerDefaultCredentialResolvers(secrets: vscode.SecretStorage): void {
  registerBuiltInCredentialResolvers();
  registerCredentialResolver(new VsCodeSecretStorageResolver(secrets));
}
