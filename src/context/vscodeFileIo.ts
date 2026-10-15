import type * as vscode from 'vscode';
import { FileIo } from '../engine/context/contextStore';

/**
 * The engine's `FileIo` over `vscode.workspace.fs` (v0.26.0), so extension-side
 * managers keep working in remote and virtual workspaces where Node's `fs`
 * can't reach the files.
 *
 * Takes the VS Code API from its caller instead of importing it at runtime:
 * each manager passes the `vscode` it was loaded with, which keeps this module
 * free of a runtime `vscode` dependency (and keeps the functional tests'
 * per-module vscode mocks from leaking between modules through a shared one).
 */
export function createVscodeFileIo(api: Pick<typeof vscode, 'workspace' | 'Uri'>): FileIo {
  return {
    async readFile(filePath) {
      try {
        return await api.workspace.fs.readFile(api.Uri.file(filePath));
      } catch {
        return undefined;
      }
    },
    writeFile: async (filePath, content) => { await api.workspace.fs.writeFile(api.Uri.file(filePath), content); },
    rename: async (from, to) => { await api.workspace.fs.rename(api.Uri.file(from), api.Uri.file(to), { overwrite: true }); },
    mkdirp: async (dirPath) => { await api.workspace.fs.createDirectory(api.Uri.file(dirPath)); },
    async listDir(dirPath) {
      try {
        return (await api.workspace.fs.readDirectory(api.Uri.file(dirPath))).map(([name]) => name);
      } catch {
        return undefined;
      }
    },
    deleteFile: async (filePath) => { await api.workspace.fs.delete(api.Uri.file(filePath)); }
  };
}
