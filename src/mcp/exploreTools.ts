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
const ASSET_TYPES = { type: 'array', items: { enum: ['table', 'view', 'column', 'glossary_term', 'rule', 'verified_query', 'semantic_model', 'logical_table', 'dimension', 'time_dimension', 'semantic_fact', 'metric', 'filter', 'knowledge_fact'] } };
const CERTIFICATIONS = { type: 'array', items: { enum: ['verified', 'documented', 'unverified', 'draft'] } };

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
      description: 'Search everything AutoDE knows — tables, views, columns, glossary terms, rules, verified queries, semantic models (logical tables, dimensions, time dimensions, facts, metrics, filters), knowledge facts, and tables in the estate catalog beyond the working set — by name, alias, synonym and description. Every word must match; otherwise the results are related ones from the customer\'s vocabulary, flagged approximate. An empty query lists everything. Returns ranked results with ids, and facet counts: asset type, system, platform, environment, certification (verified, documented, unverified, draft), status, review state (knowledge facts), classification, glossary term; domain, owner and tag are in pendingFacets until they have data. Filter by any facet. Then read one with autode_get_asset_context.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['query'],
        properties: { query: { type: 'string' }, assetTypes: ASSET_TYPES, systems: strings, platforms: strings, environments: strings, certifications: CERTIFICATIONS, statuses: strings, reviewStates: strings, classifications: strings, glossaryTerms: strings, limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0 } }
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
      description: 'The graph. With an asset: its neighbourhood, one to three hops out, both directions (edges contains, foreign_key, related_to, maps_to, derives_from, uses_table, constrained_by; optionally only some types; a hub is capped and what is left out is counted per node). Without one: the landscape, the working set\'s tables (or one system, schema or semantic model\'s) with every relationship AutoDE knows between them — declared foreign keys, confirmed relationships, proposed ones and semantic-layer joins (proposed: true when not confirmed), each labelled with its columns. Columns, when asked for, name their table as parent.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { asset: { type: 'string', minLength: 1 }, hops: { type: 'integer', minimum: 1, maximum: 3 }, edgeTypes: strings, includeColumns: { type: 'boolean' }, system: { type: 'string' }, schema: { type: 'string' }, model: { type: 'string' } } },
      annotations: read('Explore the graph'),
      handler: async (args, ws) => {
        if (!args.asset) {
          const l = await explore(ws, { type: 'landscape', ...(args.system ? { system: String(args.system) } : {}), ...(args.schema ? { schema: String(args.schema) } : {}), ...(args.model ? { model: String(args.model) } : {}), ...(args.includeColumns ? { includeColumns: true } : {}) });
          return l.slice as Record<string, unknown>;
        }
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
