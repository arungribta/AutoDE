import * as fs from 'node:fs';
import * as path from 'node:path';
import { Document, isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import { DataPlatformProvider } from '../types';
import { parseYaml } from '../context/Yaml';
import { ensureLayout, layoutPath, layoutRel } from '../workspaceLayout';
import { CredentialReference, VSCODE_SECRET_RESOLVER_ID } from './credentials/types';
import { getCredentialResolver, resolveCredential } from './credentials/registry';
import { envCredentialVariable } from './credentials/EnvVarCredentialResolver';

/**
 * The connections the MCP server and the extension can use (docs/mcp-engine-
 * requirements.md §5.3, §6; phase 4, phase DRV2), from two files:
 *
 *   .autode/config/connections.yaml     committed — the team's connections
 *   .autode/local/connections.yaml      gitignored — this engineer's own fields
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
 * Both files hold pointers and non-secret settings only: a secret field makes
 * the entry invalid. Secrets come from the referenced resolver — `env`
 * (`AUTODE_<PLATFORM>[_<REF>]_<FIELD>`), `cli` (the platform CLI's own
 * configuration) or `vscode` (VS Code's secret storage, which only the
 * extension can read; elsewhere the same-named `env` variables stand in).
 *
 * The local file adds what differs per engineer — `username`, key and wallet
 * paths, a CLI path — to a team entry with the same `id`, may point that entry
 * at the engineer's own credentials, and may hold connections of its own.
 * Sample-data consent (`allowSampleDataInPrompts`) is the team's decision: the
 * local file can't change it for a team entry.
 *
 * Without a file entry, `AUTODE_SNOWFLAKE_ACCOUNT`, `AUTODE_DATABRICKS_WORKSPACE_URL`
 * or `AUTODE_ORACLE_CONNECT_STRING` in the environment defines one source
 * connection (resolver `env`, consent off) — the CI and service-account path.
 */

export type ConnectionRole = 'source' | 'target';
export type ConnectionOrigin = 'file' | 'local' | 'environment';

export interface ConnectionEntry {
  /** `platform:<ref>` — the same id `BaseDataSourceAdapter.getConnectionId()` gives the live connection. */
  id: string;
  platform: DataPlatformProvider;
  role: ConnectionRole;
  /** Non-secret connection settings (account, warehouse, workspaceUrl, …), team and personal merged. */
  fields: Record<string, string>;
  credentials: { resolver: string; ref: string };
  allowSampleDataInPrompts: boolean;
  origin: ConnectionOrigin;
  /** Names of the fields (and `credentials`) the local file supplied for a team entry. */
  personal?: string[];
}

export interface ConnectionsConfig {
  connections: ConnectionEntry[];
  /** Entries that were refused, and why. */
  errors: string[];
  /** Workspace-relative path of the team file. */
  file: string;
  fileExists: boolean;
  /** Workspace-relative path of the personal file. */
  localFile: string;
  localFileExists: boolean;
}

export const CONNECTION_FIELDS: Readonly<Partial<Record<DataPlatformProvider, readonly string[]>>> = {
  // `snowflakeRole` is Snowflake's role (SYSADMIN, …): `role` is the connection's source/target role.
  snowflake: ['account', 'username', 'warehouse', 'database', 'schema', 'snowflakeRole', 'authMode', 'keyPath', 'snowflakeCliPath'],
  databricks: ['workspaceUrl', 'httpPath', 'catalog', 'schema', 'catalogType'],
  oracle: ['connectString', 'username', 'configDir', 'walletLocation']
};

/** File field → the credential field the adapters take, where they differ. */
const ADAPTER_FIELD: Readonly<Record<string, string>> = { snowflakeRole: 'role' };

/** The entry's fields as `ConnectionManager.connect()` takes them. */
export function adapterFields(fields: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [ADAPTER_FIELD[k] ?? k, v]));
}

/** Fields that differ per engineer: written to the local file, never the team file. */
export const PERSONAL_FIELDS: readonly string[] = ['username', 'keyPath', 'snowflakeCliPath', 'configDir', 'walletLocation'];

/** Fields that hold secrets: refused in both files, supplied only by a resolver. */
export const SECRET_FIELDS: readonly string[] = ['password', 'token', 'privateKey', 'privateKeyPassphrase', 'passphrase', 'clientSecret', 'secret', 'accessToken', 'walletPassword'];

export const CONNECTION_RESOLVERS: readonly string[] = ['env', 'cli', 'vscode'];

const KNOWN_KEYS = new Set(['id', 'platform', 'role', 'credentials', 'allowSampleDataInPrompts']);

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

function secretKeys(e: Record<string, unknown>): string[] {
  return Object.keys(e).filter((k) => SECRET_FIELDS.some((s) => s.toLowerCase() === k.toLowerCase()));
}

function parseCredentials(value: unknown, where: string, errors: string[]): { resolver: string; ref: string } | undefined {
  const creds = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const resolver = String(creds.resolver ?? 'env');
  if (!CONNECTION_RESOLVERS.includes(resolver)) { errors.push(`${where}: credentials.resolver must be env, cli or vscode.`); return undefined; }
  const ref = creds.ref === undefined || creds.ref === null ? '' : String(creds.ref);
  return { resolver, ref };
}

function readList(text: string | undefined, file: string, errors: string[]): unknown[] {
  let raw: unknown;
  try {
    raw = text === undefined ? undefined : parseYaml(text);
  } catch (err) {
    errors.push(`${file} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const list = raw && typeof raw === 'object' ? (raw as { connections?: unknown }).connections : undefined;
  if (raw !== undefined && raw !== null && !Array.isArray(list)) errors.push(`${file} needs a "connections:" list.`);
  return Array.isArray(list) ? list : [];
}

/** One complete entry (team file, or a connection of the engineer's own in the local file). */
function parseEntry(item: unknown, where: string, origin: 'file' | 'local', env: NodeJS.ProcessEnv, errors: string[]): ConnectionEntry | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${where}: not a mapping.`); return undefined; }
  const e = item as Record<string, unknown>;
  const platform = String(e.platform ?? '') as DataPlatformProvider;
  const allowed = CONNECTION_FIELDS[platform];
  if (!allowed) { errors.push(`${where}: platform "${String(e.platform ?? '')}" is not supported (snowflake, databricks, oracle).`); return undefined; }
  const secrets = secretKeys(e);
  if (secrets.length) { errors.push(`${where}: ${secrets.join(', ')} must not be in this file. Supply secrets through the credentials resolver (env vars, the platform CLI's configuration, or VS Code's secret storage).`); return undefined; }
  const role = e.role === undefined ? 'source' : String(e.role);
  if (role !== 'source' && role !== 'target') { errors.push(`${where}: role must be source or target.`); return undefined; }
  if (platform === 'oracle' && role === 'target') { errors.push(`${where}: Oracle is supported as a source only.`); return undefined; }
  const credentials = parseCredentials(e.credentials, where, errors);
  if (!credentials) return undefined;
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(e)) {
    if (KNOWN_KEYS.has(k)) continue;
    if (!allowed.includes(k)) { errors.push(`${where}: unknown field "${k}" (ignored).`); continue; }
    if (v !== undefined && v !== null && String(v) !== '') fields[k] = String(v);
  }
  if (platform === 'oracle' && !fields.connectString && !(credentials.resolver === 'env' && envFields(platform, credentials.ref, env).connectString)) { errors.push(`${where}: an Oracle connection needs connectString (a tnsnames alias or host:port/service).`); return undefined; }
  const idFields = credentials.resolver === 'env' ? { ...envFields(platform, credentials.ref, env), ...fields } : fields;
  const id = e.id !== undefined && String(e.id).trim() ? String(e.id).trim() : connectionIdFor(platform, idFields, credentials);
  return { id, platform, role, fields, credentials, allowSampleDataInPrompts: e.allowSampleDataInPrompts === true, origin };
}

/** Applies a local-file item to the team entry with the same id. */
function applyPersonal(entry: ConnectionEntry, e: Record<string, unknown>, where: string, errors: string[]): void {
  if (e.platform !== undefined && String(e.platform) !== entry.platform) { errors.push(`${where}: platform differs from the team entry "${entry.id}" (ignored).`); return; }
  const secrets = secretKeys(e);
  if (secrets.length) { errors.push(`${where}: ${secrets.join(', ')} must not be in this file either — it is plain text on disk. Use VS Code's secret storage (resolver vscode), env vars or the platform CLI's configuration.`); return; }
  if (e.allowSampleDataInPrompts !== undefined) errors.push(`${where}: allowSampleDataInPrompts is the team's decision — set it in ${layoutRel('connections')} (ignored).`);
  if (e.role !== undefined && String(e.role) !== entry.role) errors.push(`${where}: role is set by the team entry (ignored).`);
  const allowed = CONNECTION_FIELDS[entry.platform] ?? [];
  const personal: string[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (KNOWN_KEYS.has(k)) continue;
    if (!allowed.includes(k)) { errors.push(`${where}: unknown field "${k}" (ignored).`); continue; }
    if (v === undefined || v === null || String(v) === '') continue;
    entry.fields[k] = String(v);
    personal.push(k);
  }
  if (e.credentials !== undefined) {
    const credentials = parseCredentials(e.credentials, where, errors);
    if (credentials) { entry.credentials = credentials; personal.push('credentials'); }
  }
  if (personal.length) entry.personal = personal;
}

export function parseConnectionsConfig(text: string | undefined, env: NodeJS.ProcessEnv = process.env, localText?: string): Omit<ConnectionsConfig, 'file' | 'fileExists' | 'localFile' | 'localFileExists'> {
  const errors: string[] = [];
  const connections: ConnectionEntry[] = [];
  const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  readList(text, layoutRel('connections'), errors).forEach((item, index) => {
    const where = `connections[${index}]`;
    const entry = parseEntry(item, where, 'file', env, errors);
    if (!entry) return;
    if (connections.some((c) => sameId(c.id, entry.id))) { errors.push(`${where}: duplicate connection id "${entry.id}" (ignored).`); return; }
    connections.push(entry);
  });
  readList(localText, layoutRel('localConnections'), errors).forEach((item, index) => {
    const where = `local connections[${index}]`;
    const e = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
    const team = e && e.id !== undefined ? connections.find((c) => c.origin === 'file' && sameId(c.id, String(e.id).trim())) : undefined;
    if (team && e) { applyPersonal(team, e, where, errors); return; }
    if (e && e.id !== undefined && e.platform === undefined) { errors.push(`${where}: no team connection "${String(e.id)}" in ${layoutRel('connections')} to add these fields to (ignored).`); return; }
    const entry = parseEntry(item, where, 'local', env, errors);
    if (!entry) return;
    if (connections.some((c) => sameId(c.id, entry.id))) { errors.push(`${where}: duplicate connection id "${entry.id}" (ignored).`); return; }
    connections.push(entry);
  });
  // The environment-only connection, when the files don't already describe it.
  for (const platform of ['snowflake', 'databricks', 'oracle'] as const) {
    const fields = envFields(platform, '', env);
    if (!(platform === 'snowflake' ? fields.account : platform === 'databricks' ? fields.workspaceUrl : fields.connectString)) continue;
    const credentials = { resolver: 'env', ref: '' };
    const id = connectionIdFor(platform, fields, credentials);
    if (connections.some((c) => sameId(c.id, id))) continue;
    connections.push({ id, platform, role: 'source', fields: {}, credentials, allowSampleDataInPrompts: false, origin: 'environment' });
  }
  return { connections, errors };
}

function readText(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

/** Reads `.autode/config/connections.yaml` and the personal `.autode/local/connections.yaml` (missing = no entries). */
export function loadConnectionsConfig(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): ConnectionsConfig {
  const text = readText(layoutPath(workspaceRoot, 'connections'));
  const localText = readText(layoutPath(workspaceRoot, 'localConnections'));
  return {
    ...parseConnectionsConfig(text, env, localText),
    file: layoutRel('connections'), fileExists: text !== undefined,
    localFile: layoutRel('localConnections'), localFileExists: localText !== undefined
  };
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

/** The secret fields a connection takes from its resolver, given its auth mode. */
export function secretFieldsFor(platform: DataPlatformProvider, fields: Readonly<Record<string, string>>): string[] {
  if (platform === 'databricks') return ['token'];
  if (platform === 'oracle') return fields.walletLocation ? ['password', 'walletPassword'] : ['password'];
  if (platform === 'snowflake') {
    const mode = fields.authMode || 'key-pair';
    if (mode === 'username-password') return ['password'];
    if (mode === 'key-pair') return ['privateKeyPassphrase'];
    return ['token'];
  }
  return [];
}

/**
 * The stand-in `env` for a `vscode` entry's secrets, from the values VS Code's secret
 * storage holds (phase 5): what the extension passes to a server it has VS Code start,
 * so the connection is ready there too. Only the entry's secret fields are passed.
 */
export function standInEnv(entry: Pick<ConnectionEntry, 'platform' | 'fields' | 'credentials'>, secrets: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const field of secretFieldsFor(entry.platform, entry.fields)) {
    const name = envCredentialVariable(entry.platform, entry.credentials.ref, field);
    if (name && secrets[field]) env[name] = secrets[field];
  }
  return env;
}

/** The `env` variables that stand in for a `vscode` entry's secrets outside VS Code. */
export function envStandInVariables(entry: Pick<ConnectionEntry, 'platform' | 'fields' | 'credentials'>): string[] {
  return secretFieldsFor(entry.platform, entry.fields).map((f) => envCredentialVariable(entry.platform, entry.credentials.ref, f)).filter((v): v is string => !!v);
}

/**
 * The credential set `ConnectionManager.connect()` takes: the entry's
 * non-secret fields plus what its resolver supplies (the resolver wins).
 * Throws when a `cli` reference names nothing the CLI's configuration holds,
 * or when a `vscode` entry is used outside VS Code without its stand-in
 * `env` variables.
 */
export async function resolveConnectionCredentials(entry: ConnectionEntry, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  const resolverId = entry.credentials.resolver === 'vscode' ? VSCODE_SECRET_RESOLVER_ID : entry.credentials.resolver;
  const reference: CredentialReference = { platform: entry.platform, principalType: 'interactive-user', ref: entry.credentials.ref, resolverId };
  if (entry.credentials.resolver === 'vscode' && !getCredentialResolver(VSCODE_SECRET_RESOLVER_ID)) {
    // Outside VS Code: the same-named env variables stand in for the secret storage.
    const vars = envStandInVariables(entry);
    const supplied: Record<string, string> = {};
    for (const field of secretFieldsFor(entry.platform, entry.fields)) {
      const name = envCredentialVariable(entry.platform, entry.credentials.ref, field);
      if (name && env[name]) supplied[field] = env[name] as string;
    }
    const optional = entry.platform === 'snowflake' && (entry.fields.authMode || 'key-pair') === 'key-pair';
    if (!Object.keys(supplied).length && !optional) {
      throw new Error(`Connection "${entry.id}" keeps its secret in VS Code's secret storage, which only the AutoDE extension can read. For this client, set ${vars.join(' and ')} in its environment, or use a CLI connection (resolver cli).`);
    }
    return { ...adapterFields(entry.fields), ...supplied };
  }
  const resolved = await resolveCredential(reference);
  if (!resolved && entry.credentials.resolver === 'cli') {
    if (entry.platform === 'oracle') throw new Error('Oracle connections take credentials from environment variables (resolver env) or VS Code\'s secret storage (resolver vscode); the connect string (a tnsnames alias or Easy Connect) is a field of the entry.');
    const where = entry.platform === 'snowflake' ? 'connections.toml' : '.databrickscfg';
    throw new Error(`The ${entry.platform} CLI configuration (${where}) has no connection named "${entry.credentials.ref || 'default'}".`);
  }
  return { ...adapterFields(entry.fields), ...(resolved ?? {}) };
}

// ── Writing (Phase DRV2) ─────────────────────────────────────────────────────

export interface ConnectionDraft {
  platform: DataPlatformProvider;
  role: ConnectionRole;
  /** Non-secret fields; personal ones go to the local file. A secret field is refused. */
  fields: Record<string, string>;
  credentials: { resolver: string; ref: string };
  /** Only for a new team entry or a personal connection; an existing team entry keeps its consent. */
  allowSampleDataInPrompts?: boolean;
  /** `team` (default): the shared part goes to the committed file. `personal`: the whole entry stays in the local file. */
  scope?: 'team' | 'personal';
}

export interface SavedConnection {
  id: string;
  /** Workspace-relative files written. */
  written: string[];
  /** Set when an existing team entry used other credentials: this engineer's choice went to the local file. */
  credentialsLocal?: boolean;
}

const TEAM_HEADER = ' Data-platform connections AutoDE and its MCP server can use (docs/mcp-setup.md).\n Committed: pointers and non-secret settings only. Personal fields live in\n .autode/local/connections.yaml; secrets in env vars, the platform CLI\'s\n configuration or VS Code\'s secret storage.';
const LOCAL_HEADER = ' This engineer\'s connection fields (not committed): merged by id into\n .autode/config/connections.yaml. No secrets here either.';

function loadDoc(file: string, header: string): Document {
  const text = readText(file);
  const doc = text === undefined || !text.trim() ? new Document({ connections: [] }) : parseDocument(text);
  if (doc.errors.length) throw new Error(`${file} is not valid YAML: ${doc.errors[0].message}`);
  if (text === undefined || !text.trim()) doc.commentBefore = header;
  if (!isSeq(doc.get('connections'))) doc.set('connections', doc.createNode([]));
  return doc;
}

function itemId(item: YAMLMap, env: NodeJS.ProcessEnv): string {
  const json = item.toJSON() as Record<string, unknown>;
  if (json.id !== undefined && String(json.id).trim()) return String(json.id).trim();
  const errors: string[] = [];
  return parseEntry(json, '', 'file', env, errors)?.id ?? '';
}

function findItem(doc: Document, id: string, env: NodeJS.ProcessEnv): YAMLMap | undefined {
  const seq = doc.get('connections') as YAMLSeq;
  return seq.items.find((i): i is YAMLMap => isMap(i) && itemId(i, env).toLowerCase() === id.toLowerCase());
}

function credentialsNode(doc: Document, credentials: { resolver: string; ref: string }) {
  const node = doc.createNode(credentials.ref ? { resolver: credentials.resolver, ref: credentials.ref } : { resolver: credentials.resolver });
  (node as YAMLMap).flow = true;
  return node;
}

function writeDoc(file: string, doc: Document): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, doc.toString());
  fs.renameSync(tmp, file);
}

/**
 * Writes a connection: the shared part to the team file (comments kept), the
 * personal fields to the local file. Returns the id the connection has.
 * Throws on a secret field, an unknown platform/field or resolver.
 */
export function saveConnection(workspaceRoot: string, draft: ConnectionDraft, env: NodeJS.ProcessEnv = process.env): SavedConnection {
  const allowed = CONNECTION_FIELDS[draft.platform];
  if (!allowed) throw new Error(`Platform "${draft.platform}" is not supported (snowflake, databricks, oracle).`);
  if (draft.platform === 'oracle' && draft.role === 'target') throw new Error('Oracle is supported as a source only.');
  const secrets = secretKeys(draft.fields);
  if (secrets.length) throw new Error(`${secrets.join(', ')} can't be written to a connections file; it goes to the credentials resolver.`);
  if (!CONNECTION_RESOLVERS.includes(draft.credentials.resolver)) throw new Error('credentials.resolver must be env, cli or vscode.');
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(draft.fields)) {
    if (!allowed.includes(k)) throw new Error(`Unknown ${draft.platform} field "${k}".`);
    if (v !== undefined && v !== null && String(v).trim() !== '') fields[k] = String(v).trim();
  }
  const id = connectionIdFor(draft.platform, fields, draft.credentials);
  ensureLayout(workspaceRoot);
  const teamFile = layoutPath(workspaceRoot, 'connections');
  const localFile = layoutPath(workspaceRoot, 'localConnections');
  const team = loadDoc(teamFile, TEAM_HEADER);
  const local = loadDoc(localFile, LOCAL_HEADER);
  const written: string[] = [];
  let credentialsLocal = false;

  const personal = Object.fromEntries(Object.entries(fields).filter(([k]) => PERSONAL_FIELDS.includes(k)));
  const shared = Object.fromEntries(Object.entries(fields).filter(([k]) => !PERSONAL_FIELDS.includes(k)));
  const existingLocal = findItem(local, id, env);
  const existingTeam = findItem(team, id, env);

  if (draft.scope === 'personal' && !existingTeam) {
    const node = entryNode(local, id, draft, fields);
    replaceOrAdd(local, existingLocal, node);
    writeDoc(localFile, local);
    return { id, written: [layoutRel('localConnections')] };
  }

  let localCredentials: { resolver: string; ref: string } | undefined;
  if (existingTeam) {
    const current = existingTeam.toJSON() as Record<string, unknown>;
    const creds = (current.credentials ?? {}) as Record<string, unknown>;
    const same = String(creds.resolver ?? 'env') === draft.credentials.resolver && String(creds.ref ?? '') === draft.credentials.ref;
    if (!same) { localCredentials = draft.credentials; credentialsLocal = true; }
    for (const k of allowed) if (!PERSONAL_FIELDS.includes(k) && !(k in shared) && existingTeam.has(k)) existingTeam.delete(k);
    for (const [k, v] of Object.entries(shared)) existingTeam.set(k, v);
    if (!existingTeam.has('id')) existingTeam.set('id', id);
  } else {
    const node = entryNode(team, id, draft, shared);
    replaceOrAdd(team, undefined, node);
  }
  writeDoc(teamFile, team);
  written.push(layoutRel('connections'));

  if (Object.keys(personal).length || localCredentials) {
    const item: Record<string, unknown> = { id, ...personal };
    const node = local.createNode(item) as YAMLMap;
    if (localCredentials) node.set('credentials', credentialsNode(local, localCredentials));
    replaceOrAdd(local, existingLocal, node);
    writeDoc(localFile, local);
    written.push(layoutRel('localConnections'));
  } else if (existingLocal) {
    replaceOrAdd(local, existingLocal, undefined);
    writeDoc(localFile, local);
    written.push(layoutRel('localConnections'));
  }
  return { id, written, credentialsLocal: credentialsLocal || undefined };
}

function entryNode(doc: Document, id: string, draft: ConnectionDraft, fields: Record<string, string>): YAMLMap {
  const node = doc.createNode({ id, platform: draft.platform, role: draft.role, ...fields }) as YAMLMap;
  node.set('credentials', credentialsNode(doc, draft.credentials));
  node.set('allowSampleDataInPrompts', draft.allowSampleDataInPrompts === true);
  return node;
}

function replaceOrAdd(doc: Document, existing: YAMLMap | undefined, node: YAMLMap | undefined): void {
  const seq = doc.get('connections') as YAMLSeq;
  const index = existing ? seq.items.indexOf(existing) : -1;
  if (index >= 0 && node) seq.items[index] = node;
  else if (index >= 0) seq.items.splice(index, 1);
  else if (node) seq.items.push(node);
}

/** Removes a connection from both files. Returns the files changed. */
export function removeConnection(workspaceRoot: string, id: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const changed: string[] = [];
  for (const [key, header] of [['connections', TEAM_HEADER], ['localConnections', LOCAL_HEADER]] as const) {
    const file = layoutPath(workspaceRoot, key);
    if (readText(file) === undefined) continue;
    const doc = loadDoc(file, header);
    const item = findItem(doc, id, env);
    if (!item) continue;
    replaceOrAdd(doc, item, undefined);
    writeDoc(file, doc);
    changed.push(layoutRel(key));
  }
  return changed;
}
