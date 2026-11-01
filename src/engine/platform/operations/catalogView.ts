import * as fs from 'node:fs';
import * as path from 'node:path';
import { Catalog, loadCatalog } from './load';
import { ConnectionTarget, OperationSummary, runOnConnection, summarize } from './service';
import { Loaded, PlatformCapability, PlatformDefinition, PlatformOperation } from './types';
import { OperationRun, lastRuns, readOperationRuns } from './runLog';
import { ConnectionEntry, loadConnectionsConfig } from '../connectionsConfig';
import { readReadiness } from '../connectionReadiness';
import { CatalogEntry, skillCatalog } from '../../agents/skillCatalog';
import { listPrimitives } from '../../transforms/registry';
import { SqlDialect } from '../../transforms/types';
import { layoutPath } from '../../workspaceLayout';

/**
 * POP4a, the operations and skills catalog (docs/specs/platform-operations.md §6.3): what AutoDE does on each
 * platform and what relies on it, the same for the VS Code tab, the CLI and MCP. Everything comes from the
 * platform definitions, the operations, the connections, the skills and the recorded runs: no screen or rule
 * here knows a platform by name.
 */

export interface CatalogScope { resourcesRoot: string; workspaceRoot?: string; home?: string }

/** The capabilities people ask about first, in this order; any other follows alphabetically. */
const CAPABILITY_ORDER = ['estate', 'profiling', 'lineage', 'governance.assess', 'governance.tags', 'governance.policies', 'performance.assess', 'pipelines.assess', 'deployment', 'semantic.import', 'semantic.export', 'knowledge.import', 'knowledge.export', 'compile.target'];

/**
 * AutoDE features that run operations themselves (the rest are run by agents through skills): by a capability's
 * list in the definition, or by id. Kept beside the callers' ids: `BaseAdapter.ts`, `DefinitionAdapter.ts`, `lineage/record.ts`.
 */
const ENGINE_FEATURES: ReadonlyArray<{ feature: string; capability?: string; operations?: string[] }> = [
  { feature: 'Estate extraction (Browse Source Database, autode estate extract, MCP autode_extract_metadata)', capability: 'estate' },
  { feature: 'Observed lineage (autode lineage refresh, MCP autode_refresh_lineage)', capability: 'lineage' },
  { feature: 'Browsing a platform\'s databases and schemas (Settings → Connections, Browse Source Database)', operations: ['estate.list_databases', 'estate.list_schemas'] },
  { feature: 'Refresh on use (which tables changed since they were read)', operations: ['estate.last_altered'] }
];

/** Areas an operation id starts with: a backticked `area.name` in a skill that isn't in the catalog is an unknown operation. */
const OPERATION_ID = /^(estate|lineage|governance|performance|pipelines|platform|quality|deployment|semantic|knowledge|profiling)\.[a-z][a-z0-9_]*$/;

export type CellStatus = 'ok' | 'partly' | 'failing' | 'not-checked';

export interface ConnectionCell { connection: string; status: CellStatus; detail?: string; checkedAt?: string }

export interface MatrixCell {
  support: PlatformCapability['support'] | 'not_declared';
  operations: string[];
  privileges?: string;
  note?: string;
  /** From the last conformance run on each of the platform's connections. */
  connections: ConnectionCell[];
}

export interface CatalogMatrix {
  capabilities: string[];
  platforms: Array<{ id: string; title: string; category: string; connected: boolean; connections: string[]; origin: string; status: string }>;
  /** capability → platform → cell. */
  cells: Record<string, Record<string, MatrixCell>>;
  errors: string[];
}

// ── Conformance runs ────────────────────────────────────────────────────────

export interface ConformanceResult {
  connection: string;
  platform: string;
  at: string;
  capabilities: Record<string, { status: CellStatus; detail?: string; operations: Array<{ id: string; ok: boolean; skipped?: string; error?: string }> }>;
  /** "supports 9 of 11 capabilities; lineage needs a privilege". */
  summary: string;
}

function conformanceFile(workspaceRoot: string): string {
  return path.join(path.dirname(layoutPath(workspaceRoot, 'connectionReadiness')), 'conformance.json');
}

export function readConformance(workspaceRoot: string | undefined): Record<string, ConformanceResult> {
  if (!workspaceRoot) return {};
  try { return JSON.parse(fs.readFileSync(conformanceFile(workspaceRoot), 'utf8')) as Record<string, ConformanceResult>; } catch { return {}; }
}

function writeConformance(workspaceRoot: string, r: ConformanceResult): void {
  const all = readConformance(workspaceRoot);
  all[r.connection] = r;
  const file = conformanceFile(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
}

/** Parameter values a conformance run can give an operation, from the connection's own fields. */
function conformanceParams(op: PlatformOperation, fields: Readonly<Record<string, string>>): { params?: Record<string, unknown>; missing?: string } {
  const database = fields.database ?? fields.catalog;
  const schema = fields.schema;
  const params: Record<string, unknown> = {};
  for (const p of op.params) {
    if (p.default !== undefined || p.required === false) continue;
    const one = p.name === 'database' || p.name === 'catalog' ? database : p.name === 'schema' ? schema : undefined;
    const many = p.name === 'databases' || p.name === 'catalogs' ? database : p.name === 'schemas' ? schema : undefined;
    if (one) params[p.name] = one;
    else if (many) params[p.name] = [many];
    else return { missing: p.name };
  }
  return { params };
}

/**
 * Tries each capability's read operations on a connection, a row at most each, with parameters from the
 * connection's own fields: supported where they run, *partly* (with the privileges it needs) where some fail,
 * not checked where an operation needs a value the connection doesn't hold. Recorded for the matrix.
 */
export async function conformanceRun(scope: CatalogScope, target: ConnectionTarget, fields: Readonly<Record<string, string>>, now = () => new Date()): Promise<ConformanceResult> {
  const catalog = loadCatalog(scope);
  const def = catalog.platforms.find((p) => p.item.id === target.platform && p.status === 'approved')?.item;
  if (!def) throw new Error(`No approved platform definition for ${target.platform}.`);
  const out: ConformanceResult['capabilities'] = {};
  for (const [cap, c] of Object.entries(def.capabilities)) {
    if (c.support === 'not_applicable') continue;
    const ops = (c.operations ?? []).map((id) => catalog.operations.find((o) => o.item.id === id && o.status === 'approved')?.item).filter((o): o is PlatformOperation => !!o && o.kind === 'read' && !!o.platforms[target.platform]);
    if (!ops.length) { out[cap] = { status: 'not-checked', detail: c.operations?.length ? 'its operations change the platform, or aren\'t for this platform: not tried' : 'served by AutoDE\'s own code: not tried here', operations: [] }; continue; }
    const results: ConformanceResult['capabilities'][string]['operations'] = [];
    for (const op of ops) {
      const { params, missing } = conformanceParams(op, fields);
      if (!params) { results.push({ id: op.id, ok: false, skipped: `needs ${missing}` }); continue; }
      try {
        const r = await runOnConnection({ ...scope, catalog }, target, op.id, params, { maxRows: 1, via: 'conformance' });
        results.push(r.gap ? { id: op.id, ok: false, error: r.gap } : { id: op.id, ok: true });
      } catch (err) { results.push({ id: op.id, ok: false, error: err instanceof Error ? err.message : String(err) }); }
    }
    const ran = results.filter((r) => !r.skipped);
    const ok = ran.filter((r) => r.ok).length;
    const status: CellStatus = !ran.length ? 'not-checked' : ok === ran.length ? 'ok' : ok ? 'partly' : 'failing';
    const failed = ran.filter((r) => !r.ok);
    out[cap] = { status, ...(failed.length ? { detail: `${failed.map((f) => `${f.id}: ${f.error}`).join('; ')}${c.privileges ? `. It needs: ${c.privileges}` : ''}` } : !ran.length ? { detail: `not tried: ${results.map((r) => `${r.id} ${r.skipped}`).join('; ')}` } : {}), operations: results };
  }
  const checked = Object.entries(out).filter(([, v]) => v.status !== 'not-checked');
  const supported = checked.filter(([, v]) => v.status === 'ok').length;
  const short = checked.filter(([, v]) => v.status !== 'ok').map(([k, v]) => `${k} ${v.status === 'partly' ? 'partly works' : 'fails'}${def.capabilities[k]?.privileges ? ' (it may need a privilege)' : ''}`);
  const result: ConformanceResult = {
    connection: target.connectionId, platform: target.platform, at: now().toISOString(), capabilities: out,
    summary: `This connection supports ${supported} of ${checked.length} checked capabilities${short.length ? `; ${short.join('; ')}` : ''}${checked.length < Object.keys(out).length ? `; ${Object.keys(out).length - checked.length} not checked` : ''}.`
  };
  if (scope.workspaceRoot) writeConformance(scope.workspaceRoot, result);
  return result;
}

// ── The matrix ──────────────────────────────────────────────────────────────

function orderCapabilities(caps: Iterable<string>): string[] {
  const all = [...new Set(caps)];
  const known = CAPABILITY_ORDER.filter((c) => all.includes(c));
  return [...known, ...all.filter((c) => !known.includes(c)).sort()];
}

function connectionsOf(scope: CatalogScope): ConnectionEntry[] {
  if (!scope.workspaceRoot) return [];
  try { return loadConnectionsConfig(scope.workspaceRoot).connections; } catch { return []; }
}

const CATEGORY_ORDER = ['warehouse', 'lakehouse', 'semantic', 'catalog', 'orchestration', 'bi'];

/** Capabilities are rows; the platforms are columns, the workspace's (with connections) first, by category. */
export function capabilityMatrix(scope: CatalogScope, catalog: Catalog = loadCatalog(scope)): CatalogMatrix {
  const conns = connectionsOf(scope);
  const conformance = readConformance(scope.workspaceRoot);
  const defs = catalog.platforms.filter((p) => p.status === 'approved');
  const platforms = defs.map((p) => {
    const mine = conns.filter((c) => c.platform === p.item.id).map((c) => c.id);
    return { id: p.item.id, title: p.item.title, category: p.item.category, connected: mine.length > 0, connections: mine, origin: p.origin, status: p.status };
  }).sort((a, b) => Number(b.connected) - Number(a.connected) || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.title.localeCompare(b.title));
  const capabilities = orderCapabilities(defs.flatMap((p) => Object.keys(p.item.capabilities)));
  const cells: CatalogMatrix['cells'] = {};
  for (const cap of capabilities) {
    cells[cap] = {};
    for (const p of platforms) {
      const c = defs.find((d) => d.item.id === p.id)!.item.capabilities[cap];
      cells[cap][p.id] = {
        support: c?.support ?? 'not_declared', operations: c?.operations ?? [], ...(c?.privileges ? { privileges: c.privileges } : {}), ...(c?.note ? { note: c.note } : {}),
        connections: p.connections.map((id) => { const r = conformance[id]?.capabilities[cap]; return r ? { connection: id, status: r.status, ...(r.detail ? { detail: r.detail } : {}), checkedAt: conformance[id].at } : { connection: id, status: 'not-checked' as const, detail: 'no conformance run yet' }; })
      };
    }
  }
  return { capabilities, platforms, cells, errors: catalog.errors };
}

// ── What relies on what ─────────────────────────────────────────────────────

export interface SkillText { id: string; group: string; text: string; stageKinds: string[]; platforms: string[]; file?: string }

/** The skills whose text AutoDE can read: its own and the workspace's imported ones. Vendor skills are references only. */
export function skillTexts(scope: CatalogScope): { texts: SkillText[]; entries: CatalogEntry[] } {
  let entries: CatalogEntry[] = [];
  try { entries = skillCatalog({ resourcesRoot: scope.resourcesRoot, workspaceRoot: scope.workspaceRoot ?? scope.resourcesRoot, home: scope.home ?? '' }).entries; } catch { /* no skills */ }
  const texts: SkillText[] = [];
  for (const e of entries) {
    const dirs = e.group === 'autode' ? [path.join(scope.resourcesRoot, 'skills', e.name)] : e.group === 'workspace' && scope.workspaceRoot ? [path.join(layoutPath(scope.workspaceRoot, 'toolSkills'), e.name)] : [];
    for (const d of dirs) {
      const file = path.join(d, 'SKILL.md');
      try { texts.push({ id: e.name, group: e.group, text: fs.readFileSync(file, 'utf8'), stageKinds: e.stageKinds, platforms: e.platforms, file }); } catch { /* not readable */ }
    }
  }
  return { texts, entries };
}

/**
 * A query of the platform's own metadata or history (system views, SHOW, DESCRIBE): reading the platform is an
 * operation's job. Deliverable code a skill teaches (DDL, the grants a runbook applies) is the skill's own and isn't flagged.
 */
const PLATFORM_QUERY = /\b(information_schema|account_usage|pg_catalog|(svv|stv|stl|sys)_[a-z_]+|system\.(query|access|information_schema|billing|compute|lakeflow)\b|show\s+(tables|grants|schemas|databases|columns|views|warehouses)|describe\s|desc\s+table)/i;

/** The operations a skill's text names (each with the section that does), the unknown ids it names, and platform queries it carries itself. */
export function skillOperations(text: string, catalog: Catalog): { uses: Array<{ id: string; section: string }>; unknown: string[]; sql: string[] } {
  const known = new Set(catalog.operations.map((o) => o.item.id));
  const uses = new Map<string, string>();
  const unknown = new Set<string>();
  let section = '(top)';
  let inSql = false;
  const sql: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.+)$/.exec(line);
    if (h && !inSql) section = h[1].trim();
    if (/^```\s*sql\b/i.test(line.trim())) { inSql = true; continue; }
    if (inSql) {
      if (line.trim().startsWith('```')) inSql = false;
      else if (PLATFORM_QUERY.test(line)) sql.push(`"${line.trim().slice(0, 80)}" under "${section}"`);
      continue;
    }
    if (/^\s*(SELECT|SHOW|DESCRIBE)\b/i.test(line) && PLATFORM_QUERY.test(line)) sql.push(`"${line.trim().slice(0, 80)}" under "${section}"`);
    for (const m of line.matchAll(/`([a-z][a-z0-9_.]*)`/g)) {
      const id = m[1];
      if (known.has(id)) { if (!uses.has(id)) uses.set(id, section); }
      // Shaped like an operation id (estate.list_tables: an area, then a verb_noun); a dotted field name (governance.columns) isn't.
      else if (OPERATION_ID.test(id) && id.includes('_')) unknown.add(id);
    }
    for (const id of known) if (!uses.has(id) && new RegExp(`(^|[^\\w.])${id.replace(/\./g, '\\.')}([^\\w.]|$)`).test(line)) uses.set(id, section);
  }
  return { uses: [...uses].map(([id, s]) => ({ id, section: s })), unknown: [...unknown].sort(), sql };
}

export interface OperationPage extends OperationSummary {
  implementations: Array<{ platform: string; transport: string; statement?: string; argv?: string[]; since?: string; until?: string }>;
  example?: PlatformOperation['example'];
  approvedBy?: string;
  lastRuns: OperationRun[];
  reliedOnBy: { capabilities: string[]; engine: string[]; skills: Array<{ id: string; section: string }>; stages: string[] };
  /** Nothing relies on it: no capability, engine feature or skill names it. */
  unused: boolean;
}

/** An operation's page: what it does on each platform, its example and last runs, and what relies on it. */
export function operationPage(scope: CatalogScope, id: string, catalog: Catalog = loadCatalog(scope)): OperationPage | undefined {
  const all = catalog.operations.filter((o) => o.item.id === id);
  const loaded: Loaded<PlatformOperation> | undefined = all.find((o) => o.status === 'approved') ?? all[0];
  if (!loaded) return undefined;
  const summary = summarize({ ...catalog, operations: [loaded] })[0];
  const op = loaded.item;
  const defs = catalog.platforms.filter((p) => p.status === 'approved').map((p) => p.item);
  const engine = [
    ...ENGINE_FEATURES.filter((f) => f.operations?.includes(id) || (f.capability && defs.some((d) => (d.capabilities[f.capability!]?.operations ?? []).includes(id)))).map((f) => f.feature),
    ...(defs.some((d) => d.versionOperation === id) ? ['Platform version (read before each run, to pick the implementation)'] : [])
  ];
  const { texts } = skillTexts(scope);
  const skills = texts.flatMap((t) => { const u = skillOperations(t.text, catalog).uses.find((x) => x.id === id); return u ? [{ id: t.id, section: u.section }] : []; });
  const stages = [...new Set(texts.filter((t) => skills.some((s) => s.id === t.id)).flatMap((t) => t.stageKinds))].sort();
  const runs = readOperationRuns(scope.workspaceRoot).filter((r) => r.operation === id);
  return {
    ...summary,
    implementations: Object.entries(op.platforms).map(([platform, impl]) => ({ platform, transport: impl.sql ? 'sql' : impl.cli ? 'cli' : impl.http ? 'http' : 'file', ...(impl.sql ? { statement: impl.sql.trim() } : {}), ...(impl.cli ? { argv: impl.cli } : {}), ...(impl.since ? { since: impl.since } : {}), ...(impl.until ? { until: impl.until } : {}) })),
    ...(op.example ? { example: op.example } : {}), ...(loaded.approvedBy ? { approvedBy: loaded.approvedBy } : {}),
    lastRuns: [...lastRuns(runs).values()],
    reliedOnBy: { capabilities: summary.usedBy, engine, skills, stages },
    unused: !summary.usedBy.length && !engine.length && !skills.length
  };
}

export interface SkillPage {
  id: string;
  group: string;
  summary: string;
  stageKinds: string[];
  platforms: string[];
  version?: number | string;
  maturity?: string;
  status?: string;
  file?: string;
  operations: Array<{ id: string; section: string; state: 'ok' | 'draft' | 'failing' }>;
  /** `skills lint`: operation ids it names that don't exist, and SQL it carries itself. */
  lint: { unknown: string[]; sql: string[] };
}

/** A skill's page: its operations (with their state), and what `skills lint` flags. */
export function skillPage(scope: CatalogScope, id: string, catalog: Catalog = loadCatalog(scope)): SkillPage | undefined {
  const { texts, entries } = skillTexts(scope);
  const e = entries.find((x) => x.name === id);
  if (!e) return undefined;
  const t = texts.find((x) => x.id === id);
  const found = t ? skillOperations(t.text, catalog) : { uses: [], unknown: [], sql: [] };
  const last = lastRuns(readOperationRuns(scope.workspaceRoot));
  const failing = (op: string) => [...last.values()].some((r) => r.operation === op && !r.ok);
  return {
    id, group: e.group, summary: e.summary, stageKinds: e.stageKinds, platforms: e.platforms, ...(e.version !== undefined ? { version: e.version } : {}), ...(e.maturity ? { maturity: e.maturity } : {}), ...(e.status ? { status: e.status } : {}), ...(t?.file ? { file: t.file } : {}),
    operations: found.uses.map((u) => ({ ...u, state: catalog.operations.some((o) => o.item.id === u.id && o.status === 'approved') ? (failing(u.id) ? 'failing' as const : 'ok' as const) : 'draft' as const })),
    lint: { unknown: found.unknown, sql: found.sql }
  };
}

// ── A platform's page ───────────────────────────────────────────────────────

export interface PlatformTab { id: 'overview' | 'capabilities' | 'operations' | 'skills' | 'tools' | 'primitives' | 'privileges' | 'health'; title: string }

export interface PlatformPage {
  id: string;
  title: string;
  category: string;
  /** Only the tabs that apply to its category and definition. */
  tabs: PlatformTab[];
  overview: { origin: string; status: string; file: string; approvedBy?: string; transports: string[]; versionOperation?: string; roles: string[]; connections: Array<{ id: string; role: string; readiness: string; detail?: string }> };
  capabilities: Array<{ capability: string } & MatrixCell>;
  operations: Array<{ area: string; operations: Array<{ id: string; title: string; kind: string; transport: string; origin: string; status: string; since?: string; until?: string; lastRun?: OperationRun }> }>;
  skills: Array<{ id: string; group: string; summary: string; stageKinds: string[]; operations?: string[]; availability?: string }>;
  tools?: { cli?: { command: string; minVersion?: string; install?: string; versionArgs?: string[]; profiles: boolean }; api?: string };
  primitives?: { dialect: string; primitives: Array<{ kind: string; description: string; compiles: boolean; reason?: string }> };
  privileges: Array<{ capability: string; privileges: string }>;
  health: { failing: OperationRun[]; recent: OperationRun[]; drafts: string[]; conformance: Array<{ connection: string; at: string; summary: string }> };
}

const TAB_TITLES: Record<PlatformTab['id'], string> = { overview: 'Overview', capabilities: 'Capabilities', operations: 'Operations', skills: 'Skills', tools: 'Tools', primitives: 'Primitives and dialect', privileges: 'Privileges', health: 'Health' };

/** Small valid parameters per core primitive, to say whether it compiles to a dialect (the compile goldens' inputs). */
const PRIMITIVE_EXAMPLES: Record<string, Record<string, unknown>> = {
  dedup: { sourceObject: 'RAW.PUBLIC.ORDERS', targetObject: 'CURATED.STAGING.ORDERS_DEDUP', partitionByColumns: ['ORDER_ID'], orderByColumn: 'UPDATED_AT', orderDirection: 'DESC', objectKind: 'view' },
  incremental_load: { sourceObject: 'RAW.PUBLIC.ORDERS', targetObject: 'CURATED.STAGING.ORDERS', keyColumns: ['ORDER_ID'], updateColumns: ['STATUS', 'AMOUNT'] },
  rename_cast: { sourceObject: 'RAW.PUBLIC.CUSTOMERS', targetObject: 'CURATED.STAGING.STG_CUSTOMERS', objectKind: 'view', columns: [{ source: 'CUST_ID', target: 'customer_id', type: 'INTEGER' }] },
  mask: { sourceObject: 'CURATED.STAGING.STG_CUSTOMERS', targetObject: 'CURATED.STAGING.STG_CUSTOMERS_MASKED', passthrough: ['customer_id'], columns: [{ name: 'email', strategy: 'hash' }], saltExpression: "secret('pii', 'salt')" }
};

function primitivesFor(dialect: SqlDialect): NonNullable<PlatformPage['primitives']>['primitives'] {
  return listPrimitives().map((p) => {
    const params = PRIMITIVE_EXAMPLES[p.kind];
    if (!params) return { kind: p.kind, description: p.description, compiles: false, reason: 'not checked: no example for this primitive' };
    try { p.compile(params as never, { platform: dialect, database: 'CURATED', schema: 'STAGING' } as never, dialect); return { kind: p.kind, description: p.description, compiles: true }; }
    catch (err) { return { kind: p.kind, description: p.description, compiles: false, reason: err instanceof Error ? err.message : String(err) }; }
  });
}

/** One platform's page: the same tabs for every platform, those that don't apply hidden. */
export function platformPage(scope: CatalogScope, id: string, catalog: Catalog = loadCatalog(scope)): PlatformPage | undefined {
  const loaded = catalog.platforms.find((p) => p.item.id === id && p.status === 'approved') ?? catalog.platforms.find((p) => p.item.id === id);
  if (!loaded) return undefined;
  const def: PlatformDefinition = loaded.item;
  const matrix = capabilityMatrix(scope, catalog);
  const conns = connectionsOf(scope).filter((c) => c.platform === id);
  const readiness = scope.workspaceRoot ? readReadiness(scope.workspaceRoot) : {};
  const runs = readOperationRuns(scope.workspaceRoot).filter((r) => r.platform === id);
  const last = lastRuns(runs);
  const mine = catalog.operations.filter((o) => o.item.platforms[id]);
  const areas = [...new Set(mine.map((o) => o.item.area))].sort();
  const { texts, entries } = skillTexts(scope);
  const forPlatform = entries.filter((e) => e.platforms.includes(id) || e.scope === id);
  const compiles = (def.category === 'warehouse' || def.category === 'lakehouse') && def.dialect?.compile;
  const tabs: PlatformTab['id'][] = ['overview', 'capabilities', 'operations', 'skills', ...(def.access ? ['tools' as const] : []), ...(compiles ? ['primitives' as const] : []), 'privileges', 'health'];
  const conformance = readConformance(scope.workspaceRoot);
  return {
    id, title: def.title, category: def.category,
    tabs: tabs.map((t) => ({ id: t, title: TAB_TITLES[t] })),
    overview: {
      origin: loaded.origin, status: loaded.status, file: loaded.file, ...(loaded.approvedBy ? { approvedBy: loaded.approvedBy } : {}), transports: def.transports, ...(def.versionOperation ? { versionOperation: def.versionOperation } : {}), roles: def.connection?.roles ?? [],
      connections: conns.map((c) => { const r = readiness[c.id]; return { id: c.id, role: c.role, readiness: r ? (r.ok ? 'ready' : 'failed') : 'unchecked', ...(r?.detail ? { detail: r.detail } : {}) }; })
    },
    capabilities: matrix.capabilities.filter((cap) => def.capabilities[cap]).map((cap) => ({ capability: cap, ...matrix.cells[cap][id] })),
    operations: areas.map((area) => ({
      area,
      operations: mine.filter((o) => o.item.area === area).map((o) => {
        const impl = o.item.platforms[id];
        const lr = [...last.values()].filter((r) => r.operation === o.item.id).sort((a, b) => b.at.localeCompare(a.at))[0];
        return { id: o.item.id, title: o.item.title, kind: o.item.kind, transport: impl.sql ? 'sql' : impl.cli ? 'cli' : impl.http ? 'http' : 'file', origin: o.origin, status: o.status, ...(impl.since ? { since: impl.since } : {}), ...(impl.until ? { until: impl.until } : {}), ...(lr ? { lastRun: lr } : {}) };
      })
    })),
    skills: forPlatform.map((e) => { const t = texts.find((x) => x.id === e.name); return { id: e.name, group: e.group, summary: e.summary, stageKinds: e.stageKinds, ...(t ? { operations: skillOperations(t.text, catalog).uses.map((u) => u.id) } : {}), ...(e.availability ? { availability: e.availability } : {}) }; }),
    ...(def.access ? { tools: { ...(def.access.cli ? { cli: { command: def.access.cli.command, ...(def.access.cli.minVersion ? { minVersion: def.access.cli.minVersion } : {}), ...(def.access.cli.install ? { install: def.access.cli.install } : {}), ...(def.access.cli.versionArgs ? { versionArgs: def.access.cli.versionArgs } : {}), profiles: !!def.access.cli.listProfiles } } : {}), ...(def.access.api ? { api: def.access.api.name } : {}) } } : {}),
    ...(compiles ? { primitives: { dialect: def.dialect!.compile!, primitives: primitivesFor(def.dialect!.compile as SqlDialect) } } : {}),
    privileges: Object.entries(def.capabilities).filter(([, c]) => c.privileges).map(([cap, c]) => ({ capability: cap, privileges: c.privileges! })),
    health: {
      failing: [...last.values()].filter((r) => !r.ok),
      recent: runs.slice(-20).reverse(),
      drafts: catalog.operations.filter((o) => o.status === 'draft' && o.item.platforms[id]).map((o) => o.item.id).concat(catalog.platforms.filter((p) => p.item.id === id && p.status === 'draft').map((p) => `${p.item.id} (the platform definition)`)),
      conformance: conns.map((c) => conformance[c.id]).filter((x): x is ConformanceResult => !!x).map((x) => ({ connection: x.connection, at: x.at, summary: x.summary }))
    }
  };
}
