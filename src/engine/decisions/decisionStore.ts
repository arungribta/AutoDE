import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml, stringifyYaml } from '../context/Yaml';
import { createUlidFactory } from '../context/assertions';
import { layoutPath } from '../workspaceLayout';

/**
 * Decisions (docs/mcp-engine-requirements.md §3.1 D6, §9.2 Phase PA1;
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
  /** A workflow stage's approval gate (PA3a), for stages whose output has no approval of its own. */
  | 'gate'
  /** A runbook: platform changes checked by the engine and run by the runner once approved (v0.45.6). */
  | 'runbook'
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
}

export type DecisionErrorCode = 'NOT_FOUND' | 'NOT_PENDING' | 'CHANNEL_NOT_ALLOWED' | 'NOT_APPROVED';

export class DecisionError extends Error {
  public constructor(public readonly code: DecisionErrorCode, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DecisionError';
  }
}

/** Facts that change no join, key, grain, rule or metric: an agent may accept them with its user's confirmation. */
export const LOW_STAKES_ASSERTION_KINDS: readonly string[] = ['business_term', 'naming_convention', 'assumption'];

/** Stakes are defined here, once; no caller, skill or host can lower them. */
export function stakesFor(kind: DecisionKind, proposal?: unknown): Stakes {
  if (kind === 'vocabulary') return 'low';
  if (kind === 'assertion') {
    const k = proposal && typeof proposal === 'object' ? String((proposal as { kind?: unknown }).kind ?? '') : '';
    return LOW_STAKES_ASSERTION_KINDS.includes(k) ? 'low' : 'high';
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

const HEADER = '# AutoDE decision (docs/mcp-engine-requirements.md §9.2 PA1).\n# To resolve it here: set resolution.decision to approved or rejected, fill resolution.by, and commit.\n# AutoDE applies an approved decision; never edit the other fields.\n';
const ID_RE = /^dec-[0-9A-Z]{26}$/;

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
    writeAtomic(this.file(d.id, '.proposal.json'), JSON.stringify(input.proposal, null, 2) + '\n');
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
    try { text = fs.readFileSync(this.file(id, '.yaml'), 'utf8'); } catch { throw new DecisionError('NOT_FOUND', `No decision "${id}".`); }
    return normalise(parseYaml(text));
  }

  public proposal<T = unknown>(id: string): T {
    try { return JSON.parse(fs.readFileSync(this.file(id, '.proposal.json'), 'utf8')) as T; } catch { throw new DecisionError('NOT_FOUND', `The proposal of decision "${id}" is missing.`); }
  }

  public list(filter: { status?: DecisionStatus | DecisionStatus[]; kind?: DecisionKind; problemId?: string } = {}): Decision[] {
    let names: string[];
    try { names = fs.readdirSync(this.directory).filter((n) => /^dec-[0-9A-Z]{26}\.yaml$/.test(n)).sort(); } catch { return []; }
    const statuses = filter.status === undefined ? undefined : Array.isArray(filter.status) ? filter.status : [filter.status];
    const out: Decision[] = [];
    for (const n of names) {
      let d: Decision;
      try { d = this.get(n.slice(0, -5)); } catch { continue; }
      if (statuses && !statuses.includes(d.status)) continue;
      if (filter.kind && d.kind !== filter.kind) continue;
      if (filter.problemId && d.problemId && d.problemId !== filter.problemId) continue;
      out.push(d);
    }
    return out;
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
   * those left alone because `by` is missing.
   */
  public syncFileResolutions(): { resolved: Decision[]; incomplete: string[] } {
    const resolved: Decision[] = [];
    const incomplete: string[] = [];
    for (const d of this.list({ status: 'pending' })) {
      const r = d.resolution;
      if (r.decision !== 'approved' && r.decision !== 'rejected') continue;
      if (!r.by.trim()) { incomplete.push(d.id); continue; }
      resolved.push(this.resolve(d.id, { decision: r.decision, by: r.by, channel: 'file', note: r.note || undefined }));
    }
    return { resolved, incomplete };
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
