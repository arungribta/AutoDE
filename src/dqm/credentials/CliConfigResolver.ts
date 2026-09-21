import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PrincipalType } from '../../core/types';
import { CredentialReference, CredentialResolver } from './types';
import { readDatabricksCfgProfiles } from './databricksCfg';

/** Top-level `[name]` table headers in a `connections.toml` file, in file order. */
async function readConnectionNames(filePath: string): Promise<string[] | undefined> {
  let text: string;
  try {
    text = await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }

  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\[\s*([^.[\]]+)\s*\]\s*$/.exec(line.trim());
    if (match) {
      names.push(match[1].trim());
    }
  }
  return names;
}

/**
 * Resolves credentials via a vendor CLI's own configuration file — primarily an
 * interactive-user path (a developer who's already run `snow connection add`), but
 * nothing prevents a CI runner with the CLI pre-configured from using it too.
 *
 * For Snowflake this reuses `snowflake-sdk`'s native `connections.toml` support
 * (`createConnection()` honors `SNOWFLAKE_HOME`/`SNOWFLAKE_DEFAULT_CONNECTION_NAME`)
 * rather than re-implementing a TOML parser: this resolver only confirms the named
 * connection exists — by scanning for its `[name]` table header, never extracting
 * field values — and hands back a pointer (`connectionName`) for the SDK to load
 * itself at actual connect time. It never reads or returns the underlying secret.
 *
 * For Databricks (Phase 3a-ii), no vendor Node SDK with native `.databrickscfg`
 * loading is chosen yet (that's Phase 3b's "new dependency") — so, for consistency
 * with Snowflake's pointer-only contract, this also only confirms the named profile
 * exists in `.databrickscfg` and hands back a `{profile}` pointer, never the file's
 * `token`/`host` field values. `DatabricksAdapter`'s real credential resolution
 * (extracting those values, or reusing whatever the eventual driver dependency
 * supports natively) is deferred to Phase 3b, same as Snowflake's `connectionName`.
 */
export class CliConfigResolver implements CredentialResolver {
  readonly id = 'cli';
  readonly supportedPrincipalTypes: PrincipalType[] = ['interactive-user', 'service-account'];

  async resolve(reference: CredentialReference): Promise<Record<string, string> | undefined> {
    if (reference.platform === 'snowflake') {
      return this.resolveSnowflake(reference);
    }
    if (reference.platform === 'databricks') {
      return this.resolveDatabricks(reference);
    }
    return undefined;
  }

  private async resolveSnowflake(reference: CredentialReference): Promise<Record<string, string> | undefined> {
    const configDir = process.env.SNOWFLAKE_HOME || path.join(os.homedir(), '.snowflake');
    const configPath = path.join(configDir, 'connections.toml');
    const names = await readConnectionNames(configPath);
    if (!names) {
      return undefined;
    }

    const connectionName = reference.ref && reference.ref.trim().length > 0 ? reference.ref : 'default';
    if (!names.includes(connectionName)) {
      return undefined;
    }

    return { connectionName, authMode: 'connections-toml' };
  }

  private async resolveDatabricks(reference: CredentialReference): Promise<Record<string, string> | undefined> {
    const profiles = await readDatabricksCfgProfiles();
    if (!profiles) {
      return undefined;
    }

    const profileName = reference.ref && reference.ref.trim().length > 0 ? reference.ref : 'DEFAULT';
    if (!profiles.some((p) => p.name === profileName)) {
      return undefined;
    }

    return { profile: profileName, authMode: 'databrickscfg' };
  }
}
