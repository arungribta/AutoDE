import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Same detection shape as `ClaudeCodeAdapter.resolve()` (explicit setting → PATH →
 * a bounded, specific set of well-known install directories → structured,
 * non-throwing result). There is no "bundled with a VS Code extension" equivalent
 * for a data-platform CLI, so the third tier checks concrete, documented install
 * locations rather than scanning the filesystem or every drive letter — a real
 * filesystem/drive scan would be slow, unpredictable, and needlessly invasive.
 * An install on a genuinely non-standard path (e.g. a non-default drive) is still
 * only reachable via the explicit `*CliPath` setting, by design.
 */
export interface CliDetectionResult {
  found: boolean;
  cliPath?: string;
  version?: string;
  source: 'setting' | 'path' | 'well-known-location' | 'none';
  error?: string;
}

/** Resolve a bare command name to an absolute path via `where` / `which`, mirroring `claudeCodeAdapter.ts`. */
function resolveOnPath(command: string): string | undefined {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const res = spawnSync(finder, [command], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (res.status === 0 && typeof res.stdout === 'string') {
      const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first && fs.existsSync(first)) {
        return first;
      }
    }
  } catch {
    /* not found */
  }
  return undefined;
}

/**
 * Accepts an explicitly-configured path that points at the binary itself, or — since
 * pasting a *folder* (e.g. copied from Explorer's address bar) is a completely
 * natural mistake — at the folder containing it, auto-completing to `<folder>/<binName>`.
 * `fs.existsSync()` alone can't tell a directory from a file, so without this a
 * folder path was silently accepted as if it were the executable, only to fail with
 * a confusing `ENOENT` the first time something actually tried to spawn it.
 */
function resolveExplicitPath(configured: string, binName: string): string | undefined {
  try {
    const stat = fs.statSync(configured);
    if (stat.isFile()) {
      return configured;
    }
    if (stat.isDirectory()) {
      const candidate = path.join(configured, binName);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  } catch {
    /* doesn't exist at all — fall through to PATH resolution */
  }
  return undefined;
}

function tryVersion(cliPath: string, versionArgs: string[]): string | undefined {
  try {
    const res = spawnSync(cliPath, versionArgs, { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (res.status === 0 && typeof res.stdout === 'string' && res.stdout.trim().length > 0) {
      return res.stdout.trim().split(/\r?\n/)[0];
    }
  } catch {
    /* not runnable */
  }
  return undefined;
}

/**
 * Detects a data-platform CLI binary: an explicit setting, then `PATH`, then a small
 * set of well-known install directories. Never throws — a `source: 'none'` result
 * always carries actionable `error` text, matching `ClaudeCodeAdapter.resolve()`'s
 * "detection is data, not exceptions" contract. The version-check shell-out here is
 * exempt from `dataPlatformCliConsent` (it never touches connection/profile data),
 * same as `ClaudeCodeAdapter`'s own `--version` probe.
 */
export function detectCliBinary(opts: {
  displayName: string;
  binaryNames: { win32: string; default: string };
  explicitPathSetting?: string;
  versionArgs?: string[];
  installHint: string;
  /**
   * Specific, documented install directories to check if PATH resolution fails
   * (e.g. the default folder a vendor's own Windows installer writes to). This is a
   * bounded lookup against a short candidate list, not a filesystem scan — it will
   * not find an install on a drive/location the vendor's installer doesn't itself
   * default to. Callers should only list locations they have real evidence for.
   */
  wellKnownDirs?: string[];
}): CliDetectionResult {
  const versionArgs = opts.versionArgs ?? ['--version'];
  const binName = process.platform === 'win32' ? opts.binaryNames.win32 : opts.binaryNames.default;

  const configured = (opts.explicitPathSetting ?? '').trim();
  if (configured) {
    const resolved = resolveExplicitPath(configured, binName);
    if (resolved) {
      return { found: true, cliPath: resolved, source: 'setting', version: tryVersion(resolved, versionArgs) };
    }
    const abs = resolveOnPath(configured);
    if (abs) {
      return { found: true, cliPath: abs, source: 'setting', version: tryVersion(abs, versionArgs) };
    }
    return { found: false, source: 'none', error: `The configured ${opts.displayName} CLI path "${configured}" was not found or is not runnable.` };
  }

  for (const cmd of [binName, opts.binaryNames.default]) {
    const abs = resolveOnPath(cmd);
    if (abs) {
      const version = tryVersion(abs, versionArgs);
      if (version) {
        return { found: true, cliPath: abs, source: 'path', version };
      }
    }
  }

  for (const dir of opts.wellKnownDirs ?? []) {
    const candidate = path.join(dir, binName);
    if (fs.existsSync(candidate)) {
      const version = tryVersion(candidate, versionArgs);
      if (version) {
        return { found: true, cliPath: candidate, source: 'well-known-location', version };
      }
    }
  }

  return {
    found: false,
    source: 'none',
    error: `${opts.displayName} CLI not found on PATH or in common install locations. ${opts.installHint}`
  };
}
