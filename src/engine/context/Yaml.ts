import { parse, stringify } from 'yaml';

/**
 * Thin wrapper around the `yaml` library so the rest of the codebase parses and
 * serializes YAML consistently (replacing the hand-rolled parsers).
 */

/** Parses a YAML document into a JS value (object / array / scalar). */
export function parseYaml(text: string): unknown {
  return parse(text);
}

/** Serializes a JS value into a YAML document string. */
export function stringifyYaml(value: unknown): string {
  return stringify(value);
}
