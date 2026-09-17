import { BusinessProblemSpec, ImplementationType, InferredPhase, PlanStep, SessionStatus, WorkflowPhase } from './types';

/**
 * Spec-driven phase inference + orchestration.
 *
 * From the approved Business Problem Specification AutoDE determines which of the
 * four workflow phases (discover / model / build / validate) are required and how
 * they depend on each other. The user does not select workflow steps — the workflow
 * is inferred and continuously adapted as the plan executes.
 *
 * This module is deliberately dependency-free (no `vscode` import) so the rules are
 * unit-testable in a plain Node process.
 */

export const PHASE_ORDER: WorkflowPhase[] = ['discover', 'model', 'build', 'validate'];

export const PHASE_LABELS: Record<WorkflowPhase, string> = {
  discover: 'Discover & assess sources',
  model: 'Model the data',
  build: 'Build pipelines & artifacts',
  validate: 'Validate & document'
};

/** Evidence keywords: if any appear in the specification the phase is required. */
const PHASE_KEYWORDS: Record<WorkflowPhase, string[]> = {
  discover: [
    'source', 'sources', 'raw data', 'raw sources', 'landing', 'staging', 'ingest', 'ingestion',
    'extract', 'extraction', 'assessment', 'profile', 'profiling', 'metadata', 'schema analysis',
    'legacy', 'existing systems', 'as-is', 'as is', 'current state', 'discover', 'discovery',
    'connect', 'catalog', 'crawl', 'capture'
  ],
  model: [
    'model', 'models', 'modeling', 'modelling', 'dimensional', 'star schema', 'snowflake schema',
    'data vault', 'one big table', 'obt', 'curated', 'mart', 'marts', 'gold layer', 'silver layer',
    '3nf', 'transform', 'transformation', 'mapping', 'sttm', 'semantic layer', 'snapshot',
    'conformed', 'slowly changing', 'attribute'
  ],
  build: [
    'pipeline', 'pipelines', 'dag', 'load', 'loading', 'dbt', 'etl', 'elt', 'airflow', 'dagster',
    'prefect', 'build', 'scaffold', 'scaffolding', 'ddl', 'incremental', 'orchestrat', 'deploy',
    'create table', 'create view', 'create the table', 'run', 'code', 'implementation'
  ],
  validate: [
    'valid', 'validation', 'quality', 'test', 'testing', 'document', 'documentation', 'report',
    'dashboard', 'accuracy', 'reconcile', 'reconciliation', 'row count', 'rowcount', 'sla',
    'monitor', 'monitoring', 'alert', 'governance', 'lineage', 'audit'
  ]
};

/**
 * Explicit exclusions declared in `scope.out`. A matching phrase removes the phase
 * even when positive evidence exists elsewhere in the specification.
 */
const SCOPE_OUT_EXCLUSIONS: Array<{ phase: WorkflowPhase; phrases: string[] }> = [
  { phase: 'discover', phrases: ['no discovery', 'no source assessment', 'no metadata', 'no profiling', 'no schema analysis', 'no as-is', 'no current state', 'sources are provided', 'already ingested', 'no ingestion', 'no source analysis'] },
  { phase: 'model', phrases: ['no modeling', 'no modelling', 'no models', 'no model', 'no transformations', 'no mapping', 'no star schema', 'no data vault', 'no semantic layer', 'no silver', 'no gold', 'no dbt models'] },
  { phase: 'build', phrases: ['no pipeline', 'no pipelines', 'no code', 'no build', 'no dbt', 'no etl', 'no elt', 'no ingestion', 'no loading', 'no ddl', 'no orchestration', 'no deployment', 'read-only analysis', 'read only analysis', 'no implementation'] },
  { phase: 'validate', phrases: ['no validation', 'no tests', 'no testing', 'no documentation', 'no docs', 'no reports', 'no report', 'no dashboard', 'no monitoring', 'no sla', 'no alerts'] }
];
/** Word-boundary matcher: a keyword must start on a word boundary to avoid `source` matching inside `resource`. */
export function matchesAnyKeyword(text: string, keywords: string[]): boolean {
  for (const kw of keywords) {
    if (new RegExp(`(?:^|[^a-z0-9_])${escapeRegExp(kw)}`, 'i').test(text)) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Computes the predecessor chain for each phase using only the currently-required phases. */
export function buildPhaseDependencies(required: WorkflowPhase[]): Record<WorkflowPhase, WorkflowPhase[]> {
  const set = new Set(required);
  const naturalPredecessors: Partial<Record<WorkflowPhase, WorkflowPhase | undefined>> = {
    model: 'discover',
    build: 'model',
    validate: 'build'
  };
  const result = {} as Record<WorkflowPhase, WorkflowPhase[]>;
  for (const phase of PHASE_ORDER) {
    const deps: WorkflowPhase[] = [];
    let cursor = naturalPredecessors[phase];
    while (cursor && set.has(cursor) && !deps.includes(cursor)) {
      deps.push(cursor);
      cursor = naturalPredecessors[cursor];
    }
    result[phase] = deps;
  }
  return result;
}
/**
 * Deterministically infers the required workflow phases from an approved BPS.
 * Rules:
 *  1. Positive keyword evidence in the specification (plus, when supplied, the
 *     synthesized Context Layer summary) marks a phase required.
 *  2. `scope.out` exclusions veto a phase even with positive evidence.
 *  3. If no phase matches at all, the whole (default) workflow is required so an
 *     underspecified-but-approved spec still produces a meaningful plan.
 *  4. A build phase that must transform data implies discovery when there is
 *     source/ingestion evidence.
 *  5. A `brownfield` implementation forces `discover` required by default —
 *     existing systems need assessment even when the spec doesn't say so
 *     explicitly — unless `scope.out` explicitly excludes it (rule 2 still wins).
 *
 * `implementationType` and `contextSummary` are optional so existing callers
 * (and tests) that only pass a spec keep working unchanged.
 */
export function inferPhases(
  spec: BusinessProblemSpec,
  implementationType?: ImplementationType,
  contextSummary?: string
): InferredPhase[] {
  const corpus = [
    spec.problemStatement || '',
    ...(spec.objectives || []),
    ...(spec.scope?.in || []),
    ...(spec.constraints || []),
    ...(spec.successCriteria || []),
    ...(spec.assumptions || []),
    spec.domain || '',
    ...(spec.keyEntities || []),
    contextSummary || ''
  ]
    .filter((part) => typeof part === 'string')
    .join('\n')
    .toLowerCase();

  const outCorpus = (spec.scope?.out || []).filter((part) => typeof part === 'string').join('\n').toLowerCase();

  const required = new Set<WorkflowPhase>();
  const defaultedByType = new Set<WorkflowPhase>();
  for (const phase of PHASE_ORDER) {
    const excluded = (SCOPE_OUT_EXCLUSIONS.find((e) => e.phase === phase)?.phrases ?? []).some((phrase) =>
      matchesAnyKeyword(outCorpus, [phrase])
    );
    if (excluded) continue;
    if (matchesAnyKeyword(corpus, PHASE_KEYWORDS[phase])) {
      required.add(phase);
    }
  }

  // Underspecified-but-approved specification → default full workflow.
  if (required.size === 0) {
    PHASE_ORDER.forEach((phase) => required.add(phase));
  }

  // Transformation work requires knowing where the data comes from.
  if (required.has('build') && matchesAnyKeyword(corpus, PHASE_KEYWORDS.discover)) {
    required.add('discover');
  }

  // Brownfield projects need to assess what already exists, even absent explicit evidence.
  const discoverExcluded = (SCOPE_OUT_EXCLUSIONS.find((e) => e.phase === 'discover')?.phrases ?? []).some(
    (phrase) => matchesAnyKeyword(outCorpus, [phrase])
  );
  if (implementationType === 'brownfield' && !discoverExcluded && !required.has('discover')) {
    required.add('discover');
    defaultedByType.add('discover');
  }

  const dependencies = buildPhaseDependencies([...required]);

  return PHASE_ORDER.map((phase) => {
    const isRequired = required.has(phase);
    const reason = isRequired
      ? reasonFor(phase, corpus, defaultedByType.has(phase) ? implementationType : undefined)
      : 'Excluded or not indicated by this specification.';
    return {
      phase,
      label: PHASE_LABELS[phase],
      required: isRequired,
      status: 'pending' as const,
      reason,
      dependsOn: dependencies[phase]
    };
  });
}

function reasonFor(phase: WorkflowPhase, corpus: string, defaultedByType?: ImplementationType): string {
  const matched = PHASE_KEYWORDS[phase].filter((kw) => matchesAnyKeyword(corpus, [kw]));
  if (matched.length > 0) {
    return `Indicated by: ${matched.slice(0, 4).join(', ')}`;
  }
  if (defaultedByType === 'brownfield') {
    return 'Required by default for a brownfield implementation (existing systems need discovery/assessment).';
  }
  return 'Required by default (no phase-specific evidence was detected).';
}
/**
 * Recomputes live phase statuses from the current plan steps.
 *   - no steps yet                     -> required phases are `pending`
 *   - steps exist, plan not yet run    -> required phases with nothing running/done are `pending-review`
 *                                         (a plan was generated; the user has not clicked "Generate
 *                                         Artifacts" yet — this is the stage-review checkpoint)
 *   - all phase steps done             -> `completed`
 *   - running / partial                -> `in-progress`
 *   - any step failed                  -> `blocked`
 *   - all steps pending, execution on  -> `pending` when dependencies are met, otherwise `blocked`
 */
export function computePhaseStatuses(
  phases: InferredPhase[] | undefined,
  steps: PlanStep[],
  _currentPhase?: WorkflowPhase,
  planStatus?: SessionStatus
): InferredPhase[] | undefined {
  if (!phases) return phases;

  if (steps.length === 0) {
    return phases.map((phase): InferredPhase => ({ ...phase, status: phase.required ? 'pending' : 'unrequired' }));
  }

  // A plan exists but hasn't been run yet — required phases with no step activity
  // are awaiting user review/confirmation, not simply "queued."
  const awaitingReview = planStatus === 'ready';

  const stepsByPhase = new Map<WorkflowPhase, PlanStep[]>();
  for (const step of steps) {
    const phase = step.phase ?? 'discover';
    const bucket = stepsByPhase.get(phase) ?? [];
    bucket.push(step);
    stepsByPhase.set(phase, bucket);
  }

  const hasFailedPhase = (phase: WorkflowPhase): boolean =>
    (stepsByPhase.get(phase) ?? []).some((step) => step.status === 'failed');
  const allDone = (phase: WorkflowPhase): boolean => {
    const bucket = stepsByPhase.get(phase);
    return !!bucket && bucket.length > 0 && bucket.every((step) => step.status === 'completed');
  };
  const phaseHasSteps = (phase: WorkflowPhase): boolean => (stepsByPhase.get(phase) ?? []).length > 0;

  return phases.map((phase): InferredPhase => {
    if (!phase.required) {
      return { ...phase, status: 'unrequired' };
    }

    const bucket = stepsByPhase.get(phase.phase) ?? [];

    if (hasFailedPhase(phase.phase)) {
      return { ...phase, status: 'blocked' };
    }
    if (allDone(phase.phase)) {
      return { ...phase, status: 'completed' };
    }
    if (bucket.some((step) => step.status === 'running')) {
      return { ...phase, status: 'in-progress' };
    }
    if (bucket.some((step) => step.status === 'completed')) {
      return { ...phase, status: 'in-progress' };
    }

    // Everything is still pending → the phase is ready only when its dependencies are done.
    const dependenciesMet = (phase.dependsOn ?? []).every(
      (dep) => !phaseHasSteps(dep) || allDone(dep)
    );

    if (awaitingReview) {
      return { ...phase, status: 'pending-review' };
    }

    return {
      ...phase,
      status: dependenciesMet ? 'pending' : 'blocked'
    };
  });
}