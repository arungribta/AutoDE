import { BaseNode, GraphEdge, Origin, TableNode } from './types';
import { parseYaml, stringifyYaml } from './Yaml';

/**
 * Estate identity (Phase K1, v0.31.0; docs/context-layer-requirements.md
 * §11 Phase K items 1–3, 10). An estate is a set of *systems* (logical
 * sources and targets: "Shop OMS", "CRM", "EDW target"), each in one or more
 * *environments* (dev, test, prod). Every physical object gets an id that
 * says which system and environment it belongs to, so identically named
 * tables in two systems — or in dev and prod — never collide. Business
 * kinds get namespaced ids too (`term:`, `rule:`, `query:`).
 *
 * `.ai-context/estate.yaml` records the systems and which connection or
 * imported file feeds which system. Anything not bound gets a system named
 * after its connection or file, added automatically.
 */

export type SystemRole = 'source' | 'target' | 'both';

export interface EstateSystem {
  /** Slug, used in ids. */
  id: string;
  name: string;
  role: SystemRole;
  /** Optional per-schema role override (`DATABASE.SCHEMA` → role), for in-place modernisation. */
  schemaRoles?: Record<string, SystemRole>;
}

export interface EstateBinding {
  /** A connection id (`snowflake:acme`) — or */
  connection?: string;
  /** an imported file (matched by file name, case-insensitive). */
  file?: string;
  system: string;
  environment?: string;
  /** Schemas to extract for a connection (`DATABASE.SCHEMA` or `SCHEMA`). */
  schemas?: string[];
}

export interface Estate {
  systems: EstateSystem[];
  bindings: EstateBinding[];
}

export interface ObjectIdentity {
  system: string;
  environment: string;
  role: SystemRole;
}

export const DEFAULT_ENVIRONMENT = 'default';
export const UNASSIGNED_SYSTEM = 'unassigned';

export function emptyEstate(): Estate {
  return { systems: [], bindings: [] };
}

/** Lower-case, `[a-z0-9]` runs joined by `-`. */
export function slugifyId(text: string): string {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

function normFqn(fqn: string): string {
  return fqn.replace(/["`[\]]/g, '').toLowerCase();
}

/** `obj:<system>/<environment>/<fqn>[.<column>]` — the id of a physical object. */
export function objectId(system: string, environment: string, fqn: string, column?: string): string {
  return `obj:${system}/${environment}/${normFqn(fqn)}${column ? '.' + column.toLowerCase() : ''}`;
}

export function edgeId(type: string, source: string, target: string): string {
  return `edge:${type}:${source}->${target}`;
}

export function termId(name: string): string { return `term:${slugifyId(name)}`; }
export function queryId(name: string): string { return `query:${slugifyId(name)}`; }
/** Rules have no natural key; the first six words make an id that survives edits to the rest of the text. */
export function ruleId(text: string): string { return `rule:${slugifyId(String(text ?? '').split(/\s+/).slice(0, 6).join(' '))}`; }
export function specTermId(specId: string, suffix: string): string { return `term:spec.${slugifyId(specId)}.${slugifyId(suffix)}`; }
export function specRuleId(specId: string, suffix: string): string { return `rule:spec.${slugifyId(specId)}.${slugifyId(suffix)}`; }

/** True for ids in the current scheme (anything else is legacy and gets re-keyed). */
export function isCanonicalId(id: string): boolean {
  return /^(obj|term|rule|query|metric|rel|edge):/.test(id);
}

/** Parses `obj:` ids; undefined for anything else. */
export function parseObjectId(id: string): { system: string; environment: string; path: string } | undefined {
  const m = /^obj:([^/]+)\/([^/]+)\/(.+)$/.exec(id);
  return m ? { system: m[1], environment: m[2], path: m[3] } : undefined;
}

// ── estate.yaml ───────────────────────────────────────────────────────────────

export function parseEstate(text: string | undefined): Estate {
  if (!text || !text.trim()) return emptyEstate();
  const raw = (parseYaml(text) ?? {}) as Partial<Estate>;
  const systems = Array.isArray(raw.systems) ? raw.systems.filter((s) => s && typeof s.id === 'string').map((s) => ({
    id: slugifyId(s.id), name: typeof s.name === 'string' && s.name ? s.name : s.id,
    role: (['source', 'target', 'both'] as const).includes(s.role as SystemRole) ? s.role as SystemRole : 'source',
    ...(s.schemaRoles && typeof s.schemaRoles === 'object' ? { schemaRoles: s.schemaRoles } : {})
  })) : [];
  const bindings = Array.isArray(raw.bindings) ? raw.bindings.filter((b) => b && typeof b.system === 'string' && (b.connection || b.file)).map((b) => ({
    ...(b.connection ? { connection: String(b.connection) } : {}),
    ...(b.file ? { file: String(b.file) } : {}),
    system: slugifyId(b.system),
    ...(b.environment ? { environment: slugifyId(b.environment) } : {}),
    ...(Array.isArray(b.schemas) && b.schemas.length ? { schemas: b.schemas.map(String) } : {})
  })) : [];
  return { systems, bindings };
}

export function serializeEstate(estate: Estate): string {
  return '# AutoDE estate: logical systems, their environments, and which connections / imported files feed them.\n'
    + '# Roles: source | target | both. A binding without an environment uses "default".\n'
    + stringifyYaml(estate);
}

function fileKey(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).toLowerCase();
}

/**
 * Which system and environment a connection or imported file belongs to.
 * An unbound one gets a system named after it; `estate` is returned with
 * that system (and binding) added, so the caller can persist it.
 */
export function resolveIdentity(estate: Estate, source: { connection?: string; file?: string; role?: SystemRole }): { identity: ObjectIdentity; estate: Estate; created: boolean } {
  const binding = estate.bindings.find((b) => (source.connection && b.connection === source.connection) || (source.file && b.file && fileKey(b.file) === fileKey(source.file)));
  if (binding) {
    const system = estate.systems.find((s) => s.id === binding.system);
    return { identity: { system: binding.system, environment: binding.environment ?? DEFAULT_ENVIRONMENT, role: system?.role ?? source.role ?? 'source' }, estate, created: false };
  }
  const base = source.connection ? source.connection : source.file ? fileKey(source.file).replace(/\.[^.]+$/, '') : UNASSIGNED_SYSTEM;
  const id = slugifyId(base);
  const exists = estate.systems.some((s) => s.id === id);
  const next: Estate = {
    systems: exists ? estate.systems : [...estate.systems, { id, name: base, role: source.role ?? 'source' }],
    bindings: [...estate.bindings, { ...(source.connection ? { connection: source.connection } : { file: fileKey(source.file ?? base) }), system: id }]
  };
  return { identity: { system: id, environment: DEFAULT_ENVIRONMENT, role: source.role ?? 'source' }, estate: next, created: true };
}

/** The role of a schema within a system (`schemaRoles` override, else the system's role). */
export function roleFor(estate: Estate, system: string, database: string, schema: string): SystemRole | undefined {
  const s = estate.systems.find((x) => x.id === system);
  if (!s) return undefined;
  const key = `${database}.${schema}`.toLowerCase();
  const override = Object.entries(s.schemaRoles ?? {}).find(([k]) => k.toLowerCase() === key || k.toLowerCase() === schema.toLowerCase());
  return override ? override[1] : s.role;
}

/** `Origin.environment` (the older source/target tag) for a role. */
export function originSideFor(role: SystemRole): 'source' | 'target' | undefined {
  return role === 'both' ? undefined : role;
}

// ── Catalog watermarks ────────────────────────────────────────────────────────

/** Latest extraction/verification time per `system/environment` — what a manifest pins (item 6). */
export function catalogWatermarks(nodes: readonly BaseNode[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of nodes) {
    if (n.type !== 'table' && n.type !== 'semantic_view') continue;
    const o = n.origin;
    const parsed = parseObjectId(n.id);
    const system = o?.system ?? parsed?.system;
    if (!system) continue;
    const key = `${system}/${o?.systemEnvironment ?? parsed?.environment ?? DEFAULT_ENVIRONMENT}`;
    const at = o?.lastVerifiedAt ?? o?.extractedAt ?? '';
    if (!(key in out)) out[key] = '';
    if (at > out[key]) out[key] = at;
  }
  for (const k of Object.keys(out)) if (!out[k]) out[k] = 'unknown';
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ── Re-keying legacy ids (item 2) ─────────────────────────────────────────────

/**
 * Converts every legacy-format id (`table-…`, `col-…`, `biz-term-…`,
 * `biz-rule-N`, `verified-query-…`, `spec-term-…`, `spec-rule-…`, `edge-…`)
 * to the current scheme. Pure: returns the re-keyed graph and the alias map
 * (old id → new id) for nodes and edges. Idempotent: a graph already in the
 * current scheme comes back unchanged with no aliases.
 */
export function rekeyLegacyGraph(
  graph: { nodes: readonly BaseNode[]; edges: readonly GraphEdge[] },
  identityOf: (origin: Origin | undefined) => { system: string; environment: string }
): { nodes: BaseNode[]; edges: GraphEdge[]; aliases: Map<string, string> } {
  const aliases = new Map<string, string>();
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const tableOfColumn = new Map<string, string>();
  for (const e of graph.edges) if (e.type === 'contains') tableOfColumn.set(e.target, e.source);
  const used = new Set(graph.nodes.filter((n) => isCanonicalId(n.id)).map((n) => n.id));
  const unique = (id: string) => {
    let out = id;
    for (let i = 2; used.has(out); i++) out = `${id}-${i}`;
    used.add(out);
    return out;
  };

  const newIdFor = (n: BaseNode): string | undefined => {
    if (isCanonicalId(n.id)) return undefined;
    const ident = identityOf(n.origin);
    switch (n.type) {
      case 'table':
      case 'semantic_view': {
        const fqn = (n as TableNode).fqn || n.label;
        return objectId(n.origin?.system ?? ident.system, n.origin?.systemEnvironment ?? ident.environment, fqn);
      }
      case 'column': {
        const tableId = tableOfColumn.get(n.id);
        const table = tableId ? byId.get(tableId) as TableNode | undefined : undefined;
        if (!table) return undefined;
        const tIdent = identityOf(table.origin);
        return objectId(table.origin?.system ?? tIdent.system, table.origin?.systemEnvironment ?? tIdent.environment, table.fqn || table.label, n.label);
      }
      case 'business_term': {
        const spec = n.origin?.specId;
        if (spec && n.id.startsWith(`spec-term-${spec}-`)) return specTermId(spec, n.id.slice(`spec-term-${spec}-`.length));
        return termId(n.label);
      }
      case 'business_rule': {
        const spec = n.origin?.specId;
        if (spec && n.id.startsWith(`spec-rule-${spec}-`)) return specRuleId(spec, n.id.slice(`spec-rule-${spec}-`.length));
        return ruleId((n as { ruleText?: string }).ruleText ?? n.label);
      }
      case 'verified_query':
        return queryId(n.label);
      default:
        return undefined;
    }
  };

  // Tables first, so columns can find their table's identity; deterministic order.
  const order = [...graph.nodes].sort((a, b) => (a.type === 'column' ? 1 : 0) - (b.type === 'column' ? 1 : 0));
  for (const n of order) {
    const next = newIdFor(n);
    if (next) aliases.set(n.id, unique(next));
  }
  const nodes = graph.nodes.map((n) => {
    const to = aliases.get(n.id);
    if (!to) return n;
    const ident = identityOf(n.origin);
    const isPhysical = n.type === 'table' || n.type === 'semantic_view' || n.type === 'column';
    const parsed = parseObjectId(to);
    const origin = n.origin && isPhysical && parsed ? { ...n.origin, system: n.origin.system ?? parsed.system ?? ident.system, systemEnvironment: n.origin.systemEnvironment ?? parsed.environment ?? ident.environment } : n.origin;
    return { ...n, id: to, ...(origin ? { origin } : {}) } as BaseNode;
  });
  const edges = graph.edges.map((e) => {
    const source = aliases.get(e.source) ?? e.source;
    const target = aliases.get(e.target) ?? e.target;
    if (isCanonicalId(e.id) && source === e.source && target === e.target) return e;
    const id = edgeId(e.type, source, target);
    if (id !== e.id) aliases.set(e.id, id);
    return { ...e, id, source, target };
  });
  return { nodes, edges, aliases };
}
