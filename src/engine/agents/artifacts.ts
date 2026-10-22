import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildGroundingManifest, GroundingManifest, PrimitiveUse } from '../grounding/manifest';
import { buildSchemaIndex } from '../grounding/sqlGrounding';
import { ContextPackSources } from '../context/contextPack';
import { StageKind } from '../workflows/stageKinds';
import { outputDirSegments } from '../workspaceLayout';
import { appendEvent, Actor } from '../workflows/events';

/**
 * A stage's deliverable, recorded by the agent doing the stage (PA3b): written
 * where AutoDE's artifacts go (`autode-output/<problem>/<phase>/<stage>/…`,
 * the previous revision archived to `history/`), with the same grounding
 * manifest beside it that the panel writes, and noted in the workflow's
 * history. It is a draft: the stage's gate is where a person approves it
 * (owner's decision 2026-10-21: one approval, not one per artifact).
 */

const PHASE_OF: Record<StageKind, string> = {
  'specify': '01-discover', 'plan': '01-discover', 'target-context': '01-discover', 'source-assessment': '01-discover', 'conformance': '01-discover', 'quality-rules': '01-discover', 'platform-setup': '01-discover',
  'mapping': '02-model', 'entity-resolution': '02-model', 'modelling': '02-model', 'bi-migration': '02-model',
  'build': '03-build', 'code-conversion': '03-build', 'deploy': '03-build',
  'reconcile': '04-validate', 'validate': '04-validate', 'document': '04-validate'
};

export interface RecordArtifactInput {
  workspaceRoot: string;
  problemId: string;
  problemRoot: string;
  stage: { id: string; kind: StageKind };
  /** Relative to the stage's folder; no `..`, not absolute. */
  path: string;
  content: string;
  language?: string;
  who: Actor;
  channel: string;
  sources: ContextPackSources;
  primitiveUses?: PrimitiveUse[];
  outputDir?: string;
  model?: string;
}

export interface RecordedArtifact { path: string; manifestPath: string; unresolved: number; warnings: string[] }

const LANG: Record<string, string> = { '.sql': 'sql', '.md': 'markdown', '.yml': 'yaml', '.yaml': 'yaml', '.py': 'python', '.json': 'json' };

export function recordArtifact(input: RecordArtifactInput): RecordedArtifact {
  const rel = input.path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.split('/').includes('..') || path.isAbsolute(input.path) || /^[A-Za-z]:/.test(input.path)) throw new Error(`"${input.path}" must be a relative path inside the stage's folder.`);
  const segs = [...outputDirSegments(input.problemId, input.outputDir), PHASE_OF[input.stage.kind], input.stage.id, ...rel.split('/')];
  const file = path.join(input.workspaceRoot, ...segs);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const hist = path.join(path.dirname(file), 'history');
    fs.mkdirSync(hist, { recursive: true });
    fs.copyFileSync(file, path.join(hist, `${Date.now()}.${path.basename(file)}`));
  }
  fs.writeFileSync(file, input.content);
  const relPath = segs.join('/');
  const manifest: GroundingManifest = buildGroundingManifest({
    artifact: { path: relPath, content: input.content, language: input.language ?? LANG[path.extname(file).toLowerCase()] ?? 'text', agent: input.who.kind === 'agent' ? input.who.name : input.who.kind },
    catalogRevisions: input.sources.catalogRevisions,
    stepId: input.stage.id,
    primitiveUses: input.primitiveUses ?? [],
    graph: input.sources.graph,
    schemaIndex: buildSchemaIndex(input.sources.graph.nodes, input.sources.graph.edges),
    assertions: input.sources.assertions,
    model: input.model
  });
  const manifestFile = `${file}.grounding.json`;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  appendEvent(input.problemRoot, { at: new Date().toISOString(), type: 'recorded', stage: input.stage.id, actor: input.who, channel: input.channel, files: [relPath] });
  return { path: relPath, manifestPath: `${relPath}.grounding.json`, unresolved: manifest.grounding.identifiers.unresolved.length, warnings: manifest.grounding.warnings };
}
