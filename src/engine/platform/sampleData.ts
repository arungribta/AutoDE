import type { ColumnMetadata, QueryResult, SchemaSnapshot } from './types';

/**
 * Sample-data consent and redaction (docs/mcp-engine-requirements.md phase 4).
 *
 * Row values — query results, profile minimums and maximums, query text from
 * the platform's history — reach a language model only when the connection's
 * `allowSampleDataInPrompts` is on (default off; `.autode/config/connections.yaml`).
 * Off, only schema, counts and aggregate statistics are kept. On, values in
 * columns that look like personal data are masked.
 *
 * Over MCP every tool result goes into the calling agent's prompt, so the gate
 * applies to what the server returns, not only to AutoDE's own prompts.
 *
 * Personal data is recognised from column names (and, for e-mail addresses and
 * card numbers, from the value itself) until phase GOV classifies columns.
 */

export const MASK = '[masked]';

/** Name tokens that denote personal data. Matched against the snake_case words of a column name. */
const PII_WORDS = new Set([
  'email', 'mail', 'phone', 'mobile', 'cell', 'fax', 'telephone', 'tel',
  'ssn', 'nin', 'nino', 'passport', 'aadhaar', 'nric', 'tin',
  'iban', 'bic', 'swift', 'cvv', 'cvc', 'pan',
  'dob', 'birthdate', 'birthday',
  'surname', 'firstname', 'lastname', 'fullname', 'forename', 'maiden',
  'address', 'street', 'postcode', 'postal', 'zip', 'zipcode',
  'ip', 'ipv4', 'ipv6', 'mac',
  'latitude', 'longitude', 'lat', 'lon', 'lng',
  'username', 'login', 'password', 'passwd',
  'salary', 'gender', 'ethnicity', 'religion', 'diagnosis'
]);

/** Two-word names (`first_name`, `date_of_birth` → `date_birth`, …). */
const PII_PHRASES = [
  'first name', 'last name', 'middle name', 'full name', 'given name', 'family name', 'maiden name',
  'customer name', 'contact name', 'person name', 'employee name', 'owner name', 'member name', 'patient name',
  'birth date', 'date birth', 'social security', 'national id', 'national insurance', 'tax id', 'tax number',
  'card number', 'credit card', 'debit card', 'cc number', 'account number', 'routing number', 'sort code',
  'license number', 'licence number', 'driver license', 'driving licence', 'user name', 'e mail'
];

function nameWords(column: string): string[] {
  return String(column ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && w !== 'of');
}

/** Whether a column name suggests personal data (heuristic, until GOV's classification). */
export function isPiiColumnName(column: string): boolean {
  const words = nameWords(column);
  if (words.some((w) => PII_WORDS.has(w))) return true;
  const joined = ` ${words.join(' ')} `;
  return PII_PHRASES.some((p) => joined.includes(` ${p} `));
}

const EMAIL = /[^\s@'"<>]+@[^\s@'"<>]+\.[a-z]{2,}/i;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Whether a value itself is personal data whatever its column is called: an e-mail address or a card number. */
export function looksLikePiiValue(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const s = String(value);
  if (EMAIL.test(s)) return true;
  const digits = s.replace(/[ -]/g, '');
  return /^\d{13,19}$/.test(digits) && /^[\d -]+$/.test(s) && luhn(digits);
}

export interface GatedRows {
  columns: string[];
  rowCount: number;
  /** Absent when values were withheld. */
  rows?: Array<Record<string, unknown>>;
  /** Why rows are absent. */
  withheld?: string;
  /** Columns masked as personal data (by name), when rows are present. */
  maskedColumns: string[];
  /** Further values masked because of their shape (e-mail, card number). */
  maskedValues: number;
}

/** Masks personal data in rows: whole columns by name, single values by shape. */
export function maskRows(columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>, isPii: (column: string) => boolean = isPiiColumnName): { rows: Array<Record<string, unknown>>; maskedColumns: string[]; maskedValues: number } {
  const names = new Set<string>(columns);
  for (const r of rows) for (const k of Object.keys(r)) names.add(k);
  const masked = new Set([...names].filter((c) => isPii(c)));
  let maskedValues = 0;
  const out = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => {
    if (masked.has(k)) return [k, v === null || v === undefined ? v : MASK];
    if (looksLikePiiValue(v)) { maskedValues++; return [k, MASK]; }
    return [k, v];
  })));
  return { rows: out, maskedColumns: [...masked].sort(), maskedValues };
}

/**
 * Applies the consent setting to a query result. `metadata` results (SHOW,
 * DESCRIBE, EXPLAIN) describe objects rather than data and pass unchanged.
 */
export function gateQueryResult(result: QueryResult, options: { allowSampleData: boolean; metadata: boolean; connectionId: string }): GatedRows {
  const base = { columns: [...result.columns], rowCount: result.rowCount };
  if (options.metadata) return { ...base, rows: [...result.rows], maskedColumns: [], maskedValues: 0 };
  if (!options.allowSampleData) {
    return {
      ...base,
      maskedColumns: [],
      maskedValues: 0,
      withheld: `Row values are withheld: sample data is not allowed in prompts for connection "${options.connectionId}". Only the columns and the row count are returned. To allow it, set allowSampleDataInPrompts: true for this connection in .autode/config/connections.yaml (values in personal-data columns stay masked).`
    };
  }
  return { ...base, ...maskRows(result.columns, result.rows) };
}

/**
 * The snapshot with row values removed (consent off) or masked (consent on):
 * profile minimum/maximum values, and the query text lineage carries from the
 * platform's query history (which holds literals from real queries). Counts,
 * types and structure are kept either way.
 */
export function sanitizeSnapshot(snapshot: SchemaSnapshot, allowSampleData: boolean): SchemaSnapshot {
  const column = (c: ColumnMetadata): ColumnMetadata => {
    if (!c.profile || (c.profile.minValue === undefined && c.profile.maxValue === undefined)) return c;
    const { minValue, maxValue, ...rest } = c.profile;
    if (!allowSampleData) return { ...c, profile: rest };
    const mask = (v: string | undefined) => (v === undefined ? undefined : isPiiColumnName(c.name) || looksLikePiiValue(v) ? MASK : v);
    return { ...c, profile: { ...rest, minValue: mask(minValue), maxValue: mask(maxValue) } };
  };
  return {
    ...snapshot,
    tables: snapshot.tables.map((t) => ({ ...t, columns: t.columns.map(column) })),
    ...(snapshot.lineage ? { lineage: allowSampleData ? snapshot.lineage : snapshot.lineage.map((e) => ({ ...e, queryText: undefined })) } : {})
  };
}
