import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Assertion, isLive } from '../context/assertions';
import { GraphView } from '../context/retrieval';
import { isMirror } from '../context/projection';
import { TableNode } from '../context/types';
import { contentSha } from '../context/pack';
import { readPackDocument, readPackFile } from '../context/packChecks';
import { listProblems } from '../documents/problems';
import { Article, checkArticle, listArticles } from '../knowledge/articles';
import { checkSemanticModel } from '../semantic/checks';
import { LayerTable, PhysicalRef, knownDatabase, matchBase, physicalRef, semanticElementId, semanticModelId, semanticRelationshipId, semanticTableId, semanticTablesFor } from '../semantic/layer';
import { SemanticTable } from '../semantic/model';
import { listShared, loadSemanticLayer } from '../semantic/store';
import { readWorkflow } from '../workflows/instance';
import { statusFor } from '../workflows/service';
import { layoutPath } from '../workspaceLayout';
import { problemTableIds } from '../context/capture';
import { problemMode } from '../documents/problemMode';
import { loadMaintenanceConfig, readMaintenanceState } from './policy';
import { unreviewedTurns } from './turns';

/**
 * The maintenance queue (MM2; docs/context-layer-requirements.md §5.6):
 * deterministic rules decide that something needs attention, name the agent
 * suited to it, and a person decides. The queue is computed from the state
 * the rules look at — the ledger, the semantic layer, the articles, the packs,
 * the recorded turns, the workflow — never stored, so:
 * - an item is keyed by its cause: the same cause never makes a second item;
 * - it closes itself when its cause is gone (the model changes, the article
 *   is updated, the fact is settled, the document is read);
 * - every surface (VS Code, the CLI, MCP) sees the same items.
 * No model is called here, whatever the policy.
 */

export type MaintenanceRule =
  | 'semantic-contradiction'  // a confirmed fact contradicts an approved model
  | 'semantic-broken'         // a column or table the model uses is gone, renamed or retyped
  | 'semantic-ambiguous'      // a base table fits several tables (§6.4a)
  | 'semantic-gap'            // a confirmed metric, join or term has no semantic counterpart
  | 'article-stale'           // a fact an article cites changed
  | 'glossary-structure'      // terms that fit no glossary category
  | 'document-reading'        // a document not yet read for knowledge
  | 'unreviewed-turns'        // chat turns that read like facts, not yet reviewed
  | 'stage-stale';            // a stage's deliverable rests on a fact that changed (§8.3)

export const MAINTENANCE_RULES: readonly MaintenanceRule[] = ['semantic-contradiction', 'semantic-broken', 'semantic-ambiguous', 'semantic-gap', 'article-stale', 'glossary-structure', 'document-reading', 'unreviewed-turns', 'stage-stale'];

export interface MaintenanceItem {
  /** The cause: `<rule>:<what>[:<hash of the difference>]`. Stable while the cause holds. */
  key: string;
  rule: MaintenanceRule;
  /** The role suited to it (`semantic-modeler`, `knowledge-engineer`, `context-curator`, a stage's role), or `person`. */
  agent: string;
  title: string;
  detail: string;
  /** What to do about it: the brief the agent gets. */
  next: string;
  /** The assets it concerns (graph ids, `sem:` ids, `article:<slug>`, `doc:<path>`, fact ids). */
  subjects: string[];
  problemId?: string;
  /** The command a person runs to look at it. */
  cli: string;
}

export interface MaintenanceInput {
  workspaceRoot: string;
  resourcesRoot?: string;
  /** The active problem: its packs and workflow; without `all`, only its documents are checked. */
  problemId?: string;
  sources: { graph: GraphView; assertions: readonly Assertion[]; articles?: readonly Article[] };
  /** Every problem's documents, not only the active one's. */
  all?: boolean;
}

const h8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);
const confirmed = (a: Assertion) => !isMirror(a) && a.status === 'active' && (a.trust === 'confirmed' || a.trust === 'verified');
const snake = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** The estate's tables, as the layer matches them. */
function tableRefs(graph: GraphView): PhysicalRef[] {
  return graph.nodes.filter((n) => n.type === 'table').map((n) => physicalRef(n as TableNode));
}

function physicalOf(t: SemanticTable, refs: readonly PhysicalRef[], binding?: { system: string; environment?: string }): string | undefined {
  const b = t.base_table;
  const lt = { baseName: b.table.toLowerCase(), baseSchema: b.schema.toLowerCase(), baseDatabase: knownDatabase(b.database), ...(binding ? { binding } : {}) } as LayerTable;
  return matchBase(lt, refs).match?.id;
}

/** Errors of the shared models (approved, or changed since): contradictions, broken references, ambiguity. */
function semanticFindings(input: MaintenanceInput, refs: readonly PhysicalRef[]): MaintenanceItem[] {
  const out: MaintenanceItem[] = [];
  for (const s of listShared(input.workspaceRoot)) {
    if (!s.model || (s.status !== 'approved' && s.status !== 'changed')) continue;
    for (const f of checkSemanticModel(s.model, { graph: input.sources.graph, assertions: input.sources.assertions, ...(s.binding ? { binding: s.binding } : {}) })) {
      if (f.severity !== 'error') continue;
      const rule: MaintenanceRule = /\bambiguous\b/.test(f.message) ? 'semantic-ambiguous' : /\bcontradicts\b|\bfact \S+ defines\b/.test(f.message) ? 'semantic-contradiction' : 'semantic-broken';
      const [table, element] = f.where.startsWith('relationship:') ? [undefined, undefined] : f.where.split('.');
      const st = table ? s.model.tables.find((t) => t.name.toLowerCase() === table.toLowerCase()) : undefined;
      const phys = st ? physicalOf(st, refs, s.binding) : undefined;
      const facts = [...f.message.matchAll(/\bfact (\S+?)[,\s:]/g)].map((m) => m[1]);
      const subjects = [
        semanticModelId(s.name),
        f.where.startsWith('relationship:') ? semanticRelationshipId(s.name, f.where.slice(13)) : element ? semanticElementId(s.name, table!, element) : semanticTableId(s.name, table!),
        ...(phys ? [phys] : []), ...facts
      ];
      const what = rule === 'semantic-contradiction' ? 'contradicts what is known' : rule === 'semantic-ambiguous' ? 'has an ambiguous base table' : 'uses something the estate no longer has';
      out.push({
        key: `${rule}:${s.name}:${f.where}:${h8(f.message)}`, rule, agent: 'semantic-modeler',
        title: `${s.name} ${f.where} ${what}`, detail: f.message,
        next: rule === 'semantic-ambiguous'
          ? `Resolve which table ${f.where} stands for: set its base_table database, or bind the model to a system (autode_semantic_check shows the candidates), and propose the change with autode_propose_semantic_model.`
          : rule === 'semantic-contradiction'
            ? `Decide which is right. If the fact${facts.length ? ` (${facts.join(', ')})` : ''} is, propose the model's change with autode_propose_semantic_model; if the model is, propose a correction of the fact with autode_propose_assertion. A person approves either.`
            : `Find what replaced it (autode_resolve), then propose the model's change with autode_propose_semantic_model.`,
        subjects: [...new Set(subjects)], cli: `autode semantic check ${s.name}`
      });
    }
  }
  return out;
}

/** Confirmed metrics, joins and terms the approved layer has no counterpart for, where a model covers their tables. */
function semanticGaps(input: MaintenanceInput, refs: readonly PhysicalRef[]): MaintenanceItem[] {
  const index = loadSemanticLayer(input.workspaceRoot);
  if (!index.models.length) return [];
  const out: MaintenanceItem[] = [];
  const nodes = new Map(input.sources.graph.nodes.map((n) => [n.id, n] as const));
  const refOf = (id: string) => { const n = nodes.get(id); return n && n.type === 'table' ? physicalRef(n as TableNode) : undefined; };
  const coveredBy = (tableId: string) => { const r = refOf(tableId); return r ? semanticTablesFor(index, r, refs) : []; };
  const tableOfColumn = (colId: string) => { const i = colId.lastIndexOf('.'); return i > 0 && nodes.get(colId.slice(0, i))?.type === 'table' ? colId.slice(0, i) : undefined; };
  for (const a of input.sources.assertions.filter(confirmed)) {
    if (a.kind === 'metric') {
      const name = a.subject[0]?.startsWith('metric:') ? a.subject[0].slice(7) : String((a.value as { name?: unknown }).name ?? '');
      if (!name || index.metricsByName.has(name.toLowerCase()) || index.metricsByName.has(snake(name))) continue;
      const tables = [...new Set(a.subject.map((s) => nodes.get(s)?.type === 'table' ? s : tableOfColumn(s)).filter((x): x is string => !!x))];
      const models = [...new Set(tables.flatMap((t) => coveredBy(t).map((lt) => lt.model)))];
      if (!models.length) continue;
      out.push({ key: `semantic-gap:metric:${a.id}`, rule: 'semantic-gap', agent: 'semantic-modeler', title: `Metric ${name} has no counterpart in ${models.join(', ')}`, detail: `Fact ${a.id}: ${a.statement}`, next: `Add the metric to ${models.join(' or ')} (autode_semantic_draft shows how AutoDE would write it) and propose the change with autode_propose_semantic_model.`, subjects: [a.id, ...tables, ...models.map(semanticModelId)], cli: `autode facts show ${a.id}` });
    } else if (a.kind === 'relationship') {
      const v = a.value as { from?: { entity?: string }; to?: { entity?: string } };
      const from = v.from?.entity, to = v.to?.entity;
      if (!from || !to) continue;
      const lf = coveredBy(from), lt = coveredBy(to);
      const shared = lf.filter((l) => lt.some((r) => r.model === l.model));
      if (!shared.length) continue;
      const joined = index.relationships.some((r) => shared.some((l) => r.model === l.model && ((r.left === l.key && lt.some((x) => x.key === r.right)) || (r.right === l.key && lt.some((x) => x.key === r.left)))));
      if (joined) continue;
      const models = [...new Set(shared.map((l) => l.model))];
      out.push({ key: `semantic-gap:join:${a.id}`, rule: 'semantic-gap', agent: 'semantic-modeler', title: `${models.join(', ')} has no relationship for a confirmed join`, detail: `Fact ${a.id}: ${a.statement}`, next: `Add the relationship to ${models.join(' or ')} and propose the change with autode_propose_semantic_model.`, subjects: [a.id, from, to, ...models.map(semanticModelId)], cli: `autode facts show ${a.id}` });
    } else if (a.kind === 'business_term') {
      const v = a.value as { term?: string; boundTo?: string[] };
      const term = v.term?.trim();
      if (!term) continue;
      for (const col of [...new Set([...(v.boundTo ?? []), ...a.subject])]) {
        const table = tableOfColumn(col);
        if (!table) continue;
        const colName = col.slice(table.length + 1).toLowerCase();
        const elements = coveredBy(table).flatMap((lt) => index.elements.filter((e) => e.model === lt.model && e.table === lt.table.name && e.expr.trim().toLowerCase() === colName));
        const missing = elements.filter((e) => e.name.toLowerCase() !== term.toLowerCase() && !e.synonyms.some((x) => x.toLowerCase() === term.toLowerCase()));
        if (!missing.length || missing.length < elements.length) continue;
        out.push({ key: `semantic-gap:term:${a.id}:${col}`, rule: 'semantic-gap', agent: 'semantic-modeler', title: `"${term}" isn't a synonym of ${missing.map((e) => `${e.model}.${e.table}.${e.name}`).join(', ')}`, detail: `Fact ${a.id}: ${a.statement}`, next: `Add "${term}" to the element's synonyms, so questions in the business's words find it, and propose the change with autode_propose_semantic_model.`, subjects: [a.id, col, ...missing.map((e) => semanticElementId(e.model, e.table, e.name))], cli: `autode facts show ${a.id}` });
      }
    }
  }
  return out;
}

function articleItems(input: MaintenanceInput): MaintenanceItem[] {
  const articles = input.sources.articles ?? listArticles(input.workspaceRoot);
  return articles.filter((a) => a.state !== 'deprecated').flatMap((a) => {
    const c = checkArticle(a, input.sources.assertions);
    if (!c.staleBecause.length) return [];
    return [{ key: `article-stale:${a.slug}:${h8(c.staleBecause.join('|'))}`, rule: 'article-stale' as const, agent: 'knowledge-engineer', title: `Knowledge article "${a.title}" is stale`, detail: c.staleBecause.join('; '), next: `Update the article to what is now known: cite the facts that replaced those, rewrite what they changed, and propose it with autode_propose_article (a person approves it).`, subjects: [`article:${a.slug}`, ...a.about, ...a.cites], cli: `autode articles check ${a.slug}` }];
  });
}

function glossaryItem(input: MaintenanceInput): MaintenanceItem[] {
  const terms = input.sources.assertions.filter((a) => !isMirror(a) && isLive(a.status) && a.kind === 'business_term' && !(a.value as { category?: string }).category);
  if (!terms.length) return [];
  const names = [...new Set(terms.map((a) => String((a.value as { term?: string }).term ?? a.statement)))].sort();
  return [{ key: `glossary-structure:${h8(terms.map((a) => a.id).sort().join('|'))}`, rule: 'glossary-structure', agent: 'knowledge-engineer', title: `${names.length} glossary term(s) fit no category`, detail: names.slice(0, 20).join(', ') + (names.length > 20 ? ` and ${names.length - 20} more` : ''), next: 'Place each term: its category, broader, narrower and related terms, and its steward if known. Propose each as a correction of the term fact (autode_propose_assertion, same kind, subject and predicate).', subjects: terms.map((a) => a.id), cli: 'autode facts list --kind business_term' }];
}

/** Documents AutoDE touched (pack documents, the last workspace scan) whose current content hasn't been read for knowledge. */
function documentItems(input: MaintenanceInput): MaintenanceItem[] {
  const problems = input.all ? listProblems(input.workspaceRoot).map((p) => p.id) : input.problemId ? [input.problemId] : [];
  const everyProblem = listProblems(input.workspaceRoot).map((p) => p.id);
  // Content read anywhere counts: the same document attached to another problem isn't read again.
  const read = new Set<string>();
  const docs: Array<{ path: string; sha: string; problemId?: string; purpose: string }> = [];
  for (const id of everyProblem) {
    for (const d of readPackFile(path.join(layoutPath(input.workspaceRoot, 'problems', id), 'pack')).documents) {
      // The content recorded at the last reading was read, whichever file holds it now.
      if (d.sha) read.add(d.sha);
      let sha: string;
      try { sha = contentSha(readPackDocument(input.workspaceRoot, d)); } catch { continue; }
      if (d.sha !== sha && problems.includes(id)) docs.push({ path: d.path, sha, problemId: id, purpose: `${d.role} in the pack of ${id}` });
    }
  }
  for (const d of readMaintenanceState(input.workspaceRoot).scan?.documents ?? []) {
    let sha: string;
    try { sha = contentSha(fs.readFileSync(path.join(input.workspaceRoot, d.path), 'utf8')); } catch { continue; }
    docs.push({ path: d.path, sha, purpose: 'found by the workspace scan' });
  }
  const bySha = new Map<string, typeof docs>();
  for (const d of docs) if (!read.has(d.sha)) bySha.set(d.sha, [...(bySha.get(d.sha) ?? []), d]);
  return [...bySha].map(([sha, ds]) => {
    const inPack = ds.find((d) => d.problemId);
    return {
      key: `document-reading:${sha.slice(0, 12)}`, rule: 'document-reading' as const, agent: 'context-curator',
      title: `Read ${ds[0].path} for knowledge`, detail: `Not read at its current content (${ds.map((d) => d.purpose).join('; ')}). What it was brought for and what it knows are separate: its facts, terms and rules belong in the context layer whatever its purpose.`,
      next: inPack ? `Read it: autode_pack_apply, then for free text autode_pack_reading and autode_pack_record_reading (document ${inPack.path}). Every fact quotes its section.` : `Add it to the problem's pack (autode_pack_add, with its role), then read it as a pack document. If it holds no knowledge, say so and a person dismisses the item.`,
      subjects: [...new Set(ds.map((d) => `doc:${d.path}`))], problemId: inPack?.problemId, cli: inPack ? 'autode pack apply' : `autode pack add ${ds[0].path}`
    };
  });
}

function turnItems(input: MaintenanceInput): MaintenanceItem[] {
  const bySession = new Map<string, ReturnType<typeof unreviewedTurns>>();
  for (const t of unreviewedTurns(input.workspaceRoot, input.sources.assertions)) {
    const k = `${t.host}-${t.session}`;
    bySession.set(k, [...(bySession.get(k) ?? []), t]);
  }
  return [...bySession].map(([session, ts]) => ({
    key: `unreviewed-turns:${session}`, rule: 'unreviewed-turns' as const, agent: 'context-curator',
    title: `${ts.length} chat message(s) read like facts, not yet reviewed`, detail: `${ts[0].host} session ${ts[0].session}, from ${ts[0].at.slice(0, 16).replace('T', ' ')}: ${ts.slice(0, 3).map((t) => `"${t.text.replace(/\s+/g, ' ').slice(0, 80)}"`).join('; ')}${ts.length > 3 ? ' …' : ''}`,
    next: 'Review them (autode_review_session with no turns lists them): propose a fact for each that states one, citing its ref as chat_message evidence; dismiss the rest (autode_dismiss_turns).',
    subjects: ts.map((t) => t.ref), cli: 'autode maintenance turns'
  }));
}

function stageItems(input: MaintenanceInput): MaintenanceItem[] {
  if (!input.problemId || !input.resourcesRoot) return [];
  const w = readWorkflow(layoutPath(input.workspaceRoot, 'problems', input.problemId));
  if (!w || w.status !== 'approved') return [];
  try {
    return statusFor({ workspaceRoot: input.workspaceRoot, resourcesRoot: input.resourcesRoot, problemId: input.problemId }).stages.filter((s) => s.status === 'stale').map((s) => ({
      key: `stage-stale:${input.problemId}/${s.id}`, rule: 'stage-stale' as const, agent: s.agent?.role ?? 'person',
      title: `${s.title}'s deliverables are stale`, detail: s.why ?? 'A fact they rest on changed.',
      next: `Re-open the stage and redo what the change affects (a person re-opens it: the Workflow view, or autode workflow reopen ${s.id}).`, subjects: [`stage:${s.id}`], problemId: input.problemId, cli: 'autode workflow status'
    }));
  } catch { return []; }
}

/** Every item the rules find now, dismissed or not (in rule order). Under `off`, none. */
export function maintenanceItems(input: MaintenanceInput): MaintenanceItem[] {
  if (loadMaintenanceConfig(input.workspaceRoot).policy === 'off') return [];
  const refs = tableRefs(input.sources.graph);
  const safe = (f: () => MaintenanceItem[]) => { try { return f(); } catch { return []; } };
  const items = [
    ...safe(() => semanticFindings(input, refs)), ...safe(() => semanticGaps(input, refs)), ...safe(() => articleItems(input)), ...safe(() => glossaryItem(input)),
    ...safe(() => documentItems(input)), ...safe(() => turnItems(input)), ...safe(() => stageItems(input))
  ];
  const seen = new Set<string>();
  return items.filter((i) => !seen.has(i.key) && !!seen.add(i.key)).sort((a, b) => MAINTENANCE_RULES.indexOf(a.rule) - MAINTENANCE_RULES.indexOf(b.rule));
}

/** The open items: not dismissed by this engineer. */
export function openMaintenanceItems(input: MaintenanceInput): MaintenanceItem[] {
  const dismissed = readMaintenanceState(input.workspaceRoot).dismissed;
  return maintenanceItems(input).filter((i) => !dismissed[i.key]);
}

/** The open items that concern any of these assets (a stage's tables, an asset page). */
export function itemsTouching(items: readonly MaintenanceItem[], ids: Iterable<string>): MaintenanceItem[] {
  const want = new Set([...ids].map((x) => x.toLowerCase()));
  // A column's table counts as the column's: an item on `t.col` touches `t`.
  const hits = (s: string) => want.has(s.toLowerCase()) || [...want].some((w) => s.toLowerCase().startsWith(w + '.'));
  return items.filter((i) => i.subjects.some(hits));
}

export interface ProblemMaintenance {
  open: number;
  unreviewedTurns: number;
  /** Open items about the problem's tables (and what the layer and articles say about them) or its documents. */
  touching: MaintenanceItem[];
}

/** The problem's share of the queue: what `autode_workflow_next` reports and a stage's gate lists. */
export function problemMaintenance(input: MaintenanceInput & { problemId: string }): ProblemMaintenance {
  const items = openMaintenanceItems(input);
  const problemRoot = layoutPath(input.workspaceRoot, 'problems', input.problemId);
  let tables: string[] = [];
  try { tables = problemTableIds({ workspaceRoot: input.workspaceRoot, problemRoot, sources: input.sources }); } catch { /* no specification yet */ }
  const touching = [...new Set([...itemsTouching(items.filter((i) => i.rule !== 'unreviewed-turns'), tables), ...items.filter((i) => i.problemId === input.problemId && i.rule !== 'stage-stale')])];
  return { open: items.length, unreviewedTurns: items.filter((i) => i.rule === 'unreviewed-turns').reduce((n, i) => n + i.subjects.length, 0), touching };
}

/**
 * A stage's gate (§5.6): in a governed problem, open items that touch the
 * problem's assets hold the approval until they are resolved or a person
 * dismisses them with a reason; in exploration mode they only warn.
 */
export function gateMaintenance(input: MaintenanceInput & { problemId: string }): { blocking: boolean; items: MaintenanceItem[]; message?: string } {
  const items = problemMaintenance(input).touching.filter((i) => i.rule !== 'document-reading' || i.problemId === input.problemId);
  if (!items.length) return { blocking: false, items };
  const governed = problemMode(layoutPath(input.workspaceRoot, 'problems', input.problemId)) !== 'exploration';
  const list = items.map((i) => `- ${i.title} (${i.agent}; ${i.key})`).join('\n');
  return {
    blocking: governed, items,
    message: governed
      ? `${items.length} open maintenance item(s) touch this problem's assets and hold the approval:\n${list}\nResolve them (the named agent proposes, a person approves), or dismiss each with a reason: autode maintenance dismiss <key> --reason "<why>".`
      : `Exploration mode: ${items.length} open maintenance item(s) touch this problem's assets (approval goes ahead):\n${list}`
  };
}
