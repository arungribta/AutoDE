import { BusinessProblemSpec, ContextQuestion } from '../engine/types';
import { TARGET_OPTIONS, TargetChoice, TargetConnectionChoice, TargetDefaults } from '../engine/context/problemContexts';
import { matchesAnyKeyword } from './keywords';

/**
 * Deterministic Target Context question set — a fixed, structured Q&A
 * (not an adaptive LLM conversation). Since v0.45.10 (SIMP-4) it picks one
 * of the workspace's named target connections (which decides the platform
 * and the default database) and asks only the problem's own decisions.
 * Each question carries a `suggestedDefault`: the specification's own words
 * first, then the team's facts and the last approved target context
 * (`targetDefaults()`), then a built-in default — never silently assumed,
 * the user confirms or overrides every field.
 */

/** The answer that means "no connection yet": the platform question applies instead. */
export const NO_CONNECTION = 'none yet';

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

function firstMatch(corpus: string, candidates: Array<{ value: string; keywords: string[] }>): string | undefined {
  for (const candidate of candidates) {
    if (matchesAnyKeyword(corpus, candidate.keywords)) return candidate.value;
  }
  return undefined;
}

const EVIDENCE: Record<TargetChoice, Array<{ value: string; keywords: string[] }>> = {
  platform: [
    { value: 'databricks', keywords: ['databricks', 'delta lake', 'unity catalog'] },
    { value: 'bigquery', keywords: ['bigquery', 'big query'] },
    { value: 'redshift', keywords: ['redshift'] },
    { value: 'synapse', keywords: ['synapse'] },
    { value: 'snowflake', keywords: ['snowflake'] }
  ],
  modelingApproach: [
    { value: 'data-vault', keywords: ['data vault'] },
    { value: 'obt', keywords: ['one big table', 'obt'] },
    { value: '3nf', keywords: ['3nf', 'third normal form', 'normalized'] },
    { value: 'raw-pass-through', keywords: ['pass-through', 'pass through', 'no modeling', 'raw only'] },
    { value: 'dimensional', keywords: ['star schema', 'dimensional', 'kimball', 'fact table'] }
  ],
  transformationTool: [
    { value: 'sqlmesh', keywords: ['sqlmesh'] },
    { value: 'stored-procedures', keywords: ['stored procedure'] },
    { value: 'custom-sql', keywords: ['custom sql', 'hand-written sql'] },
    { value: 'dbt', keywords: ['dbt', 'data build tool'] }
  ],
  orchestrationTool: [
    { value: 'dagster', keywords: ['dagster'] },
    { value: 'prefect', keywords: ['prefect'] },
    { value: 'dbt-cloud', keywords: ['dbt cloud'] },
    { value: 'manual', keywords: ['manual trigger', 'no orchestration', 'ad hoc run'] },
    { value: 'airflow', keywords: ['airflow'] }
  ],
  namingConvention: [
    { value: 'camelCase', keywords: ['camelcase', 'camel case'] },
    { value: 'PascalCase', keywords: ['pascalcase', 'pascal case'] },
    { value: 'snake_case', keywords: ['snake_case', 'snake case'] }
  ]
};

const FALLBACK: Record<TargetChoice, string> = { platform: 'snowflake', modelingApproach: 'dimensional', transformationTool: 'dbt', orchestrationTool: 'airflow', namingConvention: 'snake_case' };

export interface TargetQuestionOptions {
  connections?: readonly TargetConnectionChoice[];
  defaults?: TargetDefaults;
}

export function buildTargetContextQuestions(spec: BusinessProblemSpec, opts: TargetQuestionOptions = {}): ContextQuestion[] {
  const corpus = corpusFor(spec);
  const connections = opts.connections ?? [];
  const suggest = (k: TargetChoice): { value: string; rationale: string } => {
    const fromSpec = firstMatch(corpus, EVIDENCE[k]);
    if (fromSpec) return { value: fromSpec, rationale: `Suggested from the specification (mentions "${fromSpec}").` };
    const team = opts.defaults?.values[k];
    if (team) return { value: team, rationale: `Suggested from ${opts.defaults!.from[k]}.` };
    return { value: FALLBACK[k], rationale: `Not mentioned in the specification or the team's facts — defaulting to ${FALLBACK[k]}; confirm or change it.` };
  };
  const select = (k: TargetChoice, prompt: string): ContextQuestion => {
    const s = suggest(k);
    return { id: k, field: k, kind: 'single-select', prompt, options: [...TARGET_OPTIONS[k]], suggestedDefault: s.value, rationale: s.rationale };
  };
  const questions: ContextQuestion[] = [];
  if (connections.length) {
    // The spec naming a platform picks that platform's connection first.
    const platform = firstMatch(corpus, EVIDENCE.platform);
    const preferred = connections.find((c) => c.platform === platform) ?? connections[0];
    questions.push({
      id: 'connectionId', field: 'connectionId', kind: 'single-select',
      prompt: 'Which of the workspace\'s target connections will this problem build into?',
      options: [...connections.map((c) => c.id), NO_CONNECTION],
      suggestedDefault: preferred.id,
      rationale: 'The connection decides the platform and the default database. Choose "none yet" if the target is not set up yet.'
    });
  }
  const platform = select('platform', connections.length ? 'Which platform, if there is no connection yet?' : 'Which platform will the target data warehouse/lakehouse run on? (No target connection in the workspace yet.)');
  questions.push(platform,
    select('modelingApproach', 'Which data modeling approach should the target use?'),
    select('transformationTool', 'Which transformation tool will run the models?'),
    select('orchestrationTool', 'Which orchestration tool will schedule the pipeline?'),
    select('namingConvention', 'Which naming convention should generated objects follow?'));
  const conn = connections[0];
  questions.push(
    {
      id: 'database', field: 'platformConfig.database', kind: 'text',
      prompt: 'Target database / catalog name?',
      suggestedDefault: conn?.database ?? 'CURATED_DB',
      rationale: conn?.database ? 'Defaults to the connection\'s database; change it if this problem builds elsewhere.' : undefined
    },
    {
      id: 'schema', field: 'platformConfig.schema', kind: 'text',
      prompt: 'Target schema name?',
      suggestedDefault: conn?.schema ?? 'ANALYTICS'
    }
  );
  return questions;
}
