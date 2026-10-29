// The platform boundary (owner, 2026-10-28; CLAUDE.md): platform-specific work is done by AutoDE's agents with
// platform skills and runbooks. Only safety checks, estate reads, repeatable deliverables and connections are code,
// in their own folders. This test reads the TypeScript sources (no build needed) and fails when platform statements
// or CLI commands appear outside those folders, or platform branches grow, beyond the recorded baseline.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const BASELINE = JSON.parse(fs.readFileSync(path.join(__dirname, 'architecture', 'platform-boundary.json'), 'utf8'));

/** Where platform code belongs (CLAUDE.md): safety checks, estate reads, connections; the runner; dialect compilation. */
const ALLOWED = ['src/engine/platform/', 'src/engine/runner/', 'src/engine/transforms/'];

/** Statements and commands that exist on one platform only. */
const STATEMENTS = [
  /\bsnow\s+(sql|object|stage|connection|app|streamlit|spcs|cortex|dbt|git|notebook)\b/gi,
  /\b(CREATE|ALTER)\s+(OR\s+REPLACE\s+)?(TAG|WAREHOUSE|STAGE|STREAM|TASK|PIPE|DYNAMIC\s+TABLE|MASKING\s+POLICY|ROW\s+ACCESS\s+POLICY)\b/gi,
  /\bSET\s+TAG\b/gi,
  /\bSNOWFLAKE\.ACCOUNT_USAGE\b/gi,
  /\bCOPY\s+INTO\b/gi,
  /\bdatabricks\s+(bundle|jobs|fs|workspace|clusters|pipelines|catalogs|schemas|tables|aitools|auth)\b/gi,
  /\bOPTIMIZE\s+\w+[^;\n]*\bZORDER\b|\bVACUUM\s+\w/gi,
  /\bsystem\.(access|information_schema|billing|lakeflow)\b/gi,
  /\b(ALL|DBA|USER)_(TAB_COLUMNS|TABLES|CONSTRAINTS|CONS_COLUMNS|VIEWS|TAB_COMMENTS)\b/gi
];
/** Behaviour that branches on a platform's name. */
const BRANCHES = /(===|!==|case)\s*'(snowflake|databricks|oracle)'/g;

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : e.name.endsWith('.ts') ? [p] : [];
  });
}
/** Comments say what code does; they aren't code. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}
const count = (text, re) => (text.match(re) || []).length;

const results = [];
function test(name, fn) {
  try { fn(); results.push(true); console.log(`  PASS  ${name}`); } catch (err) { results.push(false); console.log(`  FAIL  ${name}\n    ${String(err && err.message || err).replace(/\n/g, '\n    ')}`); }
}

const found = {};
for (const file of sources(path.join(ROOT, 'src'))) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (ALLOWED.some((a) => rel.startsWith(a))) continue;
  const text = code(fs.readFileSync(file, 'utf8'));
  const statements = STATEMENTS.reduce((n, re) => n + count(text, re), 0);
  const branches = count(text, BRANCHES);
  if (statements || branches) found[rel] = { statements, branches };
}

console.log('Platform boundary (CLAUDE.md)...\n');
const rule = 'Platform-specific work belongs in skills and runbooks (CLAUDE.md, "Platform-specific work belongs in skills and platform operations, not in engine code"). Move it into a platform operation file or a skill, or into an allowed folder (' + ALLOWED.join(', ') + '). Never raise the baseline to make this pass.';

test('platform statements and CLI commands appear only in the allowed folders, or where the baseline records why', () => {
  const over = Object.entries(found).filter(([f, c]) => c.statements > ((BASELINE.files[f] || {}).statements || 0))
    .map(([f, c]) => `${f}: ${c.statements} platform statement(s) or command(s), baseline ${(BASELINE.files[f] || {}).statements || 0}`);
  assert.deepStrictEqual(over, [], `${over.join('\n')}\n${rule}`);
});

test('platform branches (=== \'snowflake\' and the like) don\'t grow outside the allowed folders', () => {
  const over = Object.entries(found).filter(([f, c]) => c.branches > ((BASELINE.files[f] || {}).branches || 0))
    .map(([f, c]) => `${f}: ${c.branches} platform branch(es), baseline ${(BASELINE.files[f] || {}).branches || 0}`);
  assert.deepStrictEqual(over, [], `${over.join('\n')}\nPrefer data (a dialect table, a YAML definition) or a skill over branching on a platform's name. ${rule}`);
});

test('every baseline entry says why, and none is stale (a fixed file\'s entry is lowered or removed)', () => {
  const problems = [];
  for (const [f, b] of Object.entries(BASELINE.files)) {
    if (!b.why || b.why.length < 20) problems.push(`${f}: no reason recorded`);
    const c = found[f] || { statements: 0, branches: 0 };
    if ((b.statements || 0) > c.statements || (b.branches || 0) > c.branches) problems.push(`${f}: baseline ${JSON.stringify({ statements: b.statements || 0, branches: b.branches || 0 })} is above today's ${JSON.stringify(c)}; lower it so the gain is kept`);
  }
  assert.deepStrictEqual(problems, [], problems.join('\n'));
});

test('the rule is written where every coding agent reads it', () => {
  const md = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  assert.ok(/Platform-specific work belongs in skills and platform operations, not in engine code/.test(md) && md.includes('test/architecture.test.cjs'));
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exitCode = 1;
