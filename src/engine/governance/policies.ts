import * as fs from 'node:fs';
import { parseYaml } from '../context/Yaml';
import { layoutPath } from '../workspaceLayout';
import type { PipelineSpec } from '../pipelineSpec/types';
import { CLASSIFICATIONS, Classification, ColumnGovernance, governanceFor } from './governance';

/**
 * Policies as data (ONT2; docs/specs/context-layer.md §6.11, §11): `.autode/config/policies.yaml` maps a regulation
 * (or the team's own rule) to the classifications it covers and the controls it requires — masking, retention,
 * access — in ODRL's spirit (a permission or duty on an asset, under a constraint), kept small. Every classified
 * column lists the policies that apply to it, and the governance check of a Pipeline Spec runs on them: a policy's
 * masking duty makes an unmasked column an error, not a warning; retention and access are stated duties the Pipeline
 * Spec can't show yet, so they are warnings naming what is owed.
 *
 *   autode: policies/1
 *   policies:
 *     - id: gdpr-personal-data
 *       title: Personal data under GDPR
 *       regulation: GDPR
 *       applies: { classifications: [pii, sensitive-pii] }
 *       controls:
 *         - { control: masking, strategy: hash }
 *         - { control: retention, days: 2555 }
 *         - { control: access, roles: [data_steward] }
 */

export type ControlKind = 'masking' | 'retention' | 'access';
export interface PolicyControl { control: ControlKind; strategy?: 'hash' | 'redact'; days?: number; roles?: string[]; note?: string }
export interface Policy { id: string; title: string; regulation?: string; description?: string; applies: { classifications: Classification[] }; controls: PolicyControl[] }
export interface PolicyFile { policies: Policy[]; errors: string[]; file: string }

export function parsePolicies(text: string | undefined): { policies: Policy[]; errors: string[] } {
  if (!text?.trim()) return { policies: [], errors: [] };
  let raw: unknown;
  try { raw = parseYaml(text); } catch (err) { return { policies: [], errors: [`not YAML: ${err instanceof Error ? err.message : String(err)}`] }; }
  const r = (raw ?? {}) as { autode?: unknown; policies?: unknown };
  const errors: string[] = [];
  if (r.autode !== 'policies/1') errors.push('autode must be policies/1');
  const policies: Policy[] = [];
  const ids = new Set<string>();
  for (const [i, p] of (Array.isArray(r.policies) ? r.policies : []).entries()) {
    const at = `policies[${i}]`;
    const x = (p ?? {}) as Partial<Policy>;
    if (typeof x.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(x.id)) { errors.push(`${at}.id is a slug`); continue; }
    if (ids.has(x.id)) errors.push(`${x.id} appears twice`);
    ids.add(x.id);
    const cls = Array.isArray(x.applies?.classifications) ? x.applies!.classifications : [];
    const bad = cls.filter((c) => !CLASSIFICATIONS.includes(c));
    if (!cls.length || bad.length) errors.push(`${x.id}: applies.classifications is a list of ${CLASSIFICATIONS.join(', ')}${bad.length ? ` (not ${bad.join(', ')})` : ''}`);
    const controls = Array.isArray(x.controls) ? x.controls : [];
    for (const c of controls) {
      if (!['masking', 'retention', 'access'].includes(String(c?.control))) errors.push(`${x.id}: a control is masking, retention or access`);
      if (c?.control === 'retention' && !(typeof c.days === 'number' && c.days > 0)) errors.push(`${x.id}: retention needs days`);
      if (c?.control === 'access' && !(Array.isArray(c.roles) && c.roles.length)) errors.push(`${x.id}: access needs roles`);
      if (c?.control === 'masking' && c.strategy && !['hash', 'redact'].includes(c.strategy)) errors.push(`${x.id}: masking strategy is hash or redact`);
    }
    if (!controls.length) errors.push(`${x.id}: give at least one control`);
    policies.push({ id: x.id, title: typeof x.title === 'string' ? x.title : x.id, ...(x.regulation ? { regulation: x.regulation } : {}), ...(x.description ? { description: x.description } : {}), applies: { classifications: cls.filter((c) => CLASSIFICATIONS.includes(c)) }, controls });
  }
  return { policies, errors };
}

export function loadPolicies(workspaceRoot: string): PolicyFile {
  const file = layoutPath(workspaceRoot, 'policies');
  let text: string | undefined;
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = undefined; }
  return { ...parsePolicies(text), file };
}

/** The policies a classification falls under. */
export function policiesFor(classification: string | undefined, policies: readonly Policy[]): Policy[] {
  return classification ? policies.filter((p) => p.applies.classifications.includes(classification as Classification)) : [];
}

export interface ColumnPolicies { table: string; column: string; classification: Classification; fact?: string; status?: string; policies: Array<{ id: string; title: string; regulation?: string; controls: PolicyControl[] }> }

/** Every classified column with the policies that apply to it (an empty list says no policy covers it). */
export function columnPolicies(facts: readonly ColumnGovernance[], policies: readonly Policy[]): ColumnPolicies[] {
  return facts.filter((f) => f.classification !== 'none').map((f) => ({
    table: f.table, column: f.column, classification: f.classification, ...(f.assertionId ? { fact: f.assertionId } : {}), ...(f.status ? { status: f.status } : {}),
    policies: policiesFor(f.classification, policies).map((p) => ({ id: p.id, title: p.title, ...(p.regulation ? { regulation: p.regulation } : {}), controls: p.controls }))
  }));
}

/**
 * The governance check on policies: for each entity, the confirmed classified columns it reads that a policy covers.
 * A masking duty unmet is an error; retention and access duties are warnings (what is owed, for the people who run it).
 */
export function policyGaps(spec: Pick<PipelineSpec, 'entities'>, facts: readonly ColumnGovernance[], policies: readonly Policy[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!policies.length) return { errors, warnings };
  for (const e of spec.entities ?? []) {
    const masked = new Set<string>();
    for (const t of e.transforms ?? []) if (t.kind === 'mask') for (const c of ((t.params as { columns?: Array<{ name?: string }> }).columns ?? [])) if (c?.name) masked.add(c.name.toLowerCase());
    const staging = (e.transforms ?? []).find((t) => t.kind === 'rename_cast');
    const renamed = staging ? new Map(((staging.params as { columns?: Array<{ source?: string; target?: string }> }).columns ?? []).filter((c) => c?.source && c?.target).map((c) => [c.source!.toLowerCase(), c.target!.toLowerCase()])) : undefined;
    const owed = new Map<string, Set<string>>();
    for (const f of governanceFor(e.source?.object ?? '', facts)) {
      if (f.status !== 'active') continue;
      const name = renamed ? renamed.get(f.column) : f.column;
      if (!name) continue;
      for (const p of policiesFor(f.classification, policies)) {
        for (const c of p.controls) {
          if (c.control === 'masking' && !masked.has(name)) errors.push(`${e.name}: policy ${p.id}${p.regulation ? ` (${p.regulation})` : ''} requires ${f.table}.${f.column} (${f.classification}, fact ${f.assertionId}) to be masked${c.strategy ? ` by ${c.strategy}` : ''}; mask ${name}.`);
          else if (c.control === 'retention') { const k = `retention of ${c.days} days`; owed.set(k, (owed.get(k) ?? new Set()).add(p.id)); }
          else if (c.control === 'access') { const k = `access only for ${(c.roles ?? []).join(', ')}`; owed.set(k, (owed.get(k) ?? new Set()).add(p.id)); }
        }
      }
    }
    for (const [duty, ids] of owed) warnings.push(`${e.name}: ${duty} (policy ${[...ids].join(', ')}) applies to its classified columns; the Pipeline Spec doesn't state it: arrange it on the platform (a runbook) and note it.`);
  }
  return { errors: [...new Set(errors)], warnings };
}
