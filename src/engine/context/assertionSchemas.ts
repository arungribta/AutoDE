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
    properties: { term: { type: 'string', minLength: 1 }, definition: { type: 'string' }, formula: { type: 'string' }, boundTo: { type: 'array', items: { type: 'string' } } }
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
    properties: { text: { type: 'string' }, level: { enum: ['STRICT', 'RECOMMENDED'] }, strategy: { type: 'string' } }
  },
  mapping: {
    type: 'object',
    required: ['from', 'to'],
    properties: { from: { type: 'array', items: { type: 'string' }, minItems: 1 }, to: { type: 'string' }, transform: { type: 'string' } }
  },
  quality_expectation: {
    type: 'object',
    required: ['check'],
    properties: { check: { enum: ['not_null', 'accepted_values', 'freshness', 'unique', 'range'] }, values: { type: 'array' }, maxAgeHours: { type: 'number' } }
  },
  decision: { type: 'object' },
  assumption: { type: 'object' },
  constraint: { type: 'object' },
  naming_convention: { type: 'object' },
  verified_query: {
    type: 'object',
    required: ['sql'],
    properties: { sql: { type: 'string' }, dialect: { type: 'string' } }
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
