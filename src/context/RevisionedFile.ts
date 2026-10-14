import type * as vscode from 'vscode';
import { createHash } from 'node:crypto';

/**
 * Compare-and-swap persistence for one `.ai-context` file (v0.25.0, Phase 1
 * of docs/mcp-engine-requirements.md §8). Every manager that caches a YAML
 * document in memory (`SpecManager`, `PipelineSpecManager`, the Source/
 * Target/Mapping context managers, `SemanticLayerManager`) reads and writes
 * through one of these, so a file edited by another process — Claude Code,
 * Copilot, `git pull`, a second VS Code window — is never silently
 * overwritten by a stale in-memory copy.
 *
 * A *revision* is the SHA-256 of the file's bytes; `undefined` means the
 * file was absent. The revision the owner last read or wrote is the
 * "expected" one; a write is refused with `RevisionConflictError` if the
 * file on disk no longer matches it.
 *
 * Takes the VS Code API from its owner instead of importing it at runtime:
 * the owning manager supplies the `vscode` it was loaded with, and this
 * module stays free of a runtime `vscode` dependency until Phase 2 replaces
 * it with the engine layer's node-fs `ContextStore`.
 */

/** The slice of the VS Code API this needs — `workspace.fs` and `Uri.joinPath`. */
export type WorkspaceFsApi = Pick<typeof vscode, 'workspace' | 'Uri'>;

export function computeRevision(content: Uint8Array | string): string {
  return createHash('sha256').update(typeof content === 'string' ? Buffer.from(content, 'utf8') : content).digest('hex');
}

export class RevisionConflictError extends Error {
  public constructor(
    public readonly uri: vscode.Uri,
    public readonly label: string,
    public readonly expectedRevision: string | undefined,
    public readonly actualRevision: string | undefined,
    private readonly overwriteFn: () => Promise<void>
  ) {
    super(`${label} changed on disk since AutoDE loaded it — your change was not saved.`);
    this.name = 'RevisionConflictError';
  }

  /**
   * Writes the refused content anyway, discarding the external change. Does
   * NOT update the owner's in-memory copy or expected revision — the caller
   * follows up with the owner's `reload()`, which then sees a changed file
   * and re-reads it, so memory and disk end up consistent through the one
   * normal reload path.
   */
  public overwrite(): Promise<void> {
    return this.overwriteFn();
  }
}

export type RevisionConflictHandler = (conflict: RevisionConflictError) => void;

let conflictHandler: RevisionConflictHandler | undefined;

/**
 * Registers the one UI-side handler notified on every conflict (the webview
 * provider's Reload/Overwrite prompt). Notified *before* the error is thrown,
 * so the prompt appears even when the caller catches the error and only logs
 * it — several webview message handlers do exactly that.
 */
export function setRevisionConflictHandler(handler: RevisionConflictHandler | undefined): void {
  conflictHandler = handler;
}

export type ReloadResult<T> =
  | { status: 'unchanged' }
  | { status: 'removed' }
  | { status: 'updated'; value: T }
  | { status: 'invalid'; error: string };

export class RevisionedFile {
  private readonly fileUri: vscode.Uri;
  private expectedRevision: string | undefined;

  public constructor(
    private readonly api: WorkspaceFsApi,
    private readonly dirUri: vscode.Uri,
    private readonly fileName: string,
    private readonly label: string
  ) {
    this.fileUri = api.Uri.joinPath(dirUri, fileName);
  }

  public getUri(): vscode.Uri {
    return this.fileUri;
  }

  /** Reads the file and adopts its revision as the expected one. `undefined` when the file is absent. */
  public async read(): Promise<string | undefined> {
    const bytes = await this.readBytes();
    this.expectedRevision = bytes ? computeRevision(bytes) : undefined;
    return bytes ? Buffer.from(bytes).toString('utf8') : undefined;
  }

  /**
   * Re-reads after an external change. Adopts the new revision only when the
   * content parses — a half-written or invalid external edit leaves the
   * expected revision stale, so the owner's next save is refused rather than
   * clobbering whatever the user is in the middle of editing.
   */
  public async reload<T>(parse: (content: string) => T): Promise<ReloadResult<T>> {
    const bytes = await this.readBytes();
    const revision = bytes ? computeRevision(bytes) : undefined;
    if (revision === this.expectedRevision) return { status: 'unchanged' };
    if (!bytes) {
      this.expectedRevision = undefined;
      return { status: 'removed' };
    }
    try {
      const value = parse(Buffer.from(bytes).toString('utf8'));
      this.expectedRevision = revision;
      return { status: 'updated', value };
    } catch (err) {
      return { status: 'invalid', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Atomic write (temp file + rename), refused if the file changed on disk since it was last read or written. */
  public async write(content: string): Promise<void> {
    const bytes = await this.readBytes();
    const actual = bytes ? computeRevision(bytes) : undefined;
    if (actual !== this.expectedRevision) {
      const conflict = new RevisionConflictError(this.fileUri, this.label, this.expectedRevision, actual, () => this.writeRaw(content));
      conflictHandler?.(conflict);
      throw conflict;
    }
    await this.writeRaw(content);
    this.expectedRevision = computeRevision(content);
  }

  private async writeRaw(content: string): Promise<void> {
    await this.api.workspace.fs.createDirectory(this.dirUri);
    const dot = this.fileName.lastIndexOf('.');
    const base = dot > 0 ? this.fileName.slice(0, dot) : this.fileName;
    const ext = dot > 0 ? this.fileName.slice(dot) : '';
    const tempUri = this.api.Uri.joinPath(this.dirUri, `.${base}.tmp.${Date.now()}${ext}`);
    await this.api.workspace.fs.writeFile(tempUri, Buffer.from(content, 'utf8'));
    await this.api.workspace.fs.rename(tempUri, this.fileUri, { overwrite: true });
  }

  private async readBytes(): Promise<Uint8Array | undefined> {
    try {
      return await this.api.workspace.fs.readFile(this.fileUri);
    } catch {
      return undefined;
    }
  }
}

/**
 * Applies a `ReloadResult` to a manager's cached value and logs the outcome
 * — the shared body of every manager's `reload()`. Returns true when the
 * cached value changed.
 */
export function applyReload<T>(result: ReloadResult<T>, label: string, log: (msg: string) => void, set: (value: T | undefined) => void): boolean {
  switch (result.status) {
    case 'unchanged':
      return false;
    case 'removed':
      set(undefined);
      log(`${label} was removed on disk — cleared the loaded copy.`);
      return true;
    case 'updated':
      set(result.value);
      log(`${label} changed on disk — reloaded.`);
      return true;
    case 'invalid':
      log(`${label} changed on disk but could not be parsed (${result.error}) — keeping the loaded copy; saving will ask before overwriting.`);
      return false;
  }
}
