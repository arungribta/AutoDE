import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import Ajv, { ValidateFunction } from 'ajv';
import { parseYaml } from '../../context/Yaml';
import { layoutPath } from '../../workspaceLayout';
import { checkReadOnlySql } from '../sqlGuard';
import { BindError, bindTemplate, sampleValues, valuesFor } from './bind';
import { mapRows } from './map';
import { OPERATION_SCHEMA, PLATFORM_SCHEMA } from './schema';
import { Loaded, PlatformDefinition, PlatformOperation } from './types';

/**
 * Loading the catalog (POP1): AutoDE's operations (`platform-operations/`)
 * and platform definitions (`platforms/`), and the team's in
 * `.autode/config/`, which replace a shipped one with the same id once a
 * person approves them (decision kind platform_operation; the approval is
 * for the file's exact content). Every file is checked as it loads, item by
 * item: the schema, each read implementation through the read-only guard,
 * and the recorded example's binding and mapping. A bad file is refused
 * with its reasons; the rest still load.
 */

export interface CatalogScope { resourcesRoot?: string; workspaceRoot?: string }

export interface Catalog {
  operations: Array<Loaded<PlatformOperation>>;
  platforms: Array<Loaded<PlatformDefinition>>;
  errors: string[];
}

interface Approval { checksum: string; by: string; at: string; decisionId?: string }
export interface Approvals { operations: Record<string, Approval>; platforms: Record<string, Approval> }

let compiled: { op: ValidateFunction; platform: ValidateFunction } | undefined;
function validators() {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: false, logger: false });
    compiled = { op: ajv.compile(OPERATION_SCHEMA), platform: ajv.compile(PLATFORM_SCHEMA) };
  }
  return compiled;
}
const schemaErrors = (v: ValidateFunction) => (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);

export function checksumOf(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

/** What is wrong with an operation (empty: none). `platforms` lets an implementation's dialect be used. */
export function checkOperation(op: PlatformOperation, platforms: ReadonlyMap<string, PlatformDefinition> = new Map()): string[] {
  const v = validators().op;
  if (!v(op)) return schemaErrors(v);
  const errors: string[] = [];
  const names = new Set<string>();
  for (const p of op.params) { if (names.has(p.name)) errors.push(`parameter ${p.name} twice`); names.add(p.name); }
  for (const [pid, impl] of Object.entries(op.platforms)) {
    const d = platforms.get(pid)?.dialect ?? {};
    try {
      if (impl.sql) {
        const bound = bindTemplate(impl.sql, op.params, sampleValues(op.params), d);
        const c = checkReadOnlySql(bound);
        if (op.kind === 'read' && !c.ok) errors.push(`${pid}: a read operation must be one read-only statement (${c.reason})`);
      }
      if (impl.cli) for (const a of impl.cli) bindTemplate(a, op.params, sampleValues(op.params), d);
      if (impl.http && op.kind === 'read' && impl.http.method === 'POST' && !impl.http.readOnly) errors.push(`${pid}: a read over http is a GET, or a POST declared readOnly (a search)`);
    } catch (err) { errors.push(`${pid}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  if (op.example) {
    const pid = op.example.platform ?? Object.keys(op.platforms)[0];
    const impl = op.platforms[pid];
    if (!impl) errors.push(`example: no implementation for ${pid}`);
    else try {
      const values = valuesFor(op.params, op.example.params);
      if (impl.sql) bindTemplate(impl.sql, op.params, values, platforms.get(pid)?.dialect ?? {});
      const mapped = mapRows(op.returns, op.example.rows);
      const missing = op.returns.filter((r) => op.example!.rows.length && mapped.every((m) => m[r.name] === null) && !op.example!.rows.some((row) => Object.keys(row).some((k) => k.toLowerCase() === (r.from ?? r.name).toLowerCase())));
      if (missing.length) errors.push(`example: no column for ${missing.map((r) => r.from ?? r.name).join(', ')}`);
    } catch (err) { errors.push(`example: ${err instanceof BindError || err instanceof Error ? err.message : String(err)}`); }
  }
  return errors;
}

export function checkPlatform(p: PlatformDefinition): string[] {
  const v = validators().platform;
  return v(p) ? [] : schemaErrors(v);
}

function yamlFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? yamlFiles(p) : /\.ya?ml$/i.test(e.name) ? [p] : [];
  });
}

export function readApprovals(workspaceRoot: string | undefined): Approvals {
  if (!workspaceRoot) return { operations: {}, platforms: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(layoutPath(workspaceRoot, 'platformApprovals'), 'utf8')) as Partial<Approvals>;
    return { operations: raw.operations ?? {}, platforms: raw.platforms ?? {} };
  } catch { return { operations: {}, platforms: {} }; }
}

export function writeApproval(workspaceRoot: string, what: 'operations' | 'platforms', id: string, approval: Approval): void {
  const all = readApprovals(workspaceRoot);
  all[what][id] = approval;
  const file = layoutPath(workspaceRoot, 'platformApprovals');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
}

function loadKind<T extends { id: string }>(dirs: Array<{ dir: string; origin: 'shipped' | 'team' }>, approvals: Record<string, Approval>, check: (item: T) => string[], label: string, root: string | undefined, errors: string[]): Array<Loaded<T>> {
  const byId = new Map<string, Loaded<T>>();
  const drafts: Array<Loaded<T>> = [];
  for (const { dir, origin } of dirs) {
    for (const file of yamlFiles(dir)) {
      const rel = root ? path.relative(root, file).split(path.sep).join('/') : file;
      let text: string; let item: T;
      try { text = fs.readFileSync(file, 'utf8'); item = parseYaml(text) as T; } catch (err) { errors.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`); continue; }
      const problems = check(item);
      if (problems.length) { errors.push(`${rel}: ${problems.join('; ')}`); continue; }
      const checksum = checksumOf(text);
      const a = origin === 'team' ? approvals[item.id] : undefined;
      const status = origin === 'shipped' || (a && a.checksum === checksum) ? 'approved' : 'draft';
      const entry: Loaded<T> = { item, origin, file: rel, checksum, status, ...(a && status === 'approved' ? { approvedBy: a.by } : {}) };
      if (origin === 'shipped') { if (byId.has(item.id)) errors.push(`${rel}: ${label} ${item.id} is defined twice`); byId.set(item.id, entry); continue; }
      entry.overrides = byId.has(item.id);
      if (status === 'approved') byId.set(item.id, entry); else drafts.push(entry);
    }
  }
  return [...byId.values(), ...drafts];
}

/** The catalog in effect: shipped files, replaced by approved team files; team drafts are listed, never run. */
export function loadCatalog(scope: CatalogScope): Catalog {
  const errors: string[] = [];
  const approvals = readApprovals(scope.workspaceRoot);
  const root = scope.workspaceRoot ?? scope.resourcesRoot;
  const dirs = (shipped: string, team: Parameters<typeof layoutPath>[1]) => [
    ...(scope.resourcesRoot ? [{ dir: path.join(scope.resourcesRoot, shipped), origin: 'shipped' as const }] : []),
    ...(scope.workspaceRoot ? [{ dir: layoutPath(scope.workspaceRoot, team), origin: 'team' as const }] : [])
  ];
  const platforms = loadKind<PlatformDefinition>(dirs('platforms', 'platformDefinitions'), approvals.platforms, checkPlatform, 'platform', root, errors);
  const effective = new Map(platforms.filter((p) => p.status === 'approved').map((p) => [p.item.id, p.item] as const));
  const operations = loadKind<PlatformOperation>(dirs('platform-operations', 'platformOperations'), approvals.operations, (op) => checkOperation(op, effective), 'operation', root, errors);
  return { operations, platforms, errors };
}

/** The operation in effect with this id (shipped, or the approved team file); drafts never run. */
export function operationById(catalog: Catalog, id: string): Loaded<PlatformOperation> | undefined {
  return catalog.operations.find((o) => o.item.id === id && o.status === 'approved');
}

export function platformById(catalog: Catalog, id: string): PlatformDefinition | undefined {
  return catalog.platforms.find((p) => p.item.id === id && p.status === 'approved')?.item;
}
