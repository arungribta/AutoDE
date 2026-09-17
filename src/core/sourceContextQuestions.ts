import { BusinessProblemSpec, ContextQuestion } from './types';
import { matchesAnyKeyword } from './phaseInference';

/**
 * Deterministic Source Context question set for the "describe" method
 * (data-push / no direct connectivity) — reuses the same fixed-Q&A pattern
 * as `targetContextQuestions.ts`. The "connect" method skips this entirely
 * and runs a live connection check instead.
 */
export function buildSourceContextQuestions(spec: BusinessProblemSpec): ContextQuestion[] {
  const corpus = [spec.problemStatement || '', ...(spec.objectives || [])].join('\n').toLowerCase();
  const cataloged = (spec.sourceCatalog || []).map((s) => `${s.name} (${s.type})`).join(', ');

  const suggestedType = matchesAnyKeyword(corpus, ['api', 'rest', 'webhook']) ? 'api'
    : matchesAnyKeyword(corpus, ['file', 'csv', 'flat file', 'sftp']) ? 'file'
      : matchesAnyKeyword(corpus, ['stream', 'kafka', 'kinesis', 'event']) ? 'stream'
        : matchesAnyKeyword(corpus, ['saas', 'salesforce', 'workday', 'netsuite']) ? 'saas'
          : 'database';

  return [
    {
      id: 'sourceType', field: 'sourceType', kind: 'single-select',
      prompt: 'What type of source system is this?',
      options: ['database', 'api', 'file', 'stream', 'saas', 'other'],
      suggestedDefault: suggestedType,
      rationale: cataloged ? `From the specification's source catalog: ${cataloged}.` : undefined
    },
    {
      id: 'description', field: 'description', kind: 'text',
      prompt: 'Describe the source system — what data it holds, key tables/entities, and any known structure or business meaning.',
      rationale: cataloged ? `Already named in the spec: ${cataloged}. Add whatever detail you have beyond that.` : undefined
    },
    {
      id: 'dataContract', field: 'dataContract', kind: 'text',
      prompt: 'If a data contract, schema definition, or interface spec already exists, paste or summarize it here (optional — leave blank if none).'
    }
  ];
}
