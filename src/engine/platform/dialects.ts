import { loadCatalog, platformById } from './operations/load';
import { onPlatformResourcesRootChange, platformResourcesRoot } from './definitions';

/**
 * A platform's SQL dialect, as its platform definition states it (POP1 part 2;
 * docs/specs/platform-operations.md §2.2). Probes, reconciliation and the dry
 * run read these pieces instead of branching on a platform's name, so a new
 * platform (or a changed one) is a change to its definition, not to code.
 */

export interface SqlFragments {
  /** The platform id, or `ansi` for none. */
  id: string;
  /** A sampled table: `{table}` and `{n}`. */
  sample: string;
  /** A value matching a regular expression: `{column}` and `{pattern}` (already a quoted literal); absent = none. */
  regexMatch?: string;
  /** TRUE and FALSE as the platform writes them. */
  booleans: [string, string];
  /** `native`: COUNT(DISTINCT a, b) works; `emulated`: the caller counts distinct tuples another way. */
  distinctTuples: 'native' | 'emulated';
  /** An order-independent hash of a set of keys: `{keys}`; absent = none. */
  keyHash?: string;
  /** A statement's plan without running it: `{statement}`. */
  explain: string;
  /** When the plan is read by a second statement (Oracle's DBMS_XPLAN). */
  explainResult?: string;
  /** v0.55.2: the statements (by first keyword) EXPLAIN compiles here, where it doesn't compile them all (Redshift: no DDL); absent = all. */
  explainCovers?: string[];
}

/** For a platform with no definition, or no connection: standard SQL. */
export const ANSI: SqlFragments = { id: 'ansi', sample: '(SELECT * FROM {table} LIMIT {n}) s0', booleans: ['TRUE', 'FALSE'], distinctTuples: 'emulated', explain: 'EXPLAIN {statement}' };

export { setPlatformResourcesRoot } from './definitions';

const cache = new Map<string, SqlFragments>();
onPlatformResourcesRootChange(() => cache.clear());

/** A platform's dialect from its definition (the team's approved copy when there is one), standard SQL for an unknown platform. */
export function fragmentsFor(platformId: string | undefined, scope: { resourcesRoot?: string; workspaceRoot?: string } = {}): SqlFragments {
  if (!platformId) return ANSI;
  const resourcesRoot = platformResourcesRoot(scope);
  const key = `${resourcesRoot ?? ''}|${scope.workspaceRoot ?? ''}|${platformId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const d = resourcesRoot || scope.workspaceRoot ? platformById(loadCatalog({ resourcesRoot, workspaceRoot: scope.workspaceRoot }), platformId)?.dialect : undefined;
  const f = d?.fragments ?? {};
  const out: SqlFragments = d ? {
    id: platformId,
    sample: f.sample ?? ANSI.sample,
    ...(f.regexMatch ? { regexMatch: f.regexMatch } : {}),
    booleans: d.booleans ?? ANSI.booleans,
    distinctTuples: f.distinctTuples === 'native' ? 'native' : 'emulated',
    ...(f.keyHash ? { keyHash: f.keyHash } : {}),
    explain: f.explain ?? ANSI.explain,
    ...(f.explainResult ? { explainResult: f.explainResult } : {}),
    ...(f.explainCovers ? { explainCovers: f.explainCovers.split(/[,\s]+/).map((k) => k.trim().toUpperCase()).filter(Boolean) } : {})
  } : ANSI;
  cache.set(key, out);
  return out;
}

/** Fills a fragment's `{name}` holes with SQL the caller has already made safe (identifiers checked, literals quoted). */
export function fill(fragment: string, values: Record<string, string>): string {
  return fragment.replace(/\{([a-z]+)\}/g, (m, k: string) => (k in values ? values[k] : m));
}

/** The statements that show a plan without running it: one, or Oracle's two (EXPLAIN PLAN FOR, then the plan). */
export function explainStatements(platformId: string | undefined, statement: string): string[] {
  const f = fragmentsFor(platformId);
  return [fill(f.explain, { statement }), ...(f.explainResult ? [f.explainResult] : [])];
}

/**
 * v0.55.2: whether the platform's EXPLAIN compiles this statement (its first keyword), so a dry run can check it.
 * Where it can't (Redshift's DDL and MERGE), a dry run must say "not checked by the platform", never pass.
 */
export function explainCovers(platformId: string | undefined, firstKeyword: string | undefined): boolean {
  const covers = fragmentsFor(platformId).explainCovers;
  return !covers || !firstKeyword || covers.includes(firstKeyword.toUpperCase());
}
