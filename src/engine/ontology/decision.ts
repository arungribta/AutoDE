import { OntologyPack, UPPER_PACK, checkPacks, packRevision, parsePack } from './pack';
import { OntologyScope, loadOntology, readTeamPack, writeTeamPack } from './store';

/**
 * A pack change is a workspace-level decision (kind `ontology`; docs/specs/context-layer.md §6.8): importing,
 * growing or deprecating concepts is shared by every business problem, the same as a shared semantic model
 * change. The proposal carries the whole pack; approving it writes the pack with the person's approval of that
 * exact revision. Concepts are deprecated, never deleted.
 */

export interface OntologyPayload {
  /** The pack's id; its file is `.autode/knowledge/ontology/<id>.yaml`. */
  id: string;
  /** The pack, as `stringifyPack` writes it. */
  content: string;
  reason?: string;
  /** Concepts this proposal adds (for the reviewer). */
  added?: string[];
}

export interface OntologyValidation { errors: string[]; warnings: string[]; pack?: OntologyPack }

/** The team pack's current revision (`none` when there is none): what a proposal is made against. */
export function ontologyRevision(workspaceRoot: string, id: string): string {
  const l = readTeamPack(workspaceRoot, id);
  return l?.revision ?? (l ? 'invalid' : 'none');
}

export function validateOntologyPayload(p: OntologyPayload, scope: OntologyScope): OntologyValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!p || typeof p.content !== 'string' || typeof p.id !== 'string') return { errors: ['give id and content (the whole pack)'], warnings };
  const parsed = parsePack(p.content);
  if (!parsed.pack) return { errors: parsed.errors, warnings };
  const pack = parsed.pack;
  if (pack.id !== p.id) errors.push(`The pack's id is ${pack.id}, not ${p.id}.`);
  if (pack.id === UPPER_PACK) errors.push('The upper layer is AutoDE\'s own: extend it with a pack of your own.');
  const ontology = loadOntology(scope);
  const others = ontology.packs.filter((x) => x.id !== pack.id);
  const checks = checkPacks([...others, pack]);
  errors.push(...(checks.get(pack.id) ?? []));
  // A concept another pack also defines would be two meanings for one id.
  for (const c of pack.concepts) { const o = others.find((x) => x.concepts.some((k) => k.id === c.id)); if (o) errors.push(`${c.id} is already defined by the pack ${o.id}.`); }
  const current = readTeamPack(scope.workspaceRoot, pack.id)?.pack;
  if (current) {
    const ids = new Set(pack.concepts.map((c) => c.id));
    const dropped = current.concepts.filter((c) => !ids.has(c.id)).map((c) => c.id);
    if (dropped.length) errors.push(`Concepts are deprecated, never deleted: keep ${dropped.join(', ')} (status: deprecated).`);
    const deprecated = pack.concepts.filter((c) => c.status === 'deprecated' && current.concepts.find((k) => k.id === c.id)?.status !== 'deprecated').map((c) => c.id);
    if (deprecated.length) warnings.push(`It deprecates ${deprecated.join(', ')}: terms and tables that mean them keep their links, flagged.`);
  }
  if (pack.distribution === 'workspace') warnings.push(`The standard's licence (${pack.standard?.licence.name ?? 'not stated'}) doesn't allow redistribution: the pack stays in this workspace and can't be exported.`);
  return { errors, warnings, pack };
}

/** Writes the approved pack: the person who approved the decision approved this revision. */
export function applyOntologyPayload(p: OntologyPayload, scope: OntologyScope, approval: { by: string; at: string; decision?: string }): { file: string; revision: string; errors: string[] } {
  const v = validateOntologyPayload(p, scope);
  if (v.errors.length || !v.pack) return { file: '', revision: '', errors: v.errors };
  const revision = packRevision(v.pack);
  const file = writeTeamPack(scope.workspaceRoot, { ...v.pack, approved: { by: approval.by, at: approval.at, revision, ...(approval.decision ? { decision: approval.decision } : {}) } });
  return { file, revision, errors: [] };
}

/** A person approves a team pack as it is on disk (a hand edit, or a pack written outside a decision). */
export function approveTeamPack(scope: OntologyScope, id: string, by: string, at = new Date().toISOString()): { ok: boolean; message: string } {
  const l = readTeamPack(scope.workspaceRoot, id);
  if (!l?.pack) return { ok: false, message: l ? `${l.file}: ${l.errors.join('; ')}` : `No team pack "${id}" (.autode/knowledge/ontology/${id}.yaml).` };
  const rest: Partial<OntologyPack> = { ...l.pack };
  delete rest.approved;
  const v = validateOntologyPayload({ id, content: JSON.stringify(rest) }, scope);
  if (v.errors.length) return { ok: false, message: v.errors.join(' ') };
  const revision = packRevision(l.pack);
  writeTeamPack(scope.workspaceRoot, { ...l.pack, approved: { by, at, revision } });
  return { ok: true, message: `${id} approved by ${by} (revision ${revision}): its concepts are in effect.` };
}
