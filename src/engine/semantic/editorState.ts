import * as path from 'node:path';
import { Assertion } from '../context/assertions';
import { GraphView } from '../context/retrieval';
import { problemMode } from '../documents/problemMode';
import { ELEMENT_LISTS, ElementList, SemanticModel, SemanticNamedExpr, parseSemanticModel, serializeSemanticModel } from './model';
import { Composite, isCompositeText, parseComposite, resolveComposite } from './composite';
import { SemanticFinding, checkSemanticModel } from './checks';
import { CompositeEntry, SharedEntry, readComposite, readShared, semanticPaths, sharedLoader } from './store';
import { layoutPath } from '../workspaceLayout';

/**
 * What the Semantic Model editor shows and does (C5a;
 * docs/context-layer-requirements.md §6.7), without VS Code: the state of a
 * file (a shared model, a composite or a resolved model), and the edits its
 * form makes to the YAML. The file stays the source of truth; every edit is a
 * new text, applied as an ordinary (undoable) document edit.
 */

export type SemanticFileKind = 'shared' | 'composite' | 'resolved' | 'other';

export interface EditorContext { workspaceRoot: string; graph: GraphView; assertions: readonly Assertion[] }

export interface EditorState {
  kind: SemanticFileKind;
  name: string;
  problemId?: string;
  model?: SemanticModel;
  composite?: Composite;
  /** A composite's resolution as it would be now (not written). */
  preview?: SemanticModel;
  errors: string[];
  warnings: string[];
  findings: SemanticFinding[];
  shared?: Pick<SharedEntry, 'status' | 'revision' | 'approved' | 'backing'>;
  compositeStatus?: Pick<CompositeEntry, 'status' | 'staleBecause' | 'approved' | 'approvalCurrent'>;
  mode: 'governed' | 'exploration';
}

/** Which kind of semantic file this is, by where it lives. */
export function semanticFileKind(workspaceRoot: string, file: string, text: string): { kind: SemanticFileKind; name: string; problemId?: string } {
  const p = semanticPaths(workspaceRoot);
  const abs = path.resolve(file);
  const base = path.basename(abs).replace(/\.ya?ml$/i, '');
  if (/\.resolved$/i.test(base)) return { kind: 'resolved', name: base.replace(/\.resolved$/i, ''), problemId: path.basename(path.dirname(path.dirname(abs))) };
  if (path.dirname(abs).toLowerCase() === path.resolve(p.sharedDir).toLowerCase()) return { kind: 'shared', name: base };
  if (path.basename(path.dirname(abs)) === 'semantic' && isCompositeText(text)) return { kind: 'composite', name: base, problemId: path.basename(path.dirname(path.dirname(abs))) };
  return { kind: isCompositeText(text) ? 'composite' : 'other', name: base };
}

export function semanticEditorState(file: string, text: string, ctx: EditorContext): EditorState {
  const where = semanticFileKind(ctx.workspaceRoot, file, text);
  const mode = where.problemId ? problemMode(layoutPath(ctx.workspaceRoot, 'problems', where.problemId)) : 'governed';
  const base: EditorState = { ...where, errors: [], warnings: [], findings: [], mode };
  if (where.kind === 'composite') {
    const { composite, errors } = parseComposite(text);
    if (!composite) return { ...base, errors };
    const r = resolveComposite(composite, sharedLoader(ctx.workspaceRoot));
    const entry = where.problemId ? readComposite(ctx.workspaceRoot, where.problemId, where.name) : undefined;
    return {
      ...base, composite, preview: r.model, errors: r.errors,
      findings: r.model ? checkSemanticModel(r.model, ctx) : [],
      compositeStatus: entry ? { status: entry.status, staleBecause: entry.staleBecause, approved: entry.approved, approvalCurrent: entry.approvalCurrent } : undefined
    };
  }
  const parsed = parseSemanticModel(text);
  const shared = where.kind === 'shared' ? readShared(ctx.workspaceRoot, where.name) : undefined;
  return {
    ...base, model: parsed.model, errors: parsed.errors, warnings: parsed.warnings,
    findings: parsed.model ? checkSemanticModel(parsed.model, ctx) : [],
    shared: shared ? { status: shared.status, revision: shared.revision, approved: shared.approved, backing: shared.backing } : undefined
  };
}

export type SemanticEdit =
  | { op: 'set'; table: string; list?: ElementList; name?: string; field: 'description' | 'synonyms' | 'expr'; value: string }
  | { op: 'add'; table: string; list: ElementList; name: string; expr: string; description?: string }
  | { op: 'remove'; table: string; list: ElementList; name: string };

/**
 * Applies a form edit to a shared model's text and returns the new text
 * (re-serialized in the fixed order, so comments other than the model are
 * not kept). Throws on an edit that doesn't fit the model.
 */
export function applySemanticEdit(text: string, edit: SemanticEdit): string {
  const parsed = parseSemanticModel(text);
  const model = parsed.model ?? (() => { throw new Error(`fix the YAML first: ${parsed.errors[0]}`); })();
  const table = model.tables.find((t) => t.name === edit.table);
  if (!table) throw new Error(`no table ${edit.table}`);
  const list = (l: ElementList) => ((table as unknown as Record<string, SemanticNamedExpr[] | undefined>)[l] ??= []);
  if (edit.op === 'add') {
    if (ELEMENT_LISTS.some((l) => (list(l)).some((e) => e.name.toLowerCase() === edit.name.toLowerCase()))) throw new Error(`${edit.table}.${edit.name} exists`);
    list(edit.list).push({ name: edit.name, ...(edit.description ? { description: edit.description } : {}), expr: edit.expr });
  } else if (edit.op === 'remove') {
    (table as unknown as Record<string, SemanticNamedExpr[]>)[edit.list] = list(edit.list).filter((e) => e.name !== edit.name);
  } else {
    const target: { description?: string; synonyms?: string[]; expr?: string } | undefined = edit.name && edit.list ? list(edit.list).find((e) => e.name === edit.name) : table;
    if (!target) throw new Error(`no ${edit.table}.${edit.name ?? ''}`);
    if (edit.field === 'synonyms') { const s = edit.value.split(',').map((x) => x.trim()).filter(Boolean); if (s.length) target.synonyms = s; else delete target.synonyms; }
    else if (edit.field === 'description') { if (edit.value.trim()) target.description = edit.value.trim(); else delete target.description; }
    else { if (!edit.name) throw new Error('a table has no expression'); if (!edit.value.trim()) throw new Error('an expression is required'); target.expr = edit.value.trim(); }
  }
  for (const l of ELEMENT_LISTS) if ((table as unknown as Record<string, unknown[] | undefined>)[l]?.length === 0) delete (table as unknown as Record<string, unknown>)[l];
  return serializeSemanticModel(model);
}

/**
 * Merges a fresh draft into an existing model, adding only: tables, elements
 * and relationships the model doesn't have. Nothing the person wrote is
 * changed. Returns the new text and what was added.
 */
export function mergeDraft(text: string, draft: SemanticModel): { text: string; added: string[] } {
  const parsed = parseSemanticModel(text);
  const raw = parsed.model ?? (text.trim() ? undefined : { name: draft.name, tables: [] } as unknown as SemanticModel);
  if (!raw) throw new Error(`fix the YAML first: ${parsed.errors[0]}`);
  const model: SemanticModel = JSON.parse(JSON.stringify(raw));
  const added: string[] = [];
  for (const t of draft.tables) {
    const mine = model.tables.find((x) => x.name.toLowerCase() === t.name.toLowerCase());
    if (!mine) { model.tables.push(t); added.push(t.name); continue; }
    for (const l of ELEMENT_LISTS) {
      for (const e of (t[l] as SemanticNamedExpr[] | undefined) ?? []) {
        if (ELEMENT_LISTS.some((k) => ((mine[k] as SemanticNamedExpr[] | undefined) ?? []).some((x) => x.name.toLowerCase() === e.name.toLowerCase()))) continue;
        (mine as unknown as Record<string, SemanticNamedExpr[]>)[l] = [...((mine[l] as SemanticNamedExpr[] | undefined) ?? []), e];
        added.push(`${t.name}.${e.name}`);
      }
    }
    if (!mine.primary_key && t.primary_key) { mine.primary_key = t.primary_key; added.push(`${t.name} primary key`); }
  }
  for (const r of draft.relationships ?? []) {
    if ((model.relationships ?? []).some((x) => x.name.toLowerCase() === r.name.toLowerCase())) continue;
    model.relationships = [...(model.relationships ?? []), r];
    added.push(`relationship ${r.name}`);
  }
  return { text: serializeSemanticModel(model), added };
}

/** A new composite's starting text. */
export function newCompositeText(name: string, models: readonly string[]): string {
  return [
    'autode: semantic-composite/1',
    `name: ${name}`,
    'description: ""',
    'uses:',
    ...(models.length ? models.map((m) => `  - model: ${m}`) : ['  - model: <a shared model>']),
    '# add:            # this use case\'s own metrics, filters and verified queries',
    '#   metrics:',
    '#     - { table: orders, name: revenue_per_order, expr: "SUM(amount) / COUNT(order_id)" }',
    '# describe:       # descriptions and synonyms only',
    '#   orders.net_revenue: { synonyms: [net sales] }',
    ''
  ].join('\n');
}
