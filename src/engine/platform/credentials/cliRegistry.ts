import { DataPlatformProvider } from '../../types';
import { PlatformCliDescriptor } from './PlatformCliDescriptor';
import { SnowflakeCli } from './SnowflakeCli';
import { DatabricksCli } from './DatabricksCli';
import { DefinitionCli } from './DefinitionCli';
import { platformDefinition } from '../definitions';

const CLI_DESCRIPTORS: Partial<Record<DataPlatformProvider, PlatformCliDescriptor>> = {
  snowflake: new SnowflakeCli(),
  databricks: new DatabricksCli()
};

/** The `PlatformCliDescriptor` for `platform` (v0.55.0: built from its definition when it is defined by files), or `undefined`. */
export function getCliDescriptor(platform: DataPlatformProvider): PlatformCliDescriptor | undefined {
  const builtIn = CLI_DESCRIPTORS[platform];
  if (builtIn) return builtIn;
  const d = platformDefinition(platform);
  return d?.connection && d.access?.cli ? new DefinitionCli(d) : undefined;
}
