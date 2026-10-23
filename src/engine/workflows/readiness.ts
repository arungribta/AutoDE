import { StageKind } from './stageKinds';
import { readProblemDocument, parseMappingContext } from '../documents/problemDocuments';
import { parseYaml } from '../context/Yaml';
import { layoutPath } from '../workspaceLayout';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Whether a stage has what its work needs, checked before an agent is given it
 * (v0.45.8, from the owner's UI test: the mapper ran on an estate with no
 * tables and could only write open questions). Deterministic and cheap: it
 * reads the compiled estate graph and the problem's documents, never a model.
 * Each problem says what to do about it.
 */

/** Tables in the compiled estate graph; undefined when it hasn't been compiled yet (then nothing is refused). */
export function estateTableCount(workspaceRoot: string): number | undefined {
  try {
    const g = JSON.parse(fs.readFileSync(layoutPath(workspaceRoot, 'graph'), 'utf8')) as { nodes?: Array<{ type?: string }> };
    return (g.nodes ?? []).filter((n) => n.type === 'table' || n.type === 'semantic_view').length;
  } catch { return undefined; }
}

export interface ReadinessInput { workspaceRoot: string; problemRoot: string; kind: StageKind }

export function stageReadiness(input: ReadinessInput): string[] {
  const problems: string[] = [];
  const mappings = (() => { try { const t = readProblemDocument(input.problemRoot, 'mappingContext'); return t ? parseMappingContext(t).mappings.length : 0; } catch { return 0; } })();
  const sourceContext = (() => { try { return parseYaml(fs.readFileSync(path.join(input.problemRoot, 'context', 'source-context.yaml'), 'utf8')) as { status?: string; sources?: unknown[] } | null; } catch { return null; } })();
  if (input.kind === 'mapping' || input.kind === 'quality-rules' || input.kind === 'conformance') {
    if (estateTableCount(input.workspaceRoot) === 0) {
      problems.push(`There are no tables in the estate yet, so there is nothing to ${input.kind === 'mapping' ? 'map' : 'check'}. Bring the sources in first: Run agent on Source assessment, Ingest File in the AutoDE panel, or \`autode estate ingest <file>\` / \`autode estate extract --connection <id>\` in a terminal.`);
      if (sourceContext?.status === 'not_applicable') problems.push('This problem\'s source context is marked not applicable: re-open the source-assessment stage if the problem does have sources.');
    }
  }
  if ((input.kind === 'modelling' || input.kind === 'build') && mappings === 0) {
    problems.push('The mapping document has no mappings yet: do the mapping stage first (the model and the pipelines are built from it).');
  }
  return problems;
}
