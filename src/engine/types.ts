import type { PrimitiveUse } from './grounding/manifest';
import { TransformSpec } from './transforms/types';
import { FileIo } from './context/contextStore';

export type LlmProvider = 'azure-openai' | 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'copilot' | 'claude';
export type DataPlatformProvider = 'snowflake' | 'databricks' | 'oracle' | 'bigquery' | 'redshift' | 'synapse' | 'other';
export type SnowflakeAuthMode = 'username-password' | 'oauth' | 'key-pair' | 'external-browser' | 'mcp';
/** An interactive-user is a human at a workstation; a service-account is a headless principal (CI, a scheduled job, a server deployment). */
export type PrincipalType = 'interactive-user' | 'service-account';
/** Which principal type(s) a platform's auth mode is suited to — a UI/service config surface only offers applicable modes. */
export interface AuthModeDescriptor {
  mode: string;
  principalTypes: PrincipalType[];
}
export type AgentType = 'ingestionAgent' | 'sttmAgent' | 'snowflakeExecutor' | 'sourceAssessmentAgent' | 'dataModelerAgent' | 'transformScaffoldAgent' | 'toolSkillAgent';
export type PlanStatus = 'pending' | 'running' | 'completed' | 'failed';
export type SessionStatus = 'idle' | 'planning' | 'ready' | 'running' | 'paused' | 'failed' | 'completed';
export type EnvironmentProfile = 'development' | 'staging' | 'production';
export type ModelingApproach = 'dimensional' | 'data-vault' | 'obt' | '3nf' | 'raw-pass-through';
export type NamingConvention = 'snake_case' | 'camelCase' | 'PascalCase';
export type TransformationTool = 'dbt' | 'sqlmesh' | 'custom-sql' | 'stored-procedures' | 'none';
export type OrchestrationTool = 'airflow' | 'dagster' | 'prefect' | 'dbt-cloud' | 'manual' | 'none';
export type OutputFormat = 'ddl' | 'yaml' | 'markdown' | 'python' | 'sql';

// ── Project & Workflow Types ──

export type WorkflowPhase = 'discover' | 'model' | 'build' | 'validate';

/**
 * Whether the project is building on an existing system (`brownfield`) or
 * starting without one (`greenfield`). Classified deterministically from the
 * approved specification (keyword evidence, mirroring phase inference), with
 * an explicit user override always available — see `implementationType.ts`.
 */
export type ImplementationType = 'greenfield' | 'brownfield';

/**
 * Live status of an inferred workflow phase.
 * `unrequired` means the phase is Non-Applicable (excluded by the spec, or by a user override).
 * `pending-review` means a plan exists but hasn't been run yet — the phase is awaiting the
 * user's confirmation on the Workflow Palette before "Generate Artifacts" is clicked.
 */
export type PhaseStatus = 'pending-review' | 'pending' | 'in-progress' | 'completed' | 'blocked' | 'unrequired';

/**
 * A workflow phase inferred from the approved Business Problem Specification.
 * Carries the deterministic reason, ownership of the generated plan, and live status.
 */
export interface InferredPhase {
  phase: WorkflowPhase;
  label: string;
  required: boolean;
  status: PhaseStatus;
  /** Short, human-readable justification produced by the inference rules. */
  reason: string;
  /** Phases that must be completed before this one can start (only required phases appear here). */
  dependsOn: WorkflowPhase[];
}

// ── Business Problem Specification ──

export type SpecStatus = 'draft' | 'approved' | 'superseded';

// ── Multi-Problem Workspace (v0.12.0) ──
//
// A single workspace can hold several business problems, each with its own
// spec/plan/context/artifacts subtree under `.autode/problems/<id>/`.
// See requirements.md §8.11.

/** Identifies which business problem is currently active — `.autode/local/active-problem.json`. */
export interface ActiveProblemPointer {
  problemId: string;
  activatedAt: string;
}

/** One row in the business-problem picker — summarized from `<id>/spec/business-problem.yaml` without loading the full spec. */
export interface BusinessProblemSummary {
  id: string;
  problemStatement: string;
  status: SpecStatus;
  specVersion: number;
  updatedAt: string;
  isActive: boolean;
}

export interface BusinessProblemSpec {
  id: string;
  version: number;
  status: SpecStatus;
  problemStatement: string;
  objectives: string[];
  successCriteria: string[];
  scope: { in: string[]; out: string[] };
  constraints: string[];
  assumptions: string[];
  domain?: string;
  stakeholders?: string[];
  keyEntities?: string[];
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvedBy?: string;

  // ── Comprehensive (v2) fields — populated by agentic spec synthesis ──
  businessRequirements?: string[];
  dataFlows?: DataFlow[];
  transformations?: string[];
  dependencies?: string[];
  /** Verifiable pass/fail conditions, distinct from business `successCriteria`. */
  acceptanceCriteria?: string[];
  implementationConsiderations?: string[];
  sourceCatalog?: SourceEntry[];
  /**
   * Phase C4a: ledger ids of the business-problem pack's contract clauses this
   * specification rests on — referenced, not copied, so the spec and the
   * contract can't drift apart.
   */
  packRefs?: string[];
  /** Traceability: which question/skill/assumption produced each spec field. */
  provenance?: SpecProvenance[];

  // ── Implementation type classification ──
  implementationType?: ImplementationType;
  /** Human-readable justification produced by `classifyImplementationType`, or "Manually set by user." */
  implementationTypeReason?: string;
  /** True once the user has explicitly overridden the deterministic classification — preserved across revisions. */
  implementationTypeOverridden?: boolean;

  // ── Business Problem checkpoint (v0.13.0) ──
  /**
   * True once the user has reviewed and explicitly confirmed the inferred
   * business problem statement produced by discovery — a lightweight gate
   * ahead of the full specification review, required before `approveSpec`
   * will accept this spec. See requirements.md §8.12. Not reset by in-place
   * spec edits (`reviseSpec`/refinement of a still-draft spec); reset to
   * `false` only when a *new* draft is synthesized (a fresh discovery pass
   * or a revision of an already-approved spec), since that's the point a
   * new business-problem understanding needs re-confirming.
   */
  problemStatementApproved?: boolean;
}

// ── Agentic Specification Generation (SpecOps) ──

/** A named data movement from a source to a target (business flow, not physical DDL). */
export interface DataFlow {
  id: string;
  source: string;
  target: string;
  description: string;
  transformations?: string[];
  frequency?: string;
}

/** A candidate source system/entity surfaced during requirements discovery. */
export interface SourceEntry {
  name: string;
  type: 'database' | 'api' | 'file' | 'stream' | 'saas' | 'other';
  description?: string;
  availability?: string;
}

/** Links a spec field to the question/skill/assumption/attachment that produced it. */
export interface SpecProvenance {
  /** Dotted path, e.g. 'dataFlows' or 'objectives.0'. */
  field: string;
  source: 'user' | 'question' | 'assumption' | 'synthesis' | 'skill' | 'attachment';
  questionId?: string;
  skill?: string;
  /** Populated when `source === 'attachment'` — the `IntakeAttachment.id` that informed this field. */
  attachmentId?: string;
}

export type SpecQuestionKind = 'text' | 'single-select' | 'multi-select' | 'boolean';

export interface SpecIntakeQuestion {
  id: string;
  /** Primary spec field this question informs (dotted path, e.g. 'dataFlows'). */
  field: string;
  prompt: string;
  kind: SpecQuestionKind;
  options?: string[];
  rationale?: string;
  skill?: string;
  askedAt: string;
}

export interface IntakeAnswer {
  questionId: string;
  field: string;
  value: string;
  answeredAt: string;
}

export type SpecEngineState = 'discovery' | 'synthesizing' | 'draft' | 'refining' | 'approved';

export type SpecCoverageStatus = 'complete' | 'partial' | 'missing';

/** A column the structured extraction found in an attached document. */
export interface AttachmentExtractColumn {
  name: string;
  type?: string;
}

/** An entity (table-like structure) the structured extraction found in an attached document. */
export interface AttachmentExtractEntity {
  name: string;
  columns?: AttachmentExtractColumn[];
}

/**
 * Structured facts pulled from an `IntakeAttachment` by a dedicated LLM
 * extraction pass (Phase 2B-i) — deliberately not a rigid, format-specific
 * schema, since an attachment could be a schema dump, a requirements memo,
 * or anything else. `rawSummary` is the graceful-degradation floor: always
 * populated, even when nothing else can be extracted.
 */
export interface AttachmentExtract {
  attachmentId: string;
  extractedAt: string;
  entities?: AttachmentExtractEntity[];
  businessRules?: string[];
  constraints?: string[];
  rawSummary: string;
  confidence: 'high' | 'medium' | 'low';
}

/** A file the user attached as supplementary reference material for a spec conversation. */
export interface IntakeAttachment {
  id: string;
  path: string;
  content: string;
  attachedAt: string;
  /** Populated once the structured-extraction pass has run (Phase 2B-i) — absent for an attachment made before this existed, or if extraction itself is still pending. */
  extract?: AttachmentExtract;
}

/** Persisted record of an in-progress (or completed) agentic specification conversation. */
export interface IntakeSession {
  id: string;
  specId?: string;
  problemStatement: string;
  state: SpecEngineState;
  questions: SpecIntakeQuestion[];
  answers: IntakeAnswer[];
  /** Derived observations from the conversation (LLM-produced). */
  insights: string[];
  /** Per spec-field coverage used by the stop condition. */
  coverage: Record<string, SpecCoverageStatus>;
  turnCount: number;
  turnBudget: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Set when this session is *revising* an already-approved specification rather
   * than starting fresh. A snapshot taken when the session was created — used to
   * show the LLM what already exists so it only asks about what the change
   * affects, and to carry forward anything the revision doesn't touch.
   */
  previousSpec?: BusinessProblemSpec;
  /** The user's description of the requested change, when `previousSpec` is set. */
  changeRequest?: string;
  /** Ad-hoc reference files the user attached during the conversation. */
  attachments?: IntakeAttachment[];
}

/**
 * The prompt-schema "action" an LLM returns each turn. Validated deterministically.
 * (No native tool-calling: Copilot's vscode.lm is text-in/text-out only.)
 */
export type SpecEngineAction =
  | { action: 'ask'; question: Omit<SpecIntakeQuestion, 'id' | 'askedAt'> }
  | { action: 'ask_many'; questions: Array<Omit<SpecIntakeQuestion, 'id' | 'askedAt'>> }
  | { action: 'synthesize' }
  | { action: 'done' };

/** A composable DE spec-generation skill (Superpowers-inspired, user-editable). */
export interface SkillDefinition {
  id: string;
  name: string;
  order: number;
  description: string;
  /** System prompt fragment loaded for this skill. */
  systemPrompt: string;
  /** Guidance for the LLM on what questions this skill asks. */
  questionGuidance: string;
  /** Spec fields this skill is responsible for filling (empty = non-question skill, e.g. synthesis). */
  specFields: string[];
  exampleQuestions?: string[];
}

// ── Target Environment ──

export interface SnowflakeTargetConfig {
  account: string;
  database: string;
  schema: string;
  warehouse: string;
  role: string;
}

export interface DatabricksTargetConfig {
  workspaceUrl: string;
  catalog: string;
  schema: string;
}

export interface BigQueryTargetConfig {
  projectId: string;
  dataset: string;
  region: string;
}

export type PlatformTargetConfig = SnowflakeTargetConfig | DatabricksTargetConfig | BigQueryTargetConfig;

export interface TargetEnvironment {
  platform: DataPlatformProvider;
  environmentProfile: EnvironmentProfile;
  modelingApproach: ModelingApproach;
  namingConvention: NamingConvention;
  transformationTool: TransformationTool;
  orchestrationTool: OrchestrationTool;
  outputFormats: OutputFormat[];
  platformConfig: PlatformTargetConfig;
}

export interface TargetProfile {
  name: string;
  inherits?: string;
  environment: TargetEnvironment;
}

export interface TargetConfigFile {
  profiles: TargetProfile[];
  activeProfile: string;
}

// ── Source & Target Context (v0.11.0) ──
//
// Distinct from TargetEnvironment/TargetConfigFile above (which are a flat,
// generic, user-editable tool-preference profile) and from the Context Layer
// graph (which only ever re-derives what the spec already says). These are
// spec-tied, reviewed, gating records: built via a structured Q&A after spec
// approval, explicitly approved by the user, and required before a plan can
// be generated. See requirements.md §8.10.

/** `not_applicable` only ever applies to Source Context (Greenfield — no source system). Target Context is always required. */
export type ContextStatus = 'not_applicable' | 'pending' | 'built' | 'approved';

export type ContextQuestionKind = 'text' | 'single-select' | 'boolean';

/** One deterministic (non-adaptive) question in a Target/Source Context Q&A flow. */
export interface ContextQuestion {
  id: string;
  /** Field on TargetContext/SourceContext this answer populates — dotted for nested fields, e.g. 'platformConfig.database'. */
  field: string;
  prompt: string;
  kind: ContextQuestionKind;
  options?: string[];
  rationale?: string;
  /** Deterministic, keyword-evidence-derived suggestion — pre-fills the form field, never silently assumed. */
  suggestedDefault?: string;
}

/**
 * The reviewed, approved target-platform decision for one spec version.
 * Once approved, its fields become the plan's live `TargetEnvironment`
 * (`AgentHub.setTargetEnvironment`) — replacing the generic
 * `TargetConfigManager` default that previously seeded it silently.
 */
export interface TargetContext {
  specId: string;
  specVersion: number;
  /**
   * The Target Context's own content-revision counter — independent of
   * `specVersion` (which BPS revision this context belongs to). Bumped only
   * when a revision replaces an already-*approved* predecessor, mirroring
   * `PipelineSpec.version`/`PrimitiveDefinition.version`; approving a
   * not-yet-approved record never bumps it. The prior revision is archived to
   * `context/history/target-context.v<N>.yaml` on bump. Defaults to 1 when
   * absent (pre-v0.19.0 records, or a fresh first build).
   */
  version?: number;
  status: ContextStatus;
  platform?: DataPlatformProvider;
  environmentProfile?: EnvironmentProfile;
  modelingApproach?: ModelingApproach;
  namingConvention?: NamingConvention;
  transformationTool?: TransformationTool;
  orchestrationTool?: OrchestrationTool;
  outputFormats?: OutputFormat[];
  platformConfig?: Record<string, string>;
  /**
   * How the platform connection was established via "AutoDE: Connect to Data
   * Platform" (Phase 3a-ii) — a pointer, never the secret. `resolverId` names a
   * registered `CredentialResolver` (`src/engine/platform/credentials/`, e.g. `'cli'`); `ref`
   * is that resolver's own reference (e.g. a `connections.toml` connection name).
   */
  credentialRef?: { resolverId: string; ref: string };
  /** Raw Q&A record (question id → answer) for traceability and re-display when revising. */
  answers: Record<string, string>;
  builtAt?: string;
  approvedAt?: string;
}

/**
 * The reviewed source-system context for one spec version — `not_applicable`
 * for Greenfield, otherwise built via either a live connection check
 * (`method: 'connected'`) or a guided description (`method: 'described'`,
 * for data-push/no-connectivity cases). Its `description`/`connectionSummary`
 * feed the Context Layer prompt alongside the spec once approved.
 */
/**
 * One connected or described source system within a `SourceContext`.
 * `connectionId` is the stable discriminator that distinguishes it from any
 * other entry (see `BaseDataSourceAdapter.getConnectionId()` /
 * `Origin.connectionId`) — required so multiple entries (a future capability;
 * v1 UI only ever populates one) never collide, e.g. two Snowflake connections
 * or two tables named the same across different sources. Distinct from the
 * unrelated, pre-existing `SourceEntry` (a Business Problem Spec's named
 * source-catalog item) — different concept, deliberately different name.
 */
export interface SourceContextEntry {
  connectionId: string;
  platform?: DataPlatformProvider;
  /** `'file'` (v0.22.0, Step 5) — structurally parsed from a CSV/JSON/DDL file, for when live connectivity isn't available. See `src/engine/context/fileIngestion.ts`. */
  method: 'connected' | 'described' | 'file';
  sourceType?: 'database' | 'api' | 'file' | 'stream' | 'saas' | 'other';
  description?: string;
  connectionSummary?: {
    database: string;
    schema: string;
    tableCount: number;
    viewCount: number;
  };
  /** Populated only for `method: 'file'` entries. */
  fileSummary?: {
    fileName: string;
    format: 'csv' | 'json' | 'ddl';
    tableCount: number;
    columnCount: number;
  };
  extractedAt?: string;
}

/**
 * The Source Context is one object with one lifecycle/approval, even once it
 * describes more than one source system — `sources` holds the (currently 0-or-1,
 * future N) entries. See "Source & Target Context Architecture" in the
 * architecture plan for the reasoning: one container, internally scalable,
 * rather than multiple sibling context records.
 */
export interface SourceContext {
  specId: string;
  specVersion: number;
  /** Content-revision counter, independent of `specVersion` — see `TargetContext.version`'s doc comment for the exact semantics (same pattern on both). */
  version?: number;
  status: ContextStatus;
  sources: SourceContextEntry[];
  answers: Record<string, string>;
  builtAt?: string;
  approvedAt?: string;
}

/**
 * One source column → target column correspondence within an `EntityMapping`.
 * `transformExpression` is free-text (e.g. `UPPER(source_col)`) — deliberately
 * not a structured transform reference in this pass; that's the same
 * selectable-primitive concept `TransformSpec` already models elsewhere, and
 * wiring the two together is future work, not invented fresh here.
 */
export interface ColumnMapping {
  sourceColumn: string;
  targetColumn: string;
  transformExpression?: string;
}

/**
 * One source table → target table mapping. `sourceEntityId` references a real
 * `GraphManager` node id (a live-connected or file-ingested table) — the
 * mapping is meaningless without a real source. `targetEntityId` is optional:
 * per the reviewed proposal's Greenfield case, a target table frequently
 * doesn't exist as a discovered node yet (it's being designed), so `targetName`
 * (free text) is what's authoritative when there's no node to point at.
 */
export interface EntityMapping {
  id: string;
  sourceEntityId: string;
  sourceFqn: string;
  targetEntityId?: string;
  targetName: string;
  columns: ColumnMapping[];
  notes?: string;
}

/**
 * A separate, independent object from `SourceContext`/`TargetContext` — per
 * the architecture review's Q2: mappings are inherently relational and don't
 * belong inside either side. `sourceContextVersion`/`targetContextVersion` pin
 * the mapping to the specific context revisions it was built against (the
 * same version-pinning pattern `PipelineSpec`/primitive-version-pinning
 * already use elsewhere), so a later Source/Target Context revision can't
 * silently invalidate an existing mapping — it just becomes visibly stale
 * against a newer version, never silently wrong.
 */
export interface MappingContext {
  specId: string;
  specVersion: number;
  version?: number;
  status: ContextStatus;
  sourceContextVersion?: number;
  targetContextVersion?: number;
  mappings: EntityMapping[];
  builtAt?: string;
  approvedAt?: string;
}

/**
 * A persisted, versioned snapshot of the Unified Semantic Layer — per the
 * architecture review's Q3, the semantic layer is already one unified
 * `GraphManager` graph (source and target nodes coexist via
 * `Origin.environment` tagging), so this is deliberately NOT a second
 * modeling system. It's an explicit, spec-pinned point-in-time capture of
 * that one graph's node/edge counts, generated only on an explicit "Build"
 * action (never silently/automatically, matching this codebase's consistent
 * governance pattern) — the same reasoning `PipelineSpec`/primitive-version
 * pinning already use: a later live-graph change shouldn't silently
 * invalidate what a pipeline was actually generated against.
 */
export interface SemanticLayerSnapshot {
  specId: string;
  specVersion: number;
  version?: number;
  status: ContextStatus;
  nodeCount: number;
  edgeCount: number;
  builtAt?: string;
  approvedAt?: string;
}

// ── Artifact Types ──

export type ArtifactType = 'data_model' | 'sttm_mapping' | 'ddl_script' | 'pipeline_dag' | 'architecture_diagram' | 'data_dictionary' | 'sql_script' | 'requirements_doc' | 'discovery_report' | 'data_profile' | 'knowledge_graph' | 'validation_report' | 'test_suite';

export interface GeneratedArtifact {
  id: string;
  type: ArtifactType;
  title: string;
  description: string;
  content: string;
  language: 'sql' | 'yaml' | 'markdown' | 'python' | 'json';
  /** The agent, or `engine` for what AutoDE derives itself (the grounding report); older artifacts may name a retired agent. */
  generatedBy: AgentType | 'engine' | string;
  generatedAt: string;
  approved: boolean;
  filePath?: string;
  phase?: WorkflowPhase;
  specId?: string;
  specVersion?: number;
}

// ── Core Settings ──

export interface DataAgentHubSettings {
  extensionDisplayName: string;
  extensionDescription: string;
  defaultProvider: DataPlatformProvider;
  defaultSnowflakeAccount: string;
  defaultSnowflakeUsername: string;
  defaultSnowflakeWarehouse: string;
  defaultSnowflakeDatabase: string;
  defaultSnowflakeSchema: string;
  defaultSnowflakeRole: string;
  defaultSnowflakeAuthMode: SnowflakeAuthMode;
  snowflakePrivateKeyPath: string;
  metadataCachingDurationMinutes: number;
  queryTimeoutSeconds: number;
  readOnlyMode: boolean;
  enableSessionReuse: boolean;
  autoDocumentationEnabled: boolean;
  telemetryEnabled: boolean;
  activeLlmProvider: LlmProvider;
  activeLlmModel: string;
  llmEndpoint: string;
  artifactDirectory: string;
  /** Consent to use a locally-installed language model programmatically (VS Code Copilot, or the Claude Code CLI). */
  languageModelProgrammaticConsent?: boolean;
  /** Optional explicit path to the Claude Code CLI (`claude` / `claude.exe`). Empty = auto-detect. */
  claudeCodePath?: string;
  /** @deprecated Superseded by `languageModelProgrammaticConsent`; still read as a fallback. */
  copilotProgrammaticConsent?: boolean;
  /** Opt-in gate (Phase 2B-iv, default false) — publishing/deprecating a Tier-2 declarative primitive is disabled until a workspace's platform admin turns this on. */
  primitiveManagementEnabled?: boolean;
  /** Opt-in (Phase S2, default false): tool-skill lifecycle — imports start as drafts; publish/deprecate/retire keep versions. Review and trust work regardless. */
  toolSkillManagementEnabled?: boolean;
  /** Consent to shell out to an external data-platform CLI (`snow`/`databricks`) — to enumerate connections/profiles (Phase 3a-ii), and to actually execute queries via a CLI-derived connection (Phase 3b's `SnowflakeCliBackend`). CLI *detection* (a version check) is exempt — only these actually invoke the vendor CLI. */
  dataPlatformCliConsent?: boolean;
  /** Optional explicit path to the Snowflake CLI (`snow` / `snow.exe`). Empty = auto-detect via PATH. */
  snowflakeCliPath?: string;
  /** Optional explicit path to the Databricks CLI (`databricks` / `databricks.exe`). Empty = auto-detect via PATH. */
  databricksCliPath?: string;
  /**
   * A service-account `CredentialReference` set once by a platform team (Phase
   * 3a-ii) — deliberately a plain settings surface, no chat/QuickPick/CLI-detection
   * dialog. JSON string of `{platform, resolverId, ref}`; `principalType` is always
   * `'service-account'` for this setting. See `getServiceAccountCredentialReference()`.
   */
  serviceAccountCredentialRef?: string;
  /** Default Databricks workspace host (e.g. `adb-1234.5.azuredatabricks.net`, scheme optional). Phase 3b — Databricks has no equivalent settings today; `ConnectionManager.getCredentialsFromSettings()` previously referenced a nonexistent `workspaceUrl` key. */
  defaultDatabricksWorkspaceUrl?: string;
  /** The target SQL warehouse's HTTP Path (e.g. `/sql/1.0/warehouses/<id>`), copied from its connection-details page. Used both to derive `warehouse_id` for the Statement Execution REST API and (Phase 3b-iv, future) as the native-driver connection path. */
  defaultDatabricksHttpPath?: string;
  defaultDatabricksCatalog?: string;
  defaultDatabricksSchema?: string;
  /**
   * Explicit override for which metadata-introspection shape `DatabricksAdapter`
   * uses — `'unity'` (`information_schema` as a schema within the catalog) or
   * `'hive_metastore'` (legacy: no bulk `information_schema` at all, `SHOW TABLES`
   * only, no column/FK/view-level detail). `'auto'` (default) infers it from the
   * catalog name (`hive_metastore` is a reserved name Databricks never lets a user
   * repurpose) — but a single workspace can have *both* kinds of catalog side by
   * side, so this is user-settable rather than silently inferred every time,
   * and also doubles as a manual escape hatch for any other catalog that turns
   * out to share the legacy catalog's limitations.
   */
  defaultDatabricksCatalogType?: 'auto' | 'unity' | 'hive_metastore';
  /** Oracle source (v0.38.0, Thin mode): a tnsnames alias or an Easy Connect string (`host:port/service`). */
  defaultOracleConnectString?: string;
  defaultOracleUsername?: string;
  /** Folder holding tnsnames.ora; empty = TNS_ADMIN, then $ORACLE_HOME/network/admin. */
  oracleConfigDir?: string;
  /** TLS wallet folder (e.g. Autonomous Database); its password is a secret. */
  oracleWalletLocation?: string;
  /** Where user-installed drivers live (phase DRV1); empty = AUTODE_DRIVERS_DIR, else ~/.autode/drivers. */
  driversDirectory?: string;
  /** Phase DRV2: the named connection (connections.yaml id) Connect uses per role; empty = the card's fields. */
  activeSourceConnection?: string;
  activeTargetConnection?: string;

  // ── Target connection (v0.19.0 Source/Target Panel split) ──
  // Doubled flat settings, deliberately additive rather than a symmetric
  // rename: the fields above (defaultProvider/defaultSnowflake*/
  // defaultDatabricks*) keep meaning "source" exactly as they always have —
  // renaming them would have orphaned real, already-configured settings.json
  // values. `defaultTargetProvider` etc. are the new, parallel target-side
  // settings; both can be live simultaneously (separate `ConnectionManager`
  // instances in `extension.ts`), per the confirmed decision.
  defaultTargetProvider?: DataPlatformProvider;
  defaultTargetSnowflakeAccount?: string;
  defaultTargetSnowflakeUsername?: string;
  defaultTargetSnowflakeWarehouse?: string;
  defaultTargetSnowflakeDatabase?: string;
  defaultTargetSnowflakeSchema?: string;
  defaultTargetSnowflakeRole?: string;
  defaultTargetSnowflakeAuthMode?: SnowflakeAuthMode;
  targetSnowflakePrivateKeyPath?: string;
  targetSnowflakeCliPath?: string;
  targetDatabricksCliPath?: string;
  defaultTargetDatabricksWorkspaceUrl?: string;
  defaultTargetDatabricksHttpPath?: string;
  defaultTargetDatabricksCatalog?: string;
  defaultTargetDatabricksSchema?: string;
  defaultTargetDatabricksCatalogType?: 'auto' | 'unity' | 'hive_metastore';
}

export interface PlanStep {
  id: string;
  assignedAgent: AgentType;
  taskDescription: string;
  status: PlanStatus;
  dependsOn?: string[];
  validationRules?: string[];
  phase?: WorkflowPhase;
  /** Which imported tool skill to run — required when `assignedAgent === 'toolSkillAgent'`. */
  skillId?: string;
  /** Pins a published version of that skill (Phase S2); resolves after deprecation, from its version history. */
  skillVersion?: number;
}

// ── Tool-executing Skills (Phase D) ──

/** A Claude Agent Skill (SKILL.md + resources) imported into AutoDE. Distinct from the
 * interview-only `SkillDefinition` (skills/*.json) — this one can carry real tool access. */
export interface ToolSkillDefinition {
  id: string;
  name: string;
  description: string;
  /** The SKILL.md body — instructions injected into the model's system prompt. */
  instructions: string;
  /** Tool names the skill's own frontmatter declared it needs, if any (informational — the
   * actual tool surface granted at run time is still capped by the execution mode). */
  declaredTools?: string[];
  /** Absolute path to the imported skill's directory (contains SKILL.md + any resources). */
  sourceDir: string;
  /** Relative paths of bundled resource files alongside SKILL.md. */
  resourceFiles: string[];
}

export type ToolExecutionMode = 'none' | 'read-only' | 'full';

/** One tool invocation, for the audit log a tool-skill run produces. */
export interface ToolCallAuditEntry {
  tool: string;
  input: Record<string, unknown>;
  /** 'approved' | 'denied' | 'error' | 'ok' */
  outcome: string;
  detail?: string;
  at: string;
}

// ── Chat sessions (Phase F) ──

export type ChatSessionStatus = 'active' | 'archived' | 'discarded';

/**
 * Metadata for one chat session. Independent of Business Problem Specification
 * identity (a chat is a transcript, not a spec container) — `specId`/`specVersion`
 * are just "what was approved when this chat was active," for traceability, not
 * a container relationship.
 */
export interface ChatSessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: ChatSessionStatus;
  specId?: string;
  specVersion?: number;
  llmProvider?: LlmProvider;
  /** A short, human-readable label — the first user message, truncated, when available. */
  title?: string;
  /** Claude Code CLI's own session id for this chat (`--session-id` on first use, `--resume` after).
   *  Set only while `llmProvider === 'claude'`; a provider switch leaves it stale and unused. */
  claudeSessionId?: string;
  /** Rolling compressed account of turns that have aged out of the token-budget window (Phase 3). */
  summary?: string;
}

/** One persisted line of a chat session's transcript (`.autode/local/chats/<id>.jsonl`). */
export interface ChatMessage {
  role: 'user' | 'ai' | 'log';
  content: string;
  at: string;
}

export interface PlanState {
  objective: string;
  schemaContext: string;
  sourceProvider: DataPlatformProvider;
  targetEnvironment?: TargetEnvironment;
  steps: PlanStep[];
  mode: 'plan' | 'execute';
  status: SessionStatus;
  runningStepId?: string;
  lastError?: string;
  /** C4b: the step paused on context gaps, and what it needs (answered in the Context Inbox). */
  waitingForContext?: { stepId: string; gaps: Array<{ needed: string; subject: string[]; text: string; reason: string; minTrust: string; foundTrust?: string; stepId?: string }> };
  artifacts?: GeneratedArtifact[];
  currentPhase?: WorkflowPhase;
  specId?: string;
  specVersion?: number;
  /** Phases inferred from the approved Business Problem Specification (live status view). */
  inferredPhases?: InferredPhase[];
  /** Carried over from the spec that produced this plan — see `BusinessProblemSpec.implementationType`. */
  implementationType?: ImplementationType;
  /**
   * Explicit user overrides of a phase's applicability (Applicable/Non-Applicable),
   * layered on top of whatever `inferPhases()` computed. Survives a subsequent
   * re-plan (re-applied after each `inferPhases()` call) and is cleared by
   * `resetPlan()`. Does not retroactively edit an already-generated plan's
   * steps — the palette flags the plan as possibly stale instead (see
   * `requirements.md` §8.8 follow-up).
   */
  phaseOverrides?: Partial<Record<WorkflowPhase, boolean>>;
  /**
   * Live mirror of `webviewProvider.computeContextGateStatus().canGeneratePlan` (v0.13.0) —
   * pushed into the hub whenever context/spec state changes so the orchestrator (`AgentHub`)
   * can enforce the same precondition on plan generation itself, not just at the UI call site.
   * Not persisted — recomputed and re-pushed on every activation/context change.
   */
  contextGateReady?: boolean;
  /**
   * Explicit Plan Approval gate (v0.13.0, requirements.md §8.12) — required before
   * `executePlan()` will run. Set by `AgentHub.approvePlan()`; reset to `false` whenever
   * a new plan is generated, since a regenerated plan needs its own approval.
   */
  planApproved?: boolean;
  planApprovedAt?: string;
  /**
   * Explicit "confirm applicable stages" gate (v0.13.0, requirements.md §8.12) — required
   * before `executePlan()` will run, alongside `planApproved`. Set by `AgentHub.confirmStages()`;
   * reset to `false` whenever the inferred/overridden phase set changes (`inferPhasesFromSpec`,
   * `setPhaseOverride`) or a new plan is generated, since either invalidates a prior confirmation.
   */
  stagesConfirmed?: boolean;
  stagesConfirmedAt?: string;
}

/**
 * The durable, on-disk record of a generated plan — persisted by `PlanManager` to
 * `.autode/plan/plan.yaml`, with every prior version archived to `plan/history/`
 * (mirrors `SpecManager`'s pattern exactly). Unlike `PlanState`, which is the live,
 * in-memory working copy `AgentHub` mutates step-by-step during execution, this is
 * the governed artifact: one row written per generation or re-plan.
 */
export interface PersistedPlan {
  /** Stable across versions of the same plan lineage; a fresh objective/spec starts a new id. */
  id: string;
  version: number;
  specId?: string;
  specVersion?: number;
  implementationType?: ImplementationType;
  objective: string;
  schemaContext: string;
  status: SessionStatus;
  steps: PlanStep[];
  inferredPhases?: InferredPhase[];
  targetEnvironment?: TargetEnvironment;
  phaseOverrides?: Partial<Record<WorkflowPhase, boolean>>;
  /** Why this version was written — the initial generation, or a failure-triggered re-plan. */
  generationReason: 'initial' | 're-plan';
  /** Plan Approval + Stage Confirmation gates (v0.13.0) — see `PlanState`. */
  planApproved?: boolean;
  planApprovedAt?: string;
  stagesConfirmed?: boolean;
  stagesConfirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What an agent needs from whatever is hosting it (v0.26.0, docs/mcp-engine-requirements.md
 * §7.4) — so agents ask the host instead of calling VS Code APIs directly. The extension
 * implements it in `AgentHub`; a headless host would supply its own.
 */
export interface AgentHost {
  /** The workspace folder agents read from and write to, if any. */
  workspaceRoot?: string;
  /** Asks the user to approve an action; resolves true only on explicit approval. */
  confirm(message: string, actionLabel: string): Promise<boolean>;
  /** File access in the host's workspace (VS Code's file system inside the extension). */
  fileIo: FileIo;
}

/** One of the engine's MCP tools, as a tool loop offers it to a model (phase 5). */
export interface EngineToolSpec {
  name: string;
  description: string;
  /** The tool's JSON Schema input. */
  parameters: Record<string, unknown>;
}

/**
 * The engine's tools for one tool-loop run (phase 5): already narrowed to what the
 * run may use (mode, the skill's allowed-tools, trust). `call` returns the text the
 * model sees — the tool's JSON result, or an error envelope.
 */
export interface EngineToolSet {
  specs: EngineToolSpec[];
  call(name: string, input: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

/** The engine as an agent reaches it: the same MCP tools any host agent calls, started on first use. */
export interface EngineAccess {
  /** Engine tools for a run in `mode`, narrowed by a skill's declared `allowed-tools` (undefined = no narrowing). */
  toolSet(mode: ToolExecutionMode, declared: readonly string[] | undefined): Promise<EngineToolSet>;
  /** Whether `declared` names an engine tool that changes something (a proposal) — such a skill may need `'full'` mode. */
  declaresWrite(declared: readonly string[] | undefined): Promise<boolean>;
  /** PA3b: the engine's tool list (name, annotations), for choosing an assignment's tools. */
  listTools?(): Promise<Array<{ name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } }>>;
  /** PA3b: exactly the named tools. */
  toolSetNamed?(names: readonly string[]): Promise<EngineToolSet>;
  dispose(): Promise<void>;
}

/** Options for `AgentExecutionContext.runWithTools` (v0.28.0). */
export interface AgentToolRunOptions {
  systemPrompt: string;
  toolExecutionMode: ToolExecutionMode;
  /** AutoDE tool names the run may use; omitted = the mode's full catalog. */
  allowedToolNames?: string[];
  justification?: string;
  /** Claude Code only: the whole-run approval text (it can't approve per call). */
  approvalPrompt?: string;
  /** Engine tools offered next to the file tools (phase 5). AutoDE-owned loops only; Claude Code's own loop ignores them. */
  engineTools?: EngineToolSet;
}

export interface AgentExecutionContext {
  objective: string;
  schemaContext?: string;
  sourceProvider: DataPlatformProvider;
  targetEnvironment?: TargetEnvironment;
  settings: DataAgentHubSettings;
  configManager: {
    getSecret: (key: string) => Promise<string | undefined>;
    getSettings: () => DataAgentHubSettings;
  };
  log: (message: string) => void;
  addArtifact?: (artifact: GeneratedArtifact) => void;
  currentPhase?: WorkflowPhase;
  /**
   * Calls the configured LLM provider (v0.11.0) — lets a codegen agent produce
   * genuinely context-aware content instead of a fixed string template.
   * Delegates to `AgentHub.callConfiguredLlm`; errors propagate as a rejected
   * promise, same as any other LLM call in the hub.
   */
  callLlm?: (prompt: string, systemPrompt?: string) => Promise<string>;
  /**
   * Runs one LLM turn with AutoDE tool access through the configured provider (v0.28.0) and returns
   * the tool-call audit with the text. The tool-skill path: every provider's own tool loop, one call.
   */
  runWithTools?: (prompt: string, opts: AgentToolRunOptions) => Promise<{ text: string; audit: ToolCallAuditEntry[]; provider: LlmProvider }>;
  /** The hosting environment (v0.26.0). Optional so hand-built contexts in tests keep compiling. */
  host?: AgentHost;
  /** The engine's MCP tools, through an in-process client (phase 5). Optional: absent in hand-built contexts. */
  engine?: EngineAccess;
  /** Only populated for `toolSkillAgent` — the workspace root, for sandboxing tool execution. */
  workspaceRoot?: string;
  /** Which skill to run + the user's instruction — populated by the caller (plan step or chat). */
  skillId?: string;
  /** Pins a published version of the skill (Phase S2). */
  skillVersion?: number;
  skillInstruction?: string;
  /**
   * Lets a caller (a future spec/UI authoring flow) supply a transform
   * primitive spec directly, bypassing the LLM's own primitive-selection
   * step entirely (Phase 2, see core/transforms/). When set, a codegen
   * agent's "try primitive first" branch compiles this instead of asking
   * the LLM to choose one.
   */
  transformSpec?: TransformSpec;
  /**
   * Called by the shared codegen path (`generateViaPrimitiveOrFallback`) with
   * what it generated from — which primitive and parameters, or the freehand /
   * template fallback (C3, v0.30.0). The orchestrator turns these into the
   * artifact's grounding manifest; agents never call it themselves.
   */
  recordGeneration?: (use: PrimitiveUse) => void;
}

export interface AgentExecutionResult {
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
  error?: string;
  artifacts?: GeneratedArtifact[];
}

export interface WebviewSettingsMessage {
  defaultProvider?: DataPlatformProvider;
  defaultSnowflakeAccount?: string;
  defaultSnowflakeUsername?: string;
  defaultSnowflakeWarehouse?: string;
  defaultSnowflakeDatabase?: string;
  defaultSnowflakeSchema?: string;
  defaultSnowflakeRole?: string;
  defaultSnowflakeAuthMode?: SnowflakeAuthMode;
  snowflakePrivateKeyPath?: string;
  metadataCachingDurationMinutes?: number;
  queryTimeoutSeconds?: number;
  readOnlyMode?: boolean;
  enableSessionReuse?: boolean;
  autoDocumentationEnabled?: boolean;
  telemetryEnabled?: boolean;
  activeLlmProvider?: LlmProvider;
  activeLlmModel?: string;
  llmEndpoint?: string;
  llmApiKey?: string;
  snowflakePassword?: string;
  snowflakePrivateKeyPassphrase?: string;
}

export interface WebviewMessage {
  type: string;
  [key: string]: unknown;
}