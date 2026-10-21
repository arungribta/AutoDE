#!/usr/bin/env node
/**
 * Stages and packs the standalone `autode` package (docs/mcp-engine-requirements.md
 * §3.1 D7, phase PA2): the engine, `autode mcp`, the CLI and the bundled
 * resources, laid out like the extension so the same dist/autode.js finds them.
 * It has no dependencies — dist/autode.js is self-contained.
 *
 *   node scripts/pack-cli.cjs          stage dist/package/ only
 *   node scripts/pack-cli.cjs --pack   stage, then `npm pack` it into dist/autode-<version>.tgz
 *
 * Run after `npm run compile` (or the --production bundle: `npm run package:cli`).
 * Publishing to a registry is a separate step for the owner (`npm publish dist/autode-<version>.tgz`).
 */
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

/** Files the package carries, relative to the repository root. Directories are copied whole. */
const CONTENT = [
  'dist/autode.js',
  'dist/mcp-server.js',
  'dist/THIRD-PARTY-NOTICES.md',
  'skills',
  'primitive-definitions',
  'workflows',
  'media/autode-icon-64.png',
  'LICENSE'
];

function copy(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from)) copy(path.join(from, e), path.join(to, e));
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

/** Builds the package folder; returns its path. Exported for the tests. */
function stage(outDir = path.join(root, 'dist', 'package')) {
  if (!fs.existsSync(path.join(root, 'dist', 'autode.js'))) throw new Error('dist/autode.js is missing: run npm run compile first.');
  const ext = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const rel of CONTENT) {
    const from = path.join(root, rel);
    // skills/ ships only the interview prompt packs, as in the VSIX; primitive-definitions/ may not exist yet.
    if (!fs.existsSync(from)) continue;
    if (rel === 'skills') {
      for (const f of fs.readdirSync(from).filter((x) => x.endsWith('.json'))) copy(path.join(from, f), path.join(outDir, 'skills', f));
      continue;
    }
    copy(from, path.join(outDir, rel));
  }
  // The package README is the CLI reference; its links point at the repository.
  const repo = (ext.repository && ext.repository.url ? ext.repository.url : '').replace(/\.git$/, '');
  const readme = fs.readFileSync(path.join(root, 'docs', 'cli.md'), 'utf8')
    .replace(/\]\((?!https?:|#)([^)]+)\)/g, (_m, link) => `](${repo}/blob/master/docs/${link})`);
  fs.writeFileSync(path.join(outDir, 'README.md'), readme);
  const pkg = {
    name: 'autode',
    version: ext.version,
    description: 'AutoDE engine on its own: deterministic data-engineering tools, the AutoDE MCP server (autode mcp) and the autode CLI. Holds no model credentials; the host supplies the model.',
    license: ext.license,
    author: ext.author,
    repository: ext.repository,
    homepage: ext.homepage || (repo ? `${repo}#readme` : undefined),
    keywords: ['data engineering', 'mcp', 'model context protocol', 'snowflake', 'databricks', 'pipeline', 'cli'],
    bin: { autode: 'dist/autode.js' },
    main: 'dist/autode.js',
    engines: { node: '>=18' },
    files: ['dist/', 'skills/', 'primitive-definitions/', 'workflows/', 'media/', 'README.md', 'LICENSE']
  };
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  return outDir;
}

/** `npm pack` of the staged folder into dist/; returns the tarball path. */
function pack(stageDir, destination = path.join(root, 'dist')) {
  const r = spawnSync('npm', ['pack', '--json', '--pack-destination', destination], { cwd: stageDir, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true });
  if (r.status !== 0) throw new Error(`npm pack failed: ${r.stderr || r.stdout}`);
  const [info] = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
  return { tarball: path.join(destination, info.filename), size: info.size, unpackedSize: info.unpackedSize, files: info.files.map((f) => f.path) };
}

module.exports = { stage, pack, CONTENT };

if (require.main === module) {
  try {
    const dir = stage();
    console.log(`staged ${path.relative(root, dir)}`);
    if (process.argv.includes('--pack')) {
      const r = pack(dir);
      console.log(`packed ${path.relative(root, r.tarball)} (${Math.round(r.size / 1024)} KB, ${r.files.length} files, ${Math.round(r.unpackedSize / 1024)} KB unpacked)`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
