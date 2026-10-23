'use strict';
/**
 * The fixture check of AutoDE's platform skills (v0.45.11, mcp-engine §9.2 PA3 §8b): every
 * skill ships a worked example on the reference problem (retail orders) inside its SKILL.md,
 * and this checks what the example teaches:
 * - its SQL resolves against the reference estate (or objects the examples create, or the model's planned tables);
 * - it uses its platform's dialect (no other platform's markers), one statement at a time where it is run;
 * - a landing table marked `-- lands <table>` has exactly the estate table's columns (plus `_`-prefixed load columns);
 * - its runbooks pass the engine's checks with no dialect warning, its bundle files and dbt YAML are sound.
 * Used by functional.test.cjs; run on its own with `node test/platformSkillCheck.cjs` after `npm run compile`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const dist = (m) => require(path.join(ROOT, 'dist', m));

/** Fenced blocks: language, label (the rest of the info string) and body. */
function skillBlocks(md) {
  const out = [];
  for (const m of md.matchAll(/^```(\w+)[ \t]*([^\n]*)\r?\n([\s\S]*?)^```[ \t]*$/gm)) out.push({ lang: m[1], label: m[2].trim(), body: m[3] });
  return out;
}

/** The reference estate: the retail-orders DDL as a schema index and a column map by fully qualified name. */
function referenceEstate() {
  const { parseDdl } = dist('engine/context/fileIngestion.js');
  const { buildSchemaIndex } = dist('engine/grounding/sqlGrounding.js');
  const nodes = [], edges = [];
  for (const f of ['shop.ddl', 'crm.ddl']) {
    const file = path.join(ROOT, 'test', 'reference', 'retail-orders', 'sources', f);
    const r = parseDdl(fs.readFileSync(file, 'utf8'), file, { system: f.replace('.ddl', ''), environment: 'prod' });
    nodes.push(...r.nodes); edges.push(...r.edges);
  }
  const index = buildSchemaIndex(nodes, edges);
  return { index, columns: (fqn) => index.tables.find((t) => t.fqn.toLowerCase() === fqn.toLowerCase())?.columns };
}

const CONNECTIONS = [
  { id: 'snowflake:analytics_dev', platform: 'snowflake', role: 'target', fields: {}, credentials: { resolver: 'cli', ref: 'analytics_dev' }, allowSampleDataInPrompts: false, origin: 'team' },
  { id: 'databricks:lakehouse_dev', platform: 'databricks', role: 'target', fields: {}, credentials: { resolver: 'cli', ref: 'lakehouse_dev' }, allowSampleDataInPrompts: false, origin: 'team' }
];

/** The target model's planned tables (the modelling stage's), which examples may read. */
const MODEL_TABLES = ['fct_orders', 'dim_customer', 'dim_product'];

const statements = (sql) => sql.split(/;[ \t]*(?:\r?\n|$)/).map((s) => s.trim()).filter((s) => s && !/^(--[^\n]*\n?)+$/.test(s));

/** Objects the examples create (any skill): known to the others, as a later stage's would be. */
function createdObjects(skills) {
  const names = new Set(MODEL_TABLES);
  for (const k of skills) {
    const md = fs.readFileSync(path.join(k.dir, 'SKILL.md'), 'utf8');
    for (const m of md.matchAll(/\bcreate\s+(?:or\s+(?:replace|alter|refresh)\s+)?(?:(?:transient|temporary|dynamic|streaming|materialized|iceberg)\s+)*(?:table|view|stream)\s+(?:if\s+not\s+exists\s+)?([\w.]+)/gi)) names.add(m[1].split('.').pop().toLowerCase());
    // dbt models are named by their files.
    for (const m of md.matchAll(/```sql\s+models\/\S*?(\w+)\.sql/g)) names.add(m[1].toLowerCase());
  }
  return [...names];
}

/** One skill's example (`md`: its SKILL.md, or a changed copy) against the context of all of them. */
function checkSkill(skill, ctx, md = fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8')) {
  const errors = [];
  const { foreignDialect } = dist('engine/platform/dialectMarkers.js');
  const { checkSingleStatement } = dist('engine/platform/sqlGuard.js');
  const { checkSqlGrounding } = dist('engine/grounding/sqlGrounding.js');
  const { checkRunbook } = dist('engine/runner/runbook.js');
  const { loadRunbookPolicy } = dist('engine/runner/policy.js');
  const { parseYaml } = dist('engine/context/Yaml.js');
  const blocks = skillBlocks(md);
  const platforms = skill.meta.platforms.filter((p) => p !== 'any');
  const sqlArtifacts = [];
  const dialectCheck = (where, sql) => { for (const p of platforms) { const f = foreignDialect(sql, p); if (f.length && platforms.length === 1) errors.push(`${where}: not ${p} SQL (${f.join('; ')}).`); } };

  for (const [i, b] of blocks.entries()) {
    const where = `${skill.id} block ${i + 1}${b.label ? ` (${b.label})` : ''}`;
    if (b.lang === 'sql') {
      sqlArtifacts.push({ name: b.label || `${skill.id}-${i + 1}.sql`, content: b.body });
      dialectCheck(where, b.body);
      if (!/\{\{|\{%/.test(b.body)) for (const st of statements(b.body)) { const c = checkSingleStatement(st); if (!c.ok) errors.push(`${where}: ${c.reason} — ${st.slice(0, 80)}`); }
      for (const m of b.body.matchAll(/--\s*lands\s+([\w.]+)[ \t]*\r?\n\s*create\s+table\s+(?:if\s+not\s+exists\s+)?[\w.]+\s*\(([\s\S]*?)\)\s*(?:;|$)/gi)) {
        const estate = ctx.estate.columns(m[1]);
        if (!estate) { errors.push(`${where}: ${m[1]} is not in the reference estate.`); continue; }
        const cols = m[2].split(/,\s*(?![^(]*\))/).map((c) => c.trim().split(/\s+/)[0].toLowerCase()).filter(Boolean);
        for (const c of cols) if (!c.startsWith('_') && !estate.has(c)) errors.push(`${where}: landing column ${c} is not in ${m[1]}.`);
        for (const c of estate.keys()) if (!cols.includes(c)) errors.push(`${where}: landing table misses ${m[1]}.${c}.`);
      }
    } else if (b.lang === 'yaml' && b.label === 'runbook') {
      let rb;
      try { rb = parseYaml(b.body); } catch (e) { errors.push(`${where}: ${e.message}`); continue; }
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-skill-'));
      for (const y of blocks.filter((x) => x.lang === 'yaml' && /databricks\.yml$/.test(x.label))) {
        fs.mkdirSync(path.join(ws, path.dirname(y.label)), { recursive: true });
        fs.writeFileSync(path.join(ws, y.label), y.body);
      }
      const r = checkRunbook(rb, { workspaceRoot: ws, connections: CONNECTIONS, policy: loadRunbookPolicy(ws) });
      if (!r.ok) errors.push(...r.errors.map((e) => `${where}: ${e}`));
      for (const w of r.warnings.filter((x) => /looks like/.test(x))) errors.push(`${where}: ${w}`);
      const conn = CONNECTIONS.find((c) => c.id === rb.connectionId);
      if (conn && platforms.length && !platforms.includes(conn.platform)) errors.push(`${where}: a ${conn.platform} runbook in a ${platforms.join('/')} skill.`);
      const all = (steps) => (steps ?? []).flatMap((s) => [s, ...all(s.rollback?.steps)]);
      for (const s of all(rb.steps)) if (s.kind === 'sql') sqlArtifacts.push({ name: `${rb.id}.${s.id}.sql`, content: s.sql });
      fs.rmSync(ws, { recursive: true, force: true });
    } else if (b.lang === 'yaml' && /databricks\.yml$/.test(b.label)) {
      let doc;
      try { doc = parseYaml(b.body); } catch (e) { errors.push(`${where}: ${e.message}`); continue; }
      if (!doc?.bundle?.name) errors.push(`${where}: a bundle needs bundle.name.`);
      if (!doc?.targets || !Object.keys(doc.targets).length) errors.push(`${where}: a bundle needs its targets (dev, prod).`);
      for (const m of b.body.matchAll(/\$\{var\.(\w+)\}/g)) if (!doc?.variables?.[m[1]]) errors.push(`${where}: \${var.${m[1]}} is not declared under variables.`);
    } else if (b.lang === 'yaml' && /\.yml$/.test(b.label)) {
      let doc;
      try { doc = parseYaml(b.body); } catch (e) { errors.push(`${where}: ${e.message}`); continue; }
      for (const src of doc?.sources ?? []) for (const t of src.tables ?? []) {
        const fqn = `${src.schema ?? src.name}.${t.identifier ?? t.name}`;
        const cols = ctx.estate.columns(fqn);
        if (!cols) { errors.push(`${where}: dbt source ${fqn} is not in the reference estate.`); continue; }
        for (const c of t.columns ?? []) if (!cols.has(String(c.name).toLowerCase())) errors.push(`${where}: dbt source column ${fqn}.${c.name} is not in the estate.`);
      }
    }
  }
  if (!sqlArtifacts.length) errors.push(`${skill.id}: the worked example has no SQL.`);
  if ((skill.meta.scope === 'snowflake' || skill.meta.scope === 'databricks') && !blocks.some((b) => b.label === 'runbook')) errors.push(`${skill.id}: a platform skill's example includes its runbook.`);
  const g = checkSqlGrounding(sqlArtifacts, ctx.estate.index, ctx.planned);
  for (const u of g.unresolved) errors.push(`${skill.id}: ${u.kind} ${u.ref} doesn't resolve (${u.artifact}).`);
  for (const t of g.typeIssues) errors.push(`${skill.id}: ${t.detail} (${t.artifact}).`);
  return { errors, blocks, grounding: g };
}

/** Every platform skill (Snowflake, Databricks, dbt and the reconciliation skill) and what is wrong with each. */
function platformSkills() {
  const { loadSkillPack } = dist('engine/agents/definitions.js');
  const skills = loadSkillPack(ROOT).skills.filter((k) => ['snowflake', 'databricks', 'dbt'].includes(k.meta.scope) || k.id === 'autode-de-reconciliation');
  return { skills, ctx: { estate: referenceEstate(), planned: createdObjects(skills) } };
}

function checkPlatformSkills() {
  const { skills, ctx } = platformSkills();
  return skills.map((k) => ({ id: k.id, ...checkSkill(k, ctx) }));
}

module.exports = { skillBlocks, referenceEstate, platformSkills, checkSkill, checkPlatformSkills, CONNECTIONS };

if (require.main === module) {
  let bad = 0;
  for (const r of checkPlatformSkills()) {
    console.log(`${r.errors.length ? '✗' : '✓'} ${r.id} (${r.blocks.length} blocks; tables ${r.grounding.tablesResolved}/${r.grounding.tablesChecked}, columns ${r.grounding.columnsResolved}/${r.grounding.columnsChecked})`);
    for (const e of r.errors) console.log(`    ${e}`);
    bad += r.errors.length;
  }
  process.exitCode = bad ? 1 : 0;
}
