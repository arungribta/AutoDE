import { DataPlatformProvider } from '../types';
import { SqlDialect } from './types';

/** Maps a target platform to the SQL dialect its DDL/DML should be rendered in. */
export function platformToDialect(platform: DataPlatformProvider): SqlDialect {
  switch (platform) {
    case 'snowflake':
      return 'snowflake';
    case 'databricks':
      return 'spark_sql';
    case 'bigquery':
      return 'google_sql';
    case 'redshift':
      return 'postgres';
    case 'synapse':
      return 'tsql';
    default:
      return 'ansi';
  }
}
