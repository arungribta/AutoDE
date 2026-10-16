/**
 * Lexical classification of SQL for the MCP server's read-only mode
 * (docs/mcp-engine-requirements.md §5.3, phase 4): strips comments, string
 * literals and quoted identifiers, splits statements on the semicolons that
 * remain, and looks at the words left over.
 *
 * Dialects disagree about quoting — Snowflake and Spark SQL honour backslash
 * escapes in strings, Spark quotes identifiers with backticks and strings with
 * double quotes, Snowflake has `$$…$$` strings; ANSI SQL has none of these. A
 * guard that reads a string where the platform reads code can be bypassed
 * (`'x\'' ; DROP …`), so the text is tokenised under **both** conventions and
 * accepted only when both agree it is one read-only statement.
 *
 * This is a guard, not a security boundary: functions with side effects
 * (some `SYSTEM$…` functions, procedures behind views) are invisible to it. A
 * read-only platform role is the boundary; docs/mcp-setup.md says so.
 */

/** Statements whose results describe objects, not data: returned whatever the sample-data setting says. */
const METADATA_KEYWORDS = new Set(['SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN']);
const READ_KEYWORDS = new Set(['SELECT', 'WITH', ...METADATA_KEYWORDS]);

/**
 * Words that make a statement a write wherever they appear outside literals.
 * `INTO` catches `SELECT … INTO new_table`; `ANALYZE` catches `EXPLAIN ANALYZE`
 * (which executes on some platforms). `REPLACE`, `GET` and `SET` are absent on
 * purpose: they are also function names or appear in read-only clauses.
 */
const WRITE_KEYWORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'RENAME', 'UNDROP',
  'GRANT', 'REVOKE', 'CALL', 'EXEC', 'EXECUTE', 'COPY', 'PUT', 'REMOVE', 'INTO', 'REFRESH', 'OPTIMIZE', 'VACUUM',
  'MSCK', 'ANALYZE', 'CACHE', 'UNCACHE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'DECLARE', 'USE'
]);

interface Convention {
  /** Backslash escapes the next character inside quotes. */
  backslash: boolean;
  /** Backtick-quoted identifiers. */
  backtick: boolean;
  /** `$$…$$` strings. */
  dollar: boolean;
}

const CONVENTIONS: readonly Convention[] = [
  { backslash: false, backtick: false, dollar: false },
  { backslash: true, backtick: true, dollar: true }
];

interface Lexed {
  /** Words outside comments, literals and quoted identifiers, per statement (upper case). */
  statements: string[][];
  /** Set when a quote or block comment never closes. */
  unterminated?: string;
}

function lex(sql: string, c: Convention): Lexed {
  const statements: string[][] = [[]];
  let i = 0;
  const n = sql.length;
  const closeQuote = (q: string): boolean => {
    // Returns false when the quote never closes; doubled quotes are escapes in every dialect.
    for (i++; i < n; i++) {
      const ch = sql[i];
      if (c.backslash && ch === '\\' && q !== '`') { i++; continue; }
      if (ch === q) {
        if (sql[i + 1] === q) { i++; continue; }
        i++;
        return true;
      }
    }
    return false;
  };
  while (i < n) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) return { statements, unterminated: 'a block comment' };
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || (c.backtick && ch === '`')) {
      if (!closeQuote(ch)) return { statements, unterminated: `a ${ch} quote` };
      continue;
    }
    if (c.dollar && ch === '$' && sql[i + 1] === '$') {
      const end = sql.indexOf('$$', i + 2);
      if (end < 0) return { statements, unterminated: 'a $$ string' };
      i = end + 2;
      continue;
    }
    if (ch === ';') {
      statements.push([]);
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      statements[statements.length - 1].push(sql.slice(i, j).toUpperCase());
      i = j;
      continue;
    }
    i++;
  }
  return { statements };
}

export interface SqlCheck {
  ok: boolean;
  /** Non-empty statements found (the larger count of the two conventions). */
  statements: number;
  /** First keyword of the (single) statement. */
  firstKeyword?: string;
  /** `metadata` for SHOW / DESCRIBE / EXPLAIN, `query` for SELECT / WITH, `write` for anything else. */
  kind?: 'query' | 'metadata' | 'write';
  /** Why the check failed. */
  reason?: string;
}

/** One statement, in any convention — the precondition for every execution, read-only or not. */
export function checkSingleStatement(sql: string): SqlCheck {
  let first: string | undefined;
  let words: string[] = [];
  let count = 0;
  for (const c of CONVENTIONS) {
    const lexed = lex(String(sql ?? ''), c);
    if (lexed.unterminated) return { ok: false, statements: 0, reason: `The SQL has an unterminated ${lexed.unterminated}.` };
    const nonEmpty = lexed.statements.filter((s) => s.length > 0);
    count = Math.max(count, nonEmpty.length);
    if (nonEmpty.length !== 1) continue;
    if (first !== undefined && first !== nonEmpty[0][0]) return { ok: false, statements: count, reason: 'The SQL reads differently under different quoting rules; simplify the quoting.' };
    first = nonEmpty[0][0];
    words = words.concat(nonEmpty[0]);
  }
  if (count === 0) return { ok: false, statements: 0, reason: 'No SQL statement found.' };
  if (count > 1) return { ok: false, statements: count, reason: `Only one statement per call is allowed; found ${count}.` };
  const kind = !first || !READ_KEYWORDS.has(first) || words.some((w) => WRITE_KEYWORDS.has(w)) ? 'write' : METADATA_KEYWORDS.has(first) ? 'metadata' : 'query';
  return { ok: true, statements: 1, firstKeyword: first, kind };
}

/** One read-only statement: SELECT / WITH / SHOW / DESCRIBE / EXPLAIN, with no write keyword anywhere outside literals. */
export function checkReadOnlySql(sql: string): SqlCheck {
  const single = checkSingleStatement(sql);
  if (!single.ok) return single;
  if (single.kind === 'write') {
    const first = single.firstKeyword ?? '';
    return {
      ...single,
      ok: false,
      reason: READ_KEYWORDS.has(first)
        ? `A ${first} statement that writes (or may write) is not allowed in read-only mode.`
        : `${first || 'This'} statements are not allowed in read-only mode; only SELECT, WITH, SHOW, DESCRIBE and EXPLAIN are.`
    };
  }
  return single;
}

/** The statement without a trailing semicolon — some platform APIs reject one. */
export function stripTrailingSemicolon(sql: string): string {
  return String(sql ?? '').replace(/;\s*$/, '').trim();
}
