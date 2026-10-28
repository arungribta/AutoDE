import * as fs from 'node:fs';
import * as path from 'node:path';
import { ContextPackSources } from '../context/contextPack';
import { CatalogEntry } from '../context/catalog';
import { parseEstate } from '../context/estate';
import { loadConnectionsConfig } from '../platform/connectionsConfig';
import { connectionStatus, readReadiness } from '../platform/connectionReadiness';
import { loadSemanticLayer, semanticPaths } from '../semantic/store';
import { layoutPath } from '../workspaceLayout';
import { ArtifactUse, AssetType, Certification, ExploreSources, exploreGraph, exploreLandscape, exploreOverview, getAssetContext, listFacts, searchAssets } from './explore';
import { TrustTier } from '../context/assertions';

/**
 * Builds the Explorer's sources for a workspace (C5b) and answers its
 * requests: the same function behind the VS Code Knowledge Explorer,
 * `autode explore` and the MCP tools.
 */

const MAX_MANIFESTS = 5000;

/** What every grounding manifest in the deliverables folder rests on (§8.3), for "used by". */
export function artifactUses(workspaceRoot: string): ArtifactUse[] {
  const root = path.dirname(semanticPaths(workspaceRoot).sharedDir);
  const out: ArtifactUse[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_MANIFESTS) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'history') walk(p); continue; }
      if (!e.name.endsWith('.grounding.json')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(p, 'utf8')) as { artifact?: string; agent?: string; generatedAt?: string; assertions?: Array<{ id: string }>; decisions?: Array<{ subject?: string }>; sources?: { lineage?: string[] }; grounding?: { warnings?: string[] } };
        out.push({
          path: m.artifact ?? path.relative(workspaceRoot, p).replace(/\\/g, '/').replace(/\.grounding\.json$/, ''),
          ...(m.agent ? { agent: m.agent } : {}),
          ...(m.generatedAt ? { generatedAt: m.generatedAt } : {}),
          assertions: [...new Set((m.assertions ?? []).map((a) => a.id))],
          subjects: [...new Set([...(m.decisions ?? []).map((d) => d.subject).filter((s): s is string => !!s), ...(m.sources?.lineage ?? [])])],
          warnings: m.grounding?.warnings?.length ?? 0
        });
      } catch { /* not a manifest we can read */ }
    }
  };
  walk(root);
  return out;
}

/** The Explorer's sources: the context sources, with the semantic layer drafts included and the artifacts' manifests. */
export function exploreSources(workspaceRoot: string, context: ContextPackSources, problemId: string | undefined): ExploreSources {
  return {
    graph: context.graph,
    assertions: context.assertions,
    conflicts: context.conflicts,
    ...(context.catalog ? { catalog: context.catalog as ExploreSources['catalog'] } : {}),
    semantic: loadSemanticLayer(workspaceRoot, { problemId, includeDrafts: true }),
    artifacts: artifactUses(workspaceRoot)
  };
}

export interface EstateView {
  systems: Array<{ id: string; name: string; role: string; environments: Array<{ environment: string; tables: number; tiers: Record<string, number>; inWorkingSet: number; notVisible: number }> }>;
  bindings: Array<{ system: string; environment?: string; connection?: string; file?: string; schemas?: string[] }>;
  connections: Array<{ id: string; platform: string; role: string; readiness: string; checkedAt?: string; detail?: string }>;
  errors: string[];
}

/** Systems, environments and catalogs (§6.10 Estate), with connection readiness. */
export function estateView(workspaceRoot: string, sources: ExploreSources): EstateView {
  let estate = parseEstate(undefined);
  const errors: string[] = [];
  try { estate = parseEstate(fs.readFileSync(layoutPath(workspaceRoot, 'estate'), 'utf8')); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`estate.yaml: ${err instanceof Error ? err.message : String(err)}`); }
  const entries: CatalogEntry[] = sources.catalog?.all?.() ?? [];
  const inGraph = new Set(sources.graph.nodes.map((n) => n.id));
  const bySys = new Map<string, Map<string, { tables: number; tiers: Record<string, number>; inWorkingSet: number; notVisible: number }>>();
  const bump = (system: string, env: string) => {
    const envs = bySys.get(system) ?? new Map();
    bySys.set(system, envs);
    const v = envs.get(env) ?? { tables: 0, tiers: {}, inWorkingSet: 0, notVisible: 0 };
    envs.set(env, v);
    return v;
  };
  for (const e of entries) {
    const v = bump(e.system, e.environment);
    v.tables++;
    v.tiers[String(e.tier)] = (v.tiers[String(e.tier)] ?? 0) + 1;
    if (inGraph.has(e.id)) v.inWorkingSet++;
    if (e.visible === false) v.notVisible++;
  }
  for (const n of sources.graph.nodes) {
    if (n.type !== 'table' || sources.catalog?.get(n.id)) continue;
    const v = bump(n.origin?.system ?? 'unassigned', n.origin?.systemEnvironment ?? 'default');
    v.tables++; v.inWorkingSet++;
  }
  const ids = [...new Set([...estate.systems.map((s) => s.id), ...bySys.keys()])].sort();
  const systems = ids.map((id) => {
    const s = estate.systems.find((x) => x.id === id);
    const envs = bySys.get(id) ?? new Map();
    return { id, name: s?.name ?? id, role: s?.role ?? 'unknown', environments: [...envs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([environment, v]) => ({ environment, ...v })) };
  });
  let connections: EstateView['connections'] = [];
  try {
    const cfg = loadConnectionsConfig(workspaceRoot);
    const readiness = readReadiness(workspaceRoot);
    errors.push(...cfg.errors);
    connections = cfg.connections.map((c) => { const st = connectionStatus(c, readiness[c.id]); return { id: c.id, platform: c.platform, role: c.role, readiness: st.autode, ...(st.checkedAt ? { checkedAt: st.checkedAt } : {}), ...(st.detail ? { detail: st.detail } : {}) }; });
  } catch (err) { errors.push(`connections: ${err instanceof Error ? err.message : String(err)}`); }
  return { systems, bindings: estate.bindings.map((b) => ({ system: b.system, ...(b.environment ? { environment: b.environment } : {}), ...(b.connection ? { connection: b.connection } : {}), ...(b.file ? { file: b.file } : {}), ...(b.schemas ? { schemas: b.schemas } : {}) })), connections, errors };
}

/** A request from any surface; the reply is plain JSON. */
export type ExploreRequest =
  | { type: 'overview' }
  | { type: 'search'; query: string; assetTypes?: AssetType[]; systems?: string[]; platforms?: string[]; environments?: string[]; certifications?: Certification[]; statuses?: string[]; reviewStates?: string[]; classifications?: string[]; glossaryTerms?: string[]; limit?: number; offset?: number }
  | { type: 'asset'; id: string }
  | { type: 'graph'; id: string; hops?: number; edgeTypes?: string[]; includeColumns?: boolean; cap?: number }
  | { type: 'landscape'; system?: string; schema?: string; model?: string; includeColumns?: boolean; proposed?: boolean; semantic?: boolean; cap?: number }
  | { type: 'facts'; kinds?: string[]; statuses?: string[]; trust?: TrustTier[]; text?: string; limit?: number; offset?: number }
  | { type: 'estate' };

export function handleExploreRequest(request: ExploreRequest, sources: ExploreSources, workspaceRoot: string): Record<string, unknown> {
  switch (request.type) {
    case 'overview': return { type: 'overview', overview: exploreOverview(sources) };
    case 'search': {
      const { query, ...options } = request;
      return { type: 'search', result: searchAssets(sources, query ?? '', options) };
    }
    case 'asset': {
      const context = getAssetContext(sources, request.id);
      return context ? { type: 'asset', context } : { type: 'asset', error: `No asset "${request.id}" (search for it first).` };
    }
    case 'graph': {
      const slice = exploreGraph(sources, request.id, request);
      return slice ? { type: 'graph', slice } : { type: 'graph', error: `No asset "${request.id}" in the graph.` };
    }
    case 'landscape': return { type: 'landscape', slice: exploreLandscape(sources, request) };
    case 'facts': return { type: 'facts', result: listFacts(sources, request) };
    case 'estate': return { type: 'estate', estate: estateView(workspaceRoot, sources) };
  }
}
