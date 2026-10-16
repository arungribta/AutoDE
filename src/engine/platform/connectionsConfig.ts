import * as fs from 'node:fs';
import { DataPlatformProvider } from '../types';
import { parseYaml } from '../context/Yaml';
import { layoutPath, layoutRel } from '../workspaceLayout';
import { CredentialReference } from './credentials/types';
import { resolveCredential } from './credentials/registry';
import { envCredentialVariable } from './credentials/EnvVarCredentialResolver';

/**
 * The connections the MCP server can use (docs/mcp-engine-requirements.md
 * §5.3, §6; phase 4), from `.autode/config/connections.yaml`:
 *
 *   connections:
 *     - platform: snowflake
 *       role: source
 *       credentials: { resolver: cli, ref: prod }   # [prod] in ~/.snowflake/connections.toml
 *       allowSampleDataInPrompts: false
 *     - platform: databricks
 *       workspaceUrl: adb-123.4.azuredatabricks.net
 *       httpPath: /sql/1.0/warehouses/abc
 *       credentials: { resolver: env }              # AUTODE_DATABRICKS_TOKEN
 *
 * The file is committed with the team's configuration, so it holds pointers
 * and non-secret settings only: a secret field in it makes the entry invalid.
 * Secrets come from the referenced resolver — `env` (`AUTODE_<PLATFORM>[_<REF>]_<FIELD>`)
 * or `cli` (the platform CLI's own configuration). `allowSampleDataInPrompts`
 * is the per-connection sample-data consent, read by the extension too.
 *
 * Without a file entry, `AUTODE_SNOWFLAKE_ACCOUNT`, `AUTODE_DATABRICKS_WORKSPACE_URL`
 * or `AUTODE_ORACLE_CONNECT_STRING` in the environment defines one source
 * connection (resolver `env`, consent off) — the CI and service-account path.
 */

export type ConnectionRole = 'source' | 'target';

export interface ConnectionEntry {
  /** `platform:<ref>` — the same id `BaseDataSourceAdapter.getConnectionId()` gives the live connection. */
  id: string;
  platform: DataPlatformProvider;
  role: ConnectionRole;
  /** Non-secret connection settings (account, warehouse, workspaceUrl, …). */
  fields: Record<string, string>;
  credentials: { resolver: string; ref: string };
  allowSampleDataInPrompts: boolean;
  origin: 'file' | 'environment';
}

export interface ConnectionsConfig {
  connections: ConnectionEntry[];
  /** Entries that were refused, and why. */
  errors: string[];
  /** Workspace-relative path of the file. */
  file: string;
  fileExists: boolean;
}

export const CONNECTION_FIELDS: Readonly<Partial<Record<DataPlatformProvider, readonly string[]>>> = {
  snowflake: ['account', 'username', 'warehouse', 'database', 'schema', 'role', 'authMode', 'keyPath', 'snowflakeCliPath'],
  databricks: ['workspaceUrl', 'httpPath', 'catalog', 'schema', 'catalogType'],
  oracle: ['connectString', 'username', 'configDir', 'walletLocation']
};

/** Fields that hold secrets: refused in the file, supplied only by a resolver. */
export const SECRET_FIELDS: readonly string[] = ['password', 'token', 'privateKey', 'privateKeyPassphrase', 'passphrase', 'clientSecret', 'secret', 'accessToken', 'walletPassword'];

const KNOWN_KEYS = new Set(['id', 'platform', 'role', 'credentials', 'allowSampleDataInPrompts']);
const RESOLVERS = new Set(['env', 'cli']);

/** The id a connection gets — mirrors `BaseDataSourceAdapter.getConnectionId()` over the non-secret fields. */
export function connectionIdFor(platform: DataPlatformProvider, fields: Readonly<Record<string, string>>, credentials: { resolver: string; ref: string }): string {
  const cliRef = credentials.resolver === 'cli' ? credentials.ref || (platform === 'databricks' ? 'DEFAULT' : 'default') : '';
  const ref = cliRef || fields.account || fields.workspaceUrl || fields.connectString || fields.username || '';
  return ref ? `${platform}:${ref}` : platform;
}

/** Non-secret fields the `env` resolver would supply for this reference (to compute ids before connecting). */
function envFields(platform: DataPlatformProvider, ref: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of CONNECTION_FIELDS[platform] ?? []) {
    const name = envCredentialVariable(platform, ref, field);
    const value = name ? env[name] : undefined;
    if (value) out[field] = value;
  }
  return out;
}

export function parseConnectionsConfig(text: string | undefined, env: NodeJS.ProcessEnv = process.env): Omit<ConnectionsConfig, 'file' | 'fileExists'> {
  const errors: string[] = [];
  const connections: ConnectionEntry[] = [];
  let raw: unknown;
  try {
    raw = text === undefined ? undefined : parseYaml(text);
  } catch (err) {
    errors.push(`${layoutRel('connections')} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const list = raw && typeof raw === 'object' ? (raw as { connections?: unknown }).connections : undefined;
  if (raw !== undefined && raw !== null && !Array.isArray(list)) errors.push(`${layoutRel('connections')} needs a "connections:" list.`);
  (Array.isArray(list) ? list : []).forEach((item, index) => {
    const where = `connections[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${where}: not a mapping.`); return; }
    const e = item as Record<string, unknown>;
    const platform = String(e.platform ?? '') as DataPlatformProvider;
    const allowed = CONNECTION_FIELDS[platform];
    if (!allowed) { errors.push(`${where}: platform "${String(e.platform ?? '')}" is not supported (snowflake, databricks, oracle).`); return; }
    const secrets = Object.keys(e).filter((k) => SECRET_FIELDS.some((s) => s.toLowerCase() === k.toLowerCase()));
    if (secrets.length) { errors.push(`${where}: ${secrets.join(', ')} must not be in this file — it is committed. Supply secrets through the credentials resolver (env vars or the platform CLI's configuration).`); return; }
    const role = e.role === undefined ? 'source' : String(e.role);
    if (role !== 'source' && role !== 'target') { errors.push(`${where}: role must be source or target.`); return; }
    const creds = (e.credentials && typeof e.credentials === 'object' ? e.credentials : {}) as Record<string, unknown>;
    const resolver = String(creds.resolver ?? 'env');
    if (!RESOLVERS.has(resolver)) { errors.push(`${where}: credentials.resolver must be env or cli.`); return; }
    const ref = creds.ref === undefined || creds.ref === null ? '' : String(creds.ref);
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(e)) {
      if (KNOWN_KEYS.has(k)) continue;
      if (!allowed.includes(k)) { errors.push(`${where}: unknown field "${k}" (ignored).`); continue; }
      if (v !== undefined && v !== null && String(v) !== '') fields[k] = String(v);
    }
    const credentials = { resolver, ref };
    if (platform === 'oracle' && !fields.connectString && !(resolver === 'env' && envFields(platform, ref, env).connectString)) { errors.push(`${where}: an Oracle connection needs connectString (a tnsnames alias or host:port/service).`); return; }
    const idFields = resolver === 'env' ? { ...envFields(platform, ref, env), ...fields } : fields;
    const id = e.id !== undefined && String(e.id).trim() ? String(e.id).trim() : connectionIdFor(platform, idFields, credentials);
    if (connections.some((c) => c.id === id)) { errors.push(`${where}: duplicate connection id "${id}" (ignored).`); return; }
    connections.push({ id, platform, role, fields, credentials, allowSampleDataInPrompts: e.allowSampleDataInPrompts === true, origin: 'file' });
  });
  // The environment-only connection, when the file doesn't already describe it.
  for (const platform of ['snowflake', 'databricks', 'oracle'] as const) {
    const fields = envFields(platform, '', env);
    if (!(platform === 'snowflake' ? fields.account : platform === 'databricks' ? fields.workspaceUrl : fields.connectString)) continue;
    const credentials = { resolver: 'env', ref: '' };
    const id = connectionIdFor(platform, fields, credentials);
    if (connections.some((c) => c.id === id)) continue;
    connections.push({ id, platform, role: 'source', fields: {}, credentials, allowSampleDataInPrompts: false, origin: 'environment' });
  }
  return { connections, errors };
}

/** Reads `.autode/config/connections.yaml` (missing = no file entries). */
export function loadConnectionsConfig(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): ConnectionsConfig {
  const file = layoutPath(workspaceRoot, 'connections');
  let text: string | undefined;
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = undefined; }
  return { ...parseConnectionsConfig(text, env), file: layoutRel('connections'), fileExists: text !== undefined };
}

/**
 * The sample-data consent of the workspace's connections, by connection id —
 * for the extension's own connections, which come from settings. Re-read on
 * each call (the file is small), so an edit applies to the next extraction.
 * A connection the file doesn't list has no consent.
 */
export function sampleDataConsentFromWorkspace(workspaceRoot: string | undefined): (connectionId: string | undefined) => boolean {
  return (connectionId) => {
    if (!workspaceRoot || !connectionId) return false;
    const entry = loadConnectionsConfig(workspaceRoot).connections.find((c) => c.id.toLowerCase() === connectionId.toLowerCase());
    return entry?.allowSampleDataInPrompts === true;
  };
}

/**
 * The credential set `ConnectionManager.connect()` takes: the entry's
 * non-secret fields plus what its resolver supplies (the resolver wins).
 * Throws when a `cli` reference names nothing the CLI's configuration holds.
 */
export async function resolveConnectionCredentials(entry: ConnectionEntry): Promise<Record<string, string>> {
  const reference: CredentialReference = { platform: entry.platform, principalType: 'interactive-user', ref: entry.credentials.ref, resolverId: entry.credentials.resolver };
  const resolved = await resolveCredential(reference);
  if (!resolved && entry.credentials.resolver === 'cli') {
    if (entry.platform === 'oracle') throw new Error('Oracle connections take credentials from environment variables (resolver env); the connect string (a tnsnames alias or Easy Connect) is a field of the entry.');
    const where = entry.platform === 'snowflake' ? 'connections.toml' : '.databrickscfg';
    throw new Error(`The ${entry.platform} CLI configuration (${where}) has no connection named "${entry.credentials.ref || 'default'}".`);
  }
  return { ...entry.fields, ...(resolved ?? {}) };
}
