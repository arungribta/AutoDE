/**
 * Mapping recall (ONT2; docs/specs/context-layer.md §11): AutoDE's column matching against golden mappings, by names
 * and the vocabulary alone and then through meaning (the ontology's names folded, glossary terms, classifications).
 * Each golden mapping's target is a planned table: its columns are given, as a mapper would.
 *
 *   const r = await mappingRecall({ workspace, goldenFile, tool });  // tool: autode_match_columns's handler
 *   r.namesOnly.found / r.total, r.meaning.found / r.total, r.gained (pairs only meaning finds)
 */
const fs = require('node:fs');
const { parse } = require('yaml');

async function run(golden, tool, ws, namesOnly) {
  let found = 0; let wrong = 0; const pairs = [];
  for (const m of golden.mappings) {
    const targetColumns = Object.values(m.columns).map((name) => ({ name }));
    const r = await tool({ source: m.source, target: m.target, targetColumns, ...(namesOnly ? { namesOnly: true } : {}) }, ws);
    for (const [s, t] of Object.entries(m.columns)) {
      const hit = r.matches.find((x) => x.sourceColumn.toLowerCase() === s.toLowerCase());
      const ok = !!hit && hit.targetColumn.toLowerCase() === t.toLowerCase();
      if (ok) found++; else if (hit) wrong++;
      pairs.push({ source: `${m.source}.${s}`, target: `${m.target}.${t}`, found: ok, ...(hit ? { matched: hit.targetColumn, reasons: hit.reasons } : {}) });
    }
  }
  return { found, wrong, pairs };
}

async function mappingRecall({ ws, goldenFile, tool }) {
  const golden = parse(fs.readFileSync(goldenFile, 'utf8'));
  const total = golden.mappings.reduce((n, m) => n + Object.keys(m.columns).length, 0);
  const namesOnly = await run(golden, tool, ws, true);
  const meaning = await run(golden, tool, ws, false);
  const gained = meaning.pairs.filter((p, i) => p.found && !namesOnly.pairs[i].found).map((p) => ({ source: p.source, target: p.target, reasons: p.reasons }));
  const lost = meaning.pairs.filter((p, i) => !p.found && namesOnly.pairs[i].found).map((p) => p.source);
  return { total, namesOnly: { found: namesOnly.found, wrong: namesOnly.wrong }, meaning: { found: meaning.found, wrong: meaning.wrong }, gained, lost, pairs: meaning.pairs };
}

/**
 * The two fixtures as workspaces: lending (LOANSYS, its vocabulary, the FIBO concepts it touches onboarded and
 * approved) and retail (shop and crm, its glossary and vocabulary; no ontology).
 */
async function fixtureWorkspace(kind, { root, dist, tmp }) {
  const path = require('node:path');
  const ws = fs.mkdtempSync(path.join(tmp, `recall-${kind}-`));
  const { run } = dist('cli/main.js');
  const io = { out: () => {}, err: () => {}, env: {}, cwd: root, interactive: false, prompt: async () => '' };
  const ref = (...p) => path.join(root, 'test', 'reference', ...p);
  if (kind === 'lending') {
    await run(['estate', 'ingest', ref('lending', 'sources', 'loansys.ddl'), '--workspace', ws, '--system', 'loansys'], io);
    fs.copyFileSync(ref('lending', 'vocabulary.yaml'), path.join(ws, '.autode', 'knowledge', 'vocabulary.yaml'));
    const scope = { workspaceRoot: ws, resourcesRoot: root };
    const p = dist('engine/ontology/service.js').previewPack(scope, { kind: 'shipped', id: 'fibo-lending' }, undefined, { only: ['fibo:Borrower', 'fibo:CreditFacility', 'fibo:Payment', 'fibo:Collateral', 'fibo:Guaranty'] });
    const w = dist('engine/ontology/decision.js').applyOntologyPayload({ id: p.pack.id, content: p.text }, scope, { by: 'eval', at: '2026-11-03T00:00:00.000Z' });
    if (w.errors.length) throw new Error(w.errors.join(' '));
  } else {
    for (const f of ['shop.ddl', 'crm.ddl']) await run(['estate', 'ingest', ref('retail-orders', 'sources', f), '--workspace', ws, '--system', f.split('.')[0]], io);
    fs.copyFileSync(ref('retail-orders', 'documents', 'business-context.yaml'), path.join(ws, '.autode', 'knowledge', 'business-context.yaml'));
    fs.copyFileSync(ref('retail-orders', 'documents', 'vocabulary.yaml'), path.join(ws, '.autode', 'knowledge', 'vocabulary.yaml'));
  }
  return ws;
}

/** Both fixtures' recall, names only and through meaning. */
async function measureMappingRecall({ root, dist, tmp }) {
  const path = require('node:path');
  const { EngineWorkspace } = dist('mcp/workspace.js');
  const tool = dist('mcp/agentTools.js').agentTools(() => 'eval').find((t) => t.name === 'autode_match_columns').handler;
  const out = {};
  for (const [kind, golden] of [['lending', ['lending', 'golden-mappings.yaml']], ['retail', ['retail-orders', 'golden', 'mappings.yaml']]]) {
    const ws = await fixtureWorkspace(kind, { root, dist, tmp });
    out[kind] = await mappingRecall({ ws: new EngineWorkspace({ workspaceRoot: ws, resourcesRoot: root }), goldenFile: path.join(root, 'test', 'reference', ...golden), tool });
  }
  return out;
}

module.exports = { mappingRecall, fixtureWorkspace, measureMappingRecall };
