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
      createOutputChannel: () => ({ show() {}, appendLine() {} }) },
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
    ConfigurationTarget: { Global: 1 }, EventEmitter: class {}
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
  for (const p of ['../dist/core/languageModelAdapter.js', '../dist/core/copilotAdapter.js', '../dist/core/claudeCodeAdapter.js']) {
    try { delete require.cache[require.resolve(p)]; } catch { /* not loaded yet */ }
  }
}
function freshAdapter(mock) { clearAdapterCache(); return withMock(mock, () => require('../dist/core/languageModelAdapter.js')); }

/**
 * Builds a fresh, consented DataAgentHubHub whose configured LLM always returns `responseText`.
 * Pre-satisfies the v0.13.0 orchestrator gate (an active spec + approved context) so tests that
 * call the raw `hub.generatePlan()` to exercise plan-generation/validation logic directly don't
 * also have to stand up a full spec-approval/context-approval fixture just to get past the gate —
 * that gate itself is covered separately (see the "generatePlan() orchestrator gate" tests).
 */
function hubForPlanResponse(responseText) {
  const model = { id: 'copilot-4o', family: 'gpt-4o', vendor: 'copilot', version: '1', name: 'Copilot-4o', maxInputTokens: 128000,
    sendRequest: async () => ({ text: textIter(responseText) }) };
  const mock = createMock({ models: [model] });
  delete require.cache[require.resolve('../dist/core/agentHub.js')];
  clearAdapterCache();
  const { DataAgentHubHub } = withMock(mock, () => require('../dist/core/agentHub.js'));
  const hub = new DataAgentHubHub(fakeCm({ activeLlmProvider: 'copilot', activeLlmModel: 'x', languageModelProgrammaticConsent: true, defaultProvider: 'snowflake' }));
  hub.setSpec('bps-test', 1);
  hub.setContextGateReady(true);
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
    assert.strictEqual(typeof lib.CopilotAdapter, 'function');
    // Back-compat shim re-exports the same class.
    const shim = withMock(createMock(), () => fresh('../dist/core/copilotAdapter.js'));
    assert.strictEqual(shim.CopilotAdapter, lib.LanguageModelAdapter);
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

  await test('generatePlan() blocks without consent', async () => {
    const mock = createMock();
    clearAdapterCache();
    const { DataAgentHubHub } = withMock(mock, () => fresh('../dist/core/agentHub.js'));
    const hub = new DataAgentHubHub(fakeCm({ activeLlmProvider: 'copilot', activeLlmModel: 'x', languageModelProgrammaticConsent: false, copilotProgrammaticConsent: false, defaultProvider: 'snowflake' }));
    hub.setSpec('bps-test', 1);
    hub.setContextGateReady(true);
    await assert.rejects(() => withMock(mock, () => hub.generatePlan('build')),
      /programmatic use of a local language model is not enabled/i);
  });

  await test('generatePlan() with consent', async () => {
    const plan = JSON.stringify([{ id: 's', assignedAgent: 'ingestionAgent', taskDescription: 'x', dependsOn: [], validationRules: [] }]);
    const model = { id: 'copilot-4o', family: 'gpt-4o', vendor: 'copilot', version: '1', name: 'Copilot-4o', maxInputTokens: 128000,
      sendRequest: async () => ({ text: textIter(plan) }) };
    const mock = createMock({ models: [model] });
    // Clear both agentHub and adapter caches so the new mock is used.
    delete require.cache[require.resolve('../dist/core/agentHub.js')];
    clearAdapterCache();
    const { DataAgentHubHub } = withMock(mock, () => require('../dist/core/agentHub.js'));
    const hub = new DataAgentHubHub(fakeCm({ activeLlmProvider: 'copilot', activeLlmModel: 'x', languageModelProgrammaticConsent: true, defaultProvider: 'snowflake' }));
    hub.setSpec('bps-test', 1);
    hub.setContextGateReady(true);
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

  // ── Spec-driven phase inference (pure module) ──
  await test('inferPhases() flags discover/model/build for an ingestion+modeling spec', () => {
    const { inferPhases } = require('../dist/core/phaseInference.js');
    const phases = inferPhases({
      id: 'bps-1', version: 1, status: 'approved',
      problemStatement: 'Load raw sales events from our source systems into Snowflake and build dbt pipelines.',
      objectives: ['ingest ordering events', 'build curated marts'],
      successCriteria: ['pipeline runs daily'],
      scope: { in: ['source assessment'], out: [] },
      constraints: [], assumptions: [], createdAt: '', updatedAt: ''
    });
    const required = phases.filter((p) => p.required).map((p) => p.phase);
    assert.deepStrictEqual(required, ['discover', 'model', 'build']);
    assert.strictEqual(phases.find((p) => p.phase === 'discover').reason.includes('source'), true);
  });

  await test('inferPhases() honors scope.out exclusions that veto evidence', () => {
    const { inferPhases } = require('../dist/core/phaseInference.js');
    const phases = inferPhases({
      id: 'bps-2', version: 1, status: 'approved',
      problemStatement: 'Design a dimensional star schema for the analytics team.',
      objectives: ['create star schema marts'],
      successCriteria: ['model approved'],
      scope: { in: [], out: ['no pipelines', 'no documentation'] },
      constraints: [], assumptions: [], createdAt: '', updatedAt: ''
    });
    const required = phases.filter((p) => p.required).map((p) => p.phase);
    assert.deepStrictEqual(required, ['model']);
  });

  await test('inferPhases() defaults to the full workflow when nothing matches', () => {
    const { inferPhases } = require('../dist/core/phaseInference.js');
    const phases = inferPhases({
      id: 'bps-3', version: 1, status: 'approved',
      problemStatement: 'We need to understand our data better.',
      objectives: ['review the landscape'],
      successCriteria: ['walkthrough complete'],
      scope: { in: [], out: [] },
      constraints: [], assumptions: [], domain: 'general', createdAt: '', updatedAt: ''
    });
    assert.deepStrictEqual(phases.filter((p) => p.required).map((p) => p.phase), ['discover', 'model', 'build', 'validate']);
  });

  await test('computePhaseStatuses() tracks live status across the phase chain', () => {
    const { inferPhases, computePhaseStatuses } = require('../dist/core/phaseInference.js');
    const base = inferPhases({
      id: 'bps-4', version: 1, status: 'approved',
      problemStatement: 'Ingest raw source data, transform it into dimensional marts, build dbt pipelines, and add validation tests and documentation.',
      objectives: [], successCriteria: [], scope: { in: [], out: [] },
      constraints: [], assumptions: [], createdAt: '', updatedAt: ''
    });
    const pendingAll = computePhaseStatuses(base, [], 'discover');
    assert.ok(pendingAll.every((p) => (p.required ? p.status === 'pending' : p.status === 'unrequired')));

    const plan = [
      { id: 's1', assignedAgent: 'sourceAssessmentAgent', taskDescription: 'x', status: 'completed', phase: 'discover' },
      { id: 's2', assignedAgent: 'dataModelerAgent', taskDescription: 'x', status: 'completed', phase: 'model' },
      { id: 's3', assignedAgent: 'ingestionAgent', taskDescription: 'x', status: 'pending', phase: 'build' },
      { id: 's4', assignedAgent: 'architectureAgent', taskDescription: 'x', status: 'pending', phase: 'validate' }
    ];
    const live = computePhaseStatuses(base, plan, 'build');
    const byPhase = (ph) => live.find((p) => p.phase === ph).status;
    assert.strictEqual(byPhase('discover'), 'completed');
    assert.strictEqual(byPhase('model'), 'completed');
    assert.strictEqual(byPhase('build'), 'pending');
    assert.strictEqual(byPhase('validate'), 'blocked');
  });

  await test('generatePlanFromSpec() infers phases and tags plan steps', async () => {
    const plan = JSON.stringify([
      { id: 's1', assignedAgent: 'ingestionAgent', taskDescription: 'build ingestion pipeline', dependsOn: [], validationRules: [] },
      { id: 's2', assignedAgent: 'architectureAgent', taskDescription: 'document the data dictionary', dependsOn: ['s1'], validationRules: [] }
    ]);
    const model = { id: 'copilot-4o', family: 'gpt-4o', vendor: 'copilot', version: '1', name: 'Copilot-4o', maxInputTokens: 128000,
      sendRequest: async () => ({ text: textIter(plan) }) };
    const mock = createMock({ models: [model] });
    delete require.cache[require.resolve('../dist/core/agentHub.js')];
    clearAdapterCache();
    const { DataAgentHubHub } = withMock(mock, () => require('../dist/core/agentHub.js'));
    const hub = new DataAgentHubHub(fakeCm({ activeLlmProvider: 'copilot', activeLlmModel: 'x', languageModelProgrammaticConsent: true, defaultProvider: 'snowflake' }));
    const spec = {
      id: 'bps-it', version: 3, status: 'approved', problemStatementApproved: true,
      problemStatement: 'Ingest raw sales channel source data and load dbt pipelines, then document the results.',
      objectives: ['ingest channel data'], successCriteria: ['pipeline runs'],
      scope: { in: [], out: [] }, constraints: [], assumptions: [], createdAt: '', updatedAt: ''
    };
    hub.setContextGateReady(true);
    await withMock(mock, () => hub.generatePlanFromSpec(spec));
    const state = hub.getPlan();
    assert.ok(state.inferredPhases.length === 4, 'all four phases present');
    assert.strictEqual(state.inferredPhases.find((p) => p.phase === 'build').required, true);
    assert.strictEqual(state.steps[0].phase, 'build');
    assert.strictEqual(state.steps[1].phase, 'validate');
    assert.strictEqual(state.specVersion, 3);
  });

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

  await test('loadSkillsFromDirectory() loads bundled skills', () => {
    const { loadSkillsFromDirectory } = require('../dist/engine/skills/skillRegistry.js');
    const skills = loadSkillsFromDirectory(nodePath.join(__dirname, '..', 'skills'));
    assert.ok(skills.length >= 6, `expected >=6 bundled skills, got ${skills.length}`);
    assert.ok(skills.some((s) => s.id === 'synthesis'));
    assert.ok(skills.every((s) => s.id && s.systemPrompt));
  });

  await test('createIntakeSession() seeds coverage and budget', () => {
    const { createIntakeSession } = require('../dist/core/specOps.js');
    const session = createIntakeSession('Build a marts pipeline', { fields: ['dataFlows', 'objectives'], turnBudget: 5, now: '2026-01-01T00:00:00.000Z' });
    assert.strictEqual(session.state, 'discovery');
    assert.strictEqual(session.turnBudget, 5);
    assert.deepStrictEqual(session.coverage, { dataFlows: 'missing', objectives: 'missing' });
    assert.throws(() => createIntakeSession('   '), /problem statement/i);
  });

  await test('createIntakeSession() seeds a revision from a previous approved spec', () => {
    const { createIntakeSession } = require('../dist/core/specOps.js');
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
    const { createIntakeSession, SpecOpsEngine } = require('../dist/core/specOps.js');
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
    const { createIntakeSession, SpecOpsEngine } = require('../dist/core/specOps.js');
    const engine = new SpecOpsEngine(createIntakeSession('x', { fields: ['objectives'], turnBudget: 1 }));
    engine.ask([{ id: 'q1', field: 'objectives', prompt: 'p?', kind: 'text', askedAt: 't' }]);
    assert.strictEqual(engine.shouldSynthesize(), true);
  });

  await test('validateAction() accepts valid actions and rejects invalid ones', () => {
    const { SpecOpsEngine } = require('../dist/core/specOps.js');
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
    const { createIntakeSession, SpecOpsEngine } = require('../dist/core/specOps.js');
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
    const { createIntakeSession } = require('../dist/core/specOps.js');
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
    const { createIntakeSession, SpecOpsEngine } = require('../dist/core/specOps.js');
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
    const { createIntakeSession } = require('../dist/core/specOps.js');
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
    const { createIntakeSession } = require('../dist/core/specOps.js');
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
    const { createIntakeSession } = require('../dist/core/specOps.js');
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
    const { createIntakeSession } = require('../dist/core/specOps.js');
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
    const { writeGraphSnapshot, readGraphSnapshot } = require('../dist/context/GraphPersistence.js');
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
      store.set('/ws/.ai-context/spec/business-problem.yaml', legacy);
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
    const mgr = new SpecManager({ fsPath: '/ws/.ai-context' }, () => {});
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
      store.set('/ws/.ai-context/spec/business-problem.yaml', legacy);
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
    const mgr = new SpecManager({ fsPath: '/ws/.ai-context' }, () => {});
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
    const mgr = new SpecManager({ fsPath: '/ws/.ai-context' }, () => {});
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
    await mock.workspace.fs.readFile({ fsPath: '/ws/.ai-context/spec/business-problem.yaml' }).then((b) => { raw = b.toString('utf8'); });
    assert.ok(!raw.includes('comprehensive:'), 'should not emit the JSON comprehensive block');
    assert.ok(raw.includes('scope:'), 'should emit nested scope');
    assert.ok(raw.includes('businessRequirements:'), 'v2 field emitted natively');
    const mgr2 = new SpecManager({ fsPath: '/ws/.ai-context' }, () => {});
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

  await test('TargetConfigManager round-trips profiles through real YAML', async () => {
    function tcmMock() {
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
          },
          createFileSystemWatcher: () => ({ onDidChange: () => {}, dispose: () => {} })
        },
        RelativePattern: class { constructor(_base, _pattern) {} }
      };
    }
    const mock = tcmMock();
    delete require.cache[require.resolve('../dist/context/TargetConfigManager.js')];
    const { TargetConfigManager } = withMock(mock, () => require('../dist/context/TargetConfigManager.js'));
    const tcm = new TargetConfigManager({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => tcm.initialize());
    const active = tcm.getActiveEnvironment();
    assert.ok(active, 'default active environment present');
    assert.strictEqual(active.platform, 'snowflake');
    assert.deepStrictEqual(active.outputFormats, ['ddl', 'yaml', 'markdown']);
    await withMock(mock, () => tcm.upsertProfile({
      name: 'staging', inherits: 'base',
      environment: {
        platform: 'snowflake', environmentProfile: 'staging', modelingApproach: 'dimensional',
        namingConvention: 'snake_case', transformationTool: 'dbt', orchestrationTool: 'airflow',
        outputFormats: ['ddl'], platformConfig: { account: 'acct', database: 'DB', schema: 'S', warehouse: 'W', role: 'R' }
      }
    }));
    const tcm2 = new TargetConfigManager({ fsPath: '/ws' }, () => {});
    await withMock(mock, () => tcm2.initialize());
    const profiles = tcm2.getAllProfiles();
    const staging = profiles.find((p) => p.name === 'staging');
    assert.ok(staging, 'staging profile persisted');
    assert.strictEqual(staging.inherits, 'base');
    assert.strictEqual(staging.environment.platformConfig.database, 'DB');
  });

  await test('ContextFileManager loads authoritative context + persists compiled graph atomically', async () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-cfm-'));
    const ctxDir = path.join(dir, '.ai-context');
    const authDir = path.join(ctxDir, 'context');
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
    const graphPath = path.join(ctxDir, 'derived', 'graph.json');
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
    const ctxDir = path.join(dir, '.ai-context');
    fs.mkdirSync(ctxDir, { recursive: true });

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
    const graphPath = path.join(ctxDir, 'derived', 'graph.json');
    assert.ok(fs.existsSync(graphPath), 'derived/graph.json exists after the very first activation, even with nothing extracted yet');
    assert.strictEqual(graph1.getNodesByType('table').length, 0);

    // Step 2: "Source Assessment" writes schema-graph.json with real tables —
    // give it a guaranteed-later mtime (real filesystem timestamp resolution can
    // otherwise be too coarse to distinguish two writes microseconds apart).
    const schemaGraphPath = path.join(ctxDir, 'schema-graph.json');
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
    const workspaceRoot = { fsPath: tmpRoot, toString: () => tmpRoot };
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

    assert.ok(fs.existsSync(path.join(tmpRoot, 'artifacts', '03-build', 'bps-1.v1', 'a1.sql')), 'v1 artifact under its spec-tagged folder');
    assert.ok(fs.existsSync(path.join(tmpRoot, 'artifacts', '03-build', 'bps-1.v2', 'a2.sql')), 'v2 artifact under its spec-tagged folder');
    assert.ok(fs.existsSync(path.join(tmpRoot, 'artifacts', '03-build', 'legacy.sql')), 'unstamped artifact has no version folder');

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
    assert.ok(fs.existsSync(path.join(tmpRoot, '.ai-context', 'chats')), 'chats directory created');

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
    assert.ok(!fs.existsSync(path.join(tmpRoot, '.ai-context', 'chats', `${session.id}.meta.json`)), 'meta file removed');
    assert.ok(!fs.existsSync(path.join(tmpRoot, '.ai-context', 'chats', `${session.id}.jsonl`)), 'transcript file removed');
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

  await test('inferPhases() forces discover for brownfield unless excluded by scope.out', () => {
    const { inferPhases } = require('../dist/core/phaseInference.js');
    const base = { id: 'b', version: 1, status: 'approved', problemStatement: 'Build dbt models and orchestrate them with Airflow.', objectives: ['Transform data into star schema marts.'], successCriteria: [], scope: { in: [], out: [] }, constraints: [], assumptions: [], createdAt: '', updatedAt: '' };

    const withoutType = inferPhases(base);
    assert.strictEqual(withoutType.find((p) => p.phase === 'discover').required, false);

    const brownfield = inferPhases(base, 'brownfield');
    const discoverPhase = brownfield.find((p) => p.phase === 'discover');
    assert.strictEqual(discoverPhase.required, true);
    assert.ok(/brownfield implementation/i.test(discoverPhase.reason));

    const excluded = inferPhases({ ...base, scope: { in: [], out: ['no source assessment'] } }, 'brownfield');
    assert.strictEqual(excluded.find((p) => p.phase === 'discover').required, false, 'explicit scope.out exclusion still wins over the brownfield default');
  });

  await test('validatePlanResponse() rejects malformed JSON', async () => {
    const { hub, mock } = hubForPlanResponse('not json at all');
    await assert.rejects(() => withMock(mock, () => hub.generatePlan('build')), /LLM returned invalid JSON/i);
  });

  await test('validatePlanResponse() rejects a JSON object instead of an array', async () => {
    const { hub, mock } = hubForPlanResponse(JSON.stringify({ id: 's' }));
    await assert.rejects(() => withMock(mock, () => hub.generatePlan('build')), /did not produce a JSON array/i);
  });

  await test('validatePlanResponse() rejects an invalid assignedAgent', async () => {
    const bad = JSON.stringify([{ id: 's', assignedAgent: 'notARealAgent', taskDescription: 'x', dependsOn: [] }]);
    const { hub, mock } = hubForPlanResponse(bad);
    await assert.rejects(() => withMock(mock, () => hub.generatePlan('build')), /invalid assignedAgent/i);
  });

  await test('validatePlanResponse() rejects a step with no taskDescription', async () => {
    const bad = JSON.stringify([{ id: 's', assignedAgent: 'ingestionAgent', taskDescription: '   ', dependsOn: [] }]);
    const { hub, mock } = hubForPlanResponse(bad);
    await assert.rejects(() => withMock(mock, () => hub.generatePlan('build')), /does not include a taskDescription/i);
  });

  await test('validatePlanResponse() rejects duplicate step IDs', async () => {
    const bad = JSON.stringify([
      { id: 's', assignedAgent: 'ingestionAgent', taskDescription: 'a', dependsOn: [] },
      { id: 's', assignedAgent: 'sttmAgent', taskDescription: 'b', dependsOn: [] }
    ]);
    const { hub, mock } = hubForPlanResponse(bad);
    await assert.rejects(() => withMock(mock, () => hub.generatePlan('build')), /duplicate step ID/i);
  });

  await test('validatePlanResponse() rejects a dependency on a missing step ID', async () => {
    const bad = JSON.stringify([{ id: 's1', assignedAgent: 'ingestionAgent', taskDescription: 'a', dependsOn: ['ghost'] }]);
    const { hub, mock } = hubForPlanResponse(bad);
    await assert.rejects(() => withMock(mock, () => hub.generatePlan('build')), /depends on missing step IDs/i);
  });

  await test('validatePlanResponse() rejects a step that depends on itself', async () => {
    const bad = JSON.stringify([{ id: 's1', assignedAgent: 'ingestionAgent', taskDescription: 'a', dependsOn: ['s1'] }]);
    const { hub, mock } = hubForPlanResponse(bad);
    await assert.rejects(() => withMock(mock, () => hub.generatePlan('build')), /cannot depend on itself/i);
  });

  await test('validatePlanResponse() rejects a multi-step circular dependency', async () => {
    const bad = JSON.stringify([
      { id: 's1', assignedAgent: 'ingestionAgent', taskDescription: 'a', dependsOn: ['s2'] },
      { id: 's2', assignedAgent: 'sttmAgent', taskDescription: 'b', dependsOn: ['s1'] }
    ]);
    const { hub, mock } = hubForPlanResponse(bad);
    await assert.rejects(() => withMock(mock, () => hub.generatePlan('build')), /circular dependency/i);
  });

  await test('validatePlanResponse() tolerates a markdown-fenced JSON array', async () => {
    const plan = '```json\n' + JSON.stringify([{ id: 's1', assignedAgent: 'ingestionAgent', taskDescription: 'x', dependsOn: [] }]) + '\n```';
    const { hub, mock } = hubForPlanResponse(plan);
    const steps = await withMock(mock, () => hub.generatePlan('build'));
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].id, 's1');
  });

  await test('validatePlanResponse() rejects a step outside the required phases', async () => {
    const outOfPhase = JSON.stringify([{ id: 's1', assignedAgent: 'sourceAssessmentAgent', taskDescription: 'assess sources', dependsOn: [] }]);
    const { hub, mock } = hubForPlanResponse(outOfPhase);
    const spec = {
      id: 'bps-1', version: 1, status: 'approved', problemStatementApproved: true,
      problemStatement: 'Build dbt pipelines and load into the warehouse.',
      objectives: ['Build a dbt pipeline.'], successCriteria: [], scope: { in: [], out: [] },
      constraints: [], assumptions: [], createdAt: '', updatedAt: ''
    };
    await assert.rejects(() => withMock(mock, () => hub.generatePlanFromSpec(spec)), /not among the required phases/i);
  });

  await test('computePhaseStatuses() shows pending-review for a freshly generated, not-yet-run plan', () => {
    const { computePhaseStatuses } = require('../dist/core/phaseInference.js');
    const phases = [
      { phase: 'discover', label: 'Discover', required: true, status: 'pending', reason: 'r', dependsOn: [] },
      { phase: 'build', label: 'Build', required: true, status: 'pending', reason: 'r', dependsOn: ['discover'] },
      { phase: 'validate', label: 'Validate', required: false, status: 'pending', reason: 'r', dependsOn: [] }
    ];
    const steps = [
      { id: 's1', assignedAgent: 'sourceAssessmentAgent', taskDescription: 'x', status: 'pending', phase: 'discover' },
      { id: 's2', assignedAgent: 'ingestionAgent', taskDescription: 'y', status: 'pending', phase: 'build', dependsOn: ['s1'] }
    ];
    const readyResult = computePhaseStatuses(phases, steps, undefined, 'ready');
    assert.strictEqual(readyResult.find((p) => p.phase === 'discover').status, 'pending-review', 'required phase awaits review before anything has run');
    assert.strictEqual(readyResult.find((p) => p.phase === 'build').status, 'pending-review', 'even a dependency-blocked phase reads as review-pending, not blocked, before execution starts');
    assert.strictEqual(readyResult.find((p) => p.phase === 'validate').status, 'unrequired');

    const runningResult = computePhaseStatuses(phases, steps, undefined, 'running');
    assert.strictEqual(runningResult.find((p) => p.phase === 'discover').status, 'pending', 'once execution has started, phases use the normal pending/blocked lifecycle');
    assert.strictEqual(runningResult.find((p) => p.phase === 'build').status, 'blocked', 'build genuinely is blocked on discover mid-execution');
  });

  await test('generateWithLlm() only accepts a properly fenced response, falling back to undefined otherwise', async () => {
    const { generateWithLlm } = require('../dist/agents/llmCodegen.js');
    const step = { id: 's1', assignedAgent: 'ingestionAgent', taskDescription: 'Load orders', status: 'pending' };
    const baseContext = { objective: 'obj', schemaContext: 'ctx', sourceProvider: 'snowflake', settings: {}, configManager: { getSecret: async () => undefined, getSettings: () => ({}) }, log: () => {} };

    const fenced = await generateWithLlm({ ...baseContext, callLlm: async () => '```sql\nSELECT 1;\n```' }, step, { role: 'x', instructions: 'y', fence: 'sql' });
    assert.strictEqual(fenced, 'SELECT 1;', 'extracts the fenced content verbatim');

    const unfenced = await generateWithLlm({ ...baseContext, callLlm: async () => 'Sure, here is the SQL: SELECT 1;' }, step, { role: 'x', instructions: 'y', fence: 'sql' });
    assert.strictEqual(unfenced, undefined, 'an unfenced response is not treated as valid content — never risk shipping prose as an artifact');

    const throwing = await generateWithLlm({ ...baseContext, callLlm: async () => { throw new Error('LLM unavailable'); } }, step, { role: 'x', instructions: 'y', fence: 'sql' });
    assert.strictEqual(throwing, undefined, 'a failed LLM call falls back cleanly, never throws out of generateWithLlm');

    const noLlm = await generateWithLlm(baseContext, step, { role: 'x', instructions: 'y', fence: 'sql' });
    assert.strictEqual(noLlm, undefined, 'no callLlm on the context at all falls back the same way');
  });

  await test('sourceAssessmentAgent and snowflakeExecutor degrade gracefully instead of failing when there is no target connection', async () => {
    const plan = JSON.stringify([
      { id: 'assess', assignedAgent: 'sourceAssessmentAgent', taskDescription: 'Assess the source landscape', dependsOn: [], validationRules: [] },
      { id: 'ingest', assignedAgent: 'ingestionAgent', taskDescription: 'Generate ingestion DDL', dependsOn: [], validationRules: [] },
      { id: 'snowflake-check', assignedAgent: 'snowflakeExecutor', taskDescription: 'Validate against Snowflake', dependsOn: [], validationRules: [] }
    ]);
    const { hub, mock } = hubForPlanResponse(plan);
    hub.inferPhasesFromSpec({
      id: 'bps-test', version: 1, status: 'approved', implementationType: 'brownfield',
      problemStatement: 'Assess the existing source system and build an ingestion pipeline.', objectives: [], successCriteria: [],
      scope: { in: [], out: [] }, constraints: [], assumptions: [], createdAt: '', updatedAt: ''
    });
    await withMock(mock, () => hub.generatePlan('build a pipeline', 'Known: three source tables from the registered data contract.'));
    hub.approvePlan();
    hub.confirmStages();

    await withMock(mock, () => hub.executePlan());

    const finalState = hub.getPlan();
    const assessStep = finalState.steps.find((s) => s.id === 'assess');
    const ingestStep = finalState.steps.find((s) => s.id === 'ingest');
    const snowflakeStep = finalState.steps.find((s) => s.id === 'snowflake-check');
    assert.strictEqual(assessStep.status, 'completed', 'source assessment degrades to a context-derived report instead of failing with no connection');
    assert.strictEqual(ingestStep.status, 'completed');
    assert.strictEqual(snowflakeStep.status, 'completed', 'snowflake validation is skipped, not failed, when there is no connection');
    assert.strictEqual(finalState.status, 'completed', 'the plan completes even though nothing could actually reach Snowflake');

    const artifacts = finalState.artifacts || [];
    const assessArtifact = artifacts.find((a) => a.generatedBy === 'sourceAssessmentAgent');
    const snowflakeArtifact = artifacts.find((a) => a.generatedBy === 'snowflakeExecutor');
    const ingestArtifact = artifacts.find((a) => a.generatedBy === 'ingestionAgent');
    assert.ok(assessArtifact, 'a context-derived assessment artifact was produced');
    assert.ok(/registered data contract/.test(assessArtifact.content), 'the report actually surfaces the known context, not just a generic placeholder');
    assert.ok(snowflakeArtifact, 'the unexecuted validation query was saved as an artifact for manual review');
    assert.ok(/not executed/i.test(snowflakeArtifact.content));
    // The mocked LLM (shared across every call in this test) returns the plan
    // JSON text, not a fenced SQL block — ingestionAgent's LLM attempt must
    // therefore fall back to its real template, not ship that JSON as "SQL".
    assert.ok(ingestArtifact, 'ingestion produced an artifact');
    assert.ok(/CREATE OR REPLACE TABLE/.test(ingestArtifact.content), 'falls back to the real template SQL rather than an unfenced LLM response');
    assert.ok(!/assignedAgent/.test(ingestArtifact.content), 'the raw plan JSON was never mistaken for generated SQL content');
  });

  await test('setPhaseOverride() flips a phase and survives a subsequent re-inference', async () => {
    const mock = createMock();
    delete require.cache[require.resolve('../dist/core/agentHub.js')];
    const { DataAgentHubHub } = withMock(mock, () => require('../dist/core/agentHub.js'));
    const hub = new DataAgentHubHub(fakeCm({ activeLlmProvider: 'copilot', activeLlmModel: 'x', languageModelProgrammaticConsent: true, defaultProvider: 'snowflake' }));

    const spec = {
      id: 'bps-1', version: 1, status: 'approved',
      problemStatement: 'Build dbt pipelines and load into the warehouse.',
      objectives: [], successCriteria: [], scope: { in: [], out: [] }, constraints: [], assumptions: [],
      createdAt: '', updatedAt: ''
    };
    hub.inferPhasesFromSpec(spec);
    assert.strictEqual(hub.getInferredPhases().find((p) => p.phase === 'discover').required, false, 'discover is not inferred as required from this spec');

    const overridden = hub.setPhaseOverride('discover', true);
    assert.strictEqual(overridden.find((p) => p.phase === 'discover').required, true);
    assert.strictEqual(overridden.find((p) => p.phase === 'discover').reason, 'Manually set by user.');

    // Re-running inference (e.g. after a spec revision) must not silently drop the override.
    hub.inferPhasesFromSpec(spec);
    assert.strictEqual(hub.getInferredPhases().find((p) => p.phase === 'discover').required, true, 'override survives a subsequent re-inference');
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

  await test('PlanManager persists plans with version history across versions and reloads', async () => {
    function fsMapMock() {
      const store = new Map();
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      const m = {
        Uri: {
          file: (p) => ({ fsPath: p }),
          joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') })
        },
        workspace: {
          fs: {
            createDirectory: async () => {},
            readFile: async (uri) => { const v = store.get(keyOf(uri)); if (v === undefined) throw new Error('ENOENT'); return Buffer.from(v, 'utf8'); },
            writeFile: async (uri, buf) => { store.set(keyOf(uri), buf.toString('utf8')); },
            rename: async (a, b) => { store.set(keyOf(b), store.get(keyOf(a))); store.delete(keyOf(a)); }
          }
        }
      };
      m.__store = store;
      return m;
    }
    const mock = fsMapMock();
    try { delete require.cache[require.resolve('../dist/context/PlanManager.js')]; } catch { /* not loaded */ }
    const { PlanManager } = withMock(mock, () => require('../dist/context/PlanManager.js'));
    const ws = { fsPath: '/ws' };
    const mgr = new PlanManager(ws, () => {});
    await withMock(mock, () => mgr.initialize());
    assert.strictEqual(mgr.getPlan(), undefined, 'nothing persisted yet');

    const base = {
      id: 'plan-1', specId: 'bps-1', specVersion: 1, implementationType: 'greenfield',
      objective: 'do the thing', schemaContext: '', status: 'ready',
      steps: [{ id: 's1', assignedAgent: 'ingestionAgent', taskDescription: 't', status: 'pending', dependsOn: [], validationRules: [] }],
      inferredPhases: undefined, targetEnvironment: undefined, generationReason: 'initial'
    };
    const saved1 = await withMock(mock, () => mgr.savePlan(base));
    assert.strictEqual(saved1.version, 1);

    const saved2 = await withMock(mock, () => mgr.savePlan(Object.assign({}, base, { status: 'failed', generationReason: 're-plan' })));
    assert.strictEqual(saved2.version, 2);
    assert.strictEqual(saved2.createdAt, saved1.createdAt, 'createdAt is preserved across versions of the same lineage');

    const mgr2 = new PlanManager(ws, () => {});
    await withMock(mock, () => mgr2.initialize());
    const loaded = mgr2.getPlan();
    assert.strictEqual(loaded.version, 2);
    assert.strictEqual(loaded.status, 'failed');
    assert.strictEqual(loaded.steps[0].id, 's1');

    const historyKeys = Array.from(mock.__store.keys()).filter((k) => k.includes('/plan/history/'));
    assert.strictEqual(historyKeys.length, 1);
    assert.ok(historyKeys[0].endsWith('plan.v1.ready.yaml'), historyKeys[0]);
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
    const workspaceRoot = { fsPath: tmpRoot, toString: () => tmpRoot };
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

    const targetPath = path.join(tmpRoot, 'artifacts', '03-build', 'bps-1.v1', 'ddl-1.sql');
    assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), 'select 2 -- rerun', 'the file itself reflects the latest rerun');

    const historyDir = path.join(tmpRoot, 'artifacts', '03-build', 'bps-1.v1', 'history');
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
      const specDir = path.join(tmpRoot, '.ai-context', 'problems', id, 'spec');
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
    fs.mkdirSync(path.join(tmpRoot, '.ai-context', 'problems', 'problem-c', 'spec'), { recursive: true });

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

  await test('resetForNewProblem() fully clears spec identity and phase/implementation state (not just plan state)', () => {
    const { hub } = hubForPlanResponse('irrelevant');
    hub.setSpec('bps-old', 3);
    const spec = {
      id: 'bps-old', version: 3, status: 'approved',
      problemStatement: 'Build dbt pipelines and load into the warehouse.',
      objectives: [], successCriteria: [], scope: { in: [], out: [] }, constraints: [], assumptions: [],
      implementationType: 'greenfield',
      createdAt: '', updatedAt: ''
    };
    hub.inferPhasesFromSpec(spec);
    hub.setTargetEnvironment({ platform: 'snowflake' });

    let plan = hub.getPlan();
    assert.strictEqual(plan.specId, 'bps-old');
    assert.ok(plan.inferredPhases && plan.inferredPhases.length > 0);
    assert.strictEqual(plan.implementationType, 'greenfield');

    hub.resetForNewProblem();
    plan = hub.getPlan();
    assert.strictEqual(plan.specId, undefined, 'spec identity must not leak into the next business problem');
    assert.strictEqual(plan.specVersion, undefined);
    assert.strictEqual(plan.inferredPhases, undefined, 'inferred phases must not leak');
    assert.strictEqual(plan.implementationType, undefined, 'implementation type must not leak');
    assert.strictEqual(plan.targetEnvironment, undefined, 'target environment must not leak');
    assert.strictEqual(plan.status, 'idle');
    assert.deepStrictEqual(plan.steps, []);
  });

  // ── Lifecycle Orchestration (v0.13.0) — requirements.md §8.12 ──
  await test('generatePlan() orchestrator gate blocks a caller with no active, context-ready business problem', async () => {
    const plan = JSON.stringify([{ id: 's', assignedAgent: 'ingestionAgent', taskDescription: 'x', dependsOn: [], validationRules: [] }]);
    const model = { id: 'copilot-4o', family: 'gpt-4o', vendor: 'copilot', version: '1', name: 'Copilot-4o', maxInputTokens: 128000,
      sendRequest: async () => ({ text: textIter(plan) }) };
    const mock = createMock({ models: [model] });
    delete require.cache[require.resolve('../dist/core/agentHub.js')];
    clearAdapterCache();
    const { DataAgentHubHub } = withMock(mock, () => require('../dist/core/agentHub.js'));
    const hub = new DataAgentHubHub(fakeCm({ activeLlmProvider: 'copilot', activeLlmModel: 'x', languageModelProgrammaticConsent: true, defaultProvider: 'snowflake' }));

    // No spec, no context-gate signal — this is the state every one of the legacy
    // ungated entry points (Command Palette, AutoDE Dashboard panel, /plan with no
    // spec, re-plan buttons) left the hub in before v0.13.0.
    await assert.rejects(() => withMock(mock, () => hub.generatePlan('build a pipeline')),
      /requires an approved Business Problem Specification/i);

    // Spec identity alone isn't enough — context still has to be ready.
    hub.setSpec('bps-1', 1);
    await assert.rejects(() => withMock(mock, () => hub.generatePlan('build a pipeline')),
      /requires an approved Business Problem Specification/i);

    // Once both are satisfied, the same call succeeds — this is the orchestrator's
    // one enforcement point, not a per-caller check the UI has to remember to run.
    hub.setContextGateReady(true);
    const steps = await withMock(mock, () => hub.generatePlan('build a pipeline'));
    assert.strictEqual(steps.length, 1);
  });

  await test('generatePlanFromSpec() enforces spec approval, business-problem confirmation, and context readiness independently', async () => {
    const plan = JSON.stringify([{ id: 's', assignedAgent: 'ingestionAgent', taskDescription: 'x', dependsOn: [], validationRules: [] }]);
    const { hub, mock } = hubForPlanResponse(plan);
    const baseSpec = {
      id: 'bps-1', version: 1, problemStatement: 'Build a dbt pipeline.',
      objectives: [], successCriteria: [], scope: { in: [], out: [] }, constraints: [], assumptions: [], createdAt: '', updatedAt: ''
    };

    hub.setContextGateReady(true);
    await assert.rejects(
      () => withMock(mock, () => hub.generatePlanFromSpec({ ...baseSpec, status: 'draft', problemStatementApproved: true })),
      /Approve the Business Problem Specification/i,
      'an unapproved spec is rejected even with context ready'
    );
    await assert.rejects(
      () => withMock(mock, () => hub.generatePlanFromSpec({ ...baseSpec, status: 'approved', problemStatementApproved: false })),
      /Confirm the inferred business problem/i,
      'an approved spec whose business-problem checkpoint was never confirmed is rejected'
    );

    hub.setContextGateReady(false);
    await assert.rejects(
      () => withMock(mock, () => hub.generatePlanFromSpec({ ...baseSpec, status: 'approved', problemStatementApproved: true })),
      /blocked until Source\/Target Context/i,
      'an otherwise-ready spec is still rejected while Source/Target Context is not'
    );

    hub.setContextGateReady(true);
    await withMock(mock, () => hub.generatePlanFromSpec({ ...baseSpec, status: 'approved', problemStatementApproved: true }));
    assert.strictEqual(hub.getPlan().steps.length, 1, 'succeeds once all three preconditions hold');
  });

  await test('executePlan() requires an explicit Plan Approval and Stage Confirmation, independently of each other', async () => {
    const plan = JSON.stringify([{ id: 's', assignedAgent: 'ingestionAgent', taskDescription: 'x', dependsOn: [], validationRules: [] }]);
    const { hub, mock } = hubForPlanResponse(plan);
    hub.inferPhasesFromSpec({
      id: 'bps-test', version: 1, status: 'approved', implementationType: 'greenfield',
      problemStatement: 'Build a dbt pipeline.', objectives: [], successCriteria: [],
      scope: { in: [], out: [] }, constraints: [], assumptions: [], createdAt: '', updatedAt: ''
    });
    await withMock(mock, () => hub.generatePlan('build a pipeline'));

    await assert.rejects(() => withMock(mock, () => hub.executePlan()), /Approve the plan/i, 'neither gate satisfied yet');

    hub.approvePlan();
    await assert.rejects(() => withMock(mock, () => hub.executePlan()), /Confirm the applicable stages/i, 'plan approved but stages not confirmed');

    hub.confirmStages();
    await withMock(mock, () => hub.executePlan());
    assert.strictEqual(hub.getPlan().status, 'completed', 'runs once both gates are satisfied');

    // Re-planning invalidates both — a regenerated plan needs its own approval/confirmation.
    await withMock(mock, () => hub.generatePlan('build a different pipeline'));
    assert.strictEqual(hub.getPlan().planApproved, false, 're-planning resets Plan Approval');
    assert.strictEqual(hub.getPlan().stagesConfirmed, false, 're-planning resets Stage Confirmation');
  });

  await test('setPhaseOverride() invalidates a prior Stage Confirmation', async () => {
    const plan = JSON.stringify([{ id: 's', assignedAgent: 'ingestionAgent', taskDescription: 'x', dependsOn: [], validationRules: [] }]);
    const { hub, mock } = hubForPlanResponse(plan);
    hub.inferPhasesFromSpec({
      id: 'bps-test', version: 1, status: 'approved', implementationType: 'greenfield',
      problemStatement: 'Build a dbt pipeline.', objectives: [], successCriteria: [],
      scope: { in: [], out: [] }, constraints: [], assumptions: [], createdAt: '', updatedAt: ''
    });
    await withMock(mock, () => hub.generatePlan('build a pipeline'));
    hub.approvePlan();
    hub.confirmStages();
    assert.strictEqual(hub.getPlan().stagesConfirmed, true);

    hub.setPhaseOverride('validate', true);
    assert.strictEqual(hub.getPlan().stagesConfirmed, false, 'changing phase applicability invalidates the prior confirmation');
    assert.strictEqual(hub.getPlan().planApproved, true, 'Plan Approval itself is untouched by a phase override');
  });

  await test('PlanManager.patchGates() persists Plan Approval / Stage Confirmation without bumping the plan version', async () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-plan-gates-'));
    const contextRoot = { fsPath: tmpRoot, toString: () => tmpRoot };
    const mock = createMock();
    mock.workspace.fs.createDirectory = async (uri) => { fs.mkdirSync(uri.fsPath, { recursive: true }); };
    mock.workspace.fs.writeFile = async (uri, buf) => { fs.writeFileSync(uri.fsPath, buf); };
    mock.workspace.fs.rename = async (a, b) => { fs.renameSync(a.fsPath, b.fsPath); };
    mock.workspace.fs.readFile = async (uri) => { try { return fs.readFileSync(uri.fsPath); } catch { throw new Error('ENOENT'); } };
    mock.workspace.fs.stat = async (uri) => { if (fs.existsSync(uri.fsPath)) return {}; throw new Error('ENOENT'); };

    delete require.cache[require.resolve('../dist/context/PlanManager.js')];
    const { PlanManager } = withMock(mock, () => require('../dist/context/PlanManager.js'));
    const mgr = new PlanManager(contextRoot, () => {});
    await withMock(mock, () => mgr.initialize());
    await withMock(mock, () => mgr.savePlan({
      id: 'plan-1', objective: 'x', schemaContext: '', status: 'ready', steps: [], generationReason: 'initial'
    }));
    await withMock(mock, () => mgr.patchGates({ planApproved: true, planApprovedAt: 't1' }));
    await withMock(mock, () => mgr.patchGates({ stagesConfirmed: true, stagesConfirmedAt: 't2' }));

    let current = mgr.getPlan();
    assert.strictEqual(current.version, 1, 'patching gates does not bump the version');
    assert.strictEqual(current.planApproved, true);
    assert.strictEqual(current.stagesConfirmed, true);

    const mgr2 = new PlanManager(contextRoot, () => {});
    await withMock(mock, () => mgr2.initialize());
    current = mgr2.getPlan();
    assert.strictEqual(current.planApproved, true, 'gate fields round-trip through reload');
    assert.strictEqual(current.planApprovedAt, 't1');
    assert.strictEqual(current.stagesConfirmed, true);
    assert.strictEqual(current.stagesConfirmedAt, 't2');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

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
    const mgr = new SpecManager({ fsPath: '/ws/.ai-context' }, () => {});
    await withMock(mock, () => mgr.initialize());
    const spec = {
      id: 'bps-1', version: 1, status: 'draft', problemStatement: 'p', objectives: ['o'], successCriteria: [],
      scope: { in: ['a'], out: [] }, constraints: [], assumptions: [], domain: 'd', stakeholders: [], keyEntities: [],
      createdAt: 'c', updatedAt: 'u',
      implementationType: 'brownfield', implementationTypeReason: 'Manually set by user.', implementationTypeOverridden: true,
      problemStatementApproved: true
    };
    await withMock(mock, () => mgr.saveSpec(spec));
    const mgr2 = new SpecManager({ fsPath: '/ws/.ai-context' }, () => {});
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

  await test('selectTransformSpec() returns a validated spec for a well-formed fenced JSON response, merging in fixedParams last', async () => {
    const { selectTransformSpec } = require('../dist/agents/llmParamSelector.js');
    const step = { id: 's1', assignedAgent: 'ingestionAgent', taskDescription: 'Dedup customers by id', status: 'pending' };
    const context = baseAgentContext(async () => '```json\n{"kind": "dedup", "params": {"sourceObject": "src.c", "targetObject": "IGNORED", "partitionByColumns": ["customer_id"], "orderByColumn": "updated_at"}}\n```');
    const spec = await selectTransformSpec(context, step, ['dedup'], { targetObject: 'tgt.c_dedup' });
    assert.strictEqual(spec.kind, 'dedup');
    assert.strictEqual(spec.params.targetObject, 'tgt.c_dedup', 'fixedParams overrides whatever the LLM put in that field');
  });

  await test('selectTransformSpec() returns undefined (never throws) for malformed JSON, an out-of-candidate kind, or invalid params', async () => {
    const { selectTransformSpec } = require('../dist/agents/llmParamSelector.js');
    const step = { id: 's1', assignedAgent: 'ingestionAgent', taskDescription: 'x', status: 'pending' };

    const notJson = await selectTransformSpec(baseAgentContext(async () => 'Sure! Here is some SQL: SELECT 1;'), step, ['dedup']);
    assert.strictEqual(notJson, undefined);

    const wrongKind = await selectTransformSpec(baseAgentContext(async () => '```json\n{"kind": "incremental_load", "params": {}}\n```'), step, ['dedup']);
    assert.strictEqual(wrongKind, undefined, 'incremental_load was not in the candidate list');

    const missingParams = await selectTransformSpec(baseAgentContext(async () => '```json\n{"kind": "dedup", "params": {"sourceObject": "s"}}\n```'), step, ['dedup']);
    assert.strictEqual(missingParams, undefined, 'dedup requires targetObject/partitionByColumns/orderByColumn');

    const throwing = await selectTransformSpec(baseAgentContext(async () => { throw new Error('LLM down'); }), step, ['dedup']);
    assert.strictEqual(throwing, undefined);

    const noLlm = await selectTransformSpec(baseAgentContext(undefined), step, ['dedup']);
    assert.strictEqual(noLlm, undefined);
  });

  await test('generateViaPrimitiveOrFallback() compiles byte-identical SQL across two separate calls given the same LLM response', async () => {
    const { generateViaPrimitiveOrFallback } = require('../dist/agents/llmParamSelector.js');
    const step = { id: 's1', assignedAgent: 'ingestionAgent', taskDescription: 'Dedup customers by id, latest wins', status: 'pending' };
    const context = baseAgentContext(async () => '```json\n{"kind": "dedup", "params": {"sourceObject": "src.c", "targetObject": "tgt.c", "partitionByColumns": ["customer_id"], "orderByColumn": "updated_at"}}\n```');
    const target = { platform: 'snowflake', database: 'd', schema: 's' };

    const first = await generateViaPrimitiveOrFallback(context, step, ['dedup'], target, 'snowflake', async () => 'FREEHAND FALLBACK', () => 'TEMPLATE FALLBACK');
    const second = await generateViaPrimitiveOrFallback(context, step, ['dedup'], target, 'snowflake', async () => 'FREEHAND FALLBACK', () => 'TEMPLATE FALLBACK');

    assert.strictEqual(first.source, 'primitive');
    assert.strictEqual(second.source, 'primitive');
    assert.strictEqual(first.content, second.content, 'the LLM only chose kind+params — the compiler produced identical SQL both times');
  });

  await test('generateViaPrimitiveOrFallback() falls back to the freehand tier, then the template tier, when primitive selection fails', async () => {
    const { generateViaPrimitiveOrFallback } = require('../dist/agents/llmParamSelector.js');
    const step = { id: 's1', assignedAgent: 'ingestionAgent', taskDescription: 'x', status: 'pending' };
    const target = { platform: 'snowflake', database: 'd', schema: 's' };

    const noValidSpec = baseAgentContext(async () => 'not json at all');
    const freehandResult = await generateViaPrimitiveOrFallback(noValidSpec, step, ['dedup'], target, 'snowflake', async () => 'FREEHAND SQL', () => 'TEMPLATE SQL');
    assert.deepStrictEqual(freehandResult, { content: 'FREEHAND SQL', source: 'freehand' });

    const templateResult = await generateViaPrimitiveOrFallback(noValidSpec, step, ['dedup'], target, 'snowflake', async () => undefined, () => 'TEMPLATE SQL');
    assert.deepStrictEqual(templateResult, { content: 'TEMPLATE SQL', source: 'template' });
  });

  await test('generateViaPrimitiveOrFallback() honors context.transformSpec as a direct bypass of LLM selection', async () => {
    const { generateViaPrimitiveOrFallback } = require('../dist/agents/llmParamSelector.js');
    const step = { id: 's1', assignedAgent: 'ingestionAgent', taskDescription: 'x', status: 'pending' };
    const target = { platform: 'snowflake', database: 'd', schema: 's' };
    const context = { ...baseAgentContext(async () => { throw new Error('should never be called'); }),
      transformSpec: { kind: 'rename_cast', params: { sourceObject: 's.raw', targetObject: 't.clean', columns: [{ source: 'a', target: 'b' }] } } };

    const result = await generateViaPrimitiveOrFallback(context, step, ['rename_cast'], target, 'snowflake', async () => 'FREEHAND', () => 'TEMPLATE');
    assert.strictEqual(result.source, 'primitive');
    assert.ok(result.content.includes('t.clean'));
  });

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

  await test('parsePipelineSpecResponse() takes targetPlatform from the approved Target Context, not an LLM re-guess, when the LLM omits it', () => {
    const { parsePipelineSpecResponse } = require('../dist/agents/pipelineSpecSynthesis.js');
    const bps = { id: 'bps-1', version: 1, status: 'approved', problemStatement: 'p', objectives: ['o'], successCriteria: [], scope: { in: ['x'], out: [] }, constraints: [], assumptions: [], createdAt: 'c', updatedAt: 'u' };
    const inputs = { bps, targetContext: { specId: 'bps-1', specVersion: 1, status: 'approved', platform: 'databricks', answers: {} } };
    const llmResponse = { entities: [{ name: 'e1', source: { object: 's', type: 'table' }, transforms: [], target: { object: 't', materialization: 'view' } }] };
    const result = parsePipelineSpecResponse(llmResponse, inputs);
    assert.strictEqual(result.targetPlatform, 'databricks', 'targetPlatform came from Target Context, not a guess, since the LLM response omitted it');
  });

  await test('parsePipelineSpecResponse() bumps version only when revising an approved predecessor, and rejects an invalid entities shape', () => {
    const { parsePipelineSpecResponse } = require('../dist/agents/pipelineSpecSynthesis.js');
    const bps = { id: 'bps-1', version: 1, status: 'approved', problemStatement: 'p', objectives: ['o'], successCriteria: [], scope: { in: ['x'], out: [] }, constraints: [], assumptions: [], createdAt: 'c', updatedAt: 'u' };
    const validEntities = { entities: [{ name: 'e1', source: { object: 's', type: 'table' }, transforms: [], target: { object: 't', materialization: 'view' } }] };

    const first = parsePipelineSpecResponse(validEntities, { bps });
    assert.strictEqual(first.version, 1);

    const approvedPrevious = { ...first, status: 'approved' };
    const revision = parsePipelineSpecResponse(validEntities, { bps, previous: approvedPrevious });
    assert.strictEqual(revision.version, 2, 'revising an approved predecessor bumps the version');
    assert.strictEqual(revision.id, approvedPrevious.id, 'the id is carried forward, not regenerated');

    assert.throws(() => parsePipelineSpecResponse({ entities: [{ name: 'e1' }] }, { bps }), /source|target|transforms/i, 'an entity missing required blocks fails Ajv validation');
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

  await test('parseAttachmentExtract() extracts entities/columns from a well-formed response, which then flow into the Pipeline Spec synthesis prompt', () => {
    const { parseAttachmentExtract } = require('../dist/core/attachmentExtraction.js');
    const { buildPipelineSpecSynthesisPrompt } = require('../dist/agents/pipelineSpecSynthesis.js');
    const attachment = { id: 'att-1', path: 'schema.sql', content: 'CREATE TABLE orders (order_id INT, status STRING);', attachedAt: 'c' };
    const extract = parseAttachmentExtract({
      entities: [{ name: 'orders', columns: [{ name: 'order_id', type: 'INT' }, { name: 'status', type: 'STRING' }] }],
      rawSummary: 'An orders table.',
      confidence: 'high'
    }, attachment);
    assert.strictEqual(extract.entities[0].name, 'orders');
    assert.strictEqual(extract.entities[0].columns.length, 2);

    const bps = { id: 'bps-1', version: 1, status: 'approved', problemStatement: 'p', objectives: ['o'], successCriteria: [], scope: { in: ['x'], out: [] }, constraints: [], assumptions: [], createdAt: 'c', updatedAt: 'u' };
    const { user } = buildPipelineSpecSynthesisPrompt({ bps, attachmentExtracts: [extract] });
    assert.ok(user.includes('orders(order_id, status)'), 'the extracted entity/columns are visible to the LLM in the synthesis prompt, not just the raw attachment text');
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

  await test('AttachmentStore persists an attachment beyond the discovery session and lists it back, tolerating a corrupt sibling file', async () => {
    function fsDirMock() {
      const files = new Map(); // dirPath -> Map(filename -> content)
      const keyOf = (uri) => (uri && uri.fsPath) ? uri.fsPath : String(uri);
      return {
        FileType: { File: 1, Directory: 2 },
        Uri: { joinPath: (...parts) => ({ fsPath: parts.map((p) => (p && p.fsPath) ? p.fsPath : String(p)).join('/') }) },
        workspace: { fs: {
          createDirectory: async () => {},
          writeFile: async (uri, buf) => {
            const p = keyOf(uri);
            const dir = p.slice(0, p.lastIndexOf('/'));
            const name = p.slice(p.lastIndexOf('/') + 1);
            if (!files.has(dir)) files.set(dir, new Map());
            files.get(dir).set(name, buf.toString('utf8'));
          },
          rename: async (a, b) => {
            const ap = keyOf(a), bp = keyOf(b);
            const adir = ap.slice(0, ap.lastIndexOf('/')), aname = ap.slice(ap.lastIndexOf('/') + 1);
            const bdir = bp.slice(0, bp.lastIndexOf('/')), bname = bp.slice(bp.lastIndexOf('/') + 1);
            const content = files.get(adir)?.get(aname);
            files.get(adir)?.delete(aname);
            if (!files.has(bdir)) files.set(bdir, new Map());
            files.get(bdir).set(bname, content);
          },
          readFile: async (uri) => {
            const p = keyOf(uri);
            const dir = p.slice(0, p.lastIndexOf('/'));
            const name = p.slice(p.lastIndexOf('/') + 1);
            const content = files.get(dir)?.get(name);
            if (content === undefined) throw new Error('ENOENT');
            return Buffer.from(content, 'utf8');
          },
          readDirectory: async (uri) => {
            const dir = keyOf(uri);
            const entries = files.get(dir);
            if (!entries) throw new Error('ENOENT');
            return [...entries.keys()].map((name) => [name, 1]);
          }
        } }
      };
    }
    const mock = fsDirMock();
    try { delete require.cache[require.resolve('../dist/context/AttachmentStore.js')]; } catch { /* not loaded */ }
    const { AttachmentStore } = withMock(mock, () => require('../dist/context/AttachmentStore.js'));
    const store = new AttachmentStore({ fsPath: '/ws' });

    await withMock(mock, () => store.save({ id: 'att-1', path: 'a.txt', content: 'hello', attachedAt: 'c', extract: { attachmentId: 'att-1', extractedAt: 'c', rawSummary: 'hi', confidence: 'low' } }));
    // A corrupt/unreadable sibling file must not prevent listing the good one.
    await mock.workspace.fs.writeFile({ fsPath: '/ws/attachments/broken.yaml' }, Buffer.from('foo: [1, 2', 'utf8'));

    const listed = await withMock(mock, () => store.list());
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].id, 'att-1');
    assert.strictEqual(listed[0].extract.rawSummary, 'hi');
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

  await test('selectTransformSpec() never offers a draft/deprecated Tier-2 primitive to the LLM as a candidate, but compileTransformSpec() still compiles it directly', async () => {
    const registry = require('../dist/engine/transforms/registry.js');
    const { createDeclarativePrimitive } = require('../dist/engine/transforms/declarative/adapter.js');
    const { selectTransformSpec } = require('../dist/agents/llmParamSelector.js');
    const yaml = require('yaml');

    const draftDef = yaml.parse(validPrimitiveDefinitionYaml('window_running_total_draft'));
    draftDef.status = 'draft';
    registry.registerPrimitives([createDeclarativePrimitive(draftDef)]);

    const step = { id: 's1', assignedAgent: 'ingestionAgent', taskDescription: 'x', status: 'pending' };
    // Even if the LLM somehow guesses the draft kind, it must not be accepted.
    const context = { objective: 'o', schemaContext: '', sourceProvider: 'snowflake', settings: {}, configManager: { getSecret: async () => undefined, getSettings: () => ({}) }, log: () => {},
      callLlm: async (prompt) => {
        assert.ok(!prompt.includes('window_running_total_draft'), 'the draft kind must not even appear in the candidate catalog shown to the LLM');
        return `\`\`\`json\n{"kind": "window_running_total_draft", "params": ${JSON.stringify(draftDef.previewParams)}}\n\`\`\``;
      }
    };
    const result = await selectTransformSpec(context, step, ['window_running_total_draft']);
    assert.strictEqual(result, undefined, 'a non-selectable kind is rejected even if the LLM returns it');

    // But it still compiles directly — a deprecated/draft primitive stays usable by anything that already references it.
    const compiled = registry.compileTransformSpec({ kind: 'window_running_total_draft', params: draftDef.previewParams }, { platform: 'snowflake', database: 'd', schema: 's' }, 'snowflake');
    assert.ok(compiled.content.includes('running_total'));

    registry.resetDeclarativePrimitives();
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

  await test('DatabricksAdapter.connect() (Phase 3b) rejects a CLI-derived profile credential with an explanation, since Databricks has no native-protocol CLI path unlike Snowflake', async () => {
    const mock = createMock();
    const { DatabricksAdapter } = freshAdapterModule(mock, '../dist/engine/platform/adapters/DatabricksAdapter.js');
    const adapter = new DatabricksAdapter({ profile: 'FinanceIQ', authMode: 'databrickscfg' }, () => {});
    await assert.rejects(() => withMock(mock, () => adapter.connect()), /no CLI-based native execution path/);

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

  await test('SemanticLayerManager.build() captures the live shared graph\'s current content/counts as a spec-pinned snapshot, and archives the prior graph content (not just metadata) on revising an approved predecessor', async () => {
    const mock = mappingFsMapMock();
    try { delete require.cache[require.resolve('../dist/context/SemanticLayerManager.js')]; } catch { /* not loaded */ }
    try { delete require.cache[require.resolve('../dist/context/GraphManager.js')]; } catch { /* not loaded */ }
    const { SemanticLayerManager } = withMock(mock, () => require('../dist/context/SemanticLayerManager.js'));
    const { GraphManager } = withMock(mock, () => require('../dist/context/GraphManager.js'));

    const graph = new GraphManager();
    await graph.addNode({ id: 't1', type: 'table', label: 'orders', database: 'db', schema: 's', fqn: 'db.s.orders', isView: false, metadata: {}, version: 1 });
    await graph.addNode({ id: 'c1', type: 'column', label: 'order_id', dataType: 'INT', isNullable: false, isPrimaryKey: true, isForeignKey: false, metadata: {}, version: 1 });
    await graph.addEdge({ id: 'e1', source: 't1', target: 'c1', type: 'contains' });

    const mgr = new SemanticLayerManager({ fsPath: '/ws' }, graph, () => {});
    await withMock(mock, () => mgr.initialize());
    assert.strictEqual(mgr.getSnapshot(), undefined);

    const built = await withMock(mock, () => mgr.build('bps-1', 1));
    assert.strictEqual(built.nodeCount, 2);
    assert.strictEqual(built.edgeCount, 1);
    assert.strictEqual(built.version, 1);

    const graphContent = await withMock(mock, () => mgr.getGraphContent());
    assert.strictEqual(graphContent.nodes.length, 2);
    assert.strictEqual(graphContent.edges.length, 1);

    await withMock(mock, () => mgr.save({ ...mgr.getSnapshot(), status: 'approved' }));
    assert.strictEqual(mgr.getSnapshot().version, 1, 'approving a not-yet-approved snapshot must not bump the version');

    await graph.addNode({ id: 't2', type: 'table', label: 'customers', database: 'db', schema: 's', fqn: 'db.s.customers', isView: false, metadata: {}, version: 1 });
    const rebuilt = await withMock(mock, () => mgr.build('bps-1', 1));
    assert.strictEqual(rebuilt.version, 2, 'revising an approved predecessor bumps the version');
    assert.strictEqual(rebuilt.nodeCount, 3, 'the rebuild captures the graph\'s current (updated) content');
    assert.strictEqual(mock.store.has('/ws/context/history/semantic-layer.spec1.v1.yaml'), true, 'the approved v1 predecessor\'s metadata was archived');
    assert.strictEqual(mock.store.has('/ws/context/history/semantic-layer.spec1.v1.json'), true, 'the approved v1 predecessor\'s captured graph content was archived too, not just its metadata');
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

  await test('v0.25.0: Source/Target/Mapping/Semantic-layer managers reload external edits and refuse stale saves', async () => {
    const cases = [
      ['../dist/context/SourceContextManager.js', 'SourceContextManager', 'source-context.yaml', { specId: 's', specVersion: 1, status: 'pending', sources: [], answers: {} }],
      ['../dist/context/TargetContextManager.js', 'TargetContextManager', 'target-context.yaml', { specId: 's', specVersion: 1, status: 'pending', answers: {} }],
      ['../dist/context/MappingContextManager.js', 'MappingContextManager', 'mapping-context.yaml', { specId: 's', specVersion: 1, status: 'pending', mappings: [] }],
      ['../dist/context/SemanticLayerManager.js', 'SemanticLayerManager', 'semantic-layer.yaml', { specId: 's', specVersion: 1, status: 'pending', nodeCount: 0, edgeCount: 0 }]
    ];
    for (const [rel, cls, fileName, record] of cases) {
      const { mock, store } = revisionFsMock();
      const Ctor = loadFresh(mock, rel)[cls];
      const { RevisionConflictError } = withMock(mock, () => require('../dist/engine/context/contextStore.js'));
      const mgr = cls === 'SemanticLayerManager' ? new Ctor({ fsPath: '/ws/p1' }, { serializeSnapshot: () => ({ nodes: [], edges: [] }) }, () => {}) : new Ctor({ fsPath: '/ws/p1' }, () => {});
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
    handlers.change({ fsPath: '/ws/.ai-context/problems/p1/spec/.business-problem.tmp.123.yaml' });
    handlers.create({ fsPath: '/ws/.ai-context/problems/p1/spec/history/business-problem.v1.draft.yaml' });
    handlers.change({ fsPath: '/ws/.ai-context/problems/p1/spec/business-problem.yaml' });
    handlers.change({ fsPath: '/ws/.ai-context/problems/p1/spec/business-problem.yaml' });
    handlers.delete({ fsPath: '/ws/.ai-context/problems/p1/context/source-context.yaml' });
    await new Promise((r) => setTimeout(r, 40));
    watcher.dispose();
    assert.deepStrictEqual(seen.sort(), ['/ws/.ai-context/problems/p1/context/source-context.yaml', '/ws/.ai-context/problems/p1/spec/business-problem.yaml']);
  });

  await test('v0.25.0: AgentHub.pauseForExternalChange() only arms a pause while a run is in progress', async () => {
    const mock = createMock();
    delete require.cache[require.resolve('../dist/core/agentHub.js')];
    const { DataAgentHubHub } = withMock(mock, () => require('../dist/core/agentHub.js'));
    const logs = [];
    const hub = new DataAgentHubHub(fakeCm({}));
    hub.setLogListener((m) => logs.push(m));
    hub.pauseForExternalChange('spec changed');
    assert.strictEqual(hub.executionPaused, false, 'idle hub: nothing to pause');
    assert.strictEqual(logs.length, 0);
    hub.state.status = 'running';
    hub.pauseForExternalChange('spec changed');
    assert.strictEqual(hub.executionPaused, true);
    assert.ok(logs.some((m) => m.includes('spec changed') && m.includes('after the current step')));
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

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });