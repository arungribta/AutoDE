import { isSkillExposable } from '../engine/skills/lifecycle';
import { computeRevision } from '../engine/context/contextStore';
import { getPrimitiveVersion, listPrimitives } from '../engine/transforms/registry';
import { EngineToolError } from './errors';
import { buildChatExtractionPrompt } from '../engine/context/chatExtraction';
import { EngineWorkspace, PROBLEM_DOCUMENTS } from './workspace';
import { layoutRel } from '../engine/workspaceLayout';
import { loadRoles, loadSkillPack } from '../engine/agents/definitions';
import { ToolInfo, assignmentFor } from '../engine/agents/assignment';
import { semanticResources } from './semanticTools';

/**
 * MCP prompts (§5.4) and resources (§5.5) — read-only views of the
 * workspace. Resource contents carry their `revision` (SHA-256 of the bytes)
 * in `_meta`, so a client that later edits the file can detect a conflict.
 */

export interface PromptInfo {
  name: string;
  title: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
}

export function listPrompts(ws: EngineWorkspace): PromptInfo[] {
  const interview = ws.interviewSkills().map((s) => ({
    name: `autode_interview_${s.id}`,
    title: `AutoDE interview: ${s.name}`,
    description: s.description || `The "${s.name}" part of AutoDE's requirements interview.`,
    arguments: [{ name: 'answers_so_far', description: 'What the stakeholder has answered so far, so questions already answered are not asked again.', required: false }]
  }));
  // Only published skills reviewed or trusted for their current content (Phase S2).
  const tools = ws.toolSkills().filter((s) => isSkillExposable(s)).map((s) => ({
    name: `autode_skill_${s.skill.id}`,
    title: s.skill.name,
    description: s.skill.description || `Imported skill "${s.skill.name}".`,
    arguments: [{ name: 'instruction', description: 'What this run of the skill should do.', required: false }]
  }));
  // C4b: the same fact extraction AutoDE runs after each chat turn, for a client's own model (§5.2, D5).
  const extraction = { name: 'autode_extract_assertions', title: 'AutoDE: extract facts from a message', description: 'Turn what the engineer just said into proposed facts (keys, grain, relationships, terms, metrics, rules, decisions); submit each with autode_propose_assertion.', arguments: [{ name: 'message', description: "The engineer's message.", required: true }, { name: 'previous_reply', description: 'Your previous reply, for context.', required: false }] };
  // PA3b: AutoDE's agents (role templates), for hosts without sub-agents; with a stage, the full assignment.
  const agents = loadRoles(ws.options.resourcesRoot, ws.options.workspaceRoot).roles.map((r) => ({
    name: `autode_agent_${r.name}`,
    title: `AutoDE agent: ${r.name}`,
    description: r.description,
    arguments: [{ name: 'stage', description: 'The workflow stage to do (its id); gives the full assignment: brief, tier, tools, skills.', required: false }]
  }));
  return [...interview, ...tools, extraction, ...agents];
}

export function getPrompt(ws: EngineWorkspace, name: string, args: Record<string, string> = {}, tools: readonly ToolInfo[] = []): { description: string; text: string } {
  if (name === 'autode_extract_assertions') {
    if (!args.message?.trim()) throw new EngineToolError('VALIDATION_FAILED', 'autode_extract_assertions needs the message to extract from.');
    const { system, user } = buildChatExtractionPrompt({ text: args.message, previousReply: args.previous_reply, source: 'chat' }, []);
    return {
      description: 'Extract the facts the engineer stated.',
      text: [system, user, 'Facts already recorded: call autode_list_assertions for the subjects involved. Then submit each fact you found with autode_propose_assertion (evidence: the message). AutoDE validates, links corrections and asks a person to confirm.'].join('\n\n')
    };
  }
  const interviewId = /^autode_interview_(.+)$/.exec(name)?.[1];
  if (interviewId) {
    const s = ws.interviewSkills().find((x) => x.id === interviewId);
    if (!s) throw new EngineToolError('NOT_FOUND', `No interview prompt "${name}".`);
    const parts = [s.systemPrompt.trim(), '## What to ask about', s.questionGuidance.trim()];
    if (s.specFields.length) parts.push(`This part of the interview fills these specification fields: ${s.specFields.join(', ')}.`);
    if (s.exampleQuestions?.length) parts.push('## Example questions', ...s.exampleQuestions.map((q) => `- ${q}`));
    if (args.answers_so_far?.trim()) parts.push('## Answers so far', args.answers_so_far.trim(), 'Do not ask again what these answers already settle.');
    return { description: s.description, text: parts.filter(Boolean).join('\n\n') };
  }
  const skillId = /^autode_skill_(.+)$/.exec(name)?.[1];
  if (skillId) {
    const s = ws.toolSkills().find((x) => x.skill.id === skillId);
    // Unexposable skills are reported as missing, the same as unknown ones.
    if (!s || !isSkillExposable(s)) throw new EngineToolError('NOT_FOUND', `No skill prompt "${name}".`);
    const toolsLine = s.skill.declaredTools?.length
      ? `This skill declares these tools and should use no others: ${s.skill.declaredTools.join(', ')}.`
      : 'This skill declares no tool restriction.';
    const tierLine = s.effectiveTier === 'reviewed'
      ? 'It was reviewed for read-only use: do not write files or run commands while following it.'
      : 'It is trusted: writes and commands are allowed where its instructions need them, with the user\'s approval.';
    const parts = [`# Skill: ${s.skill.name} (v${s.sidecar.version})`, toolsLine, tierLine, '## Instructions', s.skill.instructions.trim()];
    if (s.skill.resourceFiles.length) parts.push(`Resource files alongside the skill (in ${layoutRel('toolSkills', s.skill.id)}/): ${s.skill.resourceFiles.join(', ')}.`);
    if (args.instruction?.trim()) parts.push('## Task', args.instruction.trim());
    return { description: s.skill.description, text: parts.join('\n\n') };
  }
  const roleName = /^autode_agent_(.+)$/.exec(name)?.[1];
  if (roleName) {
    const r = loadRoles(ws.options.resourcesRoot, ws.options.workspaceRoot).roles.find((x) => x.name === roleName);
    if (!r) throw new EngineToolError('NOT_FOUND', `No agent prompt "${name}".`);
    const problemId = ws.activeProblemId();
    if (args.stage?.trim()) {
      if (!problemId) throw new EngineToolError('NOT_FOUND', 'No active business problem: select one first.');
      const a = assignmentFor({ workspaceRoot: ws.options.workspaceRoot, resourcesRoot: ws.options.resourcesRoot, problemId }, args.stage.trim(), tools);
      if (!a.assignment) throw new EngineToolError('NOT_FOUND', a.reason ?? `No assignment for ${args.stage}.`);
      if (a.assignment.role !== r.name) throw new EngineToolError('VALIDATION_FAILED', `Stage ${args.stage} is assigned to ${a.assignment.role}, not ${r.name}.`);
      return { description: r.description, text: a.assignment.text };
    }
    const pack = loadSkillPack(ws.options.resourcesRoot).skills.filter((k) => r.skills.includes(k.id));
    const text = [
      `You are AutoDE's ${r.name}: ${r.description}`, r.instructions,
      'Take your work from the workflow: autode_workflow_next gives the stage, its brief, your permission tier and the AutoDE tools you may call. Record deliverables with autode_record_artifact. Never call another agent and never approve anything.',
      ...pack.map((k) => `## Skill: ${k.name}\n${k.description}\n\n${k.instructions}`)
    ].join('\n\n');
    return { description: r.description, text };
  }
  throw new EngineToolError('NOT_FOUND', `No prompt "${name}".`);
}

export interface ResourceInfo {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export const PRIMITIVE_RESOURCE_TEMPLATE = { uriTemplate: 'autode://primitives/{kind}', name: 'Transform primitive', description: 'One transform primitive: description, status and parameter schema.', mimeType: 'application/json' };

export function listResources(ws: EngineWorkspace): ResourceInfo[] {
  const docs = Object.entries(PROBLEM_DOCUMENTS)
    .filter(([key]) => ws.problemDocument(key))
    .map(([key, d]) => ({ uri: `autode://${key}`, name: d.name, description: d.description, mimeType: 'application/yaml' }));
  ws.ensurePrimitives();
  const primitives = listPrimitives().map((p) => ({ uri: `autode://primitives/${p.kind}`, name: `Primitive ${p.kind}`, description: p.description, mimeType: 'application/json' }))
    .sort((a, b) => a.uri.localeCompare(b.uri));
  const semantic = semanticResources(ws).map(({ file: _file, ...r }) => r);
  return [...docs, ...semantic, ...primitives];
}

export function readResource(ws: EngineWorkspace, uri: string): { uri: string; mimeType: string; text: string; revision: string } {
  const m = /^autode:\/\/(.+)$/.exec(uri);
  if (!m) throw new EngineToolError('NOT_FOUND', `Unknown resource "${uri}".`);
  const key = m[1];
  if (PROBLEM_DOCUMENTS[key]) {
    const file = ws.problemDocument(key);
    if (!file) throw new EngineToolError('NOT_FOUND', ws.activeProblemId() ? `The active business problem has no ${PROBLEM_DOCUMENTS[key].name} yet.` : 'No business problem is active.');
    const { text, revision } = ws.readWithRevision(file);
    return { uri, mimeType: 'application/yaml', text, revision };
  }
  if (key.startsWith('semantic/')) {
    const hit = semanticResources(ws).find((r) => r.uri === uri);
    if (!hit) throw new EngineToolError('NOT_FOUND', `No semantic model at "${uri}" (autode_semantic_list).`);
    const { text, revision } = ws.readWithRevision(hit.file);
    return { uri, mimeType: 'application/yaml', text, revision };
  }
  const kind = /^primitives\/(.+)$/.exec(key)?.[1];
  if (kind) {
    ws.ensurePrimitives();
    const p = getPrimitiveVersion(decodeURIComponent(kind));
    if (!p) throw new EngineToolError('UNKNOWN_PRIMITIVE', `Unknown primitive kind "${kind}".`);
    const def = ws.primitiveDefinition(p.kind);
    const text = JSON.stringify({ kind: p.kind, version: p.version ?? null, status: p.status ?? 'published', description: p.description, paramSchema: p.paramSchema, previewParams: def?.previewParams ?? null }, null, 2);
    return { uri, mimeType: 'application/json', text, revision: computeRevision(text) };
  }
  throw new EngineToolError('NOT_FOUND', `Unknown resource "${uri}".`);
}
