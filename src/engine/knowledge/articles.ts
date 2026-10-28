import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Assertion, isLive } from '../context/assertions';
import { parseYaml, stringifyYaml } from '../context/Yaml';
import { layoutPath } from '../workspaceLayout';

/**
 * Knowledge articles (MM1; docs/context-layer-requirements.md §6.11): what
 * atomic facts can't express — pitfalls, history, golden sources, how to
 * reconcile — written up, reviewed and approved. Markdown with front matter
 * under `.autode/knowledge/articles/<slug>.md`, versioned in git.
 *
 * An article **cites** facts by id and never copies them, so it can't drift
 * from the ledger: when a cited fact is superseded, rejected or sent to
 * review, the article is stale until someone updates it. It is **about**
 * assets, terms, concepts and domains (many-to-many), and approved by a
 * person at a revision; editing it afterwards needs approval again. Agents
 * get approved articles about a task's assets in their packs.
 */

export type ArticleStatus = 'draft' | 'approved' | 'deprecated';

export interface ArticleFile {
  title: string;
  about: string[];
  cites: string[];
  status: ArticleStatus;
  author?: string;
  domain?: string;
  tags?: string[];
  approved?: { by: string; at: string; revision: string; channel: string };
  body: string;
}

export interface Article extends ArticleFile {
  slug: string;
  file: string;
  /** The content's revision (title, about, cites, body): what an approval is for. */
  revision: string;
  /** Approved at this revision; `changed` when edited since. */
  state: 'draft' | 'approved' | 'changed' | 'deprecated';
  errors: string[];
}

export interface ArticleCheck {
  errors: string[];
  warnings: string[];
  /** Why it is stale: cited facts that no longer stand. */
  staleBecause: string[];
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const FACT_REF = /\[fact:([A-Za-z0-9_.:-]+)\]/g;

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'article';
}

export function articleRevision(a: Pick<ArticleFile, 'title' | 'about' | 'cites' | 'body'>): string {
  const canon = JSON.stringify({ title: a.title.trim(), about: [...a.about].sort(), cites: [...a.cites].sort(), body: a.body.replace(/\r\n/g, '\n').trim() });
  return createHash('sha256').update(canon).digest('hex').slice(0, 12);
}

/** Parses an article file (front matter between `---` lines, then Markdown). */
export function parseArticle(text: string): { article?: ArticleFile; errors: string[] } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { errors: ['an article starts with front matter between --- lines (title, about, cites, status)'] };
  let fm: Record<string, unknown>;
  try { fm = (parseYaml(m[1]) ?? {}) as Record<string, unknown>; } catch (err) { return { errors: [`front matter: ${err instanceof Error ? err.message : String(err)}`] }; }
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : []);
  const errors: string[] = [];
  const title = typeof fm.title === 'string' ? fm.title.trim() : '';
  if (!title) errors.push('title is required');
  const status = (['draft', 'approved', 'deprecated'] as const).find((s) => s === fm.status) ?? 'draft';
  const ap = fm.approved as Record<string, unknown> | undefined;
  const article: ArticleFile = {
    title, about: strs(fm.about), cites: strs(fm.cites), status,
    ...(typeof fm.author === 'string' ? { author: fm.author } : {}),
    ...(typeof fm.domain === 'string' ? { domain: fm.domain } : {}),
    ...(strs(fm.tags).length ? { tags: strs(fm.tags) } : {}),
    ...(ap && typeof ap.by === 'string' && typeof ap.revision === 'string' ? { approved: { by: ap.by, at: String(ap.at ?? ''), revision: ap.revision, channel: String(ap.channel ?? 'file') } } : {}),
    body: m[2].replace(/^\r?\n/, '')
  };
  if (!article.about.length) errors.push('about names no asset, term or domain: name what the article is about');
  return { article, errors };
}

export function serializeArticle(a: ArticleFile): string {
  const fm: Record<string, unknown> = { title: a.title, about: a.about, cites: a.cites, status: a.status, ...(a.author ? { author: a.author } : {}), ...(a.domain ? { domain: a.domain } : {}), ...(a.tags?.length ? { tags: a.tags } : {}), ...(a.approved ? { approved: a.approved } : {}) };
  return `---\n${stringifyYaml(fm).trimEnd()}\n---\n\n${a.body.replace(/^\s+/, '').replace(/\s*$/, '\n')}`;
}

export function articlesDir(workspaceRoot: string): string { return layoutPath(workspaceRoot, 'articles'); }

export function readArticle(workspaceRoot: string, slug: string): Article | undefined {
  const file = path.join(articlesDir(workspaceRoot), `${slug}.md`);
  if (!fs.existsSync(file)) return undefined;
  const { article, errors } = parseArticle(fs.readFileSync(file, 'utf8'));
  const base: ArticleFile = article ?? { title: slug, about: [], cites: [], status: 'draft', body: '' };
  const revision = articleRevision(base);
  const state: Article['state'] = base.status === 'deprecated' ? 'deprecated' : base.status === 'approved' && base.approved?.revision === revision ? 'approved' : base.approved ? 'changed' : 'draft';
  return { ...base, slug, file, revision, state, errors };
}

export function listArticles(workspaceRoot: string): Article[] {
  let names: string[] = [];
  try { names = fs.readdirSync(articlesDir(workspaceRoot)).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
  return names.map((f) => readArticle(workspaceRoot, f.slice(0, -3))).filter((a): a is Article => !!a);
}

/**
 * Checks an article against the ledger: every `[fact:<id>]` in the body is
 * cited, every cited fact exists and still stands (else it is stale, with
 * the reason), and what it is about is known (a warning otherwise).
 */
export function checkArticle(a: Pick<ArticleFile, 'about' | 'cites' | 'body'>, assertions: readonly Assertion[], knownIds?: ReadonlySet<string>): ArticleCheck {
  const byId = new Map(assertions.map((x) => [x.id, x] as const));
  const errors: string[] = []; const warnings: string[] = []; const staleBecause: string[] = [];
  const inBody = [...a.body.matchAll(FACT_REF)].map((m) => m[1]);
  for (const id of new Set(inBody)) if (!a.cites.includes(id)) errors.push(`[fact:${id}] is used in the text but not in cites`);
  for (const id of a.cites) {
    const f = byId.get(id);
    if (!f) { errors.push(`cited fact ${id} doesn't exist`); continue; }
    if (f.status === 'superseded') {
      const by = assertions.find((x) => x.supersedes === id);
      staleBecause.push(`${id} was superseded${by ? ` by ${by.id}: "${by.statement}"` : ''}`);
    } else if (f.status === 'rejected') staleBecause.push(`${id} was rejected`);
    else if (f.status === 'needs_review') staleBecause.push(`${id} is under review${f.reviewReason ? ` (${f.reviewReason})` : ''}`);
    else if (!isLive(f.status) && f.status !== 'proposed') staleBecause.push(`${id} is ${f.status}`);
    else if (f.status === 'proposed') warnings.push(`${id} is only proposed: confirm it before approving the article`);
  }
  if (knownIds) for (const id of a.about) if (!knownIds.has(id) && !/^(domain|term|concept):/.test(id)) warnings.push(`about: ${id} is not an asset AutoDE knows`);
  return { errors, warnings, staleBecause };
}

/** Writes a new article (never over an existing one), as a draft. */
export function writeArticle(workspaceRoot: string, slug: string, a: Omit<ArticleFile, 'status' | 'approved'> & { status?: ArticleStatus }, options: { overwrite?: boolean } = {}): Article {
  if (!SLUG.test(slug)) throw new Error(`"${slug}" is not a valid article name (lower-case letters, digits and -).`);
  const file = path.join(articlesDir(workspaceRoot), `${slug}.md`);
  if (fs.existsSync(file) && !options.overwrite) throw new Error(`The article ${slug} exists: edit it, or choose another name.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeArticle({ ...a, status: a.status ?? 'draft' }));
  return readArticle(workspaceRoot, slug)!;
}

/** A person approves an article at its current revision; refused while it fails its check or is stale. */
export function approveArticle(workspaceRoot: string, slug: string, input: { by: string; channel: string; assertions: readonly Assertion[]; at?: Date }): { ok: boolean; message: string } {
  const a = readArticle(workspaceRoot, slug);
  if (!a) return { ok: false, message: `No article ${slug}.` };
  if (a.errors.length) return { ok: false, message: `${slug} isn't a valid article: ${a.errors.join('; ')}` };
  const c = checkArticle(a, input.assertions);
  if (c.errors.length) return { ok: false, message: `${slug} can't be approved: ${c.errors.join('; ')}` };
  if (c.staleBecause.length) return { ok: false, message: `${slug} is stale: ${c.staleBecause.join('; ')}. Update it first.` };
  const content: ArticleFile = { title: a.title, about: a.about, cites: a.cites, status: 'approved', ...(a.author ? { author: a.author } : {}), ...(a.domain ? { domain: a.domain } : {}), ...(a.tags ? { tags: a.tags } : {}), body: a.body };
  fs.writeFileSync(a.file, serializeArticle({ ...content, approved: { by: input.by, at: (input.at ?? new Date()).toISOString(), revision: a.revision, channel: input.channel } }));
  return { ok: true, message: `${slug} approved by ${input.by}. Agents get it in the packs of tasks over what it is about.` };
}

/**
 * The approved articles about any of these ids (assets, their tables,
 * terms, domains), each with whether it is stale — what a pack includes.
 */
export function articlesAbout(articles: readonly Article[], ids: ReadonlySet<string>, assertions: readonly Assertion[]): Array<{ article: Article; stale: string[] }> {
  return articles.filter((a) => a.state === 'approved' && a.about.some((x) => ids.has(x)))
    .map((article) => ({ article, stale: checkArticle(article, assertions).staleBecause }));
}

/** An article's opening paragraph: what a pack quotes. */
export function articleSummary(a: Pick<ArticleFile, 'body'>, maxChars = 600): string {
  const para = a.body.trim().split(/\r?\n\s*\r?\n/).find((p) => p.trim() && !/^#/.test(p.trim())) ?? '';
  const text = para.replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
}
