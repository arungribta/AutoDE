import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { parseYaml, stringifyYaml } from '../context/Yaml';
import { createUlidFactory } from '../context/assertions';
import { layoutPath } from '../workspaceLayout';

/**
 * Decisions (docs/specs/mcp-engine.md §3.1 D6, §9.2 Phase PA1;
 * requirements ORC-8, P9). An AI-proposed change to AutoDE's state is never
 * written directly: it becomes a decision that a person resolves, and only an
 * approved decision is applied, by deterministic engine code.
 *
 * Each decision is one file, `.autode/decisions/<id>.yaml` (committed, so a
 * team merges without conflicts), plus its proposal in `<id>.proposal.json`.
 * The YAML's `events` only ever grow. The file is also a human channel: a
 * person sets `resolution.decision` to `approved` or `rejected`, fills `by`,
 * and commits — `syncFileResolutions()` picks that up.
 */

export type DecisionKind =
  | 'assertion' | 'spec_revision' | 'pipeline_spec' | 'mapping' | 'platform_change'
  /** A new or changed data-platform connection (v0.43.1). */
  | 'connection'
  /** Retrieval vocabulary: abbreviations and synonyms (v0.43.3; low stakes — it changes what is found, not what is true). */
  | 'vocabulary'
  /** A problem's planned workflow (PA3a): the planning stage's output. */
  | 'workflow'
  /** PLN1a: the specification's coverage by the workflow; approved before the workflow. */
  | 'coverage'
  /** A workflow stage's approval gate (PA3a), for stages whose output has no approval of its own. */
  | 'gate'
  /** A runbook: platform changes checked by the engine and run by the runner once approved (v0.45.6). */
  | 'runbook'
  /** A shared semantic model or a composite, written by an agent (C5a); approving a shared model's proposal approves that revision. */
  | 'semantic_model'
  /** A knowledge article, written by an agent (MM1); approving the proposal approves that revision. */
  | 'article'
  /** POP1: a team's platform operation or platform definition; approving it approves that exact file (its checksum). */
  | 'platform_operation'
  /** POP5b: a set of platform files approved together, each at its checksum: a system being onboarded, or a pack being imported. */
  | 'platform_bundle'
  /** POP5b: a person's review of a conformance run on a real connection; the onboarded system then counts. */
  | 'platform_conformance'
  /** ONT1: an ontology pack (an industry subset or an extension) imported, grown or with concepts deprecated; a workspace-level change. */
  | 'ontology'
  /** ONT1: a team's standard to onboard from (`autode: standard/1`), researched by an agent or a person. */
  | 'standard'
  /** The panel's existing approvals, recorded for the audit trail. */
  | 'spec_approval' | 'pipeline_spec_approval';

export type Stakes = 'low' | 'high';
/** `tool`: an agent's tool call (its host asks the user). The others need a person at the keyboard or a reviewed commit. */
export type Channel = 'panel' | 'cli' | 'file' | 'tool';
export type DecisionStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'superseded' | 'withdrawn' | 'failed';
export type DecisionEventType = 'proposed' | 'approved' | 'rejected' | 'applied' | 'superseded' | 'failed' | 'withdrawn';

export interface Proposer {
  /** `mcp`, `vscode`, `cli`. */
  host: string;
  /** The MCP client's name (Claude Code, Cursor …) when known. */
  client?: string;
  skill?: string;
  /** Only when the host reports it. */
  model?: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** What was checked, for the reviewer. */
  checks: string[];
}

export interface DecisionEvent {
  at: string;
  type: DecisionEventType;
  actor: string;
  channel?: Channel;
  note?: string;
}

export interface Decision {
  id: string;
  kind: DecisionKind;
  title: string;
  summary: string;
  stakes: Stakes;
  status: DecisionStatus;
  problemId?: string;
  /** What the proposal was based on, to refuse applying it to state that changed meanwhile. */
  subject?: { document?: string; revision?: string; connectionId?: string };
  proposedBy: Proposer;
  proposedAt: string;
  evidence: Array<{ ref: string; quote?: string }>;
  validation: ValidationReport;
  allowedChannels: Channel[];
  /** The file channel: a person fills this in. */
  resolution: { decision: '' | 'approved' | 'rejected'; by: string; note: string };
  events: DecisionEvent[];
  /** sha256 of the proposal's JSON text when the decision was created: what the reviewer saw. Older decisions have none. */
  proposalHash?: string;
}

export type DecisionErrorCode = 'NOT_FOUND' | 'NOT_PENDING' | 'CHANNEL_NOT_ALLOWED' | 'NOT_APPROVED' | 'UNREADABLE';

export class DecisionError extends Error {
  public constructor(public readonly code: DecisionErrorCode, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DecisionError';
  }
}

/** Facts that change no join, key, grain, rule or metric: an agent may accept them with its user's confirmation. */
export const LOW_STAKES_ASSERTION_KINDS: readonly string[] = ['business_term', 'naming_convention', 'assumption'];

/** A fact's stakes: low for the kinds above and for tags (MM1); owners, domains, certification, properties and classifications are a person's. */
export function isLowStakesFact(kind: string, predicate?: string): boolean {
  return LOW_STAKES_ASSERTION_KINDS.includes(kind) || (kind === 'metadata' && predicate === 'tag');
}

/** Stakes are defined here, once; no caller, skill or host can lower them. */
export function stakesFor(kind: DecisionKind, proposal?: unknown): Stakes {
  if (kind === 'vocabulary') return 'low';
  if (kind === 'assertion') {
    const p = (proposal && typeof proposal === 'object' ? proposal : {}) as { kind?: unknown; predicate?: unknown };
    return isLowStakesFact(String(p.kind ?? ''), String(p.predicate ?? '')) ? 'low' : 'high';
  }
  return 'high';
}

export function channelsFor(stakes: Stakes): Channel[] {
  return stakes === 'low' ? ['panel', 'cli', 'file', 'tool'] : ['panel', 'cli', 'file'];
}

export interface NewDecision {
  kind: DecisionKind;
  title: string;
  summary: string;
  proposal: unknown;
  proposedBy: Proposer;
  validation: ValidationReport;
  evidence?: Decision['evidence'];
  subject?: Decision['subject'];
  problemId?: string;
}

const HEADER = '# AutoDE decision (docs/specs/mcp-engine.md §9.2 PA1).\n# To resolve it here: set resolution.decision to approved or rejected, fill resolution.by, and commit.\n# AutoDE applies an approved decision; never edit the other fields.\n';
const ID_RE = /^dec-[0-9A-Z]{26}$/;
/** A claim on a decision being applied is taken over after this long. */
const CLAIM_STALE_MS = 10 * 60 * 1000;
const STATUSES: readonly string[] = ['pending', 'approved', 'rejected', 'applied', 'superseded', 'withdrawn', 'failed'];

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export class DecisionStore {
  private readonly ulid: () => string;
  public readonly directory: string;

  public constructor(workspaceRoot: string, private readonly now: () => Date = () => new Date()) {
    this.directory = layoutPath(workspaceRoot, 'decisions');
    this.ulid = createUlidFactory(() => this.now().getTime());
  }

  private file(id: string, ext: '.yaml' | '.proposal.json'): string {
    if (!ID_RE.test(id)) throw new DecisionError('NOT_FOUND', `"${id}" is not a decision id.`);
    return path.join(this.directory, `${id}${ext}`);
  }

  private save(d: Decision): void {
    writeAtomic(this.file(d.id, '.yaml'), HEADER + stringifyYaml(d));
  }

  public create(input: NewDecision): Decision {
    const stakes = stakesFor(input.kind, input.proposal);
    const at = this.now().toISOString();
    const d: Decision = {
      id: `dec-${this.ulid()}`,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      stakes,
      status: 'pending',
      problemId: input.problemId,
      subject: input.subject,
      proposedBy: input.proposedBy,
      proposedAt: at,
      evidence: input.evidence ?? [],
      validation: input.validation,
      allowedChannels: channelsFor(stakes),
      resolution: { decision: '', by: '', note: '' },
      events: [{ at, type: 'proposed', actor: proposerLabel(input.proposedBy) }]
    };
    const proposalText = JSON.stringify(input.proposal, null, 2) + '\n';
    d.proposalHash = sha256(proposalText);
    writeAtomic(this.file(d.id, '.proposal.json'), proposalText);
    this.save(d);
    return d;
  }

  /** A decision made in the panel's existing flow (spec or Pipeline Spec approval), recorded as resolved and applied. */
  public recordResolved(input: Omit<NewDecision, 'validation'> & { by: string; channel: Channel; note?: string }): Decision {
    const d = this.create({ ...input, validation: { ok: true, errors: [], warnings: [], checks: [] } });
    const at = this.now().toISOString();
    d.status = 'applied';
    d.resolution = { decision: 'approved', by: input.by, note: input.note ?? '' };
    d.events.push({ at, type: 'approved', actor: input.by, channel: input.channel, note: input.note }, { at, type: 'applied', actor: 'autode' });
    this.save(d);
    return d;
  }

  public get(id: string): Decision {
    let text: string;
    const file = this.file(id, '.yaml');
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new DecisionError('NOT_FOUND', `No decision "${id}".`);
      throw new DecisionError('UNREADABLE', `Decision "${id}" can't be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    let raw: unknown;
    try { raw = parseYaml(text); } catch (err) { throw new DecisionError('UNREADABLE', `Decision "${id}" is not valid YAML: ${err instanceof Error ? err.message : String(err)}`); }
    const r = raw as { id?: unknown; status?: unknown } | null;
    if (!r || typeof r !== 'object' || r.id !== id || !STATUSES.includes(String(r.status))) throw new DecisionError('UNREADABLE', `Decision "${id}" is damaged: its id or status is missing or wrong.`);
    return normalise(raw);
  }

  /** sha256 of the proposal file's text as it is on disk now (undefined when it can't be read). */
  public proposalHashOnDisk(id: string): string | undefined {
    try { return sha256(fs.readFileSync(this.file(id, '.proposal.json'), 'utf8')); } catch { return undefined; }
  }

  /**
   * Claims a decision for applying: an exclusive lock file `<id>.applying`. Undefined when another process holds
   * it (fresher than 10 minutes); an older one is taken over. Call `release` when done.
   */
  public claim(id: string): { release: () => void } | undefined {
    const lock = this.file(id, '.yaml').replace(/\.yaml$/, '.applying');
    fs.mkdirSync(this.directory, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(lock, 'wx');
        try { fs.writeSync(fd, `${process.pid} ${this.now().toISOString()}\n`); } finally { fs.closeSync(fd); }
        return { release: () => { try { fs.unlinkSync(lock); } catch { /* already gone */ } } };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        let age = 0;
        try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
        if (age < CLAIM_STALE_MS) return undefined;
        try { fs.unlinkSync(lock); } catch { /* another process took it over */ }
      }
    }
    return undefined;
  }

  public proposal<T = unknown>(id: string): T {
    try { return JSON.parse(fs.readFileSync(this.file(id, '.proposal.json'), 'utf8')) as T; } catch { throw new DecisionError('NOT_FOUND', `The proposal of decision "${id}" is missing.`); }
  }

  public list(filter: { status?: DecisionStatus | DecisionStatus[]; kind?: DecisionKind; problemId?: string } = {}): Decision[] {
    return this.scan(filter).decisions;
  }

  /** Decision files that can't be read, each with why. They are not in `list()`: a caller that shows decisions must show these too. */
  public unreadable(): Array<{ id: string; reason: string }> {
    return this.scan().unreadable;
  }

  private scan(filter: { status?: DecisionStatus | DecisionStatus[]; kind?: DecisionKind; problemId?: string } = {}): { decisions: Decision[]; unreadable: Array<{ id: string; reason: string }> } {
    let names: string[];
    try { names = fs.readdirSync(this.directory).filter((n) => /^dec-[0-9A-Z]{26}\.yaml$/.test(n)).sort(); } catch { return { decisions: [], unreadable: [] }; }
    const statuses = filter.status === undefined ? undefined : Array.isArray(filter.status) ? filter.status : [filter.status];
    const out: Decision[] = [];
    const unreadable: Array<{ id: string; reason: string }> = [];
    for (const n of names) {
      let d: Decision;
      const id = n.slice(0, -5);
      try { d = this.get(id); } catch (err) {
        if (err instanceof DecisionError && err.code === 'NOT_FOUND') continue;
        unreadable.push({ id, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (statuses && !statuses.includes(d.status)) continue;
      if (filter.kind && d.kind !== filter.kind) continue;
      if (filter.problemId && d.problemId && d.problemId !== filter.problemId) continue;
      out.push(d);
    }
    return { decisions: out, unreadable };
  }

  /** Resolves a pending decision through a channel its stakes allow. */
  public resolve(id: string, input: { decision: 'approved' | 'rejected'; by: string; channel: Channel; note?: string }): Decision {
    const d = this.get(id);
    if (d.status !== 'pending') throw new DecisionError('NOT_PENDING', `Decision ${id} is ${d.status}, not pending.`, { status: d.status });
    // Recomputed, never read from the file: an edited `stakes:` must not open the tool channel.
    d.stakes = stakesFor(d.kind, this.proposal(d.id));
    d.allowedChannels = channelsFor(d.stakes);
    if (!d.allowedChannels.includes(input.channel)) {
      throw new DecisionError('CHANNEL_NOT_ALLOWED', `Decision ${id} is ${d.stakes} stakes: it can be resolved only by a person — in the AutoDE panel, with the autode CLI in a terminal, or by editing .autode/decisions/${id}.yaml (resolution.decision, resolution.by) and committing it.`, { stakes: d.stakes, allowedChannels: d.allowedChannels });
    }
    const by = input.by.trim() || 'unknown';
    d.status = input.decision;
    d.resolution = { decision: input.decision, by, note: input.note ?? '' };
    d.events.push({ at: this.now().toISOString(), type: input.decision, actor: by, channel: input.channel, note: input.note });
    this.save(d);
    return d;
  }

  public withdraw(id: string, actor: string, note?: string): Decision {
    return this.transition(id, ['pending'], 'withdrawn', actor, note);
  }

  public markApplied(id: string, note?: string): Decision {
    return this.transition(id, ['approved'], 'applied', 'autode', note);
  }

  public markSuperseded(id: string, note: string): Decision {
    return this.transition(id, ['pending', 'approved'], 'superseded', 'autode', note);
  }

  public markFailed(id: string, note: string): Decision {
    return this.transition(id, ['approved'], 'failed', 'autode', note);
  }

  private transition(id: string, from: DecisionStatus[], to: DecisionStatus & DecisionEventType, actor: string, note?: string): Decision {
    const d = this.get(id);
    if (!from.includes(d.status)) throw new DecisionError('NOT_PENDING', `Decision ${id} is ${d.status}; it can't become ${to}.`, { status: d.status });
    d.status = to;
    d.events.push({ at: this.now().toISOString(), type: to, actor, note });
    this.save(d);
    return d;
  }

  /**
   * The file channel: pending decisions whose `resolution` a person filled in
   * become resolved (`by` is required). Returns the ones resolved now, and
   * those left alone because `by` is missing. With `fileStakes: 'low'` (an agent's channel, the MCP server) a
   * high-stakes decision's file resolution is left alone and listed in `held`: a person's CLI or panel picks it up.
   * Stakes are recomputed from the proposal, never read from the file.
   */
  public syncFileResolutions(opts: { fileStakes?: 'all' | 'low' } = {}): { resolved: Decision[]; incomplete: string[]; held: string[] } {
    const resolved: Decision[] = [];
    const incomplete: string[] = [];
    const held: string[] = [];
    for (const d of this.list({ status: 'pending' })) {
      const r = d.resolution;
      if (r.decision !== 'approved' && r.decision !== 'rejected') continue;
      if (opts.fileStakes === 'low') {
        let stakes: Stakes = 'high';
        try { stakes = stakesFor(d.kind, this.proposal(d.id)); } catch { /* an unreadable proposal counts as high */ }
        if (stakes !== 'low') { held.push(d.id); continue; }
      }
      if (!r.by.trim()) { incomplete.push(d.id); continue; }
      resolved.push(this.resolve(d.id, { decision: r.decision, by: r.by, channel: 'file', note: r.note || undefined }));
    }
    return { resolved, incomplete, held };
  }
}

export function proposerLabel(p: Proposer): string {
  return [p.host, p.client, p.skill && `skill:${p.skill}`].filter(Boolean).join(':');
}

function normalise(raw: unknown): Decision {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Decision;
  const r = (d.resolution ?? {}) as Partial<Decision['resolution']>;
  const decision = r.decision === 'approved' || r.decision === 'rejected' ? r.decision : '';
  return {
    ...d,
    evidence: Array.isArray(d.evidence) ? d.evidence : [],
    events: Array.isArray(d.events) ? d.events : [],
    allowedChannels: Array.isArray(d.allowedChannels) ? d.allowedChannels : channelsFor(d.stakes === 'low' ? 'low' : 'high'),
    resolution: { decision, by: typeof r.by === 'string' ? r.by : '', note: typeof r.note === 'string' ? r.note : '' }
  };
}
