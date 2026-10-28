import Ajv, { ValidateFunction } from 'ajv';
import { Assertion, AssertionKind, ASSERTION_KINDS } from './assertions';

/**
 * Per-kind JSON Schemas for `Assertion.value` (C2,
 * docs/context-layer-requirements.md §4.1). Graph mirrors — assertions whose
 * predicate is `node` / `edge`, produced by migrating the graph into the
 * ledger — carry the node or edge itself and are checked by shape only.
 */

const columnList = { type: 'array', items: { type: 'string' }, minItems: 1 };
const entityRef = {
  type: 'object',
  required: ['entity', 'columns'],
  properties: { entity: { type: 'string' }, columns: columnList }
};

const VALUE_SCHEMAS: Record<AssertionKind, object> = {
  schema_fact: {
    type: 'object',
    properties: { dataType: { type: 'string' }, isNullable: { type: 'boolean' }, exists: { type: 'boolean' } }
  },
  data_fact: {
    type: 'object',
    properties: {
      nullRate: { type: 'number', minimum: 0, maximum: 1 },
      distinctCount: { type: 'number', minimum: 0 },
      rowCount: { type: 'number', minimum: 0 },
      min: {}, max: {}, freshness: { type: 'string' }
    }
  },
  key: columnList,
  grain: columnList,
  relationship: {
    type: 'object',
    required: ['from', 'to'],
    properties: {
      from: entityRef,
      to: entityRef,
      cardinality: { enum: ['1:1', '1:N', 'N:1', 'N:M'] },
      optional: { type: 'boolean' }
    }
  },
  business_term: {
    type: 'object',
    required: ['term'],
    // MM1 (§6.11): SKOS-shaped — category, broader / narrower / related terms, steward, status.
    properties: {
      term: { type: 'string', minLength: 1 }, definition: { type: 'string' }, formula: { type: 'string' }, boundTo: { type: 'array', items: { type: 'string' } },
      category: { type: 'string' }, broader: { type: 'array', items: { type: 'string' } }, narrower: { type: 'array', items: { type: 'string' } }, related: { type: 'array', items: { type: 'string' } },
      steward: { type: 'string' }, status: { enum: ['draft', 'approved', 'deprecated'] }, abbreviation: { type: 'string' }, examples: { type: 'array', items: { type: 'string' } }
    }
  },
  metric: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      expression: { type: 'string' },
      definition: { type: 'string' },
      aggregation: { type: 'string' },
      grain: { type: 'array', items: { type: 'string' } },
      filters: { type: 'array', items: { type: 'string' } },
      unit: { type: 'string' }
    },
    anyOf: [{ required: ['expression'] }, { required: ['definition'] }]
  },
  business_rule: {
    type: 'object',
    // GOV: predicate `classification` on a column carries its classification and, for personal data, the mask strategy.
    // MM1 (§6.11, SBVR): ruleType and modality; `level` is the older name of modality (STRICT = mandatory).
    properties: {
      text: { type: 'string' }, level: { enum: ['STRICT', 'RECOMMENDED'] }, strategy: { type: 'string' }, classification: { enum: ['none', 'pii', 'sensitive-pii', 'confidential'] },
      ruleType: { enum: ['definition', 'validation', 'policy', 'standard', 'guidance'] }, modality: { enum: ['mandatory', 'advisory'] },
      scope: { enum: ['asset', 'domain', 'team'] }, domain: { type: 'string' }, expression: { type: 'string' }, owner: { type: 'string' }
    }
  },
  quality_expectation: {
    type: 'object',
    required: ['check'],
    properties: { check: { enum: ['not_null', 'accepted_values', 'freshness', 'unique', 'range', 'schema', 'pattern', 'referential'] }, values: { type: 'array' }, maxAgeHours: { type: 'number' }, dataType: { type: 'string' }, isNullable: { type: 'boolean' }, columns: { type: 'object' }, pattern: { type: 'string' }, references: { type: 'string' }, dimension: { enum: ['completeness', 'uniqueness', 'validity', 'consistency', 'timeliness', 'accuracy'] } }
  },
  decision: { type: 'object' },
  assumption: { type: 'object' },
  constraint: { type: 'object' },
  naming_convention: { type: 'object' },
  verified_query: {
    type: 'object',
    required: ['sql'],
    properties: { sql: { type: 'string' }, dialect: { type: 'string' } }
  },
  classification: {
    type: 'object',
    required: ['classification'],
    properties: { classification: { type: 'string', minLength: 1 }, strategy: { enum: ['hash', 'redact'] }, text: { type: 'string' } }
  },
  // Predicates: tag {key, value?, group?}; owner {role, person}; domain {domain}; certification {status, note?}; property {name, value}.
  metadata: {
    type: 'object',
    oneOf: [
      { required: ['key'], properties: { key: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_.-]*$' }, value: { type: 'string' }, group: { type: 'string' } } },
      { required: ['role', 'person'], properties: { role: { enum: ['business_owner', 'technical_owner', 'data_steward'] }, person: { type: 'string', minLength: 1 } } },
      { required: ['domain'], properties: { domain: { type: 'string', minLength: 1 } } },
      { required: ['status'], properties: { status: { enum: ['verified', 'draft', 'deprecated'] }, note: { type: 'string' } } },
      { required: ['name', 'value'], properties: { name: { type: 'string', minLength: 1 }, value: {} } }
    ]
  }
};

const MIRROR_SCHEMA = {
  type: 'object',
  oneOf: [
    { required: ['node'], properties: { node: { type: 'object', required: ['id', 'type'] } } },
    { required: ['edge'], properties: { edge: { type: 'object', required: ['id', 'source', 'target', 'type'] } } }
  ]
};

let compiled: { byKind: Map<AssertionKind, ValidateFunction>; mirror: ValidateFunction } | undefined;

function validators(): NonNullable<typeof compiled> {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: false, logger: false });
    const byKind = new Map<AssertionKind, ValidateFunction>();
    for (const kind of ASSERTION_KINDS) byKind.set(kind, ajv.compile(VALUE_SCHEMAS[kind]));
    compiled = { byKind, mirror: ajv.compile(MIRROR_SCHEMA) };
  }
  return compiled;
}

export function isMirrorPredicate(predicate: string): boolean {
  return predicate === 'node' || predicate === 'edge';
}

/** Validates an assertion's envelope and its kind-specific `value`. Returns error messages (empty = valid). */
export function validateAssertion(a: Pick<Assertion, 'kind' | 'subject' | 'predicate' | 'value' | 'statement' | 'evidence'>): string[] {
  const errors: string[] = [];
  if (String(a.kind) === 'mapping') return ['mapping facts were retired in v0.45.8: record the mapping in the mapping document (autode_record_mapping).'];
  if (!ASSERTION_KINDS.includes(a.kind)) return [`unknown kind "${String(a.kind)}"`];
  if (!Array.isArray(a.subject) || a.subject.length === 0 || a.subject.some((s) => typeof s !== 'string' || !s)) errors.push('subject must be a non-empty list of ids');
  if (typeof a.predicate !== 'string' || !a.predicate) errors.push('predicate is required');
  if (typeof a.statement !== 'string' || !a.statement.trim()) errors.push('statement is required');
  if (!Array.isArray(a.evidence) || a.evidence.length === 0) errors.push('at least one evidence entry is required');
  const { byKind, mirror } = validators();
  const fn = isMirrorPredicate(a.predicate) ? mirror : byKind.get(a.kind)!;
  if (!fn(a.value)) {
    for (const e of fn.errors ?? []) errors.push(`value${e.instancePath || ''} ${e.message ?? 'is invalid'}`);
  }
  return errors;
}
