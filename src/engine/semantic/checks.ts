import { Assertion, isLive } from '../context/assertions';
import { GraphView } from '../context/retrieval';
import { isMirror } from '../context/projection';
import { TableShape, knownKey, tableShapes, typeClass } from '../context/dataCandidates';
import { DATABASE_PLACEHOLDER } from './draft';
import { ELEMENT_LISTS, SemanticModel, SemanticTable } from './model';

/**
 * Checks (C5a; docs/context-layer-requirements.md §6.5), deterministic:
 * against the estate — every base table and column exists, expressions use
 * known columns and elements, types fit — and against the knowledge — a
 * relationship that contradicts a known key, a primary key no fact supports,
 * a metric whose fact says otherwise. Results are shown; nothing is
 * synchronised silently. Errors refuse an approval in governed mode.
 */

export interface SemanticFinding {
  severity: 'error' | 'warning';
  /** `table`, `table.element`, `relationship:<name>`. */
  where: string;
  message: string;
}

const SQL_WORDS = new Set(['and', 'or', 'not', 'null', 'is', 'in', 'case', 'when', 'then', 'else', 'end', 'as', 'distinct', 'true', 'false', 'like', 'ilike', 'between', 'interval', 'over', 'partition', 'by', 'order', 'asc', 'desc', 'filter', 'where', 'within', 'group', 'day', 'days', 'month', 'months', 'year', 'years', 'week', 'hour', 'minute', 'second', 'quarter', 'current_date', 'current_timestamp', 'date', 'timestamp', 'varchar', 'number', 'int', 'integer', 'float', 'decimal', 'string', 'boolean', 'rows', 'range', 'unbounded', 'preceding', 'following', 'current', 'row', 'nulls', 'first', 'last', 'exists', 'any', 'all', 'some']);

/** The identifiers an expression uses (`col` or `table.col`), leaving out functions, keywords, literals and quoted strings. */
export function exprIdentifiers(expr: string): string[] {
  const text = expr.replace(/'(?:[^']|'')*'/g, ' ');
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9_$.])([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?)(\s*\()?/g)) {
    if (m[2]) continue; // a function call
    if (SQL_WORDS.has(m[1].toLowerCase())) continue;
    if (/^\d/.test(m[1])) continue;
    out.push(m[1]);
  }
  return [...new Set(out)];
}

function physical(t: SemanticTable, shapes: readonly TableShape[]): TableShape | undefined {
  const b = t.base_table;
  const full = `${b.database}.${b.schema}.${b.table}`.toLowerCase();
  const short = `${b.schema}.${b.table}`.toLowerCase();
  return shapes.find((s) => s.fqn.toLowerCase() === full) ?? shapes.find((s) => s.fqn.toLowerCase() === short || s.fqn.toLowerCase().endsWith(`.${short}`));
}

const sameCols = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.some((y) => y.toLowerCase() === x.toLowerCase()));
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const snake = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export function checkSemanticModel(model: SemanticModel, input: { graph: GraphView; assertions: readonly Assertion[] }): SemanticFinding[] {
  const findings: SemanticFinding[] = [];
  const shapes = tableShapes(input.graph);
  const phys = new Map(model.tables.map((t) => [t.name.toLowerCase(), physical(t, shapes)] as const));
  const columnsOf = (t: string) => new Map((phys.get(t.toLowerCase())?.columns ?? []).map((c) => [c.name.toLowerCase(), c] as const));
  const elementsOf = (t: SemanticTable) => new Set(ELEMENT_LISTS.flatMap((l) => ((t[l] as Array<{ name: string }> | undefined) ?? []).map((e) => e.name.toLowerCase())));
  const tableByName = new Map(model.tables.map((t) => [t.name.toLowerCase(), t] as const));

  for (const t of model.tables) {
    const p = phys.get(t.name.toLowerCase());
    const b = t.base_table;
    if (b.database === DATABASE_PLACEHOLDER) findings.push({ severity: 'warning', where: t.name, message: `base_table.database is a placeholder: set the database the table lives in before deploying` });
    if (!p) { findings.push({ severity: 'error', where: t.name, message: `base table ${b.database}.${b.schema}.${b.table} isn't in the estate` }); continue; }
    const cols = columnsOf(t.name);
    for (const k of t.primary_key?.columns ?? []) if (!cols.has(k.toLowerCase())) findings.push({ severity: 'error', where: t.name, message: `primary_key column ${k} isn't a column of ${p.fqn}` });
    for (const list of ['dimensions', 'time_dimensions', 'facts'] as const) {
      for (const e of t[list] ?? []) {
        for (const id of exprIdentifiers(e.expr)) {
          if (!cols.has(id.toLowerCase())) findings.push({ severity: 'error', where: `${t.name}.${e.name}`, message: `${id} isn't a column of ${p.fqn}` });
        }
        const col = cols.get(e.expr.trim().toLowerCase());
        if (col) {
          const cls = typeClass(col.dataType);
          if (list === 'time_dimensions' && cls !== 'time' && cls !== 'unknown') findings.push({ severity: 'warning', where: `${t.name}.${e.name}`, message: `a time dimension over ${col.name}, which is ${col.dataType}` });
          if (list === 'facts' && cls !== 'number' && cls !== 'unknown') findings.push({ severity: 'warning', where: `${t.name}.${e.name}`, message: `a fact over ${col.name}, which is ${col.dataType}, not a number` });
        }
      }
    }
    const own = elementsOf(t);
    for (const list of ['metrics', 'filters'] as const) {
      for (const e of t[list] ?? []) {
        for (const id of exprIdentifiers(e.expr)) {
          const [a, b2] = id.split('.');
          if (b2) {
            const other = tableByName.get(a.toLowerCase());
            if (!other) { findings.push({ severity: 'error', where: `${t.name}.${e.name}`, message: `${a} isn't a table of this model` }); continue; }
            if (!elementsOf(other).has(b2.toLowerCase()) && !columnsOf(other.name).has(b2.toLowerCase())) findings.push({ severity: 'error', where: `${t.name}.${e.name}`, message: `${id}: ${b2} is neither an element of ${other.name} nor a column of its base table` });
          } else if (!own.has(a.toLowerCase()) && !cols.has(a.toLowerCase())) {
            findings.push({ severity: 'error', where: `${t.name}.${e.name}`, message: `${id} is neither an element of ${t.name} nor a column of ${p.fqn}` });
          }
        }
      }
    }
    // Against the knowledge: the key.
    const known = knownKey(p, input.assertions);
    if (t.primary_key) {
      if (!known) findings.push({ severity: 'warning', where: t.name, message: `no declared key or fact supports the primary key (${t.primary_key.columns.join(', ')})` });
      else if (!sameCols(known.columns, t.primary_key.columns)) findings.push({ severity: 'error', where: t.name, message: `primary key (${t.primary_key.columns.join(', ')}) contradicts the known key of ${p.fqn}: (${known.columns.join(', ')})${known.fact ? `, fact ${known.fact.id}` : ', declared in its schema'}` });
    }
  }

  for (const r of model.relationships ?? []) {
    const where = `relationship:${r.name}`;
    const left = tableByName.get(r.left_table.toLowerCase()); const right = tableByName.get(r.right_table.toLowerCase());
    if (!left || !right) continue; // the format check names it
    for (const c of r.relationship_columns) {
      if (!columnsOf(left.name).has(c.left_column.toLowerCase()) && !elementsOf(left).has(c.left_column.toLowerCase())) findings.push({ severity: 'error', where, message: `${c.left_column} isn't a column of ${left.name}` });
      if (!columnsOf(right.name).has(c.right_column.toLowerCase()) && !elementsOf(right).has(c.right_column.toLowerCase())) findings.push({ severity: 'error', where, message: `${c.right_column} isn't a column of ${right.name}` });
    }
    // The "one" side of a join must be its table's key, or the join fans out.
    // The right ("one") side must be its table's key; a one-to-one's left side must be unique, which its key shows (else a warning).
    const sides: Array<[SemanticTable, string[], boolean]> = [[right, r.relationship_columns.map((c) => c.right_column), true]];
    if (r.relationship_type === 'one_to_one') sides.push([left, r.relationship_columns.map((c) => c.left_column), false]);
    for (const [t, cols, strict] of sides) {
      const p = phys.get(t.name.toLowerCase());
      const k = (p ? knownKey(p, input.assertions)?.columns : undefined) ?? t.primary_key?.columns;
      if (!k) findings.push({ severity: 'warning', where, message: `no key is known for ${t.name}, so the join's ${r.relationship_type ?? 'many_to_one'} can't be confirmed` });
      else if (!sameCols(k, cols)) findings.push(strict
        ? { severity: 'error', where, message: `contradicts the key of ${t.name} (${k.join(', ')}): joining on (${cols.join(', ')}) as ${r.relationship_type ?? 'many_to_one'} would fan out` }
        : { severity: 'warning', where, message: `one_to_one needs ${t.name}.(${cols.join(', ')}) unique, and it isn't ${t.name}'s key (${k.join(', ')}): confirm it is unique` });
    }
  }

  // Against the knowledge: metrics.
  const metricFacts = input.assertions.filter((a) => !isMirror(a) && isLive(a.status) && a.kind === 'metric');
  for (const t of model.tables) {
    for (const m of t.metrics ?? []) {
      const fact = metricFacts.find((a) => snake(a.subject[0]?.startsWith('metric:') ? a.subject[0].slice(7) : String((a.value as { name?: unknown }).name ?? '')) === snake(m.name));
      const expr = fact ? (fact.value as { expression?: string }).expression : undefined;
      if (fact && expr && norm(expr) !== norm(m.expr)) findings.push({ severity: 'error', where: `${t.name}.${m.name}`, message: `fact ${fact.id} defines ${m.name} as "${expr}", the model as "${m.expr}"` });
    }
  }
  return findings;
}
