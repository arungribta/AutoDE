import { Assertion, TrustTier, isLive, trustRank } from '../context/assertions';
import { parseObjectId } from '../context/estate';
import { exprIdentifiers } from '../semantic/checks';
import { isReportEntity } from '../lineage/observed';
import { AssetSummary, ExploreSources, articleId, exploreIndexView } from './explore';

/**
 * Lineage and impact (LIN; docs/specs/context-layer.md §8.5).
 *
 * One graph from four sources, each edge labelled with every source that
 * backs it:
 * - **observed**: `lineage` facts in the ledger, recorded from a platform's
 *   lineage views by its skill (or by an agent), `verified`;
 * - **designed**: the mapping documents (column level) and Pipeline Specs
 *   (entity level) of every business problem, read from the documents, so
 *   they never drift: `confirmed` once approved, drafts flagged;
 * - **generated**: what artifacts' grounding manifests rest on;
 * - **logical**: semantic elements from their columns, logical tables from
 *   their physical tables, verified queries from their logical tables.
 *
 * Traversals are graph walks (never similarity), cycle-guarded, depth- and
 * size-capped. An end AutoDE doesn't hold (a planned target, an object
 * outside the working set) is kept by name and labelled, never dropped or
 * guessed. Deterministic: same sources, same answer.
 */

export type LineageSource = 'observed' | 'designed' | 'generated' | 'logical';
export const LINEAGE_SOURCES: readonly LineageSource[] = ['observed', 'designed', 'generated', 'logical'];

/** What a lineage end is: an asset AutoDE holds, a target a design plans, an object outside the working set, an artifact, a job or a report. */
export type LineageNodeKind = 'asset' | 'planned' | 'external' | 'artifact' | 'job' | 'report';

/** A document or process an edge passes through: a mapping, a pipeline (spec entity or platform job), a report. */
export interface Carrier { category: 'mapping' | 'pipeline' | 'report'; id: string; label: string; problemId?: string }

export interface EdgeEvidence {
  source: LineageSource;
  trust: TrustTier;
  /** From a draft (an unapproved mapping, spec or semantic model). */
  draft?: boolean;
  /** Human-readable: "mapping m1 (problem retail-orders)", "Snowflake access_history". */
  label: string;
  /** The fact id, document path or manifest the edge comes from. */
  ref: string;
  via?: Carrier;
}

interface LNode { id: string; label: string; kind: LineageNodeKind; parent?: string; problemId?: string; note?: string }
interface LEdge { from: string; to: string; level: 'table' | 'column'; evidence: EdgeEvidence[]; rollup?: boolean }

interface LGraph {
  nodes: Map<string, LNode>;
  column: LEdge[];
  table: LEdge[];
  down: Record<'table' | 'column', Map<string, LEdge[]>>;
  up: Record<'table' | 'column', Map<string, LEdge[]>>;
  counts: Record<LineageSource, number>;
}

const graphs = new WeakMap<ExploreSources, LGraph>();
const lower = (s: string) => s.replace(/["`[\]]/g, '').toLowerCase();
const lastPart = (s: string) => lower(s).split('.').pop() ?? lower(s);
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function buildGraph(sources: ExploreSources): LGraph {
  const hit = graphs.get(sources);
  if (hit) return hit;
  const view = exploreIndexView(sources);
  const nodes = new Map<string, LNode>();
  const edgeMap = new Map<string, LEdge>();
  const counts: Record<LineageSource, number> = { observed: 0, designed: 0, generated: 0, logical: 0 };

  const parentOf = (id: string) => view.tableOf.get(id) ?? nodes.get(id)?.parent;
  const ensure = (id: string, init: Omit<LNode, 'id'>) => {
    if (!nodes.has(id)) nodes.set(id, { id, ...init });
    return id;
  };
  const known = (id: string) => (view.nodes.has(id) ? ensure(id, { label: view.nodes.get(id)!.label, kind: 'asset' }) : id);
  const link = (from: string, to: string, level: 'table' | 'column', ev: EdgeEvidence) => {
    if (from === to) return;
    const key = `${level}|${from}|${to}`;
    const e = edgeMap.get(key) ?? { from, to, level, evidence: [] };
    edgeMap.set(key, e);
    if (!e.evidence.some((x) => x.source === ev.source && x.ref === ev.ref)) { e.evidence.push(ev); counts[ev.source]++; }
  };

  // Tables by name, for designs that name objects (a mapping's source, a spec's objects): unique or not at all.
  const tables = [...view.nodes.values()].filter((n) => n.type === 'table' || n.type === 'semantic_view');
  const byName = new Map<string, string[]>();
  const add = (k: string, id: string) => { const l = byName.get(k) ?? []; if (!l.includes(id)) l.push(id); byName.set(k, l); };
  for (const t of tables) {
    const fqn = lower(String((t as { fqn?: string }).fqn || t.label));
    const parts = fqn.split('.');
    for (let i = 0; i < parts.length; i++) add(parts.slice(i).join('.'), t.id);
  }
  const findTable = (name: string): string => {
    if (view.nodes.has(name)) return known(name);
    const r = view.resolve(name);
    if (r && (view.nodes.has(r) || view.summarize(r))) return view.nodes.has(r) ? known(r) : ensure(r, { label: view.summarize(r)!.label, kind: 'external', note: 'in the estate catalog, outside the working set' });
    const ids = byName.get(lower(name)) ?? [];
    if (ids.length === 1) return known(ids[0]);
    return ensure(`ext:${lower(name)}`, { label: name, kind: 'external', note: ids.length > 1 ? `ambiguous: ${ids.length} tables fit (${ids.join(', ')})` : 'not in the estate' });
  };
  const columnOf = (tableId: string, column: string): string => {
    const name = lastPart(column);
    const found = (view.columnsOf.get(tableId) ?? []).find((c) => view.nodes.get(c)?.label.toLowerCase() === name);
    if (found) return known(found);
    const t = nodes.get(tableId);
    return ensure(`${tableId}.${name}`, { label: column, kind: t?.kind === 'asset' ? 'external' : t?.kind ?? 'external', parent: tableId, ...(t?.problemId ? { problemId: t.problemId } : {}), ...(t?.kind === 'asset' ? { note: 'not a column of the table AutoDE holds' } : {}) });
  };
  // A planned object, keyed by its last name part within the problem: a mapping's fct_orders and a spec's MART.fct_orders are one target.
  const planned = (problemId: string, name: string) => ensure(`planned:${problemId}/${lastPart(name)}`, { label: name, kind: 'planned', problemId, note: `planned by ${problemId}` });

  // ── Observed (and stated) lineage facts ──
  for (const a of sources.assertions) {
    if (a.kind !== 'lineage' || !isLive(a.status)) continue;
    const v = (a.value ?? {}) as { upstream?: string; downstream?: string; level?: string; source?: string; method?: string; connection?: string; entity?: { type: string; id: string; name?: string } };
    if (!v.upstream || !v.downstream) continue;
    const level = v.level === 'column' ? 'column' : 'table';
    const end = (id: string) => {
      if (view.nodes.has(id)) return known(id);
      if (id.startsWith('job:')) return ensure(id, { label: v.entity?.name ?? v.entity?.id ?? id, kind: v.entity && isReportEntity(v.entity.type) ? 'report' : 'job' });
      const p = parseObjectId(id);
      const path = p?.path ?? id;
      if (level === 'column') {
        const table = id.slice(0, id.lastIndexOf('.'));
        if (!nodes.has(table)) {
          if (view.nodes.has(table)) known(table);
          else ensure(table, { label: path.slice(0, path.lastIndexOf('.')), kind: 'external', note: view.summarize(table) ? 'in the estate catalog, outside the working set' : 'not in the estate' });
        }
        return ensure(id, { label: path.split('.').pop()!, kind: 'external', parent: table, note: 'outside the working set' });
      }
      return ensure(id, { label: path, kind: 'external', note: view.summarize(id) ? 'in the estate catalog, outside the working set' : 'not in the estate' });
    };
    const via: Carrier | undefined = v.entity ? { category: isReportEntity(v.entity.type) ? 'report' : 'pipeline', id: v.entity.id.startsWith('job:') ? v.entity.id : `job:${v.connection ?? ''}:${v.entity.id}`, label: `${v.entity.type} ${v.entity.name ?? v.entity.id}` } : undefined;
    const observed = v.source !== 'stated';
    link(end(v.upstream), end(v.downstream), level, { source: observed ? 'observed' : 'designed', trust: a.trust, label: observed ? `${v.method ?? 'platform'} on ${v.connection ?? 'a connection'}` : `stated: ${a.statement}`, ref: a.id, ...(via && !v.downstream.startsWith('job:') ? { via } : {}) });
  }

  // ── Designed: mappings (column level) and Pipeline Specs (entity level) ──
  for (const d of sources.designs ?? []) {
    const m = d.mapping;
    if (m) {
      const approved = m.status === 'approved';
      for (const em of m.mappings) {
        const src = em.sourceEntityId && view.nodes.has(em.sourceEntityId) ? known(em.sourceEntityId) : findTable(em.sourceFqn || em.sourceEntityId);
        const tgt = em.targetEntityId && view.nodes.has(em.targetEntityId) ? known(em.targetEntityId) : planned(d.problemId, em.targetName);
        const via: Carrier = { category: 'mapping', id: `mapping:${d.problemId}/${em.id}`, label: `mapping ${em.sourceFqn || em.sourceEntityId} → ${em.targetName}`, problemId: d.problemId };
        const ev: EdgeEvidence = { source: 'designed', trust: approved ? 'confirmed' : 'inferred', ...(approved ? {} : { draft: true }), label: `mapping document of ${d.problemId}${approved ? '' : ' (draft)'}`, ref: `${d.problemId}/context/mapping-context.yaml#${em.id}`, via };
        link(src, tgt, 'table', ev);
        const srcCols = new Set((view.columnsOf.get(src) ?? []).map((c) => view.nodes.get(c)?.label.toLowerCase()));
        for (const c of em.columns) {
          // A source "column" may be an expression (first_name || ' ' || last_name): each column it names.
          const named = IDENT.test(c.sourceColumn.trim()) ? [c.sourceColumn.trim()] : exprIdentifiers(c.sourceColumn);
          const fromExpr = c.transformExpression ? exprIdentifiers(c.transformExpression) : [];
          const cols = [...new Set([...named, ...fromExpr.filter((x) => srcCols.has(lastPart(x)))].map(lastPart))].filter((x) => !srcCols.size || srcCols.has(x) || named.map(lastPart).includes(x));
          const to = columnOf(tgt, c.targetColumn);
          for (const col of cols) link(columnOf(src, col), to, 'column', ev);
        }
      }
    }
    const spec = d.pipeline;
    if (spec) {
      const approved = spec.status === 'approved';
      for (const ent of spec.entities) {
        const chain = [ent.source.object, ...ent.transforms.map((t) => t.params?.targetObject).filter((x): x is string => typeof x === 'string' && !!x.trim()), ent.target.object];
        const ids: string[] = [];
        chain.forEach((o, i) => {
          const id = i === 0 ? findTable(o) : planned(d.problemId, o);
          if (ids[ids.length - 1] !== id) ids.push(id);
        });
        const via: Carrier = { category: 'pipeline', id: `pipeline:${d.problemId}/${ent.name}`, label: `pipeline ${ent.name}`, problemId: d.problemId };
        const ev: EdgeEvidence = { source: 'designed', trust: approved ? 'confirmed' : 'inferred', ...(approved ? {} : { draft: true }), label: `Pipeline Spec of ${d.problemId} v${spec.version}${approved ? '' : ' (draft)'}`, ref: `${d.problemId}/spec/pipeline.yaml#${ent.name}`, via };
        for (let i = 1; i < ids.length; i++) link(ids[i - 1], ids[i], 'table', ev);
      }
    }
  }

  // ── Generated: what each artifact's grounding manifest rests on ──
  for (const u of sources.artifacts ?? []) {
    const problem = /(?:^|\/)problems\/([^/]+)\//.exec(u.path)?.[1];
    const art = ensure(`artifact:${u.path}`, { label: u.path, kind: 'artifact', ...(problem ? { problemId: problem } : {}) });
    const ev: EdgeEvidence = { source: 'generated', trust: 'documented', label: `grounding manifest of ${u.path}`, ref: `${u.path}.grounding.json` };
    for (const s of u.subjects) link(findTable(s), art, 'table', ev);
    for (const id of u.assertions) {
      const a = view.assertion(id);
      for (const s of a?.subject ?? []) {
        if (view.tableOf.has(s)) link(known(s), art, 'column', ev);
        else if (view.nodes.get(s)?.type === 'table') link(known(s), art, 'table', ev);
      }
    }
  }

  // ── Logical: the semantic layer over the physical one ──
  for (const e of view.edges) {
    if (e.id.startsWith('lin:')) continue;
    const s = view.nodes.get(e.source);
    if (!s?.id.startsWith('sem:')) continue;
    const approved = s.metadata?.approved === true;
    const model = typeof s.metadata?.model === 'string' ? s.metadata.model : undefined;
    const ev = (): EdgeEvidence => ({ source: 'logical', trust: approved ? 'confirmed' : 'inferred', ...(approved ? {} : { draft: true }), label: `semantic model ${model ?? s.label}${approved ? '' : ' (draft)'}`, ref: s.id });
    if (e.type === 'derives_from' && view.nodes.has(e.target)) link(known(e.target), known(e.source), 'column', ev());
    else if (e.type === 'maps_to' && s.type === 'semantic_table' && view.nodes.has(e.target)) link(known(e.target), known(e.source), 'table', ev());
    else if (e.type === 'uses_table' && s.type === 'verified_query') link(known(e.target), known(e.source), 'table', ev());
    else if (e.type === 'contains' && (view.nodes.get(e.target)?.type === 'semantic_element' || view.nodes.get(e.target)?.type === 'metric')) {
      known(e.target);
      nodes.get(e.target)!.parent = e.source;
    }
  }

  // Column edges roll up to their tables; a table edge of its own (a spec, a table-level observation) stays one.
  const column = [...edgeMap.values()].filter((e) => e.level === 'column');
  const table = [...edgeMap.values()].filter((e) => e.level === 'table');
  const tableKey = new Map<string, LEdge>(table.map((e) => [`${e.from}|${e.to}`, e]));
  for (const e of column) {
    const f = parentOf(e.from), t = parentOf(e.to);
    if (!f || !t || f === t) continue;
    known(f); known(t);
    const k = `${f}|${t}`;
    const ex = tableKey.get(k);
    if (ex) { for (const ev of e.evidence) if (!ex.evidence.some((x) => x.source === ev.source && x.ref === ev.ref)) ex.evidence.push(ev); continue; }
    const r: LEdge = { from: f, to: t, level: 'table', evidence: [...e.evidence], rollup: true };
    tableKey.set(k, r);
    table.push(r);
  }
  const index = (list: LEdge[], by: 'from' | 'to') => {
    const m = new Map<string, LEdge[]>();
    for (const e of list) m.set(e[by], [...(m.get(e[by]) ?? []), e]);
    return m;
  };
  const g: LGraph = { nodes, column, table, down: { table: index(table, 'from'), column: index(column, 'from') }, up: { table: index(table, 'to'), column: index(column, 'to') }, counts };
  for (const id of nodes.keys()) if (!nodes.get(id)!.parent && view.tableOf.has(id)) nodes.get(id)!.parent = view.tableOf.get(id);
  graphs.set(sources, g);
  return g;
}

// ── Views ───────────────────────────────────────────────────────────────────

export interface LineageNodeView {
  id: string;
  label: string;
  kind: LineageNodeKind;
  fqn?: string;
  assetType?: string;
  layer?: string;
  system?: string;
  environment?: string;
  domain?: string;
  /** The table a column belongs to. */
  parent?: string;
  problemId?: string;
  note?: string;
  inWorkingSet: boolean;
  /** Hops from the asset: negative upstream, positive downstream. */
  depth: number;
}

export interface LineageEdgeView {
  from: string;
  to: string;
  level: 'table' | 'column';
  sources: LineageSource[];
  /** The strongest evidence's trust. */
  trust: TrustTier;
  /** Every source behind it is a draft. */
  draft: boolean;
  evidence: EdgeEvidence[];
}

export interface Coverage {
  counts: Record<LineageSource, number>;
  /** What is missing and how to get it. */
  notes: string[];
}

export interface LineageRequest { direction?: 'upstream' | 'downstream' | 'both'; depth?: number; level?: 'table' | 'column'; cap?: number }

export interface LineageResult {
  asset: LineageNodeView;
  direction: 'upstream' | 'downstream' | 'both';
  depth: number;
  level: 'table' | 'column';
  nodes: LineageNodeView[];
  edges: LineageEdgeView[];
  /** Nodes left out by the cap. */
  truncated: number;
  coverage: Coverage;
}

/** A name that reads on its own: the fqn, else the parent's name and the label (`fct_orders.tax`, `orders.total_tax`). */
function displayName(id: string, g: LGraph, sources: ExploreSources, seen = 0): string {
  const view = exploreIndexView(sources);
  const s = view.summarize(id);
  if (s?.fqn) return s.fqn;
  const n = g.nodes.get(id);
  const label = s?.label ?? n?.label ?? id;
  const parent = n?.parent ?? view.tableOf.get(id);
  return parent && seen < 3 ? `${displayName(parent, g, sources, seen + 1)}.${label}` : label;
}

function nodeView(id: string, g: LGraph, sources: ExploreSources, depth: number): LineageNodeView {
  const view = exploreIndexView(sources);
  const n = g.nodes.get(id);
  const s: AssetSummary | undefined = view.summarize(id);
  const name = displayName(id, g, sources);
  // A column (or element) is in its table's domain unless it has its own.
  const parentId = n?.parent ?? view.tableOf.get(id);
  const domain = s?.domain ?? (parentId ? view.summarize(parentId)?.domain : undefined);
  return {
    id, label: s?.label ?? n?.label ?? id, kind: n?.kind ?? (s ? (s.inWorkingSet ? 'asset' : 'external') : 'external'),
    ...(name !== (s?.label ?? n?.label ?? id) ? { fqn: name } : {}), ...(s ? { assetType: s.assetType, layer: s.layer } : {}),
    ...(s?.system ? { system: s.system } : {}), ...(s?.environment ? { environment: s.environment } : {}), ...(domain ? { domain } : {}),
    ...(n?.parent ?? view.tableOf.get(id) ? { parent: n?.parent ?? view.tableOf.get(id) } : {}),
    ...(n?.problemId ? { problemId: n.problemId } : {}), ...(n?.note ? { note: n.note } : {}),
    inWorkingSet: view.nodes.has(id), depth
  };
}

function edgeView(e: LEdge): LineageEdgeView {
  const best = e.evidence.map((x) => x.trust).sort((a, b) => trustRank(b) - trustRank(a))[0] ?? 'inferred';
  return { from: e.from, to: e.to, level: e.level, sources: LINEAGE_SOURCES.filter((s) => e.evidence.some((x) => x.source === s)), trust: best, draft: e.evidence.every((x) => x.draft), evidence: e.evidence };
}

function coverage(g: LGraph): Coverage {
  const notes: string[] = [];
  if (!g.counts.observed) notes.push('No observed lineage: pipelines built outside AutoDE are missing. Read it from the platform: autode lineage refresh --connection <id> (AutoDE: Refresh Observed Lineage, or autode_refresh_lineage); the platform definition says which privileges it needs.');
  if (!g.counts.designed) notes.push('No designed lineage: a mapping document or a Pipeline Spec adds it (approved ones are confirmed).');
  if (!g.counts.generated) notes.push('No generated lineage: artifacts recorded with grounding manifests add it.');
  if (!g.counts.logical) notes.push('No logical lineage: a semantic model over these tables adds it.');
  return { counts: { ...g.counts }, notes };
}

function startIds(id: string, level: 'table' | 'column', g: LGraph, sources: ExploreSources): string[] {
  const view = exploreIndexView(sources);
  const parent = g.nodes.get(id)?.parent ?? view.tableOf.get(id);
  if (level === 'table') return [parent ?? id];
  if (parent) return [id];
  const cols = new Set([...(view.columnsOf.get(id) ?? []), ...[...g.nodes.values()].filter((n) => n.parent === id).map((n) => n.id)]);
  return cols.size ? [...cols] : [id];
}

/** Resolves an asset reference for lineage: an id AutoDE holds, a lineage-only id (planned:, ext:, job:, artifact:), or a unique name. */
export function resolveLineageAsset(sources: ExploreSources, ref: string): string | undefined {
  const g = buildGraph(sources);
  if (g.nodes.has(ref)) return ref;
  const r = exploreIndexView(sources).resolve(ref);
  if (r) return r;
  const l = lower(ref);
  const hits = [...g.nodes.values()].filter((n) => n.id === ref || lower(n.label) === l);
  return hits.length === 1 ? hits[0].id : undefined;
}

/** Upstream and/or downstream of an asset, at table or column level, depth-limited. */
export function lineageOf(sources: ExploreSources, ref: string, request: LineageRequest = {}): LineageResult | undefined {
  const id = resolveLineageAsset(sources, ref);
  if (!id) return undefined;
  const g = buildGraph(sources);
  const direction = request.direction ?? 'both';
  const depth = Math.max(1, Math.min(10, Math.floor(request.depth ?? 3)));
  const view = exploreIndexView(sources);
  const isColumn = !!(g.nodes.get(id)?.parent ?? view.tableOf.get(id));
  const level = request.level ?? (isColumn ? 'column' : 'table');
  const cap = Math.max(10, Math.min(2000, request.cap ?? 300));
  const starts = startIds(id, level, g, sources);
  const depthOf = new Map<string, number>(starts.map((s) => [s, 0]));
  const edges = new Map<LEdge, true>();
  let truncated = 0;
  const walk = (dir: 'down' | 'up') => {
    let frontier = [...starts];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const e of g[dir][level].get(n) ?? []) {
          const other = dir === 'down' ? e.to : e.from;
          if (!depthOf.has(other)) {
            if (depthOf.size >= cap) { truncated++; continue; }
            depthOf.set(other, dir === 'down' ? d : -d);
            next.push(other);
          }
          edges.set(e, true);
        }
      }
      frontier = next;
    }
  };
  if (direction !== 'upstream') walk('down');
  if (direction !== 'downstream') walk('up');
  const shown = [...edges.keys()].filter((e) => depthOf.has(e.from) && depthOf.has(e.to));
  return {
    asset: nodeView(id, g, sources, 0), direction, depth, level,
    nodes: [...depthOf.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([n, d]) => nodeView(n, g, sources, d)),
    edges: shown.map(edgeView).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    truncated, coverage: coverage(g)
  };
}

/** How many assets lie upstream and downstream (one hop), and from which sources: for the asset page. */
export function lineageSummary(sources: ExploreSources, id: string): { upstream: number; downstream: number; sources: LineageSource[] } {
  const g = buildGraph(sources);
  const view = exploreIndexView(sources);
  const level = view.tableOf.has(id) ? 'column' : 'table';
  const up = g.up[level].get(id) ?? [];
  const down = g.down[level].get(id) ?? [];
  return { upstream: up.length, downstream: down.length, sources: LINEAGE_SOURCES.filter((s) => [...up, ...down].some((e) => e.evidence.some((x) => x.source === s))) };
}

// ── Impact ──────────────────────────────────────────────────────────────────

export type ChangeKind = 'rename_column' | 'drop_column' | 'retype_column' | 'remove_table' | 'supersede_fact';
export const CHANGE_KINDS: readonly ChangeKind[] = ['rename_column', 'drop_column', 'retype_column', 'remove_table', 'supersede_fact'];

export type ImpactCategory = 'schema' | 'mapping' | 'pipeline' | 'semantic' | 'report' | 'artifact' | 'knowledge';
export const IMPACT_CATEGORIES: readonly ImpactCategory[] = ['schema', 'mapping', 'pipeline', 'semantic', 'report', 'artifact', 'knowledge'];

export interface ImpactItem {
  id: string;
  label: string;
  category: ImpactCategory;
  /** `direct`: a column-level (or fact) path; `possible`: only table-level lineage links it. */
  certainty: 'direct' | 'possible';
  domain?: string;
  problemId?: string;
  /** From the changed asset to this one. */
  path: Array<{ id: string; label: string }>;
  /** The sources of the edges on the path. */
  sources: LineageSource[];
  draft: boolean;
}

export interface ImpactResult {
  change: { kind: ChangeKind; asset: string };
  asset: LineageNodeView;
  effect: string;
  items: ImpactItem[];
  byCategory: Record<ImpactCategory, number>;
  byDomain: Array<{ domain: string; count: number; categories: ImpactCategory[] }>;
  /** Business problems that use something affected. */
  problems: Array<{ id: string; statement?: string }>;
  /** Some affected asset lies in another domain than the changed one. */
  crossDomain: boolean;
  truncated: number;
  coverage: Coverage;
}

const EFFECT: Record<ChangeKind, string> = {
  rename_column: 'Renaming it breaks what reads it by name until each is updated.',
  drop_column: 'Dropping it breaks what reads it.',
  retype_column: 'Retyping it may change results or fail casts in what reads it.',
  remove_table: 'Removing it breaks everything downstream.',
  supersede_fact: 'What rests on the fact becomes stale until it is reviewed.'
};

function categoryOf(n: LineageNodeView): ImpactCategory {
  if (n.kind === 'artifact') return 'artifact';
  if (n.kind === 'job') return 'pipeline';
  if (n.kind === 'report') return 'report';
  if (n.id.startsWith('sem:') || n.layer === 'semantic') return 'semantic';
  if (n.id.startsWith('article:')) return 'knowledge';
  return 'schema';
}

/**
 * What a change would affect, each item with the path that links it. Column
 * changes follow column-level lineage (direct); what only table-level
 * lineage links is listed as possible. Grouped by category and by domain.
 */
export function impactOf(sources: ExploreSources, change: { kind: ChangeKind; asset: string }, options: { cap?: number } = {}): ImpactResult | { error: string } {
  if (!CHANGE_KINDS.includes(change.kind)) return { error: `Unknown change "${String(change.kind)}": ${CHANGE_KINDS.join(', ')}.` };
  const g = buildGraph(sources);
  const view = exploreIndexView(sources);
  const cap = Math.max(10, Math.min(5000, options.cap ?? 1000));
  const items = new Map<string, ImpactItem>();
  let truncated = 0;
  const labelOf = (id: string) => displayName(id, g, sources);
  const put = (item: ImpactItem) => {
    const ex = items.get(item.id);
    if (ex && (ex.certainty === 'direct' || item.certainty === 'possible')) return;
    if (!ex && items.size >= cap) { truncated++; return; }
    items.set(item.id, item);
  };

  let startId: string | undefined;
  if (change.kind === 'supersede_fact') {
    const a: Assertion | undefined = view.assertion(change.asset);
    if (!a) return { error: `No fact "${change.asset}".` };
    startId = a.id;
    const self = [{ id: a.id, label: a.statement }];
    for (const u of sources.artifacts ?? []) if (u.assertions.includes(a.id)) {
      const n = nodeView(`artifact:${u.path}`, g, sources, 1);
      put({ id: n.id, label: u.path, category: 'artifact', certainty: 'direct', ...(n.problemId ? { problemId: n.problemId } : {}), path: [...self, { id: n.id, label: u.path }], sources: ['generated'], draft: false });
    }
    for (const n of view.nodes.values()) if ((n.supportedBy ?? []).includes(a.id) && n.id.startsWith('sem:')) {
      const v = nodeView(n.id, g, sources, 1);
      put({ id: n.id, label: n.label, category: 'semantic', certainty: 'direct', ...(v.domain ? { domain: v.domain } : {}), path: [...self, { id: n.id, label: n.label }], sources: ['logical'], draft: n.metadata?.approved !== true });
    }
    for (const art of sources.articles ?? []) if (art.cites.includes(a.id)) {
      put({ id: articleId(art.slug), label: art.title, category: 'knowledge', certainty: 'direct', ...(art.domain ? { domain: art.domain } : {}), path: [...self, { id: articleId(art.slug), label: art.title }], sources: [], draft: art.state !== 'approved' });
    }
  } else {
    startId = resolveLineageAsset(sources, change.asset);
    if (!startId) return { error: `No asset "${change.asset}" (search for it first).` };
    const isColumn = !!(g.nodes.get(startId)?.parent ?? view.tableOf.get(startId));
    if (change.kind !== 'remove_table' && !isColumn) return { error: `${change.kind} needs a column; ${labelOf(startId)} is not one (use remove_table for a table).` };
    if (change.kind === 'remove_table' && isColumn) startId = g.nodes.get(startId)?.parent ?? view.tableOf.get(startId)!;
    const table = isColumn && change.kind !== 'remove_table' ? (g.nodes.get(startId)?.parent ?? view.tableOf.get(startId))! : startId;
    const columnStarts = change.kind === 'remove_table' ? startIds(table, 'column', g, sources) : [startId];

    type Step = { prev?: string; edge?: LEdge };
    const prefixOf = new Map<string, Array<{ id: string; label: string }>>();
    const walk = (level: 'table' | 'column', starts: string[], certainty: 'direct' | 'possible', firstHop?: (e: LEdge) => boolean) => {
      const prev = new Map<string, Step>(starts.map((s) => [s, {}]));
      let frontier = [...starts];
      for (let d = 1; d <= 25 && frontier.length; d++) {
        const next: string[] = [];
        for (const n of frontier) for (const e of g.down[level].get(n) ?? []) {
          if (d === 1 && firstHop && !firstHop(e)) continue;
          if (prev.has(e.to)) continue;
          prev.set(e.to, { prev: n, edge: e });
          next.push(e.to);
        }
        frontier = next;
      }
      for (const [id, step] of prev) {
        if (!step.edge) continue;
        const chain: string[] = [];
        const edges: LEdge[] = [];
        for (let cur: string | undefined = id; cur !== undefined; cur = prev.get(cur)?.prev) { chain.unshift(cur); const e = prev.get(cur)?.edge; if (e) edges.unshift(e); }
        const path = [...(prefixOf.get(chain[0]) ?? []), ...chain.map((c) => ({ id: c, label: labelOf(c) }))];
        const srcs = LINEAGE_SOURCES.filter((s) => edges.some((e) => e.evidence.some((x) => x.source === s)));
        const draft = edges.some((e) => e.evidence.every((x) => x.draft));
        const n = nodeView(id, g, sources, chain.length - 1);
        put({ id, label: labelOf(id), category: categoryOf(n), certainty, ...(n.domain ? { domain: n.domain } : {}), ...(n.problemId ? { problemId: n.problemId } : {}), path, sources: srcs, draft });
        // The documents and processes the path passes through: the mapping, the pipeline, the job or report.
        for (const e of edges) for (const ev of e.evidence) if (ev.via) put({ id: ev.via.id, label: ev.via.label, category: ev.via.category, certainty, ...(ev.via.problemId ? { problemId: ev.via.problemId } : {}), path: path.slice(0, chain.indexOf(e.to) + 1), sources: [ev.source], draft: !!ev.draft });
      }
    };
    walk('column', columnStarts, 'direct');
    // Table-level only: edges of their own (not roll-ups of column edges) link the table to more, and so do the tables the
    // direct hits are in (a dashboard reading fct_orders when fct_orders.net_amount is hit); for remove_table everything is direct.
    const hitTables: string[] = [];
    for (const i of items.values()) {
      const t = i.certainty === 'direct' ? g.nodes.get(i.id)?.parent ?? view.tableOf.get(i.id) : undefined;
      if (!t || t === table || prefixOf.has(t)) continue;
      hitTables.push(t);
      prefixOf.set(t, i.path); // the path to the hit column; the table walk continues from its table
    }
    walk('table', [...new Set([table, ...hitTables])], change.kind === 'remove_table' ? 'direct' : 'possible', change.kind === 'remove_table' ? undefined : (e) => !e.rollup);
    // A column's own table isn't affected by a change to the column; a planned column's table is listed through its column.
    items.delete(table);
    for (const s of columnStarts) items.delete(s);
    // A table (or logical table) listed as possible whose own columns (elements) are listed as direct says nothing more.
    const directParents = new Set([...items.values()].filter((i) => i.certainty === 'direct').map((i) => g.nodes.get(i.id)?.parent ?? view.tableOf.get(i.id)).filter((x): x is string => !!x));
    for (const [id, it] of items) if (it.certainty === 'possible' && directParents.has(id)) items.delete(id);
  }

  // Business problems: of the items, and of the semantic models they belong to.
  const problemIds = new Set<string>();
  for (const it of items.values()) {
    if (it.problemId) problemIds.add(it.problemId);
    const model = view.nodes.get(it.id)?.metadata?.model;
    const pid = typeof model === 'string' ? view.nodes.get(`sem:${model}`)?.metadata?.problemId : view.nodes.get(it.id)?.metadata?.problemId;
    if (typeof pid === 'string') problemIds.add(pid);
  }
  const list = [...items.values()].sort((a, b) => IMPACT_CATEGORIES.indexOf(a.category) - IMPACT_CATEGORIES.indexOf(b.category) || (a.certainty === b.certainty ? 0 : a.certainty === 'direct' ? -1 : 1) || a.label.localeCompare(b.label));
  const byCategory = Object.fromEntries(IMPACT_CATEGORIES.map((c) => [c, list.filter((i) => i.category === c).length])) as Record<ImpactCategory, number>;
  const domains = new Map<string, ImpactItem[]>();
  for (const it of list) { const d = it.domain ?? '(no domain)'; domains.set(d, [...(domains.get(d) ?? []), it]); }
  const asset = startId.startsWith('sem:') || g.nodes.has(startId) || view.summarize(startId) ? nodeView(startId, g, sources, 0) : { id: startId, label: view.assertion(startId)?.statement ?? startId, kind: 'asset' as const, inWorkingSet: true, depth: 0 };
  const statement = new Map((sources.designs ?? []).map((d) => [d.problemId, d.statement] as const));
  return {
    change, asset, effect: EFFECT[change.kind], items: list, byCategory,
    byDomain: [...domains.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([domain, its]) => ({ domain, count: its.length, categories: IMPACT_CATEGORIES.filter((c) => its.some((i) => i.category === c)) })),
    problems: [...problemIds].sort().map((id) => ({ id, ...(statement.get(id) ? { statement: statement.get(id) } : {}) })),
    crossDomain: !!asset.domain && list.some((i) => !!i.domain && i.domain !== asset.domain),
    truncated, coverage: coverage(g)
  };
}
