import { AgentToolRunOptions, EngineAccess, LlmProvider, ToolCallAuditEntry } from '../engine/types';
import { StageKind } from '../engine/workflows/stageKinds';
import { isDocumentStage } from '../engine/workflows/documentApproval';
import { Assignment, assignmentFor } from '../engine/agents/assignment';
import { completeStage, startStage, WorkflowError } from '../engine/workflows/runtime';
import { readEvents, Actor } from '../engine/workflows/events';
import { layoutPath } from '../engine/workspaceLayout';
import { readWorkflow } from '../engine/workflows/instance';

/**
 * AutoDE's in-process executor (PA3b): runs a stage's assignment with the
 * model configured in the panel — the same assignment a host agent gets from
 * `autode_workflow_next`, the same tools (by tier and role), the same
 * `autode_record_artifact` — then hands the stage in. It is a spoke: it never
 * approves, and nothing it does calls another agent.
 */

/** Who runs a stage here: the role template its kind allows (since v0.45.4 every agent is one). */
export function stageRunner(scope: StageRunScope, stageId: string, _kind?: StageKind): string | undefined {
  return assignmentFor(scope, stageId, []).assignment?.role;
}

export interface ExecutorHost {
  createEngine(clientName: string): EngineAccess | undefined;
  runAgentWithTools(prompt: string, opts: AgentToolRunOptions): Promise<{ text: string; audit: ToolCallAuditEntry[]; provider: LlmProvider }>;
  activeProvider(): LlmProvider;
  log(line: string): void;
}

export interface StageRunScope { workspaceRoot: string; resourcesRoot: string; problemId: string }

export interface StageRunResult { ok: boolean; message: string; outputs: string[]; decisionId?: string; summary?: string }

/** Whether the stage can be run here: its role has a definition (the reason otherwise). */
export function runnableReason(scope: StageRunScope, stageId: string): string | undefined {
  const r = assignmentFor(scope, stageId, []);
  return r.assignment ? undefined : r.reason;
}

export async function runStage(host: ExecutorHost, scope: StageRunScope, stageId: string, now: () => Date = () => new Date()): Promise<StageRunResult> {
  const problemRoot = layoutPath(scope.workspaceRoot, 'problems', scope.problemId);
  const ctx = { workspaceRoot: scope.workspaceRoot, problemRoot, problemId: scope.problemId };
  const stage = readWorkflow(problemRoot)?.stages.find((s) => s.id === stageId);
  if (!stage) return { ok: false, message: `No stage "${stageId}".`, outputs: [] };
  // A document stage awaiting approval may be run again (its draft is redone); a gate decision waits for a person.
  if (stage.record.status === 'done' || (stage.record.status === 'awaiting-approval' && (stage.record.decisionId || !isDocumentStage(stage.kind)))) return { ok: false, message: `${stageId} is ${stage.record.status === 'done' ? 'done; re-open it to change it' : 'waiting for approval'}.`, outputs: [] };
  if (host.activeProvider() === 'claude') {
    // Claude Code runs its own tool loop and doesn't take AutoDE's in-process tools; it gets the same assignment through the plugin.
    return { ok: false, message: 'With Claude Code as the model, run AutoDE\'s agents in Claude Code itself: `autode plugin install --host claude`, then ask it to continue this problem (the autode-orchestrator skill). Or pick another model in AutoDE\'s settings.', outputs: [] };
  }
  const probe = assignmentFor(scope, stageId, []);
  if (!probe.assignment) return { ok: false, message: probe.reason ?? `No assignment for ${stageId}.`, outputs: [] };
  const role = probe.assignment.role;
  const engine = host.createEngine(`${role} (VS Code)`);
  if (!engine?.listTools || !engine.toolSetNamed) return { ok: false, message: 'AutoDE\'s engine is not available (open a workspace folder).', outputs: [] };
  const who: Actor = { kind: 'agent', name: role, host: 'VS Code' };
  try {
    const a: Assignment = assignmentFor(scope, stageId, await engine.listTools()).assignment!;
    if (stage.record.status !== 'in-progress' && stage.record.status !== 'awaiting-approval') {
      const started = startStage(ctx, stageId, who, 'panel');
      if (started.warning) host.log(started.warning);
    }
    const since = now().toISOString();
    const mode = a.fileMode === 'full' ? 'full' : 'read-only';
    host.log(`${role}: ${a.stage.title} — tier ${a.tier}, ${a.engineTools.length} AutoDE tools.`);
    const { text } = await host.runAgentWithTools(
      `Do the "${a.stage.title}" stage now. Record each deliverable with autode_record_artifact (stage "${a.stage.id}"). Then reply with a short summary for the person who approves the stage: what you recorded and what is missing or uncertain.`,
      { systemPrompt: a.text, toolExecutionMode: mode, engineTools: await engine.toolSetNamed(a.engineTools), justification: `AutoDE ${role}: ${a.stage.title}`, approvalPrompt: mode === 'full' ? `Allow AutoDE's ${role} to write files in this workspace for the "${a.stage.title}" stage?` : undefined }
    );
    const outputs = [...new Set(readEvents(problemRoot, { stage: stageId }).filter((e) => e.type === 'recorded' && e.at >= since).flatMap((e) => e.files ?? []))];
    const summary = text.trim().slice(0, 4000) || `${role} recorded ${outputs.length} file(s).`;
    if (!outputs.length) return { ok: false, message: `${role} finished without recording a deliverable, so ${stageId} wasn't handed in. Its reply:\n${summary}`, outputs, summary };
    if (isDocumentStage(a.stage.kind)) return { ok: true, message: `${role} drafted ${stageId}'s document. Review it and approve it (Approve… on the stage) to complete the stage.`, outputs, summary };
    const done = completeStage(ctx, stageId, { outputs, summary, who, channel: 'panel' });
    return { ok: true, message: done.message, outputs, decisionId: done.decisionId, summary };
  } catch (err) {
    const message = err instanceof WorkflowError || err instanceof Error ? err.message : String(err);
    return { ok: false, message: `${role} couldn't finish ${stageId}: ${message}`, outputs: [] };
  } finally {
    await engine.dispose();
  }
}
