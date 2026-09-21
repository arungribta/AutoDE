import { DataPlatformProvider } from '../../core/types';
import { PlatformCliDescriptor } from './PlatformCliDescriptor';
import { SnowflakeCli } from './SnowflakeCli';
import { DatabricksCli } from './DatabricksCli';

const CLI_DESCRIPTORS: Partial<Record<DataPlatformProvider, PlatformCliDescriptor>> = {
  snowflake: new SnowflakeCli(),
  databricks: new DatabricksCli()
};

/** The `PlatformCliDescriptor` for `platform`, or `undefined` if that platform has no CLI-reuse story yet. */
export function getCliDescriptor(platform: DataPlatformProvider): PlatformCliDescriptor | undefined {
  return CLI_DESCRIPTORS[platform];
}
