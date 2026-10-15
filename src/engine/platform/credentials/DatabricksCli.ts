import * as os from 'node:os';
import * as path from 'node:path';
import { PlatformCliDescriptor } from './PlatformCliDescriptor';
import { CliDetectionResult, detectCliBinary } from './cliDetection';
import { readDatabricksCfgProfiles } from './databricksCfg';

/**
 * Databricks' official install script (`curl ... | sh`) documents `/usr/local/bin` as
 * its default target on macOS/Linux. No Windows default location has been independently
 * confirmed here (unlike Snowflake's), so Windows relies on PATH + the explicit
 * `databricksCliPath` setting only — guessing an unconfirmed path would be worse than
 * no guess at all.
 */
function databricksWellKnownDirs(): string[] {
  if (process.platform === 'win32') {
    return [];
  }
  return ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'bin')];
}

/**
 * The Databricks CLI (`databricks`). Its structured-output subcommand surface for
 * listing profiles isn't verified against a real installed CLI (a known gap flagged
 * in the Phase 3a design) — `listConnections()` deliberately sidesteps that
 * uncertainty by reading `.databrickscfg` directly instead of shelling out at all.
 * The file format is stable/documented and needs no CLI binary installed to read.
 * `detect()` (CLI presence/version) is still useful independently, e.g. for guided
 * install messaging, even though it isn't in `listConnections()`'s path.
 */
export class DatabricksCli implements PlatformCliDescriptor {
  readonly platform = 'databricks' as const;
  readonly binaryNames = { win32: 'databricks.exe', default: 'databricks' };

  async detect(explicitPathSetting?: string): Promise<CliDetectionResult> {
    return detectCliBinary({
      displayName: 'Databricks',
      binaryNames: this.binaryNames,
      explicitPathSetting,
      installHint: 'Install it from Databricks\' official CLI documentation, or set "autoDataEngineeringHub.databricksCliPath".',
      wellKnownDirs: databricksWellKnownDirs()
    });
  }

  async listConnections(): Promise<{ name: string }[]> {
    const profiles = await readDatabricksCfgProfiles();
    if (!profiles) {
      return [];
    }
    return profiles.map((p) => ({ name: p.name }));
  }
}
