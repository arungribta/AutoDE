import { OperationReturn } from './types';

/** A result column found without regard to case (platforms differ: Snowflake upper-cases, Databricks keeps). */
function column(row: Record<string, unknown>, name: string): unknown {
  if (name in row) return row[name];
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(row)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

function convert(v: unknown, as: OperationReturn['as']): unknown {
  if (v === undefined || v === null || v === '') return null;
  switch (as) {
    case 'number': { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? n : null; }
    case 'yes_no': return /^(y|yes|true|1)$/i.test(String(v));
    case 'boolean': return v === true || /^(true|1)$/i.test(String(v));
    case 'json': if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; }
    default: return typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

/** The platform's rows as the operation's declared result: each declared column, by name, typed; nothing else. */
export function mapRows(returns: readonly OperationReturn[], rows: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => Object.fromEntries(returns.map((r) => [r.name, convert(column(row, r.from ?? r.name), r.as)])));
}
