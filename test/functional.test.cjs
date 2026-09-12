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
      id: 'bps-it', version: 3, status: 'approved',
      problemStatement: 'Ingest raw sales channel source data and load dbt pipelines, then document the results.',
      objectives: ['ingest channel data'], successCriteria: ['pipeline runs'],
      scope: { in: [], out: [] }, constraints: [], assumptions: [], createdAt: '', updatedAt: ''
    };
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
    const { parseSkillDefinition } = require('../dist/core/skillRegistry.js');
    const skill = parseSkillDefinition({ id: 'x', name: 'X', systemPrompt: 'p', specFields: ['a', 'b', 1, ''] });
    assert.strictEqual(skill.id, 'x');
    assert.deepStrictEqual(skill.specFields, ['a', 'b']);
    assert.strictEqual(skill.order, 0);
    assert.throws(() => parseSkillDefinition({ name: 'No id' }), /requires an "id"/);
    assert.throws(() => parseSkillDefinition({ id: 'y', name: 'Y' }), /systemPrompt/);
  });

  await test('SkillRegistry orders skills and maps fields', () => {
    const { SkillRegistry } = require('../dist/core/skillRegistry.js');
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
    const { loadSkillsFromDirectory } = require('../dist/core/skillRegistry.js');
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
    const { parseYaml, stringifyYaml } = require('../dist/context/Yaml.js');
    const input = { business_terms: [{ term: 'revenue', description: 'net sales' }], flags: { enabled: true, n: 3 } };
    const parsed = parseYaml(stringifyYaml(input));
    assert.deepStrictEqual(parsed, input);
    assert.deepStrictEqual(parseYaml('a: 1\nb:\n  - x\n  - y'), { a: 1, b: ['x', 'y'] });
  });

  await test('ContextValidator validates the envelope schema', () => {
    const { ContextValidator } = require('../dist/context/ContextValidator.js');
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
    const mgr = new SpecManager({ fsPath: '/ws' }, () => {});
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
    const mgr = new SpecManager({ fsPath: '/ws' }, () => {});
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
    const mgr = new SpecManager({ fsPath: '/ws' }, () => {});
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
    const mgr2 = new SpecManager({ fsPath: '/ws' }, () => {});
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

    assert.ok(fs.existsSync(path.join(tmpRoot, 'auto-de', '03-build', 'bps-1.v1', 'a1.sql')), 'v1 artifact under its spec-tagged folder');
    assert.ok(fs.existsSync(path.join(tmpRoot, 'auto-de', '03-build', 'bps-1.v2', 'a2.sql')), 'v2 artifact under its spec-tagged folder');
    assert.ok(fs.existsSync(path.join(tmpRoot, 'auto-de', '03-build', 'legacy.sql')), 'unstamped artifact has no version folder');

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
    const { parseSkillMarkdown } = withMock(mock, () => require('../dist/core/toolSkills.js'));
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
    const { loadToolSkillsFromDirectory } = withMock(mock, () => require('../dist/core/toolSkills.js'));
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
    const { loadToolSkillsFromDirectory } = withMock(mock, () => require('../dist/core/toolSkills.js'));
    assert.deepStrictEqual(loadToolSkillsFromDirectory('/no/such/directory/at/all'), []);
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });