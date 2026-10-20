import { EngineTool } from './tools';
import { EngineToolError } from './errors';
import { EngineWorkspace } from './workspace';
import { PlatformSession } from './platform';
import { listProblems, setActiveProblem, startProblem } from '../engine/documents/problems';
import { ingestConnection, ingestFile, openContext } from '../engine/context/estateIngest';

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
  return [
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
