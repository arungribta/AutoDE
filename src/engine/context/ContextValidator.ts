import Ajv, { ErrorObject, ValidateFunction } from 'ajv';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /**
   * Problems in the kind-specific `content` (v0.29.0). Reported, never
   * failing: persisted context written before these checks existed must keep
   * loading.
   */
  warnings: string[];
}

/** `kind` → the envelope schema's `definitions` entry for its `content`. */
const CONTENT_DEFINITIONS: Record<string, string> = {
  table: 'tableContent',
  semantic_view: 'tableContent',
  column: 'columnContent',
  business_term: 'businessTermContent',
  business_rule: 'businessRuleContent',
  metric: 'metricContent',
  verified_query: 'verifiedQueryContent',
  semantic_artifact: 'semanticArtifactContent'
};

/**
 * Validates context objects against the AutoDE context-envelope JSON Schema
 * (docs/schemas/context-envelope.schema.json). The schema is injected so the
 * validator stays pure and unit-testable; the extension loads the schema file
 * once at startup.
 *
 * Since v0.29.0 the envelope's per-kind `definitions` (declared since v0.19.0
 * but never referenced) are dispatched on `kind` and applied to `content`.
 */
export class ContextValidator {
  private readonly validateFn: ValidateFunction<unknown>;
  private readonly contentFns = new Map<string, ValidateFunction<unknown>>();

  public constructor(schema: object) {
    const ajv = new Ajv({
      allErrors: true,
      strict: false,
      logger: { log: () => {}, warn: () => {}, error: () => {} }
    });
    this.validateFn = ajv.compile(schema);
    const definitions = (schema as { definitions?: Record<string, object> }).definitions ?? {};
    for (const [kind, defName] of Object.entries(CONTENT_DEFINITIONS)) {
      const def = definitions[defName];
      if (def) this.contentFns.set(kind, ajv.compile(def));
    }
  }

  public validateEnvelope(data: unknown): ValidationResult {
    const valid = this.validateFn(data) as boolean;
    const errors: string[] = (this.validateFn.errors ?? []).map(formatError);
    const warnings: string[] = [];
    const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
    const contentFn = record && typeof record.kind === 'string' ? this.contentFns.get(record.kind) : undefined;
    if (contentFn && record && record.content !== undefined) {
      if (!contentFn(record.content)) {
        for (const e of contentFn.errors ?? []) warnings.push(`/content${formatError(e).replace(/^\/ /, ' ')}`);
      }
    }
    return { valid, errors, warnings };
  }
}

function formatError(error: ErrorObject): string {
  const location = error.instancePath ? error.instancePath : '/';
  return `${location} ${error.message ?? 'is invalid'}`;
}
