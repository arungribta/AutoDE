import { DataPlatformProvider } from '../types';
import { CONNECTION_FIELDS, ConnectionDraft, ConnectionEntry, PERSONAL_FIELDS, connectionIdFor, secretFieldsFor } from './connectionsConfig';
import { envCredentialVariable } from './credentials/EnvVarCredentialResolver';
import { databricksConfigPath, readDatabricksCfgProfiles } from './credentials/databricksCfg';
import { listSnowflakeConnectionNames, snowflakeConnectionsTomlPath } from './credentials/CliConfigResolver';
import { readTnsNames } from './credentials/tnsnames';
import { platformDefinition } from './definitions';

/**
 * Setting up a connection outside the settings cards (v0.43.1): what the
 * `autode connections` commands and the MCP connection proposal share with
 * the cards — the entry a draft becomes, what its credentials still need, and
 * the connections the platforms' own tools already know.
 */

/** The entry a draft becomes once saved, for testing it before anything is written. */
export function draftEntry(draft: ConnectionDraft): ConnectionEntry {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(draft.fields ?? {})) if (v !== undefined && v !== null && String(v).trim() !== '') fields[k] = String(v).trim();
  return {
    id: connectionIdFor(draft.platform, fields, draft.credentials),
    platform: draft.platform,
    role: draft.role,
    fields,
    credentials: { resolver: draft.credentials.resolver, ref: draft.credentials.ref ?? '' },
    allowSampleDataInPrompts: draft.allowSampleDataInPrompts === true,
    origin: draft.scope === 'personal' ? 'local' : 'file'
  };
}

export interface CredentialNeeds {
  /** One line for a person: where the secret comes from. */
  summary: string;
  /** For `env` (and, outside VS Code, `vscode`): the variables to set, and whether this environment has them. */
  variables: Array<{ name: string; field: string; set: boolean }>;
}

/** Where a draft's secret comes from and what still has to be set — never the secret itself. */
export function credentialNeeds(draft: Pick<ConnectionDraft, 'platform' | 'fields' | 'credentials'>, env: NodeJS.ProcessEnv = process.env): CredentialNeeds {
  const { resolver, ref } = draft.credentials;
  const defined = CONNECTION_FIELDS[draft.platform] ? undefined : platformDefinition(draft.platform);
  if (resolver === 'cli' && defined) {
    return { summary: `Credentials come from your ${defined.access?.cli?.command ?? 'CLI'} profile "${ref || 'default'}"; AutoDE stores none.`, variables: [] };
  }
  if (resolver === 'cli') {
    const where = draft.platform === 'snowflake' ? `the Snowflake CLI connection [${ref || 'default'}] in ${snowflakeConnectionsTomlPath()}` : `the profile [${ref || 'DEFAULT'}] in ${databricksConfigPath()}`;
    return { summary: `Credentials come from ${where}; AutoDE stores none.`, variables: [] };
  }
  const variables = secretFieldsFor(draft.platform, draft.fields ?? {})
    .map((field) => ({ field, name: envCredentialVariable(draft.platform, ref, field) }))
    .filter((v): v is { field: string; name: string } => !!v.name)
    .map((v) => ({ ...v, set: !!env[v.name] }));
  const optional = (draft.platform === 'snowflake' && (draft.fields?.authMode || 'key-pair') === 'key-pair') || !!defined;
  const lead = resolver === 'vscode'
    ? 'Inside VS Code the secret comes from its secret storage; elsewhere (CLI, MCP clients) from'
    : 'The secret comes from';
  return {
    summary: variables.length ? `${lead} ${variables.map((v) => v.name).join(' and ')}${optional ? (defined ? ' (only for the sign-in that needs them)' : ' (only if the private key is encrypted)') : ''}.` : 'This connection needs no secret.',
    variables
  };
}

export interface DiscoveredConnections {
  /** Named connections in the Snowflake CLI's connections.toml. */
  snowflake: string[];
  /** Profiles in .databrickscfg, with their host. */
  databricks: Array<{ name: string; host?: string }>;
  /** tnsnames.ora aliases, for Oracle's connect string. */
  oracleAliases: string[];
}

/** What the platforms' own tools already know on this machine — read from their files, no CLI is run. */
export async function discoverCliConnections(env: NodeJS.ProcessEnv = process.env, oracleConfigDir?: string): Promise<DiscoveredConnections> {
  const snowflake = (await listSnowflakeConnectionNames()) ?? [];
  const profiles = (await readDatabricksCfgProfiles()) ?? [];
  let oracleAliases: string[] = [];
  try { oracleAliases = readTnsNames(oracleConfigDir, env).aliases; } catch { /* none */ }
  return { snowflake, databricks: profiles.map((p) => ({ name: p.name, host: p.fields.host })), oracleAliases };
}

/** The fields to ask for, per platform and credential source, in order; `required` ones must be given. */
export function setupFields(platform: DataPlatformProvider, resolver: string): Array<{ field: string; label: string; required: boolean; personal: boolean }> {
  const f = (field: string, label: string, required = false) => ({ field, label, required, personal: PERSONAL_FIELDS.includes(field) });
  if (platform === 'snowflake') {
    if (resolver === 'cli') return [f('warehouse', 'Warehouse (blank: the CLI connection\'s)'), f('database', 'Database (blank: the CLI connection\'s)'), f('schema', 'Schema'), f('snowflakeRole', 'Snowflake role (blank: the CLI connection\'s)')];
    return [f('account', 'Account identifier (e.g. ACME-XY12345)', true), f('username', 'Username', true), f('authMode', 'Authentication: key-pair (default), token, or username-password (needs --allow-cli)'), f('keyPath', 'Private key file (key-pair)'), f('warehouse', 'Warehouse'), f('database', 'Database', true), f('schema', 'Schema'), f('snowflakeRole', 'Snowflake role')];
  }
  if (platform === 'databricks') {
    if (resolver === 'cli') return [f('httpPath', 'SQL warehouse HTTP path (/sql/1.0/warehouses/…)', true), f('catalog', 'Catalog'), f('schema', 'Schema')];
    return [f('workspaceUrl', 'Workspace URL (adb-….azuredatabricks.net)', true), f('httpPath', 'SQL warehouse HTTP path (/sql/1.0/warehouses/…)', true), f('catalog', 'Catalog'), f('schema', 'Schema')];
  }
  if (platform === 'oracle') return [f('connectString', 'Connect string: a tnsnames alias or host:port/service', true), f('username', 'Username', true), f('configDir', 'Folder with tnsnames.ora (blank: TNS_ADMIN)')];
  // A platform defined by files: its definition's fields, minus the CLI profile a `cli` reference already names.
  const c = platformDefinition(platform)?.connection;
  if (c) {
    return c.fields.filter((x) => !x.secret && !(resolver === 'cli' && x.name === c.cliProfileField))
      .map((x) => ({ field: x.name, label: x.description ? `${x.label} (${x.description})` : x.label, required: !!x.required, personal: !!x.personal }));
  }
  return (CONNECTION_FIELDS[platform] ?? []).map((x) => f(x, x));
}
