import * as fs from 'node:fs';
import * as path from 'node:path';
import { EntityMapping, ModelingApproach, NamingConvention } from '../types';
import { Assertion } from '../context/assertions';
import { BaseNode } from '../context/types';
import { SchemaIndex } from '../grounding/sqlGrounding';
import { parseYaml } from '../context/Yaml';
import { parseMappingContext, readProblemDocument } from '../documents/problemDocuments';

/**
 * The data model (PA3b, v0.45.3): drafted deterministically from what AutoDE
 * knows — the mapping's target entities and columns, the source columns'
 * types, key, grain and relationship facts, the target context's modelling
 * approach and naming — then refined by the data modeler agent, checked, and
 * rendered as DDL by the engine (the agent never writes DDL by hand). Every
 * grain, key and foreign key says where it came from; what isn't known is a
 * gap, never a guess.
 */

export type EntityKind = 'fact' | 'dimension' | 'bridge' | 'hub' | 'link' | 'satellite' | 'table';
export const ENTITY_KINDS: readonly EntityKind[] = ['fact', 'dimension', 'bridge', 'hub', 'link', 'satellite', 'table'];

export interface ModelColumn { name: string; type?: string; nullable?: boolean; source?: string; transform?: string; description?: string }
export interface ForeignKey { columns: string[]; references: string; referencedColumns?: string[]; from?: string }
export interface ModelEntity {
  name: string;
  kind: EntityKind;
  description?: string;
  grain?: string[];
  primaryKey?: string[];
  naturalKey?: string[];
  /** Slowly changing dimension type, for dimensions. */
  scd?: 1 | 2;
  columns: ModelColumn[];
  foreignKeys: ForeignKey[];
  sources: string[];
  /** Where the grain and keys came from (fact ids and trust, or "the mapping"). */
  provenance?: string[];
}
export interface DataModel { approach: ModelingApproach; naming: NamingConvention; database?: string; schema?: string; entities: ModelEntity[] }

export interface ModelInputs {
  mappings: EntityMapping[];
  schemaIndex: SchemaIndex;
  assertions: readonly Assertion[];
  nodes: readonly BaseNode[];
  approach?: ModelingApproach;
  naming?: NamingConvention;
  database?: string;
  schema?: string;
}

const LIVE = new Set(['active', 'proposed', 'needs_review']);

function kindOf(name: string): EntityKind {
  const n = name.toLowerCase().split('.').pop() ?? '';
  if (/^(fct|fact)_/.test(n)) return 'fact';
  if (/^dim_/.test(n)) return 'dimension';
  if (/^(brg|bridge)_/.test(n)) return 'bridge';
  if (/^hub_/.test(n)) return 'hub';
  if (/^(lnk|link)_/.test(n)) return 'link';
  if (/^sat_/.test(n)) return 'satellite';
  return 'table';
}

/** What an assertion's subject names, as a lower-cased fully qualified table name. */
function tableRef(ref: string, nodes: readonly BaseNode[]): string {
  const n = nodes.find((x) => x.id === ref) as (BaseNode & { fqn?: string }) | undefined;
  return String(n?.fqn || n?.label || ref).replace(/^obj:/, '').toLowerCase();
}

const sameTable = (a: string, b: string) => a === b || a.split('.').pop() === b.split('.').pop() && (!a.includes('.') || !b.includes('.'));

/** The target context's approach, naming and location, when the problem has one. */
export function targetSettings(problemRoot: string): { approach?: ModelingApproach; naming?: NamingConvention; database?: string; schema?: string } {
  try {
    const t = parseYaml(fs.readFileSync(path.join(problemRoot, 'context', 'target-context.yaml'), 'utf8')) as { modelingApproach?: ModelingApproach; namingConvention?: NamingConvention; platformConfig?: Record<string, string> };
    return { approach: t.modelingApproach, naming: t.namingConvention, database: t.platformConfig?.database, schema: t.platformConfig?.schema };
  } catch { return {}; }
}

export function problemMappings(problemRoot: string): EntityMapping[] {
  const text = readProblemDocument(problemRoot, 'mappingContext');
  return text ? parseMappingContext(text).mappings : [];
}

export function draftModel(input: ModelInputs): { model: DataModel; gaps: string[] } {
  const approach = input.approach ?? 'dimensional';
  const naming = input.naming ?? 'snake_case';
  const facts = input.assertions.filter((a) => LIVE.has(a.status));
  const gaps: string[] = [];
  const byTarget = new Map<string, EntityMapping[]>();
  for (const m of input.mappings) {
    const k = m.targetName.toLowerCase();
    byTarget.set(k, [...(byTarget.get(k) ?? []), m]);
  }
  // source table → target entity, source column → target column (per source table).
  const srcToTarget = new Map<string, { entity: string; cols: Map<string, string> }[]>();
  const typeOf = (fqn: string, col: string) => input.schemaIndex.tables.find((t) => t.fqn.toLowerCase() === fqn.toLowerCase())?.columns.get(col.toLowerCase());
  const entities: ModelEntity[] = [];
  for (const [, maps] of byTarget) {
    const name = maps[0].targetName;
    const existing = input.schemaIndex.tables.find((t) => t.fqn.toLowerCase() === name.toLowerCase() || t.name === name.toLowerCase().split('.').pop());
    const columns: ModelColumn[] = [];
    const sources: string[] = [];
    for (const m of maps) {
      const src = (m.sourceFqn || m.sourceEntityId);
      sources.push(src);
      const cols = new Map<string, string>();
      for (const c of m.columns) {
        cols.set(c.sourceColumn.toLowerCase(), c.targetColumn);
        if (columns.some((x) => x.name.toLowerCase() === c.targetColumn.toLowerCase())) continue;
        columns.push({ name: c.targetColumn, type: existing?.columns.get(c.targetColumn.toLowerCase()) || typeOf(src, c.sourceColumn), source: `${src}.${c.sourceColumn}`, transform: c.transformExpression });
      }
      const list = srcToTarget.get(src.toLowerCase()) ?? [];
      list.push({ entity: name, cols });
      srcToTarget.set(src.toLowerCase(), list);
    }
    const e: ModelEntity = { name, kind: kindOf(name), columns, foreignKeys: [], sources: [...new Set(sources)], provenance: [] };
    // Grain and keys: facts about the target entity; else the single source's, through the mapping.
    const about = (kind: string, table: string) => facts.filter((a) => a.kind === kind && a.subject.some((s) => sameTable(tableRef(s, input.nodes), table)));
    const fromFacts = (kind: 'grain' | 'key'): { cols: string[]; why: string } | undefined => {
      const own = about(kind, name.toLowerCase())[0];
      if (own && Array.isArray(own.value)) return { cols: own.value as string[], why: `${kind} from fact ${own.id} (${own.trust}${own.status === 'active' ? '' : `, ${own.status}`})` };
      if (maps.length === 1) {
        const src = (maps[0].sourceFqn || maps[0].sourceEntityId).toLowerCase();
        const f = about(kind, src)[0];
        const cols = srcToTarget.get(src)?.find((x) => x.entity === name)?.cols;
        if (f && Array.isArray(f.value) && cols) {
          const mapped = (f.value as string[]).map((c) => cols.get(c.toLowerCase()));
          if (mapped.every(Boolean)) return { cols: mapped as string[], why: `${kind} of ${src} (fact ${f.id}, ${f.trust}) through the mapping` };
          gaps.push(`${name}: the ${kind} of ${src} (${(f.value as string[]).join(', ')}) isn't fully mapped.`);
        }
      }
      return undefined;
    };
    const grain = fromFacts('grain');
    if (grain) { e.grain = grain.cols; e.provenance!.push(grain.why); } else gaps.push(`${name}: no grain is known (one row per what?).`);
    const key = fromFacts('key');
    if (key) {
      if (e.kind === 'dimension' && approach === 'dimensional') {
        const sk = `${name.toLowerCase().split('.').pop()!.replace(/^dim_/, '')}_key`;
        if (!e.columns.some((c) => c.name.toLowerCase() === sk)) e.columns.unshift({ name: sk, type: 'INTEGER', nullable: false, description: 'Surrogate key' });
        e.primaryKey = [sk]; e.naturalKey = key.cols;
        e.provenance!.push(`surrogate key ${sk}; natural ${key.why}`);
      } else { e.primaryKey = key.cols; e.provenance!.push(`primary ${key.why}`); }
    } else gaps.push(`${name}: no key is known.`);
    if (e.kind === 'dimension' && approach === 'dimensional') gaps.push(`${name}: SCD type not decided (1 overwrites, 2 keeps history).`);
    for (const c of e.columns) if (!c.type) gaps.push(`${name}.${c.name}: type unknown.`);
    entities.push(e);
  }
  // Foreign keys from relationship facts between sources mapped to different target entities.
  for (const r of facts.filter((a) => a.kind === 'relationship')) {
    const v = r.value as { from?: { entity: string; columns: string[] }; to?: { entity: string; columns: string[] } } | undefined;
    if (!v?.from || !v.to) continue;
    const f = srcToTarget.get(tableRef(v.from.entity, input.nodes)) ?? [];
    const t = srcToTarget.get(tableRef(v.to.entity, input.nodes)) ?? [];
    for (const fe of f) for (const te of t) {
      if (fe.entity === te.entity) continue;
      const cols = v.from.columns.map((c) => fe.cols.get(c.toLowerCase()));
      const refCols = v.to.columns.map((c) => te.cols.get(c.toLowerCase()));
      const ent = entities.find((x) => x.name === fe.entity)!;
      if (cols.every(Boolean) && refCols.every(Boolean)) ent.foreignKeys.push({ columns: cols as string[], references: te.entity, referencedColumns: refCols as string[], from: `fact ${r.id} (${r.trust})` });
      else gaps.push(`${fe.entity} → ${te.entity}: the relationship (fact ${r.id}) isn't fully mapped.`);
    }
  }
  for (const e of entities) if (e.kind === 'fact' && !e.foreignKeys.length) gaps.push(`${e.name}: a fact with no foreign keys to dimensions.`);
  if (!entities.length) gaps.push('The mapping has no target entities yet: draft the mapping first.');
  return { model: { approach, naming, database: input.database, schema: input.schema, entities }, gaps };
}

const NAMING_RE: Record<NamingConvention, RegExp> = { snake_case: /^[a-z][a-z0-9_]*$/, camelCase: /^[a-z][a-zA-Z0-9]*$/, PascalCase: /^[A-Z][a-zA-Z0-9]*$/ };

/** Errors (it can't be approved) and warnings (a reviewer should look). */
export function checkModel(model: DataModel, ctx: { mappings?: EntityMapping[] } = {}): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  if (!model || !Array.isArray(model.entities)) return { ok: false, errors: ['model.entities must be a list.'], warnings };
  const names = new Map<string, ModelEntity>();
  for (const e of model.entities) {
    const n = String(e.name ?? '').toLowerCase();
    if (!n) { errors.push('every entity needs a name.'); continue; }
    if (names.has(n)) errors.push(`entity ${e.name} is defined twice.`);
    names.set(n, e);
  }
  const re = NAMING_RE[model.naming] ?? NAMING_RE.snake_case;
  for (const e of model.entities) {
    if (!ENTITY_KINDS.includes(e.kind)) errors.push(`${e.name}: kind is one of ${ENTITY_KINDS.join(', ')}.`);
    const cols = new Set<string>();
    for (const c of e.columns ?? []) {
      const k = String(c.name ?? '').toLowerCase();
      if (!k) { errors.push(`${e.name}: a column without a name.`); continue; }
      if (cols.has(k)) errors.push(`${e.name}.${c.name} is defined twice.`);
      cols.add(k);
      if (!c.type) warnings.push(`${e.name}.${c.name}: no type (STRING is assumed in the DDL).`);
      if (!re.test(c.name)) warnings.push(`${e.name}.${c.name} doesn't follow ${model.naming}.`);
    }
    if (!re.test(String(e.name).split('.').pop() ?? '')) warnings.push(`${e.name} doesn't follow ${model.naming}.`);
    const need = (list: string[] | undefined, what: string) => { for (const c of list ?? []) if (!cols.has(c.toLowerCase())) errors.push(`${e.name}: ${what} column ${c} is not a column of the entity.`); };
    if (!e.grain?.length) errors.push(`${e.name}: the grain is required (one row per what?).`);
    need(e.grain, 'grain');
    if (!e.primaryKey?.length) errors.push(`${e.name}: a primary key is required.`);
    need(e.primaryKey, 'primary key');
    need(e.naturalKey, 'natural key');
    if (e.kind === 'dimension' && model.approach === 'dimensional' && !e.scd) warnings.push(`${e.name}: SCD type not set.`);
    for (const fk of e.foreignKeys ?? []) {
      need(fk.columns, 'foreign key');
      const ref = names.get(String(fk.references).toLowerCase());
      if (!ref) { errors.push(`${e.name}: foreign key to ${fk.references}, which is not in the model.`); continue; }
      const refCols = fk.referencedColumns?.length ? fk.referencedColumns : ref.primaryKey ?? [];
      if (refCols.length !== fk.columns.length) errors.push(`${e.name}: foreign key (${fk.columns.join(', ')}) → ${fk.references} has ${fk.columns.length} column(s), its key ${refCols.length}.`);
      const rc = new Set((ref.columns ?? []).map((c) => c.name.toLowerCase()));
      for (const c of refCols) if (!rc.has(c.toLowerCase())) errors.push(`${e.name}: foreign key → ${fk.references}.${c}, which is not a column.`);
    }
    if (e.kind === 'fact' && !(e.foreignKeys ?? []).length) warnings.push(`${e.name}: a fact with no foreign keys.`);
  }
  // Every mapped target column is in the model.
  for (const m of ctx.mappings ?? []) {
    const e = names.get(m.targetName.toLowerCase());
    if (!e) { errors.push(`the mapping's target ${m.targetName} is not in the model.`); continue; }
    const cols = new Set((e.columns ?? []).map((c) => c.name.toLowerCase()));
    for (const c of m.columns) if (!cols.has(c.targetColumn.toLowerCase())) errors.push(`${m.targetName}.${c.targetColumn} is mapped but not in the model.`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** CREATE TABLE statements for the model, in dependency order (referenced entities first). */
export function renderModelDdl(model: DataModel): string {
  const q = (n: string) => [model.database, model.schema].filter(Boolean).concat(n.includes('.') ? [n.split('.').pop()!] : [n]).join('.');
  const done = new Set<string>(); const order: ModelEntity[] = [];
  const visit = (e: ModelEntity, seen = new Set<string>()) => {
    const k = e.name.toLowerCase();
    if (done.has(k) || seen.has(k)) return;
    seen.add(k);
    for (const fk of e.foreignKeys ?? []) { const r = model.entities.find((x) => x.name.toLowerCase() === fk.references.toLowerCase()); if (r) visit(r, seen); }
    done.add(k); order.push(e);
  };
  for (const e of model.entities) visit(e);
  return order.map((e) => {
    const lines = e.columns.map((c) => `  ${c.name} ${c.type || 'STRING'}${c.nullable === false || e.primaryKey?.some((p) => p.toLowerCase() === c.name.toLowerCase()) ? ' NOT NULL' : ''}`);
    if (e.primaryKey?.length) lines.push(`  CONSTRAINT pk_${e.name.split('.').pop()} PRIMARY KEY (${e.primaryKey.join(', ')})`);
    for (const fk of e.foreignKeys ?? []) {
      const r = model.entities.find((x) => x.name.toLowerCase() === fk.references.toLowerCase());
      lines.push(`  FOREIGN KEY (${fk.columns.join(', ')}) REFERENCES ${q(fk.references)} (${(fk.referencedColumns?.length ? fk.referencedColumns : r?.primaryKey ?? []).join(', ')})`);
    }
    const head = [`-- ${e.kind}: ${e.name}${e.grain?.length ? ` — one row per ${e.grain.join(', ')}` : ''}${e.scd ? ` (SCD${e.scd})` : ''}`, ...(e.description ? [`-- ${e.description}`] : [])];
    return `${head.join('\n')}\nCREATE TABLE ${q(e.name)} (\n${lines.join(',\n')}\n);`;
  }).join('\n\n') + '\n';
}
