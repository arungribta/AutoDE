import { IntakeSession, SkillDefinition } from './types';

/**
 * A live snapshot of SpecOps discovery progress — surfaces what `IntakeSession`
 * already tracks internally (per-field coverage, turn budget, which skill owns
 * which field) so the UI can show the interview as a bounded, structured process
 * instead of an opaque back-and-forth. Added after testing showed the discovery
 * chat "asks valid questions" but reads as ungrounded, unstructured chat — the
 * orchestration was real but entirely invisible client-side.
 */
export interface DiscoveryProgress {
  turnCount: number;
  turnBudget: number;
  coveredFields: number;
  totalFields: number;
  skills: Array<{ id: string; name: string; status: 'addressed' | 'partial' | 'not-started' }>;
}

/**
 * Pure. Coverage only ever reaches `'complete'` at synthesis time
 * (`SpecOpsEngine.completeFields`), so "covered"/"addressed" here deliberately
 * means "not missing" — matching `SpecOpsEngine.coverageComplete()`'s own stop
 * condition — rather than waiting for a status that never occurs mid-interview.
 */
export function buildDiscoveryProgress(session: IntakeSession, skills: SkillDefinition[]): DiscoveryProgress {
  const coverage = session.coverage;
  const fields = Object.keys(coverage);
  const coveredFields = fields.filter((field) => coverage[field] !== 'missing').length;

  const skillStatuses = skills
    .filter((skill) => skill.specFields.length > 0)
    .map((skill) => {
      const owned = skill.specFields;
      const notMissing = owned.filter((field) => coverage[field] !== undefined && coverage[field] !== 'missing').length;
      const status: 'addressed' | 'partial' | 'not-started' =
        notMissing === 0 ? 'not-started' : notMissing === owned.length ? 'addressed' : 'partial';
      return { id: skill.id, name: skill.name, status };
    });

  return { turnCount: session.turnCount, turnBudget: session.turnBudget, coveredFields, totalFields: fields.length, skills: skillStatuses };
}

/**
 * Which registered skill owns a question's target field, if any — resolved
 * deterministically from `SkillDefinition.specFields` rather than trusted from
 * whatever (optional) `skill` string the LLM itself put on the question, so the
 * label shown to the user is reliable even when the LLM omits or misnames it.
 */
export function skillNameForField(field: string, skills: SkillDefinition[]): string | undefined {
  return skills.find((skill) => skill.specFields.includes(field))?.name;
}
