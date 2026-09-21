import { DataPlatformProvider } from '../../core/types';
import { CliDetectionResult } from './cliDetection';

/**
 * A platform's own CLI, reused for interactive onboarding (Phase 3a-ii): detection
 * mirrors `ClaudeCodeAdapter.resolve()`'s shape, and `listConnections()` enumerates
 * configured connections/profiles for a picker — never establishing a real connection.
 */
export interface PlatformCliDescriptor {
  readonly platform: DataPlatformProvider;
  readonly binaryNames: { win32: string; default: string };
  detect(explicitPathSetting?: string): Promise<CliDetectionResult>;
  listConnections(cliPath: string): Promise<{ name: string }[]>;
}

export type { CliDetectionResult } from './cliDetection';
