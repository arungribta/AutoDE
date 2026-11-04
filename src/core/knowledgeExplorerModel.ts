import * as path from 'node:path';
import { ExploreSources, AssetContext } from '../engine/explore/explore';
import { ExploreRequest, handleExploreRequest } from '../engine/explore/sources';
import { renderAssetMarkdown, renderImpactCsv, renderImpactMarkdown } from '../engine/explore/render';
import type { ChangeKind, ImpactResult } from '../engine/explore/lineage';
import { OntologySource, shippedSources } from '../engine/ontology/onboard';
import { Choices, OntologyProposalError, WorkspaceGraph, alignmentCandidates, analyzeOntologySource, browseSource, previewPack, proposeAlignment, proposeOntologyPack } from '../engine/ontology/service';
import { standardsCatalog } from '../engine/ontology/standards';
import { qualityCandidates, qualityProposals } from '../engine/quality/candidates';
import { workspaceMeaning } from '../engine/ontology/service';
import { AssertionLedger } from '../engine/context/ledger';
import { recordChatProposals } from '../engine/context/chatExtraction';
import { layoutPath } from '../engine/workspaceLayout';
import { standardIsLocal } from '../engine/ontology/onboard';
import type { RepresentsCandidate, TermCandidate } from '../engine/ontology/onboard';
import { PortError } from '../engine/skills/port';
import { ProposalValidationError } from '../engine/decisions/proposals';

/**
 * The Knowledge Explorer's messages (C5b; docs/specs/context-layer.md
 * §6.10), without VS Code: the webview asks, this answers from the engine's
 * explore functions — the same ones `autode explore` and the MCP tools use —
 * or tells the host what to open. Read-only: every change goes through the
 * existing channels (Inbox, decisions, the Semantic Model editor).
 */

export interface ExplorerHost {
  workspaceRoot(): string | undefined;
  /** The explore sources for the workspace (re-read when its files change). */
  sources(): Promise<ExploreSources | undefined>;
  /** AutoDE's resources (shipped ontology packs). */
  resourcesRoot?(): string | undefined;
  /** Who the person is, for what they propose. */
  user?(): string | undefined;
}

export type ExplorerMessage =
  | { type: 'ready' }
  | { type: 'request'; requestId: number; request: ExploreRequest }
  | { type: 'open'; target: OpenTarget }
  | { type: 'copyMarkdown'; id: string }
  | { type: 'exportGraph'; format: 'svg' | 'png'; data: string }
  | { type: 'editMetadata'; id: string }
  | { type: 'maintenance'; key: string; act: 'work' | 'dismiss' }
  | { type: 'exportImpact'; id: string; change: ChangeKind; format: 'md' | 'csv' | 'copy' }
  /** ONT1: onboarding a standard and aligning the vocabulary (§6.8); analysis is read-only, the rest are proposals. */
  | { type: 'ontology'; requestId: number; op: 'shipped' | 'pick' | 'analyze' | 'preview' | 'propose' | 'align' | 'proposeLinks' | 'standards' | 'browse' | 'quality' | 'proposeQuality'; args?: Record<string, unknown> };

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
  | { kind: 'save'; format: 'svg' | 'png'; data: string }
  | { kind: 'editMetadata'; id: string; label: string }
  | { kind: 'maintenance'; key: string; act: 'work' | 'dismiss' }
  | { kind: 'saveText'; name: string; format: 'md' | 'csv'; text: string }
  | { kind: 'pickOntologySource'; requestId: number }
  /** A standard not on this machine yet: the host fetches it in a child process (never in the extension host), then answers the request. */
  | { kind: 'fetchStandard'; requestId: number; id: string; whole?: boolean; decision?: string };

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
  if (msg.type === 'editMetadata') {
    const sources = await host.sources();
    const body = sources ? handleExploreRequest({ type: 'asset', id: msg.id }, sources, root) : undefined;
    const ctx = body?.context as AssetContext | undefined;
    if (!ctx || ctx.asset.assetType === 'knowledge_fact' || ctx.asset.assetType === 'knowledge_article' || ctx.asset.assetType === 'domain' || ctx.asset.assetType === 'data_product') return { reply: { type: 'toast', message: 'Metadata is set on tables, columns, terms and semantic elements.' } };
    return { action: { kind: 'editMetadata', id: ctx.asset.id, label: ctx.asset.fqn ?? ctx.asset.label } };
  }
  // MM2: a maintenance item on an asset page — the host starts its agent, or a person dismisses it.
  if (msg.type === 'maintenance') return typeof msg.key === 'string' && (msg.act === 'work' || msg.act === 'dismiss') ? { action: { kind: 'maintenance', key: msg.key, act: msg.act } } : { reply: { type: 'toast', message: 'Unknown maintenance action.' } };
  // LIN: the impact list as Markdown or CSV, saved by the host or copied.
  if (msg.type === 'exportImpact') {
    const sources = await host.sources();
    const body = sources ? handleExploreRequest({ type: 'impact', id: msg.id, change: msg.change }, sources, root) : undefined;
    const r = body?.result as ImpactResult | undefined;
    if (!r) return { reply: { type: 'toast', message: String(body?.error ?? 'Nothing to export.') } };
    if (msg.format === 'copy') return { action: { kind: 'copy', text: renderImpactMarkdown(r) }, reply: { type: 'toast', message: 'Copied as Markdown.' } };
    const name = `impact-${msg.change.replace(/_/g, '-')}-${(r.asset.fqn ?? r.asset.label).replace(/[^A-Za-z0-9_.-]+/g, '_')}.${msg.format}`;
    return { action: { kind: 'saveText', name, format: msg.format, text: msg.format === 'csv' ? renderImpactCsv(r) : renderImpactMarkdown(r) } };
  }
  if (msg.type === 'ontology') return answerOntology(msg, host, root);
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

/** ONT1: the onboarding steps and the alignment, through the same service as `autode ontology` and MCP. */
async function answerOntology(msg: Extract<ExplorerMessage, { type: 'ontology' }>, host: ExplorerHost, root: string): Promise<ExplorerAnswer> {
  const reply = (body: Record<string, unknown>): ExplorerAnswer => ({ reply: { type: 'response', requestId: msg.requestId, body } });
  const scope = { workspaceRoot: root, resourcesRoot: host.resourcesRoot?.() };
  const args = msg.args ?? {};
  try {
    if (msg.op === 'shipped') return reply({ shipped: shippedSources(scope.resourcesRoot) });
    if (msg.op === 'standards') return reply({ standards: standardsCatalog(scope).map((s) => ({ ...s, local: standardIsLocal(scope, s.id, false, s.decision) })) });
    if (msg.op === 'pick') return { action: { kind: 'pickOntologySource', requestId: msg.requestId } };
    const sources = await host.sources();
    if (!sources) return reply({ error: 'Nothing known yet.' });
    const graph = sources.graph as WorkspaceGraph;
    if (msg.op === 'align') return reply(alignmentCandidates(scope, graph, sources.assertions) as unknown as Record<string, unknown>);
    // ONT2: quality-rule candidates for a table, and proposing the chosen ones for the Context Inbox.
    if (msg.op === 'quality' || msg.op === 'proposeQuality') {
      const all = qualityCandidates(workspaceMeaning(scope, { graph, assertions: sources.assertions }), msg.op === 'quality' && Array.isArray(args.tables) ? { tables: args.tables as string[] } : {});
      if (msg.op === 'quality') return reply({ candidates: all });
      const wanted = (args.rules ?? []) as Array<{ subject: string; check: string }>;
      const chosen = all.filter((c) => wanted.some((w) => w.subject === c.subject && w.check === c.check));
      const ledger = new AssertionLedger(layoutPath(root, 'ledger'));
      await ledger.load();
      const { recorded } = await recordChatProposals(ledger, { proposed: qualityProposals(chosen, `user:${host.user?.() ?? 'user'}`), dropped: [], duplicates: [] });
      return reply({ proposed: recorded.length });
    }
    const by = `user:${host.user?.() ?? 'user'}`;
    if (msg.op === 'proposeLinks') {
      const r = await proposeAlignment(scope, { means: (args.means ?? []) as TermCandidate[], represents: (args.represents ?? []) as RepresentsCandidate[] }, by);
      return reply({ recorded: r.recorded.length, duplicates: r.duplicates.length });
    }
    const src = args.source as OntologySource | undefined;
    if (!src || !['shipped', 'file', 'git', 'standard'].includes(src.kind)) return reply({ error: 'Choose a source first.' });
    // A standard read the first time is fetched by the host, off the extension host's thread; then it is read from this machine.
    if (src.kind === 'standard' && !standardIsLocal(scope, src.id, !!src.whole, src.decision)) return { action: { kind: 'fetchStandard', requestId: msg.requestId, id: src.id, ...(src.whole ? { whole: true } : {}), ...(src.decision ? { decision: src.decision } : {}) } };
    if (msg.op === 'browse') return reply({ browse: browseSource(scope, src, { ...(typeof args.query === 'string' && args.query ? { query: args.query } : {}), ...(typeof args.parent === 'string' && args.parent ? { parent: args.parent } : {}), ...(typeof args.concept === 'string' && args.concept ? { concept: args.concept } : {}), ...(typeof args.offset === 'number' ? { offset: args.offset } : {}) }) });
    const choices = (args.choices ?? {}) as Choices;
    if (msg.op === 'analyze') return reply({ analysis: analyzeOntologySource(scope, src, graph, choices).analysis });
    if (msg.op === 'preview') { const p = previewPack(scope, src, graph, choices); return reply({ text: p.text, added: p.added, kept: p.kept, problems: p.problems, revision: p.revision }); }
    const { decision, built } = proposeOntologyPack(scope, src, graph, choices, { host: 'vscode', client: host.user?.() }, { reason: String(args.reason ?? '') });
    return reply({ decision: { id: decision.id, title: decision.title, status: decision.status }, added: built.added });
  } catch (err) {
    if (err instanceof PortError || err instanceof OntologyProposalError) return reply({ error: err.message });
    if (err instanceof ProposalValidationError) return reply({ error: `The pack doesn't pass its checks: ${err.report.errors.join(' ')}` });
    return reply({ error: err instanceof Error ? err.message : String(err) });
  }
}
