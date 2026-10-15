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

/** Generic data-engineering abbreviations. Extended per customer in `.ai-context/context/vocabulary.yaml`. */
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

/** Parses `.ai-context/context/vocabulary.yaml`; malformed content yields an empty file. */
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
