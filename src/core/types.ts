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

export interface PhaseProgress {
  status: 'not-started' | 'in-progress' | 'completed';
  completedSteps: number;
  totalSteps: number;
  artifactCount: number;
  startedAt?: string;
  completedAt?: string;
}

export interface ProjectMetadata {
  id: string;
  name: string;
  objective: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'completed' | 'archived';
  currentPhase: WorkflowPhase;
  sourceProvider: DataPlatformProvider;
  targetEnvironment?: TargetEnvironment;
  phaseProgress: Record<WorkflowPhase, PhaseProgress>;
}

export interface WorkflowState {
  projectId: string;
  currentPhase: WorkflowPhase;
  phases: Record<WorkflowPhase, {
    status: 'not-started' | 'in-progress' | 'completed';
    completedSteps: number;
    totalSteps: number;
    artifactCount: number;
    artifacts: Array<{
      id: string;
      type: string;
      title: string;
      filePath: string;
    }>;
  }>;
}

export interface ProjectRegistry {
  activeProjectId: string | null;
  projects: ProjectMetadata[];
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
  projectId?: string;
  currentPhase?: WorkflowPhase;
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
  projectId?: string;
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