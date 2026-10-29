import { ContextFileManager } from '../context/contextFileManager';
import { ObservedBatch, RecordResult, recordObservedLineage } from './observed';

/** Observed edges for a connection (LIN), recorded under its estate identity: `autode lineage record` and `autode_record_observed_lineage`. */
export async function recordLineageBatch(cfm: ContextFileManager, batch: ObservedBatch, actor?: string): Promise<RecordResult & { system: string; environment: string }> {
  const { identity } = cfm.resolveConnection(batch.connectionId);
  const r = await recordObservedLineage(cfm.getLedger(), batch, identity, { actor });
  return { ...r, system: identity.system, environment: identity.environment };
}
