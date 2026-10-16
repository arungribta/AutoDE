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
  for (const b of builds) {
    const result = await esbuild.build({ ...common, ...b, metafile: true });
    const kb = Math.round(fs.statSync(b.outfile).size / 1024);
    console.log(`bundled ${path.relative(root, b.outfile)} (${kb} KB${production ? ', minified' : ''})`);
    if (process.argv.includes('--analyze')) console.log(await esbuild.analyzeMetafile(result.metafile, { verbose: false }));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
