import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { ConfigurationManager } from './configManager';
import { AgentHost, AgentToolRunOptions, LlmProvider, ToolCallAuditEntry, EngineAccess, EngineToolSet } from '../engine/types';
import { createVscodeFileIo } from '../context/vscodeFileIo';
import { executeToolSkillAgent } from '../agents/build/ToolSkillAgent';
import { SpecOpsEngine } from '../engine/interview/specOps';
import { buildDiscoveryTurnPrompt, buildSynthesisPrompt } from './specOpsPrompts';
import { parseComprehensiveSpec } from './specSynthesis';
import { buildAttachmentExtractionPrompt, fallbackAttachmentExtract, parseAttachmentExtract } from './attachmentExtraction';
import { CITATION_INSTRUCTION } from '../engine/context/chatExtraction';

/**
 * Tool-action memory (C4b): transcript `log` entries (files written, commands
 * run) are folded into the assistant turn before them, so every provider gets
 * strict user/assistant alternation and still sees what was done.
 */
export function foldActionEntries(history: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of history) {
    if (m.role === 'log') {
      const last = out[out.length - 1];
      if (last && last.role === 'ai') out[out.length - 1] = { ...last, content: `${last.content}

[Actions taken] ${m.content}` };
      continue;
    }
    if (m.role === 'user' || m.role === 'ai') out.push(m);
  }
  return out;
}
import { LlmAdapterContext, LlmHistoryTurn, extractJsonText } from './llmAdapter';
import { getLlmAdapter } from './llmProviders';
import { contextWindowForModel, windowHistoryToBudget, RESERVED_PROMPT_TOKENS, RESERVED_RESPONSE_TOKENS } from './tokenBudget';
import {
  AgentExecutionContext,
  AttachmentExtract,
  BusinessProblemSpec,
  ChatMessage,
  DataPlatformProvider,
  IntakeAttachment,
  IntakeSession,
  SkillDefinition,
  SpecEngineAction,
  TargetEnvironment,
  ToolExecutionMode
} from '../engine/types';

/**
 * The extension's model-facing services: the specification, chat, the
 * configured model with tools (for the stage executor and tool skills), and
 * the target environment the chat is grounded in. Since v0.45.9 (SIMP-3) it
 * holds no plan of steps: the workflow's stages are the only path, run from
 * the Workflow view (`agentExecutor.ts`) or by a host agent.
 */
export class DataAgentHubHub {
  /** What the chat and the tool skills are grounded in: the active specification and target. */
  private readonly state: { objective: string; schemaContext: string; sourceProvider: DataPlatformProvider; targetEnvironment?: TargetEnvironment; specId?: string; specVersion?: number } = {
    objective: '',
    schemaContext: '',
    sourceProvider: 'snowflake'
  };

  private logListener?: (message: string) => void;
  public constructor(private readonly configManager: ConfigurationManager) {}

  /** Phase 5: makes the engine client each agent context gets (started on first use; the tool-skill runner disposes it). */
  private engineFactory: ((clientName?: string) => EngineAccess | undefined) | undefined;
  public setEngineFactory(factory: (clientName?: string) => EngineAccess | undefined): void {
    this.engineFactory = factory;
  }

  /** PA3b: an engine client of its own for one stage run, named after the role so the workflow's history records who did it. */
  public createEngine(clientName: string): EngineAccess | undefined {
    return this.engineFactory?.(clientName);
  }

  /** PA3b: the configured model with tools, for the stage executor. */
  public runAgentWithTools(prompt: string, opts: AgentToolRunOptions): Promise<{ text: string; audit: ToolCallAuditEntry[]; provider: LlmProvider }> {
    return this.runConfiguredLlmWithTools(prompt, opts);
  }

  public activeProvider(): LlmProvider {
    return this.configManager.getSettings().activeLlmProvider ?? 'copilot';
  }

  public setLogListener(listener: (message: string) => void): void {
    this.logListener = listener;
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** The extension's implementation of `AgentHost` (v0.26.0): modal approval, VS Code's file system. */
  private buildAgentHost(): AgentHost {
    return {
      workspaceRoot: this.getWorkspaceRoot(),
      confirm: async (message: string, actionLabel: string) =>
        (await vscode.window.showWarningMessage(message, { modal: true }, actionLabel)) === actionLabel,
      fileIo: createVscodeFileIo(vscode)
    };
  }

  public setSpec(specId: string, specVersion: number): void {
    this.state.specId = specId;
    this.state.specVersion = specVersion;
  }

  /** The active specification's id, if any. */
  public currentSpecId(): string | undefined {
    return this.state.specId;
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
    'If the user asks for an execution plan, point them to the Workflow view: AutoDE works stage by stage.',
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
    return `${DataAgentHubHub.CHAT_SYSTEM_PROMPT_BASE}\n${capability}\n${CITATION_INSTRUCTION}`;
  }

  /**
   * Generates (or regenerates) the Business Problem Specification from natural language.
   *
   * Versioning semantics:
   * - no previous spec           -> new id, version 1, status draft
   * - previous spec is a draft   -> same id and version, status draft (in-place revision)
   * - previous spec was approved -> same id, version + 1, status draft (new revision)
   */
  public async generateSpec(userInput: string, previous?: BusinessProblemSpec, context?: string): Promise<BusinessProblemSpec> {
    const trimmed = (userInput ?? '').trim();
    if (!trimmed) {
      throw new Error('A description of the business problem is required to generate a specification.');
    }

    const previousBlock = previous
      ? `\n\n## Existing specification (revise it; do not discard content that is still valid)\n${JSON.stringify(this.specToJson(previous), null, 2)}`
      : '';
    // Previously this prompt carried zero context of any kind — not even
    // repository/connection facts other prompt-building paths already had.
    const contextBlock = context && context.trim().length > 0 ? `\n\n${context.trim()}` : '';

    const prompt = `## Business problem (from the user)\n${trimmed}${previousBlock}${contextBlock}\n\nReturn the Business Problem Specification JSON object now.`;

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

  /**
   * Extracts structured facts from a spec-discovery attachment (Phase 2B-i).
   * Never throws — a failed/malformed extraction falls back to a plain
   * summary of the attachment's own text, matching `generateWithLlm()`'s own
   * "generation must never become a hard failure point" discipline.
   */
  /**
   * One structured LLM call (Phase C4a: profile proposals, document extraction,
   * vocabulary proposals): the reply parsed as a JSON object. Throws when no
   * LLM answers; callers degrade.
   */
  public async completeJson(system: string, user: string, purpose: string): Promise<Record<string, unknown>> {
    const raw = await this.callConfiguredLlm(user, system, purpose);
    return this.parseJsonObject(extractJsonText(raw));
  }

  public async extractAttachmentFacts(attachment: IntakeAttachment): Promise<AttachmentExtract> {
    try {
      const { system, user } = buildAttachmentExtractionPrompt(attachment);
      const raw = await this.callConfiguredLlm(user, system, 'Extract structured facts from an attached reference document.');
      return parseAttachmentExtract(this.parseJsonObject(extractJsonText(raw)), attachment);
    } catch (err) {
      this.log(`Attachment extraction failed for ${attachment.path} (${err instanceof Error ? err.message : String(err)}) — falling back to a plain summary.`);
      return fallbackAttachmentExtract(attachment);
    }
  }

  /**
   * Runs one imported tool-executing skill directly (Phase D) — from chat
   * (`/skill <id> <instruction>`) or a dedicated "Run Skill" UI action. A
   * single, immediate run, approved as it goes.
   */
  public async runToolSkill(skillId: string, instruction: string, liveContext?: string, skillVersion?: number): Promise<{ success: boolean; message: string; error?: string }> {
    const context: AgentExecutionContext = {
      objective: this.state.objective,
      // A caller can supply a live context block (e.g. from ContextFileManager.buildContextPrompt(), runtime facts included).
      schemaContext: liveContext ?? this.state.schemaContext,
      sourceProvider: this.state.sourceProvider,
      targetEnvironment: this.state.targetEnvironment,
      settings: this.configManager.getSettings(),
      configManager: {
        getSecret: async (secretKey: string) => this.configManager.getSecret(secretKey),
        getSettings: () => this.configManager.getSettings()
      },
      log: (message: string) => this.log(message),
      addArtifact: (artifact) => this.log(`Artifact generated: ${artifact.title} (${artifact.type})`),
      currentPhase: 'build',
      workspaceRoot: this.getWorkspaceRoot(),
      runWithTools: (prompt: string, opts: AgentToolRunOptions) => this.runConfiguredLlmWithTools(prompt, opts),
      host: this.buildAgentHost(),
      engine: this.engineFactory?.(),
      skillId,
      skillInstruction: instruction
    };
    const result = await executeToolSkillAgent({ skillId, skillVersion, taskDescription: instruction }, context);
    return { success: result.success, message: result.message, error: result.error };
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
    this.log(`Target environment set: ${env.platform} —${env.modelingApproach} via ${env.transformationTool}`);
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
      modelingApproach: partial.modelingApproach ?? 'dimensional',
      namingConvention: partial.namingConvention ?? 'snake_case',
      transformationTool: partial.transformationTool ?? 'dbt',
      orchestrationTool: partial.orchestrationTool ?? 'airflow',
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
    opts?: { history?: ChatMessage[]; priorSummary?: string; claudeSessionId?: string; engineTools?: EngineToolSet; frontDoor?: string }
  ): Promise<{ message: string; updatedSummary?: string; newClaudeSessionId?: string; actions: ToolCallAuditEntry[] }> {
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
      // C4b: action entries ('log') are folded into the assistant turn before them — every provider's history is strict user/assistant turns.
      const rawHistory = foldActionEntries(opts?.history ?? []);
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

    const actions: ToolCallAuditEntry[] = [];
    try {
      const rawResponse = await this.callConfiguredLlm(
        prompt,
        [DataAgentHubHub.buildChatSystemPrompt(toolExecutionMode), opts?.frontDoor].filter(Boolean).join('\n\n'),
        'Answer a data engineering question in the Auto Data Engineering Hub sidebar chat.',
        // Grounded chat: every provider that supports tool execution gets the
        // same read (default) / write (opt-in, approved) grant. See core/agenticTools.ts.
        {
          toolExecutionMode,
          history: resumingClaude ? undefined : historyTurns,
          claudeSessionId,
          isNewClaudeSession: startingClaudeSession,
          auditSink: actions,
          engineTools: opts?.engineTools
        }
      );
      return {
        message: rawResponse,
        updatedSummary,
        newClaudeSessionId: startingClaudeSession ? claudeSessionId : undefined,
        actions
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

    if (this.state.targetEnvironment) {
      const t = this.state.targetEnvironment;
      const pc = t.platformConfig as unknown as Record<string, string>;
      const db = pc['database'] || pc['catalog'] || pc['dataset'] || '';
      const schema = pc['schema'] || pc['dataset'] || '';
      parts.push(
        `## Target Environment\n` +
        `- Platform: ${t.platform} (${db}.${schema})\n` +
        `- Modeling: ${t.modelingApproach}\n` +
        `- Transformation: ${t.transformationTool}\n` +
        `- Orchestration: ${t.orchestrationTool}\n` +
        `- Naming: ${t.namingConvention}`
      );
    }

    return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
  }

  /**
   * Full reset for activating a *different* (or brand new) business problem
   * (v0.12.0): spec identity and target, so nothing from the previous problem
   * leaks into the next one (requirements.md §8.11).
   */
  public resetForNewProblem(): void {
    this.state.objective = '';
    this.state.schemaContext = '';
    this.state.sourceProvider = this.configManager.getSettings().defaultProvider ?? 'snowflake';
    this.state.targetEnvironment = undefined;
    this.state.specId = undefined;
    this.state.specVersion = undefined;
    this.log('Hub state reset for a different business problem.');
  }

  // ── LLM Calls ──

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
      /** C4b: the tool calls the turn made, for the transcript (tool-action memory). */
      auditSink?: ToolCallAuditEntry[];
      /** v0.52.1: AutoDE's read-only tools for the chat (AutoDE-owned loops; Claude Code's own loop ignores them). */
      engineTools?: EngineToolSet;
    }
  ): Promise<string> {
    const settings = this.configManager.getSettings();
    const provider = settings.activeLlmProvider ?? 'copilot';
    const model = settings.activeLlmModel ?? 'gpt-4o-mini';
    const sys = systemPrompt ?? DataAgentHubHub.EXTRACTOR_SYSTEM_PROMPT;

    try {
      const adapter = getLlmAdapter(provider);
      return await adapter.complete(
        prompt,
        {
          model, systemPrompt: sys, justification,
          toolExecutionMode: opts?.toolExecutionMode,
          history: opts?.history,
          claudeSessionId: opts?.claudeSessionId,
          isNewClaudeSession: opts?.isNewClaudeSession,
          auditSink: opts?.auditSink,
          engineTools: opts?.engineTools
        },
        this.buildLlmContext()
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The selected LLM provider is unavailable.';
      throw new Error(`LLM request failed: ${message}`);
    }
  }

  /**
   * One LLM turn with AutoDE tool access through the configured provider (v0.28.0) — the single
   * path tool-executing skills use on every provider. The adapter appends each tool call to `audit`
   * (Claude Code's CLI runs its own loop and appends nothing; its run is approved as a whole).
   */
  private async runConfiguredLlmWithTools(prompt: string, opts: AgentToolRunOptions): Promise<{ text: string; audit: ToolCallAuditEntry[]; provider: LlmProvider }> {
    const settings = this.configManager.getSettings();
    const provider = settings.activeLlmProvider ?? 'copilot';
    const audit: ToolCallAuditEntry[] = [];
    const text = await getLlmAdapter(provider).complete(
      prompt,
      {
        model: settings.activeLlmModel ?? 'gpt-4o-mini',
        systemPrompt: opts.systemPrompt,
        justification: opts.justification,
        toolExecutionMode: opts.toolExecutionMode,
        allowedToolNames: opts.allowedToolNames,
        auditSink: audit,
        approvalPrompt: opts.approvalPrompt,
        engineTools: opts.engineTools
      },
      this.buildLlmContext()
    );
    return { text, audit, provider };
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

  private log(message: string): void {
    if (this.logListener) {
      this.logListener(message);
    }
  }
}
