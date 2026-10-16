import { parseYaml } from './Yaml';

/**
 * Vocabulary for retrieval that survives naming mismatch (Phase K2, item 12;
 * requirements GRD-8): physical names are abbreviated (`CUST_ORD_HDR`,
 * `TXN_AMT`) and different organisations use different words for the same
 * thing ("client", "patron"). Everything here is deterministic — a governed
 * dictionary, not a model — so retrieval stays reproducible and works the
 * same on every LLM provider (P4).
 *
 * Text is reduced to *concepts*: tokens are split on separators and camel
 * case, lower-cased, singularised, abbreviations expanded, and synonyms
 * folded onto the first word of their group. A table and a request that
 * share concepts match even when they share no spelling.
 */

/** Generic data-engineering abbreviations. Extended per customer in `.autode/knowledge/vocabulary.yaml`. */
export const DEFAULT_ABBREVIATIONS: Readonly<Record<string, string>> = {
  acct: 'account', addr: 'address', adj: 'adjustment', agg: 'aggregate', amt: 'amount', appr: 'approval', arch: 'archive',
  ast: 'asset', attr: 'attribute', aud: 'audit', avg: 'average', bal: 'balance', bdgt: 'budget', bk: 'book', bu: 'business unit',
  carr: 'carrier', cat: 'category', ccy: 'currency', cd: 'code', clm: 'claim', cmpgn: 'campaign', cnt: 'count', cntrct: 'contract',
  comm: 'commission', cr: 'credit', crt: 'create', ctry: 'country', curr: 'currency', cust: 'customer', dept: 'department',
  desc: 'description', dim: 'dimension', disc: 'discount', dly: 'daily', dr: 'debit', dt: 'date', dtl: 'detail', dts: 'timestamp',
  emp: 'employee', eff: 'effective', exp: 'expiry', fcst: 'forecast', fin: 'finance', flg: 'flag', fx: 'foreign exchange',
  gl: 'general ledger', grp: 'group', hdr: 'header', hist: 'history', hnd: 'hand', hr: 'human resource', id: 'identifier',
  ind: 'indicator', inv: 'invoice', invty: 'inventory', itm: 'item', jrnl: 'journal', ldgr: 'ledger', ln: 'line', loc: 'location',
  mgr: 'manager', mkt: 'marketing', mstr: 'master', mthly: 'monthly', nbr: 'number', nm: 'name', no: 'number', num: 'number',
  ord: 'order', org: 'organisation', pct: 'percent', pmt: 'payment', plcy: 'policy', po: 'purchase order', pos: 'point of sale',
  prc: 'price', prd: 'period', prod: 'product', promo: 'promotion', qt: 'quote', qty: 'quantity', rcpt: 'receipt', ref: 'reference',
  rfnd: 'refund', rgn: 'region', rte: 'route', rtn: 'return', sched: 'schedule', seg: 'segment', shpmt: 'shipment', snap: 'snapshot',
  src: 'source', stat: 'status', stg: 'staging', str: 'store', subscr: 'subscription', supp: 'supplier', tgt: 'target', tkt: 'ticket',
  tot: 'total', ts: 'timestamp', txn: 'transaction', txt: 'text', typ: 'type', uom: 'unit of measure', upd: 'update', veh: 'vehicle',
  whse: 'warehouse', wk: 'week', xref: 'cross reference', yr: 'year'
};

/**
 * Generic business synonyms; the first word of a group is the concept the
 * others fold onto. Organisation-specific terms (an acquired company's words)
 * belong in the customer's vocabulary file, not here.
 */
export const DEFAULT_SYNONYMS: ReadonlyArray<readonly string[]> = [
  ['customer', 'client', 'buyer', 'shopper', 'consumer'],
  ['order', 'purchase'],
  ['supplier', 'vendor'],
  ['employee', 'staff', 'worker'],
  ['product', 'item', 'sku', 'good', 'article'],
  ['shipment', 'delivery', 'dispatch'],
  ['refund', 'reimbursement'],
  ['invoice', 'bill'],
  ['payment', 'remittance', 'settlement'],
  ['promotion', 'offer'],
  ['loyalty', 'reward'],
  ['ticket', 'case'],
  ['warehouse', 'depot'],
  ['identifier', 'key']
];

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'each', 'every', 'find', 'for', 'from', 'get', 'give',
  'has', 'have', 'no', 'not', 'hold', 'how', 'i', 'in', 'into', 'is', 'it', 'its', 'list', 'me', 'my', 'of', 'on', 'or', 'our', 'per', 'record',
  'show', 'so', 'that', 'the', 'their', 'them', 'there', 'these', 'this', 'to', 'track', 'used', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'will', 'with', 'table', 'tables', 'data', 'column', 'columns', 'please', 'all', 'some', 'sent'
]);

export interface VocabularyFile {
  abbreviations?: Record<string, string>;
  synonyms?: string[][];
}

export interface Vocabulary {
  abbreviations: Map<string, string[]>;
  /** word → concept (the first word of its synonym group). */
  synonyms: Map<string, string>;
}

/** Which deterministic signals are on — all of them in AutoDE; the eval switches them off one by one to measure each. */
export interface VocabularySignals {
  abbreviations: boolean;
  synonyms: boolean;
}

export const ALL_SIGNALS: VocabularySignals = { abbreviations: true, synonyms: true };

export function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (/(sses|xes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) return word.slice(0, -1);
  return word;
}

/** Builds a vocabulary from the defaults plus a customer's additions (theirs win on conflict). */
export function buildVocabulary(extra?: VocabularyFile): Vocabulary {
  const abbreviations = new Map<string, string[]>();
  const add = (abbr: string, expansion: string) => {
    const words = String(expansion).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(singularize);
    if (words.length) abbreviations.set(String(abbr).toLowerCase(), words);
  };
  for (const [k, v] of Object.entries(DEFAULT_ABBREVIATIONS)) add(k, v);
  for (const [k, v] of Object.entries(extra?.abbreviations ?? {})) add(k, v);
  const synonyms = new Map<string, string>();
  const group = (words: readonly string[]) => {
    const norm = words.map((w) => singularize(String(w).toLowerCase().trim())).filter(Boolean);
    if (norm.length < 2) return;
    // A customer group that shares a word with an existing group joins it.
    const concept = norm.map((w) => synonyms.get(w)).find((c) => !!c) ?? norm[0];
    for (const w of norm) synonyms.set(w, concept);
  };
  for (const g of DEFAULT_SYNONYMS) group(g);
  for (const g of extra?.synonyms ?? []) if (Array.isArray(g)) group(g);
  return { abbreviations, synonyms };
}

/** Parses `.autode/knowledge/vocabulary.yaml`; malformed content yields an empty file. */
export function parseVocabularyFile(text: string | undefined): VocabularyFile {
  if (!text || !text.trim()) return {};
  let raw: VocabularyFile | null;
  try {
    raw = parseYaml(text) as VocabularyFile | null;
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const abbreviations: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.abbreviations ?? {})) if (typeof v === 'string') abbreviations[k] = v;
  const synonyms = (Array.isArray(raw.synonyms) ? raw.synonyms : []).filter((g): g is string[] => Array.isArray(g)).map((g) => g.map(String));
  return { abbreviations, synonyms };
}

/** Raw words: separators and camel-case boundaries split, lower-cased, digits dropped. */
export function splitWords(text: string): string[] {
  return String(text ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 0);
}

/**
 * The concepts a piece of text stands for. `dropStopWords` is for requests
 * (prose); physical names keep every token.
 */
export function concepts(text: string, vocab: Vocabulary, signals: VocabularySignals = ALL_SIGNALS, dropStopWords = false): string[] {
  const out: string[] = [];
  for (const raw of splitWords(text)) {
    if (dropStopWords && STOP_WORDS.has(raw)) continue;
    const expanded = signals.abbreviations ? vocab.abbreviations.get(raw) : undefined;
    const words = expanded ?? [singularize(raw)];
    for (const w of words) {
      if (w.length < 2 || (dropStopWords && STOP_WORDS.has(w))) continue;
      out.push(signals.synonyms ? vocab.synonyms.get(w) ?? w : w);
    }
  }
  return out;
}

// ── Vocabulary capture (Phase C4a, item 11) ──────────────────────────────────

/** A proposed vocabulary entry, for the engineer to accept or reject. */
export interface VocabularyProposal {
  kind: 'abbreviation' | 'synonym';
  /** The abbreviation, or the word to fold. */
  from: string;
  /** The expansion, or the word it means. */
  to: string;
  source: 'comments' | 'llm';
  /** How many names/comments support it (mined) — 0 for LLM proposals. */
  support: number;
  example?: string;
}

/**
 * Mines abbreviations from names whose comments spell them out —
 * `CUST_NO` "Customer number" → CUST = customer — without an LLM: a token is
 * proposed for a comment word that starts with the same letter and contains
 * the token's letters in order. Tokens the vocabulary already expands, and
 * tokens that are themselves words of the comments, are skipped.
 */
export function mineAbbreviations(items: ReadonlyArray<{ name: string; comment?: string }>, vocab: Vocabulary): VocabularyProposal[] {
  const votes = new Map<string, Map<string, { n: number; example: string }>>();
  const commentWords = new Set<string>();
  for (const it of items) for (const w of splitWords(it.comment ?? '')) commentWords.add(w);
  const subsequence = (t: string, w: string) => { let i = 0; for (const ch of w) if (ch === t[i]) i++; return i === t.length; };
  for (const it of items) {
    if (!it.comment) continue;
    const words = splitWords(it.comment).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
    for (const t of splitWords(it.name)) {
      if (t.length < 2 || t.length > 6 || vocab.abbreviations.has(t) || commentWords.has(t)) continue;
      const w = words.find((x) => x.length > t.length && x[0] === t[0] && subsequence(t, x));
      if (!w) continue;
      const m = votes.get(t) ?? new Map<string, { n: number; example: string }>();
      const cur = m.get(w) ?? { n: 0, example: `${it.name} "${it.comment}"` };
      cur.n++;
      m.set(w, cur);
      votes.set(t, m);
    }
  }
  const out: VocabularyProposal[] = [];
  for (const [t, m] of votes) {
    const ranked = [...m.entries()].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1));
    if (ranked.length > 1 && ranked[0][1].n === ranked[1][1].n) continue; // ambiguous: leave it to the engineer
    out.push({ kind: 'abbreviation', from: t, to: singularize(ranked[0][0]), source: 'comments', support: ranked[0][1].n, example: ranked[0][1].example });
  }
  return out.sort((a, b) => b.support - a.support || (a.from < b.from ? -1 : 1));
}

export function buildVocabularyProposalPrompt(documents: ReadonlyArray<{ path: string; text: string }>, existing: Vocabulary): { system: string; user: string } {
  return {
    system: [
      'You read a customer\'s business documents and list the vocabulary a search over their data estate needs: abbreviations used in physical names, and words this organisation uses for concepts other organisations name differently (e.g. "patron" for customer, "engagement" for campaign).',
      'Respond with one JSON object only: { "abbreviations": { "<ABBR>": "<expansion>" }, "synonyms": [ ["<common word>", "<their word>"] ] }.',
      'Synonyms are single words: retrieval matches word by word, so a phrase ("money back") can never match and is dropped.',
      'Only entries the documents support. Skip anything already known.'
    ].join('\n'),
    user: `Already known abbreviations: ${[...existing.abbreviations.keys()].slice(0, 200).join(', ')}\n\n${documents.map((d) => `## ${d.path}\n${d.text.slice(0, 20_000)}`).join('\n\n')}\n\nList the vocabulary now.`
  };
}

export function parseVocabularyProposal(raw: unknown, existing: Vocabulary): VocabularyProposal[] {
  if (!raw || typeof raw !== 'object') return [];
  const r = raw as { abbreviations?: Record<string, unknown>; synonyms?: unknown[] };
  const out: VocabularyProposal[] = [];
  for (const [k, v] of Object.entries(r.abbreviations ?? {})) {
    const from = k.toLowerCase().trim();
    if (typeof v === 'string' && /^[a-z0-9]{1,10}$/.test(from) && !existing.abbreviations.has(from) && v.trim()) out.push({ kind: 'abbreviation', from, to: v.trim().toLowerCase(), source: 'llm', support: 0 });
  }
  for (const g of Array.isArray(r.synonyms) ? r.synonyms : []) {
    if (!Array.isArray(g) || g.length < 2) continue;
    // Single words only: concepts() matches word by word, so an accepted phrase would silently do nothing.
    const words = g.map((x) => String(x).toLowerCase().trim()).filter((x) => /^[a-z]+$/.test(x)).map(singularize);
    if (words.length < 2) continue;
    const [to, ...rest] = words;
    for (const from of rest) if (from !== to && existing.synonyms.get(from) !== (existing.synonyms.get(to) ?? to)) out.push({ kind: 'synonym', from, to, source: 'llm', support: 0 });
  }
  return out;
}

/** Adds accepted proposals to a vocabulary file's text (theirs first, then ours), keeping what was there. */
export function mergeVocabularyFile(existingText: string | undefined, accepted: readonly VocabularyProposal[]): string {
  const file = parseVocabularyFile(existingText);
  const abbreviations = { ...(file.abbreviations ?? {}) };
  const synonyms = [...(file.synonyms ?? [])];
  for (const p of accepted) {
    if (p.kind === 'abbreviation') abbreviations[p.from.toUpperCase()] = p.to;
    else synonyms.push([p.to, p.from]);
  }
  const lines = ['# Vocabulary for retrieval: abbreviations and synonyms (extends AutoDE\'s defaults; yours win). Edited by hand or via "AutoDE: Propose Vocabulary".'];
  if (synonyms.length) lines.push('synonyms:', ...synonyms.map((g) => `  - [${g.map((w) => JSON.stringify(w)).join(', ')}]`));
  if (Object.keys(abbreviations).length) lines.push('abbreviations:', ...Object.entries(abbreviations).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`));
  return lines.join('\n') + '\n';
}
