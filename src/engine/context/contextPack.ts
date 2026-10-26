import { createHash } from 'node:crypto';
import { BaseNode, BusinessRuleNode, BusinessTermNode, ColumnNode, GraphEdge, TableNode, VerifiedQueryNode } from './types';
import { Assertion, TrustTier, canonicalJson, isLive, trustRank } from './assertions';
import { Conflict } from './conflicts';
import { isMirror } from './projection';
import { GraphView, TextMatch, expandNeighborhood, resolveText } from './retrieval';
import { ContextGap, DEFAULT_MIN_TRUST, describeGap, detectRelationshipGaps } from './contextGaps';
import { CatalogLookup, selectSeedHits } from './catalog';

/**
 * Task-scoped context packs (C3, v0.30.0; docs/context-layer-requirements.md
 * §7.1). Replaces the one global dump every LLM call used to receive: each
 * call gets the context relevant to *its* task, within a token budget, and a
 * `PackManifest` records exactly what was included.
 *
 * Deterministic: same graph + assertions + request → identical text,
 * manifest and `packId`.
 */

export type PackPurpose = 'interview' | 'spec' | 'plan' | 'step' | 'chat' | 'qa';

export interface ContextPackRequest {
  purpose: PackPurpose;
  /** Explicit seed node ids. Otherwise seeds are resolved from `query`. */
  seeds?: string[];
  /** The task, question or step description seeds are resolved from. */
  query?: string;
  maxTokens?: number;
  stepId?: string;
  /** Minimum trust for a join to count as known (§7.3); default `confirmed`. */
  minJoinTrust?: TrustTier;
}

export interface ContextPackSources {
  graph: GraphView;
  assertions: readonly Assertion[];
  conflicts: readonly Conflict[];
  runtimeFacts?: ReadonlyArray<{ label: string; text: string }>;
  /** Latest extraction per `system/environment` (Phase K1), pinned in grounding manifests. */
  catalogRevisions?: Record<string, string>;
  /** The estate catalog beyond the working set (Phase K2): ranked, vocabulary-aware retrieval. */
  catalog?: CatalogLookup;
}

export interface PackManifest {
  packId: string;
  purpose: PackPurpose;
  /** `seeded` = task-scoped; `overview` = no seeds resolved, project overview (the pre-C3 dump). */
  mode: 'seeded' | 'overview';
  seeds: string[];
  query?: string;
  stepId?: string;
  /** Graph nodes rendered into the pack. */
  nodeIds: string[];
  /** Ledger assertions the pack rests on, with their revision at the time. */
  assertions: Array<{ id: string; revision: string; trust: TrustTier; status: Assertion['status'] }>;
  /** What the budget or collapsing left out, by kind. */
  truncated: Record<string, number>;
  tokenCount: number;
  maxTokens: number;
  gaps: ContextGap[];
  warnings: string[];
  /** Catalog objects rendered from the catalog because they were not in the working set yet; the host promotes them (Phase K2). */
  promoted?: string[];
}

export interface ContextPack {
  text: string;
  manifest: PackManifest;
}

const HOPS: Record<PackPurpose, number> = { interview: 1, spec: 1, plan: 1, step: 2, chat: 1, qa: 1 };
const BUDGET: Record<PackPurpose, number> = { interview: 1500, spec: 2000, plan: 2500, step: 3000, chat: 2000, qa: 2500 };
const TRUST_WEIGHT: Record<TrustTier, number> = { verified: 1.0, confirmed: 0.95, documented: 0.7, inferred: 0.4 };

/** char/4, the same heuristic as `core/tokenBudget.ts`. */
export function estimatePackTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

/** A stable content revision of an assertion (what a manifest pins). */
export function assertionRevision(a: Assertion): string {
  const { id, kind, subject, predicate, value, status, trust, supersedes, validTo } = a;
  return 'sha256:' + createHash('sha256').update(canonicalJson({ id, kind, subject, predicate, value, status, trust, supersedes, validTo })).digest('hex').slice(0, 16);
}

interface Index {
  nodes: Map<string, BaseNode>;
  columns: Map<string, ColumnNode[]>;
  tableOf: Map<string, string>;
  assertions: Map<string, Assertion>;
  bySubject: Map<string, Assertion[]>;
}

function buildIndex(src: ContextPackSources): Index {
  const nodes = new Map(src.graph.nodes.map((n) => [n.id, n] as const));
  const columns = new Map<string, ColumnNode[]>();
  const tableOf = new Map<string, string>();
  for (const e of src.graph.edges) {
    if (e.type !== 'contains') continue;
    const c = nodes.get(e.target);
    if (c && c.type === 'column') {
      columns.set(e.source, [...(columns.get(e.source) ?? []), c as ColumnNode]);
      tableOf.set(c.id, e.source);
    }
  }
  const assertions = new Map(src.assertions.map((a) => [a.id, a] as const));
  const bySubject = new Map<string, Assertion[]>();
  for (const a of src.assertions) {
    if (isMirror(a)) continue;
    for (const s of a.subject) bySubject.set(s, [...(bySubject.get(s) ?? []), a]);
  }
  return { nodes, columns, tableOf, assertions, bySubject };
}

function nodeTrust(n: BaseNode | GraphEdge, idx: Index): TrustTier {
  const tiers = (n.supportedBy ?? []).map((id) => idx.assertions.get(id)?.trust).filter((t): t is TrustTier => !!t);
  return tiers.sort((a, b) => trustRank(b) - trustRank(a))[0] ?? 'documented';
}

function isTable(n: BaseNode | undefined): n is TableNode {
  return !!n && (n.type === 'table' || n.type === 'semantic_view');
}

function tableName(t: TableNode): string {
  return t.fqn || t.label;
}

function columnLine(c: ColumnNode): string {
  const flags = [c.isPrimaryKey ? 'PK' : '', c.isNullable === false ? 'NOT NULL' : ''].filter(Boolean).join(' ');
  return `${c.label} ${c.dataType || '?'}${flags ? ' ' + flags : ''}`;
}

function reliabilityNote(n: BaseNode): string {
  return n.origin?.reliability === 'best-effort-inferred' ? ' _(file-derived, not live-verified)_' : '';
}

/** Builds a pack (see the module comment). */
export function buildContextPack(request: ContextPackRequest, input: ContextPackSources): ContextPack {
  const fromCatalog = request.query && input.catalog ? catalogSeeds(request.query, input) : undefined;
  const sources = fromCatalog?.graph ? { ...input, graph: fromCatalog.graph } : input;
  const idx = buildIndex(sources);
  const purpose = request.purpose;
  const maxTokens = request.maxTokens ?? BUDGET[purpose];
  const matches: TextMatch[] = request.query ? resolveText(request.query, sources.graph) : [];
  const seeds = [...new Set([...(request.seeds ?? []), ...matches.map((m) => m.nodeId), ...(fromCatalog?.seeds ?? [])])].filter((id) => idx.nodes.has(id));

  const gaps = request.query
    ? detectRelationshipGaps(request.query, matches, sources.graph, sources.assertions, { minTrust: request.minJoinTrust ?? DEFAULT_MIN_TRUST.relationship, stepId: request.stepId })
    : [];
  gaps.push(...(fromCatalog?.gaps ?? []).map((g) => ({ ...g, stepId: request.stepId })));

  const parts: string[] = [];
  if (sources.runtimeFacts && sources.runtimeFacts.length > 0) {
    parts.push('## Live Session Facts');
    for (const f of sources.runtimeFacts) parts.push(`- **${f.label}**: ${f.text}`);
  }

  const result = seeds.length === 0
    ? renderOverview(sources, idx)
    : renderSeeded(seeds, purpose, maxTokens - estimatePackTokens(parts.join('\n')), sources, idx, gaps);
  if (seeds.length === 0 && gaps.length > 0) {
    // Nothing resolved to a loaded object, but something is known to be missing: say so.
    result.lines.push('### Warnings', ...gaps.map((g) => `- **Context gap:** ${describeGap(g)}`));
    result.warnings.push(...gaps.map((g) => `gap:${g.needed}:${g.subject.join('+')}`));
  }
  if (fromCatalog && fromCatalog.invisible.length > 0) {
    // Item 8: say what can't be seen instead of omitting it silently.
    const note = `- **Not visible:** ${fromCatalog.invisible.length} object(s) in scope are not visible with your current grants (${fromCatalog.invisible.slice(0, 5).join(', ')}${fromCatalog.invisible.length > 5 ? ', …' : ''}).`;
    const at = result.lines.indexOf('### Warnings');
    if (at >= 0) result.lines.splice(at + 1, 0, note);
    else result.lines.push('### Warnings', note);
    result.warnings.push(...fromCatalog.invisible.map((f) => `invisible:${f}`));
  }
  if (result.lines.length > 0) parts.push(...result.lines);

  const text = parts.join('\n');
  const assertionIds = new Set<string>();
  for (const id of result.nodeIds) for (const s of idx.nodes.get(id)?.supportedBy ?? []) assertionIds.add(s);
  for (const id of result.extraAssertions) assertionIds.add(id);
  const assertions = [...assertionIds].map((id) => idx.assertions.get(id)).filter((a): a is Assertion => !!a)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((a) => ({ id: a.id, revision: assertionRevision(a), trust: a.trust, status: a.status }));
  const manifestCore = {
    purpose,
    mode: seeds.length === 0 ? 'overview' as const : 'seeded' as const,
    seeds,
    query: request.query,
    stepId: request.stepId,
    nodeIds: result.nodeIds,
    assertions,
    truncated: result.truncated,
    tokenCount: estimatePackTokens(text),
    maxTokens,
    gaps,
    warnings: result.warnings,
    ...(fromCatalog && fromCatalog.promoted.length > 0 ? { promoted: fromCatalog.promoted.filter((id) => result.nodeIds.includes(id)) } : {})
  };
  const packId = 'pack-' + createHash('sha256').update(canonicalJson({ purpose, seeds, query: request.query, stepId: request.stepId, text })).digest('hex').slice(0, 20);
  return { text, manifest: { packId, ...manifestCore } };
}

/**
 * Phase K2 (items 4, 8, 12): the request's best catalog matches. Objects in
 * the working set are seeds as they are; objects whose structure the catalog
 * holds are added to this pack's graph view (and reported for promotion);
 * name-only objects raise a `structure` gap; objects hidden by grants are
 * counted for the visibility warning.
 */
function catalogSeeds(query: string, sources: ContextPackSources): { seeds: string[]; graph?: GraphView; promoted: string[]; gaps: ContextGap[]; invisible: string[] } {
  const catalog = sources.catalog!;
  const hits = selectSeedHits(catalog.search(query));
  if (hits.length === 0) return { seeds: [], promoted: [], gaps: [], invisible: [] };
  const inGraph = new Set(sources.graph.nodes.map((n) => n.id));
  const seeds: string[] = [];
  const promoted: string[] = [];
  const gaps: ContextGap[] = [];
  const invisible: string[] = [];
  for (const h of hits) {
    const entry = catalog.get(h.id);
    const name = entry?.table.fqn ?? h.id;
    if (!h.visible) { invisible.push(name); continue; }
    if (inGraph.has(h.id)) { seeds.push(h.id); continue; }
    if (h.tier === 0) {
      gaps.push({ needed: 'structure', subject: [h.id], text: name, reason: 'absent', minTrust: 'documented' });
      continue;
    }
    seeds.push(h.id);
    promoted.push(h.id);
  }
  if (promoted.length === 0) return { seeds, promoted, gaps, invisible };
  const extra = catalog.toGraph(promoted);
  return { seeds, promoted, gaps, invisible, graph: { nodes: [...sources.graph.nodes, ...extra.nodes], edges: [...sources.graph.edges, ...extra.edges] } };
}

interface Rendered { lines: string[]; nodeIds: string[]; extraAssertions: string[]; truncated: Record<string, number>; warnings: string[] }

/**
 * No seeds: the project overview — exactly what `buildContextPrompt()`
 * rendered before C3 (STRICT rules, the first 20 tables, all terms, 5 query
 * labels), so callers with nothing to scope by see no change.
 */
function renderOverview(sources: ContextPackSources, idx: Index): Rendered {
  const nodes = sources.graph.nodes;
  const of = <T extends BaseNode>(type: string) => nodes.filter((n) => n.type === type) as T[];
  const tables = of<TableNode>('table');
  const terms = of<BusinessTermNode>('business_term');
  const queries = of<VerifiedQueryNode>('verified_query');
  const rules = of<BusinessRuleNode>('business_rule');
  const lines: string[] = [];
  const nodeIds: string[] = [];
  const truncated: Record<string, number> = {};
  if (tables.length === 0 && terms.length === 0 && queries.length === 0) return { lines, nodeIds, extraAssertions: [], truncated, warnings: [] };
  lines.push('## Enterprise Context Layer');
  const strict = rules.filter((r) => r.enforcementLevel === 'STRICT');
  if (strict.length > 0) {
    lines.push('### Business Rules (STRICT)');
    for (const r of strict) { lines.push(`- **${r.label}**: ${r.ruleText}`); nodeIds.push(r.id); }
  }
  if (tables.length > 0) {
    lines.push('### Database Tables');
    for (const t of tables.slice(0, 20)) {
      lines.push(`- \`${tableName(t)}\`${t.description ? ' — ' + t.description : ''}${reliabilityNote(t)}`);
      nodeIds.push(t.id);
    }
    if (tables.length > 20) { lines.push(`- ... and ${tables.length - 20} more tables`); truncated.tables = tables.length - 20; }
  }
  if (terms.length > 0) {
    lines.push('### Business Terms');
    for (const t of terms) {
      lines.push(`- **${t.label}**${t.formula ? ` (formula: ${t.formula})` : ''}${t.description ? ': ' + t.description : ''}`);
      nodeIds.push(t.id);
    }
  }
  if (queries.length > 0) {
    lines.push('### Verified SQL Queries');
    for (const q of queries.slice(0, 5)) { lines.push(`- **${q.label}** (${q.dialect})`); nodeIds.push(q.id); }
    if (queries.length > 5) truncated.queries = queries.length - 5;
  }
  void idx;
  return { lines, nodeIds, extraAssertions: [], truncated, warnings: [] };
}

function renderSeeded(seeds: string[], purpose: PackPurpose, budget: number, sources: ContextPackSources, idx: Index, gaps: ContextGap[]): Rendered {
  // A seed column brings in its table; the table is what gets rendered.
  const seedTables = new Set<string>();
  const seedOthers = new Set<string>();
  for (const s of seeds) {
    const n = idx.nodes.get(s)!;
    if (isTable(n)) seedTables.add(s);
    else if (n.type === 'column' && idx.tableOf.has(s)) seedTables.add(idx.tableOf.get(s)!);
    else seedOthers.add(s);
  }
  const reached = expandNeighborhood(sources.graph, [...seedTables, ...seedOthers], { maxHops: HOPS[purpose] });
  const score = (id: string) => {
    const n = idx.nodes.get(id);
    return n ? (reached.get(id)?.relevance ?? 0) * TRUST_WEIGHT[nodeTrust(n, idx)] : 0;
  };
  const byScore = (ids: Iterable<string>) => [...ids].sort((a, b) => score(b) - score(a) || (a < b ? -1 : 1));

  const lines: string[] = ['## Enterprise Context Layer', `_Context selected for this ${purpose}: ${seedTables.size} table(s) in scope._`];
  const nodeIds: string[] = [];
  const extra: string[] = [];
  const truncated: Record<string, number> = {};
  const warnings: string[] = [];
  let used = estimatePackTokens(lines.join('\n'));
  const fits = (block: string[]) => used + estimatePackTokens(block.join('\n')) <= budget;
  const push = (block: string[]) => { lines.push(...block); used += estimatePackTokens(block.join('\n')); };
  const scope = new Set<string>([...reached.keys(), ...seedTables]);
  for (const t of seedTables) for (const c of idx.columns.get(t) ?? []) scope.add(c.id);

  // ── Mandatory: warnings (conflicts, items under review, context gaps) ──
  const warn: string[] = [];
  for (const c of sources.conflicts) {
    const touches = c.subject.some((s) => scope.has(s)) || c.ids.some((id) => (idx.assertions.get(id)?.subject ?? []).some((s) => scope.has(s)));
    if (!touches) continue;
    warn.push(`- **Conflict (${c.rule})** — do not pick a side without asking: ${c.sides.join(' **vs** ')}`);
    warnings.push(`conflict:${c.key}`);
    extra.push(...c.ids);
  }
  for (const s of scope) {
    for (const a of idx.bySubject.get(s) ?? []) {
      if (a.status !== 'needs_review' || warnings.includes(`review:${a.id}`)) continue;
      warn.push(`- **Under review:** ${a.statement}${a.reviewReason ? ` (${a.reviewReason})` : ''}`);
      warnings.push(`review:${a.id}`);
      extra.push(a.id);
    }
  }
  for (const g of gaps) {
    warn.push(`- **Context gap:** ${describeGap(g)}`);
    warnings.push(`gap:${g.needed}:${g.subject.join('+')}`);
  }
  if (warn.length > 0) push(['### Warnings', ...warn]);

  // ── Mandatory: STRICT rules touching the scope — linked to it, or naming a seed
  // table or one of its columns (PII rules name columns: "email and phone …") ──
  const names = [...seedTables].map((t) => (idx.nodes.get(t) as TableNode)).flatMap((t) => [tableName(t).toLowerCase(), t.label.toLowerCase()]);
  const seedColumns = new Set([...seedTables].flatMap((t) => (idx.columns.get(t) ?? []).map((c) => c.label.toLowerCase())).filter((c) => c.length >= 4));
  const mentions = (text: string) => {
    const lower = text.toLowerCase();
    return names.some((nm) => lower.includes(nm)) || (lower.match(/[a-z_][a-z0-9_]*/g) ?? []).some((w) => seedColumns.has(w));
  };
  const strict = sources.graph.nodes.filter((n): n is BusinessRuleNode => n.type === 'business_rule' && (n as BusinessRuleNode).enforcementLevel === 'STRICT')
    .filter((r) => scope.has(r.id) || mentions(r.ruleText));
  if (strict.length > 0) {
    push(['### Business Rules (STRICT)', ...strict.map((r) => `- **${r.label}**: ${r.ruleText}`)]);
    nodeIds.push(...strict.map((r) => r.id));
  }

  // ── Mandatory: keys and grain on seed tables (declared PKs are in the column list) ──
  const keyLines: string[] = [];
  for (const t of seedTables) {
    for (const a of idx.bySubject.get(t) ?? []) {
      if ((a.kind !== 'key' && a.kind !== 'grain') || !isLive(a.status)) continue;
      keyLines.push(`- ${a.kind === 'grain' ? 'Grain' : 'Key'} of \`${tableName(idx.nodes.get(t) as TableNode)}\`: (${(a.value as string[]).join(', ')}) — ${a.trust}`);
      extra.push(a.id);
    }
  }

  // ── Tables: seeds with columns, reached neighbours collapsed ──
  const tableBlock: string[] = ['### Tables'];
  let shownTables = 0;
  let collapsedCols = 0;
  for (const t of byScore(seedTables)) {
    const node = idx.nodes.get(t) as TableNode;
    const cols = idx.columns.get(t) ?? [];
    const head = `- \`${tableName(node)}\`${node.description ? ' — ' + node.description : ''}${reliabilityNote(node)}`;
    const full = [head, `  - columns: ${cols.map(columnLine).join(', ') || '(none known)'}`];
    if (fits([...tableBlock, ...full])) {
      tableBlock.push(...full);
      nodeIds.push(t, ...cols.map((c) => c.id));
    } else if (fits([...tableBlock, head])) {
      tableBlock.push(head, `  - +${cols.length} columns not shown (budget)`);
      nodeIds.push(t);
      collapsedCols += cols.length;
    } else {
      truncated.tables = (truncated.tables ?? 0) + 1;
      continue;
    }
    shownTables++;
  }
  const neighbours = byScore([...reached.keys()].filter((id) => !seedTables.has(id) && isTable(idx.nodes.get(id))));
  for (const t of neighbours) {
    const node = idx.nodes.get(t) as TableNode;
    const line = `- \`${tableName(node)}\` (related; ${(idx.columns.get(t) ?? []).length} columns)`;
    if (!fits([...tableBlock, line])) { truncated.tables = (truncated.tables ?? 0) + 1; continue; }
    tableBlock.push(line);
    nodeIds.push(t);
  }
  if (collapsedCols) truncated.columns = collapsedCols;
  if (shownTables + neighbours.length > 0) push(tableBlock);
  if (keyLines.length > 0) push(['### Keys and grain', ...keyLines]);

  // ── Relationships among tables in the pack ──
  const inPack = new Set(nodeIds);
  const tableOfNode = (id: string) => idx.tableOf.get(id) ?? id;
  const rels = sources.graph.edges.filter((e) => (e.type === 'foreign_key' || e.type === 'related_to') && inPack.has(tableOfNode(e.source)) && inPack.has(tableOfNode(e.target)));
  if (rels.length > 0) {
    const block = ['### Relationships', ...rels.map((e) => `- ${e.source} → ${e.target} (${e.type.replace('_', ' ')}, ${nodeTrust(e, idx)})`)];
    if (fits(block)) {
      push(block);
      for (const e of rels) extra.push(...(e.supportedBy ?? []));
    } else truncated.relationships = rels.length;
  }

  // ── Terms, metrics and verified queries reached from the seeds ──
  const defs = byScore([...scope].filter((id) => {
    const n = idx.nodes.get(id);
    return !!n && (n.type === 'business_term' || n.type === 'metric');
  }));
  const termBlock = ['### Business Terms'];
  for (const id of defs) {
    const n = idx.nodes.get(id) as BusinessTermNode;
    const line = `- **${n.label}**${n.formula ? ` (formula: ${n.formula})` : ''}${n.description ? ': ' + n.description : ''}`;
    if (!fits([...termBlock, line])) { truncated.terms = (truncated.terms ?? 0) + 1; continue; }
    termBlock.push(line);
    nodeIds.push(id);
  }
  if (termBlock.length > 1) push(termBlock);
  const queries = [...scope].map((id) => idx.nodes.get(id)).filter((n): n is VerifiedQueryNode => !!n && n.type === 'verified_query');
  if (queries.length > 0) {
    const block = ['### Verified SQL Queries', ...queries.slice(0, 5).map((q) => `- **${q.label}** (${q.dialect})`)];
    if (fits(block)) { push(block); nodeIds.push(...queries.slice(0, 5).map((q) => q.id)); } else truncated.queries = queries.length;
  }

  // ── Chat only (C4b): the facts an answer may cite, with their ids ──
  if (purpose === 'chat') {
    const citable = [...new Set([...extra, ...nodeIds.flatMap((id) => idx.nodes.get(id)?.supportedBy ?? [])])]
      .map((id) => idx.assertions.get(id))
      .filter((a): a is Assertion => !!a && !isMirror(a) && (isLive(a.status) || a.status === 'proposed'))
      .slice(0, 15);
    const block = ['### Facts (cite as [fact:<id>])', ...citable.map((a) => `- [${a.id}] ${a.statement} (${a.status === 'proposed' ? 'proposed, not confirmed' : a.trust})`)];
    if (citable.length && fits(block)) { push(block); extra.push(...citable.map((a) => a.id)); }
  }

  const dropped = Object.entries(truncated).filter(([, n]) => n > 0);
  if (dropped.length > 0) lines.push(`_Not shown (token budget): ${dropped.map(([k, n]) => `${n} ${k}`).join(', ')}._`);
  return { lines, nodeIds: [...new Set(nodeIds)], extraAssertions: [...new Set(extra)], truncated, warnings };
}

/** Renders a manifest as readable markdown ("What the agent saw"). */
export function renderPackManifest(pack: ContextPack, title: string): string {
  const m = pack.manifest;
  const L = [`# What the agent saw — ${title}`, ''];
  L.push(`- **Pack:** \`${m.packId}\` (${m.purpose}, ${m.mode}), ${m.tokenCount} of ${m.maxTokens} tokens`);
  if (m.query) L.push(`- **Task:** ${m.query}`);
  L.push(`- **Seeds:** ${m.seeds.length ? m.seeds.map((s) => `\`${s}\``).join(', ') : '_none — project overview_'}`);
  L.push(`- **Assertions relied on:** ${m.assertions.length} (${(['verified', 'confirmed', 'documented', 'inferred'] as TrustTier[]).map((t) => `${m.assertions.filter((a) => a.trust === t).length} ${t}`).join(', ')})`);
  const tr = Object.entries(m.truncated).filter(([, n]) => n > 0);
  if (tr.length) L.push(`- **Left out:** ${tr.map(([k, n]) => `${n} ${k}`).join(', ')}`);
  if (m.gaps.length) L.push(`- **Context gaps:** ${m.gaps.map(describeGap).join(' ')}`);
  L.push('', '## Context as sent', '', '```markdown', pack.text, '```');
  return L.join('\n') + '\n';
}
