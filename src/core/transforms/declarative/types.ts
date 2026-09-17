/**
 * Tier 2 of Phase 2B-ii's primitive extensibility model: a `PrimitiveDefinition`
 * is data (a YAML document), not code — its `compile()` behavior is a
 * platform-templated string, rendered by the constrained engine in
 * `templateEngine.ts`. See `adapter.ts` for how a definition becomes a real
 * `TransformPrimitive` (Tier 1's interface, unchanged).
 */

export type PrimitiveLifecycleStatus = 'draft' | 'published' | 'deprecated' | 'retired';

export interface PrimitiveDefinitionOutputCheck {
  /** Rendered against the same params as the template; the result must appear in the compiled output. */
  mustContain?: string;
  /** Rendered against the same params; the result must NOT appear in the compiled output (e.g. an unqualified DROP). */
  mustNotContain?: string;
}

export interface PrimitiveDefinition {
  kind: string;
  version: number;
  status: PrimitiveLifecycleStatus;
  description: string;
  /** Same Ajv JSON Schema shape Tier 1's `paramSchema` uses. */
  paramSchema: object;
  /** Dialect (`SqlDialect`) -> template string. Must include a `default` entry, used when no dialect-specific template exists. */
  platformTemplates: Record<string, string>;
  /** Sample params for the UI's live preview and for test fixtures. */
  previewParams: Record<string, unknown>;
  outputChecks?: PrimitiveDefinitionOutputCheck[];
  publishedBy?: string;
  publishedAt?: string;
  changelog?: string;
}
