import * as vscode from 'vscode';
import { TargetEnvironment, TargetConfigFile, TargetProfile } from '../core/types';
import { parseYaml, stringifyYaml } from './Yaml';

/**
 * Manages the .ai-context/target-environment.yaml file.
 * Provides CRUD operations for target environment profiles with inheritance support.
 */
export class TargetConfigManager implements vscode.Disposable {
  private config: TargetConfigFile = {
    profiles: [],
    activeProfile: 'development'
  };

  private fileWatcher?: vscode.FileSystemWatcher;
  private targetFileUri?: vscode.Uri;

  constructor(
    private readonly workspaceUri: vscode.Uri,
    private readonly log: (msg: string) => void
  ) {}

  dispose(): void {
    this.fileWatcher?.dispose();
  }

  async initialize(): Promise<void> {
    this.targetFileUri = vscode.Uri.joinPath(this.workspaceUri, '.ai-context', 'target-environment.yaml');

    // Ensure .ai-context directory exists
    const contextDir = vscode.Uri.joinPath(this.workspaceUri, '.ai-context');
    try {
      await vscode.workspace.fs.createDirectory(contextDir);
    } catch {
      // Directory may already exist
    }

    // Try to load existing config
    try {
      const content = await vscode.workspace.fs.readFile(this.targetFileUri);
      const yaml = Buffer.from(content).toString('utf8');
      this.config = this.parseYaml(yaml);
      this.log(`Loaded target environment config: ${this.config.profiles.length} profile(s), active: ${this.config.activeProfile}`);
    } catch {
      // File doesn't exist yet — create default
      this.config = this.createDefaultConfig();
      await this.save();
      this.log('Created default target environment config.');
    }

    // Watch for external changes
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(this.workspaceUri, '.ai-context'), 'target-environment.yaml')
    );
    this.fileWatcher.onDidChange(async () => {
      try {
        const content = await vscode.workspace.fs.readFile(this.targetFileUri!);
        const yaml = Buffer.from(content).toString('utf8');
        this.config = this.parseYaml(yaml);
        this.log('Target environment config reloaded from disk.');
      } catch (err) {
        this.log(`Failed to reload target config: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  getActiveProfile(): TargetProfile | undefined {
    return this.config.profiles.find((p) => p.name === this.config.activeProfile);
  }

  getActiveEnvironment(): TargetEnvironment | undefined {
    const profile = this.getActiveProfile();
    if (!profile) return undefined;

    // Apply inheritance
    if (profile.inherits) {
      const base = this.config.profiles.find((p) => p.name === profile.inherits);
      if (base) {
        return this.mergeEnvironments(base.environment, profile.environment);
      }
    }

    return profile.environment;
  }

  getAllProfiles(): TargetProfile[] {
    return [...this.config.profiles];
  }

  setActiveProfile(name: string): void {
    if (!this.config.profiles.some((p) => p.name === name)) {
      throw new Error(`Profile "${name}" does not exist.`);
    }
    this.config.activeProfile = name;
    this.save();
    this.log(`Active target profile set to: ${name}`);
  }

  async upsertProfile(profile: TargetProfile): Promise<void> {
    const idx = this.config.profiles.findIndex((p) => p.name === profile.name);
    if (idx >= 0) {
      this.config.profiles[idx] = profile;
    } else {
      this.config.profiles.push(profile);
    }
    await this.save();
    this.log(`Target profile "${profile.name}" saved.`);
  }

  async deleteProfile(name: string): Promise<void> {
    this.config.profiles = this.config.profiles.filter((p) => p.name !== name);
    if (this.config.activeProfile === name) {
      this.config.activeProfile = this.config.profiles[0]?.name ?? 'development';
    }
    await this.save();
    this.log(`Target profile "${name}" deleted.`);
  }

  private mergeEnvironments(base: TargetEnvironment, override: TargetEnvironment): TargetEnvironment {
    return {
      ...base,
      ...override,
      platformConfig: { ...base.platformConfig, ...override.platformConfig } as TargetEnvironment['platformConfig'],
      outputFormats: override.outputFormats.length > 0 ? override.outputFormats : base.outputFormats
    };
  }

  private createDefaultConfig(): TargetConfigFile {
    return {
      profiles: [
        {
          name: 'base',
          environment: {
            platform: 'snowflake',
            environmentProfile: 'development',
            modelingApproach: 'dimensional',
            namingConvention: 'snake_case',
            transformationTool: 'dbt',
            orchestrationTool: 'airflow',
            outputFormats: ['ddl', 'yaml', 'markdown'],
            platformConfig: {
              account: '',
              database: 'CURATED_DB',
              schema: 'ANALYTICS',
              warehouse: 'WH_XS',
              role: 'SYSADMIN'
            }
          }
        },
        {
          name: 'development',
          inherits: 'base',
          environment: {
            platform: 'snowflake',
            environmentProfile: 'development',
            modelingApproach: 'dimensional',
            namingConvention: 'snake_case',
            transformationTool: 'dbt',
            orchestrationTool: 'airflow',
            outputFormats: [],
            platformConfig: {
              account: '',
              database: 'DEV_DB',
              schema: 'DEV_ANALYTICS',
              warehouse: 'WH_XS',
              role: 'SYSADMIN'
            }
          }
        },
        {
          name: 'production',
          inherits: 'base',
          environment: {
            platform: 'snowflake',
            environmentProfile: 'production',
            modelingApproach: 'dimensional',
            namingConvention: 'snake_case',
            transformationTool: 'dbt',
            orchestrationTool: 'airflow',
            outputFormats: [],
            platformConfig: {
              account: '',
              database: 'PROD_DB',
              schema: 'ANALYTICS',
              warehouse: 'WH_L',
              role: 'SYSADMIN'
            }
          }
        }
      ],
      activeProfile: 'development'
    };
  }

  // ── YAML Parsing (real `yaml` library) ──

  private parseYaml(yaml: string): TargetConfigFile {
    const raw = parseYaml(yaml);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid target environment YAML: root must be an object.');
    }
    const doc = raw as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');

    const result: TargetConfigFile = {
      profiles: [],
      activeProfile: str(doc.activeProfile) || 'development'
    };

    const profilesRaw = doc.profiles;
    if (Array.isArray(profilesRaw)) {
      for (const entry of profilesRaw) {
        if (!entry || typeof entry !== 'object') continue;
        const p = entry as Record<string, unknown>;
        const envRaw = (p.environment && typeof p.environment === 'object' && !Array.isArray(p.environment))
          ? p.environment as Record<string, unknown>
          : {};
        const platformConfigRaw = (envRaw.platformConfig && typeof envRaw.platformConfig === 'object' && !Array.isArray(envRaw.platformConfig))
          ? envRaw.platformConfig as Record<string, string>
          : {} as Record<string, string>;
        const outputFormats = Array.isArray(envRaw.outputFormats)
          ? envRaw.outputFormats.filter((x) => typeof x === 'string')
          : [];

        const profile: TargetProfile = {
          name: str(p.name),
          environment: {
            platform: str(envRaw.platform) as TargetEnvironment['platform'],
            environmentProfile: str(envRaw.environmentProfile) as TargetEnvironment['environmentProfile'],
            modelingApproach: str(envRaw.modelingApproach) as TargetEnvironment['modelingApproach'],
            namingConvention: str(envRaw.namingConvention) as TargetEnvironment['namingConvention'],
            transformationTool: str(envRaw.transformationTool) as TargetEnvironment['transformationTool'],
            orchestrationTool: str(envRaw.orchestrationTool) as TargetEnvironment['orchestrationTool'],
            outputFormats: outputFormats as TargetEnvironment['outputFormats'],
            platformConfig: platformConfigRaw as unknown as TargetEnvironment['platformConfig']
          }
        };
        const inherits = str(p.inherits);
        if (inherits) profile.inherits = inherits;
        result.profiles.push(profile);
      }
    }

    return result;
  }

  // ── YAML Serialization ──

  private serializeYaml(): string {
    const lines = [
      '# AutoDE Target Environment Configuration',
      '# Edit this file to define your target data platform and toolchain.',
      '# Profiles support inheritance via the "inherits" field.'
    ];
    return lines.join('\n') + '\n' + stringifyYaml(this.config);
  }

  private async save(): Promise<void> {
    if (!this.targetFileUri) return;

    const yaml = this.serializeYaml();
    const tempFile = vscode.Uri.joinPath(
      vscode.Uri.joinPath(this.workspaceUri, '.ai-context'),
      `target-environment.tmp.${Date.now()}.yaml`
    );

    // Atomic write: temp → rename
    await vscode.workspace.fs.writeFile(tempFile, Buffer.from(yaml, 'utf8'));
    await vscode.workspace.fs.rename(tempFile, this.targetFileUri, { overwrite: true });
  }
}