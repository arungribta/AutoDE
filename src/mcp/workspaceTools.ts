import { EngineTool } from './tools';
import { EngineToolError } from './errors';
import { EngineWorkspace } from './workspace';
import { PlatformSession } from './platform';
import { listProblems, setActiveProblem, startProblem } from '../engine/documents/problems';
import { ingestConnection, ingestFile, openContext } from '../engine/context/estateIngest';
import { findSourceFiles } from '../engine/context/sourceFiles';
import { recordLineageBatch } from '../engine/lineage/record';
import { problemOverlap } from '../engine/documents/problemOverlap';
import type { ObservedEdge } from '../engine/lineage/observed';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BusinessPackManager } from '../engine/context/businessPackManager';
import { DOCUMENT_ROLES, DocumentRole } from '../engine/context/pack';
import { buildVocabulary, mineAbbreviations, parseVocabularyFile } from '../engine/context/vocabulary';
import { conformanceFailures, packConformance, readPackDocument } from '../engine/context/packChecks';
import { ProbeDialect, ProbeExecutor, combineProbeExecutors, createSqlProbeExecutor } from '../engine/context/probes';
import { fragmentsFor } from '../engine/platform/dialects';
import { layoutPath } from '../engine/workspaceLayout';
import { CatalogEntry, CatalogFetcher } from '../engine/context/catalog';
import { ContextFileManager } from '../engine/context/contextFileManager';
import { BaseNode, GraphEdge } from '../engine/context/types';
import { loadConnectionsConfig } from '../engine/platform/connectionsConfig';
import { AnswerInput, QuestionInput, isOpenInterview, readInterview, recordInterview, startInterview, summarizeInterview, writeInterview } from '../engine/interview/state';

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
  const dialectOf = (platform: string): ProbeDialect => fragmentsFor(platform);

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
      description: "Read pack documents into AutoDE's knowledge: structured ones (YAML/JSON) through their confirmed interpretation profile, deterministically. A document with no confirmed profile, or free text, is reported back: free text, and structured documents with no confirmed profile, are read with your model through autode_pack_reading and autode_pack_record_reading.",
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
      name: 'autode_pack_reading',
      description: "What reading a pack document needs from your model (the same prompts the AutoDE panel sends its LLM): for free text, its sections (cite them by id) and the extraction prompt; for a structured document no confirmed profile reads, the prompt to propose a reading profile; otherwise why nothing is needed. Answer it with your model and record the answer with autode_pack_record_reading.",
      inputSchema: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', minLength: 1, description: 'The pack document id (autode_pack_list).' }, sections: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Only these section ids: the ones autode_pack_record_reading asked to read again.' } } },
      annotations: { title: 'What reading a document needs', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args, ws) => {
        const { pm, cfm } = await pack(ws);
        try {
          const r = pm.readingFor(String(args.id), args.sections as string[] | undefined);
          const next = r.kind === 'facts' ? 'Read the document with this prompt and record the JSON { "facts": [...], "sections": [...] } with autode_pack_record_reading (facts, sections, sha, model). Each fact quotes its section word for word.'
            : r.kind === 'profile' ? 'Propose a profile with this prompt and record the JSON with autode_pack_record_reading (profile). A person confirms it; then autode_pack_apply reads the document.'
              : r.reason;
          return { ...r, next } as unknown as Record<string, unknown>;
        } finally { cfm.dispose(); }
      }
    },
    {
      name: 'autode_pack_record_reading',
      description: "Record what your model read from a pack document (as autode_pack_reading asked): facts from free text (each citing a section id the document has; recorded as proposed facts for a person to confirm, duplicates skipped, invalid ones reported as dropped), or a proposed reading profile for a structured document (written for review: a person sets status: confirmed). Pass the sha you were given, so a document changed since is read again.",
      inputSchema: { type: 'object', required: ['id'], additionalProperties: false, properties: {
        id: { type: 'string', minLength: 1 },
        facts: { type: 'array', items: { type: 'object' }, description: 'The facts, as the extraction prompt specifies (each with its verbatim quote).' },
        sections: { type: 'array', items: { type: 'object' }, description: 'Your report on every section: { section, facts } (C4c: a section left out is read again).' },
        reread: { type: 'array', items: { type: 'string' }, description: 'When this records a re-read: the section ids that were read again.' },
        model: { type: 'string', description: 'The model that read it (recorded on each fact).' },
        sha: { type: 'string', description: 'The document version autode_pack_reading returned.' },
        profile: { type: 'object', description: 'The proposed profile, as the profile prompt specifies.' }
      } },
      annotations: recordsOnly('Record a document reading', true),
      handler: async (args, ws) => {
        if (!!args.facts === !!args.profile) throw new EngineToolError('VALIDATION_FAILED', 'Give facts (free text) or profile (structured), not both.');
        const { pm, cfm } = await pack(ws);
        try {
          const r = args.facts ? await pm.recordFacts(String(args.id), { facts: args.facts, sections: args.sections ?? [] }, args.sha as string | undefined, { model: args.model as string | undefined, sections: args.reread as string[] | undefined }) : await pm.recordProfile(String(args.id), args.profile);
          if (r.status === 'error') throw new EngineToolError('VALIDATION_FAILED', r.reason);
          const reread = r.status === 'extracted' && r.reread?.length && !(args.reread as string[] | undefined)?.length ? ` Sections you didn't account for: read them again (autode_pack_reading with sections ${JSON.stringify(r.reread)}), then record that reading with reread set to them.` : '';
          return { ...r, next: r.status === 'extracted' ? `A person confirms the facts in the AutoDE Context Inbox (or autode facts). Tell the user.${reread}` : 'A person reviews the profile and sets status: confirmed; then autode_pack_apply reads the document.' } as unknown as Record<string, unknown>;
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
      description: 'Start a business problem from its problem statement: a folder, a first DRAFT specification holding only the statement, made the active problem. Nothing is approved; refine it with autode_propose_spec_change (the interview prompts help) and a person approves it. Knowledge is shared per workspace: overlap says which systems, tables, terms and semantic models the statement names here, or noMatch when the workspace holds knowledge and none of it matches (then tell the user: a different estate belongs in its own workspace folder).',
      inputSchema: { type: 'object', required: ['problemStatement'], additionalProperties: false, properties: { problemStatement: { type: 'string', minLength: 10, description: 'What the business needs, in the user\'s words.' } } },
      annotations: recordsOnly('Start a business problem', false),
      handler: async (args, ws) => {
        const { id, spec } = startProblem(ws.options.workspaceRoot, String(args.problemStatement));
        // v0.45.12: the interview starts with the problem, on disk, so any surface continues it.
        startInterview(layoutPath(ws.options.workspaceRoot, 'problems', id), spec.problemStatement, ws.interviewSkills());
        const overlap = problemOverlap(ws.options.workspaceRoot, spec.problemStatement, await ws.contextSources());
        return { id, specId: spec.id, status: spec.status, active: true, overlap, next: 'Interview the user: autode_interview_state shows what is open; record each question and answer with autode_interview_record_answer (the interview skills, or prompts autode_interview_*, say what to ask). Then propose the specification with autode_propose_spec_change.' };
      }
    },
    {
      name: 'autode_refresh_working_set',
      description: "Before you start a stage: refresh the tables AutoDE is working with that are past their refresh age, from the named connections their estate systems are bound to (read-only metadata; a table no longer visible is marked so, never deleted). The AutoDE panel does this itself before Run agent. Returns how many were checked and fetched; a source that can't be reached is reported, and the stage can still go ahead.",
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: recordsOnly('Refresh the working set', true, true),
      handler: async (_args, ws) => {
        const cfm = await openContext(ws.options.workspaceRoot);
        try {
          const { fetcher, unreachable } = estateFetcher(session, cfm, ws.options.workspaceRoot);
          cfm.setCatalogFetcher(fetcher);
          const r = await cfm.refreshWorkingSet();
          return { ...r, unreachable, next: r.fetched ? 'Refreshed: start the stage.' : 'Nothing was out of date (or no bound connection could answer): start the stage.' };
        } finally { cfm.dispose(); }
      }
    },
    {
      name: 'autode_interview_state',
      description: 'The active problem\'s requirements interview, as any surface left it (the AutoDE panel, a terminal, another host): the parts covered and not, the open questions, every answer with who gave it and where, the attachments, and the specification it fed. Continue it; don\'t ask again what is answered.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { title: 'Show the interview', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (_args, ws) => {
        const root = ws.problemRoot();
        if (!root) throw new EngineToolError('NOT_FOUND', 'No active business problem: start or select one (autode_start_problem, autode_select_problem).');
        const s = readInterview(root, ws.options.workspaceRoot);
        if (!s) return { status: 'none', next: 'No interview yet: autode_interview_record_answer starts one from the problem statement.' };
        const summary = summarizeInterview(s, ws.interviewSkills());
        const next = summary.status === 'done' ? `It fed specification ${s.feeds?.specId} v${s.feeds?.version}; a new interview starts with a revision.`
          : summary.open.length ? 'Ask the open questions (or answer them from what the user already said), and record the answers.'
            : summary.parts.some((p) => p.status !== 'addressed') ? 'Ask about the parts not yet addressed, recording each question before you ask it.'
              : 'The parts are covered: write the specification (autode-de-specification-authoring) and propose it.';
        return { ...summary, next } as unknown as Record<string, unknown>;
      }
    },
    {
      name: 'autode_interview_record_answer',
      description: 'Record questions you ask and the user\'s answers in the active problem\'s requirements interview, so the AutoDE panel, a terminal or another host continues from here. A question names the specification field it fills; an answer names its question (id) or field and holds the user\'s own words (your reading of them goes in the question\'s rationale). Answers are the user\'s statements: no approval is needed. Starts the interview from the problem statement if there is none.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        questions: { type: 'array', items: { type: 'object', required: ['field', 'prompt'], additionalProperties: false, properties: { field: { type: 'string', minLength: 1 }, prompt: { type: 'string', minLength: 1 }, kind: { type: 'string', enum: ['text', 'single-select', 'multi-select', 'boolean'] }, options: { type: 'array', items: { type: 'string' } }, rationale: { type: 'string' }, skill: { type: 'string' } } } },
        answers: { type: 'array', items: { type: 'object', required: ['value'], additionalProperties: false, properties: { questionId: { type: 'string' }, field: { type: 'string' }, prompt: { type: 'string', description: 'The question, when it wasn\'t recorded before.' }, value: { type: 'string', minLength: 1 } } } }
      } },
      annotations: recordsOnly('Record interview answers', false),
      handler: async (args, ws) => {
        const root = ws.problemRoot();
        const id = ws.activeProblemId();
        if (!root || !id) throw new EngineToolError('NOT_FOUND', 'No active business problem: start or select one (autode_start_problem, autode_select_problem).');
        const questions = (args.questions ?? []) as QuestionInput[];
        const answers = (args.answers ?? []) as AnswerInput[];
        if (!questions.length && !answers.length) throw new EngineToolError('VALIDATION_FAILED', 'Give questions, answers or both.');
        const skills = ws.interviewSkills();
        let s = readInterview(root, ws.options.workspaceRoot);
        if (s && !isOpenInterview(s)) throw new EngineToolError('VALIDATION_FAILED', `The interview already fed specification ${s.feeds?.specId ?? ''} v${s.feeds?.version ?? ''}. Change the specification with autode_propose_spec_change.`);
        if (!s) s = startInterview(root, listProblems(ws.options.workspaceRoot).find((p) => p.id === id)?.problemStatement ?? id, skills);
        const r = recordInterview(s, { questions, answers }, { by: 'user (via MCP)', channel: 'mcp' });
        if (!r.asked.length && !r.answered.length) throw new EngineToolError('VALIDATION_FAILED', r.errors.join(' '));
        writeInterview(root, r.session);
        const summary = summarizeInterview(r.session, skills);
        return { asked: r.asked, answered: r.answered, errors: r.errors, open: summary.open, parts: summary.parts };
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
      name: 'autode_find_source_files',
      description: 'The source material shared as files in the workspace: DDL files (with how many tables and which schemas), data files (CSV, JSON) and load scripts (COPY INTO, INSERT, read_csv …), each with the estate system it suggests and whether it is in the estate already. Ingest DDL and data files with autode_ingest_file (system: the suggested one unless the stakeholder says otherwise); read load scripts for what is loaded and from where.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { title: 'Find source files', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (_args, ws) => {
        const files = findSourceFiles(ws.options.workspaceRoot);
        return { files, next: files.some((f) => f.kind !== 'load-script' && !f.ingested) ? 'Ingest each DDL or data file not yet in the estate with autode_ingest_file.' : files.length ? 'Every DDL and data file is in the estate.' : 'No source files in the workspace: ask the stakeholder for them, or for access to the systems.' };
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
    },
    {
      name: 'autode_record_observed_lineage',
      description: 'Record lineage edges observed on a platform for a connection (from its lineage API, OpenLineage events, a scheduler\'s run graph, or rows you were given): each upstream object (and column) with its downstream object (and column), or the job, notebook or report (entity) that read it. Names are fully qualified as the platform gives them; AutoDE resolves them in the connection\'s estate system and environment. Recorded as verified lineage facts under the method you name. Set complete only when the read covered everything for the databases named: edges of that method not in it are then retired.',
      inputSchema: {
        type: 'object', required: ['connectionId', 'method', 'edges'], additionalProperties: false,
        properties: {
          connectionId: { type: 'string', minLength: 1 },
          method: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', description: 'Where the edges came from, e.g. openlineage, lineage_api.' },
          complete: { type: 'boolean', description: 'Default false (nothing is retired).' },
          databases: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z0-9_$-]+$' } },
          edges: {
            type: 'array', minItems: 1, maxItems: 20000,
            items: {
              type: 'object', required: ['upstream'], additionalProperties: false,
              properties: {
                upstream: { type: 'object', required: ['object'], additionalProperties: false, properties: { object: { type: 'string', minLength: 1 }, column: { type: 'string' } } },
                downstream: { type: 'object', required: ['object'], additionalProperties: false, properties: { object: { type: 'string', minLength: 1 }, column: { type: 'string' } } },
                entity: { type: 'object', required: ['type', 'id'], additionalProperties: false, properties: { type: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' } } }
              }
            }
          }
        }
      },
      annotations: recordsOnly('Record observed lineage', true),
      handler: async (args, ws: EngineWorkspace) => {
        const entry = session.entry(String(args.connectionId));
        const cfm = await openContext(ws.options.workspaceRoot);
        try {
          const edges = args.edges as ObservedEdge[];
          if (edges.some((e) => !e.downstream && !e.entity)) throw new EngineToolError('VALIDATION_FAILED', 'Each edge needs a downstream object or the entity that read the upstream one.');
          return { result: await recordLineageBatch(cfm, { connectionId: entry.id, method: String(args.method), complete: args.complete === true, edges, ...(args.databases ? { databases: args.databases as string[] } : {}) }, 'mcp') as unknown as Record<string, unknown> };
        } catch (err) {
          if (err instanceof EngineToolError) throw err;
          throw new EngineToolError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err));
        } finally { cfm.dispose(); }
      }
    }
  ];
}

/**
 * A catalog fetcher over the workspace's named connections (code audit 2026-10: refresh on use before a
 * stage, now that the plan run that did it is gone). Only connections already bound to an estate system
 * count; each is connected lazily, when a stale table of its system is actually fetched. A connection
 * that fails is reported in `unreachable` and its tables are left as they are.
 */
function estateFetcher(session: PlatformSession, cfm: ContextFileManager, workspaceRoot: string): { fetcher: CatalogFetcher | undefined; unreachable: string[] } {
  const unreachable: string[] = [];
  const configured = new Set(loadConnectionsConfig(workspaceRoot).connections.map((c) => c.id));
  const bound = cfm.getEstate().bindings.filter((b) => b.connection && configured.has(b.connection))
    .map((b) => ({ connection: b.connection!, identity: cfm.resolveConnection(b.connection!).identity }));
  if (!bound.length) return { fetcher: undefined, unreachable };
  const ownerOf = (e: CatalogEntry) => bound.find((b) => b.identity.system === e.system && (b.identity.environment ?? '') === (e.environment ?? ''));
  const fetchers = new Map<string, CatalogFetcher | undefined>();
  const fetcherFor = async (connection: string): Promise<CatalogFetcher | undefined> => {
    if (!fetchers.has(connection)) {
      try {
        const manager = await session.connect(session.entry(connection));
        manager.setEstateResolver((id) => cfm.resolveConnection(id));
        fetchers.set(connection, manager.catalogFetcher());
      } catch (err) {
        unreachable.push(`${connection}: ${err instanceof Error ? err.message : String(err)}`);
        fetchers.set(connection, undefined);
      }
    }
    return fetchers.get(connection);
  };
  const byConnection = (entries: readonly CatalogEntry[]) => {
    const m = new Map<string, CatalogEntry[]>();
    for (const e of entries) { const o = ownerOf(e); if (o) m.set(o.connection, [...(m.get(o.connection) ?? []), e]); }
    return m;
  };
  return {
    unreachable,
    fetcher: {
      covers: (system, environment) => bound.some((b) => b.identity.system === system && (b.identity.environment ?? '') === (environment ?? '')),
      fetchStructure: async (entries) => {
        const nodes: BaseNode[] = [];
        const edges: GraphEdge[] = [];
        for (const [connection, group] of byConnection(entries)) {
          const f = await fetcherFor(connection);
          if (!f) continue;
          const g = await f.fetchStructure(group);
          nodes.push(...g.nodes); edges.push(...g.edges);
        }
        return { nodes, edges };
      },
      lastAltered: async (entries) => {
        const out = new Map<string, string>();
        for (const [connection, group] of byConnection(entries)) {
          const f = await fetcherFor(connection);
          if (f?.lastAltered) for (const [k, v] of await f.lastAltered(group)) out.set(k, v);
        }
        return out;
      }
    }
  };
}
