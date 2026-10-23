import * as path from 'node:path';
import { BaseNode, GraphEdge, TableNode, ColumnNode, Origin } from './types';
import { DEFAULT_ENVIRONMENT, SystemRole, edgeId, objectId, originSideFor, slugifyId } from './estate';

/**
 * Which estate system and environment the file's objects belong to (Phase
 * K1). Defaults: a system named after the file, environment "default",
 * role source.
 */
export interface IngestIdentity {
  system?: string;
  environment?: string;
  role?: SystemRole;
}

interface ResolvedIdentity { system: string; environment: string; role: SystemRole }

function identityFor(filePath: string, identity?: IngestIdentity): ResolvedIdentity {
  return {
    system: identity?.system ? slugifyId(identity.system) : slugifyId(path.basename(filePath, path.extname(filePath))),
    environment: identity?.environment ? slugifyId(identity.environment) : DEFAULT_ENVIRONMENT,
    role: identity?.role ?? 'source'
  };
}

/**
 * Step 5 of the Source & Target Context Architecture plan — real, structural
 * file-based ingestion (CSV/JSON/DDL), as an alternative to live connectivity
 * when "connectivity is not always available" (security restrictions, network
 * boundaries, third-party-managed systems — per the reviewed proposal).
 *
 * Deliberately narrower than the full wishlist (Parquet/Avro need a real binary
 * parsing dependency; "sample data"/"metadata exports"/"data dictionaries"/
 * "documentation" are inherently free-text, which the business-problem pack
 * (documents read by LLM extraction) already handles) — this module
 * only covers formats genuinely parseable *structurally*, with zero new
 * dependencies, so a table/column fact it produces is a fact, not a guess.
 */

export type IngestibleFormat = 'csv' | 'json' | 'ddl';

export function detectFileFormat(filePath: string): IngestibleFormat | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') return 'csv';
  if (ext === '.json') return 'json';
  if (ext === '.sql' || ext === '.ddl') return 'ddl';
  return undefined;
}

export interface IngestResult {
  nodes: BaseNode[];
  edges: GraphEdge[];
  tableCount: number;
  columnCount: number;
  /** Non-fatal issues (e.g. a DDL statement that didn't parse) — surfaced to the user, never silently swallowed. */
  warnings: string[];
}

function baseOrigin(filePath: string, confidence: number, ident: ResolvedIdentity): Origin {
  const side = originSideFor(ident.role);
  return {
    source: 'derived',
    sourceRef: filePath,
    extractor: 'file-ingestion',
    extractedAt: new Date().toISOString(),
    ...(side ? { environment: side } : {}),
    system: ident.system,
    systemEnvironment: ident.environment,
    confidence,
    // Step 7 (governance layer): a structural file parse is a real fact about
    // the file's own content (hence confidence 1.0), but it's never been
    // checked against the actual live source — worth distinguishing from a
    // live connection's `'live-verified'` provenance so downstream generation
    // and the user can tell the two apart instead of treating them the same.
    reliability: 'best-effort-inferred'
  };
}

/**
 * Builds the table + column nodes + `contains` edges for one parsed table,
 * mirroring `BaseDataSourceAdapter.snapshotToGraph()`'s exact node/edge shape
 * so file-derived and live-connection-derived facts render identically
 * everywhere downstream (`ContextFileManager.buildContextPrompt()`, etc.).
 */
function buildTableGraph(
  tableName: string,
  columns: Array<{ name: string; dataType: string; isNullable?: boolean; isPrimaryKey?: boolean; comment?: string }>,
  filePath: string,
  schemaLabel: string,
  confidence: number,
  database: string | undefined,
  ident: ResolvedIdentity,
  description?: string
): { nodes: BaseNode[]; edges: GraphEdge[] } {
  const fqn = database ? `${database}.${schemaLabel}.${tableName}` : `${schemaLabel}.${tableName}`;
  const tableId = objectId(ident.system, ident.environment, fqn);
  const origin = baseOrigin(filePath, confidence, ident);
  const nodes: BaseNode[] = [];
  const edges: GraphEdge[] = [];

  const tableNode: TableNode = {
    id: tableId,
    type: 'table',
    label: tableName,
    ...(description ? { description } : {}),
    database: database ?? 'ingested_files',
    schema: schemaLabel,
    fqn,
    isView: false,
    metadata: { platform: 'file', sourceFile: path.basename(filePath) },
    version: 1,
    origin
  };
  nodes.push(tableNode);

  columns.forEach((col, idx) => {
    const colNode: ColumnNode = {
      id: objectId(ident.system, ident.environment, fqn, col.name),
      type: 'column',
      label: col.name,
      description: col.comment,
      dataType: col.dataType,
      isNullable: col.isNullable ?? true,
      isPrimaryKey: col.isPrimaryKey ?? false,
      isForeignKey: false,
      metadata: { ordinalPosition: idx + 1 },
      version: 1,
      origin
    };
    nodes.push(colNode);
    edges.push({ id: edgeId('contains', tableNode.id, colNode.id), source: tableNode.id, target: colNode.id, type: 'contains', weight: 1.0 });
  });

  return { nodes, edges };
}

/** Splits one CSV line into fields, honoring double-quoted fields (with `""`-escaped quotes) and commas inside them — not full RFC 4180 (no embedded-newline support), but correct for the common single-line-record case. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; } else { inQuotes = false; }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

/** Infers a coarse SQL-ish type from a sample of string values — real inference from real values, not an LLM guess. */
function inferCsvColumnType(values: string[]): string {
  const nonEmpty = values.filter((v) => v.trim().length > 0);
  if (nonEmpty.length === 0) return 'STRING';
  const isInt = nonEmpty.every((v) => /^-?\d+$/.test(v));
  if (isInt) return 'INTEGER';
  const isFloat = nonEmpty.every((v) => /^-?\d+\.\d+$/.test(v));
  if (isFloat) return 'FLOAT';
  const isBool = nonEmpty.every((v) => /^(true|false)$/i.test(v));
  if (isBool) return 'BOOLEAN';
  const isDate = nonEmpty.every((v) => /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(v));
  if (isDate) return 'TIMESTAMP';
  return 'STRING';
}

export function parseCsv(content: string, filePath: string, identity?: IngestIdentity): IngestResult {
  const warnings: string[] = [];
  const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { nodes: [], edges: [], tableCount: 0, columnCount: 0, warnings: ['File is empty.'] };
  }
  const header = splitCsvLine(lines[0]);
  const dictionary = detectColumnDictionary(header);
  if (dictionary) return parseColumnDictionary(lines, header, dictionary, filePath, identity);
  const sampleRows = lines.slice(1, 201).map(splitCsvLine); // sample up to 200 data rows for type inference — real values, bounded cost
  const columns = header.map((name, idx) => ({
    name: name || `column_${idx + 1}`,
    dataType: inferCsvColumnType(sampleRows.map((row) => row[idx] ?? ''))
  }));
  const tableName = path.basename(filePath, path.extname(filePath));
  if (lines.length - 1 > 200) {
    warnings.push(`Type inference sampled the first 200 of ${lines.length - 1} data rows.`);
  }
  const { nodes, edges } = buildTableGraph(tableName, columns, filePath, 'csv', 1.0, undefined, identityFor(filePath, identity));
  return { nodes, edges, tableCount: 1, columnCount: columns.length, warnings };
}

function inferJsonColumnType(value: unknown): string {
  if (value === null || value === undefined) return 'STRING';
  if (typeof value === 'number') return Number.isInteger(value) ? 'INTEGER' : 'FLOAT';
  if (typeof value === 'boolean') return 'BOOLEAN';
  if (Array.isArray(value)) return 'ARRAY';
  if (typeof value === 'object') return 'OBJECT';
  return 'STRING';
}

export function parseJson(content: string, filePath: string, identity?: IngestIdentity): IngestResult {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { nodes: [], edges: [], tableCount: 0, columnCount: 0, warnings: [`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const tableName = path.basename(filePath, path.extname(filePath));
  const records: Record<string, unknown>[] = Array.isArray(parsed)
    ? (parsed.filter((r) => r && typeof r === 'object' && !Array.isArray(r)) as Record<string, unknown>[])
    : (parsed && typeof parsed === 'object' ? [parsed as Record<string, unknown>] : []);

  if (records.length === 0) {
    return { nodes: [], edges: [], tableCount: 0, columnCount: 0, warnings: ['No object records found — expected a JSON array of objects, or a single object.'] };
  }
  if (Array.isArray(parsed) && records.length < parsed.length) {
    warnings.push(`${parsed.length - records.length} array entries were not objects and were skipped.`);
  }

  // Union of keys across a sample of records — a record missing a key just
  // means that field is nullable, not that the field doesn't exist.
  const sample = records.slice(0, 200);
  const keySet = new Set<string>();
  sample.forEach((rec) => Object.keys(rec).forEach((k) => keySet.add(k)));
  const columns = Array.from(keySet).map((name) => {
    const presentValues = sample.map((rec) => rec[name]).filter((v) => v !== undefined);
    const hasMissing = sample.some((rec) => rec[name] === undefined || rec[name] === null);
    return {
      name,
      dataType: presentValues.length > 0 ? inferJsonColumnType(presentValues[0]) : 'STRING',
      isNullable: hasMissing
    };
  });
  if (records.length > 200) {
    warnings.push(`Column inference sampled the first 200 of ${records.length} records.`);
  }
  const { nodes, edges } = buildTableGraph(tableName, columns, filePath, 'json', 1.0, undefined, identityFor(filePath, identity));
  return { nodes, edges, tableCount: 1, columnCount: columns.length, warnings };
}

/**
 * A small, deliberately narrow `CREATE TABLE` parser — not a general SQL
 * parser. Handles the common case (`CREATE TABLE [schema.]name (col type
 * [NOT NULL] [PRIMARY KEY], ...)`), across one or more statements in the file.
 * Constraint-only lines (`PRIMARY KEY (...)`, `FOREIGN KEY (...)`,
 * `CONSTRAINT ...`) are recognized and skipped rather than misparsed as columns.
 */
export function parseDdl(content: string, filePath: string, identity?: IngestIdentity): IngestResult {
  const ident = identityFor(filePath, identity);
  // Comments go first (v0.30.0): a trailing `-- A, B, C` comment's commas used to split
  // into bogus "columns", swallowing the next real column's name.
  const sql = content.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');
  const warnings: string[] = [];
  // K2: comments are a retrieval signal — `COMMENT ON TABLE|COLUMN x IS '…'` (Oracle, Teradata,
  // Postgres, Snowflake) and inline `COMMENT '…'` on a column (Snowflake, MySQL, Databricks).
  const tableComments = new Map<string, string>();
  const columnComments = new Map<string, string>();
  for (const m of sql.matchAll(/COMMENT\s+ON\s+(TABLE|COLUMN)\s+([a-zA-Z0-9_."`[\]]+)\s+IS\s+'((?:[^']|'')*)'/gi)) {
    const ref = m[2].replace(/["`[\]]/g, '').toLowerCase();
    (m[1].toUpperCase() === 'TABLE' ? tableComments : columnComments).set(ref, m[3].replace(/''/g, "'"));
  }
  const nodes: BaseNode[] = [];
  const edges: GraphEdge[] = [];
  let tableCount = 0;
  let columnCount = 0;

  const createTableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_."`[\]]+)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = createTableRe.exec(sql)) !== null) {
    const rawName = match[1].replace(/["`[\]]/g, '');
    // Keep the declared schema (and database): `shop.customers` and `crm.customers`
    // are different tables. Only an unqualified name falls back to the `ddl` label.
    // (Before v0.29.0 every table became `ddl.<name>`, so same-named tables collided.)
    const nameParts = rawName.split('.').filter(Boolean);
    const tableName = nameParts[nameParts.length - 1];
    const schemaLabel = nameParts.length >= 2 ? nameParts[nameParts.length - 2] : 'ddl';
    const database = nameParts.length >= 3 ? nameParts[nameParts.length - 3] : undefined;
    // Find the matching closing paren by bracket-depth counting from where the regex left off.
    const bodyStart = createTableRe.lastIndex;
    let depth = 1;
    let i = bodyStart;
    let quoted = false;
    while (i < sql.length && depth > 0) {
      if (sql[i] === "'") quoted = !quoted;
      else if (!quoted && sql[i] === '(') depth++;
      else if (!quoted && sql[i] === ')') depth--;
      i++;
    }
    if (depth !== 0) {
      warnings.push(`CREATE TABLE ${rawName}: unbalanced parentheses — skipped.`);
      continue;
    }
    const body = sql.slice(bodyStart, i - 1);
    const columns = parseDdlColumnDefs(body);
    for (const c of columns) c.comment = c.comment ?? columnComments.get(`${rawName}.${c.name}`.toLowerCase());
    if (columns.length === 0) {
      warnings.push(`CREATE TABLE ${rawName}: no parseable column definitions — skipped.`);
      continue;
    }
    const { nodes: tNodes, edges: tEdges } = buildTableGraph(tableName, columns, filePath, schemaLabel, 1.0, database, ident, tableComments.get(rawName.toLowerCase()));
    nodes.push(...tNodes);
    edges.push(...tEdges);
    tableCount++;
    columnCount += columns.length;
    createTableRe.lastIndex = i;
  }

  if (tableCount === 0 && warnings.length === 0) {
    warnings.push('No CREATE TABLE statements found.');
  }
  return { nodes, edges, tableCount, columnCount, warnings };
}

const DDL_CONSTRAINT_KEYWORDS = /^(PRIMARY\s+KEY|FOREIGN\s+KEY|CONSTRAINT|UNIQUE|CHECK|KEY\s*\()/i;

function parseDdlColumnDefs(body: string): Array<{ name: string; dataType: string; isNullable?: boolean; isPrimaryKey?: boolean; comment?: string }> {
  // Split on top-level commas only (not ones nested inside a type's own parens, e.g. DECIMAL(10,2)).
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quoted = false; // inside a '…' literal (a COMMENT may hold commas and parentheses)
  for (const ch of body) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && ch === ',' && depth === 0) { parts.push(current); current = ''; } else { current += ch; }
  }
  if (current.trim()) parts.push(current);

  const columns: Array<{ name: string; dataType: string; isNullable?: boolean; isPrimaryKey?: boolean; comment?: string }> = [];
  const tablePrimaryKey: string[] = [];
  for (const rawPart of parts) {
    const part = rawPart.trim();
    // A table-level `[CONSTRAINT x] PRIMARY KEY (a, b)` marks those columns as the key.
    const pk = /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(part);
    if (pk) tablePrimaryKey.push(...pk[1].split(',').map((c) => c.trim().replace(/["`[\]]/g, '').toLowerCase()).filter(Boolean));
    if (!part || DDL_CONSTRAINT_KEYWORDS.test(part)) continue;
    const colMatch = /^["`[]?([a-zA-Z_][a-zA-Z0-9_]*)["`\]]?\s+([a-zA-Z0-9_]+(?:\s*\([^)]*\))?)/.exec(part);
    if (!colMatch) continue;
    const name = colMatch[1];
    const dataType = colMatch[2].trim().toUpperCase();
    const isPrimaryKey = /PRIMARY\s+KEY/i.test(part);
    // A primary key column is never null, declared NOT NULL or not (as with a table-level PRIMARY KEY below).
    const isNullable = !/NOT\s+NULL/i.test(part) && !isPrimaryKey;
    const comment = /\bCOMMENT\s+'((?:[^']|'')*)'/i.exec(part)?.[1]?.replace(/''/g, "'");
    columns.push({ name, dataType, isNullable, isPrimaryKey, ...(comment ? { comment } : {}) });
  }
  for (const col of columns) {
    if (tablePrimaryKey.includes(col.name.toLowerCase())) { col.isPrimaryKey = true; col.isNullable = false; }
  }
  return columns;
}

export function parseFile(content: string, filePath: string, identity?: IngestIdentity): IngestResult {
  const format = detectFileFormat(filePath);
  if (format === 'csv') return parseCsv(content, filePath, identity);
  if (format === 'json') return parseJson(content, filePath, identity);
  if (format === 'ddl') return parseDdl(content, filePath, identity);
  return { nodes: [], edges: [], tableCount: 0, columnCount: 0, warnings: [`Unsupported file type: ${path.extname(filePath) || '(no extension)'}. Supported: .csv, .json, .sql, .ddl.`] };
}

// ── Legacy column-dictionary exports (Phase K1 item 7) ─────────────────────────

type DictionaryFlavor = 'teradata' | 'oracle' | 'information_schema';

interface DictionaryColumns {
  flavor: DictionaryFlavor;
  catalog?: number;
  schema: number;
  table: number;
  column: number;
  type: number;
  length?: number;
  precision?: number;
  scale?: number;
  nullable?: number;
  ordinal?: number;
  comment?: number;
}

/**
 * Recognises a column-dictionary export by its header names: Teradata
 * `DBC.ColumnsV` (DatabaseName, TableName, ColumnName, ColumnType …), Oracle
 * `ALL_TAB_COLUMNS` (OWNER, TABLE_NAME, COLUMN_NAME, DATA_TYPE …) and
 * `INFORMATION_SCHEMA.COLUMNS` (TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME,
 * DATA_TYPE …; SQL Server, Snowflake, Postgres, MySQL).
 */
function detectColumnDictionary(header: string[]): DictionaryColumns | undefined {
  const h = header.map((x) => x.trim().toLowerCase());
  const at = (...names: string[]) => { const i = h.findIndex((x) => names.includes(x)); return i >= 0 ? i : undefined; };
  const table = at('tablename', 'table_name');
  const column = at('columnname', 'column_name');
  if (table === undefined || column === undefined) return undefined;
  const common = { table, column, length: at('columnlength', 'data_length', 'character_maximum_length'), precision: at('decimaltotaldigits', 'data_precision', 'numeric_precision'), scale: at('decimalfractionaldigits', 'data_scale', 'numeric_scale'), nullable: at('nullable', 'is_nullable'), ordinal: at('columnid', 'column_id', 'ordinal_position'), comment: at('commentstring', 'comments', 'comment', 'column_comment') };
  const tdSchema = at('databasename');
  const tdType = at('columntype');
  if (tdSchema !== undefined && tdType !== undefined) return { flavor: 'teradata', schema: tdSchema, type: tdType, ...common };
  const owner = at('owner');
  const dataType = at('data_type');
  if (owner !== undefined && dataType !== undefined) return { flavor: 'oracle', schema: owner, type: dataType, ...common };
  const isSchema = at('table_schema');
  if (isSchema !== undefined && dataType !== undefined) return { flavor: 'information_schema', catalog: at('table_catalog'), schema: isSchema, type: dataType, ...common };
  return undefined;
}

/** Teradata `ColumnType` codes → SQL type names (the common ones; anything else is kept as given). */
const TERADATA_TYPES: Record<string, string> = {
  CV: 'VARCHAR', CF: 'CHAR', CO: 'CLOB', BO: 'BLOB', BF: 'BYTE', BV: 'VARBYTE',
  I: 'INTEGER', I1: 'BYTEINT', I2: 'SMALLINT', I8: 'BIGINT', F: 'FLOAT', D: 'DECIMAL', N: 'NUMBER',
  DA: 'DATE', AT: 'TIME', TS: 'TIMESTAMP', TZ: 'TIME WITH TIME ZONE', SZ: 'TIMESTAMP WITH TIME ZONE', JN: 'JSON', XM: 'XML'
};

function dictionaryType(flavor: DictionaryFlavor, row: string[], c: DictionaryColumns): string {
  const raw = (row[c.type] ?? '').trim();
  const len = c.length !== undefined ? (row[c.length] ?? '').trim() : '';
  const prec = c.precision !== undefined ? (row[c.precision] ?? '').trim() : '';
  const scale = c.scale !== undefined ? (row[c.scale] ?? '').trim() : '';
  const base = flavor === 'teradata' ? (TERADATA_TYPES[raw.toUpperCase()] ?? raw.toUpperCase()) : raw.toUpperCase();
  if (/^(DECIMAL|NUMBER|NUMERIC)$/.test(base) && prec && /^\d+$/.test(prec)) return `${base}(${prec}${scale && /^\d+$/.test(scale) ? `,${scale}` : ''})`;
  if (/CHAR|BYTE|BINARY/.test(base) && !/CHAR\(/.test(base) && len && /^\d+$/.test(len) && len !== '-1') return `${base}(${len})`;
  return base || 'UNKNOWN';
}

function parseColumnDictionary(lines: string[], header: string[], c: DictionaryColumns, filePath: string, identity?: IngestIdentity): IngestResult {
  const ident = identityFor(filePath, identity);
  const tables = new Map<string, { catalog?: string; schema: string; table: string; cols: Array<{ ord: number; name: string; dataType: string; isNullable: boolean; comment?: string }> }>();
  const warnings: string[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const row = splitCsvLine(line);
    const schema = (row[c.schema] ?? '').trim();
    const table = (row[c.table] ?? '').trim();
    const column = (row[c.column] ?? '').trim();
    if (!schema || !table || !column) { skipped++; continue; }
    const catalog = c.catalog !== undefined ? (row[c.catalog] ?? '').trim() || undefined : undefined;
    const key = `${catalog ?? ''}|${schema}|${table}`.toLowerCase();
    const entry = tables.get(key) ?? { catalog, schema, table, cols: [] };
    const nullRaw = c.nullable !== undefined ? (row[c.nullable] ?? '').trim().toUpperCase() : '';
    const ordRaw = c.ordinal !== undefined ? Number((row[c.ordinal] ?? '').trim()) : NaN;
    const comment = c.comment !== undefined ? (row[c.comment] ?? '').trim() || undefined : undefined;
    entry.cols.push({ ord: Number.isFinite(ordRaw) ? ordRaw : entry.cols.length + 1, name: column, dataType: dictionaryType(c.flavor, row, c), isNullable: !(nullRaw === 'N' || nullRaw === 'NO'), ...(comment ? { comment } : {}) });
    tables.set(key, entry);
  }
  if (skipped) warnings.push(`${skipped} row(s) without a schema, table or column name were skipped.`);
  const nodes: BaseNode[] = [];
  const edges: GraphEdge[] = [];
  let columnCount = 0;
  for (const t of tables.values()) {
    const cols = t.cols.sort((a, b) => a.ord - b.ord).map(({ name, dataType, isNullable, comment }) => ({ name, dataType, isNullable, comment }));
    const g = buildTableGraph(t.table, cols, filePath, t.schema, 1.0, t.catalog, ident);
    for (const n of g.nodes) if (n.type === 'table') (n.metadata as Record<string, unknown>).dictionaryFlavor = c.flavor;
    nodes.push(...g.nodes);
    edges.push(...g.edges);
    columnCount += cols.length;
  }
  warnings.push(`Read as a ${c.flavor === 'teradata' ? 'Teradata DBC.ColumnsV' : c.flavor === 'oracle' ? 'Oracle ALL_TAB_COLUMNS' : 'INFORMATION_SCHEMA.COLUMNS'} column dictionary (${header.length} columns in the export).`);
  return { nodes, edges, tableCount: tables.size, columnCount, warnings };
}
