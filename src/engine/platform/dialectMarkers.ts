/**
 * Dialect markers (v0.45.11): constructs that belong to one data platform's SQL
 * and not the other's, so a Databricks statement in a Snowflake runbook (or the
 * reverse) is caught before anyone runs it. Deliberately a short list of
 * unambiguous markers, not a parser: both dialects share most of SQL (MERGE,
 * QUALIFY, CLUSTER BY, `::` casts), and those are not markers.
 */

export type MarkedPlatform = 'snowflake' | 'databricks';

const MARKERS: Record<MarkedPlatform, Array<[string, RegExp]>> = {
  snowflake: [
    ['a stage, pipe, stream, task, warehouse, file format or policy object', /\bcreate\s+(?:or\s+(?:replace|alter)\s+)?(?:stage|pipe|stream|task|warehouse|dynamic\s+table|file\s+format|masking\s+policy|row\s+access\s+policy|storage\s+integration)\b/i],
    ['TARGET_LAG', /\btarget_lag\b/i],
    ['HASH_AGG', /\bhash_agg\s*\(/i],
    ['SYSTEM$ functions', /\bsystem\$\w+/i],
    ['METADATA$ columns', /\bmetadata\$\w+/i],
    ['a stage reference (@stage)', /(?:^|[\s(,])@[A-Za-z_~%]/],
    ['FILE_FORMAT =', /\bfile_format\s*=/i],
    ['MATCH_BY_COLUMN_NAME', /\bmatch_by_column_name\b/i],
    ['USE WAREHOUSE', /\buse\s+warehouse\b/i],
    ['SET MASKING POLICY / ROW ACCESS POLICY', /\b(?:set\s+masking\s+policy|add\s+row\s+access\s+policy)\b/i]
  ],
  databricks: [
    ['USING DELTA', /\busing\s+delta\b/i],
    ['OPTIMIZE / ZORDER / VACUUM', /^\s*(?:optimize|vacuum)\b|\bzorder\s+by\b/im],
    ['read_files() / cloud_files()', /\b(?:read_files|cloud_files)\s*\(/i],
    ['a streaming table', /\bstreaming\s+table\b/i],
    ['TBLPROPERTIES', /\btblproperties\b/i],
    ['xxhash64()', /\bxxhash64\s*\(/i],
    ['SET ROW FILTER / SET MASK', /\bset\s+(?:row\s+filter|mask)\b/i],
    ['FORMAT_OPTIONS / COPY_OPTIONS', /\b(?:format_options|copy_options)\b/i],
    ['a Unity Catalog volume path', /\/Volumes\//],
    ['a catalog or volume object', /\bcreate\s+(?:catalog|volume|external\s+volume)\b/i],
    ['AUTO CDC / APPLY CHANGES', /\b(?:auto\s+cdc|apply\s+changes)\s+into\b/i],
    ['backtick identifiers', /`[A-Za-z_][\w]*`/]
  ]
};

/** Strips comments and string literals, keeping `/Volumes/` and `@stage` paths inside literals visible as markers. */
function strip(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'((?:[^']|'')*)'/g, (_m, inner: string) => (/^(?:\/Volumes\/|@)/.test(inner) ? ` ${inner} ` : "''"));
}

/** The markers of each platform the SQL carries. */
export function dialectMarkers(sql: string): Record<MarkedPlatform, string[]> {
  const text = strip(String(sql ?? ''));
  const found = (p: MarkedPlatform) => MARKERS[p].filter(([, re]) => re.test(text)).map(([label]) => label);
  return { snowflake: found('snowflake'), databricks: found('databricks') };
}

/** Markers of another platform in SQL meant for `platform` (empty when the platform isn't Snowflake or Databricks). */
export function foreignDialect(sql: string, platform: string): string[] {
  const m = dialectMarkers(sql);
  if (platform === 'snowflake') return m.databricks;
  if (platform === 'databricks') return m.snowflake;
  return [];
}
