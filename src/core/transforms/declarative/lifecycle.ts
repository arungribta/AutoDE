import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml, stringifyYaml } from '../../../context/Yaml';
import { PrimitiveDefinition } from './types';
import { validatePrimitiveDefinition } from './schema';

/**
 * Publish/deprecate actions on a `PrimitiveDefinition` file on disk (Phase
 * 2B-iii) — plain `node:fs`, same convention as `loader.ts`, operating on a
 * workspace directory path rather than requiring a `vscode.Uri`.
 */

export interface PublishResult {
  definition: PrimitiveDefinition;
  /** True when this republished an already-published definition (version bumped + prior revision archived); false for a first-ever publish. */
  versionBumped: boolean;
}

function findDefinitionFile(dirPath: string, kind: string): string {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    throw new Error(`No primitive definitions directory at ${dirPath}.`);
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    try {
      const raw = parseYaml(fs.readFileSync(fullPath, 'utf8')) as Record<string, unknown> | undefined;
      if (raw && raw.kind === kind) return fullPath;
    } catch {
      continue;
    }
  }
  throw new Error(`No primitive definition found for kind "${kind}" in ${dirPath}.`);
}

function writeDefinition(filePath: string, definition: PrimitiveDefinition): void {
  fs.writeFileSync(filePath, '# AutoDE Primitive Definition\n' + stringifyYaml(definition as unknown as Record<string, unknown>));
}

/** Archives the previous revision to `<dirPath>/history/<kind>.v<version>.yaml`, mirroring PipelineSpecManager/SpecManager's convention. Idempotent — a version already archived is left alone. */
function archive(dirPath: string, definition: PrimitiveDefinition): void {
  const historyDir = path.join(dirPath, 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  const target = path.join(historyDir, `${definition.kind}.v${definition.version}.yaml`);
  if (fs.existsSync(target)) return;
  fs.writeFileSync(target, '# AutoDE Primitive Definition (archived)\n' + stringifyYaml(definition as unknown as Record<string, unknown>));
}

/**
 * Publishes (or re-publishes) a primitive definition. A first publish
 * (current status is not already `published`) keeps `version` as-is —
 * mirrors `SpecManager.approve()`: "a draft v1 becomes an approved v1."
 * Re-publishing an already-published definition (i.e. edited again) bumps
 * `version` and archives the prior revision first — the same "version bumps
 * only when revising an already-approved predecessor" rule used everywhere
 * else in this plan.
 */
export function publishPrimitiveDefinition(dirPath: string, kind: string, publishedBy: string): PublishResult {
  const filePath = findDefinitionFile(dirPath, kind);
  const current = parseYaml(fs.readFileSync(filePath, 'utf8')) as PrimitiveDefinition;
  const wasPublished = current.status === 'published';
  if (wasPublished) {
    archive(dirPath, current);
  }
  const updated: PrimitiveDefinition = {
    ...current,
    status: 'published',
    version: wasPublished ? current.version + 1 : current.version,
    publishedBy,
    publishedAt: new Date().toISOString()
  };
  const { valid, errors } = validatePrimitiveDefinition(updated);
  if (!valid) {
    throw new Error(`Cannot publish an invalid primitive definition: ${errors.join('; ')}`);
  }
  writeDefinition(filePath, updated);
  return { definition: updated, versionBumped: wasPublished };
}

/** Marks a published primitive deprecated — it stops being offered to the LLM (see `isSelectable`) but keeps compiling for anything that already references it. */
export function deprecatePrimitiveDefinition(dirPath: string, kind: string): PrimitiveDefinition {
  const filePath = findDefinitionFile(dirPath, kind);
  const current = parseYaml(fs.readFileSync(filePath, 'utf8')) as PrimitiveDefinition;
  const updated: PrimitiveDefinition = { ...current, status: 'deprecated' };
  writeDefinition(filePath, updated);
  return updated;
}
