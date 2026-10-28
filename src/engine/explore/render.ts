import { AssetContext, AssetSummary, ExploreOverview, GraphSlice, SearchResult } from './explore';

/**
 * Plain-text renderings of the Explorer's answers (C5b): what `autode explore`
 * prints and what the Knowledge Explorer copies as Markdown. The JSON is the
 * contract; these are views of it.
 */

const KIND: Record<string, string> = { table: 'table', view: 'view', column: 'column', business_term: 'term', business_rule: 'rule', verified_query: 'query', metric: 'metric', semantic_model: 'semantic model', semantic_table: 'semantic table', semantic_element: 'semantic element', fact: 'fact' };

export function kindLabel(kind: string): string { return KIND[kind] ?? kind; }

function line(a: AssetSummary): string {
  const where = [a.system && `${a.system}${a.environment ? `/${a.environment}` : ''}`, a.trust, a.classification, a.approved === false ? 'draft' : '', a.inWorkingSet ? '' : 'catalog only'].filter(Boolean).join(', ');
  return `${kindLabel(a.kind).padEnd(16)} ${a.fqn ?? a.label}${where ? `  (${where})` : ''}  [${a.id}]`;
}

export function renderSearch(r: SearchResult): string {
  if (!r.total) return `Nothing matches "${r.query}".`;
  const facets = Object.entries(r.facets).filter(([, v]) => Object.keys(v).length).map(([k, v]) => `${k}: ${Object.entries(v).sort((a, b) => b[1] - a[1]).map(([x, n]) => `${x} ${n}`).join(', ')}`);
  return [`${r.approximate ? `Nothing matches every word of "${r.query}"; related results from the vocabulary. ` : ''}${r.total} match(es)${r.query ? ` for "${r.query}"` : ''}${r.results.length < r.total ? `, first ${r.results.length}` : ''}:`, ...r.results.map((x) => `  ${line(x)}`), '', ...facets.map((f) => `  ${f}`)].join('\n');
}

export function renderOverview(o: ExploreOverview): string {
  const c = o.counts;
  return [
    `Working set: ${c.tables} table(s), ${c.columns} column(s), ${c.terms} term(s), ${c.rules} rule(s), ${c.queries} verified quer${c.queries === 1 ? 'y' : 'ies'}; estate catalog: ${c.catalogTables} table(s).`,
    `Facts: ${c.facts} (${Object.entries(o.facts.byStatus).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}); ${o.conflicts} conflict(s), ${o.needsReview} to review.`,
    `Semantic layer: ${c.semanticModels} model(s), ${c.approvedSemanticModels} approved, ${c.metrics} metric(s).`,
    ...(o.systems.length ? ['Systems:', ...o.systems.map((s) => `  ${s.system}/${s.environment}: ${s.tables} table(s) in the working set`)] : [])
  ].join('\n');
}

/** The asset page as Markdown: the same sections as the Explorer's tabs. */
export function renderAssetMarkdown(c: AssetContext): string {
  const a = c.asset;
  const L: string[] = [`# ${a.fqn ?? a.label}`, '', `${kindLabel(a.kind)}${a.system ? ` · ${a.system}/${a.environment ?? 'default'}` : ''}${a.trust ? ` · ${a.trust}` : ''}${a.approved === false ? ' · draft' : ''} · \`${a.id}\``];
  if (a.description) L.push('', a.description);
  const o = c.overview;
  if (o.parent) L.push('', `Part of ${kindLabel(o.parent.kind)} **${o.parent.fqn ?? o.parent.label}**.`);
  if (o.aliases.length) L.push(`Also called: ${o.aliases.join(', ')}.`);
  if (o.origin) L.push(`Source: ${o.origin.source} (${o.origin.ref})${o.origin.reliability ? `, ${o.origin.reliability}` : ''}${o.origin.lastVerifiedAt ? `, verified ${o.origin.lastVerifiedAt}` : ''}.`);
  if (c.schema) {
    L.push('', '## Schema', '', '| Column | Type | Key | Nullable | Classification |', '|---|---|---|---|---|');
    for (const col of c.schema.columns) L.push(`| ${col.label} | ${col.dataType || '?'} | ${col.primaryKey ? 'PK' : col.foreignKey ? 'FK' : ''} | ${col.nullable ? 'yes' : 'no'} | ${col.classification ? `${col.classification}${col.strategy ? ` (${col.strategy})` : ''}` : ''} |`);
    for (const f of [...c.schema.keys, ...c.schema.grain]) L.push(`- ${f.statement} (${f.trust})`);
  }
  const m = c.meaning;
  if (m.terms.length || m.semantic.length || m.definition) {
    L.push('', '## Meaning');
    for (const t of m.terms) L.push(`- Term **${t.label}**${t.description ? `: ${t.description}` : ''}`);
    for (const s of m.semantic) L.push(`- ${kindLabel(s.kind)} **${s.label}**${s.model ? ` in ${s.model}` : ''}${s.expr ? `: \`${s.expr}\`` : ''}${s.approved === false ? ' (draft)' : ''}`);
    if (m.definition?.expr) L.push(`- Defined as \`${String(m.definition.expr)}\`${m.definition.model ? ` in ${String(m.definition.model)}` : ''}`);
  }
  if (c.lineage.related.length) {
    L.push('', '## Relationships and lineage');
    for (const r of c.lineage.related) L.push(`- ${r.direction === 'out' ? '→' : '←'} ${r.relation.replace(/_/g, ' ')} ${kindLabel(r.asset.kind)} **${r.asset.fqn ?? r.asset.label}**${r.trust ? ` (${r.trust})` : ''}`);
  }
  L.push('', `_${c.lineage.note}_`);
  if (c.governance.classifications.length || c.governance.rules.length) {
    L.push('', '## Governance');
    for (const g of c.governance.classifications) L.push(`- ${g.column}: ${g.classification}${g.strategy ? `, masked by ${g.strategy}` : ''}${g.trust ? ` (${g.trust})` : ''}`);
    for (const r of c.governance.rules) L.push(`- ${r.enforcement}: ${r.text}`);
  }
  if (c.facts.length) {
    L.push('', '## Facts');
    for (const f of c.facts) L.push(`- ${f.about ? `[${f.about}] ` : ''}${f.statement} — ${f.status}, ${f.trust}; ${f.evidence.map((e) => `${e.type} ${e.ref}`).join('; ') || 'no evidence'} \`${f.id}\``);
  }
  if (c.memory.length) {
    L.push('', '## Decisions and assumptions in scope');
    for (const f of c.memory) L.push(`- ${f.about === 'team-wide' ? '(team-wide) ' : ''}${f.statement} — ${f.kind}, ${f.trust}`);
  }
  const u = c.usedBy;
  if (u.artifacts.length || u.semanticModels.length || u.queries.length) {
    L.push('', '## Used by');
    for (const x of u.artifacts) L.push(`- Artifact ${x.path}${x.warnings ? ` (${x.warnings} grounding warning(s))` : ''}`);
    for (const x of u.semanticModels) L.push(`- Semantic model ${x.label}${x.approved === false ? ' (draft)' : ''}`);
    for (const x of u.queries) L.push(`- Verified query ${x.label}`);
  }
  if (c.conflicts.length) {
    L.push('', '## Conflicts');
    for (const x of c.conflicts) L.push(`- ${x.rule}: ${x.sides.join(' vs ')}`);
  }
  return L.join('\n') + '\n';
}

export function renderGraph(g: GraphSlice): string {
  const label = new Map(g.nodes.map((n) => [n.id, n.fqn ?? n.label] as const));
  const lines = g.edges.map((e) => `  ${label.get(e.source)} —${e.type.replace(/_/g, ' ')}→ ${label.get(e.target)}${e.trust ? ` (${e.trust})` : ''}`);
  const more = Object.entries(g.hidden).map(([id, n]) => `  +${n} more around ${label.get(id) ?? id}`);
  return [`${g.nodes.length} node(s), ${g.edges.length} edge(s) around ${label.get(g.center)}:`, ...lines, ...more].join('\n');
}
