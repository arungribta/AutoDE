import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml } from '../context/Yaml';

/**
 * The `file` transport (POP5; docs/specs/platform-operations.md §2.1): files in a bound folder, which may be a Git
 * checkout (AutoDE doesn't clone it). An operation names a glob and a parser. Reading stays inside the folder:
 * the pattern is relative, symbolic links are skipped, and the sizes are capped. Each file read gives one row (or,
 * with `results`, one row per item at that path), carrying `_file`, its path in the folder. A file that can't be read
 * is reported and the others are still read. `.git` and `node_modules` are never walked.
 */

export interface FileRead { glob: string; parse: 'yaml' | 'json' | 'csv'; results?: string }

export interface FileReadResult {
  rows: Array<Record<string, unknown>>;
  /** How many files matched. */
  files: number;
  /** Files that couldn't be read, and why. */
  problems: string[];
  truncated: boolean;
}

export type FileCall = (read: FileRead, maxRows: number) => Promise<FileReadResult>;

export interface FileCaps { maxFiles: number; maxFileBytes: number; maxBytes: number }
export const FILE_CAPS: FileCaps = { maxFiles: 5000, maxFileBytes: 20_000_000, maxBytes: 200_000_000 };

const SKIP_DIRS = new Set(['.git', 'node_modules']);

/** A pattern that stays inside the folder: relative, with no `..`. */
export function checkGlob(glob: string): string | undefined {
  const g = glob.replace(/\\/g, '/');
  if (!g.trim()) return 'an empty pattern';
  if (g.startsWith('/') || /^[A-Za-z]:/.test(g)) return `"${glob}" isn't relative to the folder`;
  if (g.split('/').some((s) => s === '..')) return `"${glob}" goes outside the folder`;
  return undefined;
}

/** `*` within a name, `**` across folders, `?` one character, `{a,b}` either. Case-sensitive, as Git is. */
export function globRegex(glob: string): RegExp {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '';
  let depth = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { out += '(?:[^/]+/)*'; i += 2; } else { out += '.*'; i += 1; }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{') { out += '(?:'; depth++; }
    else if (c === '}' && depth) { out += ')'; depth--; }
    else if (c === ',' && depth) out += '|';
    else out += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function walk(root: string, rel: string, match: RegExp, found: string[], limit: number): void {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (found.length > limit) return;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(root, r, match, found, limit); continue; }
    if (e.isFile() && match.test(r)) found.push(r);
  }
}

/** Comma-separated text with a header line; quoted cells may hold commas, quotes and line breaks. */
export function parseCsvRows(text: string): Array<Record<string, unknown>> {
  const lines: string[][] = [];
  let cell = ''; let row: string[] = []; let quoted = false;
  const endCell = () => { row.push(cell); cell = ''; };
  const endRow = () => { endCell(); if (row.length > 1 || row[0] !== '') lines.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') endCell();
    else if (c === '\n') endRow();
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) endRow();
  const [head, ...body] = lines;
  return head ? body.map((cells) => Object.fromEntries(head.map((h, i) => [h.trim(), cells[i] ?? null]))) : [];
}

/** A value at a dotted path, with `$.` allowed in front; keys matched without regard to case when not exact. */
export function valueAt(value: unknown, dotted: string | undefined): unknown {
  const p = (dotted ?? '').replace(/^\$\.?/, '');
  if (!p) return value;
  let v: unknown = value;
  for (const k of p.split('.')) {
    if (!v || typeof v !== 'object') return undefined;
    const o = v as Record<string, unknown>;
    if (k in o) { v = o[k]; continue; }
    const found = Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase());
    v = found === undefined ? undefined : o[found];
  }
  return v;
}

function rowsOfFile(text: string, read: FileRead): Array<Record<string, unknown>> {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (read.parse === 'csv') return parseCsvRows(clean);
  const doc: unknown = read.parse === 'json' ? JSON.parse(clean) : parseYaml(clean);
  const at = valueAt(doc, read.results);
  if (read.results && (at === undefined || at === null)) throw new Error(`it has no ${read.results}`);
  const list = Array.isArray(at) ? at : [at];
  return list.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : { value: x }));
}

/** Reads a bound folder. `root` is the connection's folder, absolute or relative to `baseDir`. */
export function fileConnection(root: string, title: string, baseDir?: string, caps: FileCaps = FILE_CAPS): FileCall {
  const folder = path.resolve(baseDir ?? process.cwd(), root);
  return async (read, maxRows) => {
    const bad = checkGlob(read.glob);
    if (bad) throw new Error(`Refused: ${bad}.`);
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`${title}'s folder ${folder} doesn't exist. Correct the connection, or clone the repository there first.`);
    const found: string[] = [];
    walk(folder, '', globRegex(read.glob), found, caps.maxFiles);
    const tooMany = found.length > caps.maxFiles;
    const files = found.slice(0, caps.maxFiles);
    const rows: Array<Record<string, unknown>> = [];
    const problems: string[] = [];
    let bytes = 0;
    let truncated = tooMany;
    for (const rel of files) {
      if (rows.length >= maxRows) { truncated = true; break; }
      const full = path.join(folder, rel);
      try {
        const size = fs.statSync(full).size;
        if (size > caps.maxFileBytes) throw new Error(`${size} bytes, over the ${caps.maxFileBytes} a file may be`);
        bytes += size;
        if (bytes > caps.maxBytes) { truncated = true; problems.push(`stopped at ${rel}: over the ${caps.maxBytes} bytes one read may take`); break; }
        for (const r of rowsOfFile(fs.readFileSync(full, 'utf8'), read)) rows.push({ ...r, _file: rel });
      } catch (err) { problems.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    return { rows: rows.slice(0, maxRows), files: files.length, problems, truncated: truncated || rows.length > maxRows };
  };
}
