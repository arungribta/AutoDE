export type LlmProvider = 'azure-openai' | 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'copilot';
export type DataPlatformProvider = 'snowflake' | 'databricks' | 'bigquery' | 'redshift' | 'synapse' | 'other';
export type SnowflakeAuthMode = 'username-password' | 'oauth' | 'key-pair' | 'external-browser' | 'mcp';
export type AgentType = 'ingestionAgent' | 'sttmAgent' | 'architectureAgent' | 'snowflakeExecutor' | 'sourceAssessmentAgent' | 'dataModelerAgent' | 'transformScaffoldAgent';
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

/** Live status of an inferred workflow phase. `unrequired` means the approved BPS does not include this phase. */
export type PhaseStatus = 'pending' | 'in-progress' | 'completed' | 'blocked' | 'unrequired';

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

/** Links a spec field to the question/skill/assumption that produced it. */
export interface SpecProvenance {
  /** Dotted path, e.g. 'dataFlows' or 'objectives.0'. */
  field: string;
  source: 'user' | 'question' | 'assumption' | 'synthesis' | 'skill';
  questionId?: string;
  skill?: string;
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