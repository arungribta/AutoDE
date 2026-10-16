import { spawnSync } from 'node:child_process';
import { DataPlatformProvider } from '../types';
import { getCliDescriptor } from './credentials/cliRegistry';
import { DRIVERS, DriverId, driverStatus, installCommand } from './driverStore';

/**
 * What each data platform needs on the engineer's machine, and how to get it
 * (docs/mcp-engine-requirements.md §9.1 Phase DRV1). AutoDE moderates: it
 * detects, explains, gives the exact install step and verifies; the install
 * itself runs only when the user asks. Phase DRV2's onboarding UI renders
 * this model.
 *
 * `checkPrerequisites()` runs version checks (`snow --version`, `npm --version`).
 * Call it from a user action, never at activation.
 */

export type PrerequisiteKind = 'cli' | 'driver' | 'client-library';
export type PrerequisiteState = 'ready' | 'missing' | 'unverified' | 'changed' | 'unsupported';

export interface InstallStep {
  /** A command AutoDE can run in a visible terminal on request; absent when the step is manual. */
  command?: string;
  cwd?: string;
  /** What the step needs first (e.g. npm). */
  needs?: string;
  /** Set when that need isn't met, with what to do instead. */
  blocked?: string;
  size?: string;
  licence?: string;
  docs?: string;
  notes: string[];
}

export interface Prerequisite {
  id: string;
  platform: DataPlatformProvider;
  kind: PrerequisiteKind;
  title: string;
  why: string;
  /** Without it the platform can't be used at all (a driver), as opposed to an optional accelerator (a CLI, P7). */
  required: boolean;
  state: PrerequisiteState;
  version?: string;
  detail: string;
  install?: InstallStep;
}

export interface NpmDetection {
  found: boolean;
  version?: string;
  detail: string;
}

/** `npm --version` through the shell (npm is `npm.cmd` on Windows, which Node won't spawn directly). Fixed arguments only. */
export function detectNpm(run: (cmd: string, args: string[]) => { status: number | null; stdout?: string } = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: true })): NpmDetection {
  try {
    const r = run('npm', ['--version']);
    const version = String(r.stdout ?? '').trim().split(/\r?\n/)[0];
    if (r.status === 0 && /^\d+\.\d+/.test(version)) return { found: true, version, detail: `npm ${version}` };
  } catch { /* not runnable */ }
  return { found: false, detail: 'npm was not found on PATH. Install Node.js (https://nodejs.org, which includes npm), or install the package yourself into the drivers folder and point the setting autoDataEngineeringHub.driversDirectory at it.' };
}

export interface PrerequisiteOptions {
  driversRoot: string;
  snowflakeCliPath?: string;
  databricksCliPath?: string;
  /** Default: every platform AutoDE knows prerequisites for. */
  platforms?: DataPlatformProvider[];
  /** Tests. */
  npm?: NpmDetection;
}

const DRIVER_PLATFORMS: Partial<Record<DataPlatformProvider, DriverId>> = { oracle: 'oracle' };

const CLI_INFO: Partial<Record<DataPlatformProvider, { title: string; why: string; docs: string }>> = {
  snowflake: {
    title: 'Snowflake CLI (snow)',
    why: 'Optional. Runs queries over Snowflake\'s native protocol, which works where the SQL API is restricted, and is the only way to sign in with a username and password. Without it AutoDE uses the SQL API (key-pair or token).',
    docs: 'https://docs.snowflake.com/en/developer-guide/snowflake-cli/installation/installation'
  },
  databricks: {
    title: 'Databricks CLI',
    why: 'Optional. Used to list the profiles in .databrickscfg. Queries always use the Statement Execution API, so the CLI adds no connection path.',
    docs: 'https://docs.databricks.com/en/dev-tools/cli/install.html'
  }
};

/** Status of every prerequisite of the given platforms. */
export async function checkPrerequisites(options: PrerequisiteOptions): Promise<Prerequisite[]> {
  const platforms = options.platforms ?? ['snowflake', 'databricks', 'oracle'];
  const out: Prerequisite[] = [];
  let npm: NpmDetection | undefined = options.npm;
  for (const platform of platforms) {
    const cli = CLI_INFO[platform];
    const descriptor = getCliDescriptor(platform);
    if (cli && descriptor) {
      const found = await descriptor.detect(platform === 'snowflake' ? options.snowflakeCliPath : options.databricksCliPath);
      out.push({
        id: `${platform}-cli`, platform, kind: 'cli', title: cli.title, why: cli.why, required: false,
        state: found.found ? 'ready' : 'missing', version: found.version,
        detail: found.found ? `${found.cliPath} (${found.source})` : found.error ?? 'not found',
        install: found.found ? undefined : { docs: cli.docs, notes: ['Install it with the vendor\'s installer, then set its path in AutoDE\'s settings if it isn\'t on PATH.'] }
      });
    }
    const driverId = DRIVER_PLATFORMS[platform];
    if (driverId) {
      const spec = DRIVERS[driverId];
      const status = driverStatus(options.driversRoot, driverId);
      let install: InstallStep | undefined;
      if (status.state === 'missing' || status.state === 'unsupported') {
        npm = npm ?? detectNpm();
        const cmd = installCommand(options.driversRoot, driverId);
        install = { ...cmd, needs: 'npm', blocked: npm.found ? undefined : npm.detail, size: spec.size, licence: spec.licence, notes: spec.notes };
      }
      out.push({ id: `${platform}-driver`, platform, kind: 'driver', title: spec.title, why: spec.why, required: true, state: status.state, version: status.version, detail: status.detail, install });
    }
  }
  return out;
}
