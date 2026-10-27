import * as path from 'node:path';
import { Assertion } from './assertions';
import { AssertionLedger } from './ledger';
import { GraphView } from './retrieval';
import { createSubjectResolver } from './projection';
import { ProbeExecutor } from './probes';
import { readPackDocument, readPackFile, sampleProbeExecutor } from './packChecks';
import { CandidateFinding, findCandidates, recordCandidates } from './dataCandidates';
import { CoverageReport, captureCoverage, inScopeTables } from './coverage';
import { governanceFacts, sameTable } from '../governance/governance';
import { parseBusinessProblemSpec, readProblemDocument } from '../documents/problemDocuments';
import { problemMappings } from '../agents/modelDraft';
import { admitForMode, problemMode, problemSpecId } from '../documents/problemMode';

/**
 * Capture coverage for one business problem (C4c, §5.5): the checklist and
 * the data candidates over the problem's specification, mapping and pack,
 * shared by the panel, the `autode` CLI and MCP so the three agree.
 */

export interface CaptureScope {
  workspaceRoot: string;
  problemRoot: string;
  sources: { graph: GraphView; assertions: readonly Assertion[] };
}

/** The tables the problem's mapping reads, as graph ids (added to those its specification names). */
function mappedTables(scope: CaptureScope): string[] {
  const resolve = createSubjectResolver(scope.sources.graph as Parameters<typeof createSubjectResolver>[0]);
  try {
    return problemMappings(scope.problemRoot).map((m) => resolve(m.sourceFqn || m.sourceEntityId)).filter((x): x is string => !!x);
  } catch { return []; }
}

function spec(scope: CaptureScope) {
  const text = readProblemDocument(scope.problemRoot, 'spec');
  return text ? parseBusinessProblemSpec(text) : {};
}

export function problemTableIds(scope: CaptureScope): string[] {
  return inScopeTables(scope.sources.graph, spec(scope), mappedTables(scope));
}

/** The pack's samples as a probe executor (keyed by the table each is a sample of). */
export function packSampleExecutor(workspaceRoot: string, problemRoot: string, log?: (m: string) => void): ProbeExecutor | undefined {
  return sampleProbeExecutor(readPackFile(path.join(problemRoot, 'pack')), (d) => readPackDocument(workspaceRoot, d), log);
}

export function problemCoverage(scope: CaptureScope, options: { probesAvailable?: boolean; findings?: readonly CandidateFinding[] } = {}): CoverageReport {
  return captureCoverage({ graph: scope.sources.graph, assertions: scope.sources.assertions, spec: spec(scope), tableIds: mappedTables(scope), ...options });
}

/**
 * Finds the data candidates for the problem's tables and, with `record`,
 * records those that passed as proposed facts (admitted at once in an
 * exploration problem).
 */
export async function problemCandidates(scope: CaptureScope, executor: ProbeExecutor | undefined, options: { record?: AssertionLedger } = {}): Promise<{ findings: CandidateFinding[]; recorded: Assertion[] }> {
  const facts = governanceFacts(scope.sources.assertions);
  const findings = await findCandidates({
    graph: scope.sources.graph, tableIds: problemTableIds(scope), assertions: scope.sources.assertions, executor,
    classified: (table, column) => facts.some((f) => sameTable(f.table, table) && f.column === column.toLowerCase())
  });
  if (!options.record) return { findings, recorded: [] };
  const mode = problemMode(scope.problemRoot);
  const recorded = await recordCandidates(options.record, findings, { specId: problemSpecId(scope.problemRoot), admit: (a) => admitForMode(a, mode) });
  return { findings, recorded };
}
