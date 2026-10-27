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
import { TARGET_OPTIONS, sourceSystemChoices, targetConnectionChoices, targetContextFile, writeTargetContextDraft } from '../engine/context/problemContexts';
import { readWorkflow } from '../engine/workflows/instance';
import { appendEvent, Actor } from '../engine/workflows/events';
import { EntityMapping, SourceContextEntry } from '../engine/types';
import { StageKind } from '../engine/workflows/stageKinds';
import { DataModel, checkModel, draftModel, problemMappings, renderModelDdl, targetSettings } from '../engine/agents/modelDraft';
import { primitiveCandidates, CandidateColumn } from '../engine/agents/primitiveCandidates';
import { reconcilePlan } from '../engine/agents/reconcilePlan';
import { targetPlatform } from '../engine/agents/assignment';
import { skillCatalog } from '../engine/agents/skillCatalog';
import * as port from '../engine/skills/port';
import { waitingForYou } from '../engine/approvals/waiting';
import { factView } from '../engine/context/factReview';
import { isMirror } from '../engine/context/projection';
import { listRunbooks, runLogFile, runnableProblem } from '../engine/runner/runbook';
import { loadRunbookPolicy } from '../engine/runner/policy';
import { verifyRunLog, readRunLog } from '../engine/runner/runLog';
import * as os from 'node:os';
import { PipelineEntity, PipelineSpec, CURRENT_PIPELINE_SPEC_VERSION } from '../engine/pipelineSpec/types';
import { validatePipelineSpec } from '../engine/pipelineSpec/validator';
import { validateTransformSpec } from '../engine/transforms/registry';
import { parseBusinessProblemSpec, parsePipelineSpecDocument, readProblemDocument, writePipelineSpec } from '../engine/documents/problemDocuments';

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
  const modelSchema = { type: 'object', required: ['entities'], properties: {
    approach: { type: 'string', enum: ['dimensional', 'data-vault', 'obt', '3nf', 'raw-pass-through'] }, naming: { type: 'string', enum: ['snake_case', 'camelCase', 'PascalCase'] },
    database: { type: 'string' }, schema: { type: 'string' },
    entities: { type: 'array', items: { type: 'object', required: ['name', 'kind', 'columns'], properties: {
      name: { type: 'string', minLength: 1 }, kind: { type: 'string' }, description: { type: 'string' }, scd: { enum: [1, 2] },
      grain: { type: 'array', items: { type: 'string' } }, primaryKey: { type: 'array', items: { type: 'string' } }, naturalKey: { type: 'array', items: { type: 'string' } },
      columns: { type: 'array', items: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 }, type: { type: 'string' }, nullable: { type: 'boolean' }, source: { type: 'string' }, transform: { type: 'string' }, description: { type: 'string' } } } },
      foreignKeys: { type: 'array', items: { type: 'object', required: ['columns', 'references'], properties: { columns: { type: 'array', items: { type: 'string' } }, references: { type: 'string' }, referencedColumns: { type: 'array', items: { type: 'string' } } } } },
      sources: { type: 'array', items: { type: 'string' } }
    } } }
  } };
  return [
    {
      name: 'autode_approvals_list',
      description: "Everything that waits for a person, in one list: pending decisions (workflow, stage gates, runbooks, connections, proposals), facts to review in the Context Inbox, stage documents to approve, runbooks that need a second approver. Each item says how a person approves it (the AutoDE panel, or the terminal command shown). You can't approve high-stakes items: tell the user what waits and how.",
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: read('Waiting for you'),
      handler: async (_args, ws) => {
        const src = await ws.contextSources();
        const byId = new Map(src.assertions.map((a) => [a.id, a] as const));
        const facts = src.assertions.filter((a) => !isMirror(a) && (a.status === 'proposed' || a.status === 'needs_review')).map((a) => factView(a, byId));
        return { items: waitingForYou({ workspaceRoot: ws.options.workspaceRoot, resourcesRoot: ws.options.resourcesRoot, problemId: ws.activeProblemId(), facts }) } as unknown as Record<string, unknown>;
      }
    },
    {
      name: 'autode_runbook_status',
      description: "The active problem's approved runbooks and how far they have run: each step's engine classification and state, the approvals, whether it may run now (and why not), and whether its run log is intact. Runbooks run only in AutoDE's runner, started by a person; propose new ones with autode_propose_runbook.",
      inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1 } } },
      annotations: read('Runbook status'),
      handler: async (args, ws) => {
        const { problemRoot } = problemOf(ws);
        const policy = loadRunbookPolicy(ws.options.workspaceRoot);
        const runbooks = listRunbooks(problemRoot).filter((r) => !args.id || r.runbook.id === args.id).map((r) => ({
          id: r.runbook.id, title: r.runbook.title, connectionId: r.runbook.connectionId, environment: r.environment, stage: r.runbook.stage, status: r.status,
          approvals: r.approvals.map((a) => ({ by: a.by, at: a.at, channel: a.channel })), runnable: !runnableProblem(r, policy), whyNot: runnableProblem(r, policy),
          steps: r.runbook.steps.map((s) => ({ id: s.id, title: s.title, kind: s.kind, state: r.steps[s.id]?.state ?? 'pending' })),
          log: { ...verifyRunLog(runLogFile(problemRoot, r.runbook.id)), last: readRunLog(runLogFile(problemRoot, r.runbook.id)).slice(-1)[0]?.at }
        }));
        return { runbooks } as unknown as Record<string, unknown>;
      }
    },
    {
      name: 'autode_skills_list',
      description: "AutoDE's skill catalog: its own skills (autode-<scope>-<capability>, with the stage kinds and platforms each serves and the roles that use it), this workspace's imported skills with their review state, the interview packs, and the vendor and community skills AutoDE works with (references only: licence, source, availability, and whether each is installed in this machine's host skills folders). Installing an external skill is a person's act (`autode skills install` in a terminal, or the AutoDE Skills view).",
      inputSchema: { type: 'object', additionalProperties: false, properties: { group: { type: 'string', enum: ['autode', 'workspace', 'interview', 'external'] } } },
      annotations: read('Skill catalog'),
      handler: async (args, ws) => {
        const r = skillCatalog({ resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot, home: process.env.AUTODE_HOME ?? os.homedir() });
        return { skills: r.entries.filter((e) => !args.group || e.group === args.group), errors: r.errors } as unknown as Record<string, unknown>;
      }
    },
    {
      name: 'autode_skills_analyze',
      description: "Port a skill, first step: what a skill in a Git repository (https) or a workspace folder would do in AutoDE — knowledge (guidance that joins context packs) or procedure (carried out with tools), the tools it declares and how they map to AutoDE's, the CLIs and MCP servers it needs, its scripts, licence, overlaps with existing skills, and a capability report. Nothing is copied into the workspace. Several skills in one source are listed; pass `skill` (a path from that list) to analyse one. Importing, reviewing and publishing are a person's acts (`autode skills import|review|publish` in a terminal, or Port a Skill in VS Code).",
      inputSchema: { type: 'object', required: ['source'], additionalProperties: false, properties: {
        source: { type: 'string', minLength: 1, description: 'An https Git URL, or a folder relative to the workspace.' },
        ref: { type: 'string', minLength: 1, description: 'Branch or tag (Git only).' },
        skill: { type: 'string', description: 'The skill\'s path inside the source, when it has several.' }
      } },
      annotations: { ...read('Analyze a skill'), openWorldHint: true },
      handler: async (args, ws) => {
        const src = String(args.source);
        const git = /^https:\/\//.test(src);
        if (!git && /^[a-z]+:\/\/|^git@/i.test(src)) throw new EngineToolError('VALIDATION_FAILED', 'Over MCP a Git source is an https URL; use the CLI for SSH.');
        const location = git ? src : ws.resolveInWorkspace(src);
        let run: port.PortRun;
        try { run = port.portSource({ kind: git ? 'git' : 'local', location, ref: args.ref as string | undefined }, { resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot, subpath: args.skill as string | undefined }); }
        catch (err) { if (err instanceof port.PortError) throw new EngineToolError('VALIDATION_FAILED', err.message); throw err; }
        try {
          const provenance = git ? run.staged.provenance : { ...run.staged.provenance, location: src };
          return (run.analysis
            ? { analysis: { ...run.analysis }, report: run.report, provenance, next: run.analysis.problems.length ? 'It can\'t be imported (see problems).' : 'A person imports it: `autode skills import` in a terminal, or Port a Skill in VS Code.' }
            : { skills: run.skills, next: 'Several skills: call again with `skill` set to one of their paths.' }) as unknown as Record<string, unknown>;
        } finally { run.staged.cleanup(); }
      }
    },
    {
      name: 'autode_primitive_candidates',
      description: "The transform steps a source table needs on its way to a target, as AutoDE primitives with their parameters filled in from what AutoDE knows: a staging projection that renames and casts the mapped columns (rename_cast), deduplication on the key fact keeping the latest row by the change column (dedup), and an incremental MERGE on the key (incremental_load). Each step has its reasons and is validated against the primitive's schema; what no primitive covers (column expressions, a missing key or change column) comes back as notes. Columns default to the problem's mapping for that source, else every source column as is.",
      inputSchema: { type: 'object', required: ['source'], additionalProperties: false, properties: {
        source: { type: 'string', minLength: 1 }, target: { type: 'string', minLength: 1, description: 'The target object (default: the mapping\'s target, else the source table\'s name).' },
        columns: { type: 'array', items: { type: 'object', required: ['source', 'target'], additionalProperties: false, properties: { source: { type: 'string', minLength: 1 }, target: { type: 'string', minLength: 1 }, type: { type: 'string' }, transform: { type: 'string' } } } }
      } },
      annotations: read('Primitive candidates'),
      handler: async (args, ws) => {
        ws.ensurePrimitives();
        const { problemRoot } = problemOf(ws);
        const src = await ws.contextSources();
        const index = buildSchemaIndex(src.graph.nodes, src.graph.edges);
        let columns = args.columns as CandidateColumn[] | undefined;
        let target = args.target as string | undefined;
        if (!columns?.length) {
          const s = String(args.source).toLowerCase();
          const maps = problemMappings(problemRoot).filter((m) => (m.sourceFqn || m.sourceEntityId).toLowerCase() === s && (!target || m.targetName.toLowerCase() === target.toLowerCase()));
          if (maps.length) { target = target ?? maps[0].targetName; columns = maps.filter((m) => m.targetName === target).flatMap((m) => m.columns.map((c) => ({ source: c.sourceColumn, target: c.targetColumn, transform: c.transformExpression }))); }
        }
        try {
          return primitiveCandidates({ source: String(args.source), target, columns, schemaIndex: index, assertions: src.assertions, nodes: src.graph.nodes }) as unknown as Record<string, unknown>;
        } catch (err) { throw new EngineToolError('NOT_FOUND', err instanceof Error ? err.message : String(err)); }
      }
    },
    {
      name: 'autode_record_pipeline_spec',
      description: "Draft the active problem's Pipeline Spec: the entities, each with its source, its transform steps (primitives with parameters, as autode_primitive_candidates gives them) and its target. AutoDE fills in the identity and lineage (the specification it derives from), validates the spec and every step against its primitive, archives an approved previous revision, and writes it as a draft. A person approves it as the build stage's document; then autode_compile_pipeline_spec gives the code. Replaces the previous draft.",
      inputSchema: { type: 'object', required: ['entities'], additionalProperties: false, properties: {
        entities: { type: 'array', minItems: 1, items: { type: 'object', required: ['name', 'source', 'transforms', 'target'] } },
        targetPlatform: { type: 'string', minLength: 1 },
        stage: { type: 'string', minLength: 1 }
      } },
      annotations: records('Draft the Pipeline Spec'),
      handler: async (args, ws) => {
        ws.ensurePrimitives();
        const { problemId, problemRoot } = problemOf(ws);
        const specText = readProblemDocument(problemRoot, 'spec');
        if (!specText) throw new EngineToolError('NOT_FOUND', 'The problem has no specification yet.');
        const bps = parseBusinessProblemSpec(specText);
        const prevText = readProblemDocument(problemRoot, 'pipelineSpec');
        const prev = prevText ? parsePipelineSpecDocument(prevText) : undefined;
        const now = new Date().toISOString();
        // Steps carry only kind, params and version in the spec (candidates also carry their reasons).
        const entities = (args.entities as PipelineEntity[]).map((e) => ({ ...e, transforms: (e.transforms ?? []).map((t) => ({ kind: t.kind, params: t.params, ...(t.primitiveVersion !== undefined ? { primitiveVersion: t.primitiveVersion } : {}) })) }));
        const spec: PipelineSpec = {
          specVersion: CURRENT_PIPELINE_SPEC_VERSION, id: prev?.id ?? `ps-${problemId}`,
          version: prev ? (prev.status === 'approved' ? prev.version + 1 : prev.version) : 1, status: 'draft',
          derivedFromBpsId: bps.id, derivedFromBpsVersion: bps.version,
          targetPlatform: (args.targetPlatform as string | undefined) ?? prev?.targetPlatform ?? 'snowflake',
          entities, createdAt: prev?.createdAt ?? now, updatedAt: now
        };
        const errors = [...validatePipelineSpec(spec).errors];
        for (const e of entities) for (const [i, t] of e.transforms.entries()) { const v = validateTransformSpec({ kind: t.kind, params: t.params, primitiveVersion: t.primitiveVersion }); if (!v.valid) errors.push(...v.errors.map((x) => `${e.name} step ${i + 1} (${t.kind}): ${x}`)); }
        if (errors.length) throw new EngineToolError('VALIDATION_FAILED', `The Pipeline Spec isn't valid: ${errors.join(' ')}`, { errors });
        writePipelineSpec(problemRoot, spec);
        const file = problemDocumentPath(problemRoot, 'pipelineSpec');
        note(ws, problemRoot, stageFor(problemRoot, 'build', args.stage), file);
        return { id: spec.id, version: spec.version, status: spec.status, entities: entities.length, file: path.relative(ws.options.workspaceRoot, file).split(path.sep).join('/'), next: 'Compile it with autode_compile_pipeline_spec and record the files with autode_record_artifact; then tell the user the Pipeline Spec is ready for their approval.' };
      }
    },
    {
      name: 'autode_draft_model',
      description: "A first draft of the target data model, deterministic: the mapping's target entities and columns, the source columns' types, grain, keys and foreign keys from the key, grain and relationship facts (confirmed or proposed, each with where it came from), the kind from the name (fct_, dim_, hub_ …), surrogate keys for dimensions in a dimensional model, and the target context's approach and naming. What isn't known comes back as gaps. Refine it, then check it with autode_check_model.",
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: read('Draft the data model'),
      handler: async (_args, ws) => {
        const { problemRoot } = problemOf(ws);
        const src = await ws.contextSources();
        const r = draftModel({ mappings: problemMappings(problemRoot), schemaIndex: buildSchemaIndex(src.graph.nodes, src.graph.edges), assertions: src.assertions, nodes: src.graph.nodes, ...targetSettings(problemRoot) });
        return r as unknown as Record<string, unknown>;
      }
    },
    {
      name: 'autode_check_model',
      description: "Check a data model (as autode_draft_model returns it, refined): every entity has a grain and a primary key made of its own columns, foreign keys reference entities and columns in the model with matching arity, no duplicates, every mapped target column is in the model, naming follows the convention. Returns errors (fix them), warnings (tell the reviewer), and the DDL AutoDE renders from the model — record that, never hand-written DDL.",
      inputSchema: { type: 'object', required: ['model'], additionalProperties: false, properties: { model: modelSchema } },
      annotations: read('Check the data model'),
      handler: async (args, ws) => {
        const { problemRoot } = problemOf(ws);
        const model = { approach: 'dimensional', naming: 'snake_case', ...(args.model as object) } as DataModel;
        model.entities = model.entities.map((e) => ({ ...e, columns: e.columns ?? [], foreignKeys: e.foreignKeys ?? [], sources: e.sources ?? [] }));
        const r = checkModel(model, { mappings: problemMappings(problemRoot) });
        return { ...r, ddl: renderModelDdl(model) };
      }
    },
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
      name: 'autode_reconcile_plan',
      description: 'Read-only reconciliation queries for a source table and its target, generated by AutoDE (never hand-written): per side one aggregate query (row count, distinct keys, key nulls, and per mapped column a sum, min/max, distinct count and null count by type), the comparisons to make between their results, a key hash when both sides are on the same platform, and missing-key counts when both tables are on one connection. Columns come from the problem\'s mapping (or same-named columns). Runs nothing: run each query with autode_execute_query on its side.',
      inputSchema: { type: 'object', required: ['source', 'target', 'keys'], additionalProperties: false, properties: {
        source: { type: 'string', minLength: 1, description: 'Source table in the estate.' },
        target: { type: 'string', minLength: 1, description: 'Target table in the estate (after deployment, ingested from the target connection).' },
        keys: { type: 'array', minItems: 1, items: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'object', required: ['source', 'target'], additionalProperties: false, properties: { source: { type: 'string', minLength: 1 }, target: { type: 'string', minLength: 1 } } }] }, description: 'The key: target column names (their source columns come from the mapping), or {source, target} pairs.' },
        sourcePlatform: { type: 'string', description: 'snowflake, databricks, or the source\'s platform; decides the SQL functions used.' },
        targetPlatform: { type: 'string', description: 'Default: the target context\'s platform.' },
        sourceWhere: { type: 'string', description: 'A filter for the source side (for example the load window).' },
        targetWhere: { type: 'string' },
        sameConnection: { type: 'boolean', description: 'Both tables are reachable through one connection: adds missing-key counts.' }
      } },
      annotations: read('Plan a reconciliation'),
      handler: async (args, ws) => {
        const src = await ws.contextSources();
        const index = buildSchemaIndex(src.graph.nodes, src.graph.edges);
        const s = findTable(index, String(args.source));
        if (!s) throw new EngineToolError('NOT_FOUND', `Source table ${String(args.source)} is not in the estate AutoDE knows.`);
        const t = findTable(index, String(args.target));
        if (!t) throw new EngineToolError('NOT_FOUND', `Target table ${String(args.target)} is not in the estate: after deployment, bring the target's metadata in (autode_ingest_metadata on the target connection).`);
        const problemId = ws.activeProblemId();
        const problemRoot = problemId ? layoutPath(ws.options.workspaceRoot, 'problems', problemId) : undefined;
        const last = (x: string) => x.toLowerCase().split('.').pop();
        const mapping = problemRoot ? problemMappings(problemRoot).find((m) => last(m.sourceFqn ?? '') === last(s.fqn) && last(m.targetName) === last(t.fqn)) : undefined;
        const pairs = mapping
          ? mapping.columns.map((c) => ({ source: c.sourceColumn, target: c.targetColumn }))
          : [...s.columns.keys()].filter((c) => t.columns.has(c)).map((c) => ({ source: c, target: c }));
        const keys = (args.keys as Array<string | { source: string; target: string }>).map((k) => typeof k === 'string'
          ? { source: pairs.find((p) => p.target.toLowerCase() === k.toLowerCase())?.source ?? k, target: k }
          : k);
        const cols = (x: typeof s) => [...x.columns.entries()].map(([name, type]) => ({ name, type }));
        const r = reconcilePlan({
          source: { table: s.fqn, platform: (args.sourcePlatform as string | undefined)?.toLowerCase(), columns: cols(s), where: args.sourceWhere as string | undefined },
          target: { table: t.fqn, platform: ((args.targetPlatform as string | undefined) ?? (problemRoot ? targetPlatform(problemRoot) : undefined))?.toLowerCase(), columns: cols(t), where: args.targetWhere as string | undefined },
          keys, columns: pairs, sameConnection: args.sameConnection === true
        });
        if (!r.plan) throw new EngineToolError('VALIDATION_FAILED', r.errors.join(' '));
        return { source: s.fqn, target: t.fqn, mapping: mapping?.id ?? null, ...r.plan } as unknown as Record<string, unknown>;
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
      name: 'autode_record_target_context',
      description: 'Draft the active problem\'s target context (v0.45.10): the workspace target connection it builds into (which decides the platform and the default database), and the problem\'s own decisions — modelling approach, transformation and orchestration tools, naming convention, target database and schema. Without a connection, give the platform. With no arguments, returns the choices: the workspace\'s target connections, the allowed values, and the estate\'s source systems. Written as built; a person approves it as the target stage\'s document.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        connectionId: { type: 'string', minLength: 1 }, platform: { type: 'string', enum: [...TARGET_OPTIONS.platform] },
        modelingApproach: { type: 'string', enum: [...TARGET_OPTIONS.modelingApproach] }, transformationTool: { type: 'string', enum: [...TARGET_OPTIONS.transformationTool] },
        orchestrationTool: { type: 'string', enum: [...TARGET_OPTIONS.orchestrationTool] }, namingConvention: { type: 'string', enum: [...TARGET_OPTIONS.namingConvention] },
        database: { type: 'string' }, schema: { type: 'string' },
        answers: { type: 'object', additionalProperties: { type: 'string' }, description: 'What the stakeholder said (question → answer).' },
        stage: { type: 'string', minLength: 1 }
      } },
      annotations: records('Draft the target context'),
      handler: async (args, ws) => {
        const root = ws.options.workspaceRoot;
        const choices = ['connectionId', 'platform', 'modelingApproach', 'transformationTool', 'orchestrationTool', 'namingConvention', 'database', 'schema'];
        if (!choices.some((k) => args[k] !== undefined)) return { connections: targetConnectionChoices(root), options: TARGET_OPTIONS, sourceSystems: sourceSystemChoices(root) };
        const { problemRoot } = problemOf(ws);
        const stage = stageFor(problemRoot, 'target-context', args.stage);
        let ctx;
        try { ctx = writeTargetContextDraft(root, problemRoot, args as Record<string, string>, (args.answers as Record<string, string> | undefined) ?? {}); } catch (err) { throw new EngineToolError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err)); }
        note(ws, problemRoot, stage, targetContextFile(problemRoot));
        return { platform: ctx.platform, connectionId: ctx.connectionId ?? null, version: ctx.version, status: ctx.status, file: path.relative(root, targetContextFile(problemRoot)).split(path.sep).join('/'), next: 'Tell the user the target context is ready for their approval (the Workflow view, or `autode workflow approve <stage>`).' };
      }
    },
    {
      name: 'autode_record_source_context',
      description: 'Draft the active problem\'s source context: each source system the problem draws on, and how AutoDE knows it — connected (a connection id, with what was extracted), file (DDL, CSV or JSON brought in), or described (no access yet: say what it is). It replaces the previous draft; a person approves it as the source-assessment stage\'s document. Bring the systems\' metadata into the estate first (autode_ingest_metadata, autode_ingest_file).',
      inputSchema: { type: 'object', required: ['sources'], additionalProperties: false, properties: {
        sources: { type: 'array', minItems: 1, items: { type: 'object', required: ['connectionId', 'method'], properties: {
          system: { type: 'string', description: 'The estate system (from the estate); required for connected and file sources, absent for a described one.' },
          connectionId: { type: 'string', minLength: 1 }, platform: { type: 'string' }, method: { type: 'string', enum: ['connected', 'described', 'file'] },
          sourceType: { type: 'string', enum: ['database', 'api', 'file', 'stream', 'saas', 'other'] }, description: { type: 'string' }
        } } },
        answers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Answers the stakeholder gave about the sources (question → answer).' },
        stage: { type: 'string', minLength: 1 }
      } },
      annotations: records('Draft the source context'),
      handler: async (args, ws) => {
        const { problemRoot } = problemOf(ws);
        const stage = stageFor(problemRoot, 'source-assessment', args.stage);
        let ctx;
        try { ctx = writeSourceContextDraft(problemRoot, args.sources as SourceContextEntry[], (args.answers as Record<string, string> | undefined) ?? {}, new Date(), ws.options.workspaceRoot); } catch (err) { throw new EngineToolError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err)); }
        note(ws, problemRoot, stage, sourceContextFile(problemRoot));
        return { sources: ctx.sources.length, version: ctx.version, status: ctx.status, file: path.relative(ws.options.workspaceRoot, sourceContextFile(problemRoot)).split(path.sep).join('/'), next: 'Tell the user the source context is ready for their approval.' };
      }
    }
  ];
}
