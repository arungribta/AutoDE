'use strict';
/**
 * A headless stand-in for the `vscode` module, backed by the real file system, so the eval
 * harness can run AutoDE's actual extension-side code (GraphManager, ContextFileManager,
 * AgentHub, the agents) in plain Node. Only the surface those modules touch is provided.
 * Interactive prompts resolve to "declined" — the harness never approves anything on a
 * user's behalf.
 */
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

function uriOf(p) {
  return { fsPath: p, path: p, scheme: 'file', toString: () => p };
}

function createVscodeHost({ workspaceDir, settings = {} }) {
  const noopDisposable = { dispose() {} };
  const vscode = {
    Uri: {
      file: (p) => uriOf(p),
      joinPath: (base, ...parts) => uriOf(path.join(base.fsPath, ...parts))
    },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    EventEmitter: class { constructor() { this.event = () => noopDisposable; } fire() {} dispose() {} },
    CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: () => noopDisposable }; } cancel() {} dispose() {} },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    LanguageModelChatMessage: { User: (c) => ({ role: 1, content: c }), Assistant: (c) => ({ role: 2, content: c }) },
    workspace: {
      workspaceFolders: [{ uri: uriOf(workspaceDir), name: path.basename(workspaceDir), index: 0 }],
      getConfiguration: () => ({ get: (key, fallback) => (key in settings ? settings[key] : fallback), update: async () => {} }),
      createFileSystemWatcher: () => ({ onDidChange: () => noopDisposable, onDidCreate: () => noopDisposable, onDidDelete: () => noopDisposable, dispose() {} }),
      fs: {
        readFile: async (uri) => fs.readFileSync(uri.fsPath),
        writeFile: async (uri, content) => { fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true }); fs.writeFileSync(uri.fsPath, content); },
        rename: async (from, to) => { fs.renameSync(from.fsPath, to.fsPath); },
        createDirectory: async (uri) => { fs.mkdirSync(uri.fsPath, { recursive: true }); },
        delete: async (uri) => { fs.rmSync(uri.fsPath, { recursive: true, force: true }); },
        stat: async (uri) => { const s = fs.statSync(uri.fsPath); return { type: s.isDirectory() ? 2 : 1, size: s.size }; },
        readDirectory: async (uri) => fs.readdirSync(uri.fsPath, { withFileTypes: true }).map((e) => [e.name, e.isDirectory() ? 2 : 1])
      }
    },
    window: {
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} })
    },
    commands: { registerCommand: () => noopDisposable, executeCommand: async () => undefined },
    extensions: { getExtension: () => undefined, all: [] },
    lm: { selectChatModels: async () => [] }
  };
  return vscode;
}

/** Routes `require('vscode')` to the host for the rest of the process. */
function installVscodeHost(host) {
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'vscode') return host;
    return original.call(this, request, ...rest);
  };
  return () => { Module._load = original; };
}

module.exports = { createVscodeHost, installVscodeHost };
