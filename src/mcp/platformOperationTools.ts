import { EngineTool, ToolAnnotations } from './tools';
import { EngineToolError } from './errors';
import { EngineWorkspace } from './workspace';
import { PlatformSession } from './platform';
import { gateQueryResult } from '../engine/platform/sampleData';
import { governanceFacts } from '../engine/governance/governance';
import { loadCatalog, operationById } from '../engine/platform/operations/load';
import { ConnectionTarget, OperationError, runOnConnection, summarize } from '../engine/platform/operations/service';
import { openContext } from '../engine/context/estateIngest';
import { refreshLineage } from '../engine/lineage/record';
import { accessRunbook, capabilityMatrix, conformanceRun, operationPage, platformPage, skillOperations, skillPage, skillTexts } from '../engine/platform/operations/catalogView';
import { DecisionStore } from '../engine/decisions/decisionStore';
import { ProposalValidationError, propose } from '../engine/decisions/proposals';

/**
 * Platform operations over MCP (POP1; docs/specs/platform-operations.md §4):
 * the catalog, running a read on a connection, and LIN's observed lineage
 * through its operations. The CLI calls these same handlers, so both give
 * the same answer. A change operation never runs: it comes back as the
 * runbook step to propose.
 */

const read = (title: string, openWorld = false): ToolAnnotations => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: openWorld });

/** A connection as the executor reaches it: one read-only statement at a time, through the connection's CLI or API. */
export async function connectionTarget(session: PlatformSession, connectionId: string): Promise<{ target: ConnectionTarget; allowSampleData: boolean }> {
  const entry = session.entry(connectionId);
  const manager = await session.connect(entry);
  return {
    allowSampleData: entry.allowSampleDataInPrompts,
    target: { connectionId: entry.id, platform: entry.platform, query: async (sql, maxRows) => (await manager.executeQuery(sql, { maxRows, timeoutMs: 300_000 })).rows as Array<Record<string, unknown>> }
  };
}

export function platformOperationTools(session: PlatformSession): EngineTool[] {
  return [
    {
      name: 'autode_platform_request_access',
      description: "Request access (POP4b): a runbook that grants AutoDE's role what its capabilities need on a connection (default: those its last conformance run found short, else every capability with grant operations), built from the platform definition's grant operations, bound to the role, databases and schemas in scope. With an active problem it is proposed as a runbook decision for a person who administers the platform to approve and run; without one it comes back to show. Privileges no grant operation covers come back as warnings, in words.",
      inputSchema: { type: 'object', required: ['connectionId'], additionalProperties: false, properties: {
        connectionId: { type: 'string', minLength: 1 },
        role: { type: 'string', minLength: 1, description: "The role AutoDE connects as; default: the connection's role field." },
        capabilities: { type: 'array', items: { type: 'string', minLength: 1 } },
        databases: { type: 'array', items: { type: 'string', minLength: 1 }, description: "Databases (catalogs) in scope; default: the connection's." },
        schemas: { type: 'array', items: { type: 'string', minLength: 1 }, description: "Schemas in scope; default: the connection's." },
        propose: { type: 'boolean', description: 'Propose it as a runbook decision (default true when a problem is active).' }
      } },
      annotations: { title: 'Request access', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (args, ws: EngineWorkspace) => {
        const scope = { resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot };
        let draft;
        try { draft = accessRunbook(scope, { connection: String(args.connectionId), role: args.role as string | undefined, capabilities: args.capabilities as string[] | undefined, databases: args.databases as string[] | undefined, schemas: args.schemas as string[] | undefined }); }
        catch (err) { throw new EngineToolError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err)); }
        const problemRoot = ws.problemRoot();
        if (args.propose === false || !problemRoot) return { ...draft, proposed: false, next: problemRoot ? 'Propose it with autode_propose_runbook when it is right.' : 'No active problem: a runbook is proposed within a problem. Start or select one, then ask again; or give these steps to the platform administrator.' } as unknown as Record<string, unknown>;
        try {
          const d = propose(new DecisionStore(ws.options.workspaceRoot), { workspaceRoot: ws.options.workspaceRoot, problemRoot, problemId: ws.activeProblemId(), connections: session.config().connections, resourcesRoot: ws.options.resourcesRoot }, 'runbook', draft.runbook, { proposedBy: { host: 'mcp', client: 'request-access' } });
          return { ...draft, proposed: true, decision: { id: d.id, title: d.title }, next: `A person who administers the platform approves it (autode decisions approve ${d.id}, or the panel), then runs it in AutoDE's runner.` } as unknown as Record<string, unknown>;
        } catch (err) {
          if (err instanceof ProposalValidationError) throw new EngineToolError('VALIDATION_FAILED', `The runbook did not pass its checks: ${err.report.errors.join('; ')}`, { errors: err.report.errors });
          throw err;
        }
      }
    },
    {
      name: 'autode_platform_operations',
      description: 'The platform operations catalog: every interaction AutoDE has with a platform, as a reviewed file (id, what it does, read or change, its parameters and results, the platforms it has an implementation for, shipped or the team\'s, approved or draft), and each platform\'s definition (category, capabilities and the operations and privileges each needs). With id: one operation in full, including the statement or command per platform. Use these ids instead of writing platform SQL yourself.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1 }, platform: { type: 'string', minLength: 1 }, area: { type: 'string', minLength: 1 }, uses: { type: 'string', minLength: 1, description: 'Only the operations this skill names.' } } },
      annotations: read('Platform operations catalog'),
      handler: async (args, ws: EngineWorkspace) => {
        const scope = { resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot };
        const catalog = loadCatalog(scope);
        if (args.id) {
          const found = catalog.operations.filter((o) => o.item.id === String(args.id));
          if (!found.length) throw new EngineToolError('NOT_FOUND', `No operation ${String(args.id)}.`);
          // POP4a: its page: what relies on it (capabilities, engine features, skills and their stages) and its last runs.
          return { operations: found.map((o) => ({ ...o.item, origin: o.origin, status: o.status, file: o.file, checksum: o.checksum })), page: operationPage(scope, String(args.id), catalog) as unknown as Record<string, unknown> };
        }
        const usedBySkill = args.uses ? skillTexts(scope).texts.find((t) => t.id === String(args.uses)) : undefined;
        if (args.uses && !usedBySkill) throw new EngineToolError('NOT_FOUND', `No skill ${String(args.uses)} whose text AutoDE can read.`);
        const used = usedBySkill ? new Set(skillOperations(usedBySkill.text, catalog).uses.map((u) => u.id)) : undefined;
        const ops = summarize(catalog).filter((o) => (!args.platform || o.platforms.includes(String(args.platform))) && (!args.area || o.area === String(args.area)) && (!used || used.has(o.id)));
        const platforms = catalog.platforms.filter((p) => !args.platform || p.item.id === String(args.platform)).map((p) => ({ id: p.item.id, title: p.item.title, category: p.item.category, transports: p.item.transports, access: p.item.access, capabilities: p.item.capabilities, origin: p.origin, status: p.status, file: p.file }));
        return { operations: ops, platforms, errors: catalog.errors };
      }
    },
    {
      name: 'autode_platform_run',
      description: 'Run one read operation from the catalog on a connection: AutoDE binds the parameters by type (never as text), checks the statement is read-only, runs it through the connection\'s CLI or API, and returns the declared result. Row values come back only when the operation reads names (content metadata) or the connection allows sample data; personal-data columns are masked. A change operation does not run: you get the runbook step to propose with autode_propose_runbook. A platform failure (a missing privilege, an older version) comes back as a gap with its reason.',
      inputSchema: {
        type: 'object', required: ['connectionId', 'operation'], additionalProperties: false,
        properties: { connectionId: { type: 'string', minLength: 1 }, operation: { type: 'string', minLength: 1 }, params: { type: 'object' }, maxRows: { type: 'integer', minimum: 1, maximum: 5000 } }
      },
      annotations: read('Run a platform operation', true),
      handler: async (args, ws: EngineWorkspace) => {
        const scope = { resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot };
        const catalog = loadCatalog(scope);
        const op = operationById(catalog, String(args.operation))?.item;
        const { target, allowSampleData } = await connectionTarget(session, String(args.connectionId));
        try {
          const r = await runOnConnection({ ...scope, catalog }, target, String(args.operation), (args.params as Record<string, unknown>) ?? {}, { maxRows: (args.maxRows as number | undefined) ?? 200, via: 'autode_platform_run' });
          if (!r.ok || !op || op.content === 'metadata') return r as unknown as Record<string, unknown>;
          const classified = allowSampleData ? governanceFacts((await ws.contextSources()).assertions).filter((f) => f.classification === 'pii' || f.classification === 'sensitive-pii').map((f) => f.column) : [];
          const gated = gateQueryResult({ columns: op.returns.map((x) => x.name), rows: r.rows, rowCount: r.rows.length, executionTimeMs: 0 }, { allowSampleData, metadata: false, connectionId: target.connectionId, classified });
          return { ...r, ...gated } as unknown as Record<string, unknown>;
        } catch (err) {
          if (err instanceof OperationError) {
            if (err.code === 'CHANGE') return { change: true, message: err.message, runbookStep: err.step } as Record<string, unknown>;
            throw new EngineToolError(err.code, err.message);
          }
          throw err;
        }
      }
    },
    {
      name: 'autode_platform_catalog',
      description: 'The platform catalog (POP4a): with no arguments, the capability matrix (capabilities as rows; the workspace\'s platforms, then the others, as columns), each cell supported, partly (with what is missing) or not applicable, with the last conformance run on each connection. With platform: that platform\'s page, with only the tabs that apply (overview, capabilities, operations by area, skills, tools, primitives and dialect, privileges, health). With skill: that skill\'s page, the operations it relies on and what skills lint flags (unknown operation ids, SQL it carries itself).',
      inputSchema: { type: 'object', additionalProperties: false, properties: { platform: { type: 'string', minLength: 1 }, skill: { type: 'string', minLength: 1 } } },
      annotations: read('Platform catalog'),
      handler: async (args, ws: EngineWorkspace) => {
        const scope = { resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot };
        if (args.platform) {
          const page = platformPage(scope, String(args.platform));
          if (!page) throw new EngineToolError('NOT_FOUND', `No platform ${String(args.platform)}.`);
          return { page } as unknown as Record<string, unknown>;
        }
        if (args.skill) {
          const page = skillPage(scope, String(args.skill));
          if (!page) throw new EngineToolError('NOT_FOUND', `No skill ${String(args.skill)}.`);
          return { page } as unknown as Record<string, unknown>;
        }
        return { matrix: capabilityMatrix(scope) } as unknown as Record<string, unknown>;
      }
    },
    {
      name: 'autode_platform_conformance',
      description: 'A conformance run on a connection (POP4a): tries each capability\'s read operations, one row at most each, with values from the connection\'s own fields (its database and schema), and records which capabilities work, partly work (with the privileges they need) or weren\'t tried. Read-only; nothing is changed on the platform.',
      inputSchema: { type: 'object', required: ['connectionId'], additionalProperties: false, properties: { connectionId: { type: 'string', minLength: 1 } } },
      annotations: read('Conformance run', true),
      handler: async (args, ws: EngineWorkspace) => {
        const entry = session.entry(String(args.connectionId));
        const { target } = await connectionTarget(session, entry.id);
        return { result: await conformanceRun({ resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot }, target, entry.fields) } as unknown as Record<string, unknown>;
      }
    },
    {
      name: 'autode_refresh_lineage',
      description: 'Read a connection\'s observed lineage into AutoDE: runs the lineage operations its platform definition names (Snowflake access history and object dependencies, Databricks column and table lineage …), read-only, for the databases bound to the connection (or those named), over the last days (default 30), and records each edge as a verified lineage fact. An edge no longer observed is retired with the reason, unless the read was cut off. A failed operation is reported with the privileges the platform needs; the others still run.',
      inputSchema: { type: 'object', required: ['connectionId'], additionalProperties: false, properties: { connectionId: { type: 'string', minLength: 1 }, databases: { type: 'array', maxItems: 50, items: { type: 'string', pattern: '^[A-Za-z0-9_$-]+$' } }, days: { type: 'integer', minimum: 1, maximum: 365 } } },
      annotations: { title: 'Refresh observed lineage', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (args, ws: EngineWorkspace) => {
        const { target } = await connectionTarget(session, String(args.connectionId));
        const cfm = await openContext(ws.options.workspaceRoot);
        try {
          return { result: await refreshLineage({ resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot, cfm, target, databases: args.databases as string[] | undefined, days: args.days as number | undefined, actor: 'mcp' }) as unknown as Record<string, unknown> };
        } finally { cfm.dispose(); }
      }
    }
  ];
}
