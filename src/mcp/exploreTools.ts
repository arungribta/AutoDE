import { EngineTool, ToolAnnotations } from './tools';
import { EngineToolError } from './errors';
import { EngineWorkspace } from './workspace';
import { ExploreSources } from '../engine/explore/explore';
import { ExploreRequest, exploreSources, handleExploreRequest } from '../engine/explore/sources';
import { computeRevision } from '../engine/context/contextStore';

/**
 * The Knowledge Explorer over MCP (C5b; docs/context-layer-requirements.md
 * §6.10, §7.5, §9): the same answers the VS Code Explorer and `autode
 * explore` give, so an external agent can search what AutoDE knows, read an
 * asset's full context and walk the graph. Read-only.
 */

const read = (title: string): ToolAnnotations => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const strings = { type: 'array', items: { type: 'string' } };
const TRUST = { type: 'array', items: { enum: ['verified', 'confirmed', 'documented', 'assumed', 'inferred'] } };

export async function workspaceExploreSources(ws: EngineWorkspace): Promise<ExploreSources> {
  return exploreSources(ws.options.workspaceRoot, await ws.contextSources(), ws.activeProblemId());
}

export async function explore(ws: EngineWorkspace, request: ExploreRequest): Promise<Record<string, unknown>> {
  return handleExploreRequest(request, await workspaceExploreSources(ws), ws.options.workspaceRoot);
}

export function exploreTools(): EngineTool[] {
  return [
    {
      name: 'autode_search_assets',
      description: 'Search everything AutoDE knows — tables, views, columns, glossary terms, rules, verified queries, semantic models and their elements, facts, and tables in the estate catalog beyond the working set — by name, alias, synonym and description (every word must match; abbreviations and the customer\'s vocabulary count). An empty query lists everything. Returns ranked results with ids, and facet counts (kind, system, environment, trust, status, classification); filter by any facet. Then read one with autode_get_asset_context.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['query'],
        properties: { query: { type: 'string' }, kinds: strings, systems: strings, environments: strings, trust: TRUST, statuses: strings, classifications: strings, limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0 } }
      },
      annotations: read('Search assets'),
      handler: async (args, ws) => (await explore(ws, { type: 'search', ...(args as { query: string }) })).result as Record<string, unknown>
    },
    {
      name: 'autode_get_asset_context',
      description: 'Everything AutoDE knows about one asset (a table, column, term, rule, query, semantic element or fact; by id, or by a unique name or fqn): overview and provenance, schema with keys, grain, profile and classifications, business meaning (glossary terms, semantic elements over it), relationships and derivations, governance (classifications, rules that name it), facts with evidence, trust and history, decisions and assumptions in scope, what uses it (artifacts, semantic models, queries) and conflicts — each with its source. Use it before deciding anything about the asset.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['asset'], properties: { asset: { type: 'string', minLength: 1 } } },
      annotations: read('Read an asset\'s context'),
      handler: async (args, ws) => {
        const r = await explore(ws, { type: 'asset', id: String(args.asset) });
        if (!r.context) throw new EngineToolError('NOT_FOUND', String(r.error));
        return r.context as Record<string, unknown>;
      }
    },
    {
      name: 'autode_explore_graph',
      description: 'The graph around an asset, one to three hops out, both directions: nodes (with kind, trust, classification) and edges (contains, foreign_key, related_to, maps_to, derives_from, uses_table, constrained_by), optionally only some edge types. Columns are left out unless asked for; a hub is capped and what is left out is counted per node.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['asset'], properties: { asset: { type: 'string', minLength: 1 }, hops: { type: 'integer', minimum: 1, maximum: 3 }, edgeTypes: strings, includeColumns: { type: 'boolean' } } },
      annotations: read('Explore the graph'),
      handler: async (args, ws) => {
        const r = await explore(ws, { type: 'graph', id: String(args.asset), ...(args.hops ? { hops: Number(args.hops) } : {}), ...(args.edgeTypes ? { edgeTypes: args.edgeTypes as string[] } : {}), ...(args.includeColumns ? { includeColumns: true } : {}) });
        if (!r.slice) throw new EngineToolError('NOT_FOUND', String(r.error));
        return r.slice as Record<string, unknown>;
      }
    }
  ];
}

/** `autode://explore/overview`, `autode://explore/estate` and `autode://asset/{id}`. */
export const ASSET_RESOURCE_TEMPLATE = { uriTemplate: 'autode://asset/{id}', name: 'Asset context', description: 'Everything AutoDE knows about one asset (as autode_get_asset_context).', mimeType: 'application/json' };

export function exploreResources(): Array<{ uri: string; name: string; description: string; mimeType: string }> {
  return [
    { uri: 'autode://explore/overview', name: 'What AutoDE knows', description: 'Counts of objects, facts by status and trust, systems, semantic models.', mimeType: 'application/json' },
    { uri: 'autode://explore/estate', name: 'Estate', description: 'Systems, environments, catalogs and connection readiness.', mimeType: 'application/json' }
  ];
}

export async function readExploreResource(ws: EngineWorkspace, key: string): Promise<{ text: string; revision: string } | undefined> {
  let body: unknown;
  if (key === 'explore/overview') body = (await explore(ws, { type: 'overview' })).overview;
  else if (key === 'explore/estate') body = (await explore(ws, { type: 'estate' })).estate;
  else if (key.startsWith('asset/')) {
    const r = await explore(ws, { type: 'asset', id: decodeURIComponent(key.slice('asset/'.length)) });
    if (!r.context) throw new EngineToolError('NOT_FOUND', String(r.error));
    body = r.context;
  } else return undefined;
  const text = JSON.stringify(body, null, 2);
  return { text, revision: computeRevision(text) };
}
