import { Assertion, TrustTier, isLive, normalizeName, trustRank } from './assertions';
import { GraphView, resolveText } from './retrieval';
import { isMirror } from './projection';
import { CandidateFinding, TableShape, changeColumnCandidates, foreignKeyCandidates, knownKey, tableShapes } from './dataCandidates';
import { governanceCandidates, governanceFacts, sameTable } from '../governance/governance';
import type { BusinessProblemSpec } from '../types';

/**
 * What must be known — a deterministic checklist (C4c;
 * docs/context-layer-requirements.md §5.5 item 1). From the specification and
 * the estate, AutoDE lists what a complete picture of the problem needs: per
 * table in scope its key, grain, change column, load pattern, personal-data
 * classification, relationships to the other tables in scope and a business
 * description; per metric the specification names its definition, grain and
 * filters. Every item is known, proposed, assumed, a candidate, or missing,
 * and every item not known carries the action that closes it. The model can
 * be shallow; it can't silently skip.
 */

export type ItemStatus = 'known' | 'assumed' | 'proposed' | 'candidate' | 'missing';
export type ActionType = 'probe' | 'confirm' | 'question' | 'classify';

export interface CoverageAction { type: ActionType; text: string }

export interface CoverageItem {
  item: 'key' | 'grain' | 'change_column' | 'load_pattern' | 'classification' | 'relationships' | 'description' | 'definition' | 'filters';
  status: ItemStatus;
  detail: string;
  trust?: TrustTier;
  facts?: string[];
  action?: CoverageAction;
}

export interface TableCoverage { table: string; fqn: string; items: CoverageItem[]; known: number; total: number }
export interface MetricCoverage { metric: string; fact?: string; items: CoverageItem[]; known: number; total: number }

export interface CoverageReport {
  tables: TableCoverage[];
  metrics: MetricCoverage[];
  known: number;
  total: number;
  /** Every item not known, with its action, in table then metric order. */
  actions: Array<CoverageAction & { subject: string; item: CoverageItem['item'] }>;
}

const TABLE_VIA = new Set(['fqn', 'label', 'schema']);

function specText(spec: Partial<BusinessProblemSpec>): string {
  return [
    spec.problemStatement, ...(spec.objectives ?? []), ...(spec.scope?.in ?? []), ...(spec.keyEntities ?? []),
    ...(spec.businessRequirements ?? []), ...(spec.dataFlows ?? []).map((f) => `${f.source} ${f.target} ${f.description}`),
    ...(spec.sourceCatalog ?? []).map((s) => `${s.name} ${s.description ?? ''}`), ...(spec.successCriteria ?? [])
  ].filter(Boolean).join('\n');
}

/** The tables the specification names (resolved against the estate the way packs resolve text), plus any given. */
export function inScopeTables(graph: GraphView, spec: Partial<BusinessProblemSpec>, extra: readonly string[] = []): string[] {
  const found = resolveText(specText(spec).replace(/\*/g, ''), graph).filter((m) => TABLE_VIA.has(m.via)).map((m) => m.nodeId);
  const tables = new Set(graph.nodes.filter((n) => n.type === 'table' || n.type === 'semantic_view').map((n) => n.id));
  return [...new Set([...found, ...extra])].filter((id) => tables.has(id));
}

const METRIC_NOUN = /\b((?:[a-z0-9][a-z0-9-]* ){0,2}(?:revenue|sales|retention|churn|margin|profit|cost|conversion|ltv|aov|gmv|arpu|spend|turnover|lifetime value|average order value)s?)\b/g;
const LEADING = new Set(['the', 'a', 'an', 'daily', 'weekly', 'monthly', 'yearly', 'annual', 'quarterly', 'needs', 'need', 'and', 'or', 'of', 'for', 'in', 'on', 'with', 'our', 'their', 'its', 'report', 'reporting', 'reports', 'by', 'per', 'to', 'is', 'are', 'all', 'each']);

/** Metric names the specification's text uses (deterministic: business nouns like revenue, retention, churn, margin). */
export function specMetricNames(spec: Partial<BusinessProblemSpec>): string[] {
  const names: string[] = [];
  for (const m of specText(spec).toLowerCase().replace(/[*_`]/g, ' ').matchAll(METRIC_NOUN)) {
    const words = m[1].split(' ');
    while (words.length > 1 && LEADING.has(words[0])) words.shift();
    names.push(words.join(' '));
  }
  // A name contained in a longer one is the same metric ("retention" in "90-day customer retention").
  const unique = [...new Set(names)];
  return unique.filter((n) => !unique.some((o) => o !== n && o.includes(n)));
}

const liveOrProposed = (a: Assertion) => !isMirror(a) && (isLive(a.status) || a.status === 'proposed');

function statusOf(a: Assertion): { status: ItemStatus; trust?: TrustTier } {
  if (a.status === 'proposed') return { status: 'proposed', trust: a.trust };
  if (a.trust === 'assumed') return { status: 'assumed', trust: a.trust };
  return { status: trustRank(a.trust) >= trustRank('documented') ? 'known' : 'proposed', trust: a.trust };
}

function best(facts: readonly Assertion[]): Assertion | undefined {
  const rank = (a: Assertion) => (a.status === 'proposed' ? 0 : 10) + trustRank(a.trust);
  return [...facts].sort((x, y) => rank(y) - rank(x))[0];
}

function fromFacts(item: CoverageItem['item'], facts: readonly Assertion[], describe: (a: Assertion) => string, missing: () => CoverageItem): CoverageItem {
  const a = best(facts);
  if (!a) return missing();
  const s = statusOf(a);
  return {
    item, ...s, detail: describe(a), facts: facts.map((f) => f.id),
    ...(s.status === 'proposed' ? { action: { type: 'confirm' as const, text: `Confirm or correct it in the Context Inbox (fact ${a.id}).` } } : s.status === 'assumed' ? { action: { type: 'confirm' as const, text: `Assumed in exploration mode: confirm or replace it before the problem is governed (fact ${a.id}).` } } : {})
  };
}

function tableCoverage(t: TableShape, scope: readonly TableShape[], assertions: readonly Assertion[], graph: GraphView, input: CoverageInput): TableCoverage {
  const about = assertions.filter((a) => liveOrProposed(a) && a.subject[0] === t.id);
  const probe = input.probesAvailable
    ? { type: 'probe' as const, text: 'Find candidates from the data (`autode capture candidates`, or AutoDE: Find Candidates from Data).' }
    : undefined;
  const items: CoverageItem[] = [];
  const key = knownKey(t, assertions);
  items.push(key?.source === 'declared'
    ? { item: 'key', status: 'known', detail: `(${key.columns.join(', ')}), declared in its schema` }
    : fromFacts('key', about.filter((a) => a.kind === 'key'), (a) => `(${(a.value as unknown[]).join(', ')}) — ${a.statement}`,
      () => ({ item: 'key', status: 'missing', detail: 'no key is declared or recorded', action: probe ?? { type: 'question', text: `What uniquely identifies a row of ${t.fqn}?` } })));
  items.push(fromFacts('grain', about.filter((a) => a.kind === 'grain'), (a) => `one row per (${(a.value as unknown[]).join(', ')})`,
    () => ({ item: 'grain', status: 'missing', detail: 'no grain is recorded', action: key ? { type: 'question', text: `Is ${t.fqn} one row per (${key.columns.join(', ')})? Record its grain.` } : probe ?? { type: 'question', text: `What does one row of ${t.fqn} represent?` } })));
  const changes = changeColumnCandidates(t);
  items.push(fromFacts('change_column', about.filter((a) => a.kind === 'data_fact' && a.predicate === 'change_column'), (a) => `${String((a.value as { column?: unknown }).column ?? '')}`,
    () => changes.length
      ? { item: 'change_column', status: 'candidate', detail: `${changes[0]} looks like it (name and type)`, action: { type: 'probe', text: 'Record it with the data candidates (`autode capture candidates`).' } }
      : { item: 'change_column', status: 'missing', detail: 'no column looks like a change timestamp', action: { type: 'question', text: `Which column tells when a row of ${t.fqn} changed, or is it always loaded in full?` } }));
  items.push(fromFacts('load_pattern', about.filter((a) => a.predicate === 'load_pattern'), (a) => a.statement,
    () => ({ item: 'load_pattern', status: 'missing', detail: 'how it is loaded is not recorded', action: { type: 'question', text: `How is ${t.fqn} loaded: in full, incrementally by a change column, or by change data capture?` } })));
  // Personal data: every column that looks personal (by name, or by value shape when probed) must be classified.
  const facts = governanceFacts(assertions);
  const named = governanceCandidates([{ fqn: t.fqn, columns: t.columns.map((c) => c.name) }], facts);
  const shaped = (input.findings ?? []).filter((f) => f.kind === 'personal_data' && f.table === t.id).map((f) => f.columns[0]);
  const classified = new Set(facts.filter((f) => sameTable(f.table, t.fqn)).map((f) => f.column));
  const open = [...new Set([...named.filter((c) => !c.fact).map((c) => c.column), ...shaped.filter((c) => !classified.has(c.toLowerCase()))])];
  items.push(open.length
    ? { item: 'classification', status: 'missing', detail: `${open.join(', ')} look${open.length === 1 ? 's' : ''} like personal data and ${open.length === 1 ? 'is' : 'are'} not classified`, action: { type: 'classify', text: `Classify ${open.join(', ')} (\`autode governance classify\`, or AutoDE: Classify Personal Data).` } }
    : { item: 'classification', status: 'known', detail: named.length ? `${named.length} personal-data column(s) classified` : `no column looks like personal data${input.findings ? '' : ' by name'}` });
  if (scope.length > 1) {
    const others = scope.filter((o) => o.id !== t.id);
    const rel = assertions.filter((a) => liveOrProposed(a) && a.kind === 'relationship' && a.subject.includes(t.id) && others.some((o) => a.subject.includes(o.id)));
    const fkEdges = graph.edges.filter((e) => e.type === 'foreign_key' && others.some((o) => (e.source.startsWith(t.id) && e.target.startsWith(o.id)) || (e.source.startsWith(o.id) && e.target.startsWith(t.id))));
    const keys = new Map(scope.map((s) => [s.id, knownKey(s, assertions)?.columns ?? []] as const));
    const fks = foreignKeyCandidates(scope, keys).filter((f) => f.from.table === t.id || f.to.table === t.id);
    items.push(fkEdges.length
      ? { item: 'relationships', status: 'known', detail: `${fkEdges.length} declared foreign key(s) to tables in scope` }
      : fromFacts('relationships', rel, (a) => a.statement, () => fks.length
        ? { item: 'relationships', status: 'candidate', detail: fks.map((f) => `${f.from.fqn}.${f.from.columns[0]} → ${f.to.fqn}.${f.to.columns[0]}`).join('; '), action: probe ?? { type: 'question', text: `Confirm how ${t.fqn} joins the other tables in scope.` } }
        : { item: 'relationships', status: 'missing', detail: `nothing relates it to ${others.map((o) => o.fqn).join(', ')}`, action: { type: 'question', text: `How does ${t.fqn} relate to ${others.map((o) => o.fqn).join(', ')} (which columns), if at all?` } }));
  }
  const terms = assertions.filter((a) => liveOrProposed(a) && a.kind === 'business_term' && (a.subject.includes(t.id) || ((a.value as { boundTo?: string[] })?.boundTo ?? []).includes(t.id)));
  items.push(t.description?.trim()
    ? { item: 'description', status: 'known', detail: t.description.trim().slice(0, 120) }
    : fromFacts('description', terms, (a) => a.statement, () => ({ item: 'description', status: 'missing', detail: 'no business description', action: { type: 'question', text: `What does ${t.fqn} hold, in business terms?` } })));
  return { table: t.id, fqn: t.fqn, items, known: items.filter((i) => i.status === 'known').length, total: items.length };
}

function metricCoverage(name: string, fact: Assertion | undefined): MetricCoverage {
  const v = (fact?.value ?? {}) as { expression?: string; definition?: string; grain?: string[]; filters?: string[] };
  const s = fact ? statusOf(fact) : undefined;
  const ask = (what: string): CoverageAction => ({ type: 'question', text: `${what} of the metric "${name}".` });
  const confirm = fact && s && s.status !== 'known' ? { type: 'confirm' as const, text: `Confirm or correct it in the Context Inbox (fact ${fact.id}).` } : undefined;
  const item = (i: CoverageItem['item'], present: boolean, detail: string, missing: string): CoverageItem => present && s
    ? { item: i, status: s.status, trust: s.trust, detail, facts: [fact!.id], ...(confirm ? { action: confirm } : {}) }
    : { item: i, status: 'missing', detail: missing, action: ask(i === 'definition' ? 'Give the expression or definition' : i === 'grain' ? 'Give the grain (one value per …)' : 'Give the filters (or say there are none)') };
  const items = [
    item('definition', !!(v.expression || v.definition), v.expression ?? v.definition ?? '', 'not defined'),
    item('grain', !!v.grain?.length, `per ${v.grain?.join(', ')}`, 'no grain recorded'),
    item('filters', Array.isArray(v.filters), v.filters?.length ? v.filters.join('; ') : 'none', 'filters not recorded')
  ];
  return { metric: name, fact: fact?.id, items, known: items.filter((i) => i.status === 'known').length, total: items.length };
}

export interface CoverageInput {
  graph: GraphView;
  assertions: readonly Assertion[];
  spec: Partial<BusinessProblemSpec>;
  /** More tables in scope (e.g. the mapping's sources). */
  tableIds?: readonly string[];
  /** Whether a connection or sample can run probes (decides the action for a missing key). */
  probesAvailable?: boolean;
  /** Data candidates already found (personal data by value shape). */
  findings?: readonly CandidateFinding[];
}

export function captureCoverage(input: CoverageInput): CoverageReport {
  const scope = tableShapes(input.graph, inScopeTables(input.graph, input.spec, input.tableIds));
  const tables = scope.map((t) => tableCoverage(t, scope, input.assertions, input.graph, input));
  const metricFacts = input.assertions.filter((a) => liveOrProposed(a) && a.kind === 'metric');
  const nameOf = (a: Assertion) => String((a.value as { name?: unknown })?.name ?? a.subject[0] ?? '');
  const named = specMetricNames(input.spec);
  const matching = (n: string) => metricFacts.filter((a) => { const x = normalizeName(nameOf(a)); const y = normalizeName(n); return x === y || x.includes(y) || y.includes(x); });
  const metrics: MetricCoverage[] = named.map((n) => metricCoverage(n, best(matching(n))));
  for (const a of metricFacts.filter((m) => m.specId && m.specId === input.spec.id && !named.some((n) => matching(n).includes(m)))) metrics.push(metricCoverage(nameOf(a), a));
  const actions: CoverageReport['actions'] = [];
  for (const t of tables) for (const i of t.items) if (i.action) actions.push({ ...i.action, subject: t.fqn, item: i.item });
  for (const m of metrics) for (const i of m.items) if (i.action) actions.push({ ...i.action, subject: m.metric, item: i.item });
  const all = [...tables, ...metrics];
  return { tables, metrics, known: all.reduce((n, x) => n + x.known, 0), total: all.reduce((n, x) => n + x.total, 0), actions };
}

const MARK: Record<ItemStatus, string> = { known: '✓', assumed: '~', proposed: '?', candidate: '◦', missing: '✗' };

export function renderCoverage(r: CoverageReport): string {
  const lines = [`# Capture coverage: ${r.known} of ${r.total} known`, '', '✓ known · ? proposed (waiting for a person) · ~ assumed (exploration) · ◦ candidate (found, not recorded) · ✗ missing', ''];
  if (!r.tables.length) lines.push('No table in scope: the specification names no table AutoDE knows. Bring the sources into the estate, or name the tables in the specification.', '');
  for (const t of r.tables) {
    lines.push(`## ${t.fqn} (${t.known}/${t.total})`);
    for (const i of t.items) lines.push(`- ${MARK[i.status]} ${i.item.replace('_', ' ')}: ${i.detail}${i.action ? ` → ${i.action.text}` : ''}`);
    lines.push('');
  }
  for (const m of r.metrics) {
    lines.push(`## Metric: ${m.metric} (${m.known}/${m.total})`);
    for (const i of m.items) lines.push(`- ${MARK[i.status]} ${i.item}: ${i.detail}${i.action ? ` → ${i.action.text}` : ''}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
