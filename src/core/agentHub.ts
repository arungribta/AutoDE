import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { ConfigurationManager } from './configManager';
import { executeIngestionAgent } from '../agents/build/IngestionPipelineAgent';
import { executeSttmAgent } from '../agents/model/SttmMapperAgent';
import { executeArchitectureAgent } from '../agents/validate/DocumentationAgent';
import { executeSnowflakeAgent } from '../spokes/snowflakeExecutor';
import { executeSourceAssessmentAgent } from '../agents/discover/SourceAssessmentAgent';
import { executeDataModelerAgent } from '../agents/model/DataModelerAgent';
import { executeTransformScaffoldAgent } from '../agents/build/TransformationScaffolderAgent';
import { executeToolSkillAgent } from '../agents/build/ToolSkillAgent';
import { ArtifactWriter } from '../context/ArtifactWriter';
import { PlanManager } from '../context/PlanManager';
import { inferPhases, computePhaseStatuses, buildPhaseDependencies, PHASE_ORDER } from './phaseInference';
import { SpecOpsEngine } from './specOps';
import { buildDiscoveryTurnPrompt, buildSynthesisPrompt } from './specOpsPrompts';
import { parseComprehensiveSpec } from './specSynthesis';
import { LlmAdapterContext, LlmHistoryTurn, extractJsonText } from './llmAdapter';
import { getLlmAdapter } from './llmProviders';
import { contextWindowForModel, windowHistoryToBudget, RESERVED_PROMPT_TOKENS, RESERVED_RESPONSE_TOKENS } from './tokenBudget';
import {
  AgentExecutionContext,
  AgentType,
  BusinessProblemSpec,
  ChatMessage,
  ImplementationType,
  InferredPhase,
  IntakeSession,
  PersistedPlan,
  PlanState,
  PlanStep,
  PlanStatus,
  SessionStatus,
  SkillDefinition,
  SpecEngineAction,
  TargetEnvironment,
  GeneratedArtifact,
  ToolExecutionMode,
  WorkflowPhase
} from './types';

// NOTE: 'toolSkillAgent' is deliberately NOT in this allow-list. The auto-planner
// LLM has no visibility into which skills are imported and could hallucinate a
// skillId; tool-executing skill runs are only reachable via an explicit "Run
// Skill" action that builds the PlanStep itself with a real skillId — never
// auto-assigned by generatePlan(). It's still a full AGENT_EXECUTORS entry so
// that explicit path can execute it like any other step.
const VALID_AGENT_TYPES: AgentType[] = ['ingestionAgent', 'sttmAgent', 'architectureAgent', 'snowflakeExecutor', 'sourceAssessmentAgent', 'dataModelerAgent', 'transformScaffoldAgent'];

const AGENT_EXECUTORS: Record<AgentType, (step: PlanStep, context: AgentExecutionContext) => Promise<{ success: boolean; message: string; details?: Record<string, unknown>; error?: string; artifacts?: GeneratedArtifact[] }>> = {
  ingestionAgent: executeIngestionAgent,
  sttmAgent: executeSttmAgent,
  architectureAgent: executeArchitectureAgent,
  snowflakeExecutor: executeSnowflakeAgent,
  sourceAssessmentAgent: executeSourceAssessmentAgent,
  dataModelerAgent: executeDataModelerAgent,
  transformScaffoldAgent: executeTransformScaffoldAgent,
  toolSkillAgent: executeToolSkillAgent
};

// Agent-to-phase mapping
const AGENT_PHASE: Partial<Record<AgentType, WorkflowPhase>> = {
  sourceAssessmentAgent: 'discover',
  sttmAgent: 'model',
  dataModelerAgent: 'model',
  ingestionAgent: 'build',
  transformScaffoldAgent: 'build',
  architectureAgent: 'validate',
  snowflakeExecutor: 'build',
  toolSkillAgent: 'build'
};

export class DataAgentHubHub {
  private readonly state: PlanState = {
    objective: '',
    schemaContext: '',
    sourceProvider: 'snowflake',
    steps: [],
    mode: 'plan',
    status: 'idle',
    artifacts: []
  };

  private executionPaused = false;
  private stateListener?: (state: PlanState) => void;
  private logListener?: (message: string) => void;
  private artifactWriter?: ArtifactWriter;
  private planManager?: PlanManager;
  /** Stable across re-plans of the same lineage; reset whenever `resetPlan()` runs. */
  private planLineageId?: string;
  /** Set by `handleFailure` immediately before its internal re-plan call; read once and reset by `generatePlan`. */
  private nextPlanGenerationReason: 'initial' | 're-plan' = 'initial';

  public constructor(private readonly configManager: ConfigurationManager) {}

  public setStateListener(listener: (state: PlanState) => void): void {
    this.stateListener = listener;
  }

  public setLogListener(listener: (message: string) => void): void {
    this.logListener = listener;
  }

  public setArtifactWriter(writer: ArtifactWriter): void {
    this.artifactWriter = writer;
  }

  public setPlanManager(manager: PlanManager): void {
    this.planManager = manager;
  }

  /**
   * Pushes whether Source/Target Context currently satisfy `generatePlanFromSpec`'s
   * precondition (v0.13.0) — the orchestrator's own copy of `computeContextGateStatus()`,
   * which lives in `webviewProvider` because it needs `SpecManager`/`TargetContextManager`/
   * `SourceContextManager` the hub doesn't hold. Called every time that status is
   * recomputed so `generatePlan()` can enforce the same precondition regardless of which
   * entry point calls it, not just the ones that remember to check first.
   */
  public setContextGateReady(ready: boolean): void {
    this.state.contextGateReady = ready;
  }

  /** Hydrates in-memory state from a previously persisted plan — called once at startup so a plan survives a reload. */
  public loadPersistedPlan(persisted: PersistedPlan): void {
    this.planLineageId = persisted.id;
    this.state.objective = persisted.objective;
    this.state.schemaContext = persisted.schemaContext;
    this.state.steps = persisted.steps.map((step) => ({ ...step }));
    this.state.status = persisted.status;
    this.state.inferredPhases = persisted.inferredPhases
      ? persisted.inferredPhases.map((phase) => ({ ...phase, dependsOn: [...phase.dependsOn] }))
      : undefined;
    this.state.targetEnvironment = persisted.targetEnvironment;
    this.state.specId = persisted.specId;
    this.state.specVersion = persisted.specVersion;
    this.state.implementationType = persisted.implementationType;
    this.state.planApproved = persisted.planApproved ?? false;
    this.state.planApprovedAt = persisted.planApprovedAt;
    this.state.stagesConfirmed = persisted.stagesConfirmed ?? false;
    this.state.stagesConfirmedAt = persisted.stagesConfirmedAt;
    this.state.phaseOverrides = persisted.phaseOverrides ? { ...persisted.phaseOverrides } : undefined;
    this.state.currentPhase = PHASE_ORDER.find((phase) => persisted.steps.some((step) => step.phase === phase));
    this.log(`Restored plan v${persisted.version} (${persisted.status}, ${persisted.steps.length} steps) from .ai-context/plan/.`);
    this.emitState();
  }

  /** Persists the current plan state as the next version. Failures are logged, not thrown — persistence is best-effort and must never block plan generation. */
  private async persistPlan(reason: 'initial' | 're-plan'): Promise<void> {
    if (!this.planManager) return;
    if (!this.planLineageId) {
      this.planLineageId = `plan-${Date.now().toString(36)}`;
    }
    try {
      await this.planManager.savePlan({
        id: this.planLineageId,
        specId: this.state.specId,
        specVersion: this.state.specVersion,
        implementationType: this.state.implementationType,
        objective: this.state.objective,
        schemaContext: this.state.schemaContext,
        status: this.state.status,
        steps: this.state.steps.map((step) => ({ ...step })),
        inferredPhases: this.state.inferredPhases
          ? this.state.inferredPhases.map((phase) => ({ ...phase, dependsOn: [...phase.dependsOn] }))
          : undefined,
        targetEnvironment: this.state.targetEnvironment,
        phaseOverrides: this.state.phaseOverrides ? { ...this.state.phaseOverrides } : undefined,
        generationReason: reason,
        planApproved: this.state.planApproved ?? false,
        planApprovedAt: this.state.planApprovedAt,
        stagesConfirmed: this.state.stagesConfirmed ?? false,
        stagesConfirmedAt: this.state.stagesConfirmedAt
      });
    } catch (err) {
      this.log(`Failed to persist plan: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  public setSpec(specId: string, specVersion: number): void {
    this.state.specId = specId;
    this.state.specVersion = specVersion;
    this.emitState();
  }

  public getPlan(): PlanState {
    return {
      ...this.state,
      steps: this.state.steps.map((step) => ({ ...step })),
      artifacts: this.state.artifacts ? [...this.state.artifacts] : undefined,
      inferredPhases: this.state.inferredPhases
        ? this.state.inferredPhases.map((phase) => ({ ...phase, dependsOn: [...(phase.dependsOn ?? [])] }))
        : undefined
    };
  }

  // ── Business Problem Specification ──

  /**
   * System instruction used to turn a natural-language business problem into a
   * structured Business Problem Specification (the repository's system of record).
   */
  private static readonly SPEC_SYSTEM_PROMPT = [
    'You are a senior data engineering business analyst.',
    'Transform the user\u2019s natural-language business problem into a structured Business Problem Specification.',
    'Respond with a single valid JSON object only \u2014 no prose and no markdown fences.',
    'Use exactly this shape:',
    '{',
    '  "problemStatement": "2-4 sentences, focused on the business outcome",',
    '  "objectives": ["measurable outcome the solution must achieve"],',
    '  "successCriteria": ["how success will be verified"],',
    '  "scope": { "in": ["included"], "out": ["explicitly excluded"] },',
    '  "constraints": ["technical, regulatory or organisational limits"],',
    '  "assumptions": ["anything inferred that the user must confirm"],',
    '  "domain": "business domain, e.g. finance, supply-chain, marketing",',
    '  "stakeholders": ["role or team"],',
    '  "keyEntities": ["business or data entities implied by the problem"]',
    '}',
    'Rules:',
    '- Derive content only from what the user supplied; never invent systems, tables, vendors or metrics.',
    '- If information is missing, record it as an explicit assumption instead of guessing.',
    '- "problemStatement", "objectives", "successCriteria" and "scope.in" must be non-empty.',
    '- When an existing specification is provided, revise it: keep valid content and apply the requested change.'
  ].join('\n');

  private static readonly CHAT_SYSTEM_PROMPT_BASE = [
    'You are AutoDE, an expert data engineering assistant running inside VS Code.',
    'You help users with pipeline design, SQL authoring, schema analysis, data modelling, ETL/ELT workflows and data platform operations.',
    'Answer the user\u2019s question concisely and practically, using concise markdown.',
    'Ground every answer in the supplied repository context and Business Problem Specification.',
    'If the context is insufficient, say so and state exactly what you need.',
    'Never fabricate table names, columns, metrics or systems.',
    'If the user asks for an execution plan, suggest the /plan command or the Generate Plan action.',
    'Do not wrap the whole answer in a code fence.'
  ].join('\n');

  /**
   * Builds the chat system prompt with an accurate, mode-specific statement of what
   * tools this exact call actually has. Without this, the model has nothing to check
   * a meta-question like "do you have file editing permissions?" against and can
   * confidently answer wrong \u2014 every provider's real grant for chat is `mode`, no more.
   */
  private static buildChatSystemPrompt(mode: ToolExecutionMode): string {
    const capability =
      mode === 'full'
        ? 'You have file read, directory listing, text search, file write, and command-execution tools for this workspace, scoped to this folder. Every write or command requires the user\u2019s explicit approval before it runs \u2014 tell them what you\u2019re about to do and why.'
        : mode === 'read-only'
        ? 'You have read-only tools for this workspace: file read, directory listing, and text search. You cannot write files or run commands from this chat \u2014 say so plainly if asked, and suggest the user enable "Allow edits" if they want you to make changes.'
        : 'You have no file access in this chat \u2014 you can only see what\u2019s pasted into the conversation or the context block above. If asked whether you can read or edit files, say no.';
    return `${DataAgentHubHub.CHAT_SYSTEM_PROMPT_BASE}\n${capability}`;
  }

  /**
   * Generates (or regenerates) the Business Problem Specification from natural language.
   *
   * Versioning semantics:
   * - no previous spec           -> new id, version 1, status draft
   * - previous spec is a draft   -> same id and version, status draft (in-place revision)
   * - previous spec was approved -> same id, version + 1, status draft (new revision)
   */
  public async generateSpec(userInput: string, previous?: BusinessProblemSpec): Promise<BusinessProblemSpec> {
    const trimmed = (userInput ?? '').trim();
    if (!trimmed) {
      throw new Error('A description of the business problem is required to generate a specification.');
    }

    const previousBlock = previous
      ? `\n\n## Existing specification (revise it; do not discard content that is still valid)\n${JSON.stringify(this.specToJson(previous), null, 2)}`
      : '';

    const prompt = `## Business problem (from the user)\n${trimmed}${previousBlock}\n\nReturn the Business Problem Specification JSON object now.`;

    this.log(previous ? 'Regenerating the Business Problem Specification\u2026' : 'Drafting the Business Problem Specification\u2026');
    const raw = await this.callConfiguredLlm(
      prompt,
      DataAgentHubHub.SPEC_SYSTEM_PROMPT,
      'Draft the Business Problem Specification that governs the Auto Data Engineering Hub workflow.'
    );

    const spec = this.parseSpecResponse(raw, previous);
    this.state.specId = spec.id;
    this.state.specVersion = spec.version;
    this.state.objective = spec.problemStatement;
    this.log(`Business Problem Specification ${spec.id} v${spec.version} drafted (${spec.objectives.length} objective(s)).`);
    this.emitState();
    return spec;
  }

  /**
   * Runs one turn of the agentic requirements-discovery loop: builds the
   * discovery prompt from the current intake session + skills, asks the
   * configured LLM for its next action, and validates the result.
   */
  public async discoverNextAction(session: IntakeSession, skills: SkillDefinition[], extraContext?: string): Promise<SpecEngineAction> {
    const { system, user } = buildDiscoveryTurnPrompt(session, skills, extraContext);
    const raw = await this.callConfiguredLlm(
      user,
      system,
      'Decide the next step in the data engineering requirements-discovery conversation.'
    );
    const parsed = this.parseJsonObject(extractJsonText(raw));
    return SpecOpsEngine.validateAction(parsed);
  }

  /**
   * Synthesizes the comprehensive (v2) Business Problem Specification from the
   * collected intake session, including data flows, transformations, dependencies,
   * acceptance criteria, and implementation considerations.
   */
  public async synthesizeComprehensiveSpec(session: IntakeSession, previous?: BusinessProblemSpec, extraContext?: string): Promise<BusinessProblemSpec> {
    const { system, user } = buildSynthesisPrompt(session, extraContext);
    const raw = await this.callConfiguredLlm(
      user,
      system,
      'Synthesize the comprehensive Business Problem Specification from the collected requirements.'
    );
    return parseComprehensiveSpec(this.parseJsonObject(extractJsonText(raw)), { previous, session });
  }

  /** Renders a specification as the objective text used for plan generation. */
  public buildObjectiveFromSpec(spec: BusinessProblemSpec): string {
    const lines: string[] = [spec.problemStatement];
    if (spec.objectives.length > 0) { lines.push(`Objectives: ${spec.objectives.join('; ')}`); }
    if (spec.successCriteria.length > 0) { lines.push(`Success criteria: ${spec.successCriteria.join('; ')}`); }
    if (spec.scope.in.length > 0) { lines.push(`In scope: ${spec.scope.in.join('; ')}`); }
    if (spec.scope.out.length > 0) { lines.push(`Out of scope: ${spec.scope.out.join('; ')}`); }
    if (spec.constraints.length > 0) { lines.push(`Constraints: ${spec.constraints.join('; ')}`); }
    if (spec.assumptions.length > 0) { lines.push(`Assumptions: ${spec.assumptions.join('; ')}`); }
    if (spec.domain) { lines.push(`Domain: ${spec.domain}`); }
    if (spec.keyEntities && spec.keyEntities.length > 0) { lines.push(`Key entities: ${spec.keyEntities.join(', ')}`); }
    return lines.join('\n');
  }

  /**
   * Infers the required workflow phases (discover/model/build/validate) and their
   * dependencies from the approved Business Problem Specification. This is
   * deterministic — no LLM call — so the palette can show a live status view
   * immediately after approval.
   */
  public inferPhasesFromSpec(spec: BusinessProblemSpec, contextSummary?: string): InferredPhase[] {
    this.state.implementationType = spec.implementationType;
    this.state.inferredPhases = inferPhases(spec, spec.implementationType, contextSummary);
    this.applyPhaseOverrides();
    // A changed phase set invalidates any prior "Confirm Applicable Stages" gate (§11.4/§8.12).
    this.state.stagesConfirmed = false;
    this.state.stagesConfirmedAt = undefined;
    const required = this.state.inferredPhases.filter((phase) => phase.required).map((phase) => phase.phase);
    this.log(`Inferred workflow phases from specification (${spec.implementationType ?? 'unclassified'}): ${required.join(', ')}`);
    this.emitState();
    return this.getInferredPhases();
  }

  /**
   * Sets (or clears, when `required` matches the deterministic inference again)
   * an explicit user override for one phase's applicability, then re-derives
   * dependency chains and statuses. Does not touch an already-generated plan's
   * steps — `getPlan()`/the palette surface whether the current plan still
   * matches the (possibly now-overridden) required-phase set, so the user can
   * decide whether to Re-plan.
   */
  public setPhaseOverride(phase: WorkflowPhase, required: boolean): InferredPhase[] {
    this.state.phaseOverrides = this.state.phaseOverrides ?? {};
    this.state.phaseOverrides[phase] = required;
    this.applyPhaseOverrides();
    // A changed phase set invalidates any prior "Confirm Applicable Stages" gate (§11.4/§8.12).
    this.state.stagesConfirmed = false;
    this.state.stagesConfirmedAt = undefined;
    this.log(`Phase "${phase}" manually marked ${required ? 'Applicable' : 'Non-Applicable'}.`);
    this.emitState();
    void this.persistInferredPhasesOnly();
    void this.planManager?.patchGates({ stagesConfirmed: false, stagesConfirmedAt: undefined });
    return this.getInferredPhases();
  }

  /** Re-applies `state.phaseOverrides` on top of whatever `inferPhases()` last computed, and recomputes dependency chains. */
  private applyPhaseOverrides(): void {
    if (!this.state.inferredPhases) return;
    const overrides = this.state.phaseOverrides;
    if (overrides && Object.keys(overrides).length > 0) {
      this.state.inferredPhases = this.state.inferredPhases.map((entry) => {
        const override = overrides[entry.phase];
        if (override === undefined || override === entry.required) return entry;
        return { ...entry, required: override, reason: 'Manually set by user.' };
      });
    }
    const requiredSet = this.state.inferredPhases.filter((p) => p.required).map((p) => p.phase);
    const dependencies = buildPhaseDependencies(requiredSet);
    this.state.inferredPhases = this.state.inferredPhases.map((entry) => ({ ...entry, dependsOn: dependencies[entry.phase] }));
  }

  /** Persists just the phase metadata onto the current plan version, without bumping it — an override is a correction, not a new generation. Best-effort; a plan may not exist yet. */
  private async persistInferredPhasesOnly(): Promise<void> {
    if (!this.planManager || !this.state.inferredPhases) return;
    try {
      await this.planManager.patchInferredPhases(this.state.inferredPhases, this.state.phaseOverrides);
    } catch (err) {
      this.log(`Failed to persist phase override: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public getInferredPhases(): InferredPhase[] {
    return (this.state.inferredPhases ?? []).map((phase) => ({
      ...phase,
      dependsOn: [...(phase.dependsOn ?? [])]
    }));
  }

  /**
   * Runs one imported tool-executing skill directly (Phase D) — from chat
   * (`/skill <id> <instruction>`) or a dedicated "Run Skill" UI action, never
   * from the auto-planner (see the note on `VALID_AGENT_TYPES`). Bypasses the
   * DAG: this is a single, immediate step, not a queued plan step.
   */
  public async runToolSkill(skillId: string, instruction: string): Promise<{ success: boolean; message: string; error?: string }> {
    const step: PlanStep = {
      id: `skill-${Date.now().toString(36)}`,
      assignedAgent: 'toolSkillAgent',
      taskDescription: instruction,
      status: 'running',
      skillId
    };
    const context: AgentExecutionContext = {
      objective: this.state.objective,
      schemaContext: this.state.schemaContext,
      sourceProvider: this.state.sourceProvider,
      targetEnvironment: this.state.targetEnvironment,
      settings: this.configManager.getSettings(),
      configManager: {
        getSecret: async (secretKey: string) => this.configManager.getSecret(secretKey),
        getSettings: () => this.configManager.getSettings()
      },
      log: (message: string) => this.log(message),
      addArtifact: (artifact: GeneratedArtifact) => {
        if (!this.state.artifacts) this.state.artifacts = [];
        artifact.phase = 'build';
        this.state.artifacts.push(artifact);
        this.log(`Artifact generated: ${artifact.title} (${artifact.type})`);
      },
      currentPhase: 'build',
      workspaceRoot: this.getWorkspaceRoot(),
      extensionContext: this.configManager.getExtensionContext(),
      skillId,
      skillInstruction: instruction
    };
    const result = await AGENT_EXECUTORS.toolSkillAgent(step, context);
    return { success: result.success, message: result.message, error: result.error };
  }

  /**
   * Generates the execution plan from a specification (spec-driven planning) —
   * the orchestrator's one legitimate entry point into plan generation (v0.13.0,
   * requirements.md §8.12). Re-checks the lifecycle gate itself rather than
   * trusting the caller: `webviewProvider` already checks spec/context status
   * before calling this, but that's a UX nicety (a clear error before an LLM
   * call starts), not the enforcement boundary — this is.
   */
  public async generatePlanFromSpec(spec: BusinessProblemSpec, contextSummary?: string): Promise<void> {
    if (spec.status !== 'approved') {
      throw new Error('Approve the Business Problem Specification before generating the workflow plan.');
    }
    if (!spec.problemStatementApproved) {
      throw new Error('Confirm the inferred business problem before generating the workflow plan.');
    }
    if (!this.state.contextGateReady) {
      throw new Error('Generate Plan is blocked until Source/Target Context are built and approved.');
    }
    // Set status BEFORE inferPhasesFromSpec runs — it emits its own stateUpdate
    // internally, and if `state.status` is still whatever a *previous* plan
    // left it as (e.g. a stale 'ready'), the client's pending-bubble-ending
    // check ("status === 'ready'") fires immediately on that intermediate
    // broadcast, well before the actual plan LLM call even starts, making the
    // UI look done seconds before it actually is.
    this.state.status = 'planning';
    this.state.specId = spec.id;
    this.state.specVersion = spec.version;
    this.inferPhasesFromSpec(spec, contextSummary);
    const schemaContext = [contextSummary, this.state.schemaContext]
      .filter((part) => part && part.trim().length > 0)
      .join('\n\n');
    await this.generatePlanInternal(this.buildObjectiveFromSpec(spec), schemaContext);
  }

  private specToJson(spec: BusinessProblemSpec): Record<string, unknown> {
    return {
      problemStatement: spec.problemStatement,
      objectives: spec.objectives,
      successCriteria: spec.successCriteria,
      scope: spec.scope,
      constraints: spec.constraints,
      assumptions: spec.assumptions,
      domain: spec.domain,
      stakeholders: spec.stakeholders,
      keyEntities: spec.keyEntities
    };
  }

  private parseSpecResponse(raw: string, previous?: BusinessProblemSpec): BusinessProblemSpec {
    const parsed = this.parseJsonObject(extractJsonText(raw));
    const now = new Date().toISOString();

    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
    const arr = (value: unknown): string[] => {
      if (!Array.isArray(value)) { return []; }
      return value
        .map((item) => {
          if (typeof item === 'string') { return item.trim(); }
          const record = item as Record<string, unknown> | null;
          return str(record?.name ?? record?.text ?? record?.value);
        })
        .filter((item) => item.length > 0);
    };

    const problemStatement = str(parsed.problemStatement);
    if (!problemStatement) { throw new Error('The LLM did not return a problemStatement for the specification.'); }

    const objectives = arr(parsed.objectives);
    if (objectives.length === 0) { throw new Error('The LLM did not return any objectives for the specification.'); }

    const rawScope = (parsed.scope && typeof parsed.scope === 'object' ? parsed.scope : {}) as Record<string, unknown>;
    const scopeIn = arr(rawScope.in ?? rawScope.inScope);
    if (scopeIn.length === 0) { throw new Error('The LLM did not return any in-scope items for the specification.'); }

    const isRevisionOfApproved = previous?.status === 'approved';

    return {
      id: previous?.id ?? `bps-${Date.now().toString(36)}`,
      version: isRevisionOfApproved ? (previous?.version ?? 1) + 1 : (previous?.version ?? 1),
      status: 'draft',
      problemStatement,
      objectives,
      successCriteria: arr(parsed.successCriteria),
      scope: { in: scopeIn, out: arr(rawScope.out ?? rawScope.outOfScope) },
      constraints: arr(parsed.constraints),
      assumptions: arr(parsed.assumptions),
      domain: str(parsed.domain) || previous?.domain || undefined,
      stakeholders: arr(parsed.stakeholders),
      keyEntities: arr(parsed.keyEntities),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    };
  }

  // ── Target Environment Management ──

  public setTargetEnvironment(env: TargetEnvironment): void {
    this.state.targetEnvironment = env;
    this.log(`Target environment set: ${env.platform} (${env.environmentProfile}) — ${env.modelingApproach} via ${env.transformationTool}`);
    this.emitState();
  }

  public getTargetEnvironment(): TargetEnvironment | undefined {
    return this.state.targetEnvironment;
  }

  private async extractTargetFromMessage(message: string): Promise<Partial<TargetEnvironment>> {
    const prompt = `Extract the target data platform and toolchain from this message.
Return ONLY valid JSON with these fields (omit unknown fields, use null for unknown):
{
  "platform": "snowflake" | "databricks" | "bigquery" | "redshift" | "synapse" | null,
  "database": "string or null",
  "schema": "string or null",
  "transformationTool": "dbt" | "sqlmesh" | "custom-sql" | "stored-procedures" | "none" | null,
  "orchestrationTool": "airflow" | "dagster" | "prefect" | "dbt-cloud" | "manual" | "none" | null,
  "modelingApproach": "dimensional" | "data-vault" | "obt" | "3nf" | "raw-pass-through" | null,
  "namingConvention": "snake_case" | "camelCase" | "PascalCase" | null
}

Message: ${message}`;

    try {
      const response = await this.callConfiguredLlm(prompt, DataAgentHubHub.EXTRACTOR_SYSTEM_PROMPT);
      const parsed = this.parseJsonObject(extractJsonText(response));
      return parsed as Partial<TargetEnvironment>;
    } catch {
      this.log('Could not extract target environment from message. User will be prompted for details.');
      return {};
    }
  }

  private buildTargetFromPartial(partial: Partial<TargetEnvironment>, settings: ReturnType<ConfigurationManager['getSettings']>): TargetEnvironment {
    const platform = partial.platform ?? settings.defaultProvider ?? 'snowflake';

    let platformConfig: TargetEnvironment['platformConfig'];
    switch (platform) {
      case 'snowflake':
        platformConfig = {
          account: settings.defaultSnowflakeAccount || '',
          database: (partial as Record<string, unknown>)['database'] as string || settings.defaultSnowflakeDatabase || 'CURATED_DB',
          schema: (partial as Record<string, unknown>)['schema'] as string || settings.defaultSnowflakeSchema || 'ANALYTICS',
          warehouse: settings.defaultSnowflakeWarehouse || 'WH_XS',
          role: settings.defaultSnowflakeRole || 'SYSADMIN'
        };
        break;
      case 'databricks':
        platformConfig = {
          workspaceUrl: '',
          catalog: (partial as Record<string, unknown>)['database'] as string || 'main',
          schema: (partial as Record<string, unknown>)['schema'] as string || 'default'
        };
        break;
      case 'bigquery':
        platformConfig = {
          projectId: '',
          dataset: (partial as Record<string, unknown>)['database'] as string || 'analytics',
          region: 'us-central1'
        };
        break;
      default:
        platformConfig = {
          account: '',
          database: (partial as Record<string, unknown>)['database'] as string || 'CURATED_DB',
          schema: (partial as Record<string, unknown>)['schema'] as string || 'ANALYTICS',
          warehouse: '',
          role: ''
        };
    }

    return {
      platform,
      environmentProfile: 'development',
      modelingApproach: partial.modelingApproach ?? 'dimensional',
      namingConvention: partial.namingConvention ?? 'snake_case',
      transformationTool: partial.transformationTool ?? 'dbt',
      orchestrationTool: partial.orchestrationTool ?? 'airflow',
      outputFormats: ['ddl', 'yaml', 'markdown'],
      platformConfig
    };
  }

  // ── Chat ──

  /**
   * `history`/`priorSummary`/`claudeSessionId` describe conversation state the caller
   * (`WebviewProvider`, backed by `ChatSessionManager`) already persisted — `chat()` owns
   * turning that into an actual grounded, memory-carrying request, but not persisting it;
   * the caller writes back `updatedSummary`/`newClaudeSessionId` from the result.
   */
  public async chat(
    message: string,
    schemaContext?: string,
    toolExecutionMode: ToolExecutionMode = 'read-only',
    opts?: { history?: ChatMessage[]; priorSummary?: string; claudeSessionId?: string }
  ): Promise<{ message: string; updatedSummary?: string; newClaudeSessionId?: string }> {
    const trimmed = message.trim();
    if (!trimmed) {
      throw new Error('A message is required.');
    }

    const settings = this.configManager.getSettings();
    const provider = settings.activeLlmProvider ?? 'copilot';
    this.log(`Sending chat to ${provider}...`);

    if (!this.state.targetEnvironment) {
      const partial = await this.extractTargetFromMessage(trimmed);
      const hasKeyFields = partial.platform || partial.transformationTool || partial.modelingApproach;
      if (hasKeyFields) {
        const target = this.buildTargetFromPartial(partial, settings);
        this.setTargetEnvironment(target);
      }
    }

    const contextBlock = this.buildChatContextBlock(schemaContext);

    // Claude with an already-resumable session (Phase 4): the CLI's own server-side session
    // already carries prior turns — skip windowing/summarizing text history for this call
    // entirely, it would just be redundant tokens. Every other provider (and Claude's own
    // first message in a chat) falls through to structured history + rolling summarization.
    const resumingClaude = provider === 'claude' && !!opts?.claudeSessionId;
    const startingClaudeSession = provider === 'claude' && !opts?.claudeSessionId;
    const claudeSessionId = resumingClaude ? opts!.claudeSessionId : (startingClaudeSession ? randomUUID() : undefined);

    let historyTurns: LlmHistoryTurn[] | undefined;
    let summaryForPrompt = opts?.priorSummary;
    let updatedSummary: string | undefined;

    if (!resumingClaude) {
      const rawHistory = (opts?.history ?? []).filter((m) => m.role === 'user' || m.role === 'ai');
      const budget = Math.max(contextWindowForModel(settings.activeLlmModel) - RESERVED_PROMPT_TOKENS - RESERVED_RESPONSE_TOKENS, 0);
      const { kept, dropped } = windowHistoryToBudget(rawHistory, budget);
      historyTurns = kept.map((m): LlmHistoryTurn => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
      if (dropped.length > 0) {
        updatedSummary = await this.summarizeDroppedTurns(dropped, opts?.priorSummary);
        summaryForPrompt = updatedSummary;
      }
    }

    const summaryBlock = summaryForPrompt && summaryForPrompt.trim().length > 0
      ? `## Earlier in this conversation (summarized)\n${summaryForPrompt.trim()}`
      : '';
    const sections = [contextBlock.trim(), summaryBlock].filter((s) => s.length > 0);
    const prompt = `${sections.length > 0 ? sections.join('\n\n') + '\n\n' : ''}## User message\n${trimmed}\n\nRespond now.`;

    try {
      const rawResponse = await this.callConfiguredLlm(
        prompt,
        DataAgentHubHub.buildChatSystemPrompt(toolExecutionMode),
        'Answer a data engineering question in the Auto Data Engineering Hub sidebar chat.',
        // Grounded chat: every provider that supports tool execution gets the
        // same read (default) / write (opt-in, approved) grant. See core/agenticTools.ts.
        {
          toolExecutionMode,
          history: resumingClaude ? undefined : historyTurns,
          claudeSessionId,
          isNewClaudeSession: startingClaudeSession
        }
      );
      return {
        message: rawResponse,
        updatedSummary,
        newClaudeSessionId: startingClaudeSession ? claudeSessionId : undefined
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error during chat.';
      this.log(`Chat failed: ${message}`);
      throw new Error(message);
    }
  }

  /**
   * Folds turns that fell outside the token-budget window (Phase 2) into a running,
   * compact summary instead of just discarding them — same spirit as the
   * `answers[]`/`insights[]` pattern `IntakeSession` already uses for the
   * spec-discovery interview. Best-effort: a failure here degrades to keeping
   * the prior summary rather than breaking the chat turn itself.
   */
  private async summarizeDroppedTurns(dropped: ChatMessage[], priorSummary?: string): Promise<string> {
    const turnsText = dropped.map((m) => `${m.role === 'user' ? 'User' : 'AutoDE'}: ${m.content}`).join('\n');
    const prompt = priorSummary && priorSummary.trim().length > 0
      ? `## Existing summary\n${priorSummary.trim()}\n\n## New turns to fold in\n${turnsText}`
      : `## Turns to summarize\n${turnsText}`;
    try {
      const summary = await this.callConfiguredLlm(
        prompt,
        'You maintain a running summary of an ongoing chat conversation for later reference. Extend the existing summary (or write a fresh one, if there is none) to cover the new turns too, in plain prose, under 200 words total. Preserve concrete facts, decisions, file paths, and anything the user asked to be remembered. Respond with only the summary text, no preamble.',
        'Summarize older chat turns that fell outside the active context window.'
      );
      return summary.trim();
    } catch (err) {
      this.log(`Chat history summarization failed, keeping prior summary: ${err instanceof Error ? err.message : String(err)}`);
      return priorSummary ?? '';
    }
  }

  private buildChatContextBlock(schemaContext?: string): string {
    const parts: string[] = [];

    if (this.state.specId) {
      parts.push(
        `## Current Business Problem Specification (${this.state.specId} v${this.state.specVersion ?? 1})\n` +
        `${this.state.objective || '(no problem statement recorded)'}`
      );
    }

    if (schemaContext && schemaContext.trim().length > 0) {
      parts.push(`## Source Environment\n${schemaContext}`);
    }

    if (this.state.steps.length > 0) {
      const summary = this.state.steps
        .map((step) => `- [${step.status}] ${step.id} (${step.assignedAgent}${step.phase ? `, ${step.phase}` : ''}): ${step.taskDescription}`)
        .join('\n');
      parts.push(`## Current workflow plan\n${summary}`);
    }

    if (this.state.targetEnvironment) {
      const t = this.state.targetEnvironment;
      const pc = t.platformConfig as unknown as Record<string, string>;
      const db = pc['database'] || pc['catalog'] || pc['dataset'] || '';
      const schema = pc['schema'] || pc['dataset'] || '';
      parts.push(
        `## Target Environment\n` +
        `- Platform: ${t.platform} (${db}.${schema})\n` +
        `- Profile: ${t.environmentProfile}\n` +
        `- Modeling: ${t.modelingApproach}\n` +
        `- Transformation: ${t.transformationTool}\n` +
        `- Orchestration: ${t.orchestrationTool}\n` +
        `- Naming: ${t.namingConvention}\n` +
        `- Outputs: ${t.outputFormats.join(', ')}`
      );
    }

    return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
  }

  /**
   * Each `chat()` call is otherwise a fresh, memory-less LLM request (no
   * provider here keeps a server-side session) — this is what makes the
   * conversation actually a conversation instead of independent Q&A turns.
   * `history` is the persisted transcript up to (not including) the current
   * turn; capped to the most recent messages and per-message length so a long
   * conversation doesn't blow out the prompt budget on every turn.
   */
  // ── Plan Generation ──

  /**
   * The orchestrator's lifecycle guard on plan generation (v0.13.0, requirements.md
   * §8.12/§11). This used to be the sole `generatePlan` implementation, reachable
   * ungated from the Command Palette, the AutoDE Dashboard panel, the `/plan` slash
   * command with no approved spec, and the sidebar's re-plan buttons — none of which
   * ever checked whether a business problem had even been described, let alone
   * approved. `generatePlanFromSpec` (the sidebar's real, gated entry point) already
   * validates its own preconditions and calls `generatePlanInternal` directly,
   * bypassing this guard — it doesn't need to, since it enforces the same thing
   * itself before it ever gets here. Every other caller funnels through here, so
   * this one check is what actually closes the "seven ungated entry points"
   * finding: whichever button was clicked, the same rule applies.
   */
  public async generatePlan(objective: string, schemaContext?: string): Promise<PlanStep[]> {
    if (!this.state.specId || !this.state.contextGateReady) {
      throw new Error(
        'Generate Plan requires an approved Business Problem Specification with approved Source/Target Context. ' +
        'Describe your business problem in the AutoDE sidebar to start the guided workflow.'
      );
    }
    return this.generatePlanInternal(objective, schemaContext);
  }

  private async generatePlanInternal(objective: string, schemaContext?: string): Promise<PlanStep[]> {
    const trimmedObjective = objective.trim();
    if (!trimmedObjective) {
      throw new Error('A data engineering objective is required before generating a plan.');
    }

    const settings = this.configManager.getSettings();
    this.state.objective = trimmedObjective;
    this.state.schemaContext = schemaContext ?? '';
    this.state.sourceProvider = settings.defaultProvider ?? 'snowflake';
    this.state.mode = 'plan';
    this.state.status = 'planning';
    this.state.lastError = undefined;
    this.emitState();
    this.log(`Generating execution plan via configured LLM provider for ${this.state.sourceProvider}.`);

    if (!this.state.targetEnvironment) {
      this.log('Inferring target environment (platform, modeling approach, transformation tool) from the objective…');
      const partial = await this.extractTargetFromMessage(trimmedObjective);
      const hasKeyFields = partial.platform || partial.transformationTool || partial.modelingApproach;
      if (hasKeyFields) {
        const target = this.buildTargetFromPartial(partial, settings);
        this.setTargetEnvironment(target);
        this.log(`Target environment set: ${target.platform ?? 'unspecified platform'} / ${target.modelingApproach ?? 'unspecified modeling approach'}.`);
      }
    }

    try {
      const requiredPhases = (this.state.inferredPhases ?? [])
        .filter((phase) => phase.required)
        .map((phase) => phase.phase);
      this.log(`Assembling the planning prompt (phases: ${requiredPhases.join(', ') || 'all'})…`);
      const prompt = this.buildPlanPrompt(trimmedObjective, this.state.schemaContext, requiredPhases);
      this.log(`Calling ${settings.activeLlmProvider} to draft the execution plan…`);
      const rawResponse = await this.callConfiguredLlm(prompt);
      this.log('Validating the plan steps returned by the LLM…');
      const validatedPlan = this.validatePlanResponse(rawResponse, requiredPhases);
      for (const step of validatedPlan) {
        step.phase = AGENT_PHASE[step.assignedAgent] ?? 'discover';
      }
      this.state.steps = validatedPlan;
      this.state.currentPhase = PHASE_ORDER.find((phase) => validatedPlan.some((step) => step.phase === phase));
      this.state.status = 'ready';
      this.state.runningStepId = undefined;
      // A freshly generated plan needs its own Plan Approval + Stage Confirmation
      // (v0.13.0, requirements.md §8.12) — any prior gate state was for a different plan.
      this.state.planApproved = false;
      this.state.planApprovedAt = undefined;
      this.state.stagesConfirmed = false;
      this.state.stagesConfirmedAt = undefined;
      this.log(`Plan generated with ${validatedPlan.length} steps (phases: ${requiredPhases.join(', ') || 'all'}).`);
      const generationReason = this.nextPlanGenerationReason;
      this.nextPlanGenerationReason = 'initial';
      await this.persistPlan(generationReason);
      this.emitState();
      return this.state.steps.map((step) => ({ ...step }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error while generating plan.';
      this.state.status = 'failed';
      this.state.lastError = message;
      this.log(`Plan generation failed: ${message}`);
      this.emitState();
      throw new Error(message);
    }
  }

  /**
   * Explicit Plan Approval gate (v0.13.0, requirements.md §8.12) — mirrors
   * `SpecManager.approve()`/`TargetContextManager.approve()`: a distinct user action,
   * not a side effect of viewing the plan, required before `executePlan()` will run.
   */
  public approvePlan(): void {
    if (this.state.steps.length === 0) {
      throw new Error('There is no plan to approve yet.');
    }
    this.state.planApproved = true;
    this.state.planApprovedAt = new Date().toISOString();
    this.log('Plan approved.');
    this.emitState();
    void this.planManager?.patchGates({ planApproved: true, planApprovedAt: this.state.planApprovedAt });
  }

  /**
   * Explicit "confirm applicable stages" gate (v0.13.0, requirements.md §8.12) —
   * the discrete review checkpoint requested in place of always-editable phase
   * status alone. Required, alongside `approvePlan()`, before `executePlan()` will run.
   */
  public confirmStages(): void {
    if (!this.state.inferredPhases || this.state.inferredPhases.length === 0) {
      throw new Error('There are no inferred stages to confirm yet.');
    }
    this.state.stagesConfirmed = true;
    this.state.stagesConfirmedAt = new Date().toISOString();
    this.log('Applicable stages confirmed.');
    this.emitState();
    void this.planManager?.patchGates({ stagesConfirmed: true, stagesConfirmedAt: this.state.stagesConfirmedAt });
  }

  // ── Plan Execution ──

  public async executePlan(): Promise<void> {
    this.executionPaused = false;

    if (this.state.steps.length === 0) {
      const message = 'Generate a plan before attempting execution.';
      this.log(message);
      throw new Error(message);
    }
    // Plan Approval + Stage Confirmation gates (v0.13.0, requirements.md §8.12) — the
    // orchestrator's own enforcement point, not just a UI affordance. Both are reset
    // to false by generatePlanInternal/inferPhasesFromSpec/setPhaseOverride whenever
    // something changes that would make a prior approval/confirmation stale.
    if (!this.state.planApproved) {
      const message = 'Approve the plan before generating artifacts.';
      this.log(message);
      throw new Error(message);
    }
    if (!this.state.stagesConfirmed) {
      const message = 'Confirm the applicable stages before generating artifacts.';
      this.log(message);
      throw new Error(message);
    }

    this.state.mode = 'execute';
    this.state.status = 'running';
    this.emitState();

    const completedIds = new Set<string>();
    const failedIds = new Set<string>();
    let anyFailure = false;

    for (const step of this.state.steps) {
      step.status = 'pending';
    }

    while (true) {
      const readyStep = this.state.steps.find((step) => {
        if (step.status === 'completed' || step.status === 'failed') {
          return false;
        }
        const dependencies = step.dependsOn ?? [];
        return dependencies.length === 0 || dependencies.every((dependencyId) => completedIds.has(dependencyId));
      });

      if (!readyStep) {
        const unfinished = this.state.steps.filter((step) => step.status !== 'completed' && step.status !== 'failed');
        if (unfinished.length === 0) {
          break;
        }

        // Nothing further can become ready — every remaining step is blocked,
        // either by a dependency that already failed (cascading forward from a
        // connectivity/agent failure elsewhere in the DAG) or by an
        // unsatisfiable/circular graph. Mark them all failed in this one pass
        // and stop, rather than returning on the very first one: independent
        // steps earlier in the loop have already run to completion by now, so
        // whatever artifacts they produced are not lost to this.
        for (const step of unfinished) {
          const missing = (step.dependsOn ?? []).filter((dependencyId) => !completedIds.has(dependencyId));
          step.status = 'failed';
          failedIds.add(step.id);
          anyFailure = true;
          this.log(missing.length > 0
            ? `Step ${step.id} cannot run because dependencies were not satisfied: ${missing.join(', ')}`
            : `Step ${step.id} has invalid or circular dependencies.`);
        }
        break;
      }

      if (this.executionPaused) {
        this.state.status = 'paused';
        this.state.runningStepId = undefined;
        this.log(`Execution paused before step ${readyStep.id}.`);
        this.emitState();
        return;
      }

      readyStep.status = 'running';
      this.state.runningStepId = readyStep.id;
      this.state.lastError = undefined;
      this.emitState();

      try {
        // Determine phase for this step
        const phase = AGENT_PHASE[readyStep.assignedAgent] || this.state.currentPhase || 'discover';
        readyStep.phase = phase;
        this.state.currentPhase = phase;

        const context: AgentExecutionContext = {
          objective: this.state.objective,
          schemaContext: this.state.schemaContext,
          sourceProvider: this.state.sourceProvider,
          targetEnvironment: this.state.targetEnvironment,
          settings: this.configManager.getSettings(),
          configManager: {
            getSecret: async (secretKey: string) => this.configManager.getSecret(secretKey),
            getSettings: () => this.configManager.getSettings()
          },
          log: (message: string) => this.log(message),
          addArtifact: (artifact: GeneratedArtifact) => {
            if (!this.state.artifacts) this.state.artifacts = [];
            artifact.phase = phase;
            this.state.artifacts.push(artifact);
            this.log(`Artifact generated: ${artifact.title} (${artifact.type})`);
          },
          currentPhase: phase,
          workspaceRoot: this.getWorkspaceRoot(),
          extensionContext: this.configManager.getExtensionContext(),
          skillId: readyStep.skillId,
          skillInstruction: readyStep.taskDescription,
          callLlm: (prompt: string, systemPrompt?: string) => this.callConfiguredLlm(prompt, systemPrompt)
        };

        const executor = AGENT_EXECUTORS[readyStep.assignedAgent];
        const result = await executor(readyStep, context);

        if (!result.success) {
          readyStep.status = 'failed';
          failedIds.add(readyStep.id);
          anyFailure = true;
          this.state.lastError = result.error ?? result.message;
          this.state.runningStepId = undefined;
          this.log(`Step ${readyStep.id} failed: ${this.state.lastError}. Continuing with any remaining independent steps.`);
          this.emitState();
          continue;
        }

        if (result.artifacts && result.artifacts.length > 0) {
          if (!this.state.artifacts) this.state.artifacts = [];
          for (const artifact of result.artifacts) {
            artifact.phase = phase;
            artifact.specId = this.state.specId;
            artifact.specVersion = this.state.specVersion;
            this.state.artifacts.push(artifact);
            this.log(`Artifact generated: ${artifact.title} (${artifact.type})`);

            if (this.artifactWriter) {
              const written = await this.artifactWriter.write(artifact);
              artifact.filePath = written.fsPath;
            }
          }
        }

        readyStep.status = 'completed';
        completedIds.add(readyStep.id);
        this.state.runningStepId = undefined;
        this.log(`Step ${readyStep.id} completed successfully.`);
        this.emitState();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown execution failure.';
        readyStep.status = 'failed';
        failedIds.add(readyStep.id);
        anyFailure = true;
        this.state.lastError = message;
        this.state.runningStepId = undefined;
        this.log(`Step ${readyStep.id} threw an error: ${message}. Continuing with any remaining independent steps.`);
        this.emitState();
      }
    }

    this.state.runningStepId = undefined;

    if (anyFailure) {
      this.state.status = 'failed';
      const artifactCount = this.state.artifacts?.length ?? 0;
      this.log(`Execution finished with ${failedIds.size} failed step(s) and ${completedIds.size} completed step(s) — ${artifactCount} artifact(s) generated from the steps that succeeded.`);
      this.emitState();
      const firstFailedStep = this.state.steps.find((step) => failedIds.has(step.id));
      if (firstFailedStep) {
        await this.handleFailure(firstFailedStep, this.state.lastError ?? 'One or more steps failed.');
      }
      return;
    }

    this.state.status = 'completed';
    this.log('Execution completed successfully.');
    this.emitState();
  }

  public async pauseExecution(): Promise<void> {
    this.executionPaused = true;
    this.state.status = 'paused';
    this.state.runningStepId = undefined;
    this.log('Execution paused by user request.');
    this.emitState();
  }

  public async resetPlan(): Promise<void> {
    this.state.objective = '';
    this.state.schemaContext = '';
    this.state.sourceProvider = this.configManager.getSettings().defaultProvider ?? 'snowflake';
    this.state.targetEnvironment = undefined;
    this.state.steps = [];
    this.state.mode = 'plan';
    this.state.status = 'idle';
    this.state.runningStepId = undefined;
    this.state.lastError = undefined;
    this.state.artifacts = [];
    this.state.currentPhase = undefined;
    this.state.phaseOverrides = undefined;
    this.state.planApproved = false;
    this.state.planApprovedAt = undefined;
    this.state.stagesConfirmed = false;
    this.state.stagesConfirmedAt = undefined;
    this.planLineageId = undefined;
    this.executionPaused = false;
    this.log('Hub state reset.');
    this.emitState();
  }

  /**
   * Full reset for activating a *different* (or brand new) business problem
   * (v0.12.0) — everything `resetPlan()` clears, plus spec identity, inferred
   * phases, and implementation type, none of which carry over across business
   * problems the way they legitimately do across a re-plan of the same spec.
   * Called before loading whatever the newly-activated problem has persisted,
   * so nothing from the previous one can leak into it (requirements.md §8.11 —
   * this is the fix for the stale-state bug reported in §9 of the audit).
   */
  public resetForNewProblem(): void {
    this.state.objective = '';
    this.state.schemaContext = '';
    this.state.sourceProvider = this.configManager.getSettings().defaultProvider ?? 'snowflake';
    this.state.targetEnvironment = undefined;
    this.state.steps = [];
    this.state.mode = 'plan';
    this.state.status = 'idle';
    this.state.runningStepId = undefined;
    this.state.lastError = undefined;
    this.state.artifacts = [];
    this.state.currentPhase = undefined;
    this.state.phaseOverrides = undefined;
    this.state.specId = undefined;
    this.state.specVersion = undefined;
    this.state.inferredPhases = undefined;
    this.state.implementationType = undefined;
    this.state.planApproved = false;
    this.state.planApprovedAt = undefined;
    this.state.stagesConfirmed = false;
    this.state.stagesConfirmedAt = undefined;
    this.state.contextGateReady = false;
    this.planLineageId = undefined;
    this.executionPaused = false;
    this.log('Hub state fully reset for a different business problem.');
    this.emitState();
  }

  // ── Prompt Building ──

  private buildPlanPrompt(objective: string, schemaContext: string, requiredPhases: WorkflowPhase[] = []): string {
    const baseContext = schemaContext && schemaContext.trim().length > 0 ? `\n\n## Source Environment\n${schemaContext}` : '';
    const providerName = this.state.sourceProvider;

    let phaseBlock = '';
    if (requiredPhases.length > 0) {
      phaseBlock = `\n\n## Required workflow phases (inferred from the approved business specification)\n${requiredPhases.join(', ')}\n\nCreate steps ONLY for the phases listed above. Do not create steps that belong to an unlisted phase.`;
    }

    let implementationBlock = '';
    if (this.state.implementationType) {
      implementationBlock = this.state.implementationType === 'brownfield'
        ? '\n\n## Implementation type\nBrownfield — this builds on an existing system. Plan steps should account for integrating with, migrating from, or coexisting with what already exists.'
        : '\n\n## Implementation type\nGreenfield — no existing system to integrate with. Plan steps can assume a clean build.';
    }

    let targetBlock = '';
    if (this.state.targetEnvironment) {
      const t = this.state.targetEnvironment;
      const pc = t.platformConfig as unknown as Record<string, string>;
      const db = pc['database'] || pc['catalog'] || pc['dataset'] || '';
      const schema = pc['schema'] || pc['dataset'] || '';
      targetBlock = `\n\n## Target Environment
- Platform: ${t.platform} (${db}.${schema})
- Profile: ${t.environmentProfile}
- Modeling: ${t.modelingApproach}
- Transformation: ${t.transformationTool}
- Orchestration: ${t.orchestrationTool}
- Naming: ${t.namingConvention}
- Outputs: ${t.outputFormats.join(', ')}`;
    }

    return `You are an expert data engineering planning assistant. Create a strict execution DAG for the following objective for the ${providerName} provider:${baseContext}${phaseBlock}${implementationBlock}${targetBlock}\n\nObjective: ${objective}\n\nReturn only a valid JSON array of objects. Each object must include: {"id":"step-1","assignedAgent":"ingestionAgent","taskDescription":"...","status":"pending","dependsOn":[],"validationRules":["..."]}. Use only these assignedAgent values: ingestionAgent, sttmAgent, architectureAgent, snowflakeExecutor, sourceAssessmentAgent, dataModelerAgent, transformScaffoldAgent. Order the DAG so each step is sequentially dependent. Make sure step ids are unique and use a dependency list when appropriate. If a step touches Snowflake, use snowflakeExecutor as the terminal step. Do not include markdown fences, comments, or extra text. This JSON must be parseable by a strict JSON parser.`;
  }

  // ── LLM Calls ──

  /**
   * Default system instruction for planning calls. Kept as the default so that
   * existing behaviour (strict JSON array output) is unchanged for callers that
   * do not supply their own system prompt.
   */
  private static readonly PLANNER_SYSTEM_PROMPT =
    'You are a strict data engineering planner. Respond with a JSON array only.';

  private static readonly EXTRACTOR_SYSTEM_PROMPT =
    'You are a strict data engineering assistant. Respond with a JSON object only.';

  /** Builds the narrow context object LLM adapters receive — see `LlmAdapterContext`. */
  private buildLlmContext(): LlmAdapterContext {
    return {
      getSettings: () => this.configManager.getSettings(),
      getLlmApiKey: () => this.configManager.getLlmApiKey(),
      getExtensionContext: () => this.configManager.getExtensionContext(),
      getWorkspaceRoot: () => this.getWorkspaceRoot(),
      log: (message: string) => this.log(message)
    };
  }

  private async callConfiguredLlm(
    prompt: string,
    systemPrompt?: string,
    justification?: string,
    opts?: {
      toolExecutionMode?: ToolExecutionMode;
      history?: LlmHistoryTurn[];
      claudeSessionId?: string;
      isNewClaudeSession?: boolean;
    }
  ): Promise<string> {
    const settings = this.configManager.getSettings();
    const provider = settings.activeLlmProvider ?? 'copilot';
    const model = settings.activeLlmModel ?? 'gpt-4o-mini';
    const sys = systemPrompt ?? DataAgentHubHub.PLANNER_SYSTEM_PROMPT;

    try {
      const adapter = getLlmAdapter(provider);
      return await adapter.complete(
        prompt,
        {
          model, systemPrompt: sys, justification,
          toolExecutionMode: opts?.toolExecutionMode,
          history: opts?.history,
          claudeSessionId: opts?.claudeSessionId,
          isNewClaudeSession: opts?.isNewClaudeSession
        },
        this.buildLlmContext()
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The selected LLM provider is unavailable.';
      throw new Error(`LLM request failed: ${message}`);
    }
  }

  private parseJsonObject(text: string): Record<string, unknown> {
    const attempts: string[] = [text];
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) { attempts.push(text.slice(start, end + 1)); }
    for (const candidate of attempts) {
      try {
        const value = JSON.parse(candidate) as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return value as Record<string, unknown>;
        }
      } catch {
        // try the next candidate
      }
    }
    throw new Error('The LLM did not return a valid JSON object.');
  }

  /**
   * Tolerant JSON-array parsing (mirrors `parseJsonObject`): tries the raw text
   * first, then falls back to the outermost `[`...`]` slice, so a response the
   * model wrapped in prose or left a stray trailing sentence after still parses
   * instead of failing outright (closes R10 — brittle LLM JSON parsing).
   */
  private parseJsonArray(text: string): unknown[] {
    const attempts: string[] = [text];
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) { attempts.push(text.slice(start, end + 1)); }
    for (const candidate of attempts) {
      try {
        const value = JSON.parse(candidate) as unknown;
        if (Array.isArray(value)) { return value; }
      } catch {
        // try the next candidate
      }
    }
    throw new Error('The LLM response did not produce a JSON array as required.');
  }

  private validatePlanResponse(rawResponse: string, requiredPhases: WorkflowPhase[] = []): PlanStep[] {
    let parsed: unknown[];
    try {
      parsed = this.parseJsonArray(extractJsonText(rawResponse));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'JSON parse failure';
      throw new Error(`The LLM returned invalid JSON: ${message}`);
    }

    const requiredPhaseSet = new Set(requiredPhases);

    const mapped = parsed.map((item, index) => {
      if (!item || typeof item !== 'object') {
        throw new Error(`Plan item at index ${index} is not an object.`);
      }

      const candidate = item as Record<string, unknown>;
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : `step-${index + 1}`;
      const assignedAgent = typeof candidate.assignedAgent === 'string' ? candidate.assignedAgent : 'ingestionAgent';
      const taskDescription = typeof candidate.taskDescription === 'string' ? candidate.taskDescription.trim() : '';
      const dependsOn = Array.isArray(candidate.dependsOn) ? candidate.dependsOn.filter((value): value is string => typeof value === 'string') : [];
      const validationRules = Array.isArray(candidate.validationRules) ? candidate.validationRules.filter((value): value is string => typeof value === 'string') : [];

      if (!VALID_AGENT_TYPES.includes(assignedAgent as AgentType)) {
        throw new Error(`Step ${id} contains an invalid assignedAgent value: ${assignedAgent}`);
      }
      if (!taskDescription) {
        throw new Error(`Step ${id} does not include a taskDescription.`);
      }
      if (requiredPhaseSet.size > 0) {
        const phase = AGENT_PHASE[assignedAgent as AgentType];
        if (phase && !requiredPhaseSet.has(phase)) {
          throw new Error(`Step ${id} (${assignedAgent}) belongs to the "${phase}" phase, which is not among the required phases (${requiredPhases.join(', ')}).`);
        }
      }

      return { id, assignedAgent: assignedAgent as AgentType, taskDescription, status: 'pending' as PlanStatus, dependsOn, validationRules };
    });

    const allIds = new Set<string>();
    for (const step of mapped) {
      if (allIds.has(step.id)) { throw new Error(`Plan contains duplicate step ID: ${step.id}`); }
      allIds.add(step.id);
    }
    for (const step of mapped) {
      const missingDeps = (step.dependsOn ?? []).filter((dependencyId) => !allIds.has(dependencyId));
      if (missingDeps.length > 0) { throw new Error(`Step ${step.id} depends on missing step IDs: ${missingDeps.join(', ')}`); }
      if ((step.dependsOn ?? []).includes(step.id)) { throw new Error(`Step ${step.id} cannot depend on itself.`); }
    }

    this.assertAcyclic(mapped);

    return mapped;
  }

  /**
   * Kahn's-algorithm topological sort used purely as a cycle check. Direct
   * self-dependency is already rejected above; this catches the 2-or-more-node
   * cycles (A depends on B, B depends on A) that previously passed validation
   * and were only discovered later, at execution time, as a "blocked DAG."
   */
  private assertAcyclic(steps: PlanStep[]): void {
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const step of steps) {
      inDegree.set(step.id, (step.dependsOn ?? []).length);
    }
    for (const step of steps) {
      for (const dep of step.dependsOn ?? []) {
        const list = dependents.get(dep) ?? [];
        list.push(step.id);
        dependents.set(dep, list);
      }
    }

    const queue = steps.filter((step) => (inDegree.get(step.id) ?? 0) === 0).map((step) => step.id);
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      visited++;
      for (const next of dependents.get(id) ?? []) {
        const remaining = (inDegree.get(next) ?? 0) - 1;
        inDegree.set(next, remaining);
        if (remaining === 0) { queue.push(next); }
      }
    }

    if (visited < steps.length) {
      const cyclic = steps.filter((step) => (inDegree.get(step.id) ?? 0) > 0).map((step) => step.id);
      throw new Error(`Plan contains a circular dependency among steps: ${cyclic.join(', ')}`);
    }
  }

  private async handleFailure(step: PlanStep, error: string): Promise<void> {
    const message = `Agent ${step.assignedAgent} failed while executing ${step.id}: ${error}`;
    const selection = await vscode.window.showErrorMessage(message, 'Re-plan', 'Close');
    if (selection !== 'Re-plan') { return; }

    const replanObjective = `The previous execution failed on step "${step.id}" (${step.assignedAgent}) with error: ${error}. Revise the plan to recover and continue the workflow.`;
    try {
      this.nextPlanGenerationReason = 're-plan';
      await this.generatePlan(replanObjective, this.state.schemaContext);
      this.log('Generated a revised plan after the execution failure.');
      this.emitState();
    } catch (generationError) {
      const failureMessage = generationError instanceof Error ? generationError.message : 'Re-plan failed unexpectedly.';
      this.log(`Re-plan failed: ${failureMessage}`);
      this.state.status = 'failed';
      this.state.lastError = failureMessage;
      this.emitState();
    }
  }

  private emitState(): void {
    const recomputed = computePhaseStatuses(this.state.inferredPhases, this.state.steps, this.state.currentPhase, this.state.status);
    if (recomputed) {
      this.state.inferredPhases = recomputed;
    }
    if (this.stateListener) {
      this.stateListener(this.getPlan());
    }
  }

  private log(message: string): void {
    if (this.logListener) {
      this.logListener(message);
    }
  }
}