import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml } from '../context/Yaml';
import { ToolSkillDefinition } from './types';

/**
 * Parses and loads imported Claude Agent Skills (`SKILL.md` + resources) —
 * distinct from the interview-only `skills/*.json` (`skillRegistry.ts`).
 *
 * Pure / filesystem-only (no `vscode` import), same convention as
 * `skillRegistry.ts`, so this is unit-testable in plain Node.
 *
 * SKILL.md shape assumed (the documented Claude Agent Skills convention): an
 * optional YAML frontmatter block (`---` fences) with `name`/`description`/
 * `allowed-tools` (or `allowedTools`), followed by a Markdown body that is the
 * skill's instructions. Parsing is deliberately lenient — frontmatter and every
 * field within it are optional — because this skill format is not something
 * AutoDE controls or has a machine-checkable schema for.
 */

const SKILL_FILENAME = 'SKILL.md';

export interface ParsedSkillMarkdown {
  name?: string;
  description?: string;
  allowedTools?: string[];
  body: string;
}

/** Splits a SKILL.md file into optional YAML frontmatter + the Markdown body. */
export function parseSkillMarkdown(content: string): ParsedSkillMarkdown {
  const text = (content ?? '').replace(/\r\n/g, '\n');
  const frontmatterMatch = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!frontmatterMatch) {
    return { body: text.trim() };
  }
  const body = text.slice(frontmatterMatch[0].length).trim();
  let name: string | undefined;
  let description: string | undefined;
  let allowedTools: string[] | undefined;
  try {
    const parsed = parseYaml(frontmatterMatch[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      name = typeof record.name === 'string' ? record.name.trim() : undefined;
      description = typeof record.description === 'string' ? record.description.trim() : undefined;
      const rawTools = record['allowed-tools'] ?? record.allowedTools ?? record.allowed_tools;
      if (Array.isArray(rawTools)) {
        allowedTools = rawTools.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
      } else if (typeof rawTools === 'string') {
        allowedTools = rawTools.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
      }
    }
  } catch {
    // Malformed frontmatter — fall back to treating the whole file as the body.
    return { body: text.trim() };
  }
  return { name, description, allowedTools, body };
}

/** Lists every file under `dir` (recursively), relative to `dir`, excluding SKILL.md itself. */
function listResourceFiles(dir: string): string[] {
  const results: string[] = [];
  const walk = (current: string, relPrefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), rel);
      } else if (entry.isFile() && entry.name !== SKILL_FILENAME) {
        results.push(rel);
      }
    }
  };
  walk(dir, '');
  return results;
}

/** Parses one already-imported skill directory (must contain SKILL.md) into a `ToolSkillDefinition`. */
export function loadToolSkill(sourceDir: string, idFallback?: string): ToolSkillDefinition {
  const skillMdPath = path.join(sourceDir, SKILL_FILENAME);
  const raw = fs.readFileSync(skillMdPath, 'utf8');
  const parsed = parseSkillMarkdown(raw);
  const id = idFallback ?? path.basename(sourceDir);
  return {
    id,
    name: parsed.name || id,
    description: parsed.description || '',
    instructions: parsed.body,
    declaredTools: parsed.allowedTools,
    sourceDir,
    resourceFiles: listResourceFiles(sourceDir)
  };
}

/** Loads every imported skill under `toolSkillsDir` (one subdirectory per skill, each containing SKILL.md). */
export function loadToolSkillsFromDirectory(toolSkillsDir: string): ToolSkillDefinition[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(toolSkillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: ToolSkillDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(toolSkillsDir, entry.name);
    if (!fs.existsSync(path.join(skillDir, SKILL_FILENAME))) continue;
    try {
      skills.push(loadToolSkill(skillDir, entry.name));
    } catch {
      continue; // skip an unreadable/invalid skill rather than failing the whole load
    }
  }
  return skills;
}
