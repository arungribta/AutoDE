import * as path from 'node:path';
import { AgentToolRunOptions, EngineAccess, LlmProvider, ToolCallAuditEntry } from '../engine/types';
import { StageKind } from '../engine/workflows/stageKinds';
import { isDocumentStage, stageDocumentFile } from '../engine/workflows/documentApproval';
import { stageReadiness } from '../engine/workflows/readiness';
import { StageGap, stageGapQuery, stageGapsFrom } from '../engine/agents/stageGaps';
import { problemMode } from '../engine/documents/problemMode';
import { ContextGap } from '../engine/context/contextGaps';
import { Assignment, assignmentFor } from '../engine/agents/assignment';
import { completeStage, startStage, WorkflowError } from '../engine/workflows/runtime';
import { readEvents, Actor } from '../engine/workflows/events';
import { layoutPath } from '../engine/workspaceLayout';
import { readWorkflow } from '../engine/workflows/instance';
import { MaintenanceItem } from '../engine/maintenance/queue';
import { maintenanceAssignment, workOrder } from '../engine/maintenance/brief';

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

/** The stage's context gaps, from the engine's context pack: the same ones `autode_workflow_next` puts in a host's assignment (exported for its test). */
export async function stageGaps(engine: EngineAccess, problemRoot: string, kind: StageKind, title: string): Promise<StageGap[]> {
  const query = stageGapQuery(problemRoot, title);
  if (!query || !engine.toolSetNamed) return [];
  try {
    const r = await (await engine.toolSetNamed(['autode_get_context_pack'])).call('autode_get_context_pack', { purpose: 'step', query });
    if (r.isError) return [];
    return stageGapsFrom(((JSON.parse(r.text) as { manifest?: { gaps?: ContextGap[] } }).manifest?.gaps) ?? [], kind, problemMode(problemRoot));
  } catch { return []; }
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
    return { ok: false, message: 'With Claude Code as the model, run AutoDE\'s agents in Claude Code itself: `autode plugin install --host claude`, then ask it to continue this problem (the autode-core-orchestrator skill). Or pick another model in AutoDE\'s settings.', outputs: [] };
  }
  const probe = assignmentFor(scope, stageId, []);
  if (!probe.assignment) return { ok: false, message: probe.reason ?? `No assignment for ${stageId}.`, outputs: [] };
  // Checked before the model is called: an agent given nothing to work on can only write open questions.
  const notReady = stageReadiness({ workspaceRoot: scope.workspaceRoot, problemRoot, kind: stage.kind });
  if (notReady.length) return { ok: false, message: `${stageId} isn't ready for an agent:\n- ${notReady.join('\n- ')}`, outputs: [] };
  const role = probe.assignment.role;
  const engine = host.createEngine(`${role} (VS Code)`);
  if (!engine?.listTools || !engine.toolSetNamed) return { ok: false, message: 'AutoDE\'s engine is not available (open a workspace folder).', outputs: [] };
  const who: Actor = { kind: 'agent', name: role, host: 'VS Code' };
  try {
    const a: Assignment = assignmentFor(scope, stageId, await engine.listTools(), { gaps: await stageGaps(engine, problemRoot, stage.kind, stage.title) }).assignment!;
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
    if (isDocumentStage(a.stage.kind)) {
      // Notes alone are not the document: the stage succeeds only if its document was recorded.
      const file = stageDocumentFile(problemRoot, a.stage.kind);
      const doc = file && path.relative(scope.workspaceRoot, file).split(path.sep).join('/');
      if (doc && !outputs.includes(doc)) return { ok: false, message: `${role} finished without drafting ${stageId}'s document (${doc}); it recorded ${outputs.join(', ')}. Its reply:\n${summary}`, outputs, summary };
      return { ok: true, message: `${role} drafted ${stageId}'s document. Review it and approve it (Approve… on the stage) to complete the stage.`, outputs, summary };
    }
    const done = completeStage(ctx, stageId, { outputs, summary, who, channel: 'panel' });
    return { ok: true, message: done.message, outputs, decisionId: done.decisionId, summary };
  } catch (err) {
    const message = err instanceof WorkflowError || err instanceof Error ? err.message : String(err);
    return { ok: false, message: `${role} couldn't finish ${stageId}: ${message}`, outputs: [] };
  } finally {
    await engine.dispose();
  }
}

/**
 * A knowledge-maintenance item, worked by the role it names (MM2; §5.6): the
 * work order `autode_maintenance_next` gives a host agent, run with the
 * panel's model at the propose tier. A person starts it (policy `suggest`),
 * or AutoDE does at a stage boundary within the budget (`draft`). The agent
 * proposes; nothing is approved here.
 */
export async function runMaintenance(host: ExecutorHost, scope: Pick<StageRunScope, 'workspaceRoot' | 'resourcesRoot'>, item: MaintenanceItem): Promise<{ ok: boolean; message: string }> {
  if (host.activeProvider() === 'claude') return { ok: false, message: 'With Claude Code as the model, work on it in Claude Code: ask it to take the next AutoDE maintenance item (autode_maintenance_next).' };
  const engine = host.createEngine(`${item.agent} (VS Code)`);
  if (!engine?.listTools || !engine.toolSetNamed) return { ok: false, message: 'AutoDE\'s engine is not available (open a workspace folder).' };
  try {
    const a = maintenanceAssignment(scope.resourcesRoot, scope.workspaceRoot, item, await engine.listTools());
    if (!a.assignment) return { ok: false, message: a.reason ?? 'No agent for this item.' };
    host.log(`${a.assignment.role}: ${item.title} — ${a.assignment.engineTools.length} AutoDE tools.`);
    const { text } = await host.runAgentWithTools(
      'Work on this maintenance item now. Propose what it needs; then reply with a short summary for the person who approves it: what you proposed, where it is approved, and anything uncertain.',
      { systemPrompt: a.assignment.text, toolExecutionMode: 'read-only', engineTools: await engine.toolSetNamed(a.assignment.engineTools), justification: `AutoDE ${a.assignment.role}: ${item.title}` }
    );
    return { ok: true, message: text.trim().slice(0, 4000) || `${a.assignment.role} finished.` };
  } catch (err) {
    return { ok: false, message: `${item.agent} couldn't finish: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await engine.dispose();
  }
}

/**
 * A task a person hands to an agent from the chat (v0.52.1): the role's
 * work order, run with the panel's model at the propose tier. Started by the
 * person (Run it, or an `@agent` message); the agent proposes, nothing is
 * approved here. Stage work never comes here: it goes through its stage.
 */
export async function runHandoff(host: ExecutorHost, scope: Pick<StageRunScope, 'workspaceRoot' | 'resourcesRoot'>, role: string, task: string): Promise<{ ok: boolean; message: string }> {
  if (host.activeProvider() === 'claude') return { ok: false, message: `With Claude Code as the model, ask Claude Code itself: "@${role} ${task}" (the plugin installs AutoDE's agents there).` };
  const engine = host.createEngine(`${role} (VS Code)`);
  if (!engine?.listTools || !engine.toolSetNamed) return { ok: false, message: 'AutoDE\'s engine is not available (open a workspace folder).' };
  try {
    const w = workOrder(scope.resourcesRoot, scope.workspaceRoot, role, { title: `Task from the chat: ${task.slice(0, 80)}`, body: `## The task\n${task}`, closing: 'Reply with what you found or proposed and where a person approves it.' }, await engine.listTools());
    if (!w.order) return { ok: false, message: w.reason ?? `No agent ${role}.` };
    host.log(`${role}: ${task.slice(0, 80)} — ${w.order.engineTools.length} AutoDE tools.`);
    const { text } = await host.runAgentWithTools(task, { systemPrompt: w.order.text, toolExecutionMode: 'read-only', engineTools: await engine.toolSetNamed(w.order.engineTools), justification: `AutoDE ${role}: ${task.slice(0, 80)}` });
    return { ok: true, message: text.trim().slice(0, 6000) || `${role} finished.` };
  } catch (err) {
    return { ok: false, message: `${role} couldn't finish: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await engine.dispose();
  }
}
