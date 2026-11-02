import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml, stringifyYaml } from '../../context/Yaml';
import { layoutPath } from '../../workspaceLayout';
import { Catalog, checkOperation, checksumOf, loadCatalog } from './load';
import { PlatformOperation } from './types';

/**
 * POP3, agent-proposed operations (docs/specs/platform-operations.md §6.4): an agent that did something on a
 * platform no operation covers proposes the operation file. The engine checks it before a person sees it: the
 * format, the read-only guard for reads, and a recorded example (the parameters it ran with and the rows the
 * platform returned) that binds and maps. It is written under `.autode/config/platform-operations/proposed/`, so an
 * approved team file with the same id keeps running until a person approves the proposal (decision kind
 * `platform_operation`); from then on it runs through the executor with no model.
 */

export interface OperationProposalInput {
  /** The operation: an object, or its YAML text. */
  operation: unknown;
  /** Why it is needed: what the agent did that no operation covered, or the drift it fixes. */
  reason: string;
  /** The maintenance item it fixes (`operation-drift:…`), if any. */
  fixes?: string;
}

export interface PreparedProposal {
  op?: PlatformOperation;
  /** Workspace-relative, where it is (or would be) written. */
  file: string;
  text: string;
  problems: string[];
  /** The operations it resembles, for the reviewer: same area and platforms, shared parameters and statement words. */
  resembles: Array<{ id: string; title: string; score: number }>;
}

const SQL_WORDS = new Set(['select', 'from', 'where', 'order', 'group', 'having', 'limit', 'join', 'left', 'inner', 'union', 'distinct', 'case', 'when', 'then', 'else', 'null', 'true', 'false', 'like', 'with', 'cast', 'coalesce', 'lower', 'upper', 'current_database']);
/** The names a statement reads (views, columns, CLI words), without SQL's own words or the parameters. */
const words = (op: PlatformOperation) => new Set((Object.values(op.platforms).map((p) => `${p.sql ?? ''} ${(p.cli ?? []).join(' ')}`).join(' ').replace(/\{[^}]*\}/g, ' ').toLowerCase().match(/[a-z_][a-z0-9_$]{2,}/g) ?? []).filter((w) => !SQL_WORDS.has(w)));

/** The catalog's operations most like this one (another id), most alike first. */
export function resemblingOperations(catalog: Catalog, op: PlatformOperation, n = 3): PreparedProposal['resembles'] {
  const mine = words(op);
  const params = new Set(op.params.map((p) => p.name));
  const seen = new Set<string>();
  return catalog.operations.filter((o) => o.status === 'approved' && o.item.id !== op.id && !seen.has(o.item.id) && !!seen.add(o.item.id)).map((o) => {
    const theirs = words(o.item);
    const shared = [...mine].filter((w) => theirs.has(w)).length;
    const score = (o.item.area === op.area ? 2 : 0) + Object.keys(o.item.platforms).filter((p) => op.platforms[p]).length + o.item.params.filter((p) => params.has(p.name)).length + shared;
    return { id: o.item.id, title: o.item.title, score };
  }).filter((x) => x.score > 2).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, n);
}

/**
 * Where a proposal is written: named by its operation and its content, so a later proposal (a fix) never
 * overwrites one a person already approved, which keeps running until the fix is approved.
 */
export function proposalFile(workspaceRoot: string, id: string, text: string): string {
  return layoutPath(workspaceRoot, 'platformOperations', 'proposed', `${id}.${checksumOf(text).slice(0, 8)}.yaml`);
}

/** Parses and checks a proposal; nothing is written. */
export function prepareOperationProposal(scope: { resourcesRoot?: string; workspaceRoot: string }, input: OperationProposalInput, catalog: Catalog = loadCatalog(scope)): PreparedProposal {
  const problems: string[] = [];
  let op: PlatformOperation | undefined;
  try {
    const raw = typeof input.operation === 'string' ? parseYaml(input.operation) : input.operation;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) problems.push('The operation must be an object (or its YAML): formatVersion, id, title, description, kind, area, params, returns, platforms, example.');
    else op = raw as PlatformOperation;
  } catch (err) { problems.push(`The operation isn't valid YAML: ${err instanceof Error ? err.message : String(err)}`); }
  if (!input.reason?.trim()) problems.push('Say why it is needed (reason): what you did on the platform that no operation covers, or the drift it fixes.');
  const id = op && typeof op.id === 'string' && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(op.id) ? op.id : undefined;
  if (op && !id) problems.push('The operation needs an id: area.name, for example estate.list_stages.');
  if (op) {
    // Codified: without a recorded example nobody (and no test) can see what it returns.
    if (!op.example || !Array.isArray(op.example.rows) || !op.example.rows.length) problems.push('A proposal needs a recorded example: the parameters it ran with (example.params), the platform it ran on (example.platform) and at least one row the platform returned (example.rows). Run the statement read-only first (autode_execute_query or autode_platform_run) and copy what came back.');
    const effective = new Map(catalog.platforms.filter((p) => p.status === 'approved').map((p) => [p.item.id, p.item] as const));
    for (const pid of Object.keys(op.platforms ?? {})) if (!effective.has(pid)) problems.push(`${pid} isn't a platform AutoDE knows (autode platform catalog lists them).`);
    problems.push(...checkOperation(op, effective));
  }
  const header = `# Proposed by an agent (POP3): ${input.reason.trim().replace(/\s+/g, ' ').slice(0, 300)}${input.fixes ? `\n# Fixes: ${input.fixes}` : ''}\n# A draft until a person approves it in the Platform catalog (or autode decisions approve).\n`;
  const text = op ? header + stringifyYaml(op) : '';
  const file = id ? path.relative(scope.workspaceRoot, proposalFile(scope.workspaceRoot, id, text)).split(path.sep).join('/') : '';
  const comparable = !!op && !!id && !!op.platforms && typeof op.platforms === 'object' && Array.isArray(op.params);
  return { ...(op ? { op } : {}), file, text, problems: [...new Set(problems)], resembles: comparable && op ? resemblingOperations(catalog, op) : [] };
}

/** Writes the checked proposal; the caller files the decision for its exact checksum. */
export function writeOperationProposal(workspaceRoot: string, p: PreparedProposal): { file: string; checksum: string } {
  if (p.problems.length || !p.op) throw new Error(`The operation can't be proposed: ${p.problems.join(' ')}`);
  const full = path.join(workspaceRoot, p.file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, p.text);
  return { file: p.file, checksum: checksumOf(p.text) };
}

/**
 * After a proposal is approved: the team's other files with the same id are drafts now (their approval no longer
 * matches); they are moved to `.autode/local/replaced-operations/` so the catalog shows one file per operation.
 */
export function retireReplaced(scope: { resourcesRoot?: string; workspaceRoot: string }, id: string, keep: string, now = new Date()): string[] {
  const moved: string[] = [];
  for (const o of loadCatalog(scope).operations) {
    if (o.item.id !== id || o.origin !== 'team' || o.status === 'approved' || o.file === keep) continue;
    const from = path.join(scope.workspaceRoot, o.file);
    const to = layoutPath(scope.workspaceRoot, 'local', 'replaced-operations', `${now.toISOString().replace(/[:.]/g, '-')}-${path.basename(o.file)}`);
    try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); moved.push(o.file); } catch { /* left in place */ }
  }
  return moved;
}
