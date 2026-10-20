import * as fs from 'node:fs';
import * as path from 'node:path';
import { BusinessPack, PackDocument, emptyPack, parsePack } from './pack';
import { InterpretationProfile, applyProfile, parseProfile, parseStructured, profileMatches } from './profiles';
import { ConformanceCatalog, ConformanceReport, checkConformance, renderConformanceReport } from './conformance';
import { ProbeExecutor, createSampleProbeExecutor, parseSampleCsv } from './probes';
import { Assertion, isLive } from './assertions';
import { isMirror } from './projection';
import { layoutPath } from '../workspaceLayout';

/**
 * The deterministic checks over a business-problem pack (Phase C4a), shared
 * by the extension's BusinessPackManager and the `autode` CLI (Phase PA2):
 * reading the pack and its confirmed profiles, contract conformance, probes
 * over the customer's samples, and which claims probes can test.
 */

/** Pack documents and profiles may be structured (read through a profile) or free text. */
export const STRUCTURED_DOCUMENT = /\.(ya?ml|json)$/i;

export function readPackFile(packDir: string): BusinessPack {
  const file = path.join(packDir, 'pack.yaml');
  return fs.existsSync(file) ? parsePack(fs.readFileSync(file, 'utf8')) : emptyPack();
}

/** Interpretation profiles from `.autode/knowledge/profiles/`; invalid ones are reported and skipped. */
export function loadProfiles(workspaceRoot: string, log: (msg: string) => void = () => undefined): InterpretationProfile[] {
  const dir = layoutPath(workspaceRoot, 'profiles');
  const out: InterpretationProfile[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/i.test(x)).sort()) {
    const { profile, errors } = parseProfile(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (profile) out.push(profile); else log(`Profile ${f} is not valid and is ignored: ${errors.join('; ')}`);
  }
  return out;
}

/** The document's pinned profile if confirmed, else the first confirmed profile that fits it. */
export function profileFor(profiles: readonly InterpretationProfile[], doc: PackDocument, parsed: unknown): InterpretationProfile | undefined {
  const confirmed = profiles.filter((p) => p.status === 'confirmed');
  return (doc.profileId ? confirmed.find((p) => p.id === doc.profileId) : undefined) ?? confirmed.find((p) => profileMatches(parsed, p));
}

export function readPackDocument(workspaceRoot: string, doc: Pick<PackDocument, 'path'>): string {
  return fs.readFileSync(path.isAbsolute(doc.path) ? doc.path : path.join(workspaceRoot, doc.path), 'utf8');
}

/** Probes over the pack's sample documents, keyed by the table each is a sample of. */
export function sampleProbeExecutor(pack: BusinessPack, read: (doc: PackDocument) => string, log: (msg: string) => void = () => undefined): ProbeExecutor | undefined {
  const samples = new Map<string, Array<Record<string, string>>>();
  for (const d of pack.documents) {
    if (d.role !== 'sample' || !d.table) continue;
    try { samples.set(d.table, parseSampleCsv(read(d))); } catch (err) { log(`Sample ${d.path} unreadable: ${err instanceof Error ? err.message : String(err)}`); }
  }
  return samples.size ? createSampleProbeExecutor(samples) : undefined;
}

/** Every contract document with a confirmed profile, checked against the catalog and probes. */
export async function packConformance(
  pack: BusinessPack, profiles: readonly InterpretationProfile[], read: (doc: PackDocument) => string,
  catalog: ConformanceCatalog, executor?: ProbeExecutor, log: (msg: string) => void = () => undefined
): Promise<{ reports: ConformanceReport[]; markdown: string; skipped: string[] }> {
  const reports: ConformanceReport[] = [];
  const skipped: string[] = [];
  for (const doc of pack.documents.filter((d) => d.role === 'contract' && STRUCTURED_DOCUMENT.test(d.path))) {
    const parsed = parseStructured(read(doc));
    const profile = profileFor(profiles, doc, parsed);
    if (!profile) { skipped.push(doc.path); log(`Conformance: ${doc.path} has no confirmed profile — apply it first.`); continue; }
    reports.push(await checkConformance(doc, applyProfile(parsed, profile), catalog, executor));
  }
  return { reports, markdown: reports.map(renderConformanceReport).join('\n---\n\n'), skipped };
}

/** Failing clauses across reports. */
export function conformanceFailures(reports: readonly ConformanceReport[]): number {
  return reports.reduce((n, r) => n + r.tables.reduce((m, t) => m + t.results.filter((x) => x.status === 'fail').length, 0), 0);
}

/** The claims probes can test: keys, grains, relationships and data expectations about physical tables, not yet verified. */
export function probeCandidates(assertions: readonly Assertion[]): Assertion[] {
  return assertions.filter((a) => !isMirror(a) && (isLive(a.status) || a.status === 'proposed') && a.trust !== 'verified'
    && ['key', 'grain', 'relationship', 'quality_expectation'].includes(a.kind) && !a.subject[0]?.startsWith('contract:'));
}
