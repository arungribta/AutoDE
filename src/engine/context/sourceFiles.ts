import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseEstate } from './estate';
import { layoutPath } from '../workspaceLayout';

/**
 * The source material shared as files in the workspace (owner's test,
 * 2026-10-23: "source files, DDLs and data load scripts will be shared and
 * we should infer the source context from that"). Deterministic: a walk of
 * the workspace, each file classified by what it contains, with the estate
 * system it suggests and whether it is in the estate already. DDL and data
 * files can be ingested (`ingestFile`); load scripts are evidence to read
 * (what is loaded, from where), not structure.
 */

export type SourceFileKind = 'ddl' | 'data' | 'load-script';

export interface SourceFile {
  /** Workspace-relative, forward slashes. */
  path: string;
  kind: SourceFileKind;
  /** Tables a DDL file creates. */
  tables?: number;
  /** Schemas its tables are created in (a DDL file). */
  schemas?: string[];
  /** The estate system it most likely describes: its one schema, else its file name. */
  suggestedSystem: string;
  /** The estate system it is bound to, when it is in the estate already. */
  ingested?: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'target', '.venv', 'venv', '__pycache__', 'autode-output']);
const SKIP_FILES = /^(package(-lock)?|tsconfig.*|jsconfig|composer|\.?eslintrc.*|settings|launch|tasks|extensions)\.json$/i;
const CREATE_TABLE = /\bcreate\s+(?:or\s+replace\s+)?(?:(?:global\s+|local\s+)?(?:temporary|temp|transient|external)\s+)?table\s+(?:if\s+not\s+exists\s+)?([`"[\]\w.]+)/gi;
const LOAD_SQL = /\b(copy\s+into|insert\s+into|merge\s+into|load\s+data|bulk\s+insert|create\s+(?:or\s+replace\s+)?stage)\b/i;
const LOAD_CODE = /\b(read_csv|read_parquet|read_json|to_sql|spark\.read|copy\s+into|insert\s+into|snowflake\.connector|databricks\.sql|COPY\s+INTO)\b/i;
const MAX_FILES = 2000;
const MAX_BYTES = 2 * 1024 * 1024;

export function findSourceFiles(workspaceRoot: string): SourceFile[] {
  let estate;
  try { estate = parseEstate(fs.readFileSync(layoutPath(workspaceRoot, 'estate'), 'utf8')); } catch { estate = undefined; }
  const bound = new Map((estate?.bindings ?? []).filter((b) => b.file).map((b) => [b.file!.toLowerCase(), b.system]));
  const out: SourceFile[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || seen > MAX_FILES) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1); continue; }
      if (!e.isFile() || ++seen > MAX_FILES) continue;
      const f = classify(full, e.name);
      if (!f) continue;
      out.push({ ...f, path: path.relative(workspaceRoot, full).split(path.sep).join('/'), ...(bound.has(e.name.toLowerCase()) ? { ingested: bound.get(e.name.toLowerCase()) } : {}) });
    }
  };
  walk(workspaceRoot, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function classify(full: string, name: string): Omit<SourceFile, 'path' | 'ingested'> | undefined {
  const ext = path.extname(name).toLowerCase();
  const stem = name.slice(0, name.length - ext.length).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'source';
  if (ext === '.csv') return { kind: 'data', suggestedSystem: stem };
  if (ext === '.json') return SKIP_FILES.test(name) ? undefined : { kind: 'data', suggestedSystem: stem };
  if (!['.sql', '.ddl', '.py', '.sh', '.ps1'].includes(ext)) return undefined;
  let text: string;
  try { if (fs.statSync(full).size > MAX_BYTES) return undefined; text = fs.readFileSync(full, 'utf8'); } catch { return undefined; }
  if (ext === '.sql' || ext === '.ddl') {
    const names = [...text.matchAll(CREATE_TABLE)].map((m) => m[1].replace(/[`"[\]]/g, ''));
    if (names.length) {
      const schemas = [...new Set(names.filter((n) => n.includes('.')).map((n) => n.split('.').slice(-2, -1)[0].toLowerCase()))];
      return { kind: 'ddl', tables: names.length, schemas, suggestedSystem: schemas.length === 1 ? schemas[0] : stem };
    }
    return LOAD_SQL.test(text) ? { kind: 'load-script', suggestedSystem: stem } : undefined;
  }
  return LOAD_CODE.test(text) ? { kind: 'load-script', suggestedSystem: stem } : undefined;
}
