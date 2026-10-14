import * as vscode from 'vscode';
import * as path from 'node:path';

/**
 * Recursive watcher over every `.ai-context/**` YAML/JSON file (v0.25.0,
 * docs/mcp-engine-requirements.md §8). `ContextFileManager`'s own watcher
 * only ever covered the top-level `.ai-context/*` business-context files, so
 * a change to a business problem's `spec/` or `context/` files — made by any
 * other process — went unnoticed and the cached copy went stale. This one
 * reports each changed path (debounced per path) so the owner can route it
 * to the right manager's `reload()`; it doesn't know about managers itself.
 */
export class ContextFileWatcher implements vscode.Disposable {
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  public constructor(
    workspaceRoot: vscode.Uri,
    private readonly onChange: (uri: vscode.Uri) => void,
    private readonly debounceMs = 300
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, '.ai-context/**/*.{yaml,yml,json}')
    );
    const handle = (uri: vscode.Uri): void => this.schedule(uri);
    this.watcher.onDidChange(handle);
    this.watcher.onDidCreate(handle);
    this.watcher.onDidDelete(handle);
  }

  /**
   * Temp files (`.<name>.tmp.*`, written then renamed by every atomic write)
   * and `history/` archives (immutable once written) never need a reload.
   */
  public static isRelevant(fsPath: string): boolean {
    if (path.basename(fsPath).startsWith('.')) return false;
    return !fsPath.split(/[\\/]/).includes('history');
  }

  public dispose(): void {
    this.watcher.dispose();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(uri: vscode.Uri): void {
    if (!ContextFileWatcher.isRelevant(uri.fsPath)) return;
    const key = normalizeFsPath(uri.fsPath);
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this.onChange(uri);
    }, this.debounceMs));
  }
}

/** Path key for comparing two file locations — case-insensitive on Windows, where the file system is. */
export function normalizeFsPath(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
