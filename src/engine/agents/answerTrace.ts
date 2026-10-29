import { ToolCallAuditEntry, TraceSource } from '../types';

/**
 * How an answer was made (v0.52.2; CHT-8): a trace built from what AutoDE
 * recorded — who answered, with which model, the tool calls in order with
 * what each found, the facts and articles consulted and cited, the context
 * pack, what an agent proposed — never from the model's own account of its
 * reasoning, which can be written after the fact and not match what it did.
 * No model call; nothing in it is made up.
 */

export interface TraceStep { tool: string; text: string; outcome: string; found?: string }

export interface AnswerTrace {
  /** `AutoDE chat`, or the agent (`knowledge-engineer`). */
  answeredBy: string;
  /** How the agent was reached: `Run it`, `@mention`. */
  via?: string;
  model?: string;
  steps: TraceStep[];
  /** Facts the answer cites ([fact:<id>]), with their trust. */
  cited: TraceSource[];
  /** Facts, articles, assets and models the tools returned. */
  consulted: TraceSource[];
  /** Sentences that state something and cite nothing, of all such sentences. */
  uncited: number;
  statements: number;
  pack?: { title: string; tokens: number; facts: number };
  /** What an agent proposed (decisions, facts), for the person to approve. */
  proposed: string[];
  /** When no step could be recorded (Claude Code runs its own loop). */
  note?: string;
  /** One line: "4 steps · 3 facts consulted · 1 cited". */
  summary: string;
}

const q = (v: unknown) => (typeof v === 'string' && v ? `"${v.length > 60 ? v.slice(0, 57) + '…' : v}"` : '');
const s = (v: unknown) => (typeof v === 'string' ? v : '');

/** A step in words, from the tool and its input. */
export function stepText(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'autode_search_assets': return `Searched AutoDE's assets for ${q(input.query) || 'everything'}`;
    case 'autode_get_asset_context': return `Read everything AutoDE knows about ${s(input.asset) || 'an asset'}`;
    case 'autode_browse_assets': return `Browsed ${s(input.parent) || 'the estate'}`;
    case 'autode_explore_graph': return `Walked the graph around ${s(input.asset) || 'the estate'}`;
    case 'autode_search_articles': return `Searched knowledge articles${input.query ? ` for ${q(input.query)}` : ''}${input.about ? ` about ${s(input.about)}` : ''}`;
    case 'autode_resolve': return `Resolved ${q(input.ref ?? input.name ?? input.reference) || 'a name'} in the estate`;
    case 'autode_list_assertions': return `Listed facts${Array.isArray(input.kinds) ? ` (${(input.kinds as string[]).join(', ')})` : input.kind ? ` (${s(input.kind)})` : ''}${input.subject ? ` about ${s(input.subject)}` : ''}`;
    case 'autode_semantic_list': return 'Listed the semantic models';
    case 'autode_semantic_check': return `Checked the semantic model ${s(input.name) || '(given)'}`;
    case 'autode_semantic_draft': return `Drafted a semantic model ${s(input.name)}`.trim();
    case 'autode_maintenance_list': return 'Listed open maintenance items';
    case 'autode_list_problems': return 'Listed the business problems';
    case 'autode_workflow_next': return 'Took the next stage from the workflow';
    case 'autode_record_artifact': return `Recorded ${s(input.path) || 'a deliverable'}`;
    case 'autode_workflow_status': return 'Read the workflow status';
    case 'autode_approvals_list': return 'Listed what waits for approval';
    case 'autode_list_decisions': return 'Listed decisions';
    case 'autode_get_context_pack': return `Built a context pack${input.query ? ` for ${q(input.query)}` : ''}`;
    case 'autode_propose_assertion': return 'Proposed a fact';
    case 'autode_propose_article': return `Proposed a knowledge article${(input.article as { slug?: string } | undefined)?.slug ? ` (${(input.article as { slug: string }).slug})` : ''}`;
    case 'autode_propose_semantic_model': return `Proposed a semantic model${(input.semanticModel as { name?: string } | undefined)?.name ? ` (${(input.semanticModel as { name: string }).name})` : ''}`;
    case 'autode_read_file': return `Read the file ${s(input.path)}`;
    case 'autode_list_dir': return `Listed ${s(input.path) || 'the workspace folder'}`;
    case 'autode_search_files': return `Searched workspace files for ${q(input.query ?? input.pattern)}`;
    case 'autode_write_file': return `Wrote ${s(input.path)}`;
    case 'autode_run_command': return `Ran ${q(input.command)}`;
    default: {
      const arg = Object.entries(input).find(([, v]) => typeof v === 'string');
      return `${tool.replace(/^autode_/, '').replace(/_/g, ' ')}${arg ? ` ${q(arg[1])}` : ''}`;
    }
  }
}

const isFact = (o: Record<string, unknown>) => typeof o.id === 'string' && typeof o.statement === 'string';
const isArticle = (o: Record<string, unknown>) => typeof o.slug === 'string' && typeof o.title === 'string';
const isAsset = (o: Record<string, unknown>) => typeof o.id === 'string' && typeof o.assetType === 'string';

/** What a tool's result held: a count in words, and the facts, articles and assets in it (ids, labels, trust). */
export function toolResultSummary(tool: string, text: string): { found?: string; sources: TraceSource[]; proposed?: string } {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { sources: [] }; }
  if (!doc || typeof doc !== 'object') return { sources: [] };
  const sources: TraceSource[] = [];
  const seen = new Set<string>();
  const add = (x: TraceSource) => { const k = `${x.kind}:${x.id}`; if (!seen.has(k) && sources.length < 40) { seen.add(k); sources.push(x); } };
  const walk = (v: unknown, depth: number): void => {
    if (depth > 5 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v.slice(0, 60)) walk(x, depth + 1); return; }
    const o = v as Record<string, unknown>;
    if (isFact(o)) add({ kind: 'fact', id: o.id as string, label: String(o.statement).slice(0, 140), ...(typeof o.trust === 'string' ? { trust: o.status === 'proposed' ? 'proposed' : o.trust } : {}) });
    else if (isArticle(o)) add({ kind: 'article', id: `article:${o.slug as string}`, label: o.title as string, ...(typeof o.state === 'string' ? { trust: o.state } : {}) });
    else if (isAsset(o)) add({ kind: o.assetType === 'semantic_model' ? 'semantic_model' : 'asset', id: o.id as string, label: String(o.fqn ?? o.label ?? o.id) });
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(doc, 0);
  const top = doc as Record<string, unknown>;
  const list = Object.entries(top).find(([, v]) => Array.isArray(v));
  const found = list ? `${(list[1] as unknown[]).length} ${list[0].replace(/_/g, ' ')}` : top.context ? 'its full context' : undefined;
  const decision = (top.decision as { id?: string } | undefined)?.id;
  const assertion = (top.assertion as { id?: string; statement?: string } | undefined);
  const proposed = /^autode_propose_/.test(tool) ? (decision ? `decision ${decision}` : assertion?.id ? `fact ${assertion.id}${assertion.statement ? `: ${assertion.statement}` : ''}` : undefined) : undefined;
  return { ...(found ? { found } : {}), sources, ...(proposed ? { proposed } : {}) };
}

/** Sentences that state something (not a question, a heading, a lead-in) and those of them with no citation. */
export function uncitedStatements(reply: string): { statements: number; uncited: number } {
  const prose = reply.replace(/```[\s\S]*?```/g, ' ').split('\n').filter((l) => !/^\s*(#|\||>)/.test(l)).join(' ');
  const sentences = prose.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.split(/\s+/).length >= 6 && !/\?$/.test(x) && !/^(here|let me|i |i'll|you can|to |if you|sure|in short|note)/i.test(x));
  return { statements: sentences.length, uncited: sentences.filter((x) => !/\[fact:[0-9A-Z]{26}\]/.test(x)).length };
}

export interface TraceInput {
  answeredBy: string;
  via?: string;
  model?: string;
  provider?: string;
  /** Whether the run had tools at all: a reply that used none gets a plain note, the same for every model. */
  toolsOffered?: boolean;
  audit: readonly ToolCallAuditEntry[];
  reply: string;
  cited: readonly TraceSource[];
  pack?: { title: string; tokens: number; facts: number };
}

export function buildAnswerTrace(input: TraceInput): AnswerTrace {
  const steps: TraceStep[] = input.audit.map((e) => ({ tool: e.tool, text: stepText(e.tool, e.input ?? {}), outcome: e.outcome, ...(e.found ? { found: e.found } : e.outcome !== 'ok' && e.outcome !== 'approved' && e.detail ? { found: e.detail.slice(0, 120) } : {}) }));
  const consulted: TraceSource[] = [];
  const seen = new Set(input.cited.map((c) => `${c.kind}:${c.id}`));
  for (const e of input.audit) for (const x of e.sources ?? []) { const k = `${x.kind}:${x.id}`; if (!seen.has(k)) { seen.add(k); consulted.push(x); } }
  const proposed = input.audit.map((e) => e.proposed).filter((x): x is string => !!x);
  const { statements, uncited } = uncitedStatements(input.reply);
  // Every model's steps are recorded (Claude Code's through its event stream, v0.52.3); the note is for a run that had tools and recorded none.
  const note = !input.audit.length && input.toolsOffered ? 'No tool calls were recorded for this reply: it comes from the context AutoDE gave the model.' : undefined;
  const facts = [...input.cited, ...consulted].filter((x) => x.kind === 'fact').length;
  const summary = [
    `${steps.length} step${steps.length === 1 ? '' : 's'}`,
    facts ? `${facts} fact${facts === 1 ? '' : 's'}` : '',
    consulted.some((x) => x.kind === 'article') ? `${consulted.filter((x) => x.kind === 'article').length} article(s)` : '',
    input.cited.length ? `${input.cited.length} cited` : '',
    proposed.length ? `${proposed.length} proposed` : '',
    uncited && statements ? `${uncited} of ${statements} statements uncited` : ''
  ].filter(Boolean).join(' · ');
  return { answeredBy: input.answeredBy, ...(input.via ? { via: input.via } : {}), ...(input.model ? { model: input.model } : {}), steps, cited: [...input.cited], consulted, uncited, statements, ...(input.pack ? { pack: input.pack } : {}), proposed, ...(note ? { note } : {}), summary };
}
