import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** One `[profile]` section of a `.databrickscfg` INI file. */
export interface DatabricksCfgProfile {
  name: string;
  fields: Record<string, string>;
}

/** Resolves `.databrickscfg`'s path — `DATABRICKS_CONFIG_FILE` env var, else `~/.databrickscfg` (the CLI's own documented default). */
export function databricksConfigPath(): string {
  return process.env.DATABRICKS_CONFIG_FILE || path.join(os.homedir(), '.databrickscfg');
}

/**
 * A small, deliberately minimal INI parser for `.databrickscfg` — used instead of a
 * `databricks` CLI subcommand shell-out, whose exact structured-output flags aren't
 * verified against a real installed CLI. The file format itself is stable and
 * documented, and reading it directly needs no CLI binary to be installed at all.
 * Never throws: a missing/unreadable file resolves to `undefined`.
 */
export async function readDatabricksCfgProfiles(filePath: string = databricksConfigPath()): Promise<DatabricksCfgProfile[] | undefined> {
  let text: string;
  try {
    text = await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }

  const profiles: DatabricksCfgProfile[] = [];
  let current: DatabricksCfgProfile | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const section = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (section) {
      current = { name: section[1], fields: {} };
      profiles.push(current);
      continue;
    }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (kv && current) {
      current.fields[kv[1].trim()] = kv[2].trim();
    }
  }
  return profiles;
}
