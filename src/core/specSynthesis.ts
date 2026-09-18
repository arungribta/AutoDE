import { BusinessProblemSpec, DataFlow, IntakeSession, SourceEntry, SpecProvenance } from './types';

/**
 * Parses and validates the LLM's comprehensive Business Problem Specification
 * (v2). Pure and unit-testable — the LLM call lives in AgentHub.
 */

const SOURCE_TYPES = new Set(['database', 'api', 'file', 'stream', 'saas', 'other']);

const PROVENANCE_FIELDS = [
  'objectives',
  'successCriteria',
  'businessRequirements',
  'dataFlows',
  'transformations',
  'dependencies',
  'acceptanceCriteria',
  'implementationConsiderations',
  'sourceCatalog',
  'scope',
  'constraints',
  'assumptions',
  'stakeholders',
  'keyEntities'
];

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function parseDataFlows(raw: unknown): DataFlow[] {
  if (!Array.isArray(raw)) return [];
  const flows: DataFlow[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    const source = str(record.source);
    const target = str(record.target);
    const description = str(record.description);
    if (!source || !target || !description) return;
    flows.push({
      id: str(record.id) || `f${index + 1}`,
      source,
      target,
      description,
      transformations: asStringArray(record.transformations).length > 0 ? asStringArray(record.transformations) : undefined,
      frequency: str(record.frequency) || undefined
    });
  });
  return flows;
}

function parseSourceCatalog(raw: unknown): SourceEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: SourceEntry[] = [];
  raw.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    const name = str(record.name);
    if (!name) return;
    const rawType = str(record.type);
    entries.push({
      name,
      type: SOURCE_TYPES.has(rawType) ? (rawType as SourceEntry['type']) : 'other',
      description: str(record.description) || undefined,
      availability: str(record.availability) || undefined
    });
  });
  return entries;
}

/**
 * Fields a document most directly informs, when nothing else already
 * accounts for them — used to attribute `source: 'attachment'` provenance.
 * Deliberately narrow (not "any field could come from an attachment") since
 * there is no per-field attribution signal from the LLM's synthesis output
 * today; this is the honest, limited case where the attachment's entity/
 * column extraction plausibly IS what populated the field.
 */
const ATTACHMENT_ATTRIBUTABLE_FIELDS = new Set(['sourceCatalog', 'dataFlows']);

/** Builds field→question/attachment traceability from the intake session. */
function buildProvenance(session?: IntakeSession, previous?: BusinessProblemSpec): SpecProvenance[] {
  if (!session) return [];
  const previousByField = new Map((previous?.provenance ?? []).map((p) => [p.field, p]));
  const entityAttachment = (session.attachments ?? []).find((a) => a.extract?.entities && a.extract.entities.length > 0);

  return PROVENANCE_FIELDS.map((field) => {
    const question = session.questions.find(
      (candidate) => candidate.field === field && session.answers.some((answer) => answer.questionId === candidate.id)
    );
    if (question) {
      return { field, source: 'question' as const, questionId: question.id, skill: question.skill };
    }
    if (entityAttachment && ATTACHMENT_ATTRIBUTABLE_FIELDS.has(field)) {
      return { field, source: 'attachment' as const, attachmentId: entityAttachment.id };
    }
    // Not addressed by this session — if it was carried forward from a previous
    // revision, keep its original provenance rather than mislabeling it "synthesis".
    const carriedForward = previousByField.get(field);
    return carriedForward ? { ...carriedForward, field } : { field, source: 'synthesis' as const };
  });
}

/** Returns `fallback` when `value` is empty (empty array / blank string / undefined). */
function orFallback<T>(value: T[], fallback: T[] | undefined): T[] {
  return value.length > 0 ? value : (fallback ?? []);
}

export interface ComprehensiveSpecOptions {
  previous?: BusinessProblemSpec;
  session?: IntakeSession;
  now?: string;
}

/** Parses/validates the comprehensive spec JSON, producing a v2 BusinessProblemSpec. */
export function parseComprehensiveSpec(raw: unknown, opts: ComprehensiveSpecOptions = {}): BusinessProblemSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('The LLM did not return a JSON object for the specification.');
  }
  const record = raw as Record<string, unknown>;
  const now = opts.now ?? new Date().toISOString();
  const previous = opts.previous;

  // A revision's synthesis call is instructed to always return the full spec, but
  // fall back to the previous approved content for any field the LLM's output
  // left empty — a defensive net so an under-specified revision turn can never
  // silently wipe previously-approved content.
  const problemStatement = str(record.problemStatement) || previous?.problemStatement || '';
  if (!problemStatement) throw new Error('The LLM did not return a problemStatement.');

  const objectives = orFallback(asStringArray(record.objectives), previous?.objectives);
  if (objectives.length === 0) throw new Error('The LLM did not return any objectives.');

  const scopeRaw = (record.scope && typeof record.scope === 'object' ? record.scope : {}) as Record<string, unknown>;
  const scopeIn = orFallback(asStringArray(scopeRaw.in ?? scopeRaw.inScope), previous?.scope?.in);
  if (scopeIn.length === 0) throw new Error('The LLM did not return any in-scope items.');

  const isRevisionOfApproved = previous?.status === 'approved';

  return {
    id: previous?.id ?? `bps-${Date.now().toString(36)}`,
    version: isRevisionOfApproved ? (previous?.version ?? 1) + 1 : (previous?.version ?? 1),
    status: 'draft',
    problemStatement,
    objectives,
    successCriteria: orFallback(asStringArray(record.successCriteria), previous?.successCriteria),
    scope: {
      in: scopeIn,
      out: orFallback(asStringArray(scopeRaw.out ?? scopeRaw.outOfScope), previous?.scope?.out)
    },
    constraints: orFallback(asStringArray(record.constraints), previous?.constraints),
    assumptions: orFallback(asStringArray(record.assumptions), previous?.assumptions),
    domain: str(record.domain) || previous?.domain || undefined,
    stakeholders: orFallback(asStringArray(record.stakeholders), previous?.stakeholders),
    keyEntities: orFallback(asStringArray(record.keyEntities), previous?.keyEntities),
    businessRequirements: orFallback(asStringArray(record.businessRequirements), previous?.businessRequirements),
    dataFlows: orFallback(parseDataFlows(record.dataFlows), previous?.dataFlows),
    transformations: orFallback(asStringArray(record.transformations), previous?.transformations),
    dependencies: orFallback(asStringArray(record.dependencies), previous?.dependencies),
    acceptanceCriteria: orFallback(asStringArray(record.acceptanceCriteria), previous?.acceptanceCriteria),
    implementationConsiderations: orFallback(asStringArray(record.implementationConsiderations), previous?.implementationConsiderations),
    sourceCatalog: orFallback(parseSourceCatalog(record.sourceCatalog), previous?.sourceCatalog),
    provenance: buildProvenance(opts.session, previous),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  };
}
