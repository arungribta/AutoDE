import { BusinessProblemSpec, IntakeAttachment, IntakeSession, SkillDefinition } from './types';

/**
 * Prompt assembly for the agentic spec-discovery loop. Pure functions only —
 * the LLM call itself lives in AgentHub, so these can be unit-tested in Node.
 */

export const DISCOVERY_SYSTEM_PROMPT = [
  'You are a senior data engineering business analyst conducting a requirements-discovery conversation.',
  'Your goal is to gather enough information to write a complete, high-quality Business Problem Specification.',
  'Ask the minimum number of contextual questions needed; clarify ambiguities; never re-ask what is already answered.',
  'Respond with a single valid JSON object only — no prose and no markdown fences.',
  'The object must describe your next action using exactly this shape:',
  '{',
  '  "action": "ask" | "ask_many" | "synthesize" | "done",',
  '  "question": { "field": "dataFlows", "prompt": "...", "kind": "text|single-select|multi-select|boolean", "options": ["only for select kinds"], "rationale": "why you are asking", "skill": "skill-id" },',
  '  "questions": [ { "...": "same shape as question" } ]',
  '}',
  'Rules:',
  '- Use "ask" for one question and "ask_many" for a small batch of related questions (2-4).',
  '- Choose "synthesize" only when the information is sufficient to write a complete specification.',
  '- Choose "done" only when the specification is already complete.',
  '- The "field" must be one of the specification fields you are responsible for.',
  '- "kind" must be "text", "single-select", "multi-select", or "boolean".',
  '- Include "options" only for single-select and multi-select questions.'
].join('\n');

/** Extra discovery-turn rules that apply only when revising an already-approved specification. */
export const REVISION_DISCOVERY_RULES = [
  'This conversation is REVISING an already-approved specification, shown below as "Existing approved specification".',
  'Treat every field already populated there as already answered — do not re-ask about it.',
  'Only ask about: (a) fields the requested change plausibly affects, or (b) fields that are empty/missing below and still needed for a complete specification.',
  'Once the requested change and any newly-relevant fields are sufficiently clarified, choose "synthesize" promptly rather than re-verifying unaffected fields.'
].join('\n');

/** Renders a compact, complete textual snapshot of a spec for LLM consumption. */
export function renderSpecSnapshot(spec: BusinessProblemSpec): string {
  const lines: string[] = [];
  const field = (label: string, value: string | undefined) => { if (value) lines.push(`${label}: ${value}`); };
  const list = (label: string, values: string[] | undefined) => { if (values && values.length > 0) lines.push(`${label}: ${values.join('; ')}`); };

  field('Problem statement', spec.problemStatement);
  list('Objectives', spec.objectives);
  list('Success criteria', spec.successCriteria);
  list('In scope', spec.scope?.in);
  list('Out of scope', spec.scope?.out);
  list('Constraints', spec.constraints);
  list('Assumptions', spec.assumptions);
  field('Domain', spec.domain);
  list('Stakeholders', spec.stakeholders);
  list('Key entities', spec.keyEntities);
  list('Business requirements', spec.businessRequirements);
  if (spec.sourceCatalog && spec.sourceCatalog.length > 0) {
    lines.push(`Source catalog: ${spec.sourceCatalog.map((s) => `${s.name} (${s.type})`).join('; ')}`);
  }
  if (spec.dataFlows && spec.dataFlows.length > 0) {
    lines.push(`Data flows: ${spec.dataFlows.map((f) => `${f.source} -> ${f.target}: ${f.description}`).join('; ')}`);
  }
  list('Transformations', spec.transformations);
  list('Dependencies', spec.dependencies);
  list('Acceptance criteria', spec.acceptanceCriteria);
  list('Implementation considerations', spec.implementationConsiderations);
  return lines.join('\n');
}

function renderAttachments(attachments?: IntakeAttachment[]): string {
  if (!attachments || attachments.length === 0) return '';
  const parts = attachments.map((a) => `--- ${a.path} ---\n${a.content}`);
  return `\n## Attached reference material (user-supplied)\n${parts.join('\n\n')}`;
}

/** Renders the discovery turn prompt from the current intake session + skills. */
export function buildDiscoveryTurnPrompt(
  session: IntakeSession,
  skills: SkillDefinition[],
  extraContext?: string
): { system: string; user: string } {
  const lines: string[] = [];
  const isRevision = !!session.previousSpec;

  if (isRevision) {
    lines.push(`## Requested change (from the user)\n${session.changeRequest ?? ''}`);
    lines.push(`\n## Existing approved specification (v${session.previousSpec!.version}) — revise, don't restart\n${renderSpecSnapshot(session.previousSpec!)}`);
  } else {
    lines.push(`## Business problem (from the user)\n${session.problemStatement}`);
  }

  lines.push(`\n## Conversation so far (${session.turnCount}/${session.turnBudget} turns used)`);
  if (session.questions.length === 0) {
    lines.push('(no questions asked yet)');
  } else {
    const answered = new Map(session.answers.map((answer) => [answer.questionId, answer.value]));
    for (const question of session.questions) {
      const value = answered.get(question.id);
      lines.push(`- Q: ${question.prompt}${value !== undefined ? `\n  A: ${value}` : ''}`);
    }
  }

  const gaps = Object.entries(session.coverage)
    .filter(([, status]) => status !== 'complete')
    .map(([field, status]) => `${field} (${status})`);
  lines.push(gaps.length > 0 ? `\n## Coverage gaps still to explore\n${gaps.join(', ')}` : '\n## Coverage\nAll fields explored.');

  const questionSkills = skills.filter((skill) => skill.specFields.length > 0);
  if (questionSkills.length > 0) {
    lines.push('\n## Available skills (use these to decide what to ask)');
    for (const skill of questionSkills) {
      lines.push(`- ${skill.id}: ${skill.questionGuidance}`);
      if (skill.exampleQuestions && skill.exampleQuestions.length > 0) {
        lines.push(`  e.g. "${skill.exampleQuestions[0]}"`);
      }
    }
  }

  if (extraContext && extraContext.trim().length > 0) {
    lines.push(`\n## Registered repository context\n${extraContext.trim()}`);
  }
  lines.push(renderAttachments(session.attachments));

  lines.push('\nReturn your next action as a single JSON object now.');

  const system = isRevision ? `${DISCOVERY_SYSTEM_PROMPT}\n\n${REVISION_DISCOVERY_RULES}` : DISCOVERY_SYSTEM_PROMPT;
  return { system, user: lines.join('\n') };
}

/**
 * Composes the synthesis input from the collected Q&A so the existing single-shot
 * spec generator produces a draft from the accumulated conversation. (The full v2
 * comprehensive synthesis lands in a later phase.)
 */
export function composeSynthesisPrompt(session: IntakeSession, extraContext?: string): string {
  const lines: string[] = [];
  if (session.previousSpec) {
    lines.push(`Requested change: ${session.changeRequest ?? ''}`);
    lines.push(`\nExisting approved specification (v${session.previousSpec.version}):\n${renderSpecSnapshot(session.previousSpec)}`);
  } else {
    lines.push(session.problemStatement);
  }
  const answered = new Map(session.answers.map((answer) => [answer.questionId, answer.value]));
  for (const question of session.questions) {
    const value = answered.get(question.id);
    if (value !== undefined) {
      lines.push(`Q: ${question.prompt}\nA: ${value}`);
    }
  }
  for (const insight of session.insights) {
    lines.push(`Insight: ${insight}`);
  }
  if (extraContext && extraContext.trim().length > 0) {
    lines.push(`\nRegistered repository context:\n${extraContext.trim()}`);
  }
  const attachmentBlock = renderAttachments(session.attachments);
  if (attachmentBlock) lines.push(attachmentBlock);
  return lines.join('\n');
}

export const SYNTHESIS_SYSTEM_PROMPT = [
  'You are a senior data engineering business analyst producing a comprehensive Business Problem Specification.',
  'Respond with a single valid JSON object only — no prose and no markdown fences.',
  'Use exactly this shape:',
  '{',
  '  "problemStatement": "...",',
  '  "objectives": ["..."],',
  '  "successCriteria": ["..."],',
  '  "scope": { "in": ["..."], "out": ["..."] },',
  '  "constraints": ["..."],',
  '  "assumptions": ["..."],',
  '  "domain": "...",',
  '  "stakeholders": ["..."],',
  '  "keyEntities": ["..."],',
  '  "businessRequirements": ["..."],',
  '  "dataFlows": [{ "id": "f1", "source": "...", "target": "...", "description": "...", "transformations": ["..."], "frequency": "daily" }],',
  '  "transformations": ["..."],',
  '  "dependencies": ["..."],',
  '  "acceptanceCriteria": ["..."],',
  '  "implementationConsiderations": ["..."],',
  '  "sourceCatalog": [{ "name": "...", "type": "database|api|file|stream|saas|other", "description": "...", "availability": "..." }]',
  '}',
  'Rules:',
  '- Derive every statement from the collected Q&A; never invent systems, tables, vendors, or metrics.',
  '- Record anything unresolved as an explicit assumption.',
  '- "problemStatement", "objectives" and "scope.in" must be non-empty.',
  '- Include dataFlows, transformations, dependencies, acceptanceCriteria, and implementationConsiderations as comprehensively as the collected answers support.'
].join('\n');

/** Extra synthesis rules that apply only when revising an already-approved specification. */
export const REVISION_SYNTHESIS_RULES = [
  'This is a REVISION of the existing approved specification supplied above, applying the stated requested change.',
  'Your output MUST be the FULL specification, not a diff: carry forward every field from the existing specification unchanged unless the requested change or the Q&A above says otherwise.',
  'Only fields the requested change actually affects should differ from the existing specification.'
].join('\n');

/** Builds the comprehensive-synthesis turn from the collected Q&A. */
export function buildSynthesisPrompt(session: IntakeSession, extraContext?: string): { system: string; user: string } {
  const system = session.previousSpec ? `${SYNTHESIS_SYSTEM_PROMPT}\n\n${REVISION_SYNTHESIS_RULES}` : SYNTHESIS_SYSTEM_PROMPT;
  return {
    system,
    user: `${composeSynthesisPrompt(session, extraContext)}\n\nProduce the comprehensive Business Problem Specification JSON now.`
  };
}
