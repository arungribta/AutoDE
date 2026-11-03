import * as fs from 'node:fs';
import * as path from 'node:path';
import { layoutPath } from '../workspaceLayout';
import { Concept, OntologyPack, UPPER_PACK, checkPacks, conceptPrefix, packRevision, parsePack, stringifyPack } from './pack';

/**
 * Where packs live and which are in effect (ONT1; docs/specs/context-layer.md §6.8).
 *
 * - **Shipped** (`ontologies/` in AutoDE's resources): the upper layer, always in effect, and industry packs
 *   (FIBO lending first), which are sources to onboard from and never in effect by themselves.
 * - **The team's** (`.autode/knowledge/ontology/<id>.yaml`, versioned in git): onboarded subsets and extensions.
 *   A pack is in effect while a person's approval matches its content; edited afterwards it is `changed` and
 *   needs approving again (as a knowledge article does). Concepts are deprecated, never deleted.
 */

export type PackState = 'approved' | 'changed' | 'draft' | 'invalid';

export interface LoadedPack {
  pack?: OntologyPack;
  /** Workspace-relative for the team's packs, resources-relative for shipped ones. */
  file: string;
  origin: 'shipped' | 'team';
  state: PackState;
  revision?: string;
  errors: string[];
}

export interface Ontology {
  /** The upper layer and the team's approved packs. */
  packs: OntologyPack[];
  concepts: Map<string, Concept & { pack: string }>;
  children: Map<string, string[]>;
  /** Every pack found, in effect or not, with its state. */
  loaded: LoadedPack[];
  errors: string[];
}

export interface OntologyScope { workspaceRoot: string; resourcesRoot?: string }

let defaultResources: string | undefined;
/** Where the shipped `ontologies/` folder is, for callers that don't pass it (set at start-up). */
export function setOntologyResourcesRoot(root: string | undefined): void { defaultResources = root; }

export function shippedDir(resourcesRoot?: string): string | undefined {
  const candidates = [resourcesRoot, defaultResources, path.resolve(__dirname, '..', '..', '..'), path.resolve(__dirname, '..')].filter((x): x is string => !!x);
  return candidates.map((r) => path.join(r, 'ontologies')).find((d) => fs.existsSync(path.join(d, 'upper.yaml')));
}

export const teamDir = (workspaceRoot: string) => layoutPath(workspaceRoot, 'ontology');
export const teamFile = (workspaceRoot: string, id: string) => path.join(teamDir(workspaceRoot), `${id}.yaml`);

function readPack(file: string, rel: string, origin: LoadedPack['origin']): LoadedPack {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { return { file: rel, origin, state: 'invalid', errors: [String(err)] }; }
  const parsed = parsePack(text);
  if (!parsed.pack) return { file: rel, origin, state: 'invalid', errors: parsed.errors };
  const revision = packRevision(parsed.pack);
  const state: PackState = origin === 'shipped' ? 'approved' : !parsed.pack.approved ? 'draft' : parsed.pack.approved.revision === revision ? 'approved' : 'changed';
  return { pack: parsed.pack, file: rel, origin, state, revision, errors: [] };
}

/** The shipped packs: the upper layer and the industry packs to onboard from. */
export function shippedPacks(resourcesRoot?: string): LoadedPack[] {
  const dir = shippedDir(resourcesRoot);
  if (!dir) return [];
  return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => readPack(path.join(dir, f), `ontologies/${f}`, 'shipped'));
}

export function teamPacks(workspaceRoot: string): LoadedPack[] {
  const dir = teamDir(workspaceRoot);
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort(); } catch { return []; }
  return files.map((f) => readPack(path.join(dir, f), path.relative(workspaceRoot, path.join(dir, f)).split(path.sep).join('/'), 'team'));
}

const cache = new Map<string, { key: string; ontology: Ontology }>();

/** The ontology in effect: the upper layer and the team's approved packs, checked together. */
export function loadOntology(scope: OntologyScope): Ontology {
  const shipped = shippedPacks(scope.resourcesRoot);
  const team = teamPacks(scope.workspaceRoot);
  const key = [...shipped, ...team].map((l) => `${l.file}@${l.revision ?? l.state}`).join('|');
  const hit = cache.get(scope.workspaceRoot);
  if (hit && hit.key === key) return hit.ontology;
  const errors: string[] = [];
  const upper = shipped.find((l) => l.pack?.id === UPPER_PACK)?.pack;
  if (!upper) errors.push('The upper layer (ontologies/upper.yaml) is missing from AutoDE\'s resources.');
  const effective = [...(upper ? [upper] : []), ...team.filter((l) => l.state === 'approved' && l.pack && l.pack.id !== UPPER_PACK).map((l) => l.pack!)];
  for (const l of team) {
    if (l.state === 'invalid') errors.push(`${l.file}: ${l.errors.join('; ')}`);
    if (l.pack?.id === UPPER_PACK) errors.push(`${l.file}: the upper layer is AutoDE's own; extend it with a pack of your own instead.`);
  }
  const checks = checkPacks(effective);
  // A pack whose concepts don't connect is left out (with its errors) rather than half used.
  const ok = effective.filter((p) => !checks.has(p.id) || p.id === UPPER_PACK);
  for (const [id, errs] of checks) errors.push(`${id}: ${errs.join('; ')}`);
  const loaded = [...shipped, ...team].map((l) => (l.pack && checks.has(l.pack.id) && l.origin === 'team' ? { ...l, errors: [...l.errors, ...checks.get(l.pack.id)!] } : l));
  const concepts = new Map<string, Concept & { pack: string }>();
  const children = new Map<string, string[]>();
  for (const p of ok) for (const c of p.concepts) if (!concepts.has(c.id)) concepts.set(c.id, { ...c, pack: p.id });
  for (const c of concepts.values()) if (c.parent) children.set(c.parent, [...(children.get(c.parent) ?? []), c.id].sort());
  const ontology: Ontology = { packs: ok, concepts, children, loaded, errors };
  cache.set(scope.workspaceRoot, { key, ontology });
  return ontology;
}

/** A concept by id, label or synonym (case-insensitive), when exactly one matches. */
export function findConcept(o: Ontology, ref: string): (Concept & { pack: string }) | undefined {
  const r = ref.trim().replace(/^concept:/, '');
  const direct = o.concepts.get(r);
  if (direct) return direct;
  const lower = r.toLowerCase();
  const hits = [...o.concepts.values()].filter((c) => c.id.toLowerCase() === lower || c.label.toLowerCase() === lower || (c.synonyms ?? []).some((s) => s.toLowerCase() === lower));
  const nonUpper = hits.filter((c) => conceptPrefix(c.id) !== UPPER_PACK);
  return hits.length === 1 ? hits[0] : nonUpper.length === 1 ? nonUpper[0] : undefined;
}

/** Writes a team pack (the caller decides whether it is approved). */
export function writeTeamPack(workspaceRoot: string, pack: OntologyPack): string {
  const file = teamFile(workspaceRoot, pack.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringifyPack(pack));
  cache.delete(workspaceRoot);
  return file;
}

export function readTeamPack(workspaceRoot: string, id: string): LoadedPack | undefined {
  const file = teamFile(workspaceRoot, id);
  return fs.existsSync(file) ? readPack(file, path.relative(workspaceRoot, file).split(path.sep).join('/'), 'team') : undefined;
}
