import * as fs from 'node:fs';
import * as path from 'node:path';
import { BusinessProblemSpec, ColumnMapping, ContextStatus, DataFlow, EntityMapping, MappingContext, SourceEntry, SpecProvenance, SpecStatus } from '../types';
import { PipelineSpec, CURRENT_PIPELINE_SPEC_VERSION } from '../pipelineSpec/types';
import { validatePipelineSpec } from '../pipelineSpec/validator';
import { parseYaml, stringifyYaml } from '../context/Yaml';
import { parseSensitivity, parseSpecGovernance } from '../governance/governance';

/**
 * The per-problem documents a decision can change (docs/mcp-engine-
 * requirements.md §9.2 Phase PA1): the Business Problem Specification, the
 * Pipeline Spec and the Mapping Context — their serialisation, history names
 * and revision rules, shared by the extension's managers (`src/context/*Manager.ts`,
 * which write through VS Code) and the engine's decision appliers (which
 * write with Node). One implementation, so the two can't drift.
 */

/** Where each document lives, relative to the problem's folder. */
export const PROBLEM_DOCUMENT_PATHS = {
  spec: ['spec', 'business-problem.yaml'],
  pipelineSpec: ['spec', 'pipeline.yaml'],
  mappingContext: ['context', 'mapping-context.yaml']
} as const;

export type ProblemDocumentKind = keyof typeof PROBLEM_DOCUMENT_PATHS;

// ── Business Problem Specification ──────────────────────────────────────────

export function specHistoryName(spec: Pick<BusinessProblemSpec, 'version' | 'status'>): string {
  return `business-problem.v${spec.version}.${spec.status}.yaml`;
}

export function serializeBusinessProblemSpec(spec: BusinessProblemSpec): string {
  const doc: Record<string, unknown> = {
    id: spec.id,
    version: spec.version,
    status: spec.status,
    problemStatement: spec.problemStatement,
    objectives: spec.objectives,
    successCriteria: spec.successCriteria,
    scope: { in: spec.scope.in, out: spec.scope.out },
    constraints: spec.constraints,
    assumptions: spec.assumptions,
    domain: spec.domain,
    stakeholders: spec.stakeholders,
    keyEntities: spec.keyEntities,
    // ── Comprehensive (v2) fields — persist as NATIVE YAML (no JSON stopgap) ──
    businessRequirements: spec.businessRequirements,
    dataFlows: spec.dataFlows,
    transformations: spec.transformations,
    dependencies: spec.dependencies,
    acceptanceCriteria: spec.acceptanceCriteria,
    implementationConsiderations: spec.implementationConsiderations,
    sourceCatalog: spec.sourceCatalog,
    governance: spec.governance,
    provenance: spec.provenance,
    createdAt: spec.createdAt,
    updatedAt: spec.updatedAt,
    approvedAt: spec.approvedAt,
    approvedBy: spec.approvedBy,
    implementationType: spec.implementationType,
    implementationTypeReason: spec.implementationTypeReason,
    implementationTypeOverridden: spec.implementationTypeOverridden,
    problemStatementApproved: spec.problemStatementApproved
  };
  // The `yaml` library drops `undefined` top-level keys, so optional fields are
  // omitted automatically; empty arrays are preserved (read back as []).
  return '# AutoDE Business Problem Specification\n' + stringifyYaml(doc);
}

export function parseBusinessProblemSpec(content: string): BusinessProblemSpec {
  const raw = parseYaml(content);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid specification YAML: root must be an object.');
  }
  const doc = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

  // Backward compatibility: legacy files stored scope as flat `scopeIn:`/`scopeOut:`.
  const scopeRaw = (doc.scope && typeof doc.scope === 'object' && !Array.isArray(doc.scope))
    ? doc.scope as Record<string, unknown>
    : {};
  const inScope = list(scopeRaw.in);
  const outScope = list(scopeRaw.out);
  const scope = {
    in: inScope.length > 0 ? inScope : list(doc.scopeIn),
    out: outScope.length > 0 ? outScope : list(doc.scopeOut)
  };

  const spec: BusinessProblemSpec = {
    id: str(doc.id) || `bps-${Date.now().toString(36)}`,
    version: typeof doc.version === 'number' ? doc.version : parseInt(str(doc.version), 10) || 1,
    status: (str(doc.status) as SpecStatus) || 'draft',
    problemStatement: str(doc.problemStatement),
    objectives: list(doc.objectives),
    successCriteria: list(doc.successCriteria),
    scope,
    constraints: list(doc.constraints),
    assumptions: list(doc.assumptions),
    domain: str(doc.domain) || undefined,
    stakeholders: list(doc.stakeholders),
    keyEntities: list(doc.keyEntities),
    createdAt: str(doc.createdAt),
    updatedAt: str(doc.updatedAt),
    approvedAt: str(doc.approvedAt) || undefined,
    approvedBy: str(doc.approvedBy) || undefined,
    implementationType: (doc.implementationType === 'greenfield' || doc.implementationType === 'brownfield') ? doc.implementationType : undefined,
    implementationTypeReason: str(doc.implementationTypeReason) || undefined,
    implementationTypeOverridden: doc.implementationTypeOverridden === true,
    problemStatementApproved: doc.problemStatementApproved === true
  };

  // v2 fields: native YAML keys now; legacy files may still carry a
  // `comprehensive: <JSON>` block that was read as a flow mapping (or string).
  const v2 = resolveV2Block(doc);
  const br = list(v2.businessRequirements ?? doc.businessRequirements);
  if (br.length > 0) spec.businessRequirements = br;
  const transformations = list(v2.transformations ?? doc.transformations);
  if (transformations.length > 0) spec.transformations = transformations;
  const deps = list(v2.dependencies ?? doc.dependencies);
  if (deps.length > 0) spec.dependencies = deps;
  const ac = list(v2.acceptanceCriteria ?? doc.acceptanceCriteria);
  if (ac.length > 0) spec.acceptanceCriteria = ac;
  const ic = list(v2.implementationConsiderations ?? doc.implementationConsiderations);
  if (ic.length > 0) spec.implementationConsiderations = ic;
  const flows = parseDataFlows(v2.dataFlows ?? doc.dataFlows);
  if (flows) spec.dataFlows = flows;
  const catalog = parseSourceCatalog(v2.sourceCatalog ?? doc.sourceCatalog);
  if (catalog) spec.sourceCatalog = catalog;
  const governance = parseSpecGovernance(v2.governance ?? doc.governance);
  if (governance) spec.governance = governance;
  const provenance = parseProvenance(v2.provenance ?? doc.provenance);
  if (provenance) spec.provenance = provenance;

  return spec;
}

/** Returns the legacy `comprehensive:` block (flow-mapped object or JSON string) when present. */
function resolveV2Block(doc: Record<string, unknown>): Record<string, unknown> {
  const comp = doc.comprehensive;
  if (!comp) return {};
  if (typeof comp === 'string') {
    try {
      const parsed = JSON.parse(comp) as unknown;
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return (typeof comp === 'object' && !Array.isArray(comp)) ? comp as Record<string, unknown> : {};
}

function parseDataFlows(v: unknown): DataFlow[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const flows: DataFlow[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as Record<string, unknown>;
    const str = (x: unknown): string => (typeof x === 'string' ? x : '');
    flows.push({
      id: str(f.id),
      source: str(f.source),
      target: str(f.target),
      description: str(f.description),
      transformations: (Array.isArray(f.transformations) ? f.transformations.filter((x) => typeof x === 'string') : undefined) as string[] | undefined,
      frequency: str(f.frequency) || undefined,
      ...(parseSensitivity(f.sensitivity) ? { sensitivity: parseSensitivity(f.sensitivity) } : {})
    });
  }
  return flows.length > 0 ? flows : undefined;
}

function parseSourceCatalog(v: unknown): SourceEntry[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const catalog: SourceEntry[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    const str = (x: unknown): string => (typeof x === 'string' ? x : '');
    catalog.push({
      name: str(s.name),
      type: (str(s.type) as SourceEntry['type']) || 'other',
      description: str(s.description) || undefined,
      availability: str(s.availability) || undefined,
      ...(parseSensitivity(s.sensitivity) ? { sensitivity: parseSensitivity(s.sensitivity) } : {})
    });
  }
  return catalog.length > 0 ? catalog : undefined;
}

function parseProvenance(v: unknown): SpecProvenance[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const prov: SpecProvenance[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const str = (x: unknown): string => (typeof x === 'string' ? x : '');
    prov.push({
      field: str(p.field),
      source: (str(p.source) as SpecProvenance['source']) || 'synthesis',
      questionId: str(p.questionId) || undefined,
      skill: str(p.skill) || undefined
    });
  }
  return prov.length > 0 ? prov : undefined;
}

// ── Pipeline Spec ───────────────────────────────────────────────────────────

export function pipelineSpecHistoryName(spec: Pick<PipelineSpec, 'version' | 'status'>): string {
  return `pipeline.v${spec.version}.${spec.status}.yaml`;
}

export function serializePipelineSpec(spec: PipelineSpec): string {
  return '# AutoDE Pipeline Spec\n' + stringifyYaml(spec as unknown as Record<string, unknown>);
}

/**
 * A document whose `specVersion` doesn't match `CURRENT_PIPELINE_SPEC_VERSION`
 * is loaded leniently with a logged warning rather than a hard failure —
 * schema evolution must never brick an already-approved pipeline (Phase
 * 2B-iv's stated discipline). Only a current-version document is required
 * to pass full Ajv validation.
 */
export function parsePipelineSpecDocument(content: string, log: (msg: string) => void = () => undefined): PipelineSpec {
  const raw = parseYaml(content);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid Pipeline Spec YAML: root must be an object.');
  }
  const doc = raw as Record<string, unknown>;
  const specVersion = typeof doc.specVersion === 'number' ? doc.specVersion : 0;
  if (specVersion !== CURRENT_PIPELINE_SPEC_VERSION) {
    log(`Pipeline Spec was authored against specVersion ${specVersion}, current is ${CURRENT_PIPELINE_SPEC_VERSION} — loading leniently.`);
    return doc as unknown as PipelineSpec;
  }
  const { valid, errors } = validatePipelineSpec(doc);
  if (!valid) {
    throw new Error(`Invalid Pipeline Spec: ${errors.join('; ')}`);
  }
  return doc as unknown as PipelineSpec;
}

// ── Mapping Context ─────────────────────────────────────────────────────────

export function mappingContextHistoryName(context: Pick<MappingContext, 'specVersion' | 'version'>): string {
  return `mapping-context.spec${context.specVersion}.v${context.version ?? 1}.yaml`;
}

export function serializeMappingContext(context: MappingContext): string {
  return '# AutoDE Mapping Context\n' + stringifyYaml(context as unknown as Record<string, unknown>);
}

export function parseMappingContext(content: string): MappingContext {
  const raw = parseYaml(content);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid mapping-context YAML: root must be an object.');
  }
  const doc = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

  const parseColumn = (c: unknown): ColumnMapping | undefined => {
    if (!c || typeof c !== 'object') return undefined;
    const rec = c as Record<string, unknown>;
    const sourceColumn = str(rec.sourceColumn);
    const targetColumn = str(rec.targetColumn);
    if (!sourceColumn || !targetColumn) return undefined;
    return { sourceColumn, targetColumn, transformExpression: str(rec.transformExpression) || undefined };
  };

  const parseMapping = (m: unknown): EntityMapping | undefined => {
    if (!m || typeof m !== 'object') return undefined;
    const rec = m as Record<string, unknown>;
    const id = str(rec.id);
    const sourceEntityId = str(rec.sourceEntityId);
    const targetName = str(rec.targetName);
    if (!id || !sourceEntityId || !targetName) return undefined;
    const columns = Array.isArray(rec.columns) ? rec.columns.map(parseColumn).filter((c): c is ColumnMapping => !!c) : [];
    return {
      id, sourceEntityId, targetName, columns,
      sourceFqn: str(rec.sourceFqn),
      targetEntityId: str(rec.targetEntityId) || undefined,
      notes: str(rec.notes) || undefined
    };
  };

  const mappings = Array.isArray(doc.mappings) ? doc.mappings.map(parseMapping).filter((m): m is EntityMapping => !!m) : [];

  return {
    specId: str(doc.specId),
    specVersion: typeof doc.specVersion === 'number' ? doc.specVersion : 1,
    version: typeof doc.version === 'number' ? doc.version : 1,
    status: (str(doc.status) as ContextStatus) || 'pending',
    sourceContextVersion: num(doc.sourceContextVersion),
    targetContextVersion: num(doc.targetContextVersion),
    mappings,
    builtAt: str(doc.builtAt) || undefined,
    approvedAt: str(doc.approvedAt) || undefined
  };
}

/**
 * An edited approved mapping set is no longer what was approved, so upserting
 * a mapping drops `approved` back to `built` (it must be re-reviewed).
 */
export function withMappingUpserted(current: MappingContext | undefined, mapping: EntityMapping, now: Date = new Date()): MappingContext {
  const base = current ?? { specId: '', specVersion: 1, status: 'pending' as const, mappings: [] };
  const mappings = base.mappings.filter((m) => m.id !== mapping.id);
  mappings.push(mapping);
  const status = base.status === 'approved' ? 'built' : base.status;
  return { ...base, status, mappings, builtAt: now.toISOString() };
}

/**
 * Revision rule of `MappingContextManager.save()`: within the same spec
 * lineage the revision is bumped only when the previous one was approved,
 * and that approved revision is archived first.
 */
export function nextMappingContextRevision(previous: MappingContext | undefined, context: MappingContext): { toSave: MappingContext; archivePrevious: boolean } {
  const sameLineage = !!previous && previous.specId === context.specId && previous.specVersion === context.specVersion;
  const previousWasApproved = previous?.status === 'approved';
  const version = sameLineage
    ? (previousWasApproved ? (previous!.version ?? 1) + 1 : (previous!.version ?? 1))
    : (context.version ?? 1);
  return { toSave: { ...context, version }, archivePrevious: previousWasApproved };
}

// ── Writing with Node (the engine's decision appliers) ───────────────────────

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Copies the previous text into `<dir>/history/<name>` unless it is already there (the managers' archive rule). */
function archive(dir: string, name: string, previousText: string): void {
  const target = path.join(dir, 'history', name);
  if (fs.existsSync(target)) return;
  writeAtomic(target, previousText);
}

export function problemDocumentPath(problemRoot: string, kind: ProblemDocumentKind): string {
  return path.join(problemRoot, ...PROBLEM_DOCUMENT_PATHS[kind]);
}

export function readProblemDocument(problemRoot: string, kind: ProblemDocumentKind): string | undefined {
  try { return fs.readFileSync(problemDocumentPath(problemRoot, kind), 'utf8'); } catch { return undefined; }
}

/** Writes a specification revision, archiving the current one as `SpecManager.saveSpec()` does. */
export function writeBusinessProblemSpec(problemRoot: string, spec: BusinessProblemSpec): void {
  const file = problemDocumentPath(problemRoot, 'spec');
  const currentText = readProblemDocument(problemRoot, 'spec');
  const next = serializeBusinessProblemSpec(spec);
  if (currentText !== undefined) {
    const current = parseBusinessProblemSpec(currentText);
    const currentSerialized = serializeBusinessProblemSpec(current);
    if (currentSerialized !== next) archive(path.dirname(file), specHistoryName(current), currentSerialized);
  }
  writeAtomic(file, next);
}

/** Writes a Pipeline Spec revision (validated), archiving the current one as `PipelineSpecManager.saveSpec()` does. */
export function writePipelineSpec(problemRoot: string, spec: PipelineSpec): void {
  const { valid, errors } = validatePipelineSpec(spec);
  if (!valid) throw new Error(`Invalid Pipeline Spec: ${errors.join('; ')}`);
  const file = problemDocumentPath(problemRoot, 'pipelineSpec');
  const currentText = readProblemDocument(problemRoot, 'pipelineSpec');
  const next = serializePipelineSpec(spec);
  if (currentText !== undefined) {
    const current = parsePipelineSpecDocument(currentText);
    const currentSerialized = serializePipelineSpec(current);
    if (currentSerialized !== next) archive(path.dirname(file), pipelineSpecHistoryName(current), currentSerialized);
  }
  writeAtomic(file, next);
}

/** Upserts one mapping with `MappingContextManager`'s status and revision rules. */
export function writeMappingUpsert(problemRoot: string, mapping: EntityMapping, now: Date = new Date()): MappingContext {
  const file = problemDocumentPath(problemRoot, 'mappingContext');
  const currentText = readProblemDocument(problemRoot, 'mappingContext');
  const previous = currentText === undefined ? undefined : parseMappingContext(currentText);
  // Pinned to the current specification, as the panel does: a mapping set from another spec version starts afresh (v0.45.2).
  const specText = readProblemDocument(problemRoot, 'spec');
  const spec = specText ? parseBusinessProblemSpec(specText) : undefined;
  const sameLineage = !!previous && (!spec || (previous.specId === spec.id && previous.specVersion === spec.version));
  const base: MappingContext | undefined = sameLineage ? previous : spec ? { specId: spec.id, specVersion: spec.version, status: 'built', mappings: [] } : previous;
  const upserted = withMappingUpserted(base, mapping, now);
  const { toSave, archivePrevious } = nextMappingContextRevision(previous, { ...upserted, status: upserted.status === 'pending' ? 'built' : upserted.status });
  if (archivePrevious && previous) archive(path.dirname(file), mappingContextHistoryName(previous), serializeMappingContext(previous));
  writeAtomic(file, serializeMappingContext(toSave));
  return toSave;
}
