import { BaseNode, BusinessRuleNode, BusinessTermNode, ColumnNode, GraphEdge, Origin, TableNode } from './types';
import { ruleOf } from '../metadata/model';
import { Assertion, AssertionKind, Evidence, TrustTier, canonicalJson, isLive, normalizeName, strongerTrust, trustToConfidence } from './assertions';
import { isMirrorPredicate } from './assertionSchemas';
import { AssertionLedger, LedgerEvent, NewAssertion } from './ledger';

/**
 * Graph ⇄ ledger (C2, v0.29.0; docs/context-layer-requirements.md §4.3).
 *
 * - **Migration / sync** (`syncGraphToLedger`): every node and edge the
 *   existing producers put in the graph (live discovery, file ingestion,
 *   business-context files, spec sync) is recorded as a *mirror* assertion
 *   (predicate `node` / `edge`, the node or edge as its value). A changed
 *   node supersedes its previous assertion; a node that disappeared is
 *   rejected (with a reason) — never deleted. Re-syncing an unchanged graph
 *   appends nothing, so migration is idempotent.
 * - **Projection** (`projectGraph`): the graph is rebuilt from live
 *   assertions. Mirrors give back exactly the nodes and edges they recorded,
 *   plus `supportedBy` and an `origin.confidence` from the trust tier; live
 *   non-mirror definitions (terms, metrics, rules, relationships) add nodes
 *   and edges of their own. Deterministic: same assertions → identical JSON.
 */

export interface GraphSnapshotLike {
  nodes: readonly BaseNode[];
  edges: readonly GraphEdge[];
}

// ── Mirrors ───────────────────────────────────────────────────────────────────

const NODE_KIND: Record<string, AssertionKind> = {
  table: 'schema_fact',
  column: 'schema_fact',
  semantic_view: 'schema_fact',
  business_term: 'business_term',
  business_rule: 'business_rule',
  metric: 'metric',
  verified_query: 'verified_query'
};

function edgeKind(edge: GraphEdge, nodeKinds: Map<string, AssertionKind>): AssertionKind {
  if (edge.type === 'contains') return 'schema_fact';
  if (edge.type === 'foreign_key') return 'relationship';
  return nodeKinds.get(edge.source) ?? 'schema_fact';
}

/** Removes what the projection adds, so a projected graph syncs back without change. */
function stripProjected<T extends BaseNode | GraphEdge>(item: T): T {
  const copy = JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
  delete copy.supportedBy;
  const origin = copy.origin as Record<string, unknown> | undefined;
  if (origin) delete origin.confidence;
  return copy as unknown as T;
}

/** Fields that change on every re-extraction without the fact changing. */
function comparable(item: BaseNode | GraphEdge): string {
  const copy = JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
  delete copy.createdAt;
  delete copy.updatedAt;
  const origin = copy.origin as Record<string, unknown> | undefined;
  if (origin) {
    delete origin.extractedAt;
    delete origin.lastVerifiedAt;
    delete origin.confidence;
  }
  delete copy.supportedBy;
  return canonicalJson(copy);
}

/** Initial trust from provenance (§4.3 migration rules). */
export function trustFromOrigin(origin: Origin | undefined): TrustTier {
  if (!origin) return 'documented';
  if (origin.reliability === 'live-verified') return 'verified';
  if (origin.source === 'llm') return 'inferred';
  if (origin.specId) return 'confirmed';
  return 'documented';
}

function evidenceFromOrigin(origin: Origin | undefined): Evidence {
  if (origin?.reliability === 'live-verified') return { type: 'introspection', ref: origin.connectionId ?? origin.sourceRef };
  if (origin?.specId) return { type: 'spec_field', ref: `spec:${origin.specId}${origin.specVersion !== undefined ? `@v${origin.specVersion}` : ''}` };
  return { type: 'file', ref: origin?.sourceRef ?? 'derived/graph.json' };
}

function nodeStatement(node: BaseNode): string {
  switch (node.type) {
    case 'table':
    case 'semantic_view': {
      const t = node as TableNode;
      return `${node.type === 'semantic_view' || t.isView ? 'View' : 'Table'} ${t.fqn || node.label} exists.`;
    }
    case 'column': {
      const c = node as ColumnNode;
      return `Column ${node.label} is ${c.dataType || 'untyped'}${c.isNullable === false ? ', not null' : ''}${c.isPrimaryKey ? ', primary key' : ''}.`;
    }
    case 'business_term': {
      const t = node as BusinessTermNode;
      return `Business term "${node.label}"${t.formula ? ` = ${t.formula}` : ''}${node.description ? `: ${node.description}` : ''}`.slice(0, 300);
    }
    case 'business_rule':
      return `Rule (${(node as BusinessRuleNode).enforcementLevel}): ${(node as BusinessRuleNode).ruleText}`.slice(0, 300);
    default:
      return `${node.type} "${node.label}".`;
  }
}

export function mirrorKey(a: Pick<Assertion, 'predicate' | 'value'>): string | undefined {
  if (!isMirrorPredicate(a.predicate)) return undefined;
  const v = a.value as { node?: { id: string }; edge?: { id: string } };
  if (a.predicate === 'node' && v.node) return `node:${v.node.id}`;
  if (a.predicate === 'edge' && v.edge) return `edge:${v.edge.id}`;
  return undefined;
}

export function isMirror(a: Pick<Assertion, 'predicate'>): boolean {
  return isMirrorPredicate(a.predicate);
}

function nodeMirror(node: BaseNode): NewAssertion {
  return {
    kind: NODE_KIND[node.type] ?? 'schema_fact',
    subject: [node.id],
    predicate: 'node',
    value: { node: stripProjected(node) },
    statement: nodeStatement(node),
    evidence: [evidenceFromOrigin(node.origin)],
    trust: trustFromOrigin(node.origin),
    status: 'active',
    specId: node.origin?.specId,
    createdBy: 'system'
  };
}

function edgeMirror(edge: GraphEdge, nodeKinds: Map<string, AssertionKind>, origins: Map<string, Origin | undefined>): NewAssertion {
  const origin = edge.origin ?? origins.get(edge.source);
  return {
    kind: edgeKind(edge, nodeKinds),
    subject: [edge.source, edge.target],
    predicate: 'edge',
    value: { edge: stripProjected(edge) },
    statement: `${edge.source} ${edge.type.replace(/_/g, ' ')} ${edge.target}.`,
    evidence: [evidenceFromOrigin(origin)],
    trust: trustFromOrigin(origin),
    status: 'active',
    specId: origin?.specId,
    createdBy: 'system'
  };
}

/**
 * Spec scoping: an assertion recorded for one business problem (`specId`) is
 * in scope only while that problem is active. Out-of-scope assertions stay
 * live in the ledger — switching problems is not a retraction — but are
 * neither retracted by a sync nor projected into the graph.
 */
export function inSpecScope(a: Pick<Assertion, 'specId'>, activeSpecId: string | undefined): boolean {
  return !a.specId || a.specId === activeSpecId;
}

export interface SyncResult {
  /** Mirrors carried over to a new id after a re-keying (Phase K1) — not a change, not a retraction. */
  rekeyed: number;
  asserted: number;
  superseded: number;
  retracted: number;
  reverified: number;
  /** Non-mirror assertions sent to review because a subject's schema fact changed or vanished (§8.1). */
  dependentsFlagged: number;
  /** Mirrors retracted because their object left the working set (Phase K2) — not a change in the source. */
  evicted: number;
  events: number;
}

/**
 * Records the graph's current content in the ledger (see the module comment).
 * `evicted` (Phase K2) names nodes that left the working set but still exist
 * in the catalog: their mirrors are retracted with that reason, and nothing
 * built on them is flagged — the source did not change.
 */
export async function syncGraphToLedger(
  ledger: AssertionLedger,
  graph: GraphSnapshotLike,
  options: { causedBy?: string; activeSpecId?: string; aliases?: ReadonlyMap<string, string>; evicted?: ReadonlySet<string> } = {}
): Promise<SyncResult> {
  const live = new Map<string, Assertion>();
  for (const a of ledger.assertions()) {
    const key = mirrorKey(a);
    if (key && isLive(a.status)) live.set(key, a);
  }
  const nodeKinds = new Map(graph.nodes.map((n) => [n.id, NODE_KIND[n.type] ?? 'schema_fact'] as const));
  const origins = new Map(graph.nodes.map((n) => [n.id, n.origin] as const));
  const observed: Array<{ key: string; item: BaseNode | GraphEdge; build: () => NewAssertion }> = [
    ...graph.nodes.map((n) => ({ key: `node:${n.id}`, item: n as BaseNode | GraphEdge, build: () => nodeMirror(n) })),
    ...graph.edges.map((e) => ({ key: `edge:${e.id}`, item: e as BaseNode | GraphEdge, build: () => edgeMirror(e, nodeKinds, origins) }))
  ];

  const events: LedgerEvent[] = [];
  const changedSubjects = new Map<string, string>(); // node id → reason
  const result: SyncResult = { rekeyed: 0, asserted: 0, superseded: 0, retracted: 0, reverified: 0, dependentsFlagged: 0, evicted: 0, events: 0 };
  const seen = new Set<string>();
  // Re-keyed ids: the new key's predecessor is the old key's live mirror.
  const predecessor = new Map<string, Assertion>();
  for (const [from, to] of options.aliases ?? []) {
    for (const prefix of ['node:', 'edge:']) {
      const old = live.get(prefix + from);
      if (old && !live.has(prefix + to)) predecessor.set(prefix + to, old);
    }
  }

  for (const { key, item, build } of observed) {
    if (seen.has(key)) continue;
    seen.add(key);
    const carried = predecessor.get(key);
    if (carried) {
      // Re-keying: same fact under a new id. Supersede the old mirror without
      // flagging dependents (their subjects follow through the alias map).
      const oldKey = mirrorKey(carried)!;
      seen.add(oldKey);
      const asserted = ledger.buildAsserted({ ...build(), supersedes: carried.id }, options.causedBy);
      events.push(asserted, ledger.buildEvent('superseded', carried.id, 'system', { by: asserted.assertionId, causedBy: asserted.id, reason: 're-keyed' }));
      result.rekeyed++;
      continue;
    }
    const existing = live.get(key);
    if (!existing) {
      events.push(ledger.buildAsserted(build(), options.causedBy));
      result.asserted++;
      continue;
    }
    const recorded = (existing.value as { node?: BaseNode; edge?: GraphEdge }).node ?? (existing.value as { edge: GraphEdge }).edge;
    if (comparable(recorded) !== comparable(item)) {
      const asserted = ledger.buildAsserted({ ...build(), supersedes: existing.id }, options.causedBy);
      events.push(asserted, ledger.buildEvent('superseded', existing.id, 'system', { by: asserted.assertionId, causedBy: asserted.id }));
      result.superseded++;
      if (key.startsWith('node:')) changedSubjects.set(key.slice(5), `the schema fact for ${key.slice(5)} changed`);
      continue;
    }
    const seenAt = item.origin?.lastVerifiedAt;
    const knownAt = existing.verification?.at ?? recorded.origin?.lastVerifiedAt;
    if (seenAt && item.origin?.reliability === 'live-verified' && (!knownAt || seenAt > knownAt)) {
      events.push(ledger.buildEvent('verified', existing.id, 'system', {
        verification: { method: 'introspection', at: seenAt, result: 'pass' },
        causedBy: options.causedBy
      }));
      result.reverified++;
    }
  }

  const evictedMirror = (key: string, a: Assertion) => {
    if (!options.evicted?.size) return false;
    if (key.startsWith('node:')) return options.evicted.has(key.slice(5));
    const e = (a.value as { edge?: GraphEdge }).edge;
    return !!e && (options.evicted.has(e.source) || options.evicted.has(e.target));
  };
  for (const [key, a] of live) {
    if (seen.has(key) || !inSpecScope(a, options.activeSpecId)) continue;
    if (evictedMirror(key, a)) {
      events.push(ledger.buildEvent('rejected', a.id, 'system', { reason: 'left the working set (unused; still in the catalog)', causedBy: options.causedBy }));
      result.evicted++;
      continue;
    }
    const ref = a.evidence[0]?.ref ?? 'its source';
    events.push(ledger.buildEvent('rejected', a.id, 'system', { reason: `no longer present in ${ref}`, causedBy: options.causedBy }));
    result.retracted++;
    if (key.startsWith('node:')) changedSubjects.set(key.slice(5), `${key.slice(5)} is no longer present in ${ref}`);
  }

  // Dependency walk (§8.1): business assertions about a changed or removed node go to review.
  if (changedSubjects.size > 0) {
    for (const a of ledger.assertions()) {
      if (isMirror(a) || a.status !== 'active') continue;
      const hit = a.subject.find((s) => changedSubjects.has(s));
      if (hit) {
        events.push(ledger.buildEvent('flagged_needs_review', a.id, 'system', { reason: changedSubjects.get(hit), causedBy: options.causedBy }));
        result.dependentsFlagged++;
      }
    }
  }

  await ledger.append(events);
  result.events = events.length;
  return result;
}

// ── Subject resolution ────────────────────────────────────────────────────────

/**
 * Deterministic entity resolution of a subject reference against the graph:
 * a node id; `term:<name>` / `metric:<name>`; a table fqn; `<table fqn>.<column>`;
 * or a label that names exactly one table. Anything else stays unresolved.
 */
export function createSubjectResolver(graph: GraphSnapshotLike): (ref: string) => string | undefined {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const byFqn = new Map<string, string>();
  const tableLabels = new Map<string, string[]>();
  const named = new Map<string, string>(); // `<type>|<normalized label>` → id
  for (const n of graph.nodes) {
    const fqn = (n as Partial<TableNode>).fqn;
    if (fqn) byFqn.set(fqn.toLowerCase(), n.id);
    if (n.type === 'table' || n.type === 'semantic_view') {
      const list = tableLabels.get(n.label.toLowerCase()) ?? [];
      list.push(n.id);
      tableLabels.set(n.label.toLowerCase(), list);
    }
    if (n.type === 'business_term' || n.type === 'metric') {
      const k = `${n.type}|${normalizeName(n.label)}`;
      if (!named.has(k)) named.set(k, n.id);
    }
  }
  const columnsOf = new Map<string, Map<string, string>>();
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  for (const e of graph.edges) {
    if (e.type !== 'contains') continue;
    const col = nodeById.get(e.target);
    if (!col || col.type !== 'column') continue;
    const m = columnsOf.get(e.source) ?? new Map<string, string>();
    m.set(col.label.toLowerCase(), col.id);
    columnsOf.set(e.source, m);
  }
  return (ref: string) => {
    if (ids.has(ref)) return ref;
    const prefixed = /^(term|metric):(.+)$/i.exec(ref);
    if (prefixed) {
      const type = prefixed[1].toLowerCase() === 'term' ? 'business_term' : 'metric';
      return named.get(`${type}|${normalizeName(prefixed[2])}`);
    }
    const lower = ref.toLowerCase();
    const table = byFqn.get(lower);
    if (table) return table;
    const dot = lower.lastIndexOf('.');
    if (dot > 0) {
      const tableId = byFqn.get(lower.slice(0, dot));
      const col = tableId ? columnsOf.get(tableId)?.get(lower.slice(dot + 1)) : undefined;
      if (col) return col;
    }
    const byLabel = tableLabels.get(lower);
    return byLabel && byLabel.length === 1 ? byLabel[0] : undefined;
  };
}

/** Resolves every subject reference; unresolved ones are kept as given and reported. */
export function resolveSubjects(refs: readonly string[], resolve: (ref: string) => string | undefined): { subject: string[]; unresolved: string[] } {
  const subject: string[] = [];
  const unresolved: string[] = [];
  for (const ref of refs) {
    const id = resolve(ref);
    if (id) subject.push(id);
    else { subject.push(ref); unresolved.push(ref); }
  }
  return { subject, unresolved };
}

// ── Projection ────────────────────────────────────────────────────────────────

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Rebuilds the graph from live assertions. Pure; output in assertion-id order. */
export function projectGraph(assertions: readonly Assertion[], options: { activeSpecId?: string } = {}): { nodes: BaseNode[]; edges: GraphEdge[] } {
  const live = assertions.filter((a) => isLive(a.status) && inSpecScope(a, options.activeSpecId)).slice().sort(byId);
  const nodes = new Map<string, Record<string, unknown>>();
  const edges = new Map<string, Record<string, unknown>>();
  const support = new Map<string, Assertion[]>();
  const addSupport = (id: string, a: Assertion) => {
    const list = support.get(id) ?? [];
    list.push(a);
    support.set(id, list);
  };

  for (const a of live) {
    if (!isMirror(a)) continue;
    const v = a.value as { node?: BaseNode; edge?: GraphEdge };
    if (a.predicate === 'node' && v.node) {
      nodes.set(v.node.id, JSON.parse(JSON.stringify(v.node)));
      addSupport(`node:${v.node.id}`, a);
    } else if (a.predicate === 'edge' && v.edge) {
      edges.set(v.edge.id, JSON.parse(JSON.stringify(v.edge)));
      addSupport(`edge:${v.edge.id}`, a);
    }
  }

  // Live non-mirror definitions add (or support) nodes and edges of their own.
  const termIds = new Map<string, string>();
  for (const [id, n] of nodes) if (n.type === 'business_term' || n.type === 'metric') termIds.set(`${String(n.type)}|${normalizeName(String(n.label))}`, id);
  for (const a of live) {
    if (isMirror(a)) continue;
    const v = (a.value ?? {}) as Record<string, unknown>;
    if (a.kind === 'business_term' && typeof v.term === 'string') {
      const existing = termIds.get(`business_term|${normalizeName(v.term)}`);
      const id = existing ?? `term:${slug(v.term)}`;
      if (!existing && !nodes.has(id)) {
        const node: BusinessTermNode = {
          id, type: 'business_term', label: v.term, description: typeof v.definition === 'string' ? v.definition : a.statement,
          formula: typeof v.formula === 'string' ? v.formula : undefined, mappedNodeIds: [], metadata: {}, version: 1,
          origin: { source: a.createdBy.startsWith('user:') ? 'user' : 'derived', sourceRef: a.evidence[0]?.ref ?? a.id, specId: a.specId }
        };
        nodes.set(id, JSON.parse(JSON.stringify(node)));
      }
      addSupport(`node:${id}`, a);
    } else if (a.kind === 'metric') {
      const name = typeof v.name === 'string' ? v.name : a.subject[0].replace(/^metric:/i, '');
      const existing = termIds.get(`metric|${normalizeName(name)}`);
      const id = existing ?? `metric:${slug(name)}`;
      if (!existing && !nodes.has(id)) {
        nodes.set(id, JSON.parse(JSON.stringify({
          id, type: 'metric', label: name, description: a.statement, version: 1,
          metadata: { expression: v.expression, definition: v.definition, grain: v.grain, filters: v.filters },
          origin: { source: a.createdBy.startsWith('user:') ? 'user' : 'derived', sourceRef: a.evidence[0]?.ref ?? a.id, specId: a.specId }
        })));
      }
      addSupport(`node:${id}`, a);
    } else if (a.kind === 'business_rule') {
      const id = `rule:${a.id}`;
      const node: BusinessRuleNode = {
        id, type: 'business_rule', label: a.statement.slice(0, 80), ruleText: typeof v.text === 'string' ? v.text : a.statement,
        // MM1: modality (mandatory = STRICT); a rule written before MM1 reads its level.
        enforcementLevel: ruleOf(a).modality === 'mandatory' ? 'STRICT' : 'RECOMMENDED', metadata: { ruleType: ruleOf(a).ruleType, modality: ruleOf(a).modality, scope: ruleOf(a).scope }, version: 1,
        origin: { source: a.createdBy.startsWith('user:') ? 'user' : 'derived', sourceRef: a.evidence[0]?.ref ?? a.id, specId: a.specId }
      };
      nodes.set(id, JSON.parse(JSON.stringify(node)));
      addSupport(`node:${id}`, a);
    } else if (a.kind === 'relationship' && a.subject.length >= 2 && nodes.has(a.subject[0]) && nodes.has(a.subject[1])) {
      const id = `rel:${a.id}`;
      edges.set(id, { id, source: a.subject[0], target: a.subject[1], type: 'related_to', weight: 0.9 });
      addSupport(`edge:${id}`, a);
    } else if (a.kind === 'lineage' && a.subject.length >= 2 && nodes.has(a.subject[0]) && nodes.has(a.subject[1])) {
      // LIN: downstream derives_from upstream, as the semantic layer's elements derive from their columns.
      const id = `lin:${a.id}`;
      edges.set(id, { id, source: a.subject[0], target: a.subject[1], type: 'derives_from', weight: 0.9 });
      addSupport(`edge:${id}`, a);
    }
  }

  const finish = (key: string, item: Record<string, unknown>) => {
    const sup = (support.get(key) ?? []).slice().sort(byId);
    if (sup.length === 0) return;
    item.supportedBy = sup.map((a) => a.id);
    const best = sup.reduce<TrustTier>((t, a) => strongerTrust(t, a.trust), 'inferred');
    const origin = item.origin as Record<string, unknown> | undefined;
    if (origin) {
      origin.confidence = trustToConfidence(best);
      const verifiedAt = sup.map((a) => (a.verification?.method === 'introspection' && a.verification.result === 'pass' ? a.verification.at : undefined)).filter(Boolean).sort().pop();
      if (verifiedAt) origin.lastVerifiedAt = verifiedAt;
    }
  };
  for (const [id, n] of nodes) finish(`node:${id}`, n);
  for (const [id, e] of edges) finish(`edge:${id}`, e);

  return {
    // Assertion-id order (creation order), not node-id order: deterministic, and it keeps
    // the order producers added things in, which order-sensitive consumers still see.
    nodes: [...nodes.values()] as unknown as BaseNode[],
    edges: [...edges.values()] as unknown as GraphEdge[]
  };
}
