import { BusinessProblemSpec, ImplementationType } from './types';
import { matchesAnyKeyword } from './phaseInference';

/**
 * Deterministic Greenfield/Brownfield classification from an approved (or
 * approved-in-progress) Business Problem Specification. Mirrors the keyword-
 * evidence approach `phaseInference.ts` already uses for phase applicability,
 * deliberately dependency-free (no `vscode` import) so it's unit-testable.
 *
 * Always paired with an explicit user override in the UI — this is a
 * best-guess default, not a final answer the user can't change.
 */

const BROWNFIELD_KEYWORDS = [
  'existing', 'legacy', 'migrate', 'migration', 'modernize', 'modernization', 'replace', 'replacing',
  'current system', 'current state', 'as-is', 'as is', 'already have', 'already exists', 'existing pipeline',
  'existing pipelines', 'existing warehouse', 'existing data warehouse', 'refactor', 'rework', 'upgrade',
  'decommission', 'rip and replace', 'cut over', 'cutover', 'coexist', 'in production', 'currently running',
  'existing database', 'existing system', 'existing systems', 'existing platform'
];

const GREENFIELD_KEYWORDS = [
  'greenfield', 'from scratch', 'net new', 'new system', 'new platform', 'brand new', 'ground up',
  'no existing', 'build a new', 'starting fresh', 'new implementation', 'net-new'
];

export interface ImplementationTypeResult {
  implementationType: ImplementationType;
  reason: string;
}

function evidenceCorpus(spec: BusinessProblemSpec): string {
  return [
    spec.problemStatement || '',
    ...(spec.objectives || []),
    ...(spec.scope?.in || []),
    ...(spec.constraints || []),
    ...(spec.assumptions || []),
    ...(spec.businessRequirements || []),
    ...(spec.implementationConsiderations || [])
  ]
    .filter((part) => typeof part === 'string')
    .join('\n')
    .toLowerCase();
}

function matchedKeywords(corpus: string, keywords: string[]): string[] {
  return keywords.filter((kw) => matchesAnyKeyword(corpus, [kw]));
}

/**
 * Classifies Greenfield vs. Brownfield from the specification's own text.
 * Rules:
 *  1. Existing-system language (brownfield evidence) with no new-build language → brownfield.
 *  2. New-build language (greenfield evidence) with no existing-system language → greenfield.
 *  3. Both present → brownfield (the higher-risk assumption: legacy integration
 *     concerns don't disappear just because new components are also being built).
 *  4. Neither present → greenfield (the more common default for an underspecified spec).
 */
export function classifyImplementationType(spec: BusinessProblemSpec): ImplementationTypeResult {
  const corpus = evidenceCorpus(spec);
  const brownfieldHits = matchedKeywords(corpus, BROWNFIELD_KEYWORDS);
  const greenfieldHits = matchedKeywords(corpus, GREENFIELD_KEYWORDS);

  if (brownfieldHits.length > 0 && greenfieldHits.length === 0) {
    return { implementationType: 'brownfield', reason: `Indicated by: ${brownfieldHits.slice(0, 4).join(', ')}` };
  }
  if (greenfieldHits.length > 0 && brownfieldHits.length === 0) {
    return { implementationType: 'greenfield', reason: `Indicated by: ${greenfieldHits.slice(0, 4).join(', ')}` };
  }
  if (brownfieldHits.length > 0 && greenfieldHits.length > 0) {
    return {
      implementationType: 'brownfield',
      reason: `Mixed evidence (existing-system language: ${brownfieldHits.slice(0, 2).join(', ')}; new-build language: ${greenfieldHits.slice(0, 2).join(', ')}) — defaulted to brownfield since legacy integration is the higher-risk assumption.`
    };
  }
  return { implementationType: 'greenfield', reason: 'No existing-system language detected in the specification — defaulted to greenfield.' };
}
