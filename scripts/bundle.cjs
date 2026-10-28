#!/usr/bin/env node
/**
 * Bundles AutoDE's two entry points with esbuild (docs/mcp-engine-requirements.md
 * §3 D1/D2, phase 3; §3.1 D7, phase PA2):
 *   dist/extension.js   — the VS Code extension (external: vscode)
 *   dist/autode.js      — the `autode` CLI, `autode mcp` included (no externals; any Node ≥ 18)
 *   dist/mcp-server.js  — a two-line shim for `autode mcp`, kept for existing client configurations
 *   dist/cytoscape.min.js — the graph library of the Knowledge Explorer webview (C5b), copied as published
 * All are self-contained, so the VSIX ships no node_modules/, and the VSIX and
 * the `autode` package (scripts/pack-cli.cjs) carry the same dist/autode.js.
 *
 * `tsc` still compiles every module to dist/** for the tests and the eval;
 * this runs after it and replaces dist/extension.js with the bundle.
 *
 *   node scripts/bundle.cjs               development: readable, linked source maps
 *   node scripts/bundle.cjs --production  packaging: minified (maps are not shipped)
 */
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const root = path.resolve(__dirname, '..');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // VS Code 1.90 runs extensions on Node 18; external MCP clients bring their own Node.
  target: 'node18',
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'warning',
  legalComments: 'none'
};

async function main() {
  const builds = [
    { entryPoints: [path.join(root, 'src/extension.ts')], outfile: path.join(root, 'dist/extension.js'), external: ['vscode'] },
    { entryPoints: [path.join(root, 'src/cli/main.ts')], outfile: path.join(root, 'dist/autode.js'), banner: { js: '#!/usr/bin/env node' } }
  ];
  const bundledPackages = new Map();
  for (const b of builds) {
    const result = await esbuild.build({ ...common, ...b, metafile: true });
    const kb = Math.round(fs.statSync(b.outfile).size / 1024);
    console.log(`bundled ${path.relative(root, b.outfile)} (${kb} KB${production ? ', minified' : ''})`);
    if (process.argv.includes('--analyze')) console.log(await esbuild.analyzeMetafile(result.metafile, { verbose: false }));
    for (const input of Object.keys(result.metafile.inputs)) {
      // The innermost node_modules segment names the package (a nested dependency is its own package).
      const m = [...input.matchAll(/(^|[\\/])node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/g)].pop();
      if (m) bundledPackages.set(m[2].replace(/\\/g, '/'), path.join(root, input.slice(0, m.index + m[0].length)));
    }
  }
  fs.writeFileSync(path.join(root, 'dist', 'mcp-server.js'), MCP_SHIM);
  console.log('wrote dist/mcp-server.js (shim for autode mcp)');
  // Webview libraries ship as their published minified files (no CDN: webviews load only what the VSIX carries).
  for (const [name, file] of WEBVIEW_LIBRARIES) {
    const dir = path.join(root, 'node_modules', name);
    fs.copyFileSync(path.join(dir, file), path.join(root, 'dist', path.basename(file)));
    bundledPackages.set(name, dir);
    console.log(`copied dist/${path.basename(file)} (${name})`);
  }
  writeNotices(bundledPackages);
}

/** Libraries a webview loads, by package and published file (P6 decision record: docs/roadmap.md decision log, 2026-10-28). */
const WEBVIEW_LIBRARIES = [['cytoscape', 'dist/cytoscape.min.js']];

/** The phase-3 server path, still in users' MCP configurations: the same server as `autode mcp`. */
const MCP_SHIM = `#!/usr/bin/env node
// AutoDE MCP server. The server is \`autode mcp\` in autode.js (docs/mcp-setup.md); this path stays for existing configurations.
require('./autode.js').main(['mcp', ...process.argv.slice(2)]).catch((err) => { process.stderr.write('autode: ' + (err && err.message ? err.message : String(err)) + '\\n'); process.exit(1); });
`;

/**
 * The bundles strip comments, so the licences of the libraries they contain
 * ship as dist/THIRD-PARTY-NOTICES.md instead (MIT, ISC, BSD and Apache-2.0
 * all require their notice to travel with copies). Built from what esbuild
 * actually bundled, so it can't drift from the bundle.
 */
function writeNotices(packages) {
  const sections = [];
  for (const [name, dir] of [...packages.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* keep going */ }
    const licenseFile = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    const licence = typeof pkg.license === 'string' ? pkg.license : (pkg.license && pkg.license.type) || 'see package';
    const text = licenseFile ? fs.readFileSync(path.join(dir, licenseFile), 'utf8').trim() : `No licence file in the package; package.json declares: ${licence}.`;
    sections.push(`## ${name}${pkg.version ? ` ${pkg.version}` : ''} — ${licence}\n\n${pkg.homepage || (pkg.repository && (pkg.repository.url || pkg.repository)) || ''}\n\n\`\`\`\n${text}\n\`\`\`\n`);
  }
  const header = '# Third-party notices\n\nAutoDE (MIT, see LICENSE) bundles the following open-source packages into dist/extension.js and dist/autode.js, and ships the Knowledge Explorer\'s graph library as dist/cytoscape.min.js. Their licences and notices follow.\n\n';
  fs.writeFileSync(path.join(root, 'dist', 'THIRD-PARTY-NOTICES.md'), header + sections.join('\n'));
  console.log(`wrote dist/THIRD-PARTY-NOTICES.md (${packages.size} packages)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
