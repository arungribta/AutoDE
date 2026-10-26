import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContextFileManager } from './contextFileManager';
import { BusinessPack, DocumentAuthority, DocumentRole, PackDocument, contentSha, emptyPack, serializePack, upsertDocument } from './pack';
import { InterpretationProfile, applyProfile, buildProfileProposalPrompt, parseProfileProposal, parseStructured, profileMatches, serializeProfile } from './profiles';
import { ReconcileResult, documentClauses, reconcileContract } from './contracts';
import { ConformanceReport } from './conformance';
import { ProbeExecutor, ProbeResolver, VerifyOutcome, combineProbeExecutors, createProbeResolver, verifyAssertions } from './probes';
import { STRUCTURED_DOCUMENT, loadProfiles, packConformance, probeCandidates, profileFor, readPackDocument, readPackFile, sampleProbeExecutor } from './packChecks';
import { buildDocumentExtractionPrompt, parseDocumentExtraction, recordExtraction, splitSections } from './documentExtraction';
import { VocabularyProposal, buildVocabulary, buildVocabularyProposalPrompt, mergeVocabularyFile, mineAbbreviations, parseVocabularyFile, parseVocabularyProposal } from './vocabulary';
import { createSubjectResolver } from './projection';
import { writeFileAtomic, nodeFileIo } from './contextStore';
import { layoutPath } from '../workspaceLayout';

/** One structured LLM call: system + user prompt in, parsed JSON out. */
export type CompleteJson = (system: string, user: string, purpose: string) => Promise<unknown>;

export type ApplyOutcome =
  | { status: 'applied'; reconcile: ReconcileResult; warnings: string[]; profileId: string }
  | { status: 'profile_proposed'; profilePath: string; errors?: string[] }
  | { status: 'needs_profile'; reason: string }
  | { status: 'extracted'; proposed: number; dropped: string[] }
  | { status: 'needs_llm'; reason: string }
  | { status: 'registered' }
  | { status: 'error'; reason: string };

/** What reading a document needs from a model (v0.45.13). */
export type ReadingRequest =
  | { kind: 'facts'; document: string; sha: string; sections: Array<{ id: string; heading: string }>; prompt: { system: string; user: string } }
  | { kind: 'profile'; document: string; prompt: { system: string; user: string } }
  | { kind: 'none'; document: string; reason: string };

const STRUCTURED = STRUCTURED_DOCUMENT;

/**
 * The business-problem pack of the active problem (Phase C4a): its documents
 * (`<problem>/pack/pack.yaml`), the interpretation profiles that read them
 * (`.autode/knowledge/profiles/`), and what they contribute — contract clauses,
 * extracted proposals, samples for probes, conformance reports and
 * vocabulary proposals. The context layer's ledger is the record.
 */
export class BusinessPackManager {
  private pack: BusinessPack = emptyPack();
  private profiles: InterpretationProfile[] = [];

  public constructor(
    private readonly packDir: string,
    private readonly workspaceRoot: string,
    /** A getter: the host recreates its ContextFileManager (e.g. after Source Assessment). */
    private readonly cfmOf: () => ContextFileManager,
    private readonly log: (msg: string) => void,
    private readonly complete?: CompleteJson
  ) {}

  private get cfm(): ContextFileManager { return this.cfmOf(); }
  private get packFile(): string { return path.join(this.packDir, 'pack.yaml'); }
  private get profilesDir(): string { return layoutPath(this.workspaceRoot, 'profiles'); }

  public async load(): Promise<void> {
    this.pack = readPackFile(this.packDir);
    this.profiles = loadProfiles(this.workspaceRoot, this.log);
  }

  public getPack(): BusinessPack { return this.pack; }
  public getProfiles(): readonly InterpretationProfile[] { return this.profiles; }

  private async savePack(): Promise<void> {
    fs.mkdirSync(this.packDir, { recursive: true });
    await writeFileAtomic(nodeFileIo, this.packFile, serializePack(this.pack));
  }

  private rel(p: string): string {
    const abs = path.isAbsolute(p) ? p : path.join(this.workspaceRoot, p);
    const r = path.relative(this.workspaceRoot, abs);
    return (r.startsWith('..') ? abs : r).split(path.sep).join('/');
  }

  private read(doc: PackDocument): string {
    return readPackDocument(this.workspaceRoot, doc);
  }

  /** Registers (or updates) a document; applying it is a separate step. */
  public async addDocument(input: { path: string; role: DocumentRole; authority: DocumentAuthority; version: string; table?: string; profileId?: string }): Promise<PackDocument> {
    this.pack = upsertDocument(this.pack, { ...input, path: this.rel(input.path) });
    await this.savePack();
    return this.pack.documents.find((d) => d.path === this.rel(input.path))!;
  }

  private profileFor(doc: PackDocument, parsed: unknown): InterpretationProfile | undefined {
    return profileFor(this.profiles, doc, parsed);
  }

  /**
   * Reads one document into the context layer. Structured documents go
   * through a confirmed interpretation profile (one is proposed for review
   * when none fits); free text through the extractor (needs the LLM); samples
   * are only registered — probes read them.
   */
  public async applyDocument(id: string): Promise<ApplyOutcome> {
    const doc = this.pack.documents.find((d) => d.id === id);
    if (!doc) return { status: 'error', reason: `no document "${id}" in the pack` };
    if (doc.role === 'sample') return { status: 'registered' };
    let content: string;
    try { content = this.read(doc); } catch (err) { return { status: 'error', reason: `cannot read ${doc.path}: ${err instanceof Error ? err.message : String(err)}` }; }
    const sha = contentSha(content);
    const ledger = this.cfm.getLedger();
    if (STRUCTURED.test(doc.path)) {
      let parsed: unknown;
      try { parsed = parseStructured(content); } catch (err) { return { status: 'error', reason: `${doc.path} is not valid YAML/JSON: ${err instanceof Error ? err.message : String(err)}` }; }
      const profile = this.profileFor(doc, parsed);
      if (!profile) {
        const proposedAlready = this.profiles.find((p) => p.status === 'proposed' && profileMatches(parsed, p));
        if (proposedAlready) return { status: 'needs_profile', reason: `profile "${proposedAlready.id}" is waiting for review: set its status to confirmed once it reads the document correctly` };
        if (!this.complete) return { status: 'needs_profile', reason: 'no confirmed profile fits this document, and proposing one needs a model (in an agent host: autode_pack_reading, then autode_pack_record_reading)' };
        const { system, user } = buildProfileProposalPrompt(parsed, doc.path);
        const r = await this.recordProfile(id, await this.complete(system, user, `Propose a reading profile for ${doc.path}`));
        return r.status === 'error' ? { status: 'needs_profile', reason: r.reason } : r;
      }
      const model = applyProfile(parsed, profile);
      const reconcile = await reconcileContract(ledger, doc, model, sha);
      this.pack = upsertDocument(this.pack, { ...doc, sha, profileId: profile.id });
      await this.savePack();
      await this.cfm.persistCompiledGraph();
      return { status: 'applied', reconcile, warnings: model.warnings, profileId: profile.id };
    }
    if (!this.complete) return { status: 'needs_llm', reason: 'extracting facts from free text needs a model (in an agent host: autode_pack_reading, then autode_pack_record_reading)' };
    const reading = this.readingFor(id);
    if (reading.kind !== 'facts') return { status: 'error', reason: reading.kind === 'none' ? reading.reason : 'unexpected reading' };
    return this.recordFacts(id, await this.complete(reading.prompt.system, reading.prompt.user, `Extract facts from ${doc.path}`), reading.sha);
  }

  /**
   * What reading a document needs from a model (v0.45.13): the facts prompt with its sections for free
   * text, a profile proposal for a structured document no confirmed profile reads, or nothing. The panel
   * sends it to its LLM; an agent host's model answers it, and either way the answer comes back through
   * `recordFacts` or `recordProfile`, checked the same way.
   */
  public readingFor(id: string): ReadingRequest {
    const doc = this.pack.documents.find((d) => d.id === id);
    if (!doc) return { kind: 'none', document: id, reason: `no document "${id}" in the pack` };
    if (doc.role === 'sample') return { kind: 'none', document: id, reason: 'a sample is not read: probes use it' };
    let content: string;
    try { content = this.read(doc); } catch (err) { return { kind: 'none', document: id, reason: `cannot read ${doc.path}: ${err instanceof Error ? err.message : String(err)}` }; }
    if (STRUCTURED.test(doc.path)) {
      let parsed: unknown;
      try { parsed = parseStructured(content); } catch (err) { return { kind: 'none', document: id, reason: `${doc.path} is not valid YAML/JSON: ${err instanceof Error ? err.message : String(err)}` }; }
      if (this.profileFor(doc, parsed)) return { kind: 'none', document: id, reason: 'a confirmed profile reads it: apply it (autode_pack_apply), no model needed' };
      const waiting = this.profiles.find((p) => p.status === 'proposed' && profileMatches(parsed, p));
      if (waiting) return { kind: 'none', document: id, reason: `profile "${waiting.id}" is waiting for a person's review` };
      return { kind: 'profile', document: id, prompt: buildProfileProposalPrompt(parsed, doc.path) };
    }
    const sections = splitSections(content);
    return { kind: 'facts', document: id, sha: contentSha(content), sections: sections.map((s) => ({ id: s.path, heading: s.heading })), prompt: buildDocumentExtractionPrompt(doc, sections) };
  }

  /**
   * Records facts a model read from a free-text document: each must name a section the document has, be
   * of an extractable kind and valid; subjects are resolved against the estate. Recorded as proposed facts
   * citing their section, for a person to confirm; one already proposed or live is skipped. Refused when
   * the document changed since it was read (`sha`).
   */
  public async recordFacts(id: string, raw: unknown, sha?: string): Promise<ApplyOutcome> {
    const doc = this.pack.documents.find((d) => d.id === id);
    if (!doc) return { status: 'error', reason: `no document "${id}" in the pack` };
    if (STRUCTURED.test(doc.path) || doc.role === 'sample') return { status: 'error', reason: `${doc.path} is not free text: its facts come from its profile` };
    let content: string;
    try { content = this.read(doc); } catch (err) { return { status: 'error', reason: `cannot read ${doc.path}: ${err instanceof Error ? err.message : String(err)}` }; }
    const now = contentSha(content);
    if (sha && sha !== now) return { status: 'error', reason: `${doc.path} changed since it was read: read it again` };
    const outcome = parseDocumentExtraction(raw, doc, splitSections(content), now, createSubjectResolver(this.cfm.getPackSources().graph));
    const proposed = await recordExtraction(this.cfm.getLedger(), outcome);
    this.pack = upsertDocument(this.pack, { ...doc, sha: now });
    await this.savePack();
    await this.cfm.persistCompiledGraph();
    return { status: 'extracted', proposed, dropped: outcome.dropped };
  }

  /** Records a proposed interpretation profile (a person confirms it by setting `status: confirmed`). */
  public async recordProfile(id: string, raw: unknown): Promise<ApplyOutcome> {
    const doc = this.pack.documents.find((d) => d.id === id);
    if (!doc) return { status: 'error', reason: `no document "${id}" in the pack` };
    const { profile: proposal, errors } = parseProfileProposal(raw);
    if (!proposal) return { status: 'error', reason: `the proposed profile was not valid: ${errors.join('; ')}` };
    if (this.profiles.some((p) => p.id === proposal.id && p.status === 'confirmed')) return { status: 'error', reason: `profile "${proposal.id}" is already confirmed: propose it under another id` };
    fs.mkdirSync(this.profilesDir, { recursive: true });
    const file = path.join(this.profilesDir, `${proposal.id}.yaml`);
    await writeFileAtomic(nodeFileIo, file, serializeProfile(proposal));
    this.profiles = [...this.profiles.filter((p) => p.id !== proposal.id), proposal];
    return { status: 'profile_proposed', profilePath: file };
  }

  /** Probes over the pack's sample documents, keyed by the table each is a sample of. */
  public sampleExecutor(): ProbeExecutor | undefined {
    return sampleProbeExecutor(this.pack, (d) => this.read(d), this.log);
  }

  /** Live probes where a connection reaches the table, else samples. */
  public probeExecutor(live?: ProbeExecutor): ProbeExecutor | undefined {
    return combineProbeExecutors([live, this.sampleExecutor()]);
  }

  /** Every contract document with a confirmed profile, checked against the catalog and probes. */
  public async conformance(executor?: ProbeExecutor): Promise<{ reports: ConformanceReport[]; markdown: string }> {
    const { reports, markdown } = await packConformance(this.pack, this.profiles, (d) => this.read(d), this.cfm.getCatalog(), executor, this.log);
    return { reports, markdown };
  }

  /** Resolves graph table/column ids to probe targets. */
  public probeResolver(): ProbeResolver {
    return createProbeResolver(this.cfm.getPackSources().graph);
  }

  /**
   * Probes the claims probes can test — keys, grains, relationships and data
   * expectations about physical tables that are not yet verified — and
   * records pass/fail in the ledger.
   */
  public async verifyClaims(executor: ProbeExecutor | undefined): Promise<VerifyOutcome[]> {
    if (!executor) return [];
    const candidates = probeCandidates(this.cfm.getLedger().assertions());
    const out = await verifyAssertions(this.cfm.getLedger(), candidates, executor, this.probeResolver());
    if (out.some((o) => o.result && o.result.pass !== undefined)) await this.cfm.persistCompiledGraph();
    return out;
  }

  /** Vocabulary proposals: mined from catalog names and comments, plus the LLM's reading of the pack's documents when available. */
  public async proposeVocabulary(): Promise<VocabularyProposal[]> {
    const file = layoutPath(this.workspaceRoot, 'vocabulary');
    const vocab = buildVocabulary(parseVocabularyFile(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined));
    const items = this.cfm.getCatalog().all().flatMap((e) => [{ name: e.table.label, comment: e.table.description }, ...(e.columns ?? []).map((c) => ({ name: c.label, comment: c.description }))]);
    const proposals = mineAbbreviations(items, vocab);
    if (this.complete) {
      const docs = this.pack.documents.filter((d) => d.role !== 'sample').map((d) => { try { return { path: d.path, text: this.read(d) }; } catch { return undefined; } }).filter((d): d is { path: string; text: string } => !!d);
      if (docs.length) {
        const { system, user } = buildVocabularyProposalPrompt(docs, vocab);
        try {
          const seen = new Set(proposals.map((p) => `${p.kind}|${p.from}`));
          for (const p of parseVocabularyProposal(await this.complete(system, user, 'Propose retrieval vocabulary from the business-problem pack'), vocab)) if (!seen.has(`${p.kind}|${p.from}`)) proposals.push(p);
        } catch (err) {
          this.log(`Vocabulary proposal from documents failed (mined proposals still shown): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return proposals;
  }

  /** Writes accepted proposals to `.autode/knowledge/vocabulary.yaml` and re-indexes. */
  public async acceptVocabulary(accepted: readonly VocabularyProposal[]): Promise<void> {
    if (!accepted.length) return;
    const file = layoutPath(this.workspaceRoot, 'vocabulary');
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    await writeFileAtomic(nodeFileIo, file, mergeVocabularyFile(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined, accepted));
    await this.cfm.reloadVocabulary();
  }

  /** Live contract clauses this pack contributes — what a spec references instead of copying (item 10). */
  public clauseIds(): string[] {
    const all = this.cfm.getLedger().assertions();
    return this.pack.documents.filter((d) => d.role === 'contract').flatMap((d) => documentClauses(all, d).map((a) => a.id));
  }

  /** A prompt block for spec synthesis: the documents and their clauses, by statement. */
  public summary(maxClauses = 60): string {
    if (!this.pack.documents.length) return '';
    const all = this.cfm.getLedger().assertions();
    const L = ['## Business-problem pack', ...this.pack.documents.map((d) => `- ${d.path} — ${d.role}, ${d.authority}, version ${d.version}`)];
    const clauses = this.pack.documents.filter((d) => d.role === 'contract').flatMap((d) => documentClauses(all, d));
    if (clauses.length) L.push('', '### Contract clauses (reference them; do not restate them in the specification)', ...clauses.slice(0, maxClauses).map((a) => `- [${a.id}] ${a.statement}`));
    return L.join('\n');
  }
}
