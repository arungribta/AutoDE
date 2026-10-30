import { DataAgentHubSettings, DataPlatformProvider } from '../engine/types';
import { ConnectionInfo } from '../engine/platform/types';
import { ConnectionManager } from '../engine/platform/ConnectionManager';
import {
  CONNECTION_FIELDS, ConnectionDraft, ConnectionEntry, ConnectionOrigin, ConnectionRole, connectionIdFor,
  adapterFields, loadConnectionsConfig, removeConnection, resolveConnectionCredentials, saveConnection, secretFieldsFor
} from '../engine/platform/connectionsConfig';
import { ConnectionStatus, connectionStatus, forgetReadiness, readReadiness, recordReadiness } from '../engine/platform/connectionReadiness';
import { Prerequisite, checkPrerequisites } from '../engine/platform/prerequisites';
import { driversRoot } from '../engine/platform/driverStore';
import { databricksConfigPath, readDatabricksCfgProfiles } from '../engine/platform/credentials/databricksCfg';
import { listSnowflakeConnectionNames, snowflakeConnectionsTomlPath } from '../engine/platform/credentials/CliConfigResolver';
import { readTnsNames } from '../engine/platform/credentials/tnsnames';
import { getCliDescriptor } from '../engine/platform/credentials/cliRegistry';
import { definedConnectionPlatforms, platformDefinition } from '../engine/platform/definitions';
import { ConnectionField } from '../engine/platform/operations/types';

/**
 * Platform onboarding in the settings cards (docs/specs/mcp-engine.md
 * §9.1 Phase DRV2). Each platform card shows its prerequisites (DRV1 model),
 * the backend it will use, existing CLI connections or tnsnames aliases, and
 * saves the card as a **named connection** in `.autode/config/connections.yaml`
 * (personal fields in `.autode/local/connections.yaml`) — but only after a
 * connectivity check passes. Secrets typed into a card move to VS Code's
 * secret storage under the connection's reference (resolver `vscode`).
 *
 * No `vscode` import: the host passes secret storage, settings and a
 * connection factory, so tests drive this directly.
 */

export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface OnboardingHost {
  workspaceRoot: () => string | undefined;
  /** Where `prerequisites.yaml` is: the extension's folder (v0.45.6). */
  resourcesRoot?: () => string | undefined;
  settings: () => DataAgentHubSettings;
  secrets: SecretStore;
  /** Where a `vscode` entry's secret field is stored (`secretStorageKey`). */
  secretKey: (platform: DataPlatformProvider, ref: string, field: string) => string;
  /** The key a card's own secret field has been saved under (`SECRET_KEYS`), if any. */
  cardSecretKey: (role: ConnectionRole, platform: DataPlatformProvider, field: string) => string | undefined;
  /** A connection manager configured like the extension's own (consent, drivers). */
  createManager: (log: (msg: string) => void) => ConnectionManager;
  log: (line: string) => void;
}

export interface SavedConnectionView {
  id: string;
  platform: DataPlatformProvider;
  role: ConnectionRole;
  origin: ConnectionOrigin;
  resolver: string;
  ref: string;
  personal: string[];
  allowSampleDataInPrompts: boolean;
  status: ConnectionStatus;
}

/** v0.55.0: a card drawn from a platform's definition (no card written for it). */
export interface DefinedCard {
  id: string;
  title: string;
  roles: ConnectionRole[];
  fields: ConnectionField[];
  authModes: Array<{ mode: string; label: string; requires?: string[]; note?: string }>;
  exactlyOne: string[][];
  /** The field a CLI profile fills, when one is picked. */
  cliProfileField?: string;
  /** How its CLI lists profiles, for the "existing" picker's label. */
  existingLabel: string;
  targetNote?: string;
  backend: { backend: string; caveat: string };
}

export interface PlatformsState {
  /** v0.55.0: the platforms whose card is drawn from their definition. */
  defined: DefinedCard[];
  connections: SavedConnectionView[];
  active: { source: string; target: string };
  errors: string[];
  files: { team: string; teamExists: boolean; local: string; localExists: boolean };
  /** The backend each card will use, with its caveat (Snowflake: by auth mode, plus `cli` for a CLI connection). */
  backends: Record<string, { backend: string; caveat: string }>;
  /** No workspace folder: nothing can be saved. */
  noWorkspace?: boolean;
}

export interface ExistingConnections {
  kind: 'cli' | 'tns';
  items: Array<{ name: string; usable: boolean; detail?: string }>;
  where: string;
  problem?: string;
}

export interface OnboardingResult {
  ok: boolean;
  message: string;
  id?: string;
}

/** The backend each platform card will use, with its caveat — Snowflake's depends on the auth mode. */
export function backendFor(platform: DataPlatformProvider, authMode?: string, viaCli?: boolean): { backend: string; caveat: string } {
  if (platform === 'snowflake') {
    if (viaCli || authMode === 'username-password') return { backend: 'Snowflake CLI (native protocol)', caveat: 'Needs the Snowflake CLI and your consent for AutoDE to run it. Works where the SQL API is blocked; MCP clients need the server started with --allow-cli.' };
    return { backend: 'Snowflake SQL API (REST)', caveat: 'No CLI needed. Accepts key-pair or a token, not a plain password; needs a database for the session.' };
  }
  if (platform === 'databricks') return { backend: 'Statement Execution API (REST)', caveat: 'The only backend: the Databricks CLI wraps the same API, so AutoDE reads its profiles but never runs it. Needs a SQL warehouse HTTP path.' };
  if (platform === 'oracle') return { backend: 'node-oracledb, Thin mode', caveat: 'Oracle Database 12.1 or later. 11g and older need Thick mode (Oracle Instant Client), which AutoDE does not load. Oracle is a source only.' };
  const d = platformDefinition(platform);
  const cli = d?.connection ? d.access?.cli : undefined;
  if (d && cli?.statement) return { backend: `The ${cli.command} CLI${cli.statement.mode === 'async' ? ' (statements submitted, then fetched)' : ''}`, caveat: `Needs the ${cli.command} CLI${cli.minVersion ? ` ${cli.minVersion} or later` : ''} and your consent for AutoDE to run it; MCP clients need the server started with --allow-cli. Defined by platforms/${d.id}.yaml.` };
  return { backend: 'not supported', caveat: '' };
}

/** The reference a `vscode` entry's secrets are stored under: the connection id without its platform. */
function secretRef(id: string, platform: DataPlatformProvider): string {
  return id.startsWith(`${platform}:`) ? id.slice(platform.length + 1) : 'default';
}

function cardFields(platform: DataPlatformProvider, role: ConnectionRole, settings: DataAgentHubSettings): Record<string, string> {
  const all = ConnectionManager.getCredentialsFromSettings(platform, settings as unknown as Record<string, unknown>, role);
  if (platform === 'snowflake' && 'role' in all) { all['snowflakeRole'] = all['role']; delete all['role']; }
  const allowed = CONNECTION_FIELDS[platform] ?? [];
  return Object.fromEntries(Object.entries(all).filter(([k, v]) => allowed.includes(k) && v && v.trim()));
}

/** The cards for platforms defined by files. */
export function definedCards(scope: { workspaceRoot?: string; resourcesRoot?: string } = {}): DefinedCard[] {
  return definedConnectionPlatforms(scope).map((d) => {
    const c = d.connection!;
    const cli = d.access?.cli;
    return {
      id: d.id, title: d.title, roles: c.roles ?? ['source', 'target'], fields: c.fields, authModes: c.authModes ?? [], exactlyOne: c.exactlyOne ?? [],
      cliProfileField: c.cliProfileField, existingLabel: cli?.listProfiles ? `${cli.command} profile` : 'profile', targetNote: c.targetNote,
      backend: backendFor(d.id as DataPlatformProvider)
    };
  });
}

export class PlatformOnboarding {
  constructor(private readonly host: OnboardingHost) {}

  state(): PlatformsState {
    const settings = this.host.settings();
    const active = { source: settings.activeSourceConnection ?? '', target: settings.activeTargetConnection ?? '' };
    const backends: PlatformsState['backends'] = {
      'snowflake:cli': backendFor('snowflake', undefined, true), 'snowflake:username-password': backendFor('snowflake', 'username-password'), snowflake: backendFor('snowflake', 'key-pair'),
      databricks: backendFor('databricks'), oracle: backendFor('oracle')
    };
    const root = this.host.workspaceRoot();
    const defined = definedCards({ workspaceRoot: root, resourcesRoot: this.host.resourcesRoot?.() });
    for (const d of defined) backends[d.id] = d.backend;
    if (!root) return { defined, connections: [], active, errors: [], files: { team: '', teamExists: false, local: '', localExists: false }, backends, noWorkspace: true };
    const config = loadConnectionsConfig(root);
    const readiness = readReadiness(root);
    return {
      defined,
      connections: config.connections.map((c) => ({
        id: c.id, platform: c.platform, role: c.role, origin: c.origin, resolver: c.credentials.resolver, ref: c.credentials.ref,
        personal: c.personal ?? [], allowSampleDataInPrompts: c.allowSampleDataInPrompts, status: connectionStatus(c, readiness[c.id])
      })),
      active, errors: config.errors, backends,
      files: { team: config.file, teamExists: config.fileExists, local: config.localFile, localExists: config.localFileExists }
    };
  }

  /** Version checks only (`snow --version`, `npm --version`); run on the user's click. */
  async prerequisites(platform: DataPlatformProvider): Promise<Prerequisite[]> {
    const s = this.host.settings();
    return checkPrerequisites({ driversRoot: driversRoot(s.driversDirectory), snowflakeCliPath: s.snowflakeCliPath, databricksCliPath: s.databricksCliPath, platforms: [platform], resourcesRoot: this.host.resourcesRoot?.(), workspaceRoot: this.host.workspaceRoot() });
  }

  /** Connections the platform's own configuration already has — read from files, nothing is run. */
  async existing(platform: DataPlatformProvider): Promise<ExistingConnections> {
    if (platform === 'snowflake') {
      const names = await listSnowflakeConnectionNames();
      return { kind: 'cli', where: snowflakeConnectionsTomlPath(), items: (names ?? []).map((name) => ({ name, usable: true })), problem: names ? undefined : 'No connections.toml — run "snow connection add" to create one.' };
    }
    if (platform === 'databricks') {
      const profiles = await readDatabricksCfgProfiles();
      return {
        kind: 'cli', where: databricksConfigPath(), problem: profiles ? undefined : 'No .databrickscfg — run "databricks configure" to create one.',
        items: (profiles ?? []).map((p) => ({ name: p.name, usable: !!p.fields['token'], detail: p.fields['token'] ? p.fields['host'] : `no token${p.fields['auth_type'] ? ` (auth_type ${p.fields['auth_type']})` : ''} — AutoDE needs a personal access token` }))
      };
    }
    if (platform === 'oracle') {
      const tns = readTnsNames(this.host.settings().oracleConfigDir || undefined);
      return { kind: 'tns', where: tns.file ?? tns.location?.dir ?? '', items: tns.aliases.map((name) => ({ name, usable: true })), problem: tns.problem };
    }
    // v0.55.0: a platform defined by files lists its CLI's profiles (names only).
    const d = platformDefinition(platform);
    const descriptor = d?.connection ? getCliDescriptor(platform) : undefined;
    if (d && descriptor) {
      const found = await descriptor.detect();
      if (!found.found || !found.cliPath) return { kind: 'cli', where: '', items: [], problem: found.error ?? `The ${d.access?.cli?.command} CLI was not found.` };
      const items = await descriptor.listConnections(found.cliPath);
      return { kind: 'cli', where: `${d.access?.cli?.command} ${(d.access?.cli?.listProfiles ?? []).join(' ')}`, items: items.map((i) => ({ name: i.name, usable: true })), problem: items.length ? undefined : `No ${d.access?.cli?.command} profiles yet: the autode-${d.id}-* skills say how to add one.` };
    }
    return { kind: 'cli', where: '', items: [], problem: `No onboarding for ${platform}.` };
  }

  /**
   * v0.55.0: saves a card drawn from a platform's definition. The values are
   * what the card holds (secret fields included, which go to VS Code's secret
   * storage, never a file); a CLI profile, when picked, is the credentials
   * reference. Checked first; nothing is written if the check fails.
   */
  async saveDefinedCard(platform: DataPlatformProvider, role: ConnectionRole, values: Record<string, string>, options: { cliRef?: string; scope?: 'team' | 'personal' } = {}): Promise<OnboardingResult> {
    const root = this.host.workspaceRoot();
    if (!root) return { ok: false, message: 'Open a workspace folder first: named connections are saved in it.' };
    const c = platformDefinition(platform, { workspaceRoot: root, resourcesRoot: this.host.resourcesRoot?.() })?.connection;
    if (!c) return { ok: false, message: `${platform} has no connection in its platform definition.` };
    const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const fields: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const f of c.fields) {
      const v = clean(values[f.name]);
      if (!v || (options.cliRef && f.name === c.cliProfileField)) continue;
      if (f.secret) secrets[f.name] = v; else fields[f.name] = v;
    }
    const cliRef = clean(options.cliRef);
    const provisional = connectionIdFor(platform, fields, { resolver: cliRef ? 'cli' : 'vscode', ref: cliRef });
    const draft: ConnectionDraft = { platform, role, fields, credentials: cliRef ? { resolver: 'cli', ref: cliRef } : { resolver: 'vscode', ref: secretRef(provisional, platform) }, scope: options.scope };
    const probe: ConnectionEntry = { id: provisional, platform, role, fields, credentials: draft.credentials, allowSampleDataInPrompts: false, origin: 'file' };
    let info: ConnectionInfo;
    try {
      const credentials = { ...adapterFields(fields), ...secrets, ...(cliRef && c.cliProfileField ? { [c.cliProfileField]: cliRef } : {}) };
      this.host.log(`Checking ${probe.id} before saving it…`);
      info = await this.check(platform, credentials);
    } catch (err) {
      return { ok: false, id: probe.id, message: `Not saved — the connectivity check failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    for (const [field, value] of Object.entries(secrets)) await this.host.secrets.store(this.host.secretKey(platform, draft.credentials.ref, field), value);
    const saved = saveConnection(root, draft);
    const entry = loadConnectionsConfig(root).connections.find((x) => x.id === saved.id);
    const detail = `${info.databaseName}${info.schemaName ? `.${info.schemaName}` : ''} (${info.version})`;
    if (entry) recordReadiness(root, entry, true, detail);
    return { ok: true, id: saved.id, message: `Saved ${saved.id} to ${saved.written.join(' and ')} — connectivity check passed: ${detail}.` };
  }

  /** The draft a card describes, and the secrets to store with it. */
  async draftFromCard(platform: DataPlatformProvider, role: ConnectionRole, cliRef?: string): Promise<{ draft: ConnectionDraft; secrets: Record<string, string> }> {
    const settings = this.host.settings();
    const fields = cardFields(platform, role, settings);
    if (cliRef) {
      // The CLI's configuration carries account/host and credentials; the card adds what it can't.
      const keep = platform === 'databricks' ? ['httpPath', 'catalog', 'schema', 'catalogType'] : [];
      return { draft: { platform, role, fields: Object.fromEntries(Object.entries(fields).filter(([k]) => keep.includes(k))), credentials: { resolver: 'cli', ref: cliRef } }, secrets: {} };
    }
    const id = connectionIdFor(platform, fields, { resolver: 'vscode', ref: '' });
    const secrets: Record<string, string> = {};
    for (const field of secretFieldsFor(platform, fields)) {
      const key = this.host.cardSecretKey(role, platform, field);
      const value = key ? await this.host.secrets.get(key) : undefined;
      if (value) secrets[field] = value;
    }
    return { draft: { platform, role, fields, credentials: { resolver: 'vscode', ref: secretRef(id, platform) } }, secrets };
  }

  private async check(platform: DataPlatformProvider, credentials: Record<string, string>): Promise<ConnectionInfo> {
    const manager = this.host.createManager((msg) => this.host.log(msg));
    try {
      return await manager.connect(platform, credentials);
    } finally {
      try { await manager.disconnect(); } catch { /* best-effort */ }
      manager.dispose();
    }
  }

  /**
   * Checks what the card describes and, only if the check passes, saves it as
   * a named connection (secrets to secret storage, readiness recorded).
   * Nothing is written when the check fails.
   */
  async saveFromCard(platform: DataPlatformProvider, role: ConnectionRole, options: { cliRef?: string; scope?: 'team' | 'personal' } = {}): Promise<OnboardingResult> {
    const root = this.host.workspaceRoot();
    if (!root) return { ok: false, message: 'Open a workspace folder first: named connections are saved in it.' };
    if (platform === 'oracle' && role === 'target') return { ok: false, message: 'Oracle is supported as a source only.' };
    const { draft, secrets } = await this.draftFromCard(platform, role, options.cliRef);
    draft.scope = options.scope;
    const probe: ConnectionEntry = { id: connectionIdFor(platform, draft.fields, draft.credentials), platform, role, fields: draft.fields, credentials: draft.credentials, allowSampleDataInPrompts: false, origin: 'file' };
    let info: ConnectionInfo;
    try {
      const credentials = draft.credentials.resolver === 'cli' ? await resolveConnectionCredentials(probe) : { ...adapterFields(draft.fields), ...secrets };
      this.host.log(`Checking ${probe.id} before saving it…`);
      info = await this.check(platform, credentials);
    } catch (err) {
      return { ok: false, id: probe.id, message: `Not saved — the connectivity check failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    for (const [field, value] of Object.entries(secrets)) await this.host.secrets.store(this.host.secretKey(platform, draft.credentials.ref, field), value);
    const saved = saveConnection(root, draft);
    const entry = loadConnectionsConfig(root).connections.find((c) => c.id === saved.id);
    const detail = `${info.databaseName}.${info.schemaName} (${info.version})`;
    if (entry) recordReadiness(root, entry, true, detail);
    const where = saved.written.join(' and ');
    const note = saved.credentialsLocal ? ' The team entry uses other credentials, so yours went to the local file.' : '';
    return { ok: true, id: saved.id, message: `Saved ${saved.id} to ${where} — connectivity check passed: ${detail}.${note}` };
  }

  /** Resolves a named connection the way the MCP server does, plus VS Code's secret storage. */
  async credentialsFor(id: string): Promise<{ entry: ConnectionEntry; credentials: Record<string, string> }> {
    const root = this.host.workspaceRoot();
    const entry = root ? loadConnectionsConfig(root).connections.find((c) => c.id.toLowerCase() === id.toLowerCase()) : undefined;
    if (!entry) throw new Error(`No connection "${id}" in .autode/config/connections.yaml or .autode/local/connections.yaml. Pick another in Saved connections, or stop using it to connect with the card's fields.`);
    return { entry, credentials: await resolveConnectionCredentials(entry) };
  }

  /** Records the outcome of a connect to a named connection (from the Connect button or Re-check). */
  markChecked(entry: ConnectionEntry, ok: boolean, detail: string): void {
    const root = this.host.workspaceRoot();
    if (root) recordReadiness(root, entry, ok, detail);
  }

  async recheck(id: string): Promise<OnboardingResult> {
    let resolved: { entry: ConnectionEntry; credentials: Record<string, string> };
    try { resolved = await this.credentialsFor(id); } catch (err) { return { ok: false, id, message: err instanceof Error ? err.message : String(err) }; }
    try {
      const info = await this.check(resolved.entry.platform, resolved.credentials);
      const detail = `${info.databaseName}.${info.schemaName} (${info.version})`;
      this.markChecked(resolved.entry, true, detail);
      return { ok: true, id, message: `${id}: connectivity check passed — ${detail}.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.markChecked(resolved.entry, false, message);
      return { ok: false, id, message: `${id}: connectivity check failed — ${message}` };
    }
  }

  /** Removes the entry from both files, its readiness and its stored secrets. The caller confirms first. */
  async remove(id: string): Promise<OnboardingResult> {
    const root = this.host.workspaceRoot();
    if (!root) return { ok: false, message: 'No workspace folder.' };
    const entry = loadConnectionsConfig(root).connections.find((c) => c.id === id);
    const changed = removeConnection(root, id);
    forgetReadiness(root, id);
    if (entry?.credentials.resolver === 'vscode') {
      const fields = new Set(['password', 'token', 'privateKeyPassphrase', 'walletPassword', ...secretFieldsFor(entry.platform, entry.fields)]);
      for (const field of fields) await this.host.secrets.delete(this.host.secretKey(entry.platform, entry.credentials.ref, field));
    }
    if (!changed.length) return { ok: false, id, message: entry?.origin === 'environment' ? `${id} comes from environment variables, not a file — unset them to remove it.` : `${id} is not in a connections file.` };
    return { ok: true, id, message: `Removed ${id} from ${changed.join(' and ')}.` };
  }
}
