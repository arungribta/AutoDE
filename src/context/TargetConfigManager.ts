import * as vscode from 'vscode';
import { TargetEnvironment, TargetConfigFile, TargetProfile } from '../core/types';

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

  // ── Lightweight YAML Parser ──

  private parseYaml(yaml: string): TargetConfigFile {
    const result: TargetConfigFile = { profiles: [], activeProfile: 'development' };
    const lines = yaml.split('\n');
    let currentProfile: Partial<TargetProfile> | null = null;
    let currentEnv: Partial<TargetEnvironment> | null = null;
    let inPlatformConfig = false;
    let platformConfigObj: Record<string, string> = {};

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Top-level keys
      if (trimmed.startsWith('activeProfile:')) {
        result.activeProfile = trimmed.split(':')[1].trim();
        continue;
      }

      if (trimmed === 'profiles:') continue;

      // Profile entry
      const profileMatch = trimmed.match(/^-\s+name:\s*(.+)$/);
      if (profileMatch) {
        if (currentProfile && currentEnv) {
          currentProfile.environment = currentEnv as TargetEnvironment;
          result.profiles.push(currentProfile as TargetProfile);
        }
        currentProfile = { name: profileMatch[1].trim() };
        currentEnv = null;
        inPlatformConfig = false;
        platformConfigObj = {};
        continue;
      }

      if (!currentProfile) continue;

      if (trimmed.startsWith('inherits:')) {
        currentProfile.inherits = trimmed.split(':')[1].trim();
        continue;
      }

      if (trimmed === 'environment:') {
        currentEnv = {};
        inPlatformConfig = false;
        continue;
      }

      if (!currentEnv) continue;

      if (trimmed === 'platformConfig:') {
        inPlatformConfig = true;
        continue;
      }

      if (inPlatformConfig) {
        const kvMatch = trimmed.match(/^(\w+):\s*(.+)$/);
        if (kvMatch) {
          platformConfigObj[kvMatch[1]] = kvMatch[2].trim();
        }
        continue;
      }

      // Environment fields
      const envMatch = trimmed.match(/^(\w+):\s*(.+)$/);
      if (envMatch) {
        const key = envMatch[1];
        const value = envMatch[2].trim();

        switch (key) {
          case 'platform':
            (currentEnv as Record<string, unknown>)['platform'] = value;
            break;
          case 'environmentProfile':
            (currentEnv as Record<string, unknown>)['environmentProfile'] = value;
            break;
          case 'modelingApproach':
            (currentEnv as Record<string, unknown>)['modelingApproach'] = value;
            break;
          case 'namingConvention':
            (currentEnv as Record<string, unknown>)['namingConvention'] = value;
            break;
          case 'transformationTool':
            (currentEnv as Record<string, unknown>)['transformationTool'] = value;
            break;
          case 'orchestrationTool':
            (currentEnv as Record<string, unknown>)['orchestrationTool'] = value;
            break;
          case 'outputFormats':
            (currentEnv as Record<string, unknown>)['outputFormats'] = value
              .replace(/[\[\]]/g, '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            break;
        }
      }
    }

    // Save last profile
    if (currentProfile && currentEnv) {
      currentEnv.platformConfig = platformConfigObj as unknown as TargetEnvironment['platformConfig'];
      currentProfile.environment = currentEnv as TargetEnvironment;
      result.profiles.push(currentProfile as TargetProfile);
    }

    return result;
  }

  // ── YAML Serialization ──

  private serializeYaml(): string {
    const lines: string[] = [
      '# AutoDE Target Environment Configuration',
      '# Edit this file to define your target data platform and toolchain.',
      '# Profiles support inheritance via the "inherits" field.',
      '',
      `activeProfile: ${this.config.activeProfile}`,
      '',
      'profiles:'
    ];

    for (const profile of this.config.profiles) {
      lines.push(`  - name: ${profile.name}`);
      if (profile.inherits) {
        lines.push(`    inherits: ${profile.inherits}`);
      }
      lines.push('    environment:');
      const env = profile.environment;
      lines.push(`      platform: ${env.platform}`);
      lines.push(`      environmentProfile: ${env.environmentProfile}`);
      lines.push(`      modelingApproach: ${env.modelingApproach}`);
      lines.push(`      namingConvention: ${env.namingConvention}`);
      lines.push(`      transformationTool: ${env.transformationTool}`);
      lines.push(`      orchestrationTool: ${env.orchestrationTool}`);
      lines.push(`      outputFormats: [${env.outputFormats.join(', ')}]`);
      lines.push('      platformConfig:');
      const pc = env.platformConfig as unknown as Record<string, string>;
      for (const [key, value] of Object.entries(pc)) {
        lines.push(`        ${key}: ${value}`);
      }
    }

    return lines.join('\n') + '\n';
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