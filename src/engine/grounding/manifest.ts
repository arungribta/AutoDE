import { BaseNode, BusinessRuleNode, ColumnNode, GraphEdge } from '../context/types';
import { Assertion, TrustTier, isLive, trustRank } from '../context/assertions';
import { createSubjectResolver, isMirror } from '../context/projection';
import { ContextGap, DEFAULT_MIN_TRUST } from '../context/contextGaps';
import { assertionRevision, PackManifest } from '../context/contextPack';
import { GroundingResult, SchemaIndex, checkSqlGrounding } from './sqlGrounding';
import { SemanticGroundingResult, checkSemanticGrounding, describeSemanticIssues, knownMetricNames } from './semanticGrounding';
import type { SemanticLayerIndex } from '../semantic/layer';

/**
 * Grounding manifests and checks (C3, v0.30.0; docs/specs/context-layer.md
 * §8.3, §10.1). Every written artifact gets `<file>.grounding.json`: what it
 * was generated from (spec revision, step, agent, primitive, context pack),
 * which assertions justified each decision, and the results of the
 * deterministic grounding checks. Pure; the extension writes the file.
 */

export interface PrimitiveUse {
  kind: string;
  version?: number;
  params: Record<string, unknown>;
  source: 'primitive' | 'freehand' | 'template';
  /** The estate table the step's columns trace to, when its own input is an intermediate object (a staging view): v0.45.4. */
  lineage?: string;
}

export interface DecisionRecord {
  /** `<primitive>.<param>`, e.g. `dedup.partitionByColumns`. */
  usedFor: string;
  value: unknown;
  /** The table the decision is about, as resolved. */
  subject?: string;
  backedBy?: { id: string; trust: TrustTier };
  /** No assertion justifies it (§8.3: recorded, never hidden). */
  unbacked?: boolean;
  /** Backed, but below the required trust (§7.3). */
  belowTrust?: boolean;
  /** The weakest trust among what backs it, or `unbacked` (§7.5; never a number a model states). */
  confidence?: Confidence;
}

/** Confidence of a decision or recommendation (§7.5): the weakest trust tier among its backing, `unbacked` when nothing backs it. */
export type Confidence = TrustTier | 'unbacked';

export function confidenceOf(backing: readonly TrustTier[]): Confidence {
  return backing.length ? [...backing].sort((a, b) => trustRank(a) - trustRank(b))[0] : 'unbacked';
}

/** Where an artifact's context came from, by category (§7.5 traceability). */
export interface ManifestSources {
  semantic: string[];
  metadata: string[];
  pattern: string[];
  governance: string[];
  ontology: string[];
  lineage: string[];
}

export interface RuleCheck {
  ruleId: string;
  text: string;
  status: 'pass' | 'violation' | 'not_applicable' | 'manual_review';
  detail?: string;
}

export interface ArtifactGrounding {
  identifiers: Pick<GroundingResult, 'tablesChecked' | 'tablesResolved' | 'columnsChecked' | 'columnsResolved' | 'unresolved' | 'ambiguous'>;
  typeIssues: GroundingResult['typeIssues'];
  decisions: { total: number; backed: number; unbacked: number; belowTrust: number };
  rules: RuleCheck[];
  /** Joins and metrics against the approved semantic layer (C5b). */
  semantic?: Pick<SemanticGroundingResult, 'checked' | 'joinsChecked' | 'joinsDefined' | 'metricsChecked' | 'metricsDefined' | 'issues'>;
  /** `GROUNDING_UNRESOLVED` etc. — what the panel shows on the artifact. */
  warnings: string[];
}

export interface GroundingManifest {
  artifact: string;
  /** C4c: built in an exploration problem, on unverified assumptions (§7.4). */
  exploration?: boolean;
  specId?: string;
  specVersion?: number;
  specRevision?: string;
  /** Latest extraction per `system/environment` when the artifact was built (Phase K1). */
  catalogRevisions?: Record<string, string>;
  planStepId?: string;
  agent: string;
  generation: PrimitiveUse['source'] | 'unknown';
  primitives: Array<{ kind: string; version?: number }>;
  packId?: string;
  assertions: Array<{ id: string; revision: string; trust: TrustTier; usedFor: string }>;
  decisions: DecisionRecord[];
  overrides: Array<{ usedFor: string; reason: string }>;
  gaps: ContextGap[];
  grounding: ArtifactGrounding;
  /** Its context's sources by category (C5b, §7.5). */
  sources?: ManifestSources;
  model?: string;
  generatedAt: string;
}

const DECISION_PARAM = /(key|partition|grain|orderby|incremental|watermark|join|dedup|merge)/i;

function columnsOf(value: unknown): string[] | undefined {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  return undefined;
}

function sameColumns(a: readonly string[], b: readonly string[]): boolean {
  const x = a.map((s) => s.toLowerCase()).sort();
  const y = b.map((s) => s.toLowerCase()).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Maps each decision-bearing primitive parameter to the assertion that
 * justifies it (§8.3 `usedFor`), or records it as `unbacked`:
 * - key / partition columns ← a live `key` or `grain` assertion on the
 *   source table with the same columns, else the schema's declared primary key;
 * - ordering / incremental columns ← a live `decision` assertion on the
 *   table naming that column (e.g. "load orders incrementally on updated_at").
 */
export function backDecisions(
  use: PrimitiveUse,
  graph: { nodes: readonly BaseNode[]; edges: readonly GraphEdge[] },
  assertions: readonly Assertion[]
): DecisionRecord[] {
  const resolve = createSubjectResolver(graph);
  const source = use.lineage ?? (typeof use.params.sourceObject === 'string' ? use.params.sourceObject : undefined);
  const table = source ? resolve(source) ?? resolve(source.split('.').slice(-2).join('.')) ?? resolve(source.split('.').pop()!) : undefined;
  const live = assertions.filter((a) => isLive(a.status) && !isMirror(a));
  // A fact's subject as written (shop.orders) or as resolved (obj:shop/default/shop.orders): v0.45.4.
  const isAbout = (a: Assertion, t: string) => a.subject.some((s) => s === t || resolve(s) === t);
  const records: DecisionRecord[] = [];
  for (const [param, value] of Object.entries(use.params)) {
    if (!DECISION_PARAM.test(param)) continue;
    const cols = columnsOf(value);
    if (!cols) continue;
    const usedFor = `${use.kind}.${param}`;
    const rec: DecisionRecord = { usedFor, value, subject: table };
    const isKeyLike = /(key|partition|grain|dedup|merge)/i.test(param);
    let backing: Assertion | undefined;
    if (table && isKeyLike) {
      backing = live.find((a) => (a.kind === 'key' || a.kind === 'grain') && isAbout(a, table) && Array.isArray(a.value) && sameColumns(a.value as string[], cols));
      if (!backing) {
        // The schema's own declared primary key.
        const colIds = new Set(graph.edges.filter((e) => e.type === 'contains' && e.source === table).map((e) => e.target));
        const pk = graph.nodes.filter((n) => colIds.has(n.id) && (n as ColumnNode).isPrimaryKey) as ColumnNode[];
        if (pk.length > 0 && sameColumns(pk.map((c) => c.label), cols)) {
          const support = assertions.find((a) => isMirror(a) && isLive(a.status) && a.subject[0] === pk[0].id);
          if (support) backing = support;
        }
      }
    } else if (table) {
      backing = live.find((a) => a.kind === 'decision' && isAbout(a, table) &&
        Object.values((a.value ?? {}) as Record<string, unknown>).some((v) => typeof v === 'string' && cols.some((c) => c.toLowerCase() === v.toLowerCase())));
    }
    if (backing) {
      rec.backedBy = { id: backing.id, trust: backing.trust };
      const min = isKeyLike ? DEFAULT_MIN_TRUST.key : DEFAULT_MIN_TRUST.decision;
      if (trustRank(backing.trust) < trustRank(min)) rec.belowTrust = true;
    } else {
      rec.unbacked = true;
    }
    rec.confidence = confidenceOf(backing ? [backing.trust] : []);
    records.push(rec);
  }
  return records;
}

const MASKING = /(sha2|sha256|sha1|md5|hash\w*|mask\w*|redact\w*|encrypt\w*)\s*\(/i;

/**
 * §10.1 item 4. A STRICT rule with a machine-checkable form — today, masking
 * ("… are PII and must be masked …") over columns the graph knows — is
 * checked: every reference to such a column must sit inside a masking
 * function. Other STRICT rules are listed for manual review.
 */
export function checkRules(content: string, rules: readonly BusinessRuleNode[], knownColumns: ReadonlySet<string>): RuleCheck[] {
  const code = content.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out: RuleCheck[] = [];
  for (const r of rules) {
    if (r.enforcementLevel !== 'STRICT') continue;
    const text = r.ruleText;
    if (!/\b(mask|masked|masking|hash|hashed|redact)/i.test(text)) {
      out.push({ ruleId: r.id, text, status: 'manual_review' });
      continue;
    }
    const cols = [...new Set((text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []).filter((w) => knownColumns.has(w)))];
    if (cols.length === 0) { out.push({ ruleId: r.id, text, status: 'manual_review', detail: 'no known columns named in the rule' }); continue; }
    const violations: string[] = [];
    let mentioned = false;
    for (const col of cols) {
      const re = new RegExp(`\\b${col}\\b`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        mentioned = true;
        // The nearest unclosed "(" before the reference must belong to a masking function.
        const before = code.slice(Math.max(0, m.index - 80), m.index);
        const open = before.lastIndexOf('(');
        const closed = before.lastIndexOf(')');
        const fn = open > closed ? before.slice(0, open + 1) : '';
        // Column aliases on the masked expression (`... AS email`) are fine.
        const asAlias = /\bas\s*$/i.test(before);
        if (!asAlias && !MASKING.test(fn.slice(-20))) { violations.push(col); break; }
      }
    }
    out.push(violations.length > 0
      ? { ruleId: r.id, text, status: 'violation', detail: `unmasked: ${[...new Set(violations)].join(', ')}` }
      : { ruleId: r.id, text, status: mentioned ? 'pass' : 'not_applicable' });
  }
  return out;
}

export interface BuildManifestInput {
  artifact: { path: string; content: string; language: string; agent: string; specId?: string; specVersion?: number };
  specRevision?: string;
  catalogRevisions?: Record<string, string>;
  /** Objects the approved Pipeline Spec plans to create — known, though not yet in any catalog (Phase K1 item 9). */
  plannedObjects?: readonly string[];
  stepId?: string;
  pack?: PackManifest;
  primitiveUses: readonly PrimitiveUse[];
  graph: { nodes: readonly BaseNode[]; edges: readonly GraphEdge[] };
  schemaIndex: SchemaIndex;
  assertions: readonly Assertion[];
  /** The approved semantic layer (C5b): joins and metrics are checked against it. */
  semantic?: SemanticLayerIndex;
  model?: string;
  now?: () => Date;
}

/** The manifest's sources by category (§7.5): which semantic models, catalogs, primitives, classifications and lineage it rests on. */
function manifestSources(input: BuildManifestInput, used: readonly Assertion[], sem: SemanticGroundingResult | undefined): ManifestSources {
  const uniq = (xs: Iterable<string>) => [...new Set(xs)].sort();
  return {
    semantic: uniq([...(input.pack?.semanticModels ?? []), ...(sem?.checked ? sem.models : [])]),
    metadata: uniq(Object.entries(input.catalogRevisions ?? {}).map(([k, v]) => `${k}@${v}`)),
    pattern: uniq(input.primitiveUses.filter((u) => u.source === 'primitive').map((u) => `primitive:${u.kind}${u.version ? `@${u.version}` : ''}`)),
    governance: uniq(used.filter((a) => a.predicate === 'classification').map((a) => `fact:${a.id}`)),
    ontology: [],
    lineage: uniq(input.primitiveUses.map((u) => u.lineage).filter((l): l is string => !!l))
  };
}

export function buildGroundingManifest(input: BuildManifestInput): GroundingManifest {
  const byId = new Map(input.assertions.map((a) => [a.id, a] as const));
  const decisions = input.primitiveUses.filter((u) => u.source === 'primitive').flatMap((u) => backDecisions(u, input.graph, input.assertions));
  const used = new Map<string, { id: string; revision: string; trust: TrustTier; usedFor: string }>();
  for (const d of decisions) {
    if (!d.backedBy) continue;
    const a = byId.get(d.backedBy.id);
    if (a) used.set(`${a.id}|${d.usedFor}`, { id: a.id, revision: assertionRevision(a), trust: a.trust, usedFor: d.usedFor });
  }
  for (const p of input.pack?.assertions ?? []) {
    if (![...used.values()].some((u) => u.id === p.id)) used.set(`${p.id}|context`, { id: p.id, revision: p.revision, trust: p.trust, usedFor: 'context' });
  }

  const isSql = input.artifact.language === 'sql';
  const g = isSql ? checkSqlGrounding([{ name: input.artifact.path, content: input.artifact.content }], input.schemaIndex, input.plannedObjects) : undefined;
  const knownColumns = new Set(input.graph.nodes.filter((n) => n.type === 'column').map((n) => n.label.toLowerCase()));
  const rules = input.artifact.language === 'markdown'
    ? []
    : checkRules(input.artifact.content, input.graph.nodes.filter((n) => n.type === 'business_rule') as BusinessRuleNode[], knownColumns);
  const warnings: string[] = [];
  if (g && g.unresolved.length > 0) warnings.push(`GROUNDING_UNRESOLVED: ${g.unresolved.map((u) => u.ref).join(', ')}`);
  if (g && g.typeIssues.length > 0) warnings.push(`GROUNDING_TYPE: ${g.typeIssues.map((t) => t.detail).join('; ')}`);
  const unbacked = decisions.filter((d) => d.unbacked);
  if (unbacked.length > 0) warnings.push(`GROUNDING_UNBACKED: ${unbacked.map((d) => d.usedFor).join(', ')}`);
  for (const r of rules) if (r.status === 'violation') warnings.push(`RULE_VIOLATION: ${r.text} (${r.detail})`);
  const sem = isSql ? checkSemanticGrounding([{ name: input.artifact.path, content: input.artifact.content }], input.semantic, { knownMetrics: knownMetricNames(input.assertions) }) : undefined;
  if (sem?.issues.length) warnings.push(`GROUNDING_SEMANTIC: ${describeSemanticIssues(sem.issues).join(' ')}`);

  const keyLike = (usedFor: string) => /(key|partition|grain|dedup|merge)/i.test(usedFor.split('.').pop() ?? '');
  const decisionGaps: ContextGap[] = decisions.filter((d) => d.unbacked || d.belowTrust).map((d) => ({
    needed: keyLike(d.usedFor) ? 'key' as const : 'decision' as const,
    subject: d.subject ? [d.subject] : [],
    text: `${d.usedFor} = ${JSON.stringify(d.value)}`,
    reason: d.unbacked ? 'absent' as const : 'below_trust' as const,
    minTrust: keyLike(d.usedFor) ? DEFAULT_MIN_TRUST.key : DEFAULT_MIN_TRUST.decision,
    foundTrust: d.backedBy?.trust,
    stepId: input.stepId
  }));

  const generation = input.primitiveUses.length === 0 ? 'unknown' : (input.primitiveUses.find((u) => u.source === 'primitive') ?? input.primitiveUses[0]).source;
  return {
    artifact: input.artifact.path,
    specId: input.artifact.specId,
    specVersion: input.artifact.specVersion,
    specRevision: input.specRevision,
    ...(input.catalogRevisions ? { catalogRevisions: input.catalogRevisions } : {}),
    planStepId: input.stepId,
    agent: input.artifact.agent,
    generation,
    primitives: input.primitiveUses.filter((u) => u.source === 'primitive').map((u) => ({ kind: u.kind, version: u.version })),
    packId: input.pack?.packId,
    assertions: [...used.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.usedFor < b.usedFor ? -1 : 1)),
    decisions,
    overrides: [],
    gaps: [...(input.pack?.gaps ?? []), ...decisionGaps],
    grounding: {
      identifiers: g
        ? { tablesChecked: g.tablesChecked, tablesResolved: g.tablesResolved, columnsChecked: g.columnsChecked, columnsResolved: g.columnsResolved, unresolved: g.unresolved, ambiguous: g.ambiguous }
        : { tablesChecked: 0, tablesResolved: 0, columnsChecked: 0, columnsResolved: 0, unresolved: [], ambiguous: [] },
      typeIssues: g?.typeIssues ?? [],
      decisions: { total: decisions.length, backed: decisions.filter((d) => d.backedBy).length, unbacked: unbacked.length, belowTrust: decisions.filter((d) => d.belowTrust).length },
      rules,
      ...(sem?.checked ? { semantic: { checked: sem.checked, joinsChecked: sem.joinsChecked, joinsDefined: sem.joinsDefined, metricsChecked: sem.metricsChecked, metricsDefined: sem.metricsDefined, issues: sem.issues } } : {}),
      warnings
    },
    sources: manifestSources(input, [...used.values()].map((u) => byId.get(u.id)).filter((a): a is Assertion => !!a), sem),
    model: input.model,
    generatedAt: (input.now ?? (() => new Date()))().toISOString()
  };
}

/**
 * Fact-level staleness (§8.3 impact analysis): why an artifact is stale
 * because an assertion it was built on was superseded, rejected or sent to
 * review since. Assertions the ledger no longer knows are reported too.
 */
export function manifestStaleReasons(manifest: GroundingManifest, lookup: (id: string) => Assertion | undefined): string[] {
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const ref of manifest.assertions) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    const a = lookup(ref.id);
    const what = ref.usedFor === 'context' ? 'context fact' : ref.usedFor;
    if (!a) { reasons.push(`${what}: assertion ${ref.id} is no longer in the ledger`); continue; }
    if (a.status === 'superseded') reasons.push(`${what} changed: "${a.statement}" was superseded${a.supersededBy ? ` by ${a.supersededBy}` : ''} (${evidenceLabel(a)})`);
    else if (a.status === 'rejected') reasons.push(`${what}: "${a.statement}" was rejected${a.reviewReason ? ` — ${a.reviewReason}` : ''}`);
    else if (a.status === 'needs_review') reasons.push(`${what}: "${a.statement}" is under review${a.reviewReason ? ` — ${a.reviewReason}` : ''}`);
  }
  return reasons;
}

function evidenceLabel(a: Assertion): string {
  const e = a.evidence[0];
  return e ? `${e.type.replace('_', ' ')} ${e.ref}` : 'no evidence';
}

/** "Explain This Artifact": artifact → decisions → assertions → evidence, as markdown. */
export function explainManifest(manifest: GroundingManifest, lookup: (id: string) => Assertion | undefined): string {
  const L = [`# Why this artifact looks the way it does`, '', `**${manifest.artifact}**`, ''];
  L.push(`- Generated by \`${manifest.agent}\`${manifest.planStepId ? ` for plan step ${manifest.planStepId}` : ''} on ${manifest.generatedAt}${manifest.model ? ` with ${manifest.model}` : ''}.`);
  L.push(`- Method: ${manifest.generation}${manifest.primitives.length ? ` (primitive ${manifest.primitives.map((p) => `${p.kind}${p.version ? ' v' + p.version : ''}`).join(', ')})` : ''}.`);
  if (manifest.specId) L.push(`- Specification: ${manifest.specId} v${manifest.specVersion ?? 1}${manifest.specRevision ? ` (${manifest.specRevision})` : ''}.`);
  if (manifest.packId) L.push(`- Context pack: \`${manifest.packId}\` — ${manifest.assertions.filter((a) => a.usedFor === 'context').length} assertions.`);
  const stale = manifestStaleReasons(manifest, lookup);
  L.push('', stale.length ? `> **Stale:** ${stale.join('; ')}` : '> Every assertion it relied on is still current.');

  L.push('', '## Decisions', '');
  if (manifest.decisions.length === 0) L.push('_No decision-bearing parameters (this artifact was not generated from a primitive)._');
  for (const d of manifest.decisions) {
    const a = d.backedBy ? lookup(d.backedBy.id) : undefined;
    if (!a) { L.push(`- **${d.usedFor}** = \`${JSON.stringify(d.value)}\` — **unbacked**: no assertion justifies it.`); continue; }
    L.push(`- **${d.usedFor}** = \`${JSON.stringify(d.value)}\` ← "${a.statement}" (${a.trust}, ${a.status}${d.belowTrust ? ', below the required trust' : ''})`);
    for (const e of a.evidence) L.push(`  - evidence: ${e.type} \`${e.ref}\`${e.excerpt ? ` — "${e.excerpt}"` : ''}`);
  }

  L.push('', '## Grounding checks', '');
  const id = manifest.grounding.identifiers;
  L.push(`- Identifiers: ${id.tablesResolved}/${id.tablesChecked} tables and ${id.columnsResolved}/${id.columnsChecked} qualified columns resolve to known schema.${id.unresolved.length ? ` Unresolved: ${id.unresolved.map((u) => `\`${u.ref}\``).join(', ')}.` : ''}`);
  if (manifest.grounding.typeIssues.length) L.push(`- Type issues: ${manifest.grounding.typeIssues.map((t) => t.detail).join('; ')}`);
  for (const r of manifest.grounding.rules) L.push(`- Rule "${r.text}": ${r.status.replace('_', ' ')}${r.detail ? ` (${r.detail})` : ''}`);
  if (manifest.gaps.length) {
    L.push('', '## Context gaps', '');
    for (const g of manifest.gaps) L.push(`- ${g.needed} — ${g.text} (${g.reason === 'absent' ? 'not known' : `only ${g.foundTrust}, needs ${g.minTrust}`})`);
  }

  const ctx = manifest.assertions.filter((a) => a.usedFor === 'context');
  if (ctx.length) {
    L.push('', '## Context facts in the pack', '');
    for (const ref of ctx.slice(0, 40)) {
      const a = lookup(ref.id);
      L.push(`- ${a ? a.statement : ref.id} (${ref.trust}${a && a.status !== 'active' ? `, now ${a.status}` : ''})`);
    }
    if (ctx.length > 40) L.push(`- … ${ctx.length - 40} more`);
  }
  return L.join('\n') + '\n';
}

/** The per-run Grounding Report (validation phase). */
export function renderGroundingReport(manifests: readonly GroundingManifest[], title = 'Grounding Report'): string {
  const L = [`# ${title}`, ''];
  const sum = (f: (m: GroundingManifest) => number) => manifests.reduce((s, m) => s + f(m), 0);
  const idTotal = sum((m) => m.grounding.identifiers.tablesChecked + m.grounding.identifiers.columnsChecked);
  const idResolved = sum((m) => m.grounding.identifiers.tablesResolved + m.grounding.identifiers.columnsResolved);
  const decTotal = sum((m) => m.grounding.decisions.total);
  const decBacked = sum((m) => m.decisions.filter((d) => d.backedBy && !d.belowTrust && trustRank(d.backedBy.trust) >= trustRank('confirmed')).length);
  const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);
  L.push('| Metric | Result |', '|---|---|');
  L.push(`| Artifacts | ${manifests.length} |`);
  L.push(`| Identifier grounding rate | ${pct(idResolved, idTotal)} (${idResolved}/${idTotal}) |`);
  L.push(`| Unresolved identifiers | ${sum((m) => m.grounding.identifiers.unresolved.length)} |`);
  L.push(`| Type-compatibility issues | ${sum((m) => m.grounding.typeIssues.length)} |`);
  L.push(`| Decision backing rate (≥ confirmed) | ${pct(decBacked, decTotal)} (${decBacked}/${decTotal}) |`);
  L.push(`| Unbacked decisions | ${sum((m) => m.grounding.decisions.unbacked)} |`);
  L.push(`| STRICT rule violations | ${sum((m) => m.grounding.rules.filter((r) => r.status === 'violation').length)} |`);
  L.push(`| Context gaps | ${sum((m) => m.gaps.length)} |`);
  L.push('', '## Artifacts', '', '| Artifact | Method | Identifiers | Decisions | Warnings |', '|---|---|---|---|---|');
  for (const m of manifests) {
    const id = m.grounding.identifiers;
    L.push(`| ${m.artifact} | ${m.generation} | ${id.tablesResolved + id.columnsResolved}/${id.tablesChecked + id.columnsChecked} | ${m.grounding.decisions.backed}/${m.grounding.decisions.total} | ${m.grounding.warnings.join('; ').replace(/\|/g, '\\|') || '—'} |`);
  }
  const manual = [...new Set(manifests.flatMap((m) => m.grounding.rules.filter((r) => r.status === 'manual_review').map((r) => r.text)))];
  if (manual.length) L.push('', '## STRICT rules needing manual review', '', ...manual.map((t) => `- ${t}`));
  const gaps = manifests.flatMap((m) => m.gaps.map((g) => ({ g, m })));
  if (gaps.length) L.push('', '## Context gaps', '', ...gaps.map(({ g, m }) => `- ${m.artifact}: ${g.needed} — ${g.text} (${g.reason === 'absent' ? 'not known' : `only ${g.foundTrust}`})`));
  L.push('', '_Identifier checks scan SQL with patterns, not a parser: FROM/JOIN targets and qualified `alias.column` references are checked; unqualified columns are not._');
  return L.join('\n') + '\n';
}
