import * as fs from 'node:fs';
import * as path from 'node:path';
import { EngineTool, ToolAnnotations } from './tools';
import { EngineToolError } from './errors';
import { EngineWorkspace } from './workspace';
import { buildSchemaIndex, SchemaIndex } from '../engine/grounding/sqlGrounding';
import { buildVocabulary, parseVocabularyFile } from '../engine/context/vocabulary';
import { layoutPath } from '../engine/workspaceLayout';
import { matchColumns, mappingPrecedents, MatchColumn } from '../engine/agents/columnMatch';
import { validateMappingProposal } from '../engine/decisions/proposals';
import { writeMappingUpsert, problemDocumentPath } from '../engine/documents/problemDocuments';
import { writeSourceContextDraft, sourceContextFile } from '../engine/agents/sourceContextDraft';
import { readWorkflow } from '../engine/workflows/instance';
import { appendEvent, Actor } from '../engine/workflows/events';
import { EntityMapping, SourceContextEntry } from '../engine/types';
import { StageKind } from '../engine/workflows/stageKinds';

/**
 * The tools of the source assessor and the mapper (PA3b, v0.45.2): a
 * deterministic column matcher, and drafting the stage's own document — the
 * source context, the mapping — which a person then approves as the stage's
 * document (Workflow view, `autode workflow approve <stage>`). Drafting is not
 * approving: an approved document drafted again goes back to `built`.
 */

const read = (title: string): ToolAnnotations => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const records = (title: string): ToolAnnotations => ({ title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });

function findTable(index: SchemaIndex, ref: string) {
  const lower = ref.toLowerCase();
  const exact = index.tables.filter((t) => t.fqn.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const byName = index.byName.get(lower.split('.').pop() ?? lower) ?? [];
  if (byName.length > 1) throw new EngineToolError('VALIDATION_FAILED', `${ref} is ambiguous: ${byName.map((t) => t.fqn).join(', ')}. Give the fully qualified name.`);
  return byName[0];
}

function problemOf(ws: EngineWorkspace): { problemId: string; problemRoot: string } {
  const problemId = ws.activeProblemId();
  if (!problemId) throw new EngineToolError('NOT_FOUND', 'No active business problem: start or select one (autode_start_problem, autode_select_problem).');
  return { problemId, problemRoot: layoutPath(ws.options.workspaceRoot, 'problems', problemId) };
}

/** The stage the draft belongs to: the one named, else the problem's first included stage of that kind. */
function stageFor(problemRoot: string, kind: StageKind, named: unknown): string | undefined {
  const w = readWorkflow(problemRoot);
  if (!w) return undefined;
  if (typeof named === 'string' && named) {
    const s = w.stages.find((x) => x.id === named);
    if (!s || s.kind !== kind) throw new EngineToolError('VALIDATION_FAILED', `Stage ${named} is not a ${kind} stage of this workflow.`);
    return s.id;
  }
  return w.stages.find((x) => x.included && x.kind === kind)?.id;
}

export function agentTools(clientName: () => string | undefined): EngineTool[] {
  const agent = (): Actor => ({ kind: 'agent', name: clientName() ?? 'MCP client', host: 'MCP' });
  const note = (ws: EngineWorkspace, problemRoot: string, stage: string | undefined, file: string) => {
    if (stage) appendEvent(problemRoot, { at: new Date().toISOString(), type: 'recorded', stage, actor: agent(), channel: 'tool', files: [path.relative(ws.options.workspaceRoot, file).split(path.sep).join('/')] });
  };
  return [
    {
      name: 'autode_match_columns',
      description: 'Candidate column matches from a source table to a target table, deterministic, each with a score and its reasons: the same name, the same name without the table prefix, the same meaning through the vocabulary (CUST_NO ~ customer_number), words in common, and earlier approved mappings; types that can\'t convert lower the score. The target is a table in the estate, or a planned table given as targetColumns. Use it before drafting a mapping; you decide.',
      inputSchema: { type: 'object', required: ['source'], additionalProperties: false, properties: {
        source: { type: 'string', minLength: 1, description: 'Source table, fully qualified where ambiguous.' },
        target: { type: 'string', minLength: 1, description: 'Target table in the estate.' },
        targetColumns: { type: 'array', items: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1 }, type: { type: 'string' } } }, description: 'The columns of a planned target table not yet in the estate.' },
        threshold: { type: 'number', minimum: 0, maximum: 1 }
      } },
      annotations: read('Match columns'),
      handler: async (args, ws) => {
        const src = await ws.contextSources();
        const index = buildSchemaIndex(src.graph.nodes, src.graph.edges);
        const s = findTable(index, String(args.source));
        if (!s) throw new EngineToolError('NOT_FOUND', `Source table ${String(args.source)} is not in the estate AutoDE knows (bring it in with autode_ingest_file or autode_ingest_metadata).`);
        let targetName: string | undefined;
        let targetCols: MatchColumn[];
        if (Array.isArray(args.targetColumns) && args.targetColumns.length) {
          targetCols = (args.targetColumns as MatchColumn[]).map((c) => ({ name: c.name, type: c.type }));
          targetName = args.target as string | undefined;
        } else {
          if (!args.target) throw new EngineToolError('VALIDATION_FAILED', 'Give the target table, or targetColumns for a planned one.');
          const t = findTable(index, String(args.target));
          if (!t) throw new EngineToolError('NOT_FOUND', `Target table ${String(args.target)} is not in the estate: give its planned columns as targetColumns.`);
          targetName = t.fqn;
          targetCols = [...t.columns.entries()].map(([name, type]) => ({ name, type }));
        }
        const vf = layoutPath(ws.options.workspaceRoot, 'vocabulary');
        const vocab = buildVocabulary(fs.existsSync(vf) ? parseVocabularyFile(fs.readFileSync(vf, 'utf8')) : undefined);
        const r = matchColumns({ table: s.fqn, columns: [...s.columns.entries()].map(([name, type]) => ({ name, type })) }, { table: targetName, columns: targetCols },
          { vocab, precedents: mappingPrecedents(ws.options.workspaceRoot), threshold: args.threshold as number | undefined });
        return { source: s.fqn, target: targetName ?? null, ...r } as unknown as Record<string, unknown>;
      }
    },
    {
      name: 'autode_record_mapping',
      description: 'Draft one entity mapping (source table → target, column by column, with transform expressions where needed) into the active problem\'s mapping document. It is validated against the estate first (errors come back item by item); it replaces a mapping with the same id. The mapping document is approved as a whole by a person, as the mapping stage\'s document; an approved mapping drafted again goes back to built.',
      inputSchema: { type: 'object', required: ['mapping'], additionalProperties: false, properties: {
        mapping: { type: 'object', required: ['id', 'sourceEntityId', 'targetName', 'columns'], properties: {
          id: { type: 'string', minLength: 1 }, sourceEntityId: { type: 'string', minLength: 1 }, sourceFqn: { type: 'string' }, targetEntityId: { type: 'string' }, targetName: { type: 'string', minLength: 1 }, notes: { type: 'string' },
          columns: { type: 'array', minItems: 1, items: { type: 'object', required: ['sourceColumn', 'targetColumn'], properties: { sourceColumn: { type: 'string', minLength: 1 }, targetColumn: { type: 'string', minLength: 1 }, transformExpression: { type: 'string' } } } }
        } },
        stage: { type: 'string', minLength: 1, description: 'The mapping stage (default: the workflow\'s mapping stage).' }
      } },
      annotations: records('Draft a mapping'),
      handler: async (args, ws) => {
        const { problemId, problemRoot } = problemOf(ws);
        const m = args.mapping as EntityMapping;
        const src = await ws.contextSources();
        const v = validateMappingProposal(m, { workspaceRoot: ws.options.workspaceRoot, problemRoot, problemId, schemaIndex: buildSchemaIndex(src.graph.nodes, src.graph.edges) });
        if (!v.ok) throw new EngineToolError('VALIDATION_FAILED', `The mapping isn't valid: ${v.errors.join(' ')}`, { errors: v.errors, warnings: v.warnings });
        const stage = stageFor(problemRoot, 'mapping', args.stage);
        const ctx = writeMappingUpsert(problemRoot, m);
        const file = problemDocumentPath(problemRoot, 'mappingContext');
        note(ws, problemRoot, stage, file);
        return { mapping: m.id, mappings: ctx.mappings.length, status: ctx.status, warnings: v.warnings, file: path.relative(ws.options.workspaceRoot, file).split(path.sep).join('/'), next: 'Draft the other mappings, then tell the user the mapping is ready for their approval (the Workflow view, or `autode workflow approve <stage>` in a terminal).' };
      }
    },
    {
      name: 'autode_record_source_context',
      description: 'Draft the active problem\'s source context: each source system the problem draws on, and how AutoDE knows it — connected (a connection id, with what was extracted), file (DDL, CSV or JSON brought in), or described (no access yet: say what it is). It replaces the previous draft; a person approves it as the source-assessment stage\'s document. Bring the systems\' metadata into the estate first (autode_ingest_metadata, autode_ingest_file).',
      inputSchema: { type: 'object', required: ['sources'], additionalProperties: false, properties: {
        sources: { type: 'array', minItems: 1, items: { type: 'object', required: ['connectionId', 'method'], properties: {
          connectionId: { type: 'string', minLength: 1 }, platform: { type: 'string' }, method: { type: 'string', enum: ['connected', 'described', 'file'] },
          sourceType: { type: 'string', enum: ['database', 'api', 'file', 'stream', 'saas', 'other'] }, description: { type: 'string' },
          connectionSummary: { type: 'object', properties: { database: { type: 'string' }, schema: { type: 'string' }, tableCount: { type: 'number' }, viewCount: { type: 'number' } } }
        } } },
        answers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Answers the stakeholder gave about the sources (question → answer).' },
        stage: { type: 'string', minLength: 1 }
      } },
      annotations: records('Draft the source context'),
      handler: async (args, ws) => {
        const { problemRoot } = problemOf(ws);
        const stage = stageFor(problemRoot, 'source-assessment', args.stage);
        let ctx;
        try { ctx = writeSourceContextDraft(problemRoot, args.sources as SourceContextEntry[], (args.answers as Record<string, string> | undefined) ?? {}); } catch (err) { throw new EngineToolError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err)); }
        note(ws, problemRoot, stage, sourceContextFile(problemRoot));
        return { sources: ctx.sources.length, version: ctx.version, status: ctx.status, file: path.relative(ws.options.workspaceRoot, sourceContextFile(problemRoot)).split(path.sep).join('/'), next: 'Tell the user the source context is ready for their approval.' };
      }
    }
  ];
}
