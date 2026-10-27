import Ajv, { ValidateFunction } from 'ajv';
import { PIPELINE_SPEC_SCHEMA } from './schema';
import { unmaskedSensitive } from '../governance/governance';

export interface PipelineSpecValidationResult {
  valid: boolean;
  errors: string[];
}

const ajv = new Ajv({ allErrors: true, strict: false });
let validateFn: ValidateFunction | undefined;

/** Same `new Ajv({allErrors:true, strict:false})` pattern already used by ContextValidator.ts and transforms/registry.ts. */
export function validatePipelineSpec(data: unknown): PipelineSpecValidationResult {
  if (!validateFn) {
    validateFn = ajv.compile(PIPELINE_SPEC_SCHEMA);
  }
  const schemaValid = validateFn(data) as boolean;
  const errors = (validateFn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
  // GOV: a sensitive-pii column must be masked by a mask step of its entity.
  if (schemaValid) errors.push(...unmaskedSensitive(data as Parameters<typeof unmaskedSensitive>[0]));
  return { valid: errors.length === 0, errors };
}
