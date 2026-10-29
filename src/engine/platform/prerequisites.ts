import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml } from '../context/Yaml';
import { layoutPath } from '../workspaceLayout';
import { DataPlatformProvider } from '../types';
import { getCliDescriptor } from './credentials/cliRegistry';
import { DRIVERS, DriverId, driverStatus, installCommand } from './driverStore';

/**
 * What each data platform needs on the engineer's machine, and how to get it
 * (docs/specs/mcp-engine.md §9.1 Phase DRV1). AutoDE moderates: it
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
  /** Package-manager options for this machine (v0.45.6), each probed: `available` when its manager answered. */
  options?: InstallOption[];
  /** When the guidance was last checked against the vendor, and how. */
  verifiedAt?: string;
  verifiedHow?: string;
}

export interface InstallOption { manager: string; commands: string[][]; needs?: string; available: boolean; reason: string }

/** One tool's install guidance, as `prerequisites.yaml` (and a team's override) describe it. */
export interface ToolGuide {
  id: string; platform: DataPlatformProvider; title: string; why: string; docs: string; minVersion?: string; verifiedAt?: string; verifiedHow?: string; manual?: string;
  options: Array<{ manager: string; os: string[]; probe: string[]; commands: string[][]; needs?: string }>;
}

/** The install guidance: AutoDE's `prerequisites.yaml`, with `.autode/config/prerequisites.yaml` merged over it by id. */
export function loadToolGuides(resourcesRoot?: string, workspaceRoot?: string): { guides: ToolGuide[]; errors: string[] } {
  const read = (f: string) => { try { return (parseYaml(fs.readFileSync(f, 'utf8')) as { tools?: Record<string, Partial<ToolGuide>> })?.tools ?? {}; } catch { return {}; } };
  const base = resourcesRoot ? read(path.join(resourcesRoot, 'prerequisites.yaml')) : {};
  const team = workspaceRoot ? read(path.join(layoutPath(workspaceRoot, 'config'), 'prerequisites.yaml')) : {};
  const errors: string[] = [];
  const guides: ToolGuide[] = [];
  for (const id of [...new Set([...Object.keys(base), ...Object.keys(team)])]) {
    const g = { ...(base[id] ?? {}), ...(team[id] ?? {}) } as Partial<ToolGuide>;
    if (!g.platform || !g.title || !g.docs) { errors.push(`prerequisites ${id}: platform, title and docs are required.`); continue; }
    const options = (Array.isArray(g.options) ? g.options : []).filter((o) => {
      const ok = o && typeof o.manager === 'string' && Array.isArray(o.commands) && o.commands.length > 0 && o.commands.every((c) => Array.isArray(c) && c.length > 0) && Array.isArray(o.probe) && o.probe.length > 0;
      if (!ok) errors.push(`prerequisites ${id}: an option needs manager, probe (an argument list) and commands (argument lists).`);
      return ok;
    }).map((o) => ({ manager: o.manager, os: Array.isArray(o.os) ? o.os.map(String) : ['win32', 'darwin', 'linux'], probe: o.probe.map(String), commands: o.commands.map((c) => c.map(String)), needs: o.needs }));
    guides.push({ id, platform: g.platform as DataPlatformProvider, title: g.title, why: g.why ?? '', docs: g.docs, minVersion: g.minVersion, verifiedAt: g.verifiedAt, verifiedHow: g.verifiedHow, manual: g.manual, options });
  }
  return { guides, errors };
}

export type ProbeRun = (argv: string[]) => { status: number | null; error?: Error };

/** The guide's options for this OS, each probed (the package manager answers `--version`); nothing is installed. */
export function probeOptions(g: ToolGuide, platform: NodeJS.Platform = process.platform, run: ProbeRun = (argv) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false })): InstallOption[] {
  return g.options.filter((o) => o.os.includes(platform)).map((o) => {
    let r: { status: number | null; error?: Error };
    try { r = run(o.probe); } catch (err) { r = { status: null, error: err as Error }; }
    const available = !r.error && r.status === 0;
    return { manager: o.manager, commands: o.commands, needs: o.needs, available, reason: available ? `${o.probe[0]} is installed` : `${o.probe[0]} isn't installed on this machine` };
  });
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
  /** Where `prerequisites.yaml` is (the extension's or the package's folder), and the workspace whose override applies. */
  resourcesRoot?: string;
  workspaceRoot?: string;
  /** Tests: the probe of the package managers. */
  probe?: ProbeRun;
  os?: NodeJS.Platform;
}

const DRIVER_PLATFORMS: Partial<Record<DataPlatformProvider, DriverId>> = { oracle: 'oracle' };

/** Fallback when no `prerequisites.yaml` is found (tests, an unusual layout): the vendors' pages only. */
const CLI_FALLBACK: Partial<Record<DataPlatformProvider, { title: string; why: string; docs: string }>> = {
  snowflake: { title: 'Snowflake CLI (snow)', why: 'Optional. Runs queries over Snowflake\'s native protocol.', docs: 'https://docs.snowflake.com/en/developer-guide/snowflake-cli/installation/installation' },
  databricks: { title: 'Databricks CLI', why: 'Optional. Lists the profiles in .databrickscfg and deploys bundles.', docs: 'https://docs.databricks.com/en/dev-tools/cli/install.html' }
};

/** Status of every prerequisite of the given platforms. */
export async function checkPrerequisites(options: PrerequisiteOptions): Promise<Prerequisite[]> {
  const platforms = options.platforms ?? ['snowflake', 'databricks', 'oracle'];
  const out: Prerequisite[] = [];
  let npm: NpmDetection | undefined = options.npm;
  const { guides } = loadToolGuides(options.resourcesRoot, options.workspaceRoot);
  for (const platform of platforms) {
    const guide = guides.find((g) => g.platform === platform);
    const cli = guide ?? CLI_FALLBACK[platform];
    const descriptor = getCliDescriptor(platform);
    if (cli && descriptor) {
      const found = await descriptor.detect(platform === 'snowflake' ? options.snowflakeCliPath : options.databricksCliPath);
      out.push({
        id: `${platform}-cli`, platform, kind: 'cli', title: cli.title, why: cli.why, required: false,
        state: found.found ? 'ready' : 'missing', version: found.version,
        detail: found.found ? `${found.cliPath} (${found.source})` : found.error ?? 'not found',
        install: found.found ? undefined : {
          docs: cli.docs, options: guide ? probeOptions(guide, options.os, options.probe) : undefined, verifiedAt: guide?.verifiedAt, verifiedHow: guide?.verifiedHow,
          notes: [...(guide?.manual ? [guide.manual] : []), 'After installing, set its path in AutoDE\'s settings if it isn\'t on PATH.']
        }
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
