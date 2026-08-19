import * as vscode from 'vscode';
import { DataPlatformProvider } from '../core/types';
import { IDataSourceAdapter, ConnectionInfo, SchemaSnapshot, ExtractOptions, QueryOptions, QueryResult, PlatformCapabilities } from './types';
import { SnowflakeAdapter } from './adapters/SnowflakeAdapter';
import { DatabricksAdapter } from './adapters/DatabricksAdapter';

type AdapterFactory = (credentials: Record<string, string>, log: (msg: string) => void) => IDataSourceAdapter;

/**
 * Manages the lifecycle of data platform connections.
 * Owns the active adapter and provides a unified interface for sub-agents.
 */
export class ConnectionManager implements vscode.Disposable {
  private activeAdapter: IDataSourceAdapter | null = null;
  private adapterFactories: Map<DataPlatformProvider, AdapterFactory> = new Map();

  constructor(private readonly log: (msg: string) => void) {
    // Register adapter factories for supported platforms
    this.adapterFactories.set('snowflake', (creds, l) => new SnowflakeAdapter(creds, l));
    this.adapterFactories.set('databricks', (creds, l) => new DatabricksAdapter(creds, l));
    // Future: bigquery, redshift, synapse
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
    return null;
  }

  /**
   * Extract metadata from the connected platform.
   */
  async extractMetadata(options?: ExtractOptions): Promise<SchemaSnapshot> {
    if (!this.activeAdapter) {
      throw new Error('No active connection. Connect to a data platform first.');
    }
    return this.activeAdapter.extractMetadata(options);
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
   * Persist the schema context to .ai-context/.
   */
  async persistSchemaContext(snapshot: SchemaSnapshot, workspaceUri: vscode.Uri): Promise<void> {
    if (!this.activeAdapter) {
      throw new Error('No active connection.');
    }
    await this.activeAdapter.persistSchemaContext(snapshot, workspaceUri);
  }

  /**
   * Get credentials from VS Code settings for a given platform.
   */
  static getCredentialsFromSettings(platform: DataPlatformProvider, settings: Record<string, unknown>): Record<string, string> {
    const creds: Record<string, string> = {};

    switch (platform) {
      case 'snowflake':
        creds['account'] = String(settings['defaultSnowflakeAccount'] ?? '');
        creds['username'] = String(settings['defaultSnowflakeUsername'] ?? '');
        creds['warehouse'] = String(settings['defaultSnowflakeWarehouse'] ?? '');
        creds['database'] = String(settings['defaultSnowflakeDatabase'] ?? '');
        creds['schema'] = String(settings['defaultSnowflakeSchema'] ?? 'PUBLIC');
        creds['role'] = String(settings['defaultSnowflakeRole'] ?? 'SYSADMIN');
        creds['authMode'] = String(settings['defaultSnowflakeAuthMode'] ?? 'key-pair');
        creds['keyPath'] = String(settings['snowflakePrivateKeyPath'] ?? '');
        break;
      case 'databricks':
        creds['workspaceUrl'] = String(settings['workspaceUrl'] ?? '');
        creds['token'] = String(settings['token'] ?? '');
        creds['catalog'] = String(settings['catalog'] ?? 'main');
        creds['schema'] = String(settings['schema'] ?? 'default');
        break;
      default:
        break;
    }

    return creds;
  }
}