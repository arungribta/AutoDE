import { BaseNode, GraphEdge, TableNode } from '../context/types';
import { exprIdentifiers } from './checks';
import { SemanticLayerIndex, matchBase, physicalRef, semanticElementId, semanticInstructionsId, semanticModelId, semanticQueryId, semanticRelationshipId, semanticTableId } from './layer';

/**
 * The semantic layer as graph nodes (§6.5): models contain logical tables,
 * which map to their physical tables and contain their elements; elements
 * derive from the physical columns their expressions use; relationships
 * relate logical tables. Nodes carry the facts behind them (`supportedBy`)
 * from the sidecar, and `metadata.approved`.
 */
export function semanticGraph(index: SemanticLayerIndex, graph: { nodes: readonly BaseNode[]; edges: readonly GraphEdge[] }): { nodes: BaseNode[]; edges: GraphEdge[] } {
  const nodes: BaseNode[] = [];
  const edges: GraphEdge[] = [];
  const tables = graph.nodes.filter((n): n is TableNode => n.type === 'table');
  const columnsOf = new Map<string, Map<string, string>>();
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  for (const e of graph.edges) {
    if (e.type !== 'contains') continue;
    const c = byId.get(e.target);
    if (c?.type === 'column') columnsOf.set(e.source, (columnsOf.get(e.source) ?? new Map()).set(c.label.toLowerCase(), c.id));
  }
  const edge = (type: GraphEdge['type'], source: string, target: string, supportedBy?: string[]) => edges.push({ id: `${type}:${source}->${target}`, source, target, type, weight: 0.8, ...(supportedBy?.length ? { supportedBy } : {}) });
  const meta = new Map(index.models.map((m) => [m.name, m] as const));
  for (const m of index.models) {
    nodes.push({ id: semanticModelId(m.name), type: 'semantic_model', label: m.name, metadata: { source: m.source, revision: m.revision, approved: m.approved, file: m.file, ...(m.problemId ? { problemId: m.problemId } : {}) }, version: 1 });
  }
  const physicalOf = new Map<string, TableNode | undefined>();
  const refs = tables.map(physicalRef);
  const tableById = new Map(tables.map((t) => [t.id, t] as const));
  for (const lt of index.tables) {
    const id = semanticTableId(lt.model, lt.table.name);
    const backing = meta.get(lt.model)?.backing ?? {};
    // Matched on database, schema and table within the model's system; several fits link none (§6.4).
    const m = matchBase(lt, refs);
    const phys = m.match ? tableById.get(m.match.id) : undefined;
    physicalOf.set(id, phys);
    nodes.push({ id, type: 'semantic_table', label: lt.table.name, ...(lt.table.description ? { description: lt.table.description } : {}), aliases: lt.table.synonyms, metadata: { model: lt.model, baseTable: `${lt.table.base_table.database}.${lt.table.base_table.schema}.${lt.table.base_table.table}`, primaryKey: lt.table.primary_key?.columns ?? [], approved: meta.get(lt.model)?.approved ?? false, ...(lt.binding ? { binding: lt.binding } : {}), ...(!m.match && m.candidates.length > 1 ? { ambiguous: m.candidates.map((c) => c.id) } : {}) }, version: 1, ...(backing[lt.table.name]?.length ? { supportedBy: backing[lt.table.name] } : {}) });
    edge('contains', semanticModelId(lt.model), id);
    if (phys) edge('maps_to', id, phys.id);
  }
  for (const el of index.elements) {
    const tableId = semanticTableId(el.model, el.table);
    const id = semanticElementId(el.model, el.table, el.name);
    const backing = meta.get(el.model)?.backing?.[`${el.table}.${el.name}`];
    nodes.push({ id, type: el.list === 'metrics' ? 'metric' : 'semantic_element', label: el.name, ...(el.description ? { description: el.description } : {}), aliases: el.synonyms, metadata: { model: el.model, table: el.table, list: el.list, expr: el.expr, approved: meta.get(el.model)?.approved ?? false }, version: 1, ...(backing?.length ? { supportedBy: backing } : {}) });
    edge('contains', tableId, id);
    const phys = physicalOf.get(tableId);
    const cols = phys ? columnsOf.get(phys.id) : undefined;
    if (!cols) continue;
    for (const ident of exprIdentifiers(el.expr)) {
      const col = cols.get(ident.split('.').pop()!.toLowerCase());
      if (col) edge('derives_from', id, col);
    }
  }
  // Relationships (joins): an edge between the logical tables, and an asset of their own.
  for (const r of index.relationships) {
    const backing = meta.get(r.model)?.backing?.[`relationship:${r.name}`];
    edge('related_to', semanticTableId(r.model, r.leftTable), semanticTableId(r.model, r.rightTable), backing);
    const id = semanticRelationshipId(r.model, r.name);
    nodes.push({ id, type: 'semantic_relationship', label: r.name, description: `${r.leftTable} → ${r.rightTable} on ${r.columns.map((c) => `${c.left} = ${c.right}`).join(' AND ')}`, metadata: { model: r.model, leftTable: r.leftTable, rightTable: r.rightTable, columns: r.columns, joinType: r.joinType, relationshipType: r.relationshipType, approved: meta.get(r.model)?.approved ?? false }, version: 1, ...(backing?.length ? { supportedBy: backing } : {}) });
    edge('contains', semanticModelId(r.model), id);
    edge('uses_table', id, semanticTableId(r.model, r.leftTable));
    edge('uses_table', id, semanticTableId(r.model, r.rightTable));
  }
  // Verified queries: the question, the SQL, and the logical tables it names.
  const logicalOf = new Map<string, string[]>();
  for (const lt of index.tables) logicalOf.set(lt.model, [...(logicalOf.get(lt.model) ?? []), lt.table.name]);
  for (const q of index.verifiedQueries) {
    const id = semanticQueryId(q.model, q.name);
    nodes.push({ id, type: 'verified_query', label: q.name, description: q.question, metadata: { model: q.model, question: q.question, sql: q.sql, ...(q.verifiedBy ? { verifiedBy: q.verifiedBy } : {}), ...(q.verifiedAt ? { verifiedAt: q.verifiedAt } : {}), approved: meta.get(q.model)?.approved ?? false }, version: 1 });
    edge('contains', semanticModelId(q.model), id);
    const words = new Set(q.sql.toLowerCase().split(/[^a-z0-9_]+/));
    for (const t of logicalOf.get(q.model) ?? []) if (words.has(t.toLowerCase())) edge('uses_table', id, semanticTableId(q.model, t));
  }
  for (const i of index.instructions) {
    const id = semanticInstructionsId(i.model);
    nodes.push({ id, type: 'semantic_instruction', label: `${i.model} instructions`, description: i.text, metadata: { model: i.model, text: i.text, approved: meta.get(i.model)?.approved ?? false }, version: 1 });
    edge('contains', semanticModelId(i.model), id);
  }
  return { nodes, edges };
}
