import { EngineTool } from './tools';
import { EngineToolError } from './errors';
import { EngineWorkspace } from './workspace';
import { PlatformSession } from './platform';
import { listProblems, setActiveProblem, startProblem } from '../engine/documents/problems';
import { ingestConnection, ingestFile, openContext } from '../engine/context/estateIngest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BusinessPackManager } from '../engine/context/businessPackManager';
import { DOCUMENT_ROLES, DocumentRole } from '../engine/context/pack';
import { buildVocabulary, mineAbbreviations, parseVocabularyFile } from '../engine/context/vocabulary';
import { conformanceFailures, packConformance, readPackDocument } from '../engine/context/packChecks';
import { ProbeDialect, ProbeExecutor, combineProbeExecutors, createSqlProbeExecutor } from '../engine/context/probes';
import { layoutPath } from '../engine/workspaceLayout';

/**
 * Business problems and the estate over MCP (parity step 1a, v0.43.2): what an
 * agent in another host needs to begin — list, start and select a business
 * problem; bring a file's or a connection's schema metadata in.
 *
 * These write, unlike the read tools, but nothing an agent decides: a new
 * problem is an unapproved draft holding the statement, the selection is this
 * engineer's local pointer, and ingestion records observed metadata (what the
 * source says). Inferred knowledge still goes through proposals (roadmap
 * decision log 2026-10-20).
 */

const recordsOnly = (title: string, idempotent: boolean, openWorld = false) => ({ title, readOnlyHint: false, destructiveHint: false, idempotentHint: idempotent, openWorldHint: openWorld });

export function workspaceTools(session: PlatformSession): EngineTool[] {
  /** The active problem's pack, over the shared context layer (dispose the context when done). */
  const pack = async (ws: EngineWorkspace) => {
    const root = ws.problemRoot();
    if (!root) throw new EngineToolError('NOT_FOUND', 'No active business problem: start or select one (autode_start_problem, autode_select_problem).');
    const cfm = await openContext(ws.options.workspaceRoot);
    const pm = new BusinessPackManager(path.join(root, 'pack'), ws.options.workspaceRoot, () => cfm, () => undefined);
    await pm.load();
    return { pm, cfm };
  };
  const dialectOf = (platform: string): ProbeDialect => platform === 'databricks' ? 'spark_sql' : platform === 'oracle' ? 'oracle' : platform === 'snowflake' ? 'snowflake' : 'ansi';

  return [
    {
      name: 'autode_pack_list',
      description: "The active business problem's pack: the documents that describe it (contracts, BRDs, KPI definitions, mappings, data dictionaries, samples), their authority and version.",
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { title: 'List the pack', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (_args, ws) => {
        const { pm, cfm } = await pack(ws);
        try { return { documents: pm.getPack().documents }; } finally { cfm.dispose(); }
      }
    },
    {
      name: 'autode_pack_add',
      description: "Add a workspace document to the active problem's pack as a DRAFT (its facts arrive as documented, for a person to confirm). Marking a document signed is a person's call: AutoDE panel or `autode pack add --authority signed`. Then read it in with autode_pack_apply.",
      inputSchema: { type: 'object', required: ['path', 'role', 'version'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1 }, role: { type: 'string', enum: DOCUMENT_ROLES }, version: { type: 'string', minLength: 1 }, table: { type: 'string', minLength: 1, description: 'For a sample: the object id of the table it samples.' } } },
      annotations: recordsOnly('Add a document to the pack', true),
      handler: async (args, ws) => {
        const file = ws.resolveInWorkspace(String(args.path));
        if (!fs.existsSync(file)) throw new EngineToolError('NOT_FOUND', `No file "${String(args.path)}".`);
        if (args.role === 'sample' && !args.table) throw new EngineToolError('VALIDATION_FAILED', 'A sample needs "table": the object id of the table it samples (autode_resolve).');
        const { pm, cfm } = await pack(ws);
        try { return { document: await pm.addDocument({ path: file, role: args.role as DocumentRole, authority: 'draft', version: String(args.version), table: args.table as string | undefined }) }; } finally { cfm.dispose(); }
      }
    },
    {
      name: 'autode_pack_apply',
      description: "Read pack documents into AutoDE's knowledge: structured ones (YAML/JSON) through their confirmed interpretation profile, deterministically. A document with no confirmed profile, or free text, is reported back: free text is read with your model through the autode_extract_assertions prompt and proposed with autode_propose_assertion.",
      inputSchema: { type: 'object', additionalProperties: false, properties: { ids: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Document ids (default: all).' } } },
      annotations: recordsOnly('Apply pack documents', true),
      handler: async (args, ws) => {
        const { pm, cfm } = await pack(ws);
        try {
          const wanted = args.ids as string[] | undefined;
          const docs = pm.getPack().documents.filter((d) => !wanted || wanted.includes(d.id));
          const results: Array<Record<string, unknown>> = [];
          for (const d of docs) results.push({ id: d.id, path: d.path, ...(await pm.applyDocument(d.id)) as unknown as Record<string, unknown> });
          return { results };
        } finally { cfm.dispose(); }
      }
    },
    {
      name: 'autode_check_conformance',
      description: "Check the source systems against the pack's contracts (those with a confirmed profile): names, types, keys and data clauses, using the catalog, the pack's samples and, with connectionId, read-only aggregate probes on live data. Returns the reports and the number of failing clauses; records nothing.",
      inputSchema: { type: 'object', additionalProperties: false, properties: { connectionId: { type: 'string', minLength: 1 } } },
      annotations: { title: 'Check conformance', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (args, ws) => {
        const { pm, cfm } = await pack(ws);
        try {
          let live: ProbeExecutor | undefined;
          if (args.connectionId) {
            const entry = session.entry(String(args.connectionId));
            const manager = await session.connect(entry);
            live = createSqlProbeExecutor(async (sql) => (await manager.executeQuery(sql, { maxRows: 10 })).rows as Array<Record<string, unknown>>, dialectOf(entry.platform));
          }
          const executor = combineProbeExecutors([live, pm.sampleExecutor()]);
          const r = await packConformance(pm.getPack(), pm.getProfiles(), (d) => readPackDocument(ws.options.workspaceRoot, d), cfm.getCatalog(), executor);
          return { failures: conformanceFailures(r.reports), reports: r.reports as unknown as Record<string, unknown>[], skipped: r.skipped, markdown: r.markdown };
        } finally { cfm.dispose(); }
      }
    },
    {
      name: 'autode_mine_vocabulary',
      description: "Abbreviations and synonyms mined from the estate's table and column names and comments, not yet in the vocabulary: candidates to show the user and propose with autode_propose_vocabulary. Records nothing.",
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { title: 'Mine vocabulary', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (_args, ws) => {
        const cfm = await openContext(ws.options.workspaceRoot);
        try {
          const file = layoutPath(ws.options.workspaceRoot, 'vocabulary');
          const vocab = buildVocabulary(parseVocabularyFile(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined));
          const items = cfm.getCatalog().all().flatMap((e) => [{ name: e.table.label, comment: e.table.description }, ...(e.columns ?? []).map((c) => ({ name: c.label, comment: c.description }))]);
          return { proposals: mineAbbreviations(items, vocab) as unknown as Record<string, unknown>[] };
        } finally { cfm.dispose(); }
      }
    },
    {
      name: 'autode_list_problems',
      description: 'List the business problems in this workspace (id, statement, status, which one is active).',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { title: 'List business problems', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (_args, ws) => ({ problems: listProblems(ws.options.workspaceRoot) })
    },
    {
      name: 'autode_start_problem',
      description: 'Start a business problem from its problem statement: a folder, a first DRAFT specification holding only the statement, made the active problem. Nothing is approved; refine it with autode_propose_spec_change (the interview prompts help) and a person approves it.',
      inputSchema: { type: 'object', required: ['problemStatement'], additionalProperties: false, properties: { problemStatement: { type: 'string', minLength: 10, description: 'What the business needs, in the user\'s words.' } } },
      annotations: recordsOnly('Start a business problem', false),
      handler: async (args, ws) => {
        const { id, spec } = startProblem(ws.options.workspaceRoot, String(args.problemStatement));
        return { id, specId: spec.id, status: spec.status, active: true, next: 'Interview the user (prompts autode_interview_*), then propose the specification with autode_propose_spec_change.' };
      }
    },
    {
      name: 'autode_select_problem',
      description: 'Make a business problem the active one (for this engineer; the AutoDE panel follows). The spec, context and proposal tools work on the active problem.',
      inputSchema: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', minLength: 1 } } },
      annotations: recordsOnly('Select the active business problem', true),
      handler: async (args, ws) => {
        const id = String(args.id);
        if (!listProblems(ws.options.workspaceRoot).some((p) => p.id === id)) throw new EngineToolError('NOT_FOUND', `No business problem "${id}" (see autode_list_problems).`);
        setActiveProblem(ws.options.workspaceRoot, id);
        return { id, active: true };
      }
    },
    {
      name: 'autode_ingest_file',
      description: 'Bring a DDL (.sql/.ddl), CSV or JSON file in the workspace into AutoDE\'s estate: its tables and columns go into the catalog and the working set, so resolve, context packs, grounding and conformance know them. Records only what the file says. Optionally bind it to an estate system.',
      inputSchema: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1, description: 'Workspace-relative path.' }, system: { type: 'string', minLength: 1, description: 'The estate system it describes (default: the existing binding, else a system named after the file).' }, environment: { type: 'string', minLength: 1 } } },
      annotations: recordsOnly('Ingest a schema file', true),
      handler: async (args, ws) => {
        const file = ws.resolveInWorkspace(String(args.path));
        const cfm = await openContext(ws.options.workspaceRoot);
        try {
          return { result: await ingestFile(cfm, file, { system: args.system as string | undefined, environment: args.environment as string | undefined }) as unknown as Record<string, unknown> };
        } catch (err) {
          if (err instanceof EngineToolError) throw err;
          throw new EngineToolError(/ENOENT/.test(String(err)) ? 'NOT_FOUND' : 'VALIDATION_FAILED', err instanceof Error ? err.message : String(err));
        } finally { cfm.dispose(); }
      }
    },
    {
      name: 'autode_ingest_metadata',
      description: 'Bring a connection\'s schemas into AutoDE\'s estate (read-only extraction of tables, columns, keys, views; with profile, sampled counts — row values only where the connection allows sample data). Records only what the platform says. Use autode_extract_metadata to just look without recording.',
      inputSchema: { type: 'object', required: ['connectionId', 'schemas'], additionalProperties: false, properties: { connectionId: { type: 'string', minLength: 1 }, schemas: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1 }, description: 'DATABASE.SCHEMA (or SCHEMA).' }, system: { type: 'string', minLength: 1 }, environment: { type: 'string', minLength: 1 }, profile: { type: 'boolean' } } },
      annotations: recordsOnly('Ingest a connection\'s metadata', true, true),
      handler: async (args, ws: EngineWorkspace) => {
        const entry = session.entry(String(args.connectionId));
        const manager = await session.connect(entry);
        const cfm = await openContext(ws.options.workspaceRoot);
        try {
          return { result: await ingestConnection(cfm, manager, entry.id, { schemas: args.schemas as string[], system: args.system as string | undefined, environment: args.environment as string | undefined, profile: args.profile === true }) as unknown as Record<string, unknown> };
        } finally { cfm.dispose(); }
      }
    }
  ];
}
