import { Assertion, isLive, trustRank } from '../context/assertions';
import type { ModelBinding } from './layer';
import { GraphView } from '../context/retrieval';
import { createSubjectResolver, isMirror } from '../context/projection';
import { TableShape, tableShapes, typeClass } from '../context/dataCandidates';
import { governanceFacts, sameTable } from '../governance/governance';
import { SemanticElement, SemanticModel, SemanticNamedExpr, SemanticRelationship, SemanticTable } from './model';

/**
 * Draft from knowledge (C5a; docs/specs/context-layer.md §6.5):
 * semantic elements from what AutoDE knows, deterministically — tables and
 * primary keys from declared keys and key facts, relationships from declared
 * foreign keys and relationship facts (direction and type from cardinality),
 * time dimensions, dimensions and facts from column types, metrics from
 * metric facts, synonyms from bound glossary terms, personal-data notes from
 * classifications. Only facts a person confirmed (or probes verified) are
 * used. A person reviews the draft and approves it; a model may later
 * propose better descriptions and synonyms.
 */

/** Base tables whose fully qualified name has no database get this, and the checks say so. */
export const DATABASE_PLACEHOLDER = 'SET_DATABASE';

export interface DraftResult {
  model: SemanticModel;
  /** `table.element` (or `table`, or `relationship:<name>`) → the facts it rests on. */
  backing: Record<string, string[]>;
  /** What the draft left out, and why. */
  notes: string[];
  /** The system (and environment) the drafted tables share: the model's binding (v0.50.3). */
  binding?: ModelBinding;
}

const trusted = (a: Assertion) => !isMirror(a) && isLive(a.status) && trustRank(a.trust) >= trustRank('confirmed');
const snake = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/**
 * Logical table names, unique within the model (Snowflake requires it): the
 * table's name, else schema_name, else database_schema_name — for the same
 * name in several schemas or databases (v0.50.3).
 */
function logicalNames(tables: readonly TableShape[]): Map<string, string> {
  const levels = (t: TableShape) => { const parts = t.fqn.split('.'); return [t.name, `${t.schema}_${t.name}`, `${parts.length >= 3 ? parts[parts.length - 3] : 'db'}_${t.schema}_${t.name}`, t.id.replace(/^obj:/, '')].map(snake); };
  const out = new Map<string, string>();
  for (const t of tables) {
    const names = levels(t);
    out.set(t.id, names.find((n, i) => i === names.length - 1 || tables.filter((o) => levels(o)[i] === n).length === 1)!);
  }
  return out;
}

function bindingOf(graph: GraphView, ids: readonly string[]): ModelBinding | undefined {
  const origins = ids.map((id) => graph.nodes.find((n) => n.id === id)?.origin);
  const systems = new Set(origins.map((o) => o?.system));
  if (systems.size !== 1 || [...systems][0] === undefined) return undefined;
  const envs = new Set(origins.map((o) => o?.systemEnvironment));
  return { system: [...systems][0]!, ...(envs.size === 1 && [...envs][0] ? { environment: [...envs][0] } : {}) };
}

function baseTable(t: TableShape, database: string | undefined): SemanticTable['base_table'] {
  const parts = t.fqn.split('.');
  if (parts.length >= 3) return { database: parts[parts.length - 3], schema: parts[parts.length - 2], table: parts[parts.length - 1] };
  return { database: database ?? DATABASE_PLACEHOLDER, schema: parts.length === 2 ? parts[0] : t.schema || 'PUBLIC', table: parts[parts.length - 1] };
}

export function draftSemanticModel(input: { graph: GraphView; assertions: readonly Assertion[]; tableIds: Iterable<string>; name: string; description?: string; database?: string }): DraftResult {
  const tables = tableShapes(input.graph, input.tableIds);
  const names = logicalNames(tables);
  const resolve = createSubjectResolver(input.graph as Parameters<typeof createSubjectResolver>[0]);
  const facts = input.assertions.filter(trusted);
  const backing: Record<string, string[]> = {};
  const notes: string[] = [];
  const back = (ref: string, ids: string[]) => { if (ids.length) backing[ref] = [...new Set([...(backing[ref] ?? []), ...ids])]; };
  const tableOfColumn = new Map<string, string>();
  for (const e of input.graph.edges) if (e.type === 'contains') tableOfColumn.set(e.target, e.source);
  const governance = governanceFacts(input.assertions);
  // Columns that join (declared foreign keys, relationship facts): dimensions, not facts.
  const joinColumns = new Set<string>();
  const relFacts = facts.filter((a) => a.kind === 'relationship');
  for (const e of input.graph.edges) if (e.type === 'foreign_key') { joinColumns.add(e.source); joinColumns.add(e.target); }
  for (const a of relFacts) {
    const v = a.value as { from?: { entity: string; columns: string[] }; to?: { entity: string; columns: string[] } };
    for (const side of [v.from, v.to]) { const t = side ? resolve(side.entity) : undefined; for (const c of side?.columns ?? []) if (t) joinColumns.add(`${t}|${c.toLowerCase()}`); }
  }

  const out: SemanticTable[] = [];
  for (const t of tables) {
    const name = names.get(t.id)!;
    const declared = t.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
    const keyFact = facts.find((a) => a.kind === 'key' && a.subject[0] === t.id && Array.isArray(a.value));
    const key = declared.length ? declared : keyFact ? (keyFact.value as unknown[]).map(String) : [];
    if (keyFact && !declared.length) back(name, [keyFact.id]);
    if (!key.length) notes.push(`${t.fqn}: no declared or confirmed key, so no primary_key`);
    const table: SemanticTable = { name, ...(t.description ? { description: t.description } : {}), base_table: baseTable(t, input.database), ...(key.length ? { primary_key: { columns: key } } : {}) };
    const dims: SemanticElement[] = []; const times: SemanticElement[] = []; const measures: SemanticElement[] = [];
    for (const c of t.columns) {
      const cls = typeClass(c.dataType);
      const isKeyish = key.some((k) => k.toLowerCase() === c.name.toLowerCase()) || joinColumns.has(c.id) || joinColumns.has(`${t.id}|${c.name.toLowerCase()}`) || /(_id|_no|_key|_code)$/i.test(c.name);
      const terms = facts.filter((a) => a.kind === 'business_term' && (a.subject.includes(c.id) || ((a.value as { boundTo?: string[] })?.boundTo ?? []).includes(c.id)));
      const synonyms = [...new Set(terms.map((a) => String((a.value as { term?: unknown }).term ?? '')).filter((s) => s && snake(s) !== snake(c.name)))];
      const gov = governance.find((g) => sameTable(g.table, t.fqn) && g.column === c.name.toLowerCase() && g.classification !== 'none' && g.status === 'active');
      const description = [c.description, gov ? `Personal data (${gov.classification}${gov.strategy ? `; masked by ${gov.strategy}` : ''}).` : ''].filter(Boolean).join(' ');
      const e: SemanticElement = { name: snake(c.name), ...(synonyms.length ? { synonyms } : {}), ...(description ? { description } : {}), expr: c.name, ...(c.dataType ? { data_type: c.dataType.toUpperCase() } : {}), ...(key.length === 1 && key[0].toLowerCase() === c.name.toLowerCase() ? { unique: true } : {}) };
      const ref = `${name}.${e.name}`;
      back(ref, [...terms.map((a) => a.id), ...(gov?.assertionId ? [gov.assertionId] : [])]);
      if (cls === 'time') times.push(e);
      else if (cls === 'number' && !isKeyish) measures.push(e);
      else dims.push(e);
    }
    if (dims.length) table.dimensions = dims;
    if (times.length) table.time_dimensions = times;
    if (measures.length) table.facts = measures;
    out.push(table);
  }

  const byId = new Map(tables.map((t) => [t.id, t]));
  const nameOfRef = (ref: string) => { const id = resolve(ref); return id && byId.has(id) ? names.get(id) : out.find((x) => x.name === snake(ref))?.name; };
  const relationships: SemanticRelationship[] = [];
  const addRel = (left: string, right: string, cols: Array<{ left_column: string; right_column: string }>, type: SemanticRelationship['relationship_type'], ids: string[]) => {
    const relName = `${left}_to_${right}`;
    if (relationships.some((r) => r.name === relName)) { back(`relationship:${relName}`, ids); return; }
    relationships.push({ name: relName, left_table: left, right_table: right, relationship_columns: cols, join_type: 'left_outer', relationship_type: type });
    back(`relationship:${relName}`, ids);
  };
  // Declared foreign keys: many-to-one from the referencing table.
  for (const e of input.graph.edges.filter((x) => x.type === 'foreign_key')) {
    const from = byId.get(tableOfColumn.get(e.source) ?? ''); const to = byId.get(tableOfColumn.get(e.target) ?? '');
    if (!from || !to) continue;
    const col = (id: string) => input.graph.nodes.find((n) => n.id === id)?.label ?? id;
    addRel(names.get(from.id)!, names.get(to.id)!, [{ left_column: col(e.source), right_column: col(e.target) }], 'many_to_one', []);
  }
  for (const a of relFacts) {
    const v = a.value as { from: { entity: string; columns: string[] }; to: { entity: string; columns: string[] }; cardinality?: string };
    const from = nameOfRef(v.from.entity); const to = nameOfRef(v.to.entity);
    if (!from || !to) { notes.push(`relationship fact ${a.id}: ${v.from.entity} or ${v.to.entity} is not among the tables drafted`); continue; }
    if (v.cardinality === 'N:M') { notes.push(`relationship fact ${a.id}: many-to-many has no direct Snowflake relationship; model it through a bridge table`); continue; }
    const pairs = v.from.columns.map((c, i) => ({ left_column: c, right_column: v.to.columns[i] ?? c }));
    if (v.cardinality === '1:N') addRel(to, from, pairs.map((p) => ({ left_column: p.right_column, right_column: p.left_column })), 'many_to_one', [a.id]);
    else addRel(from, to, pairs, v.cardinality === '1:1' ? 'one_to_one' : 'many_to_one', [a.id]);
  }

  for (const a of facts.filter((x) => x.kind === 'metric')) {
    const v = a.value as { name?: string; expression?: string; definition?: string; aggregation?: string; grain?: string[]; filters?: string[] };
    const name = snake(a.subject[0]?.startsWith('metric:') ? a.subject[0].slice(7) : v.name ?? a.statement);
    if (!v.expression) { notes.push(`metric ${name}: its fact defines it in words only ("${(v.definition ?? a.statement).slice(0, 80)}"); give it an expression`); continue; }
    const referenced = [...v.expression.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_]/g)].map((m) => nameOfRef(m[1])).filter((x): x is string => !!x);
    const home = (v.grain ?? []).map(nameOfRef).find((x): x is string => !!x) ?? nameOfRef(a.subject[0] ?? '') ?? (new Set(referenced).size === 1 ? referenced[0] : undefined);
    const table = out.find((t) => t.name === home);
    if (!table) { notes.push(`metric ${name}: no table to put it on (its grain or subject is not among the tables drafted)`); continue; }
    const expr = v.aggregation && !/\(/.test(v.expression) ? `${v.aggregation.toUpperCase()}(${v.expression})` : v.expression;
    const metric: SemanticNamedExpr = { name, description: [(v.definition ?? a.statement).trim().replace(/\.?$/, '.'), v.filters?.length ? `Use with the filter ${name}_scope.` : ''].filter(Boolean).join(' '), expr };
    table.metrics = [...(table.metrics ?? []), metric];
    back(`${table.name}.${name}`, [a.id]);
    if (v.filters?.length) {
      table.filters = [...(table.filters ?? []), { name: `${name}_scope`, description: `What ${name} counts.`, expr: v.filters.join(' AND ') }];
      back(`${table.name}.${name}_scope`, [a.id]);
    }
  }
  const binding = bindingOf(input.graph, tables.map((t) => t.id));
  if (!binding && tables.length) notes.push('the tables come from more than one system or environment, so the model is not bound to one; bind it before approving (a semantic view lives in one account)');
  return { model: { name: snake(input.name), ...(input.description ? { description: input.description } : {}), tables: out, relationships }, backing, notes, ...(binding ? { binding } : {}) };
}
