import { DataPlatformProvider, PrincipalType } from '../../core/types';
import { CredentialReference, CredentialResolver } from './types';

/**
 * Per-platform field → env var suffix, using the same field names the adapters'
 * `credentials` record already expects (`SnowflakeAdapter`/`DatabricksAdapter`
 * `connect()`) so a resolved set can be handed straight to `ConnectionManager.connect()`.
 */
const FIELD_SUFFIXES: Partial<Record<DataPlatformProvider, Record<string, string>>> = {
  snowflake: {
    account: 'ACCOUNT',
    username: 'USERNAME',
    warehouse: 'WAREHOUSE',
    database: 'DATABASE',
    schema: 'SCHEMA',
    role: 'ROLE',
    authMode: 'AUTH_MODE',
    password: 'PASSWORD',
    keyPath: 'PRIVATE_KEY_PATH',
    privateKey: 'PRIVATE_KEY',
    privateKeyPassphrase: 'PRIVATE_KEY_PASSPHRASE'
  },
  databricks: {
    workspaceUrl: 'WORKSPACE_URL',
    httpPath: 'HTTP_PATH',
    token: 'TOKEN',
    catalog: 'CATALOG',
    schema: 'SCHEMA',
    clientId: 'CLIENT_ID',
    clientSecret: 'CLIENT_SECRET'
  }
};

function sanitize(segment: string): string {
  return segment.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * Resolves credentials from a documented, namespaced set of environment variables —
 * `AUTODE_<PLATFORM>_<FIELD>`, or `AUTODE_<PLATFORM>_<REF>_<FIELD>` when `reference.ref`
 * names a profile (e.g. multiple named connections in one CI matrix). The simplest
 * possible service-account path: works in any CI system with zero AutoDE-specific
 * infrastructure, and involves no VS Code API at all.
 */
export class EnvVarCredentialResolver implements CredentialResolver {
  readonly id = 'env';
  readonly supportedPrincipalTypes: PrincipalType[] = ['service-account', 'interactive-user'];

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(reference: CredentialReference): Promise<Record<string, string> | undefined> {
    const fields = FIELD_SUFFIXES[reference.platform];
    if (!fields) {
      return undefined;
    }

    const profile = reference.ref && reference.ref.trim().length > 0 && reference.ref !== 'default'
      ? `_${sanitize(reference.ref)}`
      : '';
    const prefix = `AUTODE_${sanitize(reference.platform)}${profile}`;

    const result: Record<string, string> = {};
    for (const [field, suffix] of Object.entries(fields)) {
      const value = this.env[`${prefix}_${suffix}`];
      if (value !== undefined && value.length > 0) {
        result[field] = value;
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  }
}
