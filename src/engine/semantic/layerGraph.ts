import { BaseNode, GraphEdge, TableNode } from '../context/types';
import { exprIdentifiers } from './checks';
import { SemanticLayerIndex, baseMatches, semanticElementId, semanticModelId, semanticTableId } from './layer';

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
  for (const lt of index.tables) {
    const id = semanticTableId(lt.model, lt.table.name);
    const backing = meta.get(lt.model)?.backing ?? {};
    const phys = tables.find((t) => baseMatches(lt, t.fqn || t.label));
    physicalOf.set(id, phys);
    nodes.push({ id, type: 'semantic_table', label: lt.table.name, ...(lt.table.description ? { description: lt.table.description } : {}), aliases: lt.table.synonyms, metadata: { model: lt.model, baseTable: `${lt.table.base_table.database}.${lt.table.base_table.schema}.${lt.table.base_table.table}`, primaryKey: lt.table.primary_key?.columns ?? [], approved: meta.get(lt.model)?.approved ?? false }, version: 1, ...(backing[lt.table.name]?.length ? { supportedBy: backing[lt.table.name] } : {}) });
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
  for (const r of index.relationships) {
    const backing = meta.get(r.model)?.backing?.[`relationship:${r.name}`];
    edge('related_to', semanticTableId(r.model, r.leftTable), semanticTableId(r.model, r.rightTable), backing);
  }
  return { nodes, edges };
}
