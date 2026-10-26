#!/usr/bin/env node
'use strict';
/**
 * The manual-verification kit (docs/manual-verification.md, Part 0 and Parts 36 on):
 *   npm run manual:kit -- [--out <folder>] [--force]
 *
 * 1. Builds a ready workspace from the reference problem (retail orders): the sources, the pack's
 *    documents, a connection template, and the AutoDE plugin installed for Claude Code (with its guard
 *    hook). Default folder: ../autode-manual-test next to the repo. An existing folder is only replaced
 *    when it is a kit folder (it has `.autode-manual-kit`) and --force is given.
 * 2. Runs every step of the checks that needs no person, no VS Code and no live platform, in a throwaway
 *    copy, so the workspace stays as you start from.
 * 3. Writes MANUAL-KIT.md in the workspace: per check, pre-checked (pass/fail, with what was seen) or
 *    what you do, and which live platforms this machine can reach.
 * Needs `npm run compile` first. Makes no network call and calls no model.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const REF = path.join(ROOT, 'test', 'reference', 'retail-orders');
const DIST = (m) => require(path.join(ROOT, 'dist', m));
const MARKER = '.autode-manual-kit';

function args(argv) {
  const a = { out: path.resolve(ROOT, '..', 'autode-manual-test'), force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') a.out = path.resolve(argv[++i]);
    else if (argv[i] === '--force') a.force = true;
    else if (argv[i] === '--help' || argv[i] === '-h') { console.log('npm run manual:kit -- [--out <folder>] [--force]'); process.exit(0); }
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  return a;
}

function onPath(name) {
  const win = process.platform === 'win32';
  const exts = win ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const d of (process.env.PATH || '').split(win ? ';' : ':').filter(Boolean)) {
    for (const e of exts) { try { if (fs.statSync(path.join(d, name + e)).isFile()) return path.join(d, name + e); } catch { /* next */ } }
  }
  return undefined;
}

/** Claude Code: its CLI on PATH, or its VS Code extension (which reads the same .claude/ settings, .mcp.json and hooks). */
function claudeCode() {
  const cliPath = onPath('claude');
  if (cliPath) return cliPath;
  try {
    const dir = path.join(os.homedir(), '.vscode', 'extensions');
    const ext = fs.readdirSync(dir).filter((d) => /^anthropic\.claude-code-/.test(d)).sort().pop();
    return ext ? `VS Code extension ${ext}` : undefined;
  } catch { return undefined; }
}

function copy(from, to) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }

/** The workspace a person starts from. */
function buildWorkspace(dir) {
  for (const f of ['shop.ddl', 'crm.ddl', 'hr_legacy.ddl']) copy(path.join(REF, 'sources', f), path.join(dir, 'sources', f));
  for (const f of fs.readdirSync(path.join(REF, 'sources', 'samples'))) copy(path.join(REF, 'sources', 'samples', f), path.join(dir, 'sources', 'samples', f));
  // Pack documents: free text (BRD, glossary) and a house-format contract with no profile yet (Part 38.3).
  for (const f of ['brd.md', 'glossary.md', 'customer-contract.v1.yaml']) copy(path.join(REF, 'documents', 'pack', f), path.join(dir, 'documents', f));
  copy(path.join(REF, 'documents', 'business-context.yaml'), path.join(dir, '.autode', 'knowledge', 'business-context.yaml'));
  fs.writeFileSync(path.join(dir, '.autode', 'config', 'connections.example.yaml'), [
    '# Named connections for the live checks (36.2, 36.3, 39.2). Copy to connections.yaml and fill in.',
    '# No secrets here: credentials come from the platform CLI\'s own configuration (resolver cli).',
    'connections:',
    '  - platform: snowflake',
    '    role: source',
    '    credentials: { resolver: cli, ref: <your snow connection name> }',
    '    fields: { warehouse: <warehouse> }',
    '  - platform: databricks',
    '    role: target',
    '    credentials: { resolver: cli, ref: <your databricks profile> }',
    '    fields: { workspaceUrl: https://<workspace>.azuredatabricks.net }',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(dir, MARKER), `Made by npm run manual:kit (${new Date().toISOString()}). Safe to delete.\n`);
}

/** The autode CLI in-process, with a person at the terminal who answers prompts (the way the tests drive it). */
async function cli(argv, answers = []) {
  const { run } = DIST('cli/main.js');
  const out = []; const err = [];
  const io = { out: (t) => out.push(t), err: (t) => err.push(t), env: process.env, cwd: process.cwd(), interactive: true, prompt: async () => answers.shift() || '', readStdin: async () => '' };
  const code = await run(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function guard(event, cwd) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'dist', 'autode.js'), 'hook', 'guard'], { input: JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command: event } }), encoding: 'utf8', timeout: 30000 });
  return { code: r.status, err: (r.stderr || '').trim() };
}

async function preChecks(kitDir) {
  const results = [];
  const check = async (id, what, fn) => {
    try { const r = await fn(); results.push({ id, what, ok: r.ok, seen: r.seen }); }
    catch (e) { results.push({ id, what, ok: false, seen: `error: ${e.message}` }); }
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-kit-'));
  fs.cpSync(kitDir, tmp, { recursive: true });
  const W = ['--workspace', tmp];
  try {
    // A problem with an approved specification and a modernization workflow, as the checks start from.
    const started = await cli(['problems', 'new', 'Daily revenue from the shop orders, by channel, in the marts', ...W, '--json']);
    const id = JSON.parse(started.out).id;
    const prob = path.join(tmp, '.autode', 'problems', id);
    const spec = path.join(prob, 'spec', 'business-problem.yaml');
    fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8').replace('status: draft', 'status: approved').replace('problemStatementApproved: false', 'problemStatementApproved: true'));
    await cli(['workflow', 'plan', '--template', 'modernization', ...W]);
    await cli(['workflow', 'approve', ...W, '--by', 'kit'], ['approve']);

    await check('36.1', 'Platform skills per stage (Snowflake with dbt, then Databricks)', async () => {
      const A = DIST('engine/agents/assignment.js');
      const scope = { workspaceRoot: tmp, resourcesRoot: ROOT, problemId: id, home: tmp };
      // Environment and security (platform-setup) is optional in every template: include it, as the person would.
      const I = DIST('engine/workflows/instance.js');
      const w = I.readWorkflow(prob);
      for (const st of w.stages) if (st.kind === 'platform-setup') { st.included = true; st.reason = undefined; }
      I.writeWorkflow(prob, w);
      const ctxFile = path.join(prob, 'context', 'target-context.yaml');
      fs.mkdirSync(path.dirname(ctxFile), { recursive: true });
      const line = (stage) => { const a = A.assignmentFor(scope, stage, []).assignment; return a ? `${stage} → ${a.role}: ${a.skills.map((k) => k.id).join(', ')}` : `${stage} → none`; };
      fs.writeFileSync(ctxFile, 'specId: x\nspecVersion: 1\nstatus: built\nplatform: snowflake\ntransformationTool: dbt\n');
      const sf = ['platform-setup', 'build', 'deploy', 'reconcile'].map(line);
      fs.writeFileSync(ctxFile, 'specId: x\nspecVersion: 1\nstatus: built\nplatform: databricks\n');
      const dbx = ['platform-setup', 'build', 'deploy'].map(line);
      const ok = sf[0].includes('target-architect') && sf[1].includes('autode-dbt-project') && sf[2].includes('autode-snowflake-deployment') && sf[3].includes('source-assessor')
        && !dbx.join().includes('snowflake') && !dbx[1].includes('dbt');
      return { ok, seen: [...sf, ...dbx].join('; ') };
    });
    await check('36.4', 'Runbook checks: the other platform\'s SQL warned, VACUUM needs a reason', async () => {
      const RB = DIST('engine/runner/runbook.js');
      const conns = [{ id: 'snowflake:dev', platform: 'snowflake', role: 'target', fields: {}, credentials: { resolver: 'cli', ref: 'dev' }, allowSampleDataInPrompts: false, origin: 'team' }, { id: 'databricks:dev', platform: 'databricks', role: 'target', fields: {}, credentials: { resolver: 'cli', ref: 'dev' }, allowSampleDataInPrompts: false, origin: 'team' }];
      const policy = DIST('engine/runner/policy.js').loadRunbookPolicy(tmp);
      const step = (id, sql) => ({ id, title: id, kind: 'sql', sql, expect: 'x' });
      const a = RB.checkRunbook({ id: 'k1', title: 't', reason: 'r', connectionId: 'snowflake:dev', steps: [step('opt', 'OPTIMIZE marts.fct_orders')] }, { workspaceRoot: tmp, connections: conns, policy });
      const b = RB.checkRunbook({ id: 'k2', title: 't', reason: 'r', connectionId: 'databricks:dev', steps: [step('vac', 'VACUUM t RETAIN 168 HOURS')] }, { workspaceRoot: tmp, connections: conns, policy });
      const warned = a.warnings.find((w) => /looks like Databricks SQL/.test(w));
      const refused = b.errors.find((e) => /destructive/.test(e));
      return { ok: !!warned && !b.ok && !!refused, seen: `${warned || 'no warning'} | ${refused || 'not refused'}` };
    });
    await check('36.6', 'Guard hook: in the workspace\'s Claude settings; deploy blocked, listing allowed', async () => {
      const settings = path.join(kitDir, '.claude', 'settings.json');
      const has = fs.existsSync(settings) && / hook guard/.test(fs.readFileSync(settings, 'utf8'));
      const blocked = guard('databricks bundle deploy --target dev', tmp);
      const allowed = guard('databricks catalogs list', tmp);
      return { ok: has && blocked.code === 2 && allowed.code === 0, seen: `settings hook: ${has ? 'yes' : 'no'}; deploy → exit ${blocked.code} (${blocked.err.slice(0, 90)}…); list → exit ${allowed.code}` };
    });
    await check('36.7', 'Copilot CLI install says the guard is a convention there', async () => {
      const r = await cli(['plugin', 'install', '--host', 'copilot', '--scope', 'project', ...W]);
      return { ok: r.code === 0 && /convention/.test(r.out), seen: r.out.split('\n').find((l) => /convention/.test(l)) || r.out.slice(0, 200) };
    });
    await check('36.8 / 37.6', 'Skills catalog: interview parts are AutoDE skills; vendor skills referenced with install state', async () => {
      const r = await cli(['skills', 'list', ...W, '--json']);
      const skills = JSON.parse(r.out).skills;
      const parts = skills.filter((s) => s.group === 'autode' && /^autode-de-interview-/.test(s.name));
      const vendor = skills.find((s) => s.name === 'databricks-pipelines');
      return { ok: parts.length === 6 && !skills.some((s) => s.group === 'interview') && !!vendor, seen: `${parts.length} interview parts as AutoDE skills; databricks-pipelines ${vendor && vendor.installed && vendor.installed.length ? 'installed' : 'not installed here'}` };
    });
    await check('37.3', 'The interview from a terminal: show, then answer an open question', async () => {
      const S = DIST('engine/interview/state.js');
      const { interviewSkills } = DIST('engine/skills/skillRegistry.js');
      const parts = interviewSkills(DIST('engine/agents/definitions.js').loadSkillPack(ROOT).skills);
      const s = S.readInterview(prob) || S.startInterview(prob, 'Daily revenue from the shop orders', parts);
      const r1 = S.recordInterview(s, { questions: [{ field: 'scope', prompt: 'Which channels are in scope?' }] }, { by: 'kit', channel: 'mcp' });
      S.writeInterview(prob, r1.session);
      const shown = await cli(['interview', 'show', ...W]);
      const answered = await cli(['interview', 'answer', r1.asked[0], 'Web and store', ...W]);
      const after = S.readInterview(prob);
      const a = after.answers.find((x) => x.questionId === r1.asked[0]);
      return { ok: /Which channels are in scope\?/.test(shown.out) && answered.code === 0 && a && a.channel === 'cli', seen: `show lists the open question; answer recorded via ${a ? a.channel : 'nothing'}` };
    });
    await check('38.1 / 38.3', 'Pack reading: the BRD gives sections to cite; the house contract asks for a profile', async () => {
      const cfm = await DIST('engine/context/estateIngest.js').openContext(tmp);
      try {
        const { BusinessPackManager } = DIST('engine/context/businessPackManager.js');
        const pm = new BusinessPackManager(path.join(prob, 'pack'), tmp, () => cfm, () => {});
        await pm.load();
        await pm.addDocument({ path: path.join(tmp, 'documents', 'brd.md'), role: 'brd', authority: 'draft', version: '1' });
        await pm.addDocument({ path: path.join(tmp, 'documents', 'customer-contract.v1.yaml'), role: 'contract', authority: 'signed', version: '1' });
        const brd = pm.readingFor('brd');
        const contract = pm.readingFor('customer-contract-v1');
        return { ok: brd.kind === 'facts' && brd.sections.length > 1 && contract.kind === 'profile', seen: `brd: ${brd.kind}, ${brd.sections ? brd.sections.length : 0} sections; contract: ${contract.kind}${contract.reason ? ` (${contract.reason})` : ''}` };
      } finally { cfm.dispose(); }
    });
    await check('39.1', 'The build stage offers Run agent only; mapping keeps Produce', async () => {
      const m = DIST('core/workflowViewModel.js').buildWorkflowModel({ workspaceRoot: tmp, resourcesRoot: ROOT, problemId: id });
      const build = m.stages.find((s) => s.id === 'build');
      const mapping = m.stages.find((s) => s.id === 'mapping');
      return { ok: !build.actions.includes('produce') && mapping.produceLabel === 'Add a mapping…', seen: `build actions: ${build.actions.join(', ') || 'none yet'}; mapping: ${mapping.produceLabel}` };
    });
    await check('MCP', 'The MCP server starts from the plugin\'s command and lists the interview, reading and refresh tools', async () => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'dist', 'autode.js'), 'mcp', '--workspace', tmp], { input: [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kit', version: '1' } } }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })].join('\n') + '\n', encoding: 'utf8', timeout: 30000 });
      const reply = (r.stdout || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }).find((m) => m.id === 2);
      const names = reply && reply.result ? reply.result.tools.map((t) => t.name) : [];
      const want = ['autode_interview_state', 'autode_pack_reading', 'autode_refresh_working_set', 'autode_workflow_draft', 'autode_reconcile_plan'];
      const missing = want.filter((n) => !names.includes(n));
      return { ok: names.length > 0 && missing.length === 0, seen: `${names.length} tools${missing.length ? `; missing ${missing.join(', ')}` : ''}` };
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return results;
}

/** Every check of Parts 36 on, and what it needs. */
const CHECKS = [
  ['36.1', 'auto+you', 'Open each stage\'s assignment in the Workflow view (Run agent), Snowflake with dbt, then Databricks.'],
  ['36.2', 'snowflake', 'Run the Snowflake ingestion runbook on a dev connection (connections.example.yaml → connections.yaml).'],
  ['36.3', 'databricks', 'Deploy the orders bundle to a dev Databricks workspace.'],
  ['36.4', 'auto+you', 'See the warning in the Runbook tab (the engine check is pre-run).'],
  ['36.5', 'snowflake', 'Reconcile after 36.2.'],
  ['36.6', 'auto+claude', 'In Claude Code, ask for a bundle deploy (blocked) and a catalog listing (runs); review the hook in /hooks.'],
  ['36.7', 'auto+cortex', 'Optional: load the plugin folder in Cortex Code and record whether it runs the hook.'],
  ['36.8', 'auto+claude', 'Read an assignment before and after installing the Databricks agent skills.'],
  ['37.1', 'you', 'Reload VS Code mid-interview.'], ['37.2', 'you', 'New Chat and switching problems mid-interview.'],
  ['37.3', 'auto+claude', 'The panel after a reload and the business analyst in Claude Code see the terminal\'s answer.'],
  ['37.4', 'you', 'Synthesize the specification; a reload doesn\'t resume the interview.'],
  ['37.5', 'you', 'Attach a file from outside the workspace.'],
  ['37.6', 'auto+you', 'The Skills view shows the same.'],
  ['37.7', 'you', 'Run agent on the Plan stage; briefs in the Workflow view.'],
  ['37.8', 'you', 'Two problems: the questions fit each.'], ['37.9', 'you', 'Ingest sources/*.ddl first, then interview: questions the estate answers are skipped.'],
  ['37.10', 'you', 'Answer until it stops (fields covered or 12 questions).'], ['37.11', 'claude', 'The business analyst in Claude Code runs the interview.'],
  ['38.1', 'auto+claude', 'The context curator reads documents/brd.md in Claude Code.'], ['38.2', 'you', 'Apply the same BRD from the panel\'s Pack view.'],
  ['38.3', 'auto+claude', 'The curator proposes a profile for documents/customer-contract.v1.yaml; confirm it; apply.'],
  ['38.4', 'claude', 'Tell Claude Code a fact; it proposes it.'], ['38.5', 'claude', 'The curator proposes vocabulary for the CRM.'],
  ['39.1', 'auto+you', 'Look at the build stage in the Workflow view.'], ['39.2', 'snowflake|databricks', 'Run Source Assessment through a named connection.'],
  ['39.3', 'you', 'Run Source Assessment in a workspace with no connections.yaml (this one, before copying the example).'],
  ['39.4', 'snowflake|databricks', 'Set context.schemaTtlDays to 0, then Run agent.'], ['39.5', 'claude', 'The orchestrator refreshes before an assignment.']
];

function report(kitDir, env, results) {
  const byId = new Map();
  for (const r of results) for (const id of r.id.split(' / ')) byId.set(id, r);
  const needs = (n) => n.split('|').some((p) => (p === 'snowflake' && env.snow) || (p === 'databricks' && env.databricks) || (p === 'claude' && env.claude) || (p === 'cortex' && env.cortex) || p === 'you');
  const L = [];
  L.push('# Manual verification kit', '', `Made ${new Date().toISOString()} from AutoDE ${require(path.join(ROOT, 'package.json')).version}. Checks: docs/manual-verification.md, Parts 36 on.`, '');
  L.push('## Start here', '', '1. In the AutoDE repo, press F5 (Run Extension). In the new window, File → Open Folder… this folder.',
    '2. Open the AutoDE panel and choose an LLM provider (`/settings`).',
    '3. Claude Code: in this folder, open Claude Code (the VS Code extension, or `claude` in a terminal). The plugin\'s agents, skills, commands and guard hook are installed in `.claude/`, and `.mcp.json` wires AutoDE\'s MCP server.',
    '4. Live checks: copy `.autode/config/connections.example.yaml` to `connections.yaml` and fill it in (after 39.3).', '');
  L.push('## This machine', '', `| Tool | Found |`, `|---|---|`,
    ...[['VS Code (`code`)', env.code], ['Claude Code (CLI or VS Code extension)', env.claude], ['Snowflake CLI (`snow`)', env.snow], ['Databricks CLI (`databricks`)', env.databricks], ['Cortex Code (`cortex`)', env.cortex]].map(([n, p]) => `| ${n} | ${p ? `yes (${p})` : 'no'} |`), '');
  L.push('## Pre-checked here (no person, no VS Code, no live platform)', '', '| Check | What | Result | Seen |', '|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.what} | ${r.ok ? 'PASS' : '**FAIL**'} | ${String(r.seen).replace(/\|/g, '\\|')} |`), '');
  L.push('## What is left for you', '', '| Check | Pre-check | Needs | Can run on this machine | Your part |', '|---|---|---|---|---|',
    ...CHECKS.map(([id, need, what]) => {
      const pre = byId.get(id);
      const parts = need.split('+');
      const live = parts[parts.length - 1];
      return `| ${id} | ${pre ? (pre.ok ? 'pass' : '**fail**') : '—'} | ${live === 'auto' ? 'you' : live.replace('|', ' or ')} | ${needs(live === 'auto' ? 'you' : live) ? 'yes' : '**no**'} | ${what} |`;
    }), '');
  fs.writeFileSync(path.join(kitDir, 'MANUAL-KIT.md'), L.join('\n'));
}

async function main() {
  const a = args(process.argv.slice(2));
  if (!fs.existsSync(path.join(ROOT, 'dist', 'autode.js'))) throw new Error('Build first: npm run compile');
  if (fs.existsSync(a.out) && fs.readdirSync(a.out).length) {
    if (!fs.existsSync(path.join(a.out, MARKER))) throw new Error(`${a.out} exists and is not a kit folder; choose another with --out.`);
    if (!a.force) throw new Error(`${a.out} is a kit folder already: add --force to make it again (it is deleted first).`);
    fs.rmSync(a.out, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(a.out, '.autode', 'config'), { recursive: true });
  buildWorkspace(a.out);
  const inst = await cli(['plugin', 'install', '--host', 'claude', '--scope', 'project', '--workspace', a.out]);
  if (inst.code !== 0) throw new Error(`plugin install failed: ${inst.err || inst.out}`);
  const env = { code: onPath('code'), claude: claudeCode(), snow: onPath('snow'), databricks: onPath('databricks'), cortex: onPath('cortex') };
  const results = await preChecks(a.out);
  report(a.out, env, results);
  const failed = results.filter((r) => !r.ok);
  console.log(`Kit workspace: ${a.out}`);
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.what}${r.ok ? '' : `\n        ${r.seen}`}`);
  console.log(`Report: ${path.join(a.out, 'MANUAL-KIT.md')}`);
  process.exitCode = failed.length ? 1 : 0;
}

if (require.main === module) main().catch((e) => { console.error(`manual-kit: ${e.message}`); process.exitCode = 2; });
module.exports = { buildWorkspace, preChecks, CHECKS };
