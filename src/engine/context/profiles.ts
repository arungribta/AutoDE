import Ajv from 'ajv';
import { parseYaml, stringifyYaml } from './Yaml';

/**
 * Interpretation profiles (Phase C4a, item 2): how to read a structured
 * document whose shape is the customer's own (a house-format data contract
 * in YAML, a mapping workbook exported to JSON). The LLM proposes a profile
 * once from the document's structure; the engineer confirms or corrects it;
 * from then on it is applied **deterministically** — to every entry, and to
 * later versions of the document — so a new version yields a precise diff.
 *
 * Paths are dot-separated keys relative to the current object; `each` paths
 * name an array. Stored as `.autode/knowledge/profiles/<id>.yaml`.
 */

/** A yes/no value in the document: true when the value (lower-cased) is one of `yes`. */
export interface FlagPath {
  path: string;
  yes: string[];
}

export interface InterpretationProfile {
  id: string;
  name?: string;
  /** Only confirmed profiles are applied. */
  status: 'proposed' | 'confirmed';
  /** Top-level keys a document must have for this profile to apply. */
  signature: string[];
  entities: {
    each: string;
    name: string;
    description?: string;
    /** Table references (`schema.table` or a list of them) the entity is realised by. */
    tables?: string;
    fields: {
      each: string;
      name: string;
      type?: string;
      /** "Mandatory"-style flag: yes ⇒ not nullable. */
      required?: FlagPath;
      /** "Nullable"-style flag: yes ⇒ nullable. */
      nullable?: FlagPath;
      unique?: FlagPath;
      /** An object mapping a system id or schema name to the physical column name. */
      columns?: string;
    };
    rules?: {
      each: string;
      field: string;
      check: string;
      /** Document rule name (lower-cased) → AutoDE check. */
      checkMap: Record<string, 'not_null' | 'unique' | 'accepted_values'>;
      values?: string;
    };
  };
}

export interface ContractField {
  name: string;
  /** Document path of the entry (clause provenance). */
  path: string;
  type?: string;
  nullable?: boolean;
  unique?: boolean;
  columns?: Record<string, string>;
}

export interface ContractRule {
  field: string;
  check: 'not_null' | 'unique' | 'accepted_values';
  values?: unknown[];
  path: string;
}

export interface ContractEntity {
  name: string;
  path: string;
  description?: string;
  tables: string[];
  fields: ContractField[];
  rules: ContractRule[];
}

export interface ContractModel {
  entities: ContractEntity[];
  warnings: string[];
}

const flagSchema = { type: 'object', required: ['path', 'yes'], properties: { path: { type: 'string', minLength: 1 }, yes: { type: 'array', items: { type: 'string' }, minItems: 1 } }, additionalProperties: false };
const PROFILE_SCHEMA = {
  type: 'object',
  required: ['id', 'status', 'signature', 'entities'],
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
    name: { type: 'string' },
    status: { enum: ['proposed', 'confirmed'] },
    signature: { type: 'array', items: { type: 'string' } },
    entities: {
      type: 'object',
      required: ['each', 'name', 'fields'],
      properties: {
        each: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        tables: { type: 'string' },
        fields: {
          type: 'object',
          required: ['each', 'name'],
          properties: {
            each: { type: 'string', minLength: 1 },
            name: { type: 'string', minLength: 1 },
            type: { type: 'string' },
            required: flagSchema,
            nullable: flagSchema,
            unique: flagSchema,
            columns: { type: 'string' }
          },
          additionalProperties: false
        },
        rules: {
          type: 'object',
          required: ['each', 'field', 'check', 'checkMap'],
          properties: {
            each: { type: 'string', minLength: 1 },
            field: { type: 'string', minLength: 1 },
            check: { type: 'string', minLength: 1 },
            checkMap: { type: 'object', additionalProperties: { enum: ['not_null', 'unique', 'accepted_values'] } },
            values: { type: 'string' }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    }
  },
  additionalProperties: false
};

let validator: ReturnType<Ajv['compile']> | undefined;

export function validateProfile(raw: unknown): string[] {
  validator ??= new Ajv({ allErrors: true, strict: false, logger: false }).compile(PROFILE_SCHEMA);
  return validator(raw) ? [] : (validator.errors ?? []).map((e) => `${e.instancePath || 'profile'} ${e.message ?? 'is invalid'}`);
}

export function parseProfile(text: string): { profile?: InterpretationProfile; errors: string[] } {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return { errors: [`not YAML: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const errors = validateProfile(raw);
  return errors.length ? { errors } : { profile: raw as InterpretationProfile, errors };
}

export function serializeProfile(p: InterpretationProfile): string {
  return '# AutoDE interpretation profile (Phase C4a): how documents of this shape are read. Set status: confirmed once it reads them correctly.\n' + stringifyYaml(p as unknown as Record<string, unknown>);
}

// ── Reading documents ────────────────────────────────────────────────────────

/** Parses a structured document (YAML is a superset of JSON). */
export function parseStructured(content: string): unknown {
  return parseYaml(content);
}

function get(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.').filter(Boolean)) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function text(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function flag(obj: unknown, f: FlagPath | undefined): boolean | undefined {
  if (!f) return undefined;
  const v = text(get(obj, f.path));
  if (v === undefined) return undefined;
  return f.yes.map((y) => y.toLowerCase()).includes(v.toLowerCase());
}

/** Whether a profile's signature fits a document. */
export function profileMatches(doc: unknown, p: InterpretationProfile): boolean {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  const keys = new Set(Object.keys(doc as Record<string, unknown>));
  return p.signature.length > 0 && p.signature.every((k) => keys.has(k));
}

/**
 * Applies a profile to a parsed document — deterministic: same document and
 * profile, same model. Entries the profile can't read are reported as
 * warnings, never guessed.
 */
export function applyProfile(doc: unknown, p: InterpretationProfile): ContractModel {
  const warnings: string[] = [];
  const entities: ContractEntity[] = [];
  const list = get(doc, p.entities.each);
  if (!Array.isArray(list)) return { entities, warnings: [`"${p.entities.each}" is not a list in this document`] };
  list.forEach((e, i) => {
    const path = `${p.entities.each}[${i}]`;
    const name = text(get(e, p.entities.name));
    if (!name) { warnings.push(`${path}: no "${p.entities.name}" — skipped`); return; }
    const t = p.entities.tables ? get(e, p.entities.tables) : undefined;
    const tables = (Array.isArray(t) ? t : t !== undefined ? [t] : []).map(text).filter((x): x is string => !!x);
    const fields: ContractField[] = [];
    const fl = get(e, p.entities.fields.each);
    (Array.isArray(fl) ? fl : []).forEach((f, j) => {
      const fpath = `${path}.${p.entities.fields.each}[${j}]`;
      const fname = text(get(f, p.entities.fields.name));
      if (!fname) { warnings.push(`${fpath}: no "${p.entities.fields.name}" — skipped`); return; }
      const required = flag(f, p.entities.fields.required);
      const nullableFlag = flag(f, p.entities.fields.nullable);
      const cols = p.entities.fields.columns ? get(f, p.entities.fields.columns) : undefined;
      const columns = cols && typeof cols === 'object' && !Array.isArray(cols)
        ? Object.fromEntries(Object.entries(cols as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), text(v)]).filter((x): x is [string, string] => !!x[1]))
        : undefined;
      fields.push({
        name: fname,
        path: fpath,
        ...(p.entities.fields.type && text(get(f, p.entities.fields.type)) ? { type: text(get(f, p.entities.fields.type)) } : {}),
        ...(nullableFlag !== undefined ? { nullable: nullableFlag } : required !== undefined ? { nullable: !required } : {}),
        ...(flag(f, p.entities.fields.unique) !== undefined ? { unique: flag(f, p.entities.fields.unique) } : {}),
        ...(columns && Object.keys(columns).length ? { columns } : {})
      });
    });
    const rules: ContractRule[] = [];
    if (p.entities.rules) {
      const r = p.entities.rules;
      const rl = get(e, r.each);
      (Array.isArray(rl) ? rl : []).forEach((x, k) => {
        const rpath = `${path}.${r.each}[${k}]`;
        const field = text(get(x, r.field));
        const raw = text(get(x, r.check))?.toLowerCase();
        const check = raw ? r.checkMap[raw] : undefined;
        if (!field || !check) { warnings.push(`${rpath}: rule "${raw ?? '?'}" on "${field ?? '?'}" is not mapped by the profile — skipped`); return; }
        const values = r.values ? get(x, r.values) : undefined;
        rules.push({ field, check, path: rpath, ...(Array.isArray(values) ? { values } : {}) });
      });
    }
    entities.push({ name, path, ...(p.entities.description && text(get(e, p.entities.description)) ? { description: text(get(e, p.entities.description)) } : {}), tables, fields, rules });
  });
  return { entities, warnings };
}

// ── Proposing a profile (the one LLM step) ───────────────────────────────────

/** The document's shape for the prompt: keys, the first element of each list, short sample values. */
export function documentSkeleton(doc: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (Array.isArray(doc)) return doc.length ? [documentSkeleton(doc[0], depth + 1)] : [];
  if (doc && typeof doc === 'object') return Object.fromEntries(Object.entries(doc as Record<string, unknown>).map(([k, v]) => [k, documentSkeleton(v, depth + 1)]));
  return typeof doc === 'string' ? doc.slice(0, 40) : doc;
}

export function buildProfileProposalPrompt(doc: unknown, path: string): { system: string; user: string } {
  return {
    system: [
      'You map the structure of a customer\'s data document onto a fixed reading profile. You never extract the data itself.',
      'Respond with one JSON object only, no prose, in exactly this shape:',
      '{ "id": "<lower-case-slug>", "name": "...", "status": "proposed", "signature": ["<top-level keys that identify this document shape>"],',
      '  "entities": { "each": "<path to the list of datasets/entities>", "name": "<path, relative to an entity, of its name>", "description": "<optional>", "tables": "<optional path to the physical table name(s)>",',
      '    "fields": { "each": "<path, relative to an entity, of its list of fields>", "name": "...", "type": "<optional>", "required": { "path": "...", "yes": ["Y","yes","true"] }, "nullable": <optional, same shape>, "unique": <optional, same shape>, "columns": "<optional path to an object system→physical column>" },',
      '    "rules": <optional> { "each": "...", "field": "<path of the field a rule is on>", "check": "<path of the rule name>", "checkMap": { "<rule name as written, lower-case>": "not_null" | "unique" | "accepted_values" }, "values": "<optional path of allowed values>" } } }',
      'Paths are dot-separated keys. Use only paths that exist in the skeleton. Omit what the document does not have.'
    ].join('\n'),
    user: `## Document: ${path}\n\nStructure (first element of each list, values truncated):\n\n${JSON.stringify(documentSkeleton(doc), null, 2)}\n\nPropose the reading profile now.`
  };
}

/** Validates a proposed profile; it is always `proposed` until the engineer confirms it. */
export function parseProfileProposal(raw: unknown): { profile?: InterpretationProfile; errors: string[] } {
  if (!raw || typeof raw !== 'object') return { errors: ['not a JSON object'] };
  const candidate = { ...(raw as Record<string, unknown>), status: 'proposed' };
  const errors = validateProfile(candidate);
  return errors.length ? { errors } : { profile: candidate as unknown as InterpretationProfile, errors };
}
