import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Oracle Net `tnsnames.ora` — read for alias names only (phase DRV1). The
 * driver resolves an alias itself (`oracledb` Thin mode reads the same file
 * through `configDir`), so AutoDE never re-implements Oracle's address
 * syntax; it lists aliases to pick from and says clearly when one is missing.
 *
 * The folder is found the way Oracle tools find it: an explicit `configDir`,
 * then `TNS_ADMIN`, then `$ORACLE_HOME/network/admin`.
 */

export interface TnsLocation {
  /** The folder searched, and how it was chosen. */
  dir: string;
  source: 'configDir' | 'TNS_ADMIN' | 'ORACLE_HOME';
}

export interface TnsNames {
  location?: TnsLocation;
  file?: string;
  /** Alias names in file order, as written (Oracle matches them case-insensitively). */
  aliases: string[];
  /** `IFILE` references: reported, not followed. */
  includes: string[];
  /** Why nothing was read, when nothing was. */
  problem?: string;
}

/** Candidate folders in Oracle's order (only those configured). */
export function tnsLocations(configDir: string | undefined, env: NodeJS.ProcessEnv = process.env): TnsLocation[] {
  const out: TnsLocation[] = [];
  if (configDir && configDir.trim()) out.push({ dir: configDir.trim(), source: 'configDir' });
  if (env.TNS_ADMIN && env.TNS_ADMIN.trim()) out.push({ dir: env.TNS_ADMIN.trim(), source: 'TNS_ADMIN' });
  if (env.ORACLE_HOME && env.ORACLE_HOME.trim()) out.push({ dir: path.join(env.ORACLE_HOME.trim(), 'network', 'admin'), source: 'ORACLE_HOME' });
  return out;
}

/**
 * Top-level alias names of a tnsnames.ora text. An entry is `alias[, alias…] = (DESCRIPTION …)`
 * at parenthesis depth 0; `#` starts a comment.
 */
export function parseTnsAliases(text: string): { aliases: string[]; includes: string[] } {
  const aliases: string[] = [];
  const includes: string[] = [];
  let depth = 0;
  let pending = '';
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '');
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (ch === '(') { depth++; continue; }
      if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
      if (depth > 0) continue;
      if (ch === '=') {
        const names = pending.split(',').map((x) => x.trim()).filter(Boolean);
        const value = line.slice(k + 1).trim();
        if (names.length === 1 && names[0].toUpperCase() === 'IFILE') includes.push(value.replace(/^["']|["']$/g, ''));
        else for (const n of names) if (/^[A-Za-z0-9_.\-$#]+$/.test(n)) aliases.push(n);
        pending = '';
        continue;
      }
      pending += ch;
    }
    if (depth === 0) pending += ' ';
  }
  return { aliases, includes };
}

/** Reads the first `tnsnames.ora` found in Oracle's order. */
export function readTnsNames(configDir: string | undefined, env: NodeJS.ProcessEnv = process.env): TnsNames {
  const locations = tnsLocations(configDir, env);
  if (locations.length === 0) return { aliases: [], includes: [], problem: 'No tnsnames.ora location is configured: set configDir (oracleConfigDir), TNS_ADMIN or ORACLE_HOME, or use an Easy Connect string (host:port/service).' };
  for (const location of locations) {
    const file = path.join(location.dir, 'tnsnames.ora');
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    return { location, file, ...parseTnsAliases(text) };
  }
  return { aliases: [], includes: [], problem: `No tnsnames.ora in ${locations.map((l) => `${l.dir} (${l.source})`).join(', ')}.` };
}

/** Easy Connect (`host[:port]/service`, `//host…`, `tcps://…`) rather than an alias. */
export function isEasyConnect(connectString: string): boolean {
  return /[/:@]/.test(String(connectString ?? ''));
}

/**
 * Checks a connect string before connecting: Easy Connect passes; an alias must be in tnsnames.ora.
 * Returns the folder to give the driver as `configDir`, or a problem to report.
 */
export function resolveConnectString(connectString: string, configDir: string | undefined, env: NodeJS.ProcessEnv = process.env): { configDir?: string; problem?: string; warning?: string } {
  if (!connectString || !connectString.trim()) return { problem: 'No Oracle connect string: give a tnsnames alias or an Easy Connect string (host:port/service).' };
  if (isEasyConnect(connectString)) return { configDir: configDir || undefined };
  const tns = readTnsNames(configDir, env);
  if (!tns.file) return { problem: `"${connectString}" looks like a tnsnames alias, but ${tns.problem}` };
  if (!tns.aliases.some((a) => a.toLowerCase() === connectString.trim().toLowerCase())) {
    // An included file may define it; AutoDE doesn't follow IFILE, so let the driver decide.
    if (tns.includes.length) return { configDir: tns.location!.dir, warning: `The alias "${connectString}" is not in ${tns.file} itself; it may come from an included file (${tns.includes.join(', ')}), which the driver resolves.` };
    return { problem: `The alias "${connectString}" is not in ${tns.file} (found: ${tns.aliases.slice(0, 20).join(', ') || 'none'}).` };
  }
  return { configDir: tns.location!.dir };
}
