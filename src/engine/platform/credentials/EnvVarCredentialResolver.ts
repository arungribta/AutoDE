import { DataPlatformProvider, PrincipalType } from '../../types';
import { CredentialReference, CredentialResolver } from './types';
import { platformDefinition } from '../definitions';

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
  },
  oracle: {
    connectString: 'CONNECT_STRING',
    username: 'USERNAME',
    password: 'PASSWORD',
    configDir: 'CONFIG_DIR',
    walletLocation: 'WALLET_LOCATION',
    walletPassword: 'WALLET_PASSWORD'
  }
};

/** v0.55.0: a platform defined by files: each of its connection fields, `secretArn` → `SECRET_ARN`. */
function suffixesFor(platform: DataPlatformProvider): Record<string, string> | undefined {
  const builtIn = FIELD_SUFFIXES[platform];
  if (builtIn) return builtIn;
  const c = platformDefinition(platform)?.connection;
  return c ? Object.fromEntries(c.fields.map((f) => [f.name, f.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()])) : undefined;
}

function sanitize(segment: string): string {
  return segment.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** The environment variable that carries one credential field (`AUTODE_SNOWFLAKE_PROD_ACCOUNT`), or `undefined` for a field the platform doesn't have. */
export function envCredentialVariable(platform: DataPlatformProvider, ref: string | undefined, field: string): string | undefined {
  const suffix = suffixesFor(platform)?.[field];
  if (!suffix) return undefined;
  const profile = ref && ref.trim().length > 0 && ref !== 'default' ? `_${sanitize(ref)}` : '';
  return `AUTODE_${sanitize(platform)}${profile}_${suffix}`;
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
    const fields = suffixesFor(reference.platform);
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
