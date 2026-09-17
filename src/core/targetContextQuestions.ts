import { BusinessProblemSpec, ContextQuestion } from './types';
import { matchesAnyKeyword } from './phaseInference';

/**
 * Deterministic Target Context question set — a fixed, structured Q&A
 * (not an adaptive LLM conversation) walking the user through every decision
 * `TargetEnvironment` needs. Each question carries a keyword-evidence
 * `suggestedDefault` (same technique as `phaseInference`/`implementationType`)
 * so the form isn't blank, but nothing is silently assumed — the user
 * confirms or overrides every field.
 */

function corpusFor(spec: BusinessProblemSpec): string {
  return [
    spec.problemStatement || '',
    ...(spec.objectives || []),
    ...(spec.constraints || []),
    ...(spec.implementationConsiderations || []),
    ...(spec.transformations || [])
  ]
    .filter((part) => typeof part === 'string')
    .join('\n')
    .toLowerCase();
}

function firstMatch(corpus: string, candidates: Array<{ value: string; keywords: string[] }>, fallback: string): { value: string; matched: boolean } {
  for (const candidate of candidates) {
    if (matchesAnyKeyword(corpus, candidate.keywords)) return { value: candidate.value, matched: true };
  }
  return { value: fallback, matched: false };
}

export function buildTargetContextQuestions(spec: BusinessProblemSpec): ContextQuestion[] {
  const corpus = corpusFor(spec);

  const platform = firstMatch(corpus, [
    { value: 'databricks', keywords: ['databricks', 'delta lake', 'unity catalog'] },
    { value: 'bigquery', keywords: ['bigquery', 'big query'] },
    { value: 'redshift', keywords: ['redshift'] },
    { value: 'synapse', keywords: ['synapse'] },
    { value: 'snowflake', keywords: ['snowflake'] }
  ], 'snowflake');

  const modelingApproach = firstMatch(corpus, [
    { value: 'data-vault', keywords: ['data vault'] },
    { value: 'obt', keywords: ['one big table', 'obt'] },
    { value: '3nf', keywords: ['3nf', 'third normal form', 'normalized'] },
    { value: 'raw-pass-through', keywords: ['pass-through', 'pass through', 'no modeling', 'raw only'] },
    { value: 'dimensional', keywords: ['star schema', 'dimensional', 'kimball', 'fact table'] }
  ], 'dimensional');

  const transformationTool = firstMatch(corpus, [
    { value: 'sqlmesh', keywords: ['sqlmesh'] },
    { value: 'stored-procedures', keywords: ['stored procedure'] },
    { value: 'custom-sql', keywords: ['custom sql', 'hand-written sql'] },
    { value: 'dbt', keywords: ['dbt', 'data build tool'] }
  ], 'dbt');

  const orchestrationTool = firstMatch(corpus, [
    { value: 'dagster', keywords: ['dagster'] },
    { value: 'prefect', keywords: ['prefect'] },
    { value: 'dbt-cloud', keywords: ['dbt cloud'] },
    { value: 'manual', keywords: ['manual trigger', 'no orchestration', 'ad hoc run'] },
    { value: 'airflow', keywords: ['airflow'] }
  ], 'airflow');

  const namingConvention = firstMatch(corpus, [
    { value: 'camelCase', keywords: ['camelcase', 'camel case'] },
    { value: 'PascalCase', keywords: ['pascalcase', 'pascal case'] },
    { value: 'snake_case', keywords: ['snake_case', 'snake case'] }
  ], 'snake_case');

  const suggestionRationale = (label: string, match: { value: string; matched: boolean }): string =>
    match.matched
      ? `Suggested from the specification (mentions "${match.value}").`
      : `Not mentioned in the specification — defaulting to ${label}; confirm or change it.`;

  return [
    {
      id: 'platform', field: 'platform', kind: 'single-select',
      prompt: 'Which platform will the target data warehouse/lakehouse run on?',
      options: ['snowflake', 'databricks', 'bigquery', 'redshift', 'synapse', 'other'],
      suggestedDefault: platform.value,
      rationale: suggestionRationale('Snowflake', platform)
    },
    {
      id: 'modelingApproach', field: 'modelingApproach', kind: 'single-select',
      prompt: 'Which data modeling approach should the target use?',
      options: ['dimensional', 'data-vault', 'obt', '3nf', 'raw-pass-through'],
      suggestedDefault: modelingApproach.value,
      rationale: suggestionRationale('dimensional modeling', modelingApproach)
    },
    {
      id: 'transformationTool', field: 'transformationTool', kind: 'single-select',
      prompt: 'Which transformation tool will run the models?',
      options: ['dbt', 'sqlmesh', 'custom-sql', 'stored-procedures', 'none'],
      suggestedDefault: transformationTool.value,
      rationale: suggestionRationale('dbt', transformationTool)
    },
    {
      id: 'orchestrationTool', field: 'orchestrationTool', kind: 'single-select',
      prompt: 'Which orchestration tool will schedule the pipeline?',
      options: ['airflow', 'dagster', 'prefect', 'dbt-cloud', 'manual', 'none'],
      suggestedDefault: orchestrationTool.value,
      rationale: suggestionRationale('Airflow', orchestrationTool)
    },
    {
      id: 'namingConvention', field: 'namingConvention', kind: 'single-select',
      prompt: 'Which naming convention should generated objects follow?',
      options: ['snake_case', 'camelCase', 'PascalCase'],
      suggestedDefault: namingConvention.value,
      rationale: suggestionRationale('snake_case', namingConvention)
    },
    {
      id: 'environmentProfile', field: 'environmentProfile', kind: 'single-select',
      prompt: 'Which environment is this plan targeting first?',
      options: ['development', 'staging', 'production'],
      suggestedDefault: 'development'
    },
    {
      id: 'database', field: 'platformConfig.database', kind: 'text',
      prompt: 'Target database / catalog name?',
      suggestedDefault: 'CURATED_DB'
    },
    {
      id: 'schema', field: 'platformConfig.schema', kind: 'text',
      prompt: 'Target schema name?',
      suggestedDefault: 'ANALYTICS'
    }
  ];
}
