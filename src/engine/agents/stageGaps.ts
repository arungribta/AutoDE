import { ContextGap, GapClass, describeGap } from '../context/contextGaps';
import { ContextPackSources, buildContextPack } from '../context/contextPack';
import { parseBusinessProblemSpec, readProblemDocument } from '../documents/problemDocuments';
import { StageKind } from '../workflows/stageKinds';

/**
 * Context gaps in a stage's assignment (v0.45.9, SIMP-3: they were checked
 * per plan step, which paused on them). The stage's context pack is built
 * from its problem's specification; the joins, keys, grain and object
 * structure it can't back are listed in the assignment with how to close
 * each one. Nothing pauses: the agent asks, proposes the fact, or records
 * the gap as open in its deliverable, and the person approving the stage
 * sees it. Deterministic: no model.
 */

/** Stage kinds whose work rests on joins, keys and grain. */
const GAP_KINDS: readonly StageKind[] = ['mapping', 'modelling', 'build', 'quality-rules', 'conformance', 'validate'];

/** What agents must not infer (C3) and object structure not loaded yet (K2). */
const LISTED: readonly GapClass[] = ['relationship', 'key', 'grain', 'structure'];

export interface StageGap { needed: GapClass; subject: string[]; question: string }

/** What the stage's pack is centred on: the problem's statement, objectives and entities, and the stage's title. */
export function stageGapQuery(problemRoot: string, stageTitle: string): string | undefined {
  try {
    const text = readProblemDocument(problemRoot, 'spec');
    if (!text) return undefined;
    const spec = parseBusinessProblemSpec(text);
    return [spec.problemStatement, ...(spec.objectives ?? []), ...(spec.keyEntities ?? []), stageTitle].filter(Boolean).join('\n');
  } catch { return undefined; }
}

export function stageGapsFrom(gaps: readonly ContextGap[], kind: StageKind): StageGap[] {
  if (!GAP_KINDS.includes(kind)) return [];
  const seen = new Set<string>();
  return gaps.filter((g) => LISTED.includes(g.needed)).flatMap((g) => {
    const key = `${g.needed}:${[...g.subject].sort().join('|')}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ needed: g.needed, subject: g.subject, question: describeGap(g) }];
  });
}

/** The gaps for one stage, from the workspace's context. */
export function stageContextGaps(sources: ContextPackSources, input: { problemRoot: string; kind: StageKind; title: string }): StageGap[] {
  if (!GAP_KINDS.includes(input.kind)) return [];
  const query = stageGapQuery(input.problemRoot, input.title);
  if (!query) return [];
  return stageGapsFrom(buildContextPack({ purpose: 'step', query }, sources).manifest.gaps, input.kind);
}

export function renderStageGaps(gaps: readonly StageGap[]): string {
  if (!gaps.length) return '';
  return [
    '## Context gaps',
    'AutoDE\'s context doesn\'t back these yet. Don\'t infer joins, keys or grain: ask the person, propose the fact they give you (autode_propose_assertion) if your tools allow it, or record the gap as open in your deliverable so the person approving the stage sees it.',
    ...gaps.map((g) => `- ${g.question}`)
  ].join('\n');
}
