import * as vscode from 'vscode';
import { CONFIG_SECTION } from '../../core/extensionIdentity';
import { DataPlatformProvider, PrincipalType } from '../../core/types';
import { CredentialReference, CredentialResolver } from './types';

/**
 * Which credential fields for a platform are actual secrets (vs. plain settings like
 * account/warehouse, which stay in VS Code configuration). Only these are looked up here.
 */
const SECRET_FIELDS: Partial<Record<DataPlatformProvider, string[]>> = {
  snowflake: ['password', 'privateKey', 'privateKeyPassphrase'],
  databricks: ['token', 'clientSecret']
};

/**
 * Generalizes the 3 bespoke, hardcoded secret methods `ConfigurationManager` shipped
 * with (`llmApiKey`/`snowflakePassword`/`snowflakePrivateKeyPassphrase`) into one key
 * scheme that gives any platform, principal type, and profile a home without a new
 * bespoke method every time a platform is added:
 * `autoDataEngineeringHub.secret.<platform>.<principalType>.<profileOrRef>.<field>`.
 */
export function secretStorageKey(platform: DataPlatformProvider, principalType: PrincipalType, ref: string, field: string): string {
  const profile = ref && ref.trim().length > 0 ? ref : 'default';
  return `${CONFIG_SECTION}.secret.${platform}.${principalType}.${profile}.${field}`;
}

/**
 * Resolves credentials from VS Code's `SecretStorage` under the generalized key scheme
 * above — used by both principal types when running inside VS Code (an interactive
 * developer's own picks, or a service account's config surface set once via command).
 */
export class VsCodeSecretStorageResolver implements CredentialResolver {
  readonly id = 'vscode-secret-storage';
  readonly supportedPrincipalTypes: PrincipalType[] = ['interactive-user', 'service-account'];

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async resolve(reference: CredentialReference): Promise<Record<string, string> | undefined> {
    const fields = SECRET_FIELDS[reference.platform];
    if (!fields) {
      return undefined;
    }

    const result: Record<string, string> = {};
    for (const field of fields) {
      const key = secretStorageKey(reference.platform, reference.principalType, reference.ref, field);
      const value = await this.secrets.get(key);
      if (value !== undefined && value.length > 0) {
        result[field] = value;
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  }
}
