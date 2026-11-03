/**
 * The stage kinds (PA3a, docs/specs/workflow-templates.md §1): fixed in the engine.
 * A template or a planner names stages freely but must use one of these kinds;
 * the kind decides who may do the stage, the most an agent may do there, what
 * the stage consumes and produces, and its default gates. This is also what
 * makes a task "grounded" (§9.2 PA3 §4).
 */

export type StageKind =
  | 'specify' | 'plan' | 'target-context' | 'source-assessment' | 'conformance' | 'quality-rules'
  | 'mapping' | 'entity-resolution' | 'modelling' | 'code-conversion' | 'build' | 'reconcile'
  | 'validate' | 'deploy' | 'document' | 'platform-setup' | 'bi-migration'
  /** ONT1: onboarding a standard and aligning the vocabulary to its concepts (the knowledge engineer). */
  | 'ontology-alignment'
  /** ONT1: drafting shared semantic models from the aligned concepts (the semantic modeler). */
  | 'semantic-modelling'
  /** PLN1: work a person does outside AutoDE (an ML feature pipeline, a streaming service, a sign-off in another tool). No agent, nothing run. */
  | 'manual';

/** Permission tiers, lowest first. No tier resolves or applies decisions. */
export const TIERS = ['read', 'propose', 'platform-read', 'workspace-write'] as const;
export type Tier = (typeof TIERS)[number];

/** What stages hand to each other. Some are documents with their own approval status; the rest are approved through gate decisions. */
export const ARTIFACTS = [
  'spec', 'workflow', 'target-context', 'source-context', 'estate', 'conformance-report', 'quality-rules',
  'mapping', 'entity-resolution', 'model', 'converted-code', 'pipeline-spec', 'artifacts', 'reconciliation-report',
  'validation-report', 'deployment', 'documentation', 'platform-setup-plan', 'bi-migration-plan', 'legacy-code', 'contract',
  'ontology', 'semantic-model'
] as const;
export type Artifact = (typeof ARTIFACTS)[number];

export type Gate = 'check' | 'approve';

export interface StageKindSpec {
  kind: StageKind;
  roles: string[];
  ceiling: Tier;
  consumes: Artifact[];
  produces: Artifact[];
  gates: Gate[];
  /** What "done" means, for people; the check itself is in the runtime. */
  doneWhen: string;
}

const k = (kind: StageKind, roles: string[], ceiling: Tier, consumes: Artifact[], produces: Artifact[], gates: Gate[], doneWhen: string): StageKindSpec => ({ kind, roles, ceiling, consumes, produces, gates, doneWhen });

export const STAGE_KINDS: Readonly<Record<StageKind, StageKindSpec>> = {
  'specify': k('specify', ['business-analyst'], 'propose', [], ['spec'], ['check', 'approve'], 'the specification validates and its problem statement is confirmed'),
  'plan': k('plan', ['planner'], 'propose', ['spec'], ['workflow'], ['check', 'approve'], 'the workflow passes the template rules'),
  'target-context': k('target-context', ['target-architect'], 'propose', ['spec'], ['target-context'], ['check', 'approve'], 'the target context is complete'),
  'source-assessment': k('source-assessment', ['source-assessor'], 'platform-read', ['spec'], ['source-context', 'estate'], ['check', 'approve'], 'the sources are in the estate and the source context is complete'),
  'conformance': k('conformance', ['source-assessor'], 'platform-read', ['contract', 'estate'], ['conformance-report'], ['check'], 'the conformance report exists and its failures are raised'),
  'quality-rules': k('quality-rules', ['quality-engineer', 'source-assessor', 'data-modeler'], 'propose', ['spec', 'estate'], ['quality-rules'], ['approve'], 'every critical attribute has a rule or a recorded reason'),
  'mapping': k('mapping', ['sttm-mapper'], 'propose', ['source-context', 'target-context'], ['mapping'], ['check', 'approve'], 'the mappings ground against the estate'),
  'entity-resolution': k('entity-resolution', ['sttm-mapper', 'data-modeler'], 'propose', ['source-context', 'mapping'], ['entity-resolution'], ['check', 'approve'], 'every merged entity has match and survivorship rules'),
  'modelling': k('modelling', ['data-modeler'], 'propose', ['spec', 'mapping'], ['model'], ['check', 'approve'], 'the model validates; grain and keys are stated'),
  'code-conversion': k('code-conversion', ['pipeline-engineer'], 'workspace-write', ['legacy-code'], ['converted-code'], ['check', 'approve'], 'the converted code is grounded and its gaps listed'),
  'build': k('build', ['pipeline-engineer'], 'workspace-write', ['mapping'], ['pipeline-spec', 'artifacts'], ['check', 'approve'], 'the Pipeline Spec validates and compiles'),
  'reconcile': k('reconcile', ['source-assessor', 'pipeline-engineer'], 'platform-read', ['mapping', 'artifacts'], ['reconciliation-report'], ['check', 'approve'], 'the agreed tolerances are met or the differences explained'),
  'validate': k('validate', ['documenter', 'pipeline-engineer'], 'platform-read', ['artifacts'], ['validation-report'], ['check', 'approve'], 'the tests pass and the acceptance criteria are traced'),
  'deploy': k('deploy', ['pipeline-engineer'], 'propose', ['artifacts'], ['deployment'], ['approve'], 'the platform changes are approved and applied'),
  'document': k('document', ['documenter'], 'workspace-write', ['artifacts'], ['documentation'], ['check'], 'the documents are generated and linked to their artifacts'),
  'platform-setup': k('platform-setup', ['target-architect'], 'propose', ['target-context'], ['platform-setup-plan'], ['approve'], 'the plan covers every environment of the estate'),
  'ontology-alignment': k('ontology-alignment', ['knowledge-engineer'], 'propose', ['spec'], ['ontology'], ['approve'], 'the pack is approved and every glossary term the problem uses means a concept, or is recorded as a gap'),
  'semantic-modelling': k('semantic-modelling', ['semantic-modeler'], 'propose', ['ontology'], ['semantic-model'], ['check', 'approve'], 'the shared semantic models validate and are approved'),
  'bi-migration': k('bi-migration', ['documenter', 'data-modeler'], 'read', ['estate'], ['bi-migration-plan'], ['approve'], 'every report in scope is mapped or listed as a gap'),
  // No role: AutoDE assigns no agent. No gate: its owner marks it done, with a note (workflow-planning.md §3.3).
  'manual': k('manual', [], 'read', [], [], [], 'its owner marks it done outside AutoDE, with a note')
};

/** PLN1: a stage only a person does, outside AutoDE. */
export const isManualKind = (kind: StageKind): boolean => kind === 'manual';

export function tierRank(t: Tier): number {
  return TIERS.indexOf(t);
}

/** Artifacts that come from outside the workflow (connections, files, the pack): never "missing a producer". */
export const EXTERNAL_ARTIFACTS: readonly Artifact[] = ['contract', 'legacy-code', 'estate'];
