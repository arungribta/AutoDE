#!/usr/bin/env node
/**
 * Regenerates the parts of docs/technical-design.md that are facts about the
 * code — the settings table (§10.5, from package.json) and the source tree
 * (§12, from src/) — between `<!-- generated:<name> -->` markers.
 *
 *   node scripts/docs-generate.cjs          rewrite the sections
 *   node scripts/docs-generate.cjs --check  exit 1 if they are out of date (run by npm test)
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const DOC = path.join(root, 'docs', 'technical-design.md');

/** One line per source folder: what lives there. A folder missing here is listed without a note. */
const FOLDER_NOTES = {
  'src': 'activation and command registration',
  'src/agents': 'shared codegen paths (primitive selection, freehand, Pipeline Spec synthesis)',
  'src/agents/build': 'build-phase agents, including the tool-skill runner',
  'src/agents/discover': 'Source Assessment',
  'src/agents/model': 'data model and source-to-target mapping',
  'src/agents/validate': 'documentation and Grounding Report',
  'src/context': 'host-side managers: specs, plans, context documents, business-problem pack, artifacts, chats, graph, watchers',
  'src/core': 'orchestrator, webview/panel providers, LLM adapters and tools, spec engine, configuration',
  'src/core/credentials': 'VS Code SecretStorage credential resolver',
  'src/editors': 'custom editors',
  'src/engine': 'shared types (everything under src/engine/ is free of vscode)',
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
  'src/spokes': 'Snowflake executor (other files unused)'
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
    if (!re.test(out)) throw new Error(`docs/technical-design.md has no <!-- generated:${name} --> section`);
    out = out.replace(re, (_m, open, close) => `${open}${nl}${gen().replace(/\n/g, nl)}${nl}${close}`);
  }
  return out;
}

const doc = fs.readFileSync(DOC, 'utf8');
const next = render(doc);
if (process.argv.includes('--check')) {
  if (next !== doc) {
    console.error('docs/technical-design.md is out of date with package.json or src/: run `npm run docs:generate`.');
    process.exit(1);
  }
} else if (next !== doc) {
  fs.writeFileSync(DOC, next);
  console.log('docs/technical-design.md: generated sections updated');
} else {
  console.log('docs/technical-design.md: generated sections already current');
}
