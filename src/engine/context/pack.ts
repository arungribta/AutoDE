import { createHash } from 'node:crypto';
import { parseYaml, stringifyYaml } from './Yaml';
import { slugifyId } from './estate';
import { TrustTier } from './assertions';

/**
 * The business-problem pack (Phase C4a, item 1; docs/context-layer-requirements.md
 * §11 Phase C4a). A business problem is whatever the customer has — a
 * paragraph, a document, or a set of them — so the pack records which
 * documents describe this problem, what each one *is* and how far it can be
 * trusted. Documents are referenced by path, never copied (principle C9).
 *
 * Stored at `<problem>/pack/pack.yaml`.
 */

export type DocumentRole = 'contract' | 'brd' | 'kpi_definitions' | 'mapping' | 'data_dictionary' | 'sample' | 'other';
export const DOCUMENT_ROLES: readonly DocumentRole[] = ['contract', 'brd', 'kpi_definitions', 'mapping', 'data_dictionary', 'sample', 'other'];

/** `signed`: the customer stands behind it (facts enter at `confirmed`); `draft`: it says so, unconfirmed (`documented`). */
export type DocumentAuthority = 'signed' | 'draft';

export interface PackDocument {
  /** Stable slug, from the file name. */
  id: string;
  /** Workspace-relative path (posix). */
  path: string;
  role: DocumentRole;
  authority: DocumentAuthority;
  /** The customer's version label ("1", "2026-03"), as given. */
  version: string;
  /** sha256 of the content when it was last applied — clause refs pin it. */
  sha?: string;
  /** Interpretation profile applied to it (structured documents). */
  profileId?: string;
  /** `sample` documents: the table (graph id) the rows are a sample of. */
  table?: string;
  /** Contract entity → table ids, overriding name-based binding. */
  bindings?: Record<string, string[]>;
  addedAt: string;
}

export interface BusinessPack {
  documents: PackDocument[];
}

export function emptyPack(): BusinessPack {
  return { documents: [] };
}

export function parsePack(text: string | undefined): BusinessPack {
  if (!text || !text.trim()) return emptyPack();
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return emptyPack();
  }
  const docs = (raw && typeof raw === 'object' && Array.isArray((raw as BusinessPack).documents)) ? (raw as BusinessPack).documents : [];
  return {
    documents: docs
      .filter((d) => d && typeof d.path === 'string' && d.path)
      .map((d) => ({
        ...d,
        id: d.id || documentId(d.path),
        role: DOCUMENT_ROLES.includes(d.role) ? d.role : 'other',
        authority: d.authority === 'signed' ? 'signed' : 'draft',
        version: String(d.version ?? '1'),
        addedAt: d.addedAt || new Date(0).toISOString()
      }))
  };
}

export function serializePack(pack: BusinessPack): string {
  return '# AutoDE business-problem pack: the documents that describe this problem (Phase C4a)\n' + stringifyYaml({ documents: pack.documents } as unknown as Record<string, unknown>);
}

export function documentId(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return slugifyId(name.replace(/\.[^.]+$/, ''));
}

/** Adds or replaces (by path) a document; returns the new pack. */
export function upsertDocument(pack: BusinessPack, doc: Omit<PackDocument, 'id' | 'addedAt'> & Partial<Pick<PackDocument, 'id' | 'addedAt'>>): BusinessPack {
  const path = doc.path.replace(/\\/g, '/');
  const existing = pack.documents.find((d) => d.path === path);
  const next: PackDocument = { ...existing, ...doc, path, id: doc.id ?? existing?.id ?? documentId(path), addedAt: existing?.addedAt ?? doc.addedAt ?? new Date().toISOString() };
  return { documents: [...pack.documents.filter((d) => d.path !== path), next].sort((a, b) => (a.path < b.path ? -1 : 1)) };
}

export function contentSha(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Clause-level provenance (item 4): `<file>#<path | section>@<sha12>`. */
export function clauseRef(path: string, clausePath: string, sha: string): string {
  return `${path}#${clausePath}@${sha.slice(0, 12)}`;
}

/** The trust a document's facts enter at. */
export function trustFor(authority: DocumentAuthority): TrustTier {
  return authority === 'signed' ? 'confirmed' : 'documented';
}
