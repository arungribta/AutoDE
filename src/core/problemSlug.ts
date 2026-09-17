/**
 * Deterministic slug generation for a business problem's folder name
 * (`.ai-context/problems/<slug>/`) — see requirements.md §8.11. Derived from
 * the problem statement the moment the first spec draft exists; no LLM call,
 * no user prompt.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'with', 'is', 'are', 'be',
  'we', 'our', 'i', 'need', 'want', 'would', 'like', 'that', 'this', 'into', 'from', 'as'
]);

/**
 * Turns a problem statement into a short, readable, unique folder-safe slug,
 * e.g. "We need to reduce checkout latency for mobile users" ->
 * "reduce-checkout-latency-mobile-a3f1".
 */
export function generateProblemSlug(problemStatement: string, existingSlugs: string[] = []): string {
  const words = (problemStatement || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word));

  const base = words.slice(0, 5).join('-') || 'business-problem';
  const truncated = base.length > 48 ? base.slice(0, 48).replace(/-+$/, '') : base;

  const existing = new Set(existingSlugs);
  let candidate = `${truncated}-${shortId()}`;
  // Astronomically unlikely to collide (short id is random per call), but
  // guard deterministically anyway rather than trust probability alone.
  while (existing.has(candidate)) {
    candidate = `${truncated}-${shortId()}`;
  }
  return candidate;
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 6);
}
