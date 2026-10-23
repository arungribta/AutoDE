import * as fs from 'node:fs';
import * as path from 'node:path';
import { SourceContext, SourceContextEntry } from '../types';
import { parseYaml, stringifyYaml } from '../context/Yaml';
import { parseBusinessProblemSpec, readProblemDocument } from '../documents/problemDocuments';
import { sourceSystemChoices } from '../context/problemContexts';

/**
 * The source context, drafted by the agent doing a source-assessment stage
 * (PA3b, v0.45.2): which source systems the problem draws on and how AutoDE
 * knows them (connected, from files, described). Pinned to the current
 * specification, with `SourceContextManager.save()`'s revision rule; written
 * as `built`, so a person approves it as the stage's document. Since v0.45.10
 * a connected or file-based entry names its estate system (`system`): its
 * tables and bindings are in the estate, not repeated here; only a source
 * with no connection is described.
 */

export function sourceContextFile(problemRoot: string): string {
  return path.join(problemRoot, 'context', 'source-context.yaml');
}

function read(problemRoot: string): SourceContext | undefined {
  try {
    const raw = parseYaml(fs.readFileSync(sourceContextFile(problemRoot), 'utf8')) as SourceContext | null;
    return raw && typeof raw === 'object' ? raw : undefined;
  } catch { return undefined; }
}

const METHODS = ['connected', 'described', 'file'] as const;

/** Checks one entry; empty when it is fine. */
export function sourceEntryErrors(e: Partial<SourceContextEntry>, i: number): string[] {
  const errors: string[] = [];
  if (!e || typeof e !== 'object') return [`sources[${i}] must be an object.`];
  if (typeof e.connectionId !== 'string' || !e.connectionId.trim()) errors.push(`sources[${i}].connectionId is required (a connection id, or a name for the system when it is described or comes from files).`);
  if (!METHODS.includes(e.method as never)) errors.push(`sources[${i}].method is one of ${METHODS.join(', ')}.`);
  if (e.method === 'described' && !e.description?.trim()) errors.push(`sources[${i}] is described: give its description.`);
  return errors;
}

/** Resolves each connected or file-based entry to its estate system (by `system`, or the system its connection or file is bound to). */
export function resolveEstateSystems(workspaceRoot: string, entries: SourceContextEntry[]): { entries: SourceContextEntry[]; errors: string[] } {
  const systems = sourceSystemChoices(workspaceRoot);
  const errors: string[] = [];
  const out = entries.map((e, i) => {
    if (e.method === 'described') return e;
    const s = systems.find((x) => x.id === e.system) ?? (e.system ? undefined : systems.find((x) => x.bindings.includes(e.connectionId) || x.id === e.connectionId));
    if (!s) { errors.push(`sources[${i}] (${e.system ?? e.connectionId}) is not a source system in the estate${systems.length ? ` (its systems: ${systems.map((x) => x.id).join(', ')})` : ': bring it in first (`autode estate ingest` or `autode estate extract`)'}; describe it instead if there is no connection.`); return e; }
    return { ...e, system: s.id };
  });
  return { entries: out, errors };
}

export function writeSourceContextDraft(problemRoot: string, entries: SourceContextEntry[], answers: Record<string, string> = {}, now: Date = new Date(), workspaceRoot?: string): SourceContext {
  const specText = readProblemDocument(problemRoot, 'spec');
  if (!specText) throw new Error('The problem has no specification yet.');
  const spec = parseBusinessProblemSpec(specText);
  const errors = entries.length ? entries.flatMap((e, i) => sourceEntryErrors(e, i)) : ['sources must list at least one source system.'];
  if (errors.length) throw new Error(errors.join(' '));
  if (workspaceRoot) {
    const r = resolveEstateSystems(workspaceRoot, entries);
    if (r.errors.length) throw new Error(r.errors.join(' '));
    entries = r.entries;
  }
  const previous = read(problemRoot);
  const sameLineage = !!previous && previous.specId === spec.id && previous.specVersion === spec.version;
  const version = sameLineage ? (previous!.status === 'approved' ? (previous!.version ?? 1) + 1 : (previous!.version ?? 1)) : 1;
  const file = sourceContextFile(problemRoot);
  if (previous && previous.status === 'approved') {
    const target = path.join(path.dirname(file), 'history', `source-context.spec${previous.specVersion}.v${previous.version ?? 1}.yaml`);
    if (!fs.existsSync(target)) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(file, target); }
  }
  const at = now.toISOString();
  const ctx: SourceContext = {
    specId: spec.id, specVersion: spec.version, version, status: 'built',
    // Counts are the catalog's to keep (live), not stored here (v0.45.10).
    sources: entries.map(({ connectionSummary: _c, fileSummary: _f, ...e }) => ({ ...e, extractedAt: e.extractedAt ?? at })),
    answers: { ...(sameLineage ? previous!.answers ?? {} : {}), ...answers },
    builtAt: at
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# AutoDE Source Context\n' + stringifyYaml(ctx as unknown as Record<string, unknown>));
  return ctx;
}
