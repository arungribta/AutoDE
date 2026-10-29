import { Assertion, isLive } from '../context/assertions';
import { isMirror } from '../context/projection';
import { GraphView, resolveText } from '../context/retrieval';
import { TableNode } from '../context/types';
import { loadSemanticLayer } from '../semantic/store';

/**
 * A new business problem and the workspace it starts in (v0.53.2; owner,
 * 2026-10-28). Knowledge is per workspace: every problem in it shares the
 * estate, the facts and the semantic layer, and a different estate belongs in
 * its own workspace folder. These say, without a model, what a new problem
 * would share and, once it is described, what it builds on.
 */

export interface WorkspaceKnowledge {
  systems: string[];
  tables: number;
  facts: number;
  semanticModels: string[];
}

/** What every problem in this workspace shares. */
export function workspaceKnowledge(workspaceRoot: string, sources: { graph: GraphView; assertions: readonly Assertion[] }): WorkspaceKnowledge {
  const tables = sources.graph.nodes.filter((n) => n.type === 'table' || n.type === 'semantic_view') as TableNode[];
  let semanticModels: string[] = [];
  try { semanticModels = loadSemanticLayer(workspaceRoot).models.map((m) => m.name).sort(); } catch { /* none */ }
  return {
    systems: [...new Set(tables.map((t) => t.origin?.system).filter((s): s is string => !!s))].sort(),
    tables: tables.length,
    facts: sources.assertions.filter((a) => !isMirror(a) && isLive(a.status)).length,
    semanticModels
  };
}

/** One line for the + New dialog and the chat: "3 systems (crm, shop, legacy), 214 facts, 1 semantic model (sales)". */
export function knowledgeLine(k: WorkspaceKnowledge): string {
  if (!k.tables && !k.facts && !k.semanticModels.length) return 'nothing yet: this workspace is empty';
  const list = (xs: string[]) => (xs.length ? ` (${xs.slice(0, 5).join(', ')}${xs.length > 5 ? ', …' : ''})` : '');
  return [
    `${k.systems.length} system${k.systems.length === 1 ? '' : 's'}${list(k.systems)}`,
    `${k.tables} table${k.tables === 1 ? '' : 's'}`,
    `${k.facts} fact${k.facts === 1 ? '' : 's'}`,
    `${k.semanticModels.length} semantic model${k.semanticModels.length === 1 ? '' : 's'}${list(k.semanticModels)}`
  ].join(', ');
}

export interface ProblemOverlap {
  systems: string[];
  tables: string[];
  terms: string[];
  semanticModels: string[];
  /** The workspace holds knowledge, and the statement names none of it. */
  noMatch: boolean;
  /** One paragraph for the person. */
  message: string;
}

/**
 * What a problem statement builds on in this workspace: the systems, tables,
 * glossary terms and metrics it names (the same deterministic resolver the
 * context packs use), and the semantic models over those tables. Nothing
 * matching is said plainly, with the way to keep another estate apart.
 */
export function problemOverlap(workspaceRoot: string, statement: string, sources: { graph: GraphView; assertions: readonly Assertion[] }): ProblemOverlap {
  const byId = new Map(sources.graph.nodes.map((n) => [n.id, n] as const));
  const matches = resolveText(statement, sources.graph);
  const tables = new Map<string, TableNode>();
  const terms = new Set<string>();
  for (const m of matches) {
    const n = byId.get(m.nodeId);
    if (!n) continue;
    if (n.type === 'table' || n.type === 'semantic_view') tables.set(n.id, n as TableNode);
    else if (n.type === 'business_term' || n.type === 'metric') terms.add(n.label);
    else if (n.type === 'column') {
      const parent = sources.graph.edges.find((e) => e.type === 'contains' && e.target === n.id)?.source;
      const t = parent ? byId.get(parent) : undefined;
      if (t && (t.type === 'table' || t.type === 'semantic_view')) tables.set(t.id, t as TableNode);
    }
  }
  const names = [...tables.values()].map((t) => (t.fqn || t.label));
  const baseNames = new Set([...tables.values()].map((t) => t.label.toLowerCase()));
  let semanticModels: string[] = [];
  try { semanticModels = [...new Set(loadSemanticLayer(workspaceRoot).tables.filter((lt) => baseNames.has(lt.baseName)).map((lt) => lt.model))].sort(); } catch { /* none */ }
  const systems = [...new Set([...tables.values()].map((t) => t.origin?.system).filter((s): s is string => !!s))].sort();
  const known = workspaceKnowledge(workspaceRoot, sources);
  const hasKnowledge = known.tables > 0 || known.facts > 0 || known.semanticModels.length > 0;
  const noMatch = hasKnowledge && !names.length && !terms.size;
  const list = (xs: string[], n = 8) => `${xs.slice(0, n).join(', ')}${xs.length > n ? ` and ${xs.length - n} more` : ''}`;
  let message: string;
  if (!hasKnowledge) message = 'This workspace has no knowledge yet: bring the problem\'s sources in (a connection or a DDL file), and AutoDE builds its estate as you go.';
  else if (noMatch) message = `Nothing in this workspace matches the problem yet (it holds ${knowledgeLine(known)}). If it is about a different estate, open another folder as its own workspace, so the two don't mix. If it uses these systems under other names, say which tables it reads.`;
  else message = `This problem builds on what the workspace already knows: ${[systems.length ? `systems ${list(systems)}` : '', names.length ? `tables ${list(names)}` : '', terms.size ? `terms ${list([...terms])}` : '', semanticModels.length ? `semantic model${semanticModels.length === 1 ? '' : 's'} ${list(semanticModels)}` : ''].filter(Boolean).join('; ')}.`;
  return { systems, tables: names, terms: [...terms].sort(), semanticModels, noMatch, message };
}
