import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { PlatformCliDescriptor } from './PlatformCliDescriptor';
import { CliDetectionResult, detectCliBinary } from './cliDetection';

interface SnowConnectionListEntry {
  connection_name?: string;
  name?: string;
}

/**
 * Directories the Snowflake CLI's own installers are documented/confirmed to write to.
 * Windows: `Program Files\Snowflake CLI\snow.exe` is Snowflake's default MSI install
 * location — confirmed live against a real install on this machine (note: that install
 * happened to be under a `D:\Program Files\...` root rather than `C:\`, so `%ProgramFiles%`
 * alone doesn't universally cover it; a non-default drive is a job for the explicit
 * `snowflakeCliPath` setting, not this bounded check). macOS/Linux: the documented
 * pip/homebrew user-local bin directories.
 */
function snowflakeWellKnownDirs(): string[] {
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']];
    return roots.filter((r): r is string => !!r).map((r) => path.join(r, 'Snowflake CLI'));
  }
  return ['/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local', 'bin')];
}

/**
 * The Snowflake CLI (`snow`). `listConnections()` shells out purely to populate a
 * picker; the *real* connection still goes through `snowflake-sdk`'s native
 * `connections.toml` loading (`CliConfigResolver`), never re-implemented here.
 * Gated behind `dataPlatformCliConsent` — unlike detection, this actually invokes
 * the external `snow` binary.
 */
export class SnowflakeCli implements PlatformCliDescriptor {
  readonly platform = 'snowflake' as const;
  readonly binaryNames = { win32: 'snow.exe', default: 'snow' };

  async detect(explicitPathSetting?: string): Promise<CliDetectionResult> {
    return detectCliBinary({
      displayName: 'Snowflake',
      binaryNames: this.binaryNames,
      explicitPathSetting,
      installHint: 'Install it from Snowflake\'s official CLI documentation, or set "autoDataEngineeringHub.snowflakeCliPath".',
      wellKnownDirs: snowflakeWellKnownDirs()
    });
  }

  async listConnections(cliPath: string): Promise<{ name: string }[]> {
    try {
      const res = spawnSync(cliPath, ['connection', 'list', '--format', 'json'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      if (res.status !== 0 || typeof res.stdout !== 'string') {
        return [];
      }
      const parsed = JSON.parse(res.stdout) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return (parsed as SnowConnectionListEntry[])
        .map((entry) => entry.connection_name ?? entry.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
        .map((name) => ({ name }));
    } catch {
      return [];
    }
  }
}
