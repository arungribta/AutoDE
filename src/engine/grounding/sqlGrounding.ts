import { BaseNode, ColumnNode, GraphEdge, TableNode } from '../context/types';

/**
 * Deterministic grounding checks for generated SQL (v0.27.0 — docs/context-layer-requirements.md
 * §10.1 items 1 and 3). Answers two questions about an artifact, without any LLM:
 *
 * 1. **Identifier resolution** — does every table it reads from, and every
 *    `alias.column` it references on such a table, exist in the known schema?
 * 2. **Type compatibility** — does it join or cast columns across
 *    incompatible type classes (e.g. a TIMESTAMP joined to a VARCHAR)?
 *
 * Deliberately a lightweight scanner, not a SQL parser: it strips comments,
 * string literals and Jinja, then pattern-matches `FROM`/`JOIN` targets,
 * aliases, CTEs, `CREATE … TABLE|VIEW` targets and dbt `ref()`/`source()`.
 * Unqualified column references are not checked (they're ambiguous without a
 * full resolver); that limitation is reported, not hidden. Objects the
 * artifact set itself creates (CTEs, created tables/views, dbt model names)
 * count as internal and resolve without a schema match.
 */

export type TypeClass = 'numeric' | 'string' | 'temporal' | 'boolean' | 'other';

export interface SchemaTable {
  fqn: string;
  name: string;
  /** lower-cased column name → declared data type */
  columns: Map<string, string>;
}

export interface SchemaIndex {
  tables: SchemaTable[];
  /** lower-cased table name (last dotted part) → tables with that name */
  byName: Map<string, SchemaTable[]>;
}

export interface UnresolvedIdentifier {
  kind: 'table' | 'column';
  ref: string;
  artifact?: string;
}

export interface TypeIssue {
  kind: 'join' | 'cast';
  detail: string;
  artifact?: string;
}

export interface GroundingResult {
  tablesChecked: number;
  tablesResolved: number;
  columnsChecked: number;
  columnsResolved: number;
  unresolved: UnresolvedIdentifier[];
  /** Table references matching more than one known table by name — resolved, but ambiguous. */
  ambiguous: string[];
  typeIssues: TypeIssue[];
}

/** Builds a schema index from graph table/column nodes joined by `contains` edges. */
export function buildSchemaIndex(nodes: readonly BaseNode[], edges: readonly GraphEdge[]): SchemaIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const tables = new Map<string, SchemaTable>();
  for (const n of nodes) {
    if (n.type !== 'table' && n.type !== 'semantic_view') continue;
    const t = n as TableNode;
    const fqn = t.fqn || t.label;
    tables.set(n.id, { fqn, name: lastPart(fqn).toLowerCase(), columns: new Map() });
  }
  for (const e of edges) {
    if (e.type !== 'contains') continue;
    const table = tables.get(e.source);
    const col = byId.get(e.target);
    if (table && col && col.type === 'column') {
      table.columns.set(col.label.toLowerCase(), (col as ColumnNode).dataType || '');
    }
  }
  const list = [...tables.values()];
  const byName = new Map<string, SchemaTable[]>();
  for (const t of list) {
    if (!byName.has(t.name)) byName.set(t.name, []);
    byName.get(t.name)!.push(t);
  }
  return { tables: list, byName };
}

export function typeClassOf(dataType: string): TypeClass {
  const t = dataType.toUpperCase();
  if (/^(BOOL|BOOLEAN)\b/.test(t)) return 'boolean';
  if (/(INT|NUMBER|NUMERIC|DECIMAL|FLOAT|DOUBLE|REAL|BIGINT|SMALLINT)/.test(t)) return 'numeric';
  if (/(TIMESTAMP|DATE|TIME)/.test(t)) return 'temporal';
  if (/(CHAR|TEXT|STRING|VARCHAR)/.test(t)) return 'string';
  return 'other';
}

/** Casts/joins between these pairs are flagged; string↔anything and numeric↔boolean are allowed. */
function incompatible(a: TypeClass, b: TypeClass): boolean {
  if (a === 'other' || b === 'other' || a === b) return false;
  if (a === 'string' || b === 'string') return false;
  const pair = [a, b].sort().join('|');
  return pair === 'numeric|temporal' || pair === 'boolean|temporal';
}

const NOT_ALIAS = new Set([
  'where', 'on', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'group', 'order',
  'limit', 'qualify', 'using', 'union', 'having', 'window', 'as', 'lateral', 'set', 'values', 'when', 'then',
  'select', 'from', 'with', 'except', 'intersect', 'pivot', 'unpivot', 'sample', 'tablesample'
]);

function lastPart(name: string): string {
  const parts = name.split('.');
  return parts[parts.length - 1];
}

function clean(name: string): string {
  return name.replace(/["`[\]]/g, '');
}

/** Strips comments and string literals so identifiers inside them aren't counted; collects dbt refs first. */
function preprocess(sql: string): { text: string; dbtRefs: string[]; dbtSources: string[] } {
  const dbtRefs: string[] = [];
  const dbtSources: string[] = [];
  for (const m of sql.matchAll(/\bref\s*\(\s*['"]([\w.]+)['"]\s*\)/g)) dbtRefs.push(m[1].toLowerCase());
  for (const m of sql.matchAll(/\bsource\s*\(\s*['"][\w.]+['"]\s*,\s*['"]([\w.]+)['"]\s*\)/g)) dbtSources.push(m[1].toLowerCase());
  const text = sql
    .replace(/\{\{[\s\S]*?\}\}/g, ' __jinja__ ')
    .replace(/\{%[\s\S]*?%\}/g, ' ')
    .replace(/\{#[\s\S]*?#\}/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
  return { text, dbtRefs, dbtSources };
}

export interface GroundingArtifact {
  name: string;
  content: string;
}

/**
 * Checks a set of SQL artifacts together, so a model created in one artifact
 * and referenced in another (a dbt `ref`) counts as internal.
 */
export function checkSqlGrounding(artifacts: readonly GroundingArtifact[], index: SchemaIndex, plannedObjects: readonly string[] = []): GroundingResult {
  const result: GroundingResult = { tablesChecked: 0, tablesResolved: 0, columnsChecked: 0, columnsResolved: 0, unresolved: [], ambiguous: [], typeIssues: [] };

  // Pass 1: everything the artifact set itself defines, plus objects the approved
  // Pipeline Spec plans to create (Phase K1: known, though in no catalog yet).
  const internal = new Set<string>(plannedObjects.map((o) => lastPart(clean(o)).toLowerCase()));
  const pre = artifacts.map((a) => ({ a, ...preprocess(a.content) }));
  for (const { a, text } of pre) {
    const base = a.name.replace(/\\/g, '/').split('/').pop()!.replace(/\.(sql|yml|yaml)$/i, '').toLowerCase();
    if (/\.sql$/i.test(a.name)) internal.add(base);
    for (const m of text.matchAll(/\bcreate\s+(?:or\s+replace\s+)?(?:(?:transient|temporary|temp|secure|materialized)\s+)*(?:table|view)\s+(?:if\s+not\s+exists\s+)?([\w."$]+)/gi)) {
      internal.add(lastPart(clean(m[1])).toLowerCase());
    }
    for (const m of text.matchAll(/(?:\bwith|,)\s*(\w+)\s+as\s*\(/gi)) internal.add(m[1].toLowerCase());
  }

  for (const { a, text, dbtRefs, dbtSources } of pre) {
    const alias = new Map<string, SchemaTable | 'internal'>();

    const resolveTable = (raw: string): SchemaTable | 'internal' | undefined => {
      const name = lastPart(clean(raw)).toLowerCase();
      if (internal.has(name)) return 'internal';
      result.tablesChecked++;
      const matches = index.byName.get(name);
      if (!matches || matches.length === 0) {
        result.unresolved.push({ kind: 'table', ref: clean(raw), artifact: a.name });
        return undefined;
      }
      result.tablesResolved++;
      if (matches.length > 1) result.ambiguous.push(clean(raw));
      return matches[0];
    };

    for (const r of dbtRefs) {
      if (!internal.has(lastPart(r))) resolveTable(r);
    }
    for (const s of dbtSources) resolveTable(s);

    for (const m of text.matchAll(/\b(?:from|join)\s+([\w."$@]+)(?:\s+(?:as\s+)?(\w+))?/gi)) {
      const raw = m[1];
      if (raw.startsWith('@') || raw === '__jinja__' || raw.startsWith('(')) continue;
      if (/^(lateral|table|unnest|flatten|values)$/i.test(raw)) continue;
      const resolved = resolveTable(raw);
      const self = lastPart(clean(raw)).toLowerCase();
      if (resolved) {
        alias.set(self, resolved);
        const al = m[2]?.toLowerCase();
        if (al && !NOT_ALIAS.has(al)) alias.set(al, resolved);
      }
    }

    const columnType = (al: string, col: string): string | undefined => {
      const t = alias.get(al.toLowerCase());
      return t && t !== 'internal' ? t.columns.get(col.toLowerCase()) : undefined;
    };

    for (const m of text.matchAll(/\b(\w+)\.(\w+)\b(?!\s*\()/g)) {
      const t = alias.get(m[1].toLowerCase());
      if (!t || t === 'internal') continue;
      result.columnsChecked++;
      if (t.columns.has(m[2].toLowerCase())) result.columnsResolved++;
      else result.unresolved.push({ kind: 'column', ref: `${t.fqn}.${m[2]}`, artifact: a.name });
    }

    for (const m of text.matchAll(/\b(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)\b/g)) {
      const l = columnType(m[1], m[2]);
      const r = columnType(m[3], m[4]);
      if (l !== undefined && r !== undefined && incompatible(typeClassOf(l), typeClassOf(r))) {
        result.typeIssues.push({ kind: 'join', detail: `${m[1]}.${m[2]} (${l}) = ${m[3]}.${m[4]} (${r})`, artifact: a.name });
      }
    }
    for (const m of text.matchAll(/\bcast\s*\(\s*(\w+)\.(\w+)\s+as\s+(\w+)|\b(\w+)\.(\w+)::(\w+)/gi)) {
      const [al, col, target] = m[1] ? [m[1], m[2], m[3]] : [m[4], m[5], m[6]];
      const src = columnType(al, col);
      if (src !== undefined && incompatible(typeClassOf(src), typeClassOf(target))) {
        result.typeIssues.push({ kind: 'cast', detail: `CAST(${al}.${col} (${src}) AS ${target})`, artifact: a.name });
      }
    }
  }
  return result;
}
