import { DataPlatformProvider, PrincipalType } from '../../types';

/**
 * A pointer to where a credential lives, never the secret itself. This is what gets
 * persisted in settings/Target Context — the same "don't duplicate secrets" principle
 * applied structurally as `ConnectionManager.getCredentialsFromSettings()`'s flat
 * settings-only assembly gets replaced by, one platform at a time.
 */
export interface CredentialReference {
  platform: DataPlatformProvider;
  principalType: PrincipalType;
  /** Resolver-specific: a CLI connection/profile name, an env var prefix, a secrets-manager path — never the secret itself. */
  ref: string;
  /** Which registered `CredentialResolver` produces the actual values for this reference. */
  resolverId: string;
}

/**
 * Produces a credential set (the `Record<string,string>` `ConnectionManager.connect()`
 * already accepts) from a `CredentialReference`. Implementations must never throw —
 * an unresolvable reference returns `undefined`, matching `ClaudeCodeAdapter.resolve()`'s
 * "detection is data, not exceptions" contract.
 */
export interface CredentialResolver {
  readonly id: string;
  /** Which principal type(s) this resolver is meant for — a UI/service config surface only offers applicable resolvers. */
  readonly supportedPrincipalTypes: PrincipalType[];
  resolve(reference: CredentialReference): Promise<Record<string, string> | undefined>;
}

/**
 * The id the extension registers its SecretStorage resolver under. A
 * `connections.yaml` entry names it as `resolver: vscode` (Phase DRV2); outside
 * VS Code (the MCP server) it isn't registered.
 */
export const VSCODE_SECRET_RESOLVER_ID = 'vscode-secret-storage';
