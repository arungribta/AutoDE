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
      registerWebviewViewProvider: () => ({ dispose() {} }), createOutputChannel: () => ({ show() {}, appendLine() {} }) },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
    workspace: { getConfiguration: () => ({ get: (_k, f) => f, update: async () => {} }),
      openTextDocument: async () => ({ lineCount: 1, lineAt: () => ({ text: '' }) }) },
    extensions: { getExtension: (id) => installed && known.includes(id) ? { id, isActive: true } : undefined, all: [] },
    lm: { selectChatModels: async (sel) => { if (!installed) return []; if (sel?.vendor && sel.vendor !== 'copilot') return []; return models; } },
    LanguageModelChatMessage: { User: (c) => ({ role: 1, content: c }), Assistant: (c) => ({ role: 2, content: c }) },
    Uri: { file: (p) => ({ fsPath: p, toString: () => p }) },
    Selection: class {}, Position: class {},
    CancellationTokenSource: class { constructor() { this.token = {}; } cancel() {} },
    ConfigurationTarget: { Global: 1 }, EventEmitter: class {}
  };
}

// ---------- mock loader ----------
const origLoad = Module._load;
let active = null;
Module._load = function (req) { return req === 'vscode' ? (active || throw_('no mock')) : origLoad.apply(this, arguments); };
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

// ---------- runner ----------
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log('  PASS  ' + name); }
  catch (e) { results.push({ name, ok: false, err: e }); console.error('  FAIL  ' + name + '\n    ' + (e?.stack || e)); }
}

// ---------- main ----------
async function main() {
  console.log('Running Copilot functional tests...\n');

  await test('copilotAdapter loads and exports class', () => {
    const lib = withMock(createMock(), () => fresh('../dist/core/copilotAdapter.js'));
    assert.strictEqual(typeof lib.CopilotAdapter, 'function');
  });

  await test('detect() finds Copilot Chat', async () => {
    const mock = createMock();
    const lib = withMock(mock, () => fresh('../dist/core/copilotAdapter.js'));
    const { info } = await withMock(mock, () => lib.CopilotAdapter.detect(mockContext()));
    assert.strictEqual(info.found, true);
    assert.strictEqual(info.hasAccess, true);
    assert.strictEqual(info.models[0].vendor, 'copilot');
  });

  await test('detect() not installed', async () => {
    const mock = createMock({ chatInstalled: false });
    const lib = withMock(mock, () => fresh('../dist/core/copilotAdapter.js'));
    const { info } = await withMock(mock, () => lib.CopilotAdapter.detect(mockContext()));
    assert.strictEqual(info.found, false);
  });

  await test('complete() streams text', async () => {
    const model = { id: 'm', family: 'gpt', vendor: 'copilot', version: '1', name: 'm', maxInputTokens: 100,
      sendRequest: async (msgs) => { assert.strictEqual(msgs.length, 1); return { text: textIter('[{"id":"step-1"}]') }; } };
    const mock = createMock({ models: [model] });
    const lib = withMock(mock, () => fresh('../dist/core/copilotAdapter.js'));
    const { adapter } = await withMock(mock, () => lib.CopilotAdapter.detect(mockContext()));
    const t = await withMock(mock, () => adapter.complete('prompt', { timeoutMs: 500 }));
    assert.strictEqual(t, '[{"id":"step-1"}]');
  });

  await test('generatePlan() blocks without consent', async () => {
    const mock = createMock();
    const { DataAgentHubHub } = withMock(mock, () => fresh('../dist/core/agentHub.js'));
    const hub = new DataAgentHubHub(fakeCm({ activeLlmProvider: 'copilot', activeLlmModel: 'x', copilotProgrammaticConsent: false, defaultProvider: 'snowflake' }));
    await assert.rejects(() => withMock(mock, () => hub.generatePlan('build')),
      /programmatic use of GitHub Copilot is not enabled/i);
  });

  await test('generatePlan() with consent', async () => {
    const plan = JSON.stringify([{ id: 's', assignedAgent: 'ingestionAgent', taskDescription: 'x', dependsOn: [], validationRules: [] }]);
    const model = { id: 'copilot-4o', family: 'gpt-4o', vendor: 'copilot', version: '1', name: 'Copilot-4o', maxInputTokens: 128000,
      sendRequest: async () => ({ text: textIter(plan) }) };
    const mock = createMock({ models: [model] });
    // Clear both agentHub and copilotAdapter caches so the new mock is used.
    delete require.cache[require.resolve('../dist/core/agentHub.js')];
    delete require.cache[require.resolve('../dist/core/copilotAdapter.js')];
    const { DataAgentHubHub } = withMock(mock, () => require('../dist/core/agentHub.js'));
    const hub = new DataAgentHubHub(fakeCm({ activeLlmProvider: 'copilot', activeLlmModel: 'x', copilotProgrammaticConsent: true, defaultProvider: 'snowflake' }));
    const steps = await withMock(mock, () => hub.generatePlan('build'));
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].id, 's');
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

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });