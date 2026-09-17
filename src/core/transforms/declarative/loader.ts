import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml } from '../../../context/Yaml';
import { PrimitiveDefinition } from './types';
import { validatePrimitiveDefinition } from './schema';

export interface PrimitiveDefinitionLoadError {
  file: string;
  error: string;
}

export interface PrimitiveDefinitionLoadResult {
  definitions: PrimitiveDefinition[];
  errors: PrimitiveDefinitionLoadError[];
}

/**
 * Loads and validates every `*.yaml`/`*.yml` file in a primitive-definitions
 * directory (bundled defaults, or a workspace's `.ai-context/primitives/`
 * overrides). Modeled on `loadSkillsFromDirectory()` (src/core/skillRegistry.ts)
 * — same plain-Node-fs, no-vscode-dependency approach — but unlike that
 * loader, a malformed definition is reported in `errors`, not silently
 * dropped; it still never aborts loading the rest of the directory.
 */
export function loadPrimitiveDefinitionsFromDirectory(dirPath: string): PrimitiveDefinitionLoadResult {
  const definitions: PrimitiveDefinition[] = [];
  const errors: PrimitiveDefinitionLoadError[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return { definitions, errors };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    try {
      const raw = parseYaml(fs.readFileSync(fullPath, 'utf8'));
      const { valid, errors: validationErrors } = validatePrimitiveDefinition(raw);
      if (!valid) {
        errors.push({ file: entry.name, error: validationErrors.join('; ') || 'failed schema validation' });
        continue;
      }
      definitions.push(raw as PrimitiveDefinition);
    } catch (err) {
      errors.push({ file: entry.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { definitions, errors };
}

/**
 * Merges bundled defaults with workspace overrides — later entries win on a
 * matching `kind`, mirroring `ensureSkills()`'s bundled+override merge
 * (src/core/webviewProvider.ts), the only other precedent for this shape of
 * extensibility already in the codebase. Unconditional on load order, same
 * as the skills system — not gated on `version` being higher.
 */
export function mergePrimitiveDefinitions(bundled: PrimitiveDefinition[], overrides: PrimitiveDefinition[]): PrimitiveDefinition[] {
  const byKind = new Map<string, PrimitiveDefinition>();
  for (const def of bundled) byKind.set(def.kind, def);
  for (const def of overrides) byKind.set(def.kind, def);
  return [...byKind.values()];
}
