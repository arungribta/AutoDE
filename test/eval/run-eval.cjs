'use strict';
/**
 * AutoDE evaluation harness (v0.27.0 — docs/context-layer-requirements.md §10, Phase C1).
 *
 *   npm run eval                                  offline: no LLM, deterministic, runs anywhere
 *   npm run eval -- --mode replay --provider openai   answer LLM calls from a recorded cassette
 *   npm run eval -- --mode record --provider openai   call the real provider, record a cassette
 *                                                 (needs AUTODE_EVAL_API_KEY; AUTODE_EVAL_MODEL optional)
 *   --out <file>   report path (default: test/reference/retail-orders/eval-report.md)
 *   --sut <name>   system under test: `packs` (default, C3 v0.30.0), `ledger` (C2 v0.29.0) or `baseline` (v0.26.0)
 *
 * Measures how grounded AutoDE is on the reference problem in test/reference/retail-orders and
 * writes a Markdown report plus eval-results.json. It measures; it does not pass/fail — the
 * release gate on these numbers arrives with Phase C6.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVscodeHost, installVscodeHost } = require('./lib/vscodeHost.cjs');
const { LlmRouter } = require('./lib/llmRouter.cjs');
const { generateLargeEstate } = require('./lib/largeEstate.cjs');

const ROOT = path.join(__dirname, '..', '..');
const REF = path.join(ROOT, 'test', 'reference', 'retail-orders');
const SUTS = {
  baseline: () => require('./sut/baseline.cjs').createBaselineSut,
  ledger: () => require('./sut/ledger.cjs').createLedgerSut,
  packs: () => require('./sut/packs.cjs').createPacksSut
};
const UNKNOWN_RE = /\b(not (known|specified|provided|available|defined|stated|mentioned)|unknown|no information|don'?t know|do not know|cannot determine|can't determine|isn'?t (specified|defined|stated)|not in the context)\b/i;

function parseArgs(argv) {
  const args = { mode: 'offline', provider: 'openai', sut: 'packs', out: path.join(REF, 'eval-report.md') };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') args.mode = argv[++i];
    else if (a === '--provider') args.provider = argv[++i];
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--sut') args.sut = argv[++i];
  }
  if (!SUTS[args.sut]) throw new Error(`Unknown --sut "${args.sut}" (expected: ${Object.keys(SUTS).join(', ')}).`);
  if (!['offline', 'replay', 'record'].includes(args.mode)) throw new Error(`Unknown --mode "${args.mode}".`);
  return args;
}

function pct(n, d) {
  return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`;
}

/** schema.table names declared in a DDL file — the ground truth for ingestion fidelity. */
function declaredTables(ddl) {
  return [...ddl.matchAll(/CREATE\s+TABLE\s+([\w.]+)/gi)].map((m) => m[1].toLowerCase());
}

/** schema.table names in a Teradata DBC.ColumnsV-style CSV export. */
function dictionaryTables(csv) {
  const rows = csv.trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
  return [...new Set(rows.map((r) => `${r[0]}.${r[1]}`.toLowerCase()))];
}

async function main() {
  const args = parseArgs(process.argv);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-eval-'));
  const restore = installVscodeHost(createVscodeHost({ workspaceDir: path.join(scratch, 'main') }));
  const dist = (rel) => require(path.join(ROOT, 'dist', rel));
  try {
    const { parseYaml } = dist('engine/context/Yaml.js');
    const { buildSchemaIndex, checkSqlGrounding } = dist('engine/grounding/sqlGrounding.js');
    const { estimateTokens } = dist('core/tokenBudget.js');
    const createSut = SUTS[args.sut]();
    const load = (f) => parseYaml(fs.readFileSync(path.join(REF, f), 'utf8'));

    const chatScript = load('chat-script.yaml');
    const questions = load('questions.yaml').questions;
    const plan = load('plan.yaml');
    const target = load('target.yaml');
    const expected = load('expected-artifacts.yaml').checks;

    const router = new LlmRouter({ mode: args.mode, provider: args.provider, cassetteDir: path.join(REF, 'cassettes') });
    router.install(dist('core/llmProviders.js'));

    const relevantFiles = ['shop.ddl', 'crm.ddl'];
    const noiseFile = 'hr_legacy.ddl';
    const relevantDeclared = relevantFiles.flatMap((f) => declaredTables(fs.readFileSync(path.join(REF, 'sources', f), 'utf8')));
    const noiseDeclared = declaredTables(fs.readFileSync(path.join(REF, 'sources', noiseFile), 'utf8'));
    const relevantNames = [...new Set(relevantDeclared.map((t) => t.split('.').pop()))];
    const noiseNames = noiseDeclared.map((t) => t.split('.').pop());

    const results = { version: pkg.version, mode: args.mode, provider: args.mode === 'offline' ? null : args.provider, generatedAt: new Date().toISOString() };

    // ── Scenario A: realistic order (relevant sources first, noise last) — the main run ──
    fs.mkdirSync(path.join(scratch, 'main'), { recursive: true });
    const sut = createSut({ provider: args.provider });
    results.sut = sut.name;
    await sut.setup({ workspaceDir: path.join(scratch, 'main'), referenceDir: REF, sourceOrder: [...relevantFiles, noiseFile] });

    // Ingestion fidelity: does every declared source table survive as its own node?
    const graph = sut.schemaGraph();
    const tableNodes = graph.nodes.filter((n) => n.type === 'table');
    const nameCount = {};
    for (const t of relevantDeclared) { const n = t.split('.').pop(); nameCount[n] = (nameCount[n] || 0) + 1; }
    const collisions = Object.entries(nameCount).filter(([, c]) => c > 1).map(([n]) => ({ name: n, sources: relevantDeclared.filter((t) => t.endsWith('.' + n)), nodes: tableNodes.filter((x) => x.label.toLowerCase() === n).map((x) => x.fqn) }));
    const represented = relevantDeclared.length - collisions.reduce((s, c) => s + (c.sources.length - c.nodes.length), 0);
    results.ingestion = { declared: relevantDeclared.length, represented, collisions, graphTables: tableNodes.length, files: sut.ingestion };

    // Context delivery for a plan step (the baseline delivers the same text for every purpose).
    const measureContext = (ctx) => {
      const lower = ctx.toLowerCase();
      const has = (name) => new RegExp(`\\b${name}\\b`).test(lower);
      return {
        tokens: estimateTokens(ctx),
        relevantTablesShown: relevantNames.filter(has).length,
        relevantTablesTotal: relevantNames.length,
        noiseTablesShown: noiseNames.filter(has).length,
        noiseTablesTotal: noiseNames.length,
        columnsShown: /\bcolumns?\b|\(\s*\w+\s+(int|integer|varchar|timestamp)/i.test(ctx)
      };
    };
    // Every plan step's own context (a system without task scoping returns the same text for each).
    const measureSteps = async (s) => {
      const per = [];
      for (const step of plan.steps) per.push(measureContext(await s.contextFor({ purpose: 'step', step })));
      const lowerAll = [];
      for (const step of plan.steps) lowerAll.push((await s.contextFor({ purpose: 'step', step })).toLowerCase());
      const shownAny = (names) => names.filter((n) => lowerAll.some((t) => new RegExp(`\\b${n}\\b`).test(t))).length;
      const tokens = per.map((p) => p.tokens).sort((a, b) => a - b);
      return {
        tokens: tokens[Math.floor(tokens.length / 2)],
        tokensMax: tokens[tokens.length - 1],
        relevantTablesShown: shownAny(relevantNames),
        relevantTablesTotal: relevantNames.length,
        noiseTablesShown: shownAny(noiseNames),
        noiseTablesTotal: noiseNames.length,
        columnsShown: per.some((p) => p.columnsShown),
        perStep: plan.steps.map((st, i) => ({ id: st.id, tokens: per[i].tokens, noise: per[i].noiseTablesShown }))
      };
    };
    results.contextNoiseLast = await measureSteps(sut);

    // ── Scenario B: same inputs, noise schema imported first — order sensitivity of delivery ──
    fs.mkdirSync(path.join(scratch, 'noise-first'), { recursive: true });
    const sutB = createSut({ provider: args.provider });
    await sutB.setup({ workspaceDir: path.join(scratch, 'noise-first'), referenceDir: REF, sourceOrder: [noiseFile, ...relevantFiles] });
    results.contextNoiseFirst = await measureSteps(sutB);

    // ── Scenario E: estate identity (Phase K1) — the same table names in two systems,
    // and in dev and prod of one system, plus a legacy dictionary export ──
    fs.mkdirSync(path.join(scratch, 'estate', '.ai-context', 'context'), { recursive: true });
    // Phase K2: the acquired CRM team's vocabulary, where an engineer would record it.
    fs.copyFileSync(path.join(REF, 'documents', 'vocabulary.yaml'), path.join(scratch, 'estate', '.ai-context', 'context', 'vocabulary.yaml'));
    const sutE = createSut({ provider: args.provider });
    const estateFiles = ['shop.ddl', 'crm.ddl', 'shop_dev.ddl', 'legacy/edw_dbc_columns.csv'];
    await sutE.setup({ workspaceDir: path.join(scratch, 'estate'), referenceDir: REF, sourceOrder: estateFiles,
      identities: { 'shop.ddl': { system: 'shop', environment: 'prod' }, 'crm.ddl': { system: 'crm', environment: 'prod' }, 'shop_dev.ddl': { system: 'shop', environment: 'dev' }, 'legacy/edw_dbc_columns.csv': { system: 'edw', environment: 'prod' } } });
    const estateGraph = sutE.schemaGraph();
    const estateDeclared = estateFiles.reduce((n, f) => n + (f.endsWith('.csv') ? dictionaryTables(fs.readFileSync(path.join(REF, 'sources', f), 'utf8')).length : declaredTables(fs.readFileSync(path.join(REF, 'sources', f), 'utf8')).length), 0);
    const estateTables = estateGraph.nodes.filter((n) => n.type === 'table');
    results.estate = {
      declared: estateDeclared,
      distinct: new Set(estateTables.map((n) => n.id)).size,
      systems: [...new Set(estateTables.map((n) => `${n.origin && n.origin.system}/${n.origin && n.origin.systemEnvironment}`))].sort(),
      legacyIds: estateGraph.nodes.filter((n) => !/^(obj|term|rule|query|metric|rel):/.test(n.id)).length
    };

    // ── Scenario V: vocabulary mismatch (Phase K2) — does each question's pack seed the table it
    // means, and which deterministic signal finds it (names → + comments → + abbreviations →
    // + synonyms, the customer's vocabulary file and glossary aliases)? ──
    const cfmE = sutE.internals ? sutE.internals().cfm : undefined;
    if (cfmE && cfmE.getCatalog && cfmE.getCatalog().size > 0) {
      const { resolveText } = dist('engine/context/retrieval.js');
      const { selectSeedHits } = dist('engine/context/catalog.js');
      const cat = cfmE.getCatalog();
      const levels = [
        ['names only', { comments: false, abbreviations: false, synonyms: false, glossary: false }],
        ['+ comments', { abbreviations: false, synonyms: false, glossary: false }],
        ['+ abbreviations', { synonyms: false, glossary: false }],
        ['+ synonyms, vocabulary file, glossary', {}]
      ];
      const seedsAt = (q, signals) => new Set([...resolveText(q, estateGraph).map((m) => m.nodeId), ...selectSeedHits(cat.search(q, { signals })).map((h) => h.id)]);
      results.vocabulary = {
        levels: levels.map(([n]) => n),
        questions: load('vocabulary-questions.yaml').questions.map((q) => {
          const seeds = new Set(cfmE.buildContextPack({ purpose: 'qa', query: q.question }).manifest.seeds);
          return { id: q.id, kind: q.kind, question: q.question, found: q.expect.some((e) => seeds.has(e)), byLevel: levels.map(([, sig]) => { const s = seedsAt(q.question, sig); return q.expect.some((e) => s.has(e)); }) };
        })
      };
    }

    // ── Scenario L: the large estate (Phase K2) — scale, responsiveness, scoping ──
    results.large = await measureLargeEstate(dist, scratch);

    // ── The engineer's conversation ──
    results.chat = [];
    for (const turn of chatScript.turns) {
      const r = await sut.chat(turn.text);
      results.chat.push({ id: turn.id, ok: !!r.reply, error: r.error });
    }

    // ── Answerability: can the context layer alone answer each question? ──
    results.answerability = [];
    for (const q of questions.filter((x) => !x.unknown)) {
      const lowerCtx = (await sut.contextFor({ purpose: 'qa', question: q.question })).toLowerCase();
      const missing = (q.evidence || []).filter((e) => !lowerCtx.includes(String(e).toLowerCase()));
      results.answerability.push({ id: q.id, answerable: missing.length === 0, missing });
    }

    // ── QA accuracy (needs answers from a model: replay or record) ──
    results.qa = [];
    if (args.mode !== 'offline') {
      for (const q of questions) {
        const r = await sut.chat(q.question);
        if (!r.reply) { results.qa.push({ id: q.id, scored: false, error: r.error }); continue; }
        const reply = r.reply.toLowerCase();
        const admitsUnknown = UNKNOWN_RE.test(r.reply);
        const correct = q.unknown ? admitsUnknown : (q.mustInclude || []).every((t) => reply.includes(String(t).toLowerCase()));
        results.qa.push({ id: q.id, scored: true, correct, confidentWrong: !correct && !admitsUnknown });
      }
    }

    // ── Plan execution → artifacts → grounding ──
    const run = await sut.runPlan(plan, target);
    // Score each artifact once; duplicates in the plan state are reported as a finding.
    const seen = new Set();
    const artifacts = run.artifacts.filter((a) => {
      const k = `${a.title}|${a.filePath}|${a.content}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    results.artifactDuplicates = run.artifacts.length - artifacts.length;
    results.steps = run.steps.map((s) => ({ id: s.id, agent: s.assignedAgent, status: s.status }));
    results.artifacts = artifacts.map((a) => ({ title: a.title, path: a.filePath, type: a.type, language: a.language, generatedBy: a.generatedBy }));
    const index = buildSchemaIndex(graph.nodes, graph.edges);
    const sqlArtifacts = artifacts.filter((a) => a.language === 'sql').map((a) => ({ name: a.filePath || a.title, content: a.content }));
    const g = checkSqlGrounding(sqlArtifacts, index);
    results.grounding = { ...g, sqlArtifacts: sqlArtifacts.length };
    results.planContextTokens = estimateTokens(run.schemaContext);
    const manifests = (run.manifests || []).filter((m) => m.agent);
    results.manifests = {
      artifacts: manifests.length,
      decisions: manifests.reduce((n, m) => n + m.grounding.decisions.total, 0),
      decisionsBacked: manifests.reduce((n, m) => n + m.decisions.filter((d) => d.backedBy && !d.belowTrust).length, 0),
      gaps: manifests.reduce((n, m) => n + m.gaps.length, 0),
      withCatalogRevisions: manifests.filter((m) => m.catalogRevisions && Object.keys(m.catalogRevisions).length > 0).length,
      written: run.manifestFiles ?? null,
      staleUse: run.staleUse ?? null
    };

    // A property that only appears in a comment (e.g. the task description echoed into a
    // header) doesn't hold — checks run on code with comments removed.
    const code = (a) => a.content
      .replace(/\{#[\s\S]*?#\}/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ')
      .replace(/^\s*#[^\n]*/gm, ' ');
    const nonDoc = artifacts.filter((a) => a.language !== 'markdown').map((a) => ({ name: a.filePath || a.title, text: code(a) }));
    results.expected = expected.map((c) => {
      let pass;
      let matchedIn = [];
      if (c.mustNotMatch) {
        matchedIn = nonDoc.filter((a) => c.mustNotMatch.some((p) => new RegExp(p, 'i').test(a.text))).map((a) => a.name);
        pass = matchedIn.length === 0;
      } else {
        matchedIn = nonDoc.filter((a) => c.mustMatch.every((p) => new RegExp(p, 'i').test(a.text))).map((a) => a.name);
        pass = matchedIn.length > 0;
      }
      return { id: c.id, description: c.description, pass, matchedIn };
    });

    // ── Traps ──
    const cap = sut.capabilities || {};
    results.notes = sut.notes || [];
    results.conflicts = cap.conflicts ? await cap.conflicts() : null;
    results.ledger = sut.ledgerSummary ? sut.ledgerSummary() : null;
    results.contextGaps = cap.contextGaps ? await cap.contextGaps() : null;
    const ticketGap = (results.contextGaps || []).find((g) => g.needed === 'relationship' && g.subject.some((x) => /support_tickets/.test(x)) && g.subject.some((x) => /orders$/.test(x)));
    const revenueConflict = (results.conflicts || []).find((c) => /revenue/i.test(c.key) || c.sides.some((x) => /revenue/i.test(x)));
    const e7 = results.expected.find((e) => e.id === 'E7');
    const noiseFree = results.contextNoiseLast.noiseTablesShown === 0 && results.contextNoiseFirst.noiseTablesShown === 0;
    results.traps = [
      { id: 1, name: 'Revenue defined two ways (glossary gross vs chat net)', detected: !!revenueConflict, how: cap.conflicts ? (revenueConflict ? `conflict detector (${revenueConflict.rule} rule)` : 'conflict detector ran; no revenue conflict found') : 'not supported: no conflict detection' },
      { id: 2, name: 'Customer key corrected mid-chat (customer_id → cust_no)', detected: !!(cap.superseded && (await cap.superseded()).length), how: cap.superseded ? 'supersession' : ((sut.trapNotes || {})[2] || 'not supported: chat facts are not recorded, so nothing can be superseded') },
      { id: 3, name: 'Claimed-unique member_id has duplicates', detected: !!(cap.verify && (await cap.verify({ table: 'crm.loyalty_members', column: 'member_id', predicate: 'unique' }))?.result === 'fail'), how: cap.verify ? 'verification probe' : 'not supported: no verification probes' },
      { id: 4, name: 'Ticket-to-order join requested with no relationship', detected: !!ticketGap, how: cap.contextGaps ? (ticketGap ? `context gap (${ticketGap.reason}): ${ticketGap.text}` : 'context gaps supported; none raised for tickets ↔ orders') : `not supported: no context gaps (artifacts ${e7 && e7.pass ? 'did not' : 'did'} invent the join)` },
      { id: 5, name: 'Irrelevant 40-table schema ingested', detected: noiseFree, how: `noise tables in step context: ${results.contextNoiseLast.noiseTablesShown} (noise last), ${results.contextNoiseFirst.noiseTablesShown} (noise first)` }
    ];
    results.llm = router.stats;

    // ── Report ──
    fs.writeFileSync(path.join(path.dirname(args.out), 'eval-results.json'), JSON.stringify(results, null, 2));
    fs.writeFileSync(args.out, renderReport(results));
    console.log(`Eval report written to ${path.relative(ROOT, args.out)}`);
    printSummary(results);
  } finally {
    restore();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Phase K2 acceptance on a generated estate (~2 000 tables, ~50 000 columns, four systems):
 * ingest time, memory, ledger sync, pack build time, the longest synchronous task, whether packs
 * stay scoped, and recall on questions phrased in other words. Runs the extension's own
 * ContextFileManager — the same code path as "Import File…".
 */
async function measureLargeEstate(dist, scratch) {
  const v8 = require('node:v8');
  const vm = require('node:vm');
  const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const { GraphManager } = dist('context/GraphManager.js');
  const { ContextFileManager } = dist('context/ContextFileManager.js');
  const { parseFile } = dist('engine/context/fileIngestion.js');
  const dir = path.join(scratch, 'large');
  fs.mkdirSync(path.join(dir, '.ai-context'), { recursive: true });
  const estate = generateLargeEstate();
  gc();
  const heap0 = process.memoryUsage().heapUsed;
  const graph = new GraphManager();
  const cfm = new ContextFileManager({ fsPath: dir }, graph, () => {});
  await cfm.initialize();
  // Longest synchronous task: event-loop delay while a stage runs (10 ms resolution), plus the
  // directly timed synchronous calls (each file parse, each pack build).
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const stages = {};
  const stage = async (name, fn) => {
    h.reset();
    const t0 = performance.now();
    await fn();
    stages[name] = { ms: Math.round(performance.now() - t0), maxBlockMs: Math.round(h.max / 1e6) };
  };
  let parseMaxMs = 0;
  await stage('ingest', async () => {
    for (const f of estate.files) {
      const t = performance.now();
      const parsed = parseFile(f.ddl, path.join(dir, f.name), { system: f.system, environment: f.environment });
      parseMaxMs = Math.max(parseMaxMs, performance.now() - t);
      await cfm.ingestParsed(parsed.nodes, parsed.edges);
    }
  });
  gc();
  const heapMB = Math.round((process.memoryUsage().heapUsed - heap0) / 1e6);
  const cat = cfm.getCatalog();
  const schemaOf = (id) => { const [sys, , fqn] = id.slice(4).split('/'); return `${sys}/${fqn.split('.').slice(-2)[0]}`; };
  const allSchemas = new Set(cat.all().map((e) => schemaOf(e.id)));
  const packs = [];
  await stage('packs', async () => {
    for (const n of estate.needles) {
      const t = performance.now();
      const p = cfm.buildContextPack({ purpose: 'qa', query: n.question });
      const ms = performance.now() - t;
      const tables = p.manifest.nodeIds.filter((id) => cat.has(id));
      packs.push({ id: n.id, kind: n.kind, question: n.question, ms: Math.round(ms * 10) / 10, found: p.manifest.seeds.includes(n.expect), tables: tables.length, schemas: new Set(tables.map(schemaOf)).size, tokens: p.manifest.tokenCount });
    }
  });
  await stage('promotion sync', () => cfm.whenIdle());
  const workingSet = graph.getNodesByType('table').length;
  await stage('reload', async () => {
    const c2 = new ContextFileManager({ fsPath: dir }, new GraphManager(), () => {});
    await c2.initialize();
  });
  h.disable();
  const bytes = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? bytes(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0) : 0;
  const packMaxMs = Math.max(...packs.map((p) => p.ms));
  return {
    tables: estate.tables,
    columns: estate.columns,
    systems: estate.files.length,
    schemas: allSchemas.size,
    catalogued: cat.size,
    workingSet,
    heapMB,
    stages,
    parseMaxMs: Math.round(parseMaxMs),
    packMaxMs,
    longestSyncMs: Math.max(parseMaxMs, packMaxMs, ...Object.values(stages).map((s) => s.maxBlockMs)),
    catalogKB: Math.round(bytes(path.join(dir, '.ai-context', 'catalog')) / 1024),
    ledgerKB: Math.round(bytes(path.join(dir, '.ai-context', 'ledger')) / 1024),
    packs
  };
}

function summaryRows(r) {
  const g = r.grounding;
  const idTotal = g.tablesChecked + g.columnsChecked;
  const idResolved = g.tablesResolved + g.columnsResolved;
  const ans = r.answerability.filter((a) => a.answerable).length;
  const qaScored = r.qa.filter((q) => q.scored);
  const qaCorrect = qaScored.filter((q) => q.correct).length;
  const trapsCaught = r.traps.filter((t) => t.detected).length;
  const expPass = r.expected.filter((e) => e.pass).length;
  return [
    ['Identifier grounding rate', '100%', `${pct(idResolved, idTotal)} (${idResolved}/${idTotal})`],
    ['Unresolved identifiers', '0', String(g.unresolved.length)],
    ['Type-compatibility issues', '0', String(g.typeIssues.length)],
    ['Decision backing rate', '≥ 95%', !r.manifests || r.manifests.artifacts === 0 ? 'n/a — no grounding manifests (before C3)' : (r.manifests.decisions ? `${pct(r.manifests.decisionsBacked, r.manifests.decisions)} (${r.manifests.decisionsBacked}/${r.manifests.decisions})` : `n/a — no primitive decisions in this run (${r.manifests.artifacts} manifests)`)],
    ['Answerability from the context layer', 'reported', `${pct(ans, r.answerability.length)} (${ans}/${r.answerability.length})`],
    ['QA accuracy', '≥ 90%', qaScored.length ? `${pct(qaCorrect, qaScored.length)} (${qaCorrect}/${qaScored.length})` : 'not measured offline — needs replay or record'],
    ['Confident wrong answers', '0', qaScored.length ? String(qaScored.filter((q) => q.confidentWrong).length) : 'not measured offline'],
    ['Trap detection', '5/5', `${trapsCaught}/5`],
    ['Expected artifact properties', 'all', `${expPass}/${r.expected.length}`],
    ['Source tables kept distinct at ingestion', 'all', `${r.ingestion.represented}/${r.ingestion.declared}`],
    ['Tables kept distinct across systems and environments', 'all', r.estate ? `${r.estate.distinct}/${r.estate.declared}` : 'n/a'],
    ['Stale-fact use', '0', r.manifests && r.manifests.staleUse !== null ? String(r.manifests.staleUse) : 'n/a — needs grounding manifests (C3)'],
    ['Vocabulary-mismatch seed recall', 'reported', r.vocabulary ? `${r.vocabulary.questions.filter((q) => q.found).length}/${r.vocabulary.questions.length} (paraphrases: ${r.vocabulary.questions.filter((q) => q.kind === 'paraphrase' && q.found).length}/${r.vocabulary.questions.filter((q) => q.kind === 'paraphrase').length})` : 'n/a — no catalog (before K2)'],
    ['Large-estate seed recall', 'reported', r.large ? `${r.large.packs.filter((p) => p.found).length}/${r.large.packs.length}` : 'n/a'],
    ['Longest synchronous task, large estate', '≤ 100 ms', r.large ? `${Math.round(r.large.longestSyncMs)} ms` : 'n/a'],
    ['Plan-step context size', 'reported', `${r.contextNoiseLast.tokens} tokens median per step (max ${r.contextNoiseLast.tokensMax})`]
  ];
}

function renderReport(r) {
  const L = [];
  const g = r.grounding;
  L.push(`# AutoDE evaluation report — retail-orders`, '');
  L.push(`- **AutoDE version:** ${r.version}`);
  L.push(`- **System under test:** ${r.sut}`);
  L.push(`- **Mode:** ${r.mode}${r.provider ? ` (provider: ${r.provider})` : ' (no LLM — deterministic fallbacks only)'}`);
  L.push(`- **Generated:** ${r.generatedAt}`, '');
  L.push('Targets are from `docs/context-layer-requirements.md` §10.2. This report measures; the release gate on these numbers arrives with Phase C6.', '');
  L.push('## Summary', '', '| Metric | Target | Result |', '|---|---|---|');
  for (const [m, t, v] of summaryRows(r)) L.push(`| ${m} | ${t} | ${v} |`);

  L.push('', '## Traps', '', '| # | Trap | Detected | How |', '|---|---|---|---|');
  for (const t of r.traps) L.push(`| ${t.id} | ${t.name} | ${t.detected ? 'yes' : 'no'} | ${t.how} |`);

  if (r.ledger) {
    const l = r.ledger;
    L.push('', '## Context ledger', '');
    L.push(`${l.assertions} assertions from ${l.events} ledger events: ${l.active} active, ${l.proposed} proposed, ${l.needsReview} needs review. By trust: ${l.byTrust.map(([t, n]) => `${t} ${n}`).join(', ')}.`);
    if (l.unresolvedProposals.length) L.push('', `Proposed facts with a subject that does not resolve to a graph node (kept as given and flagged \`unresolved_subject\`): ${l.unresolvedProposals.map((p) => `${p.fact} (${p.unresolved.join(', ')})`).join('; ')}.`);
  }
  if (r.conflicts) {
    L.push('', '## Conflicts detected', '');
    if (!r.conflicts.length) L.push('None.');
    for (const c of r.conflicts) L.push(`- **${c.rule}** on ${c.subject.join(', ')}:`, ...c.sides.map((x) => `  - ${x.replace(/\|/g, '\\|')}`));
  }

  L.push('', '## Ingestion', '');
  L.push(`Declared source tables (shop + crm): ${r.ingestion.declared}. Kept as distinct graph nodes: ${r.ingestion.represented}. Graph tables in total, including the noise schema: ${r.ingestion.graphTables}.`);
  if (r.estate) L.push('', `**Estate identity:** ${r.estate.distinct} of ${r.estate.declared} declared tables kept distinct when shop (prod and dev), crm and a legacy EDW dictionary export are ingested together; systems/environments: ${r.estate.systems.join(', ')}; ${r.estate.legacyIds} node(s) with a pre-v0.31.0 id.`, '');
  for (const c of r.ingestion.collisions) {
    if (c.nodes.length < c.sources.length) L.push(`- **Collision:** ${c.sources.join(' and ')} became one node (${c.nodes.join(', ') || 'none'}). Their columns are merged and one source's table metadata is lost.`);
    else L.push(`- Same table name in two sources, kept distinct: ${c.nodes.join(', ')}.`);
  }

  if (r.large) {
    const g = r.large;
    L.push('', '## Large estate (Phase K2)', '');
    L.push(`Generated estate: ${g.systems} systems, ${g.schemas} schemas, ${g.tables} tables, ${g.columns} columns (same names across schemas and systems; a legacy EDW with abbreviated names; an acquired CRM with its own words). Imported the way "Import File…" imports: into the catalog, and into the working set as far as it fits.`, '');
    L.push('| Measure | Result |', '|---|---|');
    L.push(`| Catalogued / in the working set after the questions | ${g.catalogued} / ${g.workingSet} tables |`);
    L.push(`| Ingest time (parse + catalog + ledger) | ${g.stages.ingest.ms} ms |`);
    L.push(`| Extension-host heap growth after ingest | ${g.heapMB} MB |`);
    L.push(`| Pack build, max | ${g.packMaxMs} ms |`);
    L.push(`| Promotion and ledger sync after the questions | ${g.stages['promotion sync'].ms} ms |`);
    L.push(`| Reload (catalog, ledger, projection) | ${g.stages.reload.ms} ms |`);
    L.push(`| Longest synchronous task (parse ${g.parseMaxMs} ms; event-loop delay per stage: ${Object.entries(g.stages).map(([k, v]) => `${k} ${v.maxBlockMs}`).join(', ')} ms) | ${Math.round(g.longestSyncMs)} ms |`);
    L.push(`| On disk: catalog / ledger | ${g.catalogKB} KB / ${g.ledgerKB} KB |`);
    L.push('', '| Question | Kind | Seeded | Tables in pack | Schemas in pack (of ' + g.schemas + ') | Build ms |', '|---|---|---|---|---|---|');
    for (const p of g.packs) L.push(`| ${p.id} ${p.question} | ${p.kind} | ${p.found ? 'yes' : 'no'} | ${p.tables} | ${p.schemas} | ${p.ms} |`);
  }
  if (r.vocabulary) {
    const v = r.vocabulary;
    L.push('', '## Vocabulary mismatch (Phase K2)', '', 'Questions that name a table in other words, over the estate fixture (shop, crm, legacy EDW export) with the acquired team\'s vocabulary file. "Seeded" is the system as shipped; the columns to the right switch the deterministic signals on one at a time.', '');
    L.push(`| Question | Kind | Seeded | ${v.levels.join(' | ')} |`, `|---|---|---|${v.levels.map(() => '---').join('|')}|`);
    for (const q of v.questions) L.push(`| ${q.id} ${q.question} | ${q.kind} | ${q.found ? 'yes' : 'no'} | ${q.byLevel.map((b) => (b ? 'yes' : 'no')).join(' | ')} |`);
    L.push(`| **Total** | | **${v.questions.filter((q) => q.found).length}/${v.questions.length}** | ${v.levels.map((_, i) => `${v.questions.filter((q) => q.byLevel[i]).length}/${v.questions.length}`).join(' | ')} |`);
  }

  L.push('', '## Context delivery', '', '| | Noise imported last | Noise imported first |', '|---|---|---|');
  const a = r.contextNoiseLast, b = r.contextNoiseFirst;
  L.push(`| Tokens (median per step) | ${a.tokens} | ${b.tokens} |`);
  L.push(`| Relevant tables named | ${a.relevantTablesShown}/${a.relevantTablesTotal} | ${b.relevantTablesShown}/${b.relevantTablesTotal} |`);
  L.push(`| Noise tables named | ${a.noiseTablesShown}/${a.noiseTablesTotal} | ${b.noiseTablesShown}/${b.noiseTablesTotal} |`);
  L.push(`| Column details included | ${a.columnsShown ? 'yes' : 'no'} | ${b.columnsShown ? 'yes' : 'no'} |`);
  L.push('', r.sut.startsWith('baseline') || r.sut.startsWith('assertion ledger')
    ? 'The same text is delivered for every purpose (interview, plan, each step, chat): there is no task-specific retrieval yet.'
    : `Each plan step gets its own context pack. Counts are over all ${a.perStep.length} steps (a table counts if any step's pack names it). Per step (noise last): ${a.perStep.map((p) => `${p.id} ${p.tokens} tokens${p.noise ? `, ${p.noise} noise` : ''}`).join('; ')}.`);
  if (r.contextGaps) {
    L.push('', '## Context gaps', '');
    if (!r.contextGaps.length) L.push('None.');
    for (const g of r.contextGaps) L.push(`- **${g.needed}** (${g.reason}${g.foundTrust ? `, found ${g.foundTrust}` : ''}, needs ${g.minTrust})${g.stepId ? ` in step ${g.stepId}` : ' in chat'}: ${g.text}`);
  }
  if (r.manifests && r.manifests.artifacts) {
    L.push('', '## Grounding manifests', '', `${r.manifests.artifacts} artifacts carry a manifest${r.manifests.written !== null ? ` (${r.manifests.written} \`.grounding.json\` files written)` : ''}. Primitive decisions: ${r.manifests.decisions} (${r.manifests.decisionsBacked} backed at the required trust). Gaps recorded in manifests: ${r.manifests.gaps}.${r.manifests.withCatalogRevisions !== undefined ? ` Manifests pinning catalog revisions: ${r.manifests.withCatalogRevisions}.` : ''}`);
  }

  const replied = r.chat.filter((c) => c.ok).length;
  L.push('', '## Conversation', '', `${r.chat.length} scripted engineer turns sent; ${replied} got a reply${replied === r.chat.length ? '' : ` (${r.chat.length - replied} failed${r.mode === 'offline' ? ' — expected offline, no LLM' : ''})`}. Whether anything said in them reached the context layer is what the answerability table below shows.`);
  L.push('', '## Answerability', '', 'Whether the evidence each question needs is present in the context AutoDE delivers after the scripted conversation (chat history excluded — the question is what the context layer retained).', '');
  L.push('| Question | Answerable | Missing evidence |', '|---|---|---|');
  for (const q of r.answerability) L.push(`| ${q.id} | ${q.answerable ? 'yes' : 'no'} | ${q.missing.join(', ')} |`);

  if (r.qa.length) {
    L.push('', '## QA accuracy', '', '| Question | Correct | Confident wrong |', '|---|---|---|');
    for (const q of r.qa) L.push(`| ${q.id} | ${q.scored ? (q.correct ? 'yes' : 'no') : `not scored (${q.error})`} | ${q.scored && q.confidentWrong ? 'yes' : ''} |`);
  }

  L.push('', '## Generated artifacts', '');
  L.push('| Step | Agent | Status |', '|---|---|---|');
  for (const s of r.steps) L.push(`| ${s.id} | ${s.agent} | ${s.status} |`);
  L.push('', `${r.artifacts.length} distinct artifacts, ${g.sqlArtifacts} of them SQL.${r.artifactDuplicates ? ` **Finding:** the plan state held ${r.artifactDuplicates} duplicate entries — agents both call \`context.addArtifact()\` and return the same artifact, and \`executePlan()\` keeps both. Scored once each here.` : ''}`, '');
  L.push(`**Grounding:** ${g.tablesResolved}/${g.tablesChecked} table references and ${g.columnsResolved}/${g.columnsChecked} qualified column references resolve to the ingested schema.${g.ambiguous.length ? ` Ambiguous by name: ${[...new Set(g.ambiguous)].join(', ')}.` : ''}`);
  if (g.unresolved.length) {
    L.push('', '| Unresolved | Kind | Artifact |', '|---|---|---|');
    for (const u of g.unresolved.slice(0, 30)) L.push(`| \`${u.ref}\` | ${u.kind} | ${u.artifact} |`);
    if (g.unresolved.length > 30) L.push(`| … ${g.unresolved.length - 30} more | | |`);
  }
  if (g.typeIssues.length) {
    L.push('', '**Type issues:**');
    for (const t of g.typeIssues) L.push(`- ${t.kind}: ${t.detail} (${t.artifact})`);
  }
  L.push('', 'Artifact properties (checked on code with comments removed):', '', '| Check | Property | Holds | Where |', '|---|---|---|---|');
  for (const e of r.expected) L.push(`| ${e.id} | ${e.description} | ${e.pass ? 'yes' : 'no'} | ${e.matchedIn.slice(0, 3).join(', ')} |`);

  L.push('', '## LLM calls', '', `Calls: ${r.llm.calls}; replayed: ${r.llm.hits}; cassette misses: ${r.llm.misses}; recorded: ${r.llm.recorded}; refused (offline): ${r.llm.failures}.`);
  L.push('', '## Limits of this measurement', '');
  L.push('- Grounding checks scan SQL with patterns, not a parser: `FROM`/`JOIN` targets and `alias.column` references are checked, unqualified columns are not.');
  L.push('- Offline mode measures AutoDE with its LLM paths disabled, so artifacts come from the template fallbacks. Replay/record runs measure the LLM paths.');
  L.push('- The plan is the fixed reference plan in `plan.yaml`, so planning quality itself is not scored here.');
  L.push('- Ablation: run with `--sut ledger` (the global dump, same ledger) or `--sut baseline` to compare against context packs on identical inputs.');
  for (const n of r.notes || []) L.push(`- ${n}`);
  return L.join('\n') + '\n';
}

function printSummary(r) {
  for (const [m, , v] of summaryRows(r)) console.log(`  ${m.padEnd(42)} ${v}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
