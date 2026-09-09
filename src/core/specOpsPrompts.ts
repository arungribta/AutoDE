import { IntakeSession, SkillDefinition } from './types';

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

/** Renders the discovery turn prompt from the current intake session + skills. */
export function buildDiscoveryTurnPrompt(session: IntakeSession, skills: SkillDefinition[]): { system: string; user: string } {
  const lines: string[] = [];

  lines.push(`## Business problem (from the user)\n${session.problemStatement}`);

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

  lines.push('\nReturn your next action as a single JSON object now.');

  return { system: DISCOVERY_SYSTEM_PROMPT, user: lines.join('\n') };
}

/**
 * Composes the synthesis input from the collected Q&A so the existing single-shot
 * spec generator produces a draft from the accumulated conversation. (The full v2
 * comprehensive synthesis lands in a later phase.)
 */
export function composeSynthesisPrompt(session: IntakeSession): string {
  const lines: string[] = [session.problemStatement];
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

/** Builds the comprehensive-synthesis turn from the collected Q&A. */
export function buildSynthesisPrompt(session: IntakeSession): { system: string; user: string } {
  return {
    system: SYNTHESIS_SYSTEM_PROMPT,
    user: `${composeSynthesisPrompt(session)}\n\nProduce the comprehensive Business Problem Specification JSON now.`
  };
}
