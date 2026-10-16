import type { ObjectIdentity } from '../context/estate';
import { DataPlatformProvider } from '../types';
import { Disposable, IDataSourceAdapter, ConnectionInfo, SchemaSnapshot, ExtractOptions, QueryOptions, QueryResult, PlatformCapabilities } from './types';
import { SnowflakeAdapter } from './adapters/SnowflakeAdapter';
import { DatabricksAdapter } from './adapters/DatabricksAdapter';
import { OracleAdapter, OracleDriver } from './adapters/OracleAdapter';
import { driversRoot, loadDriver } from './driverStore';
import { getSupportedProviders } from './providerRegistry';
import { FileIo, nodeFileIo, writeFileAtomic } from '../context/contextStore';
import type { CatalogEntry, CatalogFetcher } from '../context/catalog';
import { DEFAULT_ENVIRONMENT, parseObjectId, slugifyId } from '../context/estate';
import { ProbeExecutor, createSqlProbeExecutor } from '../context/probes';
import { BaseDataSourceAdapter } from './BaseAdapter';
import type { BaseNode, GraphEdge } from '../context/types';
import { LAYOUT, layoutRel } from '../workspaceLayout';
import { sanitizeSnapshot } from './sampleData';
import { checkReadOnlySql } from './sqlGuard';

export type AdapterFactory = (credentials: Record<string, string>, log: (msg: string) => void) => IDataSourceAdapter;

export interface ConnectionManagerOptions {
  /**
   * Whether the user consented to AutoDE shelling out to a data-platform CLI
   * (the `dataPlatformCliConsent` setting). Read at connect time, not
   * construction, so a settings change applies to the next connection. Passed
   * in rather than read from VS Code settings so the engine has no `vscode`
   * dependency (v0.26.0). Defaults to no consent.
   */
  cliConsent?: () => boolean;
  /**
   * Phase 4: whether row values from this connection may reach a prompt (the
   * per-connection `allowSampleDataInPrompts` in `.autode/config/connections.yaml`,
   * see `sampleDataConsentFromWorkspace()`). Off — the default — extraction
   * keeps schema, counts and aggregates and drops profile min/max values and
   * lineage query text; on, personal-data columns are still masked.
   */
  sampleDataConsent?: (connectionId: string | undefined) => boolean;
  /**
   * Phase DRV1: where user-installed drivers live (`driversDirectory` setting,
   * `AUTODE_DRIVERS_DIR`, else `~/.autode/drivers`). Read at connect time; a
   * driver is loaded on first connect, never earlier, and only once verified.
   */
  driversRoot?: () => string | undefined;
}

/**
 * Where a connection's objects belong in the estate, and which schemas to
 * extract (Phase K1). Supplied by the host from `.autode/knowledge/estate.yaml`.
 */
export type EstateResolver = (connectionId: string) => { identity: ObjectIdentity; schemas?: string[] } | undefined;

/**
 * Manages the lifecycle of data platform connections.
 * Owns the active adapter and provides a unified interface for sub-agents.
 */
export class ConnectionManager implements Disposable {
  private activeAdapter: IDataSourceAdapter | null = null;
  private adapterFactories: Map<DataPlatformProvider, AdapterFactory> = new Map();
  private estateResolver?: EstateResolver;
  private readonly sampleDataConsent: (connectionId: string | undefined) => boolean;

  constructor(private readonly log: (msg: string) => void, options: ConnectionManagerOptions = {}) {
    this.sampleDataConsent = options.sampleDataConsent ?? (() => false);
    const cliConsent = options.cliConsent ?? (() => false);
    // Register adapter factories for supported platforms
    this.adapterFactories.set('snowflake', (creds, l) => new SnowflakeAdapter(creds, l, { cliConsent: cliConsent() }));
    this.adapterFactories.set('databricks', (creds, l) => new DatabricksAdapter(creds, l));
    this.adapterFactories.set('oracle', (creds, l) => new OracleAdapter(creds, l, { loadDriver: () => loadDriver<OracleDriver>(driversRoot(options.driversRoot?.()), 'oracle') }));
    // Future: bigquery, redshift, synapse
  }

  /** Registers (or replaces) the adapter for a platform — further platforms, and fakes in tests. */
  registerAdapterFactory(platform: DataPlatformProvider, factory: AdapterFactory): void {
    this.adapterFactories.set(platform, factory);
  }

  /** Whether row values from the active connection may reach a prompt (phase 4). */
  allowsSampleData(): boolean {
    return this.sampleDataConsent(this.activeConnectionId());
  }

  dispose(): void {
    if (this.activeAdapter) {
      try {
        this.activeAdapter.dispose();
      } catch {
        // Best-effort cleanup
      }
      this.activeAdapter = null;
    }
  }

  /**
   * Connect to a data platform.
   * Disconnects any existing connection first.
   */
  async connect(platform: DataPlatformProvider, credentials: Record<string, string>): Promise<ConnectionInfo> {
    // Disconnect existing
    if (this.activeAdapter) {
      try {
        await this.activeAdapter.disconnect();
        this.activeAdapter.dispose();
      } catch (err) {
        this.log(`Error disconnecting previous adapter: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.activeAdapter = null;
    }

    const factory = this.adapterFactories.get(platform);
    if (!factory) {
      throw new Error(`No adapter registered for platform: ${platform}. Supported platforms: ${Array.from(this.adapterFactories.keys()).join(', ')}`);
    }

    this.activeAdapter = factory(credentials, this.log);
    const info = await this.activeAdapter.connect();
    this.log(`Connected to ${platform}: ${info.databaseName}.${info.schemaName}`);
    return info;
  }

  /**
   * Disconnect from the current platform.
   */
  async disconnect(): Promise<void> {
    if (this.activeAdapter) {
      await this.activeAdapter.disconnect();
      this.activeAdapter.dispose();
      this.activeAdapter = null;
      this.log('Disconnected from data platform.');
    }
  }

  /**
   * Get the active adapter, or null if not connected.
   */
  getActiveAdapter(): IDataSourceAdapter | null {
    return this.activeAdapter;
  }

  /**
   * Check if connected to a data platform.
   */
  isConnected(): boolean {
    return this.activeAdapter !== null;
  }

  /**
   * Get the active platform, or null if not connected.
   */
  getActivePlatform(): DataPlatformProvider | null {
    if (!this.activeAdapter) return null;
    // Infer platform from adapter type
    if (this.activeAdapter instanceof SnowflakeAdapter) return 'snowflake';
    if (this.activeAdapter instanceof DatabricksAdapter) return 'databricks';
    if (this.activeAdapter instanceof OracleAdapter) return 'oracle';
    return null;
  }

  /**
   * Extract metadata from the connected platform.
   */
  /** Phase K1: lets the host say which system a connection feeds and which schemas to extract. */
  setEstateResolver(resolver: EstateResolver | undefined): void {
    this.estateResolver = resolver;
  }

  /** The active connection's id (e.g. `snowflake:acme`), for estate lookups. */
  activeConnectionId(): string | undefined {
    return this.activeAdapter?.getConnectionId?.();
  }

  /** The estate identity of the active connection, when the host supplied a resolver. */
  activeIdentity(): ObjectIdentity | undefined {
    const id = this.activeConnectionId();
    return id && this.estateResolver ? this.estateResolver(id)?.identity : undefined;
  }

  async extractMetadata(options?: ExtractOptions): Promise<SchemaSnapshot> {
    if (!this.activeAdapter) {
      throw new Error('No active connection. Connect to a data platform first.');
    }
    // Schemas from the estate binding apply unless the caller named its own.
    const id = this.activeConnectionId();
    const binding = id && this.estateResolver ? this.estateResolver(id) : undefined;
    const effective = !options?.schemaFilter?.length && binding?.schemas?.length ? { ...options, schemaFilter: binding.schemas } : options;
    return sanitizeSnapshot(await this.activeAdapter.extractMetadata(effective), this.sampleDataConsent(id));
  }

  /**
   * Phase K2: live structure lookups for the catalog — query-through for
   * tables whose structure isn't loaded, and last-altered checks for refresh
   * on use. Covers the system and environment this connection feeds.
   * `undefined` when nothing is connected.
   */
  catalogFetcher(): CatalogFetcher | undefined {
    const adapter = this.activeAdapter;
    if (!adapter) return undefined;
    const identity = () => this.activeIdentity() ?? { system: slugifyId(adapter.getConnectionId?.() ?? 'source'), environment: DEFAULT_ENVIRONMENT, role: 'source' as const };
    const scopeOf = (e: CatalogEntry) => (e.table.database ? `${e.table.database}.${e.table.schema}` : e.table.schema);
    const byScope = (entries: readonly CatalogEntry[]) => {
      const m = new Map<string, CatalogEntry[]>();
      for (const e of entries) m.set(scopeOf(e), [...(m.get(scopeOf(e)) ?? []), e]);
      return m;
    };
    return {
      covers: (system, environment) => {
        const i = identity();
        return i.system === system && i.environment === environment;
      },
      fetchStructure: async (entries) => {
        const nodes: BaseNode[] = [];
        const edges: GraphEdge[] = [];
        for (const [scope, list] of byScope(entries)) {
          const snapshot = await adapter.extractMetadata({ schemaFilter: [scope], tableFilter: list.map((e) => e.table.label), includeProfiling: false });
          const g = adapter.snapshotToGraph(snapshot, identity());
          nodes.push(...g.nodes);
          edges.push(...g.edges);
        }
        return { nodes, edges };
      },
      lastAltered: adapter instanceof BaseDataSourceAdapter ? async (entries) => {
        const out = new Map<string, string>();
        for (const [scope, list] of byScope(entries)) {
          const found = await adapter.readLastAltered(scope, list.map((e) => e.table.label));
          for (const e of list) {
            const at = found.get(e.table.fqn.toLowerCase()) ?? found.get(`${e.table.schema}.${e.table.label}`.toLowerCase());
            if (at) out.set(e.id, at);
          }
        }
        return out;
      } : undefined
    };
  }

  /**
   * Phase C4a: verification probes on this connection — read-only aggregate
   * queries from fixed templates (`probes.ts`), sampled, one row back. Covers
   * only tables of the system and environment this connection feeds.
   */
  probeExecutor(options: { sampleRows?: number } = {}): ProbeExecutor | undefined {
    const adapter = this.activeAdapter;
    const platform = this.getActivePlatform();
    if (!adapter || !platform) return undefined;
    const identity = this.activeIdentity();
    return createSqlProbeExecutor(
      async (sql) => {
        // Probe templates are fixed and read-only; the guard makes sure nothing else ever runs through here.
        const check = checkReadOnlySql(sql);
        if (!check.ok) throw new Error(`Probe refused: ${check.reason}`);
        return (await adapter.executeQuery(sql, { maxRows: 1, timeoutMs: 60000 })).rows;
      },
      platform === 'snowflake' ? 'snowflake' : platform === 'databricks' ? 'spark_sql' : platform === 'oracle' ? 'oracle' : 'ansi',
      {
        sampleRows: options.sampleRows ?? 50_000,
        covers: (tableId) => {
          const p = tableId ? parseObjectId(tableId) : undefined;
          return !!p && (!identity || (p.system === identity.system && p.environment === identity.environment));
        }
      }
    );
  }

  /** Lists databases/catalogs visible to the connected principal (Step 4 — discovery-based selection, not blind typing). */
  async listDatabases(): Promise<string[]> {
    if (!this.activeAdapter) {
      throw new Error('No active connection. Connect to a data platform first.');
    }
    return this.activeAdapter.listDatabases();
  }

  /** Lists schemas within a database/catalog on the connected platform. */
  async listSchemas(database: string): Promise<string[]> {
    if (!this.activeAdapter) {
      throw new Error('No active connection. Connect to a data platform first.');
    }
    return this.activeAdapter.listSchemas(database);
  }

  /**
   * Execute a query on the connected platform.
   */
  async executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult> {
    if (!this.activeAdapter) {
      throw new Error('No active connection. Connect to a data platform first.');
    }
    return this.activeAdapter.executeQuery(sql, options);
  }

  /**
   * Get the capabilities of the connected platform.
   */
  getCapabilities(): PlatformCapabilities | null {
    return this.activeAdapter?.getCapabilities() ?? null;
  }

  /**
   * Platforms with both a `providerRegistry.ts` entry and a real registered adapter
   * factory here — i.e. actually connectable today, not just listed as a future
   * platform. Reads `providerRegistry.ts` (Phase 3a-i, previously unconsumed
   * anywhere) instead of hardcoding the factory-map's own keys a second time.
   */
  getSupportedPlatforms(): DataPlatformProvider[] {
    return getSupportedProviders().filter((p) => this.adapterFactories.has(p));
  }

  /**
   * Persists the snapshot's graph form to `<workspaceRoot>/.autode/local/schema-graph.json`
   * (atomic write). `io` defaults to Node's `fs`; the extension passes its
   * `vscode.workspace.fs`-backed `FileIo` so remote workspaces keep working.
   */
  async persistSchemaContext(snapshot: SchemaSnapshot, workspaceRoot: string, io: FileIo = nodeFileIo): Promise<void> {
    if (!this.activeAdapter) {
      throw new Error('No active connection.');
    }
    const graphData = this.activeAdapter.snapshotToGraph(snapshot, this.activeIdentity());
    const sep = workspaceRoot.includes('\\') && !workspaceRoot.includes('/') ? '\\' : '/';
    const target = [workspaceRoot.replace(/[\\/]+$/, ''), ...LAYOUT.schemaGraph].join(sep);
    await writeFileAtomic(io, target, JSON.stringify(graphData, null, 2));
    this.log(`Schema context persisted to ${layoutRel('schemaGraph')}`);
  }

  /**
   * Get credentials from VS Code settings for a given platform and role.
   * `role` defaults to `'source'` for backward compatibility with existing
   * callers — the pre-v0.19.0 `defaultSnowflake*`/`defaultDatabricks*` settings
   * keep meaning "source" exactly as they always have; a target connection
   * reads the parallel `defaultTargetSnowflake*`/`defaultTargetDatabricks*`
   * settings instead (see `DataAgentHubSettings`' doc comment).
   */
  static getCredentialsFromSettings(platform: DataPlatformProvider, settings: Record<string, unknown>, role: 'source' | 'target' = 'source'): Record<string, string> {
    const creds: Record<string, string> = {};
    const p = role === 'target' ? 'Target' : '';

    switch (platform) {
      case 'snowflake':
        creds['account'] = String(settings[`default${p}SnowflakeAccount`] ?? '');
        creds['username'] = String(settings[`default${p}SnowflakeUsername`] ?? '');
        creds['warehouse'] = String(settings[`default${p}SnowflakeWarehouse`] ?? '');
        creds['database'] = String(settings[`default${p}SnowflakeDatabase`] ?? '');
        creds['schema'] = String(settings[`default${p}SnowflakeSchema`] ?? 'PUBLIC');
        creds['role'] = String(settings[`default${p}SnowflakeRole`] ?? 'SYSADMIN');
        creds['authMode'] = String(settings[`default${p}SnowflakeAuthMode`] ?? 'key-pair');
        creds['keyPath'] = String(settings[role === 'target' ? 'targetSnowflakePrivateKeyPath' : 'snowflakePrivateKeyPath'] ?? '');
        creds['snowflakeCliPath'] = String(settings[role === 'target' ? 'targetSnowflakeCliPath' : 'snowflakeCliPath'] ?? '');
        break;
      case 'databricks':
        // `workspaceUrl`/`token`/`catalog`/`schema` were previously read from settings
        // keys that never existed (`settings['workspaceUrl']` etc.) — Databricks had no
        // real settings surface until Phase 3b. Fixed to the actual `defaultDatabricks*`
        // settings (`src/engine/types.ts`); `httpPath` is new — required by the Statement
        // Execution REST API (`warehouse_id` is derived from it) and not derivable from
        // `.databrickscfg`.
        creds['workspaceUrl'] = String(settings[`default${p}DatabricksWorkspaceUrl`] ?? '');
        creds['httpPath'] = String(settings[`default${p}DatabricksHttpPath`] ?? '');
        creds['catalog'] = String(settings[`default${p}DatabricksCatalog`] ?? 'main');
        creds['schema'] = String(settings[`default${p}DatabricksSchema`] ?? 'default');
        creds['catalogType'] = String(settings[`default${p}DatabricksCatalogType`] ?? 'auto');
        break;
      case 'oracle':
        // DRV1: Oracle is a source only; the password comes from SecretStorage or AUTODE_ORACLE_PASSWORD.
        if (role === 'source') {
          creds['connectString'] = String(settings['defaultOracleConnectString'] ?? '');
          creds['username'] = String(settings['defaultOracleUsername'] ?? '');
          creds['configDir'] = String(settings['oracleConfigDir'] ?? '');
          creds['walletLocation'] = String(settings['oracleWalletLocation'] ?? '');
        }
        break;
      default:
        break;
    }

    return creds;
  }
}