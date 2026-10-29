#!/usr/bin/env node
/**
 * Regenerates the parts of docs/design/technical-design.md that are facts about the
 * code — the settings table (§10.5, from package.json) and the source tree
 * (§12, from src/) — between `<!-- generated:<name> -->` markers — and the
 * skill catalog in docs/guides/skills.md (v0.45.5, from skills/ and agents/; needs
 * `npm run compile` first, since it uses the engine's catalog).
 *
 *   node scripts/docs-generate.cjs          rewrite the sections
 *   node scripts/docs-generate.cjs --check  exit 1 if they are out of date (run by npm test)
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const DOC = path.join(root, 'docs', 'design', 'technical-design.md');

/** One line per source folder: what lives there. A folder missing here is listed without a note. */
const FOLDER_NOTES = {
  'src': 'activation and command registration',
  'src/agents': 'Pipeline Spec synthesis (the panel)',
  'src/agents/build': 'the tool-skill runner',
  'src/context': 'host-side managers: specs, plans, context documents, business-problem pack, artifacts, chats, graph, watchers',
  'src/core': 'orchestrator, webview/panel providers, LLM adapters and tools, spec engine, configuration',
  'src/core/credentials': 'VS Code SecretStorage credential resolver',
  'src/editors': 'custom editors',
  'src/engine': 'shared types (everything under src/engine/ is free of vscode)',
  'src/engine/approvals': 'what waits for a person, gathered from every mechanism (SIMP-1)',
  'src/engine/runner': 'runbooks: checks, policy, the runner and its log',
  'src/engine/agents': 'role templates, skills, assignments, the skill catalog, the plugin, and the deterministic helpers agents build on',
  'src/engine/workflows': 'workflow templates, instances, runtime, events, document approval',
  'src/engine/context': 'assertions, ledger, projection, conflicts, estate ids, catalog, vocabulary, retrieval, packs, gaps, business-problem pack, profiles, contracts, conformance, probes, persistence, ingestion',
  'src/engine/grounding': 'SQL grounding checks, manifests, reports',
  'src/engine/pipelineSpec': 'Pipeline Specification',
  'src/engine/platform': 'connections and adapters',
  'src/engine/platform/adapters': 'Snowflake and Databricks adapters',
  'src/engine/platform/credentials': 'credential resolvers and CLI detection',
  'src/engine/platform/executionBackends': 'CLI and REST execution',
  'src/engine/skills': 'interview skills, tool skills, allow-lists, tool-skill lifecycle and trust',
  'src/engine/transforms': 'primitive registry',
  'src/engine/transforms/declarative': 'Tier 2 declarative primitives',
  'src/engine/transforms/primitives': 'Tier 1 primitives',
  'src/mcp': 'MCP server (no vscode; §10.6)',
  'src/cli': 'the autode command line (no vscode; §10.8)',
  'src/spokes': 'Snowflake executor'
};

function sourceTree() {
  const folders = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.ts')) folders.set(dir, [...(folders.get(dir) ?? []), e.name]);
    }
  };
  walk('src');
  const lines = ['```'];
  for (const dir of [...folders.keys()].sort()) {
    const note = FOLDER_NOTES[dir];
    lines.push(`${dir}/${note ? `    # ${note}` : ''}`, `  ${folders.get(dir).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })).join(', ')}`);
  }
  lines.push('```');
  return lines.join('\n');
}

function settingsTable() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const props = pkg.contributes.configuration.properties;
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const firstSentence = (s) => {
    const plain = String(s ?? '').replace(/`#autoDataEngineeringHub\.([^#]+)#`/g, '`$1`').replace(/_/g, '');
    // A sentence ends at . ! ? followed by a capital (so "e.g. adb-…" does not end it) or the end.
    const m = /^(.+?[.!?])(?=\s+[A-Z`(]|\s*$)/.exec(plain);
    return m ? m[1] : plain;
  };
  const lines = ['| Setting | Type | Default | What it does |', '|---|---|---|---|'];
  for (const [key, v] of Object.entries(props)) {
    const type = v.enum ? `enum: ${v.enum.map((x) => `\`${x}\``).join(', ')}` : Array.isArray(v.type) ? v.type.join(' / ') : v.type;
    lines.push(`| \`${key.replace(/^autoDataEngineeringHub\./, '')}\` | ${cell(type)} | \`${cell(JSON.stringify(v.default))}\` | ${cell(firstSentence(v.description ?? v.markdownDescription))} |`);
  }
  return lines.join('\n');
}

const SECTIONS = { settings: settingsTable, 'source-tree': sourceTree };

function render(doc) {
  const nl = doc.includes('\r\n') ? '\r\n' : '\n';
  let out = doc;
  for (const [name, gen] of Object.entries(SECTIONS)) {
    const re = new RegExp(`(<!-- generated:${name} -->)[\\s\\S]*?(<!-- /generated:${name} -->)`);
    if (!re.test(out)) throw new Error(`docs/design/technical-design.md has no <!-- generated:${name} --> section`);
    out = out.replace(re, (_m, open, close) => `${open}${nl}${gen().replace(/\n/g, nl)}${nl}${close}`);
  }
  return out;
}

const SKILLS_DOC = path.join(root, 'docs', 'guides', 'skills.md');

/** docs/guides/skills.md: a fixed introduction and the catalog of bundled and external skills (no workspace's own skills, no detection). */
function skillsDoc() {
  const { skillCatalog, renderCatalogMarkdown } = require(path.join(root, 'dist', 'engine', 'agents', 'skillCatalog.js'));
  const none = path.join(root, 'dist', '.no-workspace');
  const { entries, errors } = skillCatalog({ resourcesRoot: root, workspaceRoot: none, home: none, env: { PATH: '' } });
  if (errors.length) throw new Error(`The skill catalog has errors:\n${errors.join('\n')}`);
  return [
    '# AutoDE skills',
    '',
    '<!-- Generated by `npm run docs:generate` from skills/, agents/ and skills/external.yaml. Do not edit by hand. -->',
    '',
    'Every skill AutoDE has, the interview packs, and the vendor and community skills it works with. In a workspace, `autode skills list` (CLI), `autode_skills_list` (MCP) and the Skills view (VS Code) show the same catalog plus the team\'s own imported skills, and whether each external skill is installed on this machine.',
    '',
    renderCatalogMarkdown(entries.filter((e) => e.group !== 'workspace')).trimEnd(),
    ''
  ].join('\n');
}

const outputs = [
  { file: DOC, current: fs.readFileSync(DOC, 'utf8'), next: (cur) => render(cur) },
  { file: SKILLS_DOC, current: fs.existsSync(SKILLS_DOC) ? fs.readFileSync(SKILLS_DOC, 'utf8') : '', next: (cur) => { const t = skillsDoc(); return cur.includes('\r\n') ? t.replace(/\n/g, '\r\n') : t; } }
];
let stale = false;
for (const o of outputs) {
  const next = o.next(o.current);
  const rel = path.relative(root, o.file).split(path.sep).join('/');
  if (process.argv.includes('--check')) {
    if (next !== o.current) { console.error(`${rel} is out of date with package.json, src/ or skills/: run \`npm run docs:generate\`.`); stale = true; }
  } else if (next !== o.current) {
    fs.writeFileSync(o.file, next);
    console.log(`${rel}: generated sections updated`);
  } else {
    console.log(`${rel}: generated sections already current`);
  }
}
if (stale) process.exit(1);
