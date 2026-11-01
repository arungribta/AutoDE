import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml, stringifyYaml } from '../../context/Yaml';
import { layoutPath } from '../../workspaceLayout';
import { checkOperation, customise, loadCatalog, platformById } from './load';
import { OPERATION_SCHEMA } from './schema';
import { PlatformOperation } from './types';

/**
 * POP4b, the operation form (docs/specs/platform-operations.md §6.3): a form generated from the operation's JSON
 * Schema, so a new field in the format reaches the form without screen code. Saving checks the operation as the
 * loader does (the schema, the read-only guard for reads, the example's binding) and writes the team's file, a
 * draft until a person approves it (decision kind platform_operation). A shipped operation is copied first
 * (Customise); AutoDE's own file is never written.
 */

export interface FormField {
  key: string;
  label: string;
  description: string;
  control: 'text' | 'textarea' | 'select' | 'checkbox' | 'readonly';
  options?: string[];
  required: boolean;
  value: string;
}

export interface OperationForm {
  id: string;
  /** Where saving writes: the team's file (made from the shipped one on the first save). */
  file: string;
  origin: 'shipped' | 'team';
  status: string;
  fields: FormField[];
  /** One row per parameter, the columns from the schema's parameter item. */
  params: { columns: FormField[]; rows: Array<Record<string, string>> };
  /** The statement (or argument list, one per line) per platform. */
  platforms: Array<{ platform: string; transport: 'sql' | 'cli' | 'other'; label: string; description: string; value: string }>;
  next: string;
}

type Prop = { type?: string; enum?: readonly string[]; const?: unknown; description?: string; minLength?: number };
const LABELS: Record<string, string> = { id: 'Id', title: 'Title', description: 'Description', kind: 'Kind', content: 'Content', area: 'Area', name: 'Name', label: 'Label', type: 'Type', required: 'Required' };
const labelOf = (k: string) => LABELS[k] ?? k.charAt(0).toUpperCase() + k.slice(1).replace(/([A-Z])/g, ' $1').toLowerCase();

function fieldsOf(props: Record<string, Prop>, required: readonly string[], values: Record<string, unknown>, readonly: readonly string[] = []): FormField[] {
  return Object.entries(props).flatMap(([key, p]): FormField[] => {
    if (p.const !== undefined || (p.type !== 'string' && p.type !== 'boolean' && !p.enum)) return [];
    const v = values[key];
    const control: FormField['control'] = readonly.includes(key) ? 'readonly' : p.enum ? 'select' : p.type === 'boolean' ? 'checkbox' : key === 'description' ? 'textarea' : 'text';
    return [{ key, label: labelOf(key), description: p.description ?? '', control, ...(p.enum ? { options: [...p.enum] } : {}), required: required.includes(key), value: v === undefined ? '' : String(v) }];
  });
}

const SCHEMA = OPERATION_SCHEMA as unknown as { required: string[]; properties: Record<string, Prop & { items?: { required: string[]; properties: Record<string, Prop> }; additionalProperties?: { properties: Record<string, Prop> } }> };

function teamFile(workspaceRoot: string, id: string): string {
  return layoutPath(workspaceRoot, 'platformOperations', `${id}.yaml`);
}

/** The form for an operation: the team's file if there is one, else the shipped operation it would copy. */
export function operationForm(scope: { resourcesRoot: string; workspaceRoot: string }, id: string): OperationForm {
  const catalog = loadCatalog(scope);
  const all = catalog.operations.filter((o) => o.item.id === id);
  const team = all.find((o) => o.origin === 'team');
  const loaded = team ?? all.find((o) => o.origin === 'shipped');
  if (!loaded) throw new Error(`No operation ${id}.`);
  const op = loaded.item;
  const item = SCHEMA.properties.params.items!;
  const implProps = SCHEMA.properties.platforms.additionalProperties!.properties;
  return {
    id, file: path.relative(scope.workspaceRoot, teamFile(scope.workspaceRoot, id)).split(path.sep).join('/'), origin: loaded.origin, status: loaded.status,
    fields: fieldsOf(SCHEMA.properties, SCHEMA.required, op as unknown as Record<string, unknown>, ['id']),
    params: {
      columns: fieldsOf(item.properties, item.required, {}),
      rows: op.params.map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v !== 'object').map(([k, v]) => [k, String(v)])))
    },
    platforms: Object.entries(op.platforms).map(([platform, impl]) => ({
      platform, transport: impl.sql ? 'sql' as const : impl.cli ? 'cli' as const : 'other' as const,
      label: `${platformById(catalog, platform)?.title ?? platform}${impl.since ? ` (since ${impl.since})` : ''}`,
      description: impl.sql ? implProps.sql.description ?? '' : impl.cli ? `${implProps.cli.description ?? ''} One argument per line.` : 'Edit this implementation in the file.',
      value: impl.sql ? impl.sql.trim() : impl.cli ? impl.cli.join('\n') : JSON.stringify(impl.http ?? impl.file)
    })),
    next: loaded.origin === 'shipped' ? 'Saving makes a team copy, a draft until a person approves it.' : loaded.status === 'approved' ? 'Saving a change makes it a draft again, until a person approves it.' : `Propose it for approval: autode platform propose ${loaded.file}.`
  };
}

export interface OperationEdit {
  fields: Record<string, string>;
  params: Array<Record<string, string>>;
  platforms: Record<string, string>;
}

function applyEdit(op: PlatformOperation, edit: OperationEdit): PlatformOperation {
  const next = JSON.parse(JSON.stringify(op)) as PlatformOperation & Record<string, unknown>;
  for (const f of fieldsOf(SCHEMA.properties, SCHEMA.required, {}, ['id'])) {
    if (f.control === 'readonly' || !(f.key in edit.fields)) continue;
    const v = edit.fields[f.key].trim();
    if (v) next[f.key] = f.control === 'checkbox' ? v === 'true' : v; else delete next[f.key];
  }
  next.params = edit.params.map((row, i) => {
    const before = (op.params[i] ?? {}) as unknown as Record<string, unknown>;
    const p: Record<string, unknown> = { ...before };
    for (const [k, v] of Object.entries(row)) {
      const t = v.trim();
      // A yes/no field keeps an explicit false (required: false is not the default).
      if (k === 'required') { if (t === 'true') p[k] = true; else if (k in before) p[k] = false; }
      else if (t) p[k] = t; else delete p[k];
    }
    return p as unknown as PlatformOperation['params'][number];
  });
  for (const [pid, text] of Object.entries(edit.platforms)) {
    const impl = next.platforms[pid];
    if (!impl) continue;
    if (impl.sql !== undefined) impl.sql = text.trim();
    else if (impl.cli) impl.cli = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  }
  return next;
}

/** What is wrong with the edited operation, as the loader would refuse it; empty: it would load. */
export function checkOperationEdit(scope: { resourcesRoot: string; workspaceRoot: string }, id: string, edit: OperationEdit): string[] {
  const catalog = loadCatalog(scope);
  const loaded = catalog.operations.find((o) => o.item.id === id && o.origin === 'team') ?? catalog.operations.find((o) => o.item.id === id);
  if (!loaded) return [`No operation ${id}.`];
  const effective = new Map(catalog.platforms.filter((p) => p.status === 'approved').map((p) => [p.item.id, p.item] as const));
  return checkOperation(applyEdit(loaded.item, edit), effective);
}

/**
 * Saves the edit to the team's file when it passes the checks (a shipped operation is copied first). The file is a
 * draft: it runs only once a person approves its exact content.
 */
export function saveOperationEdit(scope: { resourcesRoot: string; workspaceRoot: string }, id: string, edit: OperationEdit): { saved: boolean; file: string; problems: string[] } {
  const problems = checkOperationEdit(scope, id, edit);
  const target = teamFile(scope.workspaceRoot, id);
  const file = path.relative(scope.workspaceRoot, target).split(path.sep).join('/');
  if (problems.length) return { saved: false, file, problems };
  if (!fs.existsSync(target)) customise(scope, id);
  const current = parseYaml(fs.readFileSync(target, 'utf8')) as PlatformOperation;
  const next = applyEdit(current, edit);
  fs.writeFileSync(target, `# Team copy of ${id}, edited in the Platform catalog. A draft until a person approves it (autode platform propose ${file}).\n${stringifyYaml(next)}`);
  return { saved: true, file, problems: [] };
}
