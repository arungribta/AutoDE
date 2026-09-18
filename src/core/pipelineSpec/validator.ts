import Ajv, { ValidateFunction } from 'ajv';
import { PIPELINE_SPEC_SCHEMA } from './schema';

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
  const valid = validateFn(data) as boolean;
  const errors = (validateFn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
  return { valid, errors };
}
