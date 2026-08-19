import * as vscode from 'vscode';
import { ConfigurationManager } from './configManager';
import { executeIngestionAgent } from '../agents/build/IngestionPipelineAgent';
import { executeSttmAgent } from '../agents/model/SttmMapperAgent';
import { executeArchitectureAgent } from '../agents/validate/DocumentationAgent';
import { executeSnowflakeAgent } from '../spokes/snowflakeExecutor';
import { executeSourceAssessmentAgent } from '../agents/discover/SourceAssessmentAgent';
import {
  AgentExecutionContext,
  AgentType,
  PlanState,
  PlanStep,
  PlanStatus,
  SessionStatus
} from './types';

const VALID_AGENT_TYPES: AgentType[] = ['ingestionAgent', 'sttmAgent', 'architectureAgent', 'snowflakeExecutor', 'sourceAssessmentAgent'];

const AGENT_EXECUTORS: Record<AgentType, (step: PlanStep, context: AgentExecutionContext) => Promise<{ success: boolean; message: string; details?: Record<string, unknown>; error?: string }>> = {
  ingestionAgent: executeIngestionAgent,
  sttmAgent: executeSttmAgent,
  architectureAgent: executeArchitectureAgent,
  snowflakeExecutor: executeSnowflakeAgent,
  sourceAssessmentAgent: executeSourceAssessmentAgent
};

export class DataAgentHubHub {
  private readonly state: PlanState = {
    objective: '',
    schemaContext: '',
    provider: 'snowflake',
    steps: [],
    mode: 'plan',
    status: 'idle'
  };

  private executionPaused = false;
  private stateListener?: (state: PlanState) => void;
  private logListener?: (message: string) => void;

  public constructor(private readonly configManager: ConfigurationManager) {}

  public setStateListener(listener: (state: PlanState) => void): void {
    this.stateListener = listener;
  }

  public setLogListener(listener: (message: string) => void): void {
    this.logListener = listener;
  }

  public getPlan(): PlanState {
    return {
      ...this.state,
      steps: this.state.steps.map((step) => ({ ...step }))
    };
  }

  public async chat(message: string, schemaContext?: string): Promise<string> {
    const trimmed = message.trim();
    if (!trimmed) {
      throw new Error('A message is required.');
    }

    const settings = this.configManager.getSettings();
    const provider = settings.activeLlmProvider ?? 'copilot';
    this.log(`Sending chat to ${provider}...`);

    const contextBlock = schemaContext && schemaContext.trim().length > 0
      ? `\n\nRelevant database and business context:\n${schemaContext}`
      : '';

    const prompt = `You are AutoDE, an expert data engineering assistant running inside VS Code. You help users with data engineering tasks including pipeline design, SQL authoring, schema analysis, data modeling, ETL/ELT workflows, and data platform operations.

Respond conversationally and helpfully. If the user asks you to generate a plan, suggest they click the "Generate Plan" button or use the /plan command for structured execution plans.

${contextBlock}

User message: ${trimmed}`;

    try {
      const rawResponse = await this.callConfiguredLlm(prompt);
      return rawResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error during chat.';
      this.log(`Chat failed: ${message}`);
      throw new Error(message);
    }
  }

  public async generatePlan(objective: string, schemaContext?: string): Promise<PlanStep[]> {
    const trimmedObjective = objective.trim();
    if (!trimmedObjective) {
      throw new Error('A data engineering objective is required before generating a plan.');
    }

    const settings = this.configManager.getSettings();
    this.state.objective = trimmedObjective;
    this.state.schemaContext = schemaContext ?? '';
    this.state.provider = settings.defaultProvider ?? 'snowflake';
    this.state.mode = 'plan';
    this.state.status = 'planning';
    this.state.lastError = undefined;
    this.emitState();
    this.log(`Generating execution plan via configured LLM provider for ${this.state.provider}.`);

    try {
      const prompt = this.buildPlanPrompt(trimmedObjective, this.state.schemaContext);
      const rawResponse = await this.callConfiguredLlm(prompt);
      const validatedPlan = this.validatePlanResponse(rawResponse);
      this.state.steps = validatedPlan;
      this.state.status = 'ready';
      this.state.runningStepId = undefined;
      this.log(`Plan generated with ${validatedPlan.length} steps.`);
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

  public async executePlan(): Promise<void> {
    this.executionPaused = false;

    if (this.state.steps.length === 0) {
      const message = 'Generate a plan before attempting execution.';
      this.log(message);
      throw new Error(message);
    }

    this.state.mode = 'execute';
    this.state.status = 'running';
    this.emitState();

    const completedIds = new Set<string>();
    const allById = new Map(this.state.steps.map((step) => [step.id, step]));

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

        const blocked = unfinished[0];
        const missing = (blocked.dependsOn ?? []).filter((dependencyId) => !completedIds.has(dependencyId) && !this.state.steps.some((step) => step.id === dependencyId && step.status === 'failed'));
        blocked.status = 'failed';
        this.state.status = 'failed';
        this.state.lastError = missing.length > 0
          ? `Step ${blocked.id} cannot run because dependencies were not satisfied: ${missing.join(', ')}`
          : `Step ${blocked.id} has invalid or circular dependencies.`;
        this.state.runningStepId = undefined;
        this.log(this.state.lastError);
        this.emitState();
        await this.handleFailure(blocked, this.state.lastError);
        return;
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
        const context: AgentExecutionContext = {
          objective: this.state.objective,
          schemaContext: this.state.schemaContext,
          settings: this.configManager.getSettings(),
          configManager: {
            getSecret: async (secretKey: string) => this.configManager.getSecret(secretKey),
            getSettings: () => this.configManager.getSettings()
          },
          log: (message: string) => this.log(message)
        };

        const executor = AGENT_EXECUTORS[readyStep.assignedAgent];
        const result = await executor(readyStep, context);

        if (!result.success) {
          readyStep.status = 'failed';
          this.state.status = 'failed';
          this.state.lastError = result.error ?? result.message;
          this.state.runningStepId = undefined;
          this.log(`Step ${readyStep.id} failed: ${result.error ?? result.message}`);
          this.emitState();
          await this.handleFailure(readyStep, this.state.lastError);
          return;
        }

        readyStep.status = 'completed';
        completedIds.add(readyStep.id);
        this.state.runningStepId = undefined;
        this.log(`Step ${readyStep.id} completed successfully.`);
        this.emitState();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown execution failure.';
        readyStep.status = 'failed';
        this.state.status = 'failed';
        this.state.lastError = message;
        this.state.runningStepId = undefined;
        this.log(`Step ${readyStep.id} threw an error: ${message}`);
        this.emitState();
        await this.handleFailure(readyStep, message);
        return;
      }
    }

    this.state.status = 'completed';
    this.state.runningStepId = undefined;
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
    this.state.provider = this.configManager.getSettings().defaultProvider ?? 'snowflake';
    this.state.steps = [];
    this.state.mode = 'plan';
    this.state.status = 'idle';
    this.state.runningStepId = undefined;
    this.state.lastError = undefined;
    this.executionPaused = false;
    this.log('Hub state reset.');
    this.emitState();
  }

  private buildPlanPrompt(objective: string, schemaContext: string): string {
    const baseContext = schemaContext && schemaContext.trim().length > 0 ? `\n\nSchema and metadata context:\n${schemaContext}` : '';
    const providerName = this.state.provider;

    return `You are an expert data engineering planning assistant. Create a strict execution DAG for the following objective for the ${providerName} provider:${baseContext}\n\nObjective: ${objective}\n\nReturn only a valid JSON array of objects. Each object must include: {"id":"step-1","assignedAgent":"ingestionAgent","taskDescription":"...","status":"pending","dependsOn":[],"validationRules":["..."]}. Use only these assignedAgent values: ingestionAgent, sttmAgent, architectureAgent, snowflakeExecutor, sourceAssessmentAgent. Order the DAG so each step is sequentially dependent. Make sure step ids are unique and use a dependency list when appropriate. If a step touches Snowflake, use snowflakeExecutor as the terminal step. Do not include markdown fences, comments, or extra text. This JSON must be parseable by a strict JSON parser.`;
  }

  private async callConfiguredLlm(prompt: string): Promise<string> {
    const settings = this.configManager.getSettings();
    const provider = settings.activeLlmProvider ?? 'copilot';
    const model = settings.activeLlmModel ?? 'gpt-4o-mini';

    try {
      // If Copilot is selected, route through the official VS Code Language Model API.
      if (provider === 'copilot') {
        try {
          if (!settings.copilotProgrammaticConsent) {
            throw new Error(
              'Programmatic use of GitHub Copilot is not enabled. ' +
              'Open Settings (⚙) → LLM Provider → check "Allow programmatic use of local Copilot" and try again.'
            );
          }
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { CopilotAdapter } = require('./copilotAdapter') as typeof import('./copilotAdapter');
          const context = this.configManager.getExtensionContext();
          const { adapter, info } = await CopilotAdapter.detect(context);
          if (!adapter) {
            throw new Error(info.error || 'GitHub Copilot is not available. Install the GitHub Copilot Chat extension and sign in.');
          }
          const out = await adapter.complete(prompt, { model, timeoutMs: 30000 });
          return out;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log(`Copilot request failed: ${message}`);
          throw new Error(message);
        }
      }

      if (provider === 'azure-openai') {
        return await this.callAzureOpenAi(model, prompt, settings.llmEndpoint);
      }
      if (provider === 'openai') {
        return await this.callOpenAi(model, prompt);
      }
      if (provider === 'anthropic') {
        return await this.callAnthropic(model, prompt);
      }
      if (provider === 'gemini') {
        return await this.callGemini(model, prompt);
      }

      return await this.callOllama(model, prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The selected LLM provider is unavailable.';
      throw new Error(`LLM request failed: ${message}`);
    }
  }

  private async callOpenAi(model: string, prompt: string): Promise<string> {
    const apiKey = await this.configManager.getLlmApiKey();
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('OpenAI API key is missing. Add it in the settings panel.');
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'You are a strict data engineering planner. Respond with a JSON array only.'
          },
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI request failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };

    const content = data.choices?.[0]?.message?.content ?? '';
    return this.extractJsonText(content);
  }

  private async callAnthropic(model: string, prompt: string): Promise<string> {
    const apiKey = await this.configManager.getLlmApiKey();
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('Anthropic API key is missing. Add it in the settings panel.');
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic request failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };

    const text = data.content?.map((part) => (part.type === 'text' ? part.text ?? '' : '')).join('') ?? '';
    return this.extractJsonText(text);
  }

  private async callAzureOpenAi(model: string, prompt: string, endpoint?: string): Promise<string> {
    const apiKey = await this.configManager.getLlmApiKey();
    const url = endpoint && endpoint.trim().length > 0 ? endpoint.trim() : 'https://<your-resource>.openai.azure.com/openai/deployments/' + model + '/chat/completions?api-version=2024-02-01';

    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('Azure OpenAI API key is missing. Add it in the settings panel.');
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: 'You are a strict data engineering planner. Respond with a JSON array only.' },
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Azure OpenAI request failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? '';
    return this.extractJsonText(content);
  }

  private async callGemini(model: string, prompt: string): Promise<string> {
    const apiKey = await this.configManager.getLlmApiKey();
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('Gemini API key is missing. Add it in the settings panel.');
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0 }
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gemini request failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const content = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    return this.extractJsonText(content);
  }

  private async callOllama(model: string, prompt: string): Promise<string> {
    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: 'user', content: prompt }],
        format: 'json'
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama request failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as {
      message?: {
        content?: string;
      };
    };

    const content = data.message?.content ?? '';
    return this.extractJsonText(content);
  }

  private extractJsonText(content: string): string {
    const normalized = content
      .replace(/```json\s*/gi, '')
      .replace(/```/g, '')
      .trim();

    if (!normalized) {
      throw new Error('The LLM returned an empty response.');
    }

    return normalized;
  }

  private validatePlanResponse(rawResponse: string): PlanStep[] {
    let parsed: unknown;

    try {
      parsed = JSON.parse(rawResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'JSON parse failure';
      throw new Error(`The LLM returned invalid JSON: ${message}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error('The LLM response did not produce a JSON array as required.');
    }

    const mapped = parsed.map((item, index) => {
      if (!item || typeof item !== 'object') {
        throw new Error(`Plan item at index ${index} is not an object.`);
      }

      const candidate = item as Record<string, unknown>;
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : `step-${index + 1}`;
      const assignedAgent = typeof candidate.assignedAgent === 'string' ? candidate.assignedAgent : 'ingestionAgent';
      const taskDescription = typeof candidate.taskDescription === 'string' ? candidate.taskDescription.trim() : '';
      const dependsOn = Array.isArray(candidate.dependsOn)
        ? candidate.dependsOn.filter((value): value is string => typeof value === 'string')
        : [];
      const validationRules = Array.isArray(candidate.validationRules)
        ? candidate.validationRules.filter((value): value is string => typeof value === 'string')
        : [];

      if (!VALID_AGENT_TYPES.includes(assignedAgent as AgentType)) {
        throw new Error(`Step ${id} contains an invalid assignedAgent value: ${assignedAgent}`);
      }

      if (!taskDescription) {
        throw new Error(`Step ${id} does not include a taskDescription.`);
      }

      return {
        id,
        assignedAgent: assignedAgent as AgentType,
        taskDescription,
        status: 'pending' as PlanStatus,
        dependsOn,
        validationRules
      };
    });

    const allIds = new Set<string>();
    for (const step of mapped) {
      if (allIds.has(step.id)) {
        throw new Error(`Plan contains duplicate step ID: ${step.id}`);
      }
      allIds.add(step.id);
    }

    for (const step of mapped) {
      const missingDeps = (step.dependsOn ?? []).filter((dependencyId) => !allIds.has(dependencyId));
      if (missingDeps.length > 0) {
        throw new Error(`Step ${step.id} depends on missing step IDs: ${missingDeps.join(', ')}`);
      }
      if ((step.dependsOn ?? []).includes(step.id)) {
        throw new Error(`Step ${step.id} cannot depend on itself.`);
      }
    }

    return mapped;
  }

  private async handleFailure(step: PlanStep, error: string): Promise<void> {
    const message = `Agent ${step.assignedAgent} failed while executing ${step.id}: ${error}`;
    vscode.window.showErrorMessage(message, 'Re-plan');

    const selection = await vscode.window.showErrorMessage(message, 'Re-plan', 'Close');
    if (selection !== 'Re-plan') {
      return;
    }

    const replanObjective = `The previous execution failed on step "${step.id}" (${step.assignedAgent}) with error: ${error}. Revise the plan to recover and continue the workflow.`;
    try {
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