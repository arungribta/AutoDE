import * as fs from 'node:fs';
import { Assertion, isLive } from '../context/assertions';
import { parseYaml } from '../context/Yaml';
import { layoutPath } from '../workspaceLayout';

/**
 * The metadata model (MM1; docs/context-layer-requirements.md §6.11): tags,
 * ownership, domains and data products, certification, custom properties,
 * typed rules and quality dimensions — the concepts and names of the
 * standards and catalogs. Per-asset metadata is facts in the ledger (kind
 * `metadata`: evidence, trust, supersession); the governed structure —
 * tag groups, property definitions, domains — is team configuration under
 * `.autode/config/`, reviewed like code. Pure reading here; `record.ts` writes.
 */

export const OWNER_ROLES = ['business_owner', 'technical_owner', 'data_steward'] as const;
export type OwnerRole = typeof OWNER_ROLES[number];
export const CERTIFICATIONS_SET = ['verified', 'draft', 'deprecated'] as const;
export type CertificationStatus = typeof CERTIFICATIONS_SET[number];
export const RULE_TYPES = ['definition', 'validation', 'policy', 'standard', 'guidance'] as const;
export type RuleType = typeof RULE_TYPES[number];
export type Modality = 'mandatory' | 'advisory';
export const QUALITY_DIMENSIONS = ['completeness', 'uniqueness', 'validity', 'consistency', 'timeliness', 'accuracy'] as const;
export type QualityDimension = typeof QUALITY_DIMENSIONS[number];

export interface TagDefinition { key: string; description?: string; values?: string[] }
export interface TagGroup { name: string; description?: string; tags: TagDefinition[] }
export interface PropertyDefinition { name: string; type: 'string' | 'number' | 'boolean' | 'enum'; values?: string[]; appliesTo?: string[]; description?: string }
export interface DataProduct { name: string; description?: string; owner?: string; assets: string[] }
export interface DomainDefinition { name: string; description?: string; owners: Array<{ role: OwnerRole; person: string }>; assets: string[]; semanticModels: string[]; dataProducts: DataProduct[] }

export interface MetadataConfig { tagGroups: TagGroup[]; properties: PropertyDefinition[]; domains: DomainDefinition[]; errors: string[] }

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const strs = (v: unknown): string[] => list(v).map(str).filter((x): x is string => !!x);

function readYaml(file: string, errors: string[]): Record<string, unknown> {
  try { return (parseYaml(fs.readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>; } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/** Parses the three configuration files' contents (tolerant: a bad entry is reported and skipped). */
export function parseMetadataConfig(texts: { tags?: unknown; properties?: unknown; domains?: unknown }, errors: string[] = []): MetadataConfig {
  const t = (texts.tags ?? {}) as Record<string, unknown>;
  const p = (texts.properties ?? {}) as Record<string, unknown>;
  const d = (texts.domains ?? {}) as Record<string, unknown>;
  const tagGroups: TagGroup[] = list(t.groups).map((g) => g as Record<string, unknown>).filter((g) => str(g.name)).map((g) => ({
    name: str(g.name)!, ...(str(g.description) ? { description: str(g.description) } : {}),
    tags: list(g.tags).map((x) => x as Record<string, unknown>).filter((x) => str(x.key)).map((x) => ({ key: str(x.key)!, ...(str(x.description) ? { description: str(x.description) } : {}), ...(strs(x.values).length ? { values: strs(x.values) } : {}) }))
  }));
  const properties: PropertyDefinition[] = [];
  for (const raw of list(p.properties)) {
    const x = raw as Record<string, unknown>;
    const type = str(x.type) ?? 'string';
    if (!str(x.name) || !['string', 'number', 'boolean', 'enum'].includes(type)) { errors.push(`properties.yaml: ${JSON.stringify(raw).slice(0, 80)} needs a name and a type (string, number, boolean, enum)`); continue; }
    properties.push({ name: str(x.name)!, type: type as PropertyDefinition['type'], ...(strs(x.values).length ? { values: strs(x.values) } : {}), ...(strs(x.appliesTo).length ? { appliesTo: strs(x.appliesTo) } : {}), ...(str(x.description) ? { description: str(x.description) } : {}) });
  }
  const domains: DomainDefinition[] = [];
  for (const raw of list(d.domains)) {
    const x = raw as Record<string, unknown>;
    if (!str(x.name)) { errors.push(`domains.yaml: a domain needs a name`); continue; }
    const owners = list(x.owners).map((o) => o as Record<string, unknown>).filter((o) => OWNER_ROLES.includes(str(o.role) as OwnerRole) && str(o.person)).map((o) => ({ role: str(o.role) as OwnerRole, person: str(o.person)! }));
    domains.push({
      name: str(x.name)!, ...(str(x.description) ? { description: str(x.description) } : {}), owners, assets: strs(x.assets), semanticModels: strs(x.semanticModels),
      dataProducts: list(x.dataProducts).map((y) => y as Record<string, unknown>).filter((y) => str(y.name)).map((y) => ({ name: str(y.name)!, ...(str(y.description) ? { description: str(y.description) } : {}), ...(str(y.owner) ? { owner: str(y.owner) } : {}), assets: strs(y.assets) }))
    });
  }
  return { tagGroups, properties, domains, errors };
}

export function loadMetadataConfig(workspaceRoot: string): MetadataConfig {
  const errors: string[] = [];
  return parseMetadataConfig({ tags: readYaml(layoutPath(workspaceRoot, 'tagGroups'), errors), properties: readYaml(layoutPath(workspaceRoot, 'customProperties'), errors), domains: readYaml(layoutPath(workspaceRoot, 'domains'), errors) }, errors);
}

/** An asset id or name pattern (`*` any run of characters), case-insensitive, matched against the id and the qualified name. */
export function patternMatches(pattern: string, asset: { id: string; fqn?: string }): boolean {
  const re = new RegExp(`^${pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(asset.id.toLowerCase()) || (!!asset.fqn && re.test(asset.fqn.toLowerCase()));
}

export interface AssetMetadata {
  tags: Array<{ key: string; value?: string; group?: string; factId?: string }>;
  owners: Array<{ role: OwnerRole; person: string; factId?: string; inheritedFrom?: string }>;
  domain?: { name: string; factId?: string; from: 'fact' | 'domains.yaml' | 'semantic model' };
  dataProducts: string[];
  certification?: { status: CertificationStatus; by: string; at: string; note?: string; factId: string };
  properties: Array<{ name: string; value: unknown; factId: string; type?: string }>;
}

/** Live metadata facts per subject, the most recent first; a superseded or rejected fact no longer counts. */
export function metadataBySubject(assertions: readonly Assertion[]): Map<string, Assertion[]> {
  const out = new Map<string, Assertion[]>();
  for (const a of assertions) {
    if (a.kind !== 'metadata' || !isLive(a.status)) continue;
    for (const s of a.subject) out.set(s, [...(out.get(s) ?? []), a]);
  }
  for (const v of out.values()) v.sort((x, y) => (x.validFrom < y.validFrom ? 1 : -1));
  return out;
}

/**
 * Everything the metadata model says about one asset: its facts, then what
 * domains.yaml assigns by pattern (a domain fact overrides the pattern; a
 * domain's owners are inherited when the asset names none for that role).
 */
export function assetMetadata(facts: readonly Assertion[], config: MetadataConfig, asset: { id: string; fqn?: string; model?: string }): AssetMetadata {
  const meta: AssetMetadata = { tags: [], owners: [], dataProducts: [], properties: [] };
  const seen = new Set<string>();
  for (const a of facts) {
    const v = (a.value ?? {}) as Record<string, unknown>;
    if (a.predicate === 'tag' && typeof v.key === 'string') {
      const k = `tag|${v.key.toLowerCase()}`;
      if (seen.has(k)) continue; seen.add(k);
      meta.tags.push({ key: v.key, ...(typeof v.value === 'string' ? { value: v.value } : {}), ...(typeof v.group === 'string' ? { group: v.group } : {}), factId: a.id });
    } else if (a.predicate === 'owner' && OWNER_ROLES.includes(v.role as OwnerRole) && typeof v.person === 'string') {
      const k = `owner|${v.role}|${v.person.toLowerCase()}`;
      if (seen.has(k)) continue; seen.add(k);
      meta.owners.push({ role: v.role as OwnerRole, person: v.person, factId: a.id });
    } else if (a.predicate === 'domain' && typeof v.domain === 'string' && !meta.domain) {
      meta.domain = { name: v.domain, factId: a.id, from: 'fact' };
    } else if (a.predicate === 'certification' && CERTIFICATIONS_SET.includes(v.status as CertificationStatus) && !meta.certification) {
      meta.certification = { status: v.status as CertificationStatus, by: a.createdBy, at: a.validFrom, ...(typeof v.note === 'string' ? { note: v.note } : {}), factId: a.id };
    } else if (a.predicate === 'property' && typeof v.name === 'string') {
      const k = `property|${v.name.toLowerCase()}`;
      if (seen.has(k)) continue; seen.add(k);
      meta.properties.push({ name: v.name, value: v.value, factId: a.id, ...(config.properties.find((p) => p.name === v.name) ? { type: config.properties.find((p) => p.name === v.name)!.type } : {}) });
    }
  }
  const byPattern = config.domains.find((d) => d.assets.some((p) => patternMatches(p, asset)) || (!!asset.model && d.semanticModels.includes(asset.model)));
  if (!meta.domain && byPattern) meta.domain = { name: byPattern.name, from: asset.model && byPattern.semanticModels.includes(asset.model) ? 'semantic model' : 'domains.yaml' };
  const domain = meta.domain ? config.domains.find((d) => d.name.toLowerCase() === meta.domain!.name.toLowerCase()) : undefined;
  if (domain) {
    for (const o of domain.owners) if (!meta.owners.some((x) => x.role === o.role)) meta.owners.push({ ...o, inheritedFrom: `domain ${domain.name}` });
    meta.dataProducts = domain.dataProducts.filter((p) => p.assets.some((x) => patternMatches(x, asset))).map((p) => p.name);
  }
  return meta;
}

/** Validates a metadata value against the configuration: a controlled tag's values, a property's type. */
export function checkMetadata(config: MetadataConfig, predicate: string, value: Record<string, unknown>): string[] {
  if (predicate === 'tag') {
    const def = config.tagGroups.flatMap((g) => g.tags.map((t) => ({ ...t, group: g.name }))).find((t) => t.key.toLowerCase() === String(value.key ?? '').toLowerCase());
    if (def?.values?.length && !def.values.includes(String(value.value ?? ''))) return [`tag ${def.key} takes one of ${def.values.join(', ')} (tag group ${def.group})`];
    return [];
  }
  if (predicate === 'property') {
    const def = config.properties.find((p) => p.name === value.name);
    if (!def) return [`no custom property "${String(value.name)}": define it in .autode/config/properties.yaml`];
    const v = value.value;
    if (def.type === 'number' && typeof v !== 'number') return [`${def.name} is a number`];
    if (def.type === 'boolean' && typeof v !== 'boolean') return [`${def.name} is true or false`];
    if (def.type === 'enum' && !(def.values ?? []).includes(String(v))) return [`${def.name} takes one of ${(def.values ?? []).join(', ')}`];
    return [];
  }
  return [];
}

// ── Rules (SBVR) and quality dimensions ──

export interface RuleView { ruleType: RuleType; modality: Modality; scope: 'asset' | 'domain' | 'team'; text: string; expression?: string; domain?: string; inferred: boolean }

/**
 * A rule as the metadata model reads it: its type and modality, from the fact
 * or — for a rule written before MM1 — inferred deterministically from its
 * level and text (STRICT is mandatory; validation and policy wording is
 * recognised; a RECOMMENDED rule otherwise reads as guidance).
 */
export function ruleOf(a: Pick<Assertion, 'value' | 'statement' | 'subject' | 'predicate'>): RuleView {
  const v = (a.value ?? {}) as Record<string, unknown>;
  const text = typeof v.text === 'string' && v.text ? v.text : a.statement;
  const modality: Modality = v.modality === 'mandatory' || v.modality === 'advisory' ? v.modality : v.level === 'STRICT' ? 'mandatory' : 'advisory';
  const explicit = RULE_TYPES.includes(v.ruleType as RuleType) ? v.ruleType as RuleType : undefined;
  const lower = text.toLowerCase();
  const inferredType: RuleType = a.predicate === 'classification' || /\b(mask|pii|personal data|gdpr|ccpa|pci|retain|retention|access|encrypt)/.test(lower) ? 'policy'
    : /\b(unique|not null|must not be null|must be (?:between|positive|non-negative)|valid values|accepted values|range|format)\b/.test(lower) ? 'validation'
      : /\b(means|is defined as|defined as|equals|is calculated)\b/.test(lower) ? 'definition'
        : /\b(naming|named|prefix|suffix|scd|convention)\b/.test(lower) ? 'standard'
          : modality === 'advisory' ? 'guidance' : 'standard';
  const scope = v.scope === 'asset' || v.scope === 'domain' || v.scope === 'team' ? v.scope : a.subject.some((s) => s === 'project' || s === 'team') ? 'team' : 'asset';
  return { ruleType: explicit ?? inferredType, modality, scope, text, ...(typeof v.expression === 'string' ? { expression: v.expression } : {}), ...(typeof v.domain === 'string' ? { domain: v.domain } : {}), inferred: !explicit };
}

const DIMENSION_OF: Record<string, QualityDimension> = { not_null: 'completeness', unique: 'uniqueness', accepted_values: 'validity', range: 'validity', pattern: 'validity', schema: 'validity', referential: 'consistency', freshness: 'timeliness' };

/** A quality expectation's DAMA dimension: stated, else from its check. */
export function qualityDimension(value: unknown): QualityDimension | undefined {
  const v = (value ?? {}) as { check?: string; dimension?: string };
  if (QUALITY_DIMENSIONS.includes(v.dimension as QualityDimension)) return v.dimension as QualityDimension;
  return v.check ? DIMENSION_OF[v.check] : undefined;
}

/** A classification fact, whether the MM1 kind or the GOV-era rule with predicate `classification`. */
export function isClassificationFact(a: Pick<Assertion, 'kind' | 'predicate'>): boolean {
  return a.kind === 'classification' || (a.kind === 'business_rule' && a.predicate === 'classification');
}
