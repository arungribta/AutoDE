/**
 * A deliberately constrained, hand-rolled template engine for Tier 2
 * (declarative) primitives. It supports exactly three things:
 *   - `{{paramName}}`               simple variable substitution
 *   - `{{join arrayParam ", "}}`    joins an array param with a separator
 *   - `{{#each arrayParam}}...{{this}}...{{/each}}`   iterates an array param
 *
 * There is no `eval`/`Function()`, no expression language, no conditionals —
 * on purpose. The one property that matters is that a `PrimitiveDefinition`
 * author (potentially not a TypeScript contributor, see Phase 2B-iii) can
 * never smuggle arbitrary code execution into the compile path. If a
 * primitive genuinely needs logic beyond this, that's the signal to make it
 * a Tier 1 (TypeScript) primitive instead of stretching this engine further.
 *
 * Note on scope: param values are stringified as opaque text and are not
 * re-scanned for template syntax of their own — a value that happens to
 * contain a literal `{{...}}` sequence is rendered as inert text like any
 * other character, never interpreted as a nested template reference.
 */

const EACH_PATTERN = /\{\{#each\s+([a-zA-Z_][a-zA-Z0-9_]*)\}\}([\s\S]*?)\{\{\/each\}\}/g;
const JOIN_PATTERN = /\{\{\s*join\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+"([^"]*)"\s*\}\}/g;
const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const THIS_PATTERN = /\{\{\s*this\s*\}\}/g;

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Arrays/objects are only ever unwrapped via {{join}}/{{#each}} — if one reaches here
  // (e.g. {{someObjectParam}} used directly), stringify defensively rather than emit "[object Object]".
  return JSON.stringify(value);
}

/** Renders a constrained template against a flat params object. Never throws — an unknown variable renders as empty text. */
export function renderTemplate(template: string, params: Record<string, unknown>): string {
  let output = template;

  // 1. {{#each array}}...{{this}}...{{/each}} — structural, so it runs first; {{this}}
  // inside a body is resolved immediately per-iteration, before the outer variable pass.
  output = output.replace(EACH_PATTERN, (_match, paramName: string, body: string) => {
    const value = params[paramName];
    if (!Array.isArray(value)) return '';
    return value.map((item) => body.replace(THIS_PATTERN, () => stringifyValue(item))).join('');
  });

  // 2. {{join array "sep"}}
  output = output.replace(JOIN_PATTERN, (_match, paramName: string, sep: string) => {
    const value = params[paramName];
    if (!Array.isArray(value)) return '';
    return value.map(stringifyValue).join(sep);
  });

  // 3. {{paramName}} simple substitution
  output = output.replace(VARIABLE_PATTERN, (_match, paramName: string) => {
    if (!(paramName in params)) return '';
    return stringifyValue(params[paramName]);
  });

  return output;
}
