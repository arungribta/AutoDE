import { spawnSync } from 'node:child_process';
import { DataPlatformProvider } from '../../types';
import { PlatformDefinition } from '../operations/types';
import { PlatformCliDescriptor } from './PlatformCliDescriptor';
import { CliDetectionResult, detectCliBinary } from './cliDetection';

/**
 * The CLI of a platform defined by files (v0.55.0): found by its definition's
 * `access.cli` (the executable per OS, the vendor's install folders, the version
 * arguments), its profiles listed by `listProfiles` (the AWS CLI's
 * `configure list-profiles`). Listing profiles reads names only, no credentials.
 */
export class DefinitionCli implements PlatformCliDescriptor {
  readonly platform: DataPlatformProvider;
  readonly binaryNames: { win32: string; default: string };

  constructor(private readonly definition: PlatformDefinition) {
    this.platform = definition.id as DataPlatformProvider;
    const cli = definition.access?.cli;
    this.binaryNames = { win32: cli?.binary?.win32 ?? cli?.command ?? definition.id, default: cli?.binary?.default ?? cli?.command ?? definition.id };
  }

  async detect(explicitPathSetting?: string): Promise<CliDetectionResult> {
    const cli = this.definition.access?.cli;
    return detectCliBinary({
      displayName: this.definition.title,
      binaryNames: this.binaryNames,
      explicitPathSetting,
      versionArgs: cli?.versionArgs,
      installHint: cli?.install ?? '',
      wellKnownDirs: cli?.wellKnownDirs?.[process.platform === 'win32' ? 'win32' : 'default']
    });
  }

  async listConnections(cliPath: string): Promise<{ name: string }[]> {
    const args = this.definition.access?.cli?.listProfiles;
    if (!args?.length) return [];
    const r = spawnSync(cliPath, args, { encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, ...(this.definition.access?.cli?.env ?? {}) } });
    if (r.status !== 0 || typeof r.stdout !== 'string') return [];
    return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((name) => ({ name }));
  }
}
