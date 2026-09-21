import { QueryOptions, QueryResult } from '../types';

/**
 * A concrete way of actually running a query once a connection has been
 * established — the piece each adapter's `connect()` selects between (Phase 3b's
 * execution-backend cascade: CLI shell-out / on-demand native driver / REST),
 * mirroring the `CredentialResolver` cascade from Phase 3a. Adapters depend only
 * on this interface, never on a specific backend's transport.
 */
export interface ExecutionBackend {
  executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult>;
  dispose(): void;
}
