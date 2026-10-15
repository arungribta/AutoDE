import { registerCredentialResolver } from './registry';
import { EnvVarCredentialResolver } from './EnvVarCredentialResolver';
import { CliConfigResolver } from './CliConfigResolver';

export * from './types';
export * from './registry';
export { EnvVarCredentialResolver } from './EnvVarCredentialResolver';
export { CliConfigResolver } from './CliConfigResolver';
export { PlatformCliDescriptor, CliDetectionResult } from './PlatformCliDescriptor';
export { SnowflakeCli } from './SnowflakeCli';
export { DatabricksCli } from './DatabricksCli';
export { getCliDescriptor } from './cliRegistry';
export { readDatabricksCfgProfiles, databricksConfigPath, DatabricksCfgProfile } from './databricksCfg';

/**
 * Registers the host-agnostic resolvers AutoDE ships (`env`, `cli`). The
 * extension additionally registers `vscode-secret-storage` — see
 * `src/core/credentials/index.ts`'s `registerDefaultCredentialResolvers()`.
 * A production deployment or a test registers further resolvers (an
 * enterprise secrets manager, a fake) via `registerCredentialResolver()`.
 */
export function registerBuiltInCredentialResolvers(): void {
  registerCredentialResolver(new EnvVarCredentialResolver());
  registerCredentialResolver(new CliConfigResolver());
}
