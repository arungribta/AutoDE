import { FileIo, nodeFileIo, writeFileAtomic } from './contextStore';
import { Assertion, Evidence, TrustTier, Verification, createUlidFactory, strongerTrust } from './assertions';
import { validateAssertion } from './assertionSchemas';

/**
 * The assertion ledger — context-layer system of record (C2, v0.29.0;
 * docs/context-layer-requirements.md §4.2).
 *
 * Append-only JSON Lines under `.ai-context/ledger/`, one file per writer
 * session (`<yyyy-mm-dd>.<sessionUlid>.jsonl`), so a team sharing a
 * workspace merges without conflicts. Folding every event in id order gives
 * the current assertion set; the same events always fold to the same set.
 * Nothing is ever overwritten: a change supersedes, a removal rejects, and
 * history stays on disk (principle C2).
 */

export type LedgerEventType =
  | 'asserted' | 'confirmed' | 'rejected' | 'superseded' | 'verified' | 'verification_failed' | 'flagged_needs_review'
  /** Phase K1: a graph id was re-keyed (`from` → `to`); `assertionId` is `alias:<from>`. */
  | 'aliased';

export interface LedgerEvent {
  /** ULID; folding order. */
  id: string;
  type: LedgerEventType;
  assertionId: string;
  at: string;
  actor: string;
  /** The event or evidence id that triggered this one — what makes causality traceable (§8.3). */
  causedBy?: string;
  /** `asserted`: the full assertion as created. */
  assertion?: Assertion;
  /** `superseded`: the replacing assertion's id. */
  by?: string;
  /** `confirmed`: the trust tier granted (≥ confirmed). */
  trust?: TrustTier;
  /** `verified` / `verification_failed`. */
  verification?: Verification;
  /** `rejected` / `flagged_needs_review`: why. */
  reason?: string;
  /** `aliased`: the old and new graph id. */
  from?: string;
  to?: string;
}

export interface LedgerSnapshot {
  /** Id of the last event folded into `assertions`. */
  lastEventId: string;
  foldedAt: string;
  assertions: Assertion[];
  /** Graph id aliases (old → new) folded so far (Phase K1). */
  aliases?: Record<string, string>;
}

/** The alias map (old graph id → current id), following chains. */
export function foldAliases(events: readonly LedgerEvent[], snapshot?: LedgerSnapshot): Map<string, string> {
  const raw = new Map<string, string>(Object.entries(snapshot?.aliases ?? {}));
  const after = snapshot?.lastEventId ?? '';
  for (const e of [...events].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    if (e.type === 'aliased' && e.id > after && e.from && e.to && e.from !== e.to) raw.set(e.from, e.to);
  }
  const resolved = new Map<string, string>();
  for (const from of raw.keys()) {
    let to = raw.get(from)!;
    const seen = new Set([from]);
    while (raw.has(to) && !seen.has(to)) { seen.add(to); to = raw.get(to)!; }
    resolved.set(from, to);
  }
  return resolved;
}

/**
 * Applies events (any order — they are sorted by id) on top of an optional
 * snapshot. Pure and deterministic: same inputs → identical output, with
 * assertions sorted by id.
 */
export function foldEvents(events: readonly LedgerEvent[], snapshot?: LedgerSnapshot): Assertion[] {
  const byId = new Map<string, Assertion>();
  for (const a of snapshot?.assertions ?? []) byId.set(a.id, cloneAssertion(a));
  const after = snapshot?.lastEventId ?? '';
  const ordered = events.filter((e) => e.id > after).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (const e of ordered) applyEvent(byId, e);
  return [...byId.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

function cloneAssertion(a: Assertion): Assertion {
  return JSON.parse(JSON.stringify(a)) as Assertion;
}

function applyEvent(byId: Map<string, Assertion>, e: LedgerEvent): void {
  if (e.type === 'asserted') {
    if (e.assertion && !byId.has(e.assertionId)) byId.set(e.assertionId, cloneAssertion(e.assertion));
    return;
  }
  const a = byId.get(e.assertionId);
  if (!a) return; // an event about an unknown assertion (e.g. a pruned history) is ignored, never fatal
  switch (e.type) {
    case 'confirmed':
      if (a.status === 'proposed' || a.status === 'needs_review') a.status = 'active';
      a.trust = strongerTrust(a.trust, e.trust ?? 'confirmed');
      delete a.reviewReason;
      break;
    case 'rejected':
      a.status = 'rejected';
      a.validTo = e.at;
      if (e.reason) a.reviewReason = e.reason;
      break;
    case 'superseded':
      a.status = 'superseded';
      a.validTo = e.at;
      if (e.by) a.supersededBy = e.by;
      break;
    case 'verified':
      a.trust = 'verified';
      if (e.verification) a.verification = { ...e.verification };
      break;
    case 'verification_failed':
      if (a.status !== 'rejected' && a.status !== 'superseded') a.status = 'needs_review';
      if (e.verification) a.verification = { ...e.verification };
      if (e.reason) a.reviewReason = e.reason;
      break;
    case 'flagged_needs_review':
      if (a.status === 'active' || a.status === 'proposed') a.status = 'needs_review';
      if (e.reason) a.reviewReason = e.reason;
      break;
  }
}

/** What a caller supplies to create an assertion; the ledger fills ids, timestamps and defaults. */
export interface NewAssertion {
  kind: Assertion['kind'];
  subject: string[];
  predicate: string;
  value: unknown;
  statement: string;
  evidence: Evidence[];
  trust?: TrustTier;
  status?: Assertion['status'];
  supersedes?: string;
  specId?: string;
  createdBy?: string;
  flags?: string[];
}

export class AssertionValidationError extends Error {
  public constructor(public readonly errors: string[]) {
    super(`Invalid assertion: ${errors.join('; ')}`);
    this.name = 'AssertionValidationError';
  }
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

const SESSION_FILE_RE = /^\d{4}-\d{2}-\d{2}\.[0-9A-Z]{26}\.jsonl$/;

/**
 * One writer session over `<ledgerDir>`. `load()` reads every session file
 * (plus `snapshot.json`), and the mutators append to this session's own
 * file. Not safe for two sessions writing the *same* file — by design each
 * process gets its own.
 */
export class AssertionLedger {
  private readonly ulid: () => string;
  private readonly sessionFile: string;
  private events: LedgerEvent[] = [];
  private snapshot: LedgerSnapshot | undefined;
  private ownLines: string[] = [];
  private folded: Assertion[] | undefined;
  private foldedAliases: Map<string, string> | undefined;
  private loaded = false;

  public constructor(
    private readonly ledgerDir: string,
    private readonly io: FileIo = nodeFileIo,
    private readonly now: () => Date = () => new Date()
  ) {
    this.ulid = createUlidFactory(() => this.now().getTime());
    const sessionId = this.ulid();
    this.sessionFile = joinPath(ledgerDir, `${this.now().toISOString().slice(0, 10)}.${sessionId}.jsonl`);
  }

  public get directory(): string { return this.ledgerDir; }

  /** Reads `snapshot.json` and every session file. Unparseable lines are skipped and reported, never fatal. */
  public async load(): Promise<{ files: number; events: number; skippedLines: number }> {
    this.events = [];
    this.snapshot = undefined;
    this.folded = undefined;
    this.foldedAliases = undefined;
    let skippedLines = 0;
    const snapBytes = await this.io.readFile(joinPath(this.ledgerDir, 'snapshot.json'));
    if (snapBytes) {
      try { this.snapshot = JSON.parse(Buffer.from(snapBytes).toString('utf8')) as LedgerSnapshot; } catch { skippedLines++; }
    }
    const names = ((await this.io.listDir?.(this.ledgerDir)) ?? []).filter((n) => SESSION_FILE_RE.test(n)).sort();
    for (const name of names) {
      const bytes = await this.io.readFile(joinPath(this.ledgerDir, name));
      if (!bytes) continue;
      for (const line of Buffer.from(bytes).toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { this.events.push(JSON.parse(line) as LedgerEvent); } catch { skippedLines++; }
      }
    }
    // Lines this session already wrote (load() after appends) are on disk now — don't keep them twice.
    this.ownLines = [];
    const ownName = this.sessionFile.slice(Math.max(this.sessionFile.lastIndexOf('/'), this.sessionFile.lastIndexOf('\\')) + 1);
    const ownBytes = names.includes(ownName) ? await this.io.readFile(this.sessionFile) : undefined;
    if (ownBytes) this.ownLines = Buffer.from(ownBytes).toString('utf8').split(/\r?\n/).filter((l) => l.trim());
    this.loaded = true;
    return { files: names.length, events: this.events.length, skippedLines };
  }

  /** True when nothing has been recorded yet — no events and no snapshot. */
  public isEmpty(): boolean {
    return this.events.length === 0 && !this.snapshot;
  }

  /**
   * The current assertion set (every status), sorted by id. Subjects that
   * name a re-keyed graph id are reported under the current id (Phase K1),
   * so assertions written before a re-keying still point at their objects.
   */
  public assertions(): Assertion[] {
    if (!this.folded) {
      const aliases = this.aliases();
      const folded = foldEvents(this.events, this.snapshot);
      this.folded = aliases.size === 0 ? folded : folded.map((a) => (a.subject.some((s) => aliases.has(s)) ? { ...a, subject: a.subject.map((s) => aliases.get(s) ?? s) } : a));
    }
    return this.folded;
  }

  /** Graph id aliases recorded so far (old → current). */
  public aliases(): Map<string, string> {
    if (!this.foldedAliases) this.foldedAliases = foldAliases(this.events, this.snapshot);
    return this.foldedAliases;
  }

  /** Builds `aliased` events for a re-keying (one per id). */
  public buildAliasEvents(aliases: ReadonlyMap<string, string>, actor = 'system'): LedgerEvent[] {
    const known = this.aliases();
    return [...aliases].filter(([from, to]) => known.get(from) !== to).map(([from, to]) => ({
      id: this.ulid(), type: 'aliased' as const, assertionId: `alias:${from}`, at: this.now().toISOString(), actor, from, to
    }));
  }

  public get(id: string): Assertion | undefined {
    return this.assertions().find((a) => a.id === id);
  }

  public allEvents(): readonly LedgerEvent[] {
    return this.events;
  }

  /** Every event about one assertion, in order — its causal history. */
  public history(assertionId: string): LedgerEvent[] {
    return this.events.filter((e) => e.assertionId === assertionId).sort((x, y) => (x.id < y.id ? -1 : 1));
  }

  public newId(): string {
    return this.ulid();
  }

  /** Builds (but does not append) an `asserted` event; throws `AssertionValidationError` on an invalid value. */
  public buildAsserted(input: NewAssertion, causedBy?: string): LedgerEvent {
    const errors = validateAssertion(input);
    if (errors.length > 0) throw new AssertionValidationError(errors);
    const at = this.now().toISOString();
    const id = this.ulid();
    const createdBy = input.createdBy ?? 'system';
    const assertion: Assertion = {
      id,
      kind: input.kind,
      subject: [...input.subject],
      predicate: input.predicate,
      value: input.value,
      statement: input.statement,
      status: input.status ?? 'proposed',
      trust: input.trust ?? 'inferred',
      evidence: input.evidence.map((e) => ({ ...e, excerpt: e.excerpt?.slice(0, 300) })),
      validFrom: at,
      createdBy,
      createdAt: at
    };
    if (input.supersedes) assertion.supersedes = input.supersedes;
    if (input.specId) assertion.specId = input.specId;
    if (input.flags && input.flags.length > 0) assertion.flags = [...input.flags];
    return { id: this.ulid(), type: 'asserted', assertionId: id, at, actor: createdBy, causedBy, assertion };
  }

  /** Builds (but does not append) a lifecycle event about an existing assertion. */
  public buildEvent(type: Exclude<LedgerEventType, 'asserted'>, assertionId: string, actor: string, extra: Partial<Pick<LedgerEvent, 'causedBy' | 'by' | 'trust' | 'verification' | 'reason'>> = {}): LedgerEvent {
    return { id: this.ulid(), type, assertionId, at: this.now().toISOString(), actor, ...extra };
  }

  /** Appends events to this session's file in one write. */
  public async append(events: readonly LedgerEvent[]): Promise<void> {
    if (events.length === 0) return;
    if (!this.loaded) await this.load();
    const lines = events.map((e) => JSON.stringify(e));
    const content = [...this.ownLines, ...lines].join('\n') + '\n';
    await writeFileAtomic(this.io, this.sessionFile, content);
    this.ownLines.push(...lines);
    this.events.push(...events);
    this.folded = undefined;
    this.foldedAliases = undefined;
  }

  // ── Convenience mutators (each appends immediately) ──

  /** Records a new assertion. With `supersedes`, the replaced assertion is superseded in the same write. */
  public async assert(input: NewAssertion, causedBy?: string): Promise<Assertion> {
    const asserted = this.buildAsserted(input, causedBy);
    const events = [asserted];
    if (input.supersedes) {
      events.push(this.buildEvent('superseded', input.supersedes, asserted.actor, { by: asserted.assertionId, causedBy: asserted.id }));
    }
    await this.append(events);
    return this.get(asserted.assertionId)!;
  }

  public async confirm(id: string, actor: string, trust: TrustTier = 'confirmed'): Promise<void> {
    await this.append([this.buildEvent('confirmed', id, actor, { trust: strongerTrust(trust, 'confirmed') })]);
  }

  public async reject(id: string, actor: string, reason?: string): Promise<void> {
    await this.append([this.buildEvent('rejected', id, actor, { reason })]);
  }

  /** Replaces `id` with a new assertion (e.g. "Edit & confirm"); the new one supersedes it. */
  public async supersede(id: string, replacement: NewAssertion, causedBy?: string): Promise<Assertion> {
    return this.assert({ ...replacement, supersedes: id }, causedBy);
  }

  public async recordVerification(id: string, verification: Verification, actor = 'system'): Promise<void> {
    const type = verification.result === 'pass' ? 'verified' : 'verification_failed';
    await this.append([this.buildEvent(type, id, actor, { verification, reason: verification.result === 'fail' ? verification.detail : undefined })]);
  }

  public async flag(id: string, reason: string, actor = 'system', causedBy?: string): Promise<void> {
    await this.append([this.buildEvent('flagged_needs_review', id, actor, { reason, causedBy })]);
  }

  /**
   * Compaction (`AutoDE: Compact Context Ledger`): writes `snapshot.json`
   * with the folded state. History is kept unless `prune` is set, in which
   * case session files whose events are all folded into the snapshot are
   * deleted (needs `FileIo.deleteFile`).
   */
  public async compact(options: { prune?: boolean } = {}): Promise<{ assertions: number; prunedFiles: number }> {
    if (!this.loaded) await this.load();
    const assertions = this.assertions();
    const lastEventId = this.events.reduce((max, e) => (e.id > max ? e.id : max), this.snapshot?.lastEventId ?? '');
    const aliasMap = this.aliases();
    const snapshot: LedgerSnapshot = { lastEventId, foldedAt: this.now().toISOString(), assertions: foldEvents(this.events, this.snapshot), ...(aliasMap.size ? { aliases: Object.fromEntries([...aliasMap].sort(([a], [b]) => (a < b ? -1 : 1))) } : {}) };
    await writeFileAtomic(this.io, joinPath(this.ledgerDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
    this.snapshot = snapshot;
    let prunedFiles = 0;
    if (options.prune && this.io.deleteFile) {
      const names = ((await this.io.listDir?.(this.ledgerDir)) ?? []).filter((n) => SESSION_FILE_RE.test(n));
      for (const name of names) {
        await this.io.deleteFile(joinPath(this.ledgerDir, name));
        prunedFiles++;
      }
      this.events = [];
      this.ownLines = [];
    }
    return { assertions: assertions.length, prunedFiles };
  }
}
