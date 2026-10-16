#!/usr/bin/env node
/**
 * Bundles AutoDE's two entry points with esbuild (docs/mcp-engine-requirements.md
 * §3 D1/D2, phase 3):
 *   dist/extension.js   — the VS Code extension (external: vscode)
 *   dist/mcp-server.js  — the MCP server (no externals; runs on any Node ≥ 18)
 * Both are self-contained, so the VSIX ships no node_modules/.
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
    { entryPoints: [path.join(root, 'src/mcp/server.ts')], outfile: path.join(root, 'dist/mcp-server.js') }
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
  writeNotices(bundledPackages);
}

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
  const header = '# Third-party notices\n\nAutoDE (MIT, see LICENSE) bundles the following open-source packages into dist/extension.js and dist/mcp-server.js. Their licences and notices follow.\n\n';
  fs.writeFileSync(path.join(root, 'dist', 'THIRD-PARTY-NOTICES.md'), header + sections.join('\n'));
  console.log(`wrote dist/THIRD-PARTY-NOTICES.md (${packages.size} packages)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
