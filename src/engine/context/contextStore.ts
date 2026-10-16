import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';

/**
 * Compare-and-swap persistence for `.autode` files (v0.25.0, moved into
 * the engine layer in v0.26.0 — docs/mcp-engine-requirements.md §4.3/§8).
 *
 * A *revision* is the SHA-256 of a file's bytes; `undefined` means the file
 * is absent. A write states the revision it expects to replace and is
 * refused with `RevisionConflictError` if the file on disk no longer matches
 * — so a file another process edited (Claude Code, Copilot, `git pull`, the
 * MCP server, a second window) is never silently overwritten by a stale copy.
 *
 * All I/O goes through a `FileIo`, so the same logic runs over Node's `fs`
 * (the MCP server, tests) and over `vscode.workspace.fs` (the extension —
 * see `src/context/vscodeFileIo.ts`, which keeps remote/virtual workspaces
 * working). Paths are plain strings, used exactly as given: separators are
 * preserved, never normalized, so a caller's paths and this module's agree.
 */

export interface FileIo {
  /** `undefined` when the file does not exist. */
  readFile(filePath: string): Promise<Uint8Array | undefined>;
  writeFile(filePath: string, content: Uint8Array): Promise<void>;
  /** Must replace an existing `to`. */
  rename(from: string, to: string): Promise<void>;
  mkdirp(dirPath: string): Promise<void>;
  /** File names (not paths) in a directory; `undefined` when it does not exist. Optional: the C2 ledger needs it. */
  listDir?(dirPath: string): Promise<string[] | undefined>;
  /** Optional: only ledger pruning uses it. */
  deleteFile?(filePath: string): Promise<void>;
}

export const nodeFileIo: FileIo = {
  async readFile(filePath) {
    try {
      return await fsp.readFile(filePath);
    } catch {
      return undefined;
    }
  },
  writeFile: (filePath, content) => fsp.writeFile(filePath, content),
  rename: (from, to) => fsp.rename(from, to),
  mkdirp: async (dirPath) => { await fsp.mkdir(dirPath, { recursive: true }); },
  async listDir(dirPath) {
    try {
      return await fsp.readdir(dirPath);
    } catch {
      return undefined;
    }
  },
  deleteFile: async (filePath) => { await fsp.rm(filePath, { force: true }); }
};

export function computeRevision(content: Uint8Array | string): string {
  return createHash('sha256').update(typeof content === 'string' ? Buffer.from(content, 'utf8') : content).digest('hex');
}

/** Splits a path at its last separator, keeping whichever separator it used. */
function splitPath(filePath: string): { dir: string; sep: string; name: string } {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (idx < 0) return { dir: '.', sep: '/', name: filePath };
  return { dir: filePath.slice(0, idx), sep: filePath[idx], name: filePath.slice(idx + 1) };
}

/** Atomic write: a dot-prefixed temp file beside the target, then rename over it. */
export async function writeFileAtomic(io: FileIo, filePath: string, content: string): Promise<void> {
  const { dir, sep, name } = splitPath(filePath);
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  await io.mkdirp(dir);
  const tempPath = `${dir}${sep}.${base}.tmp.${Date.now()}${ext}`;
  await io.writeFile(tempPath, Buffer.from(content, 'utf8'));
  await io.rename(tempPath, filePath);
}

export class RevisionConflictError extends Error {
  public constructor(
    public readonly filePath: string,
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

/** Stateless revision-checked reads and writes. */
export class ContextStore {
  public constructor(private readonly io: FileIo = nodeFileIo) {}

  public async read(filePath: string): Promise<{ content?: string; revision?: string }> {
    const bytes = await this.io.readFile(filePath);
    if (!bytes) return {};
    return { content: Buffer.from(bytes).toString('utf8'), revision: computeRevision(bytes) };
  }

  /**
   * Writes `content` only if the file's current revision equals
   * `expectedRevision` (`undefined` = "expected absent"). Returns the new
   * revision; throws `RevisionConflictError` otherwise.
   */
  public async write(filePath: string, content: string, expectedRevision: string | undefined, label = filePath): Promise<string> {
    const bytes = await this.io.readFile(filePath);
    const actual = bytes ? computeRevision(bytes) : undefined;
    if (actual !== expectedRevision) {
      const conflict = new RevisionConflictError(filePath, label, expectedRevision, actual, () => writeFileAtomic(this.io, filePath, content));
      conflictHandler?.(conflict);
      throw conflict;
    }
    await writeFileAtomic(this.io, filePath, content);
    return computeRevision(content);
  }
}

export type ReloadResult<T> =
  | { status: 'unchanged' }
  | { status: 'removed' }
  | { status: 'updated'; value: T }
  | { status: 'invalid'; error: string };

/**
 * One file owned by one in-memory cache (a spec/context manager). Remembers
 * the revision the owner last read or wrote, so the owner never has to.
 */
export class RevisionedFile {
  private expectedRevision: string | undefined;

  public constructor(
    private readonly store: ContextStore,
    public readonly filePath: string,
    private readonly label: string
  ) {}

  /** Reads the file and adopts its revision as the expected one. `undefined` when absent. */
  public async read(): Promise<string | undefined> {
    const { content, revision } = await this.store.read(this.filePath);
    this.expectedRevision = revision;
    return content;
  }

  /**
   * Re-reads after an external change. Adopts the new revision only when the
   * content parses — a half-written or invalid external edit leaves the
   * expected revision stale, so the owner's next save is refused rather than
   * clobbering whatever the user is in the middle of editing.
   */
  public async reload<T>(parse: (content: string) => T): Promise<ReloadResult<T>> {
    const { content, revision } = await this.store.read(this.filePath);
    if (revision === this.expectedRevision) return { status: 'unchanged' };
    if (content === undefined) {
      this.expectedRevision = undefined;
      return { status: 'removed' };
    }
    try {
      const value = parse(content);
      this.expectedRevision = revision;
      return { status: 'updated', value };
    } catch (err) {
      return { status: 'invalid', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Atomic write, refused if the file changed on disk since it was last read or written. */
  public async write(content: string): Promise<void> {
    this.expectedRevision = await this.store.write(this.filePath, content, this.expectedRevision, this.label);
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
