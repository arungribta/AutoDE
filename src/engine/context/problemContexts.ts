import * as fs from 'node:fs';
import * as path from 'node:path';
import { Assertion, isLive } from './assertions';
import { parseEstate } from './estate';
import { parseYaml, stringifyYaml } from './Yaml';
import { layoutPath } from '../workspaceLayout';
import { loadConnectionsConfig } from '../platform/connectionsConfig';
import { parseBusinessProblemSpec, readProblemDocument } from '../documents/problemDocuments';
import { sourceSystems } from '../workflows/instance';
import { SourceContextEntry, TargetContext } from '../types';

/**
 * A problem's target and source contexts reference the workspace instead of
 * describing it again (v0.45.10, SIMP-4; roadmap decision log 2026-10-22).
 * The target context picks a named target connection and keeps the problem's
 * own decisions; the source context lists the estate systems in scope. One
 * implementation for the panel, `autode_record_target_context` /
 * `autode_record_source_context` and `autode context`.
 */

/** The problem's target decisions and their allowed values. */
export const TARGET_OPTIONS = {
  platform: ['snowflake', 'databricks', 'bigquery', 'redshift', 'synapse', 'other'],
  modelingApproach: ['dimensional', 'data-vault', 'obt', '3nf', 'raw-pass-through'],
  transformationTool: ['dbt', 'sqlmesh', 'custom-sql', 'stored-procedures', 'none'],
  orchestrationTool: ['airflow', 'dagster', 'prefect', 'dbt-cloud', 'manual', 'none'],
  namingConvention: ['snake_case', 'camelCase', 'PascalCase']
} as const;
export type TargetChoice = keyof typeof TARGET_OPTIONS;

export interface TargetConnectionChoice { id: string; platform: string; database?: string; schema?: string }

/** The workspace's named target connections (`.autode/config/connections.yaml`, role `target`). */
export function targetConnectionChoices(workspaceRoot: string): TargetConnectionChoice[] {
  try {
    return loadConnectionsConfig(workspaceRoot).connections.filter((c) => c.role === 'target').map((c) => ({
      id: c.id, platform: c.platform,
      database: c.fields.database ?? c.fields.catalog, schema: c.fields.schema
    }));
  } catch { return []; }
}

/** Team-wide decisions in the ledger that answer a target question (`decision` facts by predicate; `naming_convention` facts). */
const DECISION_PREDICATES: Readonly<Record<string, TargetChoice>> = {
  modeling_approach: 'modelingApproach', transformation_tool: 'transformationTool',
  orchestration_tool: 'orchestrationTool', target_platform: 'platform'
};

function factValue(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['value', 'choice', 'convention']) if (typeof o[k] === 'string') return o[k] as string;
  }
  return undefined;
}

export interface TargetDefaults {
  values: Partial<Record<TargetChoice, string>>;
  /** Where each default came from, for the question's rationale. */
  from: Partial<Record<TargetChoice, string>>;
}

/**
 * Defaults for a problem's target questions: the team's own facts first
 * (project-wide, live), then the most recently approved target context of
 * another problem. The specification's own words still win (the caller
 * applies them); nothing is assumed, every answer is confirmed.
 */
export function targetDefaults(input: { assertions: readonly Assertion[]; workspaceRoot: string; problemId?: string }): TargetDefaults {
  const out: TargetDefaults = { values: {}, from: {} };
  const set = (k: TargetChoice, v: string | undefined, from: string) => {
    if (!v || out.values[k] || !(TARGET_OPTIONS[k] as readonly string[]).includes(v)) return;
    out.values[k] = v; out.from[k] = from;
  };
  for (const a of input.assertions) {
    if (a.specId || !isLive(a.status)) continue;
    if (a.kind === 'naming_convention') set('namingConvention', factValue(a.value), 'the team\'s naming convention (a fact in the ledger)');
    if (a.kind === 'decision' && DECISION_PREDICATES[a.predicate]) set(DECISION_PREDICATES[a.predicate], factValue(a.value), `a team decision in the ledger: ${a.statement}`);
  }
  const previous = lastApprovedTarget(input.workspaceRoot, input.problemId);
  if (previous) for (const k of Object.keys(TARGET_OPTIONS) as TargetChoice[]) set(k, previous.context[k] as string | undefined, `the approved target context of problem ${previous.problemId}`);
  return out;
}

function lastApprovedTarget(workspaceRoot: string, exceptProblemId?: string): { problemId: string; context: TargetContext } | undefined {
  const root = layoutPath(workspaceRoot, 'problems');
  let best: { problemId: string; context: TargetContext } | undefined;
  let ids: string[] = [];
  try { ids = fs.readdirSync(root); } catch { return undefined; }
  for (const id of ids) {
    if (id === exceptProblemId) continue;
    const c = readTargetContext(path.join(root, id));
    if (c?.status === 'approved' && (!best || (c.approvedAt ?? '') > (best.context.approvedAt ?? ''))) best = { problemId: id, context: c };
  }
  return best;
}

export function targetContextFile(problemRoot: string): string {
  return path.join(problemRoot, 'context', 'target-context.yaml');
}

export function readTargetContext(problemRoot: string): TargetContext | undefined {
  try {
    const raw = parseYaml(fs.readFileSync(targetContextFile(problemRoot), 'utf8')) as TargetContext | null;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined;
  } catch { return undefined; }
}

export interface TargetChoices {
  connectionId?: string;
  platform?: string;
  modelingApproach?: string;
  transformationTool?: string;
  orchestrationTool?: string;
  namingConvention?: string;
  database?: string;
  schema?: string;
}

/** What is wrong with a set of target choices (empty: nothing). The connection, when named, decides the platform. */
export function targetChoiceErrors(workspaceRoot: string, c: TargetChoices): string[] {
  const errors: string[] = [];
  const connections = targetConnectionChoices(workspaceRoot);
  if (c.connectionId) {
    const conn = connections.find((x) => x.id === c.connectionId);
    if (!conn) errors.push(`No target connection "${c.connectionId}" in the workspace${connections.length ? ` (target connections: ${connections.map((x) => x.id).join(', ')})` : ': add one with `autode connections add` or a platform card in Settings'}.`);
    else if (c.platform && c.platform !== conn.platform) errors.push(`The connection ${conn.id} is ${conn.platform}, not ${c.platform}: the connection decides the platform.`);
  } else if (!c.platform) errors.push('Name the target connection (connectionId), or the platform when there is no connection yet.');
  for (const k of Object.keys(TARGET_OPTIONS) as TargetChoice[]) {
    const v = c[k];
    if (k === 'platform' && c.connectionId) continue;
    if (!v) { if (k !== 'platform') errors.push(`${k} is required (${TARGET_OPTIONS[k].join(', ')}).`); continue; }
    if (!(TARGET_OPTIONS[k] as readonly string[]).includes(v)) errors.push(`${k} is one of ${TARGET_OPTIONS[k].join(', ')}.`);
  }
  return errors;
}

/**
 * Writes the problem's target context as `built` (a person approves it as the
 * target stage's document), pinned to the current specification, with the
 * same revision rule as the panel's manager: revising an approved revision
 * bumps `version` and archives it to `context/history/`.
 */
export function writeTargetContextDraft(workspaceRoot: string, problemRoot: string, c: TargetChoices, answers: Record<string, string> = {}, now: Date = new Date()): TargetContext {
  const specText = readProblemDocument(problemRoot, 'spec');
  if (!specText) throw new Error('The problem has no specification yet.');
  const spec = parseBusinessProblemSpec(specText);
  const errors = targetChoiceErrors(workspaceRoot, c);
  if (errors.length) throw new Error(errors.join(' '));
  const conn = c.connectionId ? targetConnectionChoices(workspaceRoot).find((x) => x.id === c.connectionId) : undefined;
  const previous = readTargetContext(problemRoot);
  const sameLineage = !!previous && previous.specId === spec.id && previous.specVersion === spec.version;
  const version = sameLineage ? (previous!.status === 'approved' ? (previous!.version ?? 1) + 1 : (previous!.version ?? 1)) : 1;
  const file = targetContextFile(problemRoot);
  if (previous && previous.status === 'approved') {
    const archived = path.join(path.dirname(file), 'history', `target-context.spec${previous.specVersion}.v${previous.version ?? 1}.yaml`);
    if (!fs.existsSync(archived)) { fs.mkdirSync(path.dirname(archived), { recursive: true }); fs.copyFileSync(file, archived); }
  }
  const database = c.database || conn?.database;
  const schema = c.schema || conn?.schema;
  const ctx: TargetContext = {
    specId: spec.id, specVersion: spec.version, version, status: 'built',
    ...(conn ? { connectionId: conn.id } : {}),
    platform: (conn?.platform ?? c.platform) as TargetContext['platform'],
    modelingApproach: c.modelingApproach as TargetContext['modelingApproach'],
    transformationTool: c.transformationTool as TargetContext['transformationTool'],
    orchestrationTool: c.orchestrationTool as TargetContext['orchestrationTool'],
    namingConvention: c.namingConvention as TargetContext['namingConvention'],
    ...(database || schema ? { platformConfig: { ...(database ? { database } : {}), ...(schema ? { schema } : {}) } } : {}),
    answers, builtAt: now.toISOString()
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# AutoDE Target Context\n' + stringifyYaml(ctx as unknown as Record<string, unknown>));
  return ctx;
}

export interface SourceSystemChoice { id: string; name: string; bindings: string[] }

/** The estate's source systems (not the team's knowledge files), with what feeds each. */
export function sourceSystemChoices(workspaceRoot: string): SourceSystemChoice[] {
  let estate;
  try { estate = parseEstate(fs.readFileSync(layoutPath(workspaceRoot, 'estate'), 'utf8')); } catch { return []; }
  const ids = new Set(sourceSystems(workspaceRoot));
  return estate.systems.filter((s) => ids.has(s.id)).map((s) => ({
    id: s.id, name: s.name,
    bindings: estate.bindings.filter((b) => b.system === s.id).map((b) => b.connection ?? b.file ?? '').filter(Boolean)
  }));
}

/** The source-context entry for an estate system: connected when a connection feeds it, else from its files. */
export function sourceEntryForSystem(workspaceRoot: string, systemId: string): SourceContextEntry | undefined {
  const s = sourceSystemChoices(workspaceRoot).find((x) => x.id === systemId);
  if (!s) return undefined;
  const connection = s.bindings.find((b) => /^[a-z]+:/.test(b));
  return connection
    ? { system: s.id, connectionId: connection, platform: connection.split(':')[0] as SourceContextEntry['platform'], method: 'connected' }
    : { system: s.id, connectionId: s.bindings[0] ?? s.id, method: 'file' };
}
