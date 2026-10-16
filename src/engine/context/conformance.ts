import { ContractEntity, ContractField, ContractModel } from './profiles';
import { PackDocument } from './pack';
import { ProbeExecutor, ProbeSpec } from './probes';
import { CatalogEntry } from './catalog';

/**
 * Conformance report (Phase C4a, item 9): each source system against a
 * contract, clause by clause. Schema conformance — column present, type
 * family, nullability — comes from the catalog (what was observed); data
 * conformance — blanks, uniqueness, accepted values — from probes. A clause
 * that can't be checked says so ("not verified — no connection or sample"),
 * never passes by default.
 */

export type ClauseStatus = 'pass' | 'fail' | 'not_verified';

export interface ClauseResult {
  entity: string;
  field: string;
  clause: 'present' | 'type' | 'nullability' | 'unique' | 'not_null' | 'accepted_values';
  status: ClauseStatus;
  expected: string;
  observed: string;
  /** `<file>#<path>` of the clause. */
  ref: string;
}

export interface TableConformance {
  tableId: string;
  fqn: string;
  system: string;
  environment: string;
  results: ClauseResult[];
}

export interface ConformanceReport {
  document: string;
  version: string;
  tables: TableConformance[];
  /** Contract entities no table could be bound to. */
  unbound: string[];
}

/** Lookup of catalogued tables (the host passes its catalog's entries). */
export interface ConformanceCatalog {
  all(): readonly CatalogEntry[];
}

/** Coarse type families: a contract says "text(255)", platforms say VARCHAR(255) or STRING. */
export function typeFamily(t: string | undefined): string | undefined {
  if (!t) return undefined;
  const s = t.toLowerCase();
  if (/^(n?var)?char|^text|^string|^clob|^nvarchar/.test(s)) return 'string';
  if (/^timestamp|^datetime/.test(s)) return 'timestamp';
  if (/^date$|^date\b/.test(s)) return 'date';
  if (/^bool/.test(s)) return 'boolean';
  if (/^(big|small|tiny)?int|^integer|^byteint/.test(s)) return 'integer';
  if (/^(number|numeric|decimal|float|double|real)/.test(s)) return 'number';
  return undefined;
}

function typesCompatible(expected: string, observed: string): boolean | undefined {
  const e = typeFamily(expected);
  const o = typeFamily(observed);
  if (!e || !o) return undefined;
  return e === o || (e === 'number' && o === 'integer');
}

/**
 * The tables a contract entity is realised by: the pack's explicit bindings,
 * else the table references the contract itself names, matched by fully
 * qualified name or `schema.table` in every system and environment.
 */
export function bindEntity(entity: ContractEntity, doc: Pick<PackDocument, 'bindings'>, catalog: ConformanceCatalog): CatalogEntry[] {
  const explicit = doc.bindings?.[entity.name] ?? doc.bindings?.[entity.name.toLowerCase()];
  const entries = catalog.all();
  if (explicit?.length) return entries.filter((e) => explicit.includes(e.id));
  const refs = entity.tables.map((t) => t.toLowerCase());
  return entries.filter((e) => {
    const fqn = String(e.table.fqn ?? '').toLowerCase();
    const short = `${e.table.schema}.${e.table.label}`.toLowerCase();
    return refs.some((r) => r === fqn || r === short || fqn.endsWith('.' + r));
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The physical column for a contract field in a table: per-system or per-schema mapping, else the field's own name. */
export function physicalColumn(field: ContractField, table: CatalogEntry): string {
  const m = field.columns ?? {};
  return m[table.system.toLowerCase()] ?? m[String(table.table.schema).toLowerCase()] ?? m[`${table.system}/${table.environment}`.toLowerCase()] ?? field.name;
}

const refOf = (doc: PackDocument, path: string) => `${doc.path}#${path}`;

export async function checkConformance(doc: PackDocument, model: ContractModel, catalog: ConformanceCatalog, probes?: ProbeExecutor): Promise<ConformanceReport> {
  const report: ConformanceReport = { document: doc.path, version: doc.version, tables: [], unbound: [] };
  for (const entity of model.entities) {
    const tables = bindEntity(entity, doc, catalog);
    if (tables.length === 0) { report.unbound.push(entity.name); continue; }
    for (const t of tables) {
      const results: ClauseResult[] = [];
      const cols = new Map((t.columns ?? []).map((c) => [c.label.toLowerCase(), c] as const));
      const probe = async (spec: Omit<ProbeSpec, 'table'>): Promise<{ status: ClauseStatus; observed: string }> => {
        if (!probes) return { status: 'not_verified', observed: 'not verified — no connection or sample' };
        try {
          const r = await probes.run({ ...spec, table: { fqn: t.table.fqn ?? t.table.label, id: t.id } });
          if (!r || r.pass === undefined) return { status: 'not_verified', observed: r ? r.detail : 'not verified — no connection or sample of this table' };
          return { status: r.pass ? 'pass' : 'fail', observed: `${r.detail}${r.source === 'sample' ? ' (sample data)' : ''}` };
        } catch (err) {
          return { status: 'not_verified', observed: `probe failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      };
      for (const f of entity.fields) {
        const name = physicalColumn(f, t);
        const col = cols.get(name.toLowerCase());
        const ref = refOf(doc, f.path);
        const row = (clause: ClauseResult['clause'], status: ClauseStatus, expected: string, observed: string) => results.push({ entity: entity.name, field: f.name, clause, status, expected, observed, ref });
        if (t.tier === 0 || !t.columns) { row('present', 'not_verified', name, 'structure not loaded'); continue; }
        if (!col) { row('present', 'fail', `column ${name}`, 'missing'); continue; }
        row('present', 'pass', `column ${name}`, col.label);
        if (f.type) {
          const ok = typesCompatible(f.type, col.dataType ?? '');
          row('type', ok === undefined ? 'not_verified' : ok ? 'pass' : 'fail', f.type, col.dataType ?? '?');
        }
        if (f.nullable === false) row('nullability', col.isNullable === false ? 'pass' : 'fail', 'mandatory (NOT NULL)', col.isNullable === false ? 'NOT NULL' : 'nullable');
        if (f.unique) { const r = await probe({ check: 'unique', columns: [col.label] }); row('unique', r.status, 'unique', r.observed); }
      }
      for (const r of entity.rules) {
        const field = entity.fields.find((f) => f.name.toLowerCase() === r.field.toLowerCase()) ?? { name: r.field, path: r.path };
        const name = physicalColumn(field, t);
        const col = cols.get(name.toLowerCase());
        const expected = r.check === 'accepted_values' ? `one of ${(r.values ?? []).join(', ')}` : r.check === 'not_null' ? 'no blanks' : 'unique';
        if (!col) { results.push({ entity: entity.name, field: r.field, clause: r.check, status: 'not_verified', expected, observed: `column ${name} missing`, ref: refOf(doc, r.path) }); continue; }
        const p = await probe({ check: r.check, columns: [col.label], values: r.values });
        results.push({ entity: entity.name, field: r.field, clause: r.check, status: p.status, expected, observed: p.observed, ref: refOf(doc, r.path) });
      }
      report.tables.push({ tableId: t.id, fqn: t.table.fqn ?? t.table.label, system: t.system, environment: t.environment, results });
    }
  }
  return report;
}

export function renderConformanceReport(r: ConformanceReport): string {
  const L = [`# Conformance report — ${r.document} (version ${r.version})`, ''];
  L.push('Each source table against the contract, clause by clause. Schema clauses are checked against the catalog (what discovery observed); data clauses by probes, which return counts only. "Not verified" means there was nothing to check against — no connection, sample or loaded structure.', '');
  L.push('| System | Table | Pass | Fail | Not verified |', '|---|---|---|---|---|');
  for (const t of r.tables) {
    const n = (s: ClauseStatus) => t.results.filter((x) => x.status === s).length;
    L.push(`| ${t.system}/${t.environment} | \`${t.fqn}\` | ${n('pass')} | ${n('fail')} | ${n('not_verified')} |`);
  }
  if (r.unbound.length) L.push('', `**Not bound to any table:** ${r.unbound.join(', ')} — add a binding in the pack, or import the system that realises it.`);
  for (const t of r.tables) {
    L.push('', `## ${t.system}/${t.environment} — \`${t.fqn}\``, '', '| Field | Clause | Status | Expected | Observed | Clause ref |', '|---|---|---|---|---|---|');
    for (const x of t.results) L.push(`| ${x.field} | ${x.clause} | ${x.status === 'pass' ? 'pass' : x.status === 'fail' ? '**FAIL**' : 'not verified'} | ${x.expected} | ${x.observed.replace(/\|/g, '\\|')} | \`${x.ref}\` |`);
  }
  return L.join('\n') + '\n';
}
