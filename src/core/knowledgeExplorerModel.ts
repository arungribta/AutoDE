import * as path from 'node:path';
import { ExploreSources, AssetContext } from '../engine/explore/explore';
import { ExploreRequest, handleExploreRequest } from '../engine/explore/sources';
import { renderAssetMarkdown } from '../engine/explore/render';

/**
 * The Knowledge Explorer's messages (C5b; docs/context-layer-requirements.md
 * §6.10), without VS Code: the webview asks, this answers from the engine's
 * explore functions — the same ones `autode explore` and the MCP tools use —
 * or tells the host what to open. Read-only: every change goes through the
 * existing channels (Inbox, decisions, the Semantic Model editor).
 */

export interface ExplorerHost {
  workspaceRoot(): string | undefined;
  /** The explore sources for the workspace (re-read when its files change). */
  sources(): Promise<ExploreSources | undefined>;
}

export type ExplorerMessage =
  | { type: 'ready' }
  | { type: 'request'; requestId: number; request: ExploreRequest }
  | { type: 'open'; target: OpenTarget }
  | { type: 'copyMarkdown'; id: string }
  | { type: 'exportGraph'; format: 'svg' | 'png'; data: string };

export type OpenTarget =
  | { kind: 'file'; path: string }
  | { kind: 'inbox' }
  | { kind: 'semanticModel'; file: string }
  | { kind: 'workflow' };

export type ExplorerAction =
  | { kind: 'openFile'; file: string }
  | { kind: 'openInbox' }
  | { kind: 'openWorkflow' }
  | { kind: 'copy'; text: string }
  | { kind: 'save'; format: 'svg' | 'png'; data: string };

export interface ExplorerAnswer {
  /** Posted back to the webview. */
  reply?: Record<string, unknown>;
  /** Done by the host (VS Code). */
  action?: ExplorerAction;
}

/** A path the webview names is opened only inside the workspace. */
function insideWorkspace(root: string, p: string): string | undefined {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? abs : undefined;
}

export async function answerExplorerMessage(msg: ExplorerMessage, host: ExplorerHost): Promise<ExplorerAnswer> {
  const root = host.workspaceRoot();
  if (msg.type === 'ready') {
    if (!root) return { reply: { type: 'empty', message: 'Open a folder to explore what AutoDE knows about it.' } };
    const sources = await host.sources();
    return { reply: sources ? { type: 'response', requestId: 0, body: handleExploreRequest({ type: 'overview' }, sources, root) } : { type: 'empty', message: 'Nothing known yet: ingest a source or connect a platform.' } };
  }
  if (!root) return { reply: { type: 'error', message: 'No workspace folder is open.' } };
  if (msg.type === 'request') {
    const sources = await host.sources();
    if (!sources) return { reply: { type: 'response', requestId: msg.requestId, body: { type: msg.request.type, error: 'Nothing known yet.' } } };
    try {
      return { reply: { type: 'response', requestId: msg.requestId, body: handleExploreRequest(msg.request, sources, root) } };
    } catch (err) {
      return { reply: { type: 'response', requestId: msg.requestId, body: { type: msg.request.type, error: err instanceof Error ? err.message : String(err) } } };
    }
  }
  if (msg.type === 'copyMarkdown') {
    const sources = await host.sources();
    const body = sources ? handleExploreRequest({ type: 'asset', id: msg.id }, sources, root) : undefined;
    return body?.context ? { action: { kind: 'copy', text: renderAssetMarkdown(body.context as AssetContext) }, reply: { type: 'toast', message: 'Copied as Markdown.' } } : { reply: { type: 'toast', message: 'Nothing to copy.' } };
  }
  if (msg.type === 'exportGraph') {
    if (!/^data:image\/(svg\+xml|png)[;,]/.test(msg.data) && !msg.data.startsWith('<svg')) return { reply: { type: 'toast', message: 'Nothing to export.' } };
    return { action: { kind: 'save', format: msg.format, data: msg.data } };
  }
  const t = msg.target;
  if (t.kind === 'inbox') return { action: { kind: 'openInbox' } };
  if (t.kind === 'workflow') return { action: { kind: 'openWorkflow' } };
  const file = insideWorkspace(root, t.kind === 'file' ? t.path : t.file);
  return file ? { action: { kind: 'openFile', file } } : { reply: { type: 'toast', message: 'That file is outside the workspace.' } };
}
