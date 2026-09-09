import * as fs from 'node:fs';
import * as path from 'node:path';
import { SkillDefinition } from './types';

/**
 * Parses and validates a single skill definition from raw JSON. Normalizes
 * optional fields (order, exampleQuestions) and rejects malformed entries so
 * the registry never contains a half-usable skill.
 */
export function parseSkillDefinition(raw: unknown, idFallback?: string): SkillDefinition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('A skill definition must be a JSON object.');
  }
  const record = raw as Record<string, unknown>;

  const id = typeof record.id === 'string' ? record.id.trim() : (idFallback ?? '');
  if (!id) throw new Error('A skill definition requires an "id".');

  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) throw new Error(`Skill "${id}" requires a "name".`);

  const systemPrompt = typeof record.systemPrompt === 'string' ? record.systemPrompt.trim() : '';
  if (!systemPrompt) throw new Error(`Skill "${id}" requires a non-empty "systemPrompt".`);

  const description = typeof record.description === 'string' ? record.description.trim() : '';
  const questionGuidance = typeof record.questionGuidance === 'string' ? record.questionGuidance.trim() : '';
  const order = typeof record.order === 'number' && Number.isFinite(record.order) ? record.order : 0;

  const specFields = Array.isArray(record.specFields)
    ? record.specFields.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];

  const exampleQuestions = Array.isArray(record.exampleQuestions)
    ? record.exampleQuestions.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : undefined;

  return { id, name, order, description, systemPrompt, questionGuidance, specFields, exampleQuestions };
}

/**
 * Loads and parses every `*.json` file in a skills directory (bundled defaults
 * or user overrides under `.ai-context/skills/`). Later entries with the same
 * id override earlier ones, so user skills can replace bundled skills.
 */
export function loadSkillsFromDirectory(dirPath: string): SkillDefinition[] {
  const skills: SkillDefinition[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const fullPath = path.join(dirPath, entry.name);
    try {
      const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as unknown;
      skills.push(parseSkillDefinition(raw, entry.name.replace(/\.json$/i, '')));
    } catch {
      // Skip unreadable/invalid skill files rather than failing the whole load.
      continue;
    }
  }
  return skills;
}

/** In-memory registry of DE spec-generation skills, ordered by `order`. */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();

  public constructor(skills: SkillDefinition[] = []) {
    for (const skill of skills) {
      this.skills.set(skill.id, skill);
    }
  }

  public add(skill: SkillDefinition): void {
    this.skills.set(skill.id, skill);
  }

  public get(id: string): SkillDefinition | undefined {
    return this.skills.get(id);
  }

  public has(id: string): boolean {
    return this.skills.has(id);
  }

  public list(): SkillDefinition[] {
    return [...this.skills.values()].sort((a, b) => a.order - b.order);
  }

  /** Skills that ask questions (i.e. responsible for at least one spec field). */
  public questionSkills(): SkillDefinition[] {
    return this.list().filter((skill) => skill.specFields.length > 0);
  }

  /** Skills responsible for a given spec field. */
  public skillsForField(field: string): SkillDefinition[] {
    return this.list().filter((skill) => skill.specFields.includes(field));
  }

  /** The union of all spec fields the registered skills are responsible for. */
  public allSpecFields(): string[] {
    return [...new Set(this.list().flatMap((skill) => skill.specFields))];
  }
}
