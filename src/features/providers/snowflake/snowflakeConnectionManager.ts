import * as fs from 'node:fs';
import * as path from 'node:path';
import { DataAgentHubSettings } from '../../../core/types';

export interface SnowflakeConnectionValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  connectionConfig: {
    account: string;
    username: string;
    warehouse: string;
    database: string;
    schema: string;
    role: string;
    authMode: string;
  };
}

export function validateSnowflakeSettings(settings: DataAgentHubSettings): SnowflakeConnectionValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const authMode = settings.defaultSnowflakeAuthMode || 'key-pair';

  const account = (settings.defaultSnowflakeAccount ?? '').trim();
  const username = (settings.defaultSnowflakeUsername ?? '').trim();
  const warehouse = (settings.defaultSnowflakeWarehouse ?? '').trim();
  const database = (settings.defaultSnowflakeDatabase ?? '').trim();
  const schema = (settings.defaultSnowflakeSchema ?? 'PUBLIC').trim();
  const role = (settings.defaultSnowflakeRole ?? 'SYSADMIN').trim();

  if (!account) errors.push('Snowflake account identifier is required.');
  if (!warehouse) errors.push('Snowflake warehouse is required.');
  if (!database) errors.push('Snowflake database is required.');
  if (!username) errors.push('Snowflake username is required.');

  if (authMode === 'key-pair') {
    const privateKeyPath = (settings.snowflakePrivateKeyPath ?? '').trim();
    if (!privateKeyPath) {
      errors.push('Private key file path is required when using key-pair authentication.');
    } else {
      const resolvedPath = path.resolve(privateKeyPath);
      if (!fs.existsSync(resolvedPath)) {
        errors.push(`Snowflake private key file does not exist: ${resolvedPath}`);
      }
    }
  }

  if (authMode === 'username-password') {
    warnings.push('Username + password auth is enabled; ensure the password is stored in SecretStorage.');
  }

  if (authMode === 'key-pair' && settings.readOnlyMode) {
    warnings.push('Key-pair auth is enabled with read-only mode; all queries will be restricted to read-only operations.');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    connectionConfig: {
      account,
      username,
      warehouse,
      database,
      schema,
      role,
      authMode
    }
  };
}

export function buildSnowflakeConnectionOptions(settings: DataAgentHubSettings, password?: string, privateKeyPassphrase?: string): Record<string, unknown> {
  const validation = validateSnowflakeSettings(settings);
  const base = {
    account: validation.connectionConfig.account,
    username: validation.connectionConfig.username,
    warehouse: validation.connectionConfig.warehouse,
    database: validation.connectionConfig.database,
    schema: validation.connectionConfig.schema,
    role: validation.connectionConfig.role,
    clientSessionKeepAlive: settings.enableSessionReuse,
    application: 'auto-data-engineering-hub'
  };

  if (validation.connectionConfig.authMode === 'key-pair') {
    const resolvedPath = (settings.snowflakePrivateKeyPath ?? '').trim();
    if (!resolvedPath) {
      throw new Error('A Snowflake private key path is required for key-pair authentication.');
    }

    return {
      ...base,
      privateKey: fs.readFileSync(path.resolve(resolvedPath)),
      privateKeyPass: privateKeyPassphrase && privateKeyPassphrase.trim().length > 0 ? privateKeyPassphrase : undefined
    };
  }

  if (password && password.trim().length > 0) {
    return { ...base, password };
  }

  return base;
}
