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
      name: 'autode_platform_operations',
      description: 'The platform operations catalog: every interaction AutoDE has with a platform, as a reviewed file (id, what it does, read or change, its parameters and results, the platforms it has an implementation for, shipped or the team\'s, approved or draft), and each platform\'s definition (category, capabilities and the operations and privileges each needs). With id: one operation in full, including the statement or command per platform. Use these ids instead of writing platform SQL yourself.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1 }, platform: { type: 'string', minLength: 1 }, area: { type: 'string', minLength: 1 } } },
      annotations: read('Platform operations catalog'),
      handler: async (args, ws: EngineWorkspace) => {
        const catalog = loadCatalog({ resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot });
        if (args.id) {
          const found = catalog.operations.filter((o) => o.item.id === String(args.id));
          if (!found.length) throw new EngineToolError('NOT_FOUND', `No operation ${String(args.id)}.`);
          return { operations: found.map((o) => ({ ...o.item, origin: o.origin, status: o.status, file: o.file, checksum: o.checksum })) };
        }
        const ops = summarize(catalog).filter((o) => (!args.platform || o.platforms.includes(String(args.platform))) && (!args.area || o.area === String(args.area)));
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
          const r = await runOnConnection({ catalog }, target, String(args.operation), (args.params as Record<string, unknown>) ?? {}, { maxRows: (args.maxRows as number | undefined) ?? 200 });
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
