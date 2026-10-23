/** Word-boundary matcher: a keyword must start on a word boundary to avoid `source` matching inside `resource`. */
export function matchesAnyKeyword(text: string, keywords: string[]): boolean {
  for (const kw of keywords) {
    if (new RegExp(`(?:^|[^a-z0-9_])${escapeRegExp(kw)}`, 'i').test(text)) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
