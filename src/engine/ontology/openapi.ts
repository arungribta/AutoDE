import { createHash } from 'node:crypto';
import { parseYaml } from '../context/Yaml';
import { SourceAnalysis, SourceConcept, classifyLicence, suggestPlacement } from './convert';
import { ConceptRelation, localName } from './pack';
import type { ReaderSettings } from './standards';

/**
 * Reading a standard published as API schemas (ONT1; docs/specs/context-layer.md §6.8): OpenAPI 3 documents
 * (`components.schemas`) and JSON Schema (`$defs`, `definitions`). BIAN publishes its business objects this way, in
 * its Semantic APIs; ISO 20022 and many industry APIs too.
 *
 * - An object schema is a **concept**; a schema that is an enumeration, a scalar or a wrapper of one value is a
 *   datatype. A standard's settings sharpen this (BIAN marks business objects `format: class` and datatypes
 *   `format: datatype`; its enumerations end in `values`).
 * - A property that refers to a concept is a **relation** (`array` of them: `0..*`; a required one: `1`), any other
 *   an **attribute**. `allOf` with one reference is the schema's parent; there is no other parent in API schemas, so
 *   most concepts are placed under the upper layer by the person.
 * - The same schema in several documents (BIAN repeats them in each service domain) is one concept, its properties
 *   merged. Deterministic.
 */

interface Schema { type?: string | string[]; properties?: Record<string, Schema>; items?: Schema; $ref?: string; enum?: unknown[]; allOf?: Schema[]; description?: string; title?: string; format?: string; required?: string[] }

const refName = (ref: string | undefined) => (ref ? decodeURIComponent(ref.split('/').pop() ?? '') : undefined);
const spaced = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
const clean = (s: string | undefined) => s?.replace(/\|\|?\r?\n\|?/g, ' ').replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || undefined;

/** Whether a text is an OpenAPI document or a JSON Schema with definitions. */
export function isApiSchema(name: string, text: string): boolean {
  if (!/\.(ya?ml|json)$/i.test(name)) return false;
  return /^\s*["']?openapi["']?\s*:/m.test(text) || /"\$defs"|"definitions"\s*:|^\$defs:|^definitions:/m.test(text) || /"openapi"\s*:/.test(text);
}

export function analyzeApiSchemas(files: ReadonlyArray<{ name: string; text: string }>, opts: { title?: string; prefix?: string; licenceText?: string; settings?: ReaderSettings }): SourceAnalysis {
  const warnings: string[] = [];
  const schemas = new Map<string, Schema & { _from: string }>();
  let title = opts.title; let version: string | undefined; let licence: string | undefined;
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    let doc: Record<string, unknown>;
    try { doc = (f.name.endsWith('.json') ? JSON.parse(f.text) : parseYaml(f.text)) as Record<string, unknown>; } catch (err) { warnings.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}; skipped.`); continue; }
    if (!doc || typeof doc !== 'object') continue;
    const info = (doc.info ?? {}) as { title?: string; version?: string; license?: { name?: string; identifier?: string; url?: string } };
    version = version ?? info.version;
    licence = licence ?? (info.license ? [info.license.identifier, info.license.name, info.license.url].filter(Boolean).join(' ') : undefined);
    if (files.length === 1) title = title ?? info.title;
    const defs = ((doc.components as { schemas?: Record<string, Schema> } | undefined)?.schemas ?? (doc.$defs as Record<string, Schema> | undefined) ?? (doc.definitions as Record<string, Schema> | undefined) ?? {});
    for (const [name, s] of Object.entries(defs)) {
      if (!s || typeof s !== 'object') continue;
      const prev = schemas.get(name);
      if (!prev) schemas.set(name, { ...s, properties: { ...(s.properties ?? {}) }, _from: f.name });
      else { prev.properties = { ...(s.properties ?? {}), ...(prev.properties ?? {}) }; prev.description = prev.description ?? s.description; }
    }
  }
  const st = opts.settings ?? {};
  const enumRe = st.enumName ? new RegExp(st.enumName) : undefined;
  const props = (s: Schema) => Object.entries(s.properties ?? {});
  const kind = new Map<string, 'concept' | 'datatype'>();
  for (const [name, s] of schemas) {
    const formats = props(s).map(([, p]) => p.format).filter(Boolean);
    let k: 'concept' | 'datatype';
    if (s.enum || (enumRe && enumRe.test(name))) k = 'datatype';
    else if (st.datatypeFormat && formats.includes(st.datatypeFormat)) k = 'datatype';
    else if (st.conceptFormat && formats.includes(st.conceptFormat)) k = 'concept';
    else if ((s.type && s.type !== 'object') || (!s.properties && !s.allOf)) k = 'datatype';
    else k = props(s).length >= 2 || props(s).some(([, p]) => p.$ref || p.items?.$ref) || !!s.allOf ? 'concept' : 'datatype';
    kind.set(name, k);
  }
  // A lower-case schema name (BIAN's `loanproduct`) takes its words from a property spelt the same (`LoanProduct`).
  const spelling = new Map<string, string>();
  for (const [, s] of schemas) for (const [p] of props(s)) if (/[A-Z]/.test(p)) { const k = p.toLowerCase(); if (!spelling.has(k)) spelling.set(k, p); }
  for (const [name] of schemas) if (/[A-Z]/.test(name)) spelling.set(name.toLowerCase(), name);
  const labelOf = (name: string) => { const s = schemas.get(name); if (s?.title) return s.title; return spaced(spelling.get(name.toLowerCase()) ?? name).replace(/^./, (c) => c.toUpperCase()); };
  const prefix = opts.prefix ?? st.prefix ?? 'api';
  const used = new Set<string>();
  const idOf = new Map<string, string>();
  const conceptNames = [...schemas.keys()].filter((n) => kind.get(n) === 'concept').sort((a, b) => a.localeCompare(b));
  for (const n of conceptNames) {
    let local = localName(labelOf(n));
    for (let i = 2; used.has(local); i++) local = `${localName(labelOf(n))}${i}`;
    used.add(local);
    idOf.set(n, `${prefix}:${local}`);
  }
  const concepts: SourceConcept[] = conceptNames.map((n) => {
    const s = schemas.get(n)!;
    const relations: ConceptRelation[] = [];
    const attributes = new Set<string>();
    let parent: string | undefined;
    for (const part of s.allOf ?? []) { const r = refName(part.$ref); if (r && idOf.has(r) && r !== n && !parent) parent = idOf.get(r); else for (const [p, v] of Object.entries(part.properties ?? {})) s.properties![p] = s.properties![p] ?? v; }
    for (const [p, v] of props(s)) {
      const target = refName(v.$ref ?? v.items?.$ref ?? v.allOf?.find((x) => x.$ref)?.$ref);
      if (target && idOf.has(target) && target !== n) {
        const many = v.type === 'array' || !!v.items;
        const verb = p.replace(/^./, (c) => c.toLowerCase()).replace(/[^A-Za-z0-9]/g, '');
        if (!relations.some((r) => r.verb === verb)) relations.push({ verb, target: idOf.get(target)!, ...(many ? { cardinality: '0..*' } : (s.required ?? []).includes(p) ? { cardinality: '1' } : {}) });
      } else attributes.add(spaced(p).toLowerCase());
    }
    const label = labelOf(n);
    const definition = clean(s.description);
    const c: SourceConcept = {
      id: idOf.get(n)!, label, ...(definition ? { definition } : {}), ...(parent ? { parent } : {}),
      ...(relations.length ? { relations: relations.sort((a, b) => a.verb.localeCompare(b.verb)) } : {}),
      ...(attributes.size ? { attributes: { notable: [...attributes].sort() } } : {}),
      module: s._from.replace(/\.(ya?ml|json)$/i, '')
    };
    if (!parent) { const p = suggestPlacement([label, definition ?? '']); if (p) c.suggestedPlacement = p; }
    return c;
  });
  const modules = new Map<string, number>();
  for (const c of concepts) modules.set(c.module ?? '(none)', (modules.get(c.module ?? '(none)') ?? 0) + 1);
  const datatypes = [...kind.values()].filter((k) => k === 'datatype').length;
  if (datatypes) warnings.push(`${datatypes} schema(s) read as datatypes or enumerations, not concepts.`);
  if (!concepts.length) warnings.push('No object schemas found (components.schemas, $defs or definitions).');
  return {
    title: title ?? 'API schemas', ...(version ? { version } : {}), licence: classifyLicence(opts.licenceText ?? licence),
    concepts, relations: concepts.reduce((n, c) => n + (c.relations?.length ?? 0), 0),
    modules: [...modules.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([module, n]) => ({ module, concepts: n })),
    prefix, warnings,
    checksum: createHash('sha256').update(files.map((f) => `${f.name}\n${f.text.replace(/\r\n/g, '\n')}`).join('\n')).digest('hex').slice(0, 16)
  };
}
