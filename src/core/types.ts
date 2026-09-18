import { TransformSpec } from './transforms/types';

export type LlmProvider = 'azure-openai' | 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'copilot' | 'claude';
export type DataPlatformProvider = 'snowflake' | 'databricks' | 'bigquery' | 'redshift' | 'synapse' | 'other';
export type SnowflakeAuthMode = 'username-password' | 'oauth' | 'key-pair' | 'external-browser' | 'mcp';
export type AgentType = 'ingestionAgent' | 'sttmAgent' | 'architectureAgent' | 'snowflakeExecutor' | 'sourceAssessmentAgent' | 'dataModelerAgent' | 'transformScaffoldAgent' | 'toolSkillAgent';
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
// spec/plan/context/artifacts subtree under `.ai-context/problems/<id>/`.
// See requirements.md §8.11.

/** Identifies which business problem is currently active — `.ai-context/active-problem.json`. */
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
  status: ContextStatus;
  platform?: DataPlatformProvider;
  environmentProfile?: EnvironmentProfile;
  modelingApproach?: ModelingApproach;
  namingConvention?: NamingConvention;
  transformationTool?: TransformationTool;
  orchestrationTool?: OrchestrationTool;
  outputFormats?: OutputFormat[];
  platformConfig?: Record<string, string>;
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
export interface SourceContext {
  specId: string;
  specVersion: number;
  status: ContextStatus;
  method?: 'connected' | 'described';
  sourceType?: 'database' | 'api' | 'file' | 'stream' | 'saas' | 'other';
  description?: string;
  connectionSummary?: {
    platform: string;
    database: string;
    schema: string;
    tableCount: number;
    viewCount: number;
  };
  answers: Record<string, string>;
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
  generatedBy: AgentType;
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

/** One persisted line of a chat session's transcript (`.ai-context/chats/<id>.jsonl`). */
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
 * `.ai-context/plan/plan.yaml`, with every prior version archived to `plan/history/`
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
  /** Only populated for `toolSkillAgent` — the workspace root, for sandboxing tool execution. */
  workspaceRoot?: string;
  /**
   * Only populated for `toolSkillAgent` — the real `vscode.ExtensionContext`, needed for
   * `vscode.lm` access-information checks. Left untyped here so this pure type file keeps
   * its no-`vscode`-import rule; the executor that reads it casts back to the real type.
   * This is the one sub-agent that breaks the "agents import only core/types" convention,
   * because it does real tool execution (file I/O, process spawn, approval dialogs) rather
   * than deterministic templating — see `src/agents/build/ToolSkillAgent.ts`.
   */
  extensionContext?: unknown;
  /** Which skill to run + the user's instruction — populated by the caller (plan step or chat). */
  skillId?: string;
  skillInstruction?: string;
  /**
   * Lets a caller (a future spec/UI authoring flow) supply a transform
   * primitive spec directly, bypassing the LLM's own primitive-selection
   * step entirely (Phase 2, see core/transforms/). When set, a codegen
   * agent's "try primitive first" branch compiles this instead of asking
   * the LLM to choose one.
   */
  transformSpec?: TransformSpec;
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