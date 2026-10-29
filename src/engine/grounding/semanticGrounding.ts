import { Assertion, isLive } from '../context/assertions';
import { LayerElement, LayerTable, SemanticLayerIndex, nameRef, physicalMatches } from '../semantic/layer';
import { GroundingArtifact } from './sqlGrounding';

/**
 * The semantic grounding check (C5b; docs/specs/context-layer.md §6.5,
 * principle C3): agents don't infer joins or metrics the semantic layer
 * defines. On generated SQL, without a model:
 *
 * - **Joins.** A join between two tables the approved semantic layer covers
 *   must be one of its relationships, on the relationship's columns.
 * - **Metrics.** An aggregate named after an approved metric (or a synonym)
 *   must compute it the way the layer defines it; an aggregate named after a
 *   metric the knowledge layer knows, but the semantic layer lacks, is
 *   flagged too — the definition has to be approved first.
 *
 * Joins between tables the layer doesn't cover, and aggregates named after
 * nothing known, are not judged: the layer can only govern what it holds.
 * Like the identifier check, this is a scanner, not a SQL parser.
 */

export interface SemanticGroundingIssue {
  kind: 'join' | 'metric';
  detail: string;
  /** What to do about it. */
  fix: string;
  artifact?: string;
}

export interface SemanticGroundingResult {
  /** False when there is no approved semantic layer to check against. */
  checked: boolean;
  joinsChecked: number;
  joinsDefined: number;
  metricsChecked: number;
  metricsDefined: number;
  issues: SemanticGroundingIssue[];
  /** `model@revision` of the approved models checked against. */
  models: string[];
}

const NOT_ALIAS = new Set(['where', 'on', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'group', 'order', 'limit', 'qualify', 'using', 'union', 'having', 'window', 'as', 'lateral', 'set', 'values', 'when', 'then', 'select', 'from', 'with', 'except', 'intersect']);
const AGG = '(?:sum|count|avg|min|max|median|count_if|approx_count_distinct|stddev|variance)';
const PARENS = '\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)';
const AGG_ALIAS = new RegExp(`(${AGG}\\s*${PARENS}(?:\\s*[-+*/]\\s*(?:${AGG}\\s*${PARENS}|${PARENS}|[\\w.]+))*)\\s+as\\s+"?(\\w+)"?`, 'gi');

function strip(sql: string): string {
  return sql
    .replace(/\{\{[\s\S]*?\}\}/g, ' __jinja__ ')
    .replace(/\{[%#][\s\S]*?[%#]\}/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** Lower-cased, unqualified, unquoted, without whitespace: how two expressions are compared. */
export function normalizeExpr(expr: string): string {
  return expr.toLowerCase().replace(/["`]/g, '').replace(/\b[a-z_][a-z0-9_]*\.(?=[a-z_])/g, '').replace(/\s+/g, '');
}

/** A metric's expression with the table's elements it names replaced by their own expressions (facts are usually columns). */
function expandedForms(metric: LayerElement, index: SemanticLayerIndex): string[] {
  const own = index.elements.filter((e) => e.model === metric.model && e.table === metric.table && e.list !== 'metrics' && e.list !== 'filters');
  let expanded = metric.expr;
  for (const e of own) expanded = expanded.replace(new RegExp(`(?<![\\w.])${e.name}(?![\\w(])`, 'gi'), `(${e.expr})`);
  return [...new Set([metric.expr, expanded, expanded.replace(/\((\w+)\)/g, '$1')].map(normalizeExpr))];
}

/** Metric names the knowledge layer knows (live metric facts): flagged when the semantic layer lacks them. */
export function knownMetricNames(assertions: readonly Assertion[]): string[] {
  const out = new Set<string>();
  for (const a of assertions) {
    if (a.kind !== 'metric' || !isLive(a.status)) continue;
    const v = (a.value ?? {}) as { name?: unknown };
    const name = a.subject[0]?.startsWith('metric:') ? a.subject[0].slice(7) : typeof v.name === 'string' ? v.name : undefined;
    if (name) out.add(name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''));
  }
  return [...out];
}

export function checkSemanticGrounding(artifacts: readonly GroundingArtifact[], index: SemanticLayerIndex | undefined, options: { knownMetrics?: Iterable<string> } = {}): SemanticGroundingResult {
  const approved = (index?.models ?? []).filter((m) => m.approved);
  const result: SemanticGroundingResult = { checked: !!index && approved.length > 0, joinsChecked: 0, joinsDefined: 0, metricsChecked: 0, metricsDefined: 0, issues: [], models: approved.map((m) => `${m.name}@${m.revision}`) };
  if (!index || !result.checked) return result;
  const known = new Set([...(options.knownMetrics ?? [])].map((m) => m.toLowerCase()));
  // A name in SQL fits a semantic table where both know the part: database, schema, table (§6.4).
  const tablesFor = (ref: string): LayerTable[] => {
    const r = nameRef(ref);
    return (index.byBaseName.get(r.table) ?? []).filter((t) => physicalMatches({ ...t, binding: undefined }, r) && approved.some((m) => m.name === t.model));
  };

  for (const a of artifacts) {
    const text = strip(a.content);
    const seen = new Set<string>();
    const issue = (i: Omit<SemanticGroundingIssue, 'artifact'>) => { if (!seen.has(i.detail)) { seen.add(i.detail); result.issues.push({ ...i, artifact: a.name }); } };

    // Aliases: FROM/JOIN targets by their own name and their alias.
    const alias = new Map<string, string>();
    for (const m of text.matchAll(/\b(?:from|join)\s+([\w."$]+)(?:\s+(?:as\s+)?(\w+))?/gi)) {
      const ref = m[1];
      if (ref === '__jinja__' || ref.startsWith('(')) continue;
      alias.set(ref.toLowerCase().split('.').pop()!.replace(/"/g, ''), ref);
      const al = m[2]?.toLowerCase();
      if (al && !NOT_ALIAS.has(al)) alias.set(al, ref);
    }

    // Joins: equalities between two aliased tables in ON clauses.
    for (const on of text.matchAll(/\bon\b([\s\S]*?)(?=\b(?:left|right|inner|full|cross|join|where|group|order|qualify|limit|union|having|window|when|using)\b|;|$)/gi)) {
      for (const m of on[1].matchAll(/\b(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)\b/g)) {
        const lRef = alias.get(m[1].toLowerCase()); const rRef = alias.get(m[3].toLowerCase());
        if (!lRef || !rRef) continue;
        const lt = tablesFor(lRef); const rt = tablesFor(rRef);
        if (!lt.length || !rt.length) continue;
        const lb = new Set(lt.map((t) => t.key)); const rb = new Set(rt.map((t) => t.key));
        if ([...lb].some((b) => rb.has(b))) continue; // the same table on both sides: not a relationship
        result.joinsChecked++;
        const lc = m[2].toLowerCase(); const rc = m[4].toLowerCase();
        const between = index.relationships.filter((r) => (lb.has(r.left) && rb.has(r.right)) || (rb.has(r.left) && lb.has(r.right)));
        const matches = between.some((r) => r.columns.some((c) => (lb.has(r.left) ? c.left === lc && c.right === rc : c.left === rc && c.right === lc)));
        if (matches) { result.joinsDefined++; continue; }
        const shown = `${lRef}.${m[2]} = ${rRef}.${m[4]}`;
        if (between.length) {
          const r = between[0];
          issue({ kind: 'join', detail: `joins ${lRef} and ${rRef} on ${shown}; the semantic layer joins them on ${r.columns.map((c) => `${r.leftTable}.${c.left} = ${r.rightTable}.${c.right}`).join(' AND ')} (${r.model}: ${r.name})`, fix: `Join on the relationship's columns, or change the relationship in the semantic model ${r.model} (a person approves it).` });
        } else {
          issue({ kind: 'join', detail: `joins ${lRef} and ${rRef} on ${shown}, but the semantic layer has no relationship between them`, fix: 'Use a relationship the semantic layer defines, or propose this one in a semantic model (autode_propose_semantic_model) for a person to approve.' });
        }
      }
    }

    // Metrics: named aggregates.
    for (const m of text.matchAll(AGG_ALIAS)) {
      const expr = m[1]; const name = m[2].toLowerCase();
      const defined = index.metricsByName.get(name)?.filter((d) => approved.some((x) => x.name === d.model)) ?? [];
      if (defined.length) {
        result.metricsChecked++;
        if (defined.some((d) => expandedForms(d, index).includes(normalizeExpr(expr)))) { result.metricsDefined++; continue; }
        const d = defined[0];
        issue({ kind: 'metric', detail: `computes ${m[2]} as ${expr.replace(/\s+/g, ' ')}; the semantic layer defines ${d.name} as ${d.expr} (${d.model}: ${d.table})`, fix: `Use the definition; a different calculation is a different metric with its own name.` });
      } else if (known.has(name)) {
        result.metricsChecked++;
        issue({ kind: 'metric', detail: `computes ${m[2]}, a metric AutoDE's facts know but no approved semantic model defines`, fix: 'Add the metric to a semantic model and have it approved before building on it.' });
      }
    }
  }
  return result;
}

/** One line per issue, for manifests and refusals. */
export function describeSemanticIssues(issues: readonly SemanticGroundingIssue[]): string[] {
  return issues.map((i) => `${i.kind === 'join' ? 'Join' : 'Metric'}: ${i.detail}. ${i.fix}`);
}
