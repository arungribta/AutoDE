import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Drivers the user installs with AutoDE's guidance (docs/mcp-engine-requirements.md
 * §9.1 Phase DRV1). AutoDE never downloads, bundles or hosts a driver. It knows
 * which package a platform needs, which versions it supports and how to check
 * an installation, and it hands the user the exact `npm` command. The command
 * runs only when the user asks, with the user's own npm, registry and `.npmrc`.
 *
 * A driver is loaded only after `verifyDriver()` has recorded what it checked
 * (`.autode-driver.json`: package, version, SHA-256 of `package-lock.json`),
 * and only while that record still matches: a folder changed afterwards is
 * `changed` and must be verified again. Trust belongs to content, as for S2 skills.
 */

export type DriverId = 'oracle';

export interface DriverSpec {
  id: DriverId;
  /** The npm package. */
  package: string;
  /** Supported versions, as an npm range: fixed here and reviewed like code. */
  range: string;
  /** Supported major version (what `verifyDriver` checks). */
  major: number;
  title: string;
  why: string;
  size: string;
  licence: string;
  notes: string[];
  /** Further checks on the loaded module; returns a problem, or undefined. */
  check(mod: unknown): string | undefined;
}

export const DRIVERS: Readonly<Record<DriverId, DriverSpec>> = {
  oracle: {
    id: 'oracle',
    package: 'oracledb',
    range: '^6.0.0',
    major: 6,
    title: 'Oracle driver (node-oracledb, Thin mode)',
    why: 'Connects AutoDE to Oracle Database 12.1 and later in pure JavaScript: no Oracle Instant Client and no native code is loaded.',
    size: 'roughly 10–20 MB on disk, depending on the version (the package also contains Thick-mode libraries, which AutoDE never loads)',
    licence: 'Apache-2.0 OR UPL-1.0',
    notes: [
      'Thin mode supports Oracle Database 12.1 and later. Older databases (11g) need Thick mode and Oracle Instant Client, which AutoDE does not support yet.',
      'Installed with your own npm and registry settings (.npmrc), so an internal registry such as Artifactory or Nexus is used if you have one configured.',
      'Install scripts are disabled (--ignore-scripts): Thin mode needs none.'
    ],
    check: (mod) => {
      const m = mod as { getConnection?: unknown; thin?: unknown };
      if (typeof m?.getConnection !== 'function') return 'the package loaded but has no getConnection(): not node-oracledb?';
      if (m.thin === false) return 'the driver is in Thick mode; AutoDE uses Thin mode only';
      return undefined;
    }
  }
};

export const RECORD_FILE = '.autode-driver.json';

/** Where drivers live: the `driversDirectory` setting, else `AUTODE_DRIVERS_DIR`, else `~/.autode/drivers` (one place the extension and any MCP server agree on). */
export function driversRoot(configured?: string, env: NodeJS.ProcessEnv = process.env): string {
  const given = String(configured ?? '').trim() || String(env.AUTODE_DRIVERS_DIR ?? '').trim();
  if (given) return path.resolve(given.replace(/^~(?=[\\/]|$)/, os.homedir()));
  return path.join(os.homedir(), '.autode', 'drivers');
}

export function driverDir(root: string, id: DriverId): string {
  return path.join(root, id);
}

/**
 * The install command — `npm install --prefix "<folder>" --ignore-scripts --no-audit --no-fund "<pkg>@<range>"`.
 * Paths and the range are double-quoted, which PowerShell, cmd and POSIX shells all accept
 * (cmd would otherwise eat the `^`).
 */
export function installCommand(root: string, id: DriverId): { command: string; cwd: string } {
  const spec = DRIVERS[id];
  const dir = driverDir(root, id);
  if (/["\r\n]/.test(dir)) throw new Error(`The drivers folder "${dir}" contains a character that can't be quoted safely; choose another folder (setting driversDirectory).`);
  return { command: `npm install --prefix "${dir}" --ignore-scripts --no-audit --no-fund "${spec.package}@${spec.range}"`, cwd: dir };
}

export type DriverState = 'ready' | 'missing' | 'unverified' | 'changed' | 'unsupported';

export interface DriverStatus {
  id: DriverId;
  state: DriverState;
  dir: string;
  version?: string;
  detail: string;
}

interface DriverRecord {
  package: string;
  version: string;
  lockfileSha256: string;
  verifiedAt: string;
}

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return undefined; }
}

function lockHash(dir: string): string | undefined {
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'package-lock.json'))).digest('hex'); } catch { return undefined; }
}

function installedVersion(dir: string, pkg: string): string | undefined {
  return readJson<{ version?: string }>(path.join(dir, 'node_modules', pkg, 'package.json'))?.version;
}

const majorOf = (v: string | undefined) => Number(String(v ?? '').split('.')[0]);

/** What is installed and whether it may be loaded. Reads files only: no process, no network. */
export function driverStatus(root: string, id: DriverId): DriverStatus {
  const spec = DRIVERS[id];
  const dir = driverDir(root, id);
  const version = installedVersion(dir, spec.package);
  if (!version) return { id, state: 'missing', dir, detail: `${spec.package} is not installed in ${dir}.` };
  if (majorOf(version) !== spec.major) return { id, state: 'unsupported', dir, version, detail: `${spec.package} ${version} is installed; AutoDE supports ${spec.range}. Reinstall with the AutoDE install command.` };
  const record = readJson<DriverRecord>(path.join(dir, RECORD_FILE));
  if (!record) return { id, state: 'unverified', dir, version, detail: `${spec.package} ${version} is installed but not verified yet.` };
  const hash = lockHash(dir);
  if (!hash || record.lockfileSha256 !== hash || record.version !== version || record.package !== spec.package) {
    return { id, state: 'changed', dir, version, detail: `${dir} changed after it was verified (${record.package} ${record.version}, ${record.verifiedAt}); verify it again before AutoDE loads it.` };
  }
  return { id, state: 'ready', dir, version, detail: `${spec.package} ${version}, verified ${record.verifiedAt}.` };
}

function requireFrom(dir: string, pkg: string): unknown {
  return createRequire(path.join(dir, 'package.json'))(pkg);
}

/** Loads the installed package, checks it, and records what was checked. Never installs anything. */
export function verifyDriver(root: string, id: DriverId, now: Date = new Date()): DriverStatus {
  const spec = DRIVERS[id];
  const status = driverStatus(root, id);
  if (status.state === 'missing' || status.state === 'unsupported') return status;
  const hash = lockHash(status.dir);
  if (!hash) return { ...status, state: 'unverified', detail: `${status.dir} has no package-lock.json. Install with the AutoDE command, which creates one, so later changes can be detected.` };
  let mod: unknown;
  try { mod = requireFrom(status.dir, spec.package); } catch (err) {
    return { ...status, state: 'unverified', detail: `${spec.package} ${status.version} could not be loaded: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` };
  }
  const problem = spec.check(mod);
  if (problem) return { ...status, state: 'unverified', detail: `${spec.package} ${status.version}: ${problem}.` };
  const record: DriverRecord = { package: spec.package, version: status.version!, lockfileSha256: hash, verifiedAt: now.toISOString() };
  fs.writeFileSync(path.join(status.dir, RECORD_FILE), JSON.stringify(record, null, 2) + '\n');
  return driverStatus(root, id);
}

export class DriverNotReadyError extends Error {
  public constructor(public readonly status: DriverStatus) {
    super(`${DRIVERS[status.id].title} is not ready: ${status.detail} ${status.state === 'missing' || status.state === 'unsupported' ? 'Run "AutoDE: Install Oracle Driver" (or the command shown by "AutoDE: Check Platform Prerequisites").' : 'Run "AutoDE: Verify Oracle Driver".'}`);
    this.name = 'DriverNotReadyError';
  }
}

const loaded = new Map<string, unknown>();

/** The driver module, if verified and unchanged; cached per folder and version. */
export function loadDriver<T>(root: string, id: DriverId): T {
  const status = driverStatus(root, id);
  if (status.state !== 'ready') throw new DriverNotReadyError(status);
  const key = `${status.dir}@${status.version}`;
  if (!loaded.has(key)) loaded.set(key, requireFrom(status.dir, DRIVERS[id].package));
  return loaded.get(key) as T;
}
