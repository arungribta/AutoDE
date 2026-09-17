import * as vscode from 'vscode';
import { ChatMessage, ChatSessionMeta } from '../core/types';

/**
 * Persists chat sessions — independent of Business Problem Specification
 * identity (Phase F, v0.9.0). One `.meta.json` + one `.jsonl` transcript per
 * chat under `.ai-context/chats/` (gitignored: transcripts are local/exploratory,
 * unlike the curated, committed BPS). Mirrors the rest of `src/context/`'s
 * one-class-per-concern, atomic-metadata-write pattern (`SpecManager`,
 * `SourceRegistry`).
 *
 * Transcript writes are read-modify-write (`vscode.workspace.fs` has no native
 * append), not true appends — acceptable for realistic chat lengths, but a
 * known cost at scale; noted rather than engineered around, consistent with
 * how simple the rest of this layer stays.
 */
export class ChatSessionManager implements vscode.Disposable {
  private readonly chatsDir: vscode.Uri;

  constructor(
    private readonly workspaceUri: vscode.Uri,
    private readonly log: (msg: string) => void
  ) {
    this.chatsDir = vscode.Uri.joinPath(workspaceUri, '.ai-context', 'chats');
  }

  public dispose(): void {
    // No watchers/handles held.
  }

  public async initialize(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.chatsDir);
  }

  public async listSessions(): Promise<ChatSessionMeta[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.chatsDir);
    } catch {
      return [];
    }
    const sessions: ChatSessionMeta[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith('.meta.json')) { continue; }
      const meta = await this.readMetaFile(name);
      if (meta) { sessions.push(meta); }
    }
    sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return sessions;
  }

  public async getActiveSession(): Promise<ChatSessionMeta | undefined> {
    const sessions = await this.listSessions();
    return sessions.find((s) => s.status === 'active');
  }

  public async getSessionMeta(chatId: string): Promise<ChatSessionMeta | undefined> {
    return this.readMeta(chatId);
  }

  public async createSession(opts?: { specId?: string; specVersion?: number; llmProvider?: ChatSessionMeta['llmProvider'] }): Promise<ChatSessionMeta> {
    const now = new Date().toISOString();
    const id = `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const meta: ChatSessionMeta = {
      id,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      specId: opts?.specId,
      specVersion: opts?.specVersion,
      llmProvider: opts?.llmProvider
    };
    await this.writeMeta(meta);
    await vscode.workspace.fs.writeFile(this.transcriptUri(id), Buffer.from('', 'utf8'));
    this.log(`Started chat session ${id}.`);
    return meta;
  }

  public async appendMessage(chatId: string, message: ChatMessage): Promise<void> {
    try {
      let existing = '';
      try {
        existing = Buffer.from(await vscode.workspace.fs.readFile(this.transcriptUri(chatId))).toString('utf8');
      } catch {
        // No transcript yet — treat as empty.
      }
      const line = JSON.stringify(message) + '\n';
      await vscode.workspace.fs.writeFile(this.transcriptUri(chatId), Buffer.from(existing + line, 'utf8'));

      const meta = await this.readMeta(chatId);
      if (meta) {
        meta.updatedAt = new Date().toISOString();
        if (!meta.title && message.role === 'user') {
          meta.title = message.content.slice(0, 60);
        }
        await this.writeMeta(meta);
      }
    } catch (err) {
      this.log(`Failed to persist chat message: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public async loadTranscript(chatId: string): Promise<ChatMessage[]> {
    try {
      const raw = Buffer.from(await vscode.workspace.fs.readFile(this.transcriptUri(chatId))).toString('utf8');
      const messages: ChatMessage[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) { continue; }
        try { messages.push(JSON.parse(line) as ChatMessage); } catch { /* skip a corrupt line */ }
      }
      return messages;
    } catch {
      return [];
    }
  }

  public async archiveSession(chatId: string): Promise<void> {
    await this.updateMeta(chatId, { status: 'archived' });
  }

  /** Permanently deletes a chat's transcript + metadata. Only ever called on an explicit user request. */
  public async discardSession(chatId: string): Promise<void> {
    try { await vscode.workspace.fs.delete(this.transcriptUri(chatId)); } catch { /* already gone */ }
    try { await vscode.workspace.fs.delete(this.metaUri(chatId)); } catch { /* already gone */ }
    this.log(`Discarded chat session ${chatId}.`);
  }

  public async updateMeta(chatId: string, patch: Partial<ChatSessionMeta>): Promise<void> {
    const meta = await this.readMeta(chatId);
    if (!meta) { return; }
    Object.assign(meta, patch, { updatedAt: new Date().toISOString() });
    await this.writeMeta(meta);
  }

  private metaUri(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.chatsDir, `${id}.meta.json`);
  }

  private transcriptUri(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.chatsDir, `${id}.jsonl`);
  }

  private async readMeta(chatId: string): Promise<ChatSessionMeta | undefined> {
    return this.readMetaFile(`${chatId}.meta.json`);
  }

  private async readMetaFile(fileName: string): Promise<ChatSessionMeta | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.chatsDir, fileName));
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as ChatSessionMeta;
    } catch {
      return undefined;
    }
  }

  private async writeMeta(meta: ChatSessionMeta): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.chatsDir);
    const tempUri = vscode.Uri.joinPath(this.chatsDir, `.${meta.id}.meta.tmp.${Date.now()}.json`);
    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
    await vscode.workspace.fs.rename(tempUri, this.metaUri(meta.id), { overwrite: true });
  }
}
