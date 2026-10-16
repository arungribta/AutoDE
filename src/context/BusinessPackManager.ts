import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContextFileManager } from './ContextFileManager';
import { BusinessPack, DocumentAuthority, DocumentRole, PackDocument, contentSha, emptyPack, parsePack, serializePack, upsertDocument } from '../engine/context/pack';
import { InterpretationProfile, applyProfile, buildProfileProposalPrompt, parseProfile, parseProfileProposal, parseStructured, profileMatches, serializeProfile } from '../engine/context/profiles';
import { ReconcileResult, documentClauses, reconcileContract } from '../engine/context/contracts';
import { ConformanceReport, checkConformance, renderConformanceReport } from '../engine/context/conformance';
import { ProbeExecutor, ProbeResolver, VerifyOutcome, combineProbeExecutors, createSampleProbeExecutor, parseSampleCsv, verifyAssertions } from '../engine/context/probes';
import { buildDocumentExtractionPrompt, parseDocumentExtraction, recordExtraction, splitSections } from '../engine/context/documentExtraction';
import { VocabularyProposal, buildVocabulary, buildVocabularyProposalPrompt, mergeVocabularyFile, mineAbbreviations, parseVocabularyFile, parseVocabularyProposal } from '../engine/context/vocabulary';
import { createSubjectResolver, isMirror } from '../engine/context/projection';
import { isLive } from '../engine/context/assertions';
import { TableNode } from '../engine/context/types';
import { writeFileAtomic, nodeFileIo } from '../engine/context/contextStore';

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

const STRUCTURED = /\.(ya?ml|json)$/i;

/**
 * The business-problem pack of the active problem (Phase C4a): its documents
 * (`<problem>/pack/pack.yaml`), the interpretation profiles that read them
 * (`.ai-context/profiles/`), and what they contribute — contract clauses,
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
  private get profilesDir(): string { return path.join(this.workspaceRoot, '.ai-context', 'profiles'); }

  public async load(): Promise<void> {
    this.pack = fs.existsSync(this.packFile) ? parsePack(fs.readFileSync(this.packFile, 'utf8')) : emptyPack();
    this.profiles = [];
    if (fs.existsSync(this.profilesDir)) {
      for (const f of fs.readdirSync(this.profilesDir).filter((x) => /\.ya?ml$/i.test(x)).sort()) {
        const { profile, errors } = parseProfile(fs.readFileSync(path.join(this.profilesDir, f), 'utf8'));
        if (profile) this.profiles.push(profile); else this.log(`Profile ${f} is not valid and is ignored: ${errors.join('; ')}`);
      }
    }
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
    return fs.readFileSync(path.isAbsolute(doc.path) ? doc.path : path.join(this.workspaceRoot, doc.path), 'utf8');
  }

  /** Registers (or updates) a document; applying it is a separate step. */
  public async addDocument(input: { path: string; role: DocumentRole; authority: DocumentAuthority; version: string; table?: string; profileId?: string }): Promise<PackDocument> {
    this.pack = upsertDocument(this.pack, { ...input, path: this.rel(input.path) });
    await this.savePack();
    return this.pack.documents.find((d) => d.path === this.rel(input.path))!;
  }

  private profileFor(doc: PackDocument, parsed: unknown): InterpretationProfile | undefined {
    const confirmed = this.profiles.filter((p) => p.status === 'confirmed');
    return (doc.profileId ? confirmed.find((p) => p.id === doc.profileId) : undefined) ?? confirmed.find((p) => profileMatches(parsed, p));
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
        if (!this.complete) return { status: 'needs_profile', reason: 'no confirmed profile fits this document, and proposing one needs the LLM' };
        const { system, user } = buildProfileProposalPrompt(parsed, doc.path);
        const { profile: proposal, errors } = parseProfileProposal(await this.complete(system, user, `Propose a reading profile for ${doc.path}`));
        if (!proposal) return { status: 'needs_profile', reason: `the proposed profile was not valid: ${errors.join('; ')}` };
        fs.mkdirSync(this.profilesDir, { recursive: true });
        const file = path.join(this.profilesDir, `${proposal.id}.yaml`);
        await writeFileAtomic(nodeFileIo, file, serializeProfile(proposal));
        this.profiles.push(proposal);
        return { status: 'profile_proposed', profilePath: file };
      }
      const model = applyProfile(parsed, profile);
      const reconcile = await reconcileContract(ledger, doc, model, sha);
      this.pack = upsertDocument(this.pack, { ...doc, sha, profileId: profile.id });
      await this.savePack();
      await this.cfm.persistCompiledGraph();
      return { status: 'applied', reconcile, warnings: model.warnings, profileId: profile.id };
    }
    if (!this.complete) return { status: 'needs_llm', reason: 'extracting facts from free text needs the LLM' };
    const sections = splitSections(content);
    const { system, user } = buildDocumentExtractionPrompt(doc, sections);
    const snap = this.cfm.getPackSources().graph;
    const outcome = parseDocumentExtraction(await this.complete(system, user, `Extract facts from ${doc.path}`), doc, sections, sha, createSubjectResolver(snap));
    const proposed = await recordExtraction(ledger, outcome);
    this.pack = upsertDocument(this.pack, { ...doc, sha });
    await this.savePack();
    await this.cfm.persistCompiledGraph();
    return { status: 'extracted', proposed, dropped: outcome.dropped };
  }

  /** Probes over the pack's sample documents, keyed by the table each is a sample of. */
  public sampleExecutor(): ProbeExecutor | undefined {
    const samples = new Map<string, Array<Record<string, string>>>();
    for (const d of this.pack.documents) {
      if (d.role !== 'sample' || !d.table) continue;
      try { samples.set(d.table, parseSampleCsv(this.read(d))); } catch (err) { this.log(`Sample ${d.path} unreadable: ${err instanceof Error ? err.message : String(err)}`); }
    }
    return samples.size ? createSampleProbeExecutor(samples) : undefined;
  }

  /** Live probes where a connection reaches the table, else samples. */
  public probeExecutor(live?: ProbeExecutor): ProbeExecutor | undefined {
    return combineProbeExecutors([live, this.sampleExecutor()]);
  }

  /** Every contract document with a confirmed profile, checked against the catalog and probes. */
  public async conformance(executor?: ProbeExecutor): Promise<{ reports: ConformanceReport[]; markdown: string }> {
    const reports: ConformanceReport[] = [];
    for (const doc of this.pack.documents.filter((d) => d.role === 'contract' && STRUCTURED.test(d.path))) {
      const parsed = parseStructured(this.read(doc));
      const profile = this.profileFor(doc, parsed);
      if (!profile) { this.log(`Conformance: ${doc.path} has no confirmed profile — apply it first.`); continue; }
      reports.push(await checkConformance(doc, applyProfile(parsed, profile), this.cfm.getCatalog(), executor));
    }
    return { reports, markdown: reports.map(renderConformanceReport).join('\n---\n\n') };
  }

  /** Resolves graph table/column ids to probe targets. */
  public probeResolver(): ProbeResolver {
    const g = this.cfm.getPackSources().graph;
    const byId = new Map(g.nodes.map((n) => [n.id, n] as const));
    const tableOf = new Map<string, string>();
    for (const e of g.edges) if (e.type === 'contains') tableOf.set(e.target, e.source);
    const resolveRef = createSubjectResolver(g);
    return (ref) => {
      const id = byId.has(ref) ? ref : resolveRef(ref);
      const n = id ? byId.get(id) : undefined;
      if (!n) return undefined;
      if (n.type === 'table' || n.type === 'semantic_view') return { table: { fqn: (n as TableNode).fqn || n.label, id: n.id } };
      const t = n.type === 'column' ? byId.get(tableOf.get(n.id) ?? '') : undefined;
      return t ? { table: { fqn: (t as TableNode).fqn || t.label, id: t.id }, column: n.label } : undefined;
    };
  }

  /**
   * Probes the claims probes can test — keys, grains, relationships and data
   * expectations about physical tables that are not yet verified — and
   * records pass/fail in the ledger.
   */
  public async verifyClaims(executor: ProbeExecutor | undefined): Promise<VerifyOutcome[]> {
    if (!executor) return [];
    const candidates = this.cfm.getLedger().assertions().filter((a) => !isMirror(a) && (isLive(a.status) || a.status === 'proposed') && a.trust !== 'verified'
      && ['key', 'grain', 'relationship', 'quality_expectation'].includes(a.kind) && !a.subject[0]?.startsWith('contract:'));
    const out = await verifyAssertions(this.cfm.getLedger(), candidates, executor, this.probeResolver());
    if (out.some((o) => o.result && o.result.pass !== undefined)) await this.cfm.persistCompiledGraph();
    return out;
  }

  /** Vocabulary proposals: mined from catalog names and comments, plus the LLM's reading of the pack's documents when available. */
  public async proposeVocabulary(): Promise<VocabularyProposal[]> {
    const file = path.join(this.workspaceRoot, '.ai-context', 'context', 'vocabulary.yaml');
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

  /** Writes accepted proposals to `.ai-context/context/vocabulary.yaml` and re-indexes. */
  public async acceptVocabulary(accepted: readonly VocabularyProposal[]): Promise<void> {
    if (!accepted.length) return;
    const dir = path.join(this.workspaceRoot, '.ai-context', 'context');
    const file = path.join(dir, 'vocabulary.yaml');
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
