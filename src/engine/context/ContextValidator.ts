import Ajv, { ErrorObject, ValidateFunction } from 'ajv';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates context objects against the AutoDE context-envelope JSON Schema
 * (docs/schemas/context-envelope.schema.json). The schema is injected so the
 * validator stays pure and unit-testable; the extension loads the schema file
 * once at startup.
 */
export class ContextValidator {
  private readonly validateFn: ValidateFunction<unknown>;

  public constructor(schema: object) {
    const ajv = new Ajv({
      allErrors: true,
      strict: false,
      logger: { log: () => {}, warn: () => {}, error: () => {} }
    });
    this.validateFn = ajv.compile(schema);
  }

  public validateEnvelope(data: unknown): ValidationResult {
    const valid = this.validateFn(data) as boolean;
    const errors: string[] = (this.validateFn.errors ?? []).map(formatError);
    return { valid, errors };
  }
}

function formatError(error: ErrorObject): string {
  const location = error.instancePath ? error.instancePath : '/';
  return `${location} ${error.message ?? 'is invalid'}`;
}
