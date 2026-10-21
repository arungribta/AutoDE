import * as fs from 'node:fs';
import { parseBusinessProblemSpec, readProblemDocument } from '../documents/problemDocuments';
import { Decision, DecisionStore, Proposer } from '../decisions/decisionStore';
import { ProposalContext, applyDecision, propose } from '../decisions/proposals';
import { layoutPath } from '../workspaceLayout';
import { WorkflowInstance, diffWorkflow, draftWorkflow, readWorkflow, sourceSystems, workflowFacts, writeWorkflow } from './instance';
import { WorkflowTemplate, loadTemplates, suggestTemplate } from './templates';
import { WorkflowStatus, syncWorkflow } from './runtime';

/**
 * What every surface calls for workflows (PA3a): the panel, `autode workflow`
 * and the MCP workflow tools. One implementation, so they report the same.
 */

export interface WorkflowScope {
  workspaceRoot: string;
  /** Where the bundled `workflows/` live: the extension's or the package's root. */
  resourcesRoot: string;
  problemId: string;
}

export function problemRootOf(scope: WorkflowScope): string {
  return layoutPath(scope.workspaceRoot, 'problems', scope.problemId);
}

export function templatesFor(scope: Pick<WorkflowScope, 'workspaceRoot' | 'resourcesRoot'>): { templates: WorkflowTemplate[]; errors: string[] } {
  return loadTemplates(scope.resourcesRoot, scope.workspaceRoot);
}

/** The template AutoDE suggests for this problem, from its specification and the estate. */
export function suggestFor(scope: WorkflowScope): { id: string; reason: string } | undefined {
  const root = problemRootOf(scope);
  const text = readProblemDocument(root, 'spec') ?? '';
  let specText = text;
  let legacyHint = '';
  try { const spec = parseBusinessProblemSpec(text); specText = [spec.problemStatement, ...spec.objectives, ...spec.scope.in, spec.domain ?? ''].join(' '); legacyHint = spec.implementationType === 'brownfield' ? ' modernization' : ''; } catch { /* no spec yet */ }
  return suggestTemplate(templatesFor(scope).templates, specText + legacyHint, workflowFacts(scope.workspaceRoot, root));
}

/**
 * The problem's workflow, creating the deterministic draft when there is none
 * (this also migrates problems from before PA3a: brownfield → modernization,
 * greenfield → greenfield). An approved workflow is never replaced here.
 */
export function ensureWorkflow(scope: WorkflowScope, templateId?: string): WorkflowInstance {
  const root = problemRootOf(scope);
  if (!fs.existsSync(root)) throw new Error(`No business problem "${scope.problemId}".`);
  const current = readWorkflow(root);
  if (current && (current.status !== 'draft' || !templateId || current.template.id === templateId)) return current;
  return redraft(scope, templateId);
}

/** A fresh deterministic draft (status `draft`) from a template; refused when the workflow is approved — re-plan through a proposal. */
export function redraft(scope: WorkflowScope, templateId?: string): WorkflowInstance {
  const root = problemRootOf(scope);
  const current = readWorkflow(root);
  if (current && current.status === 'approved') throw new Error('The workflow is approved; re-plan by proposing a revised workflow.');
  const { templates, errors } = templatesFor(scope);
  const id = templateId ?? suggestFor(scope)?.id ?? 'greenfield';
  const template = templates.find((t) => t.id === id);
  if (!template) throw new Error(`No workflow template "${id}" (known: ${templates.map((t) => t.id).join(', ') || 'none'})${errors.length ? `; template errors: ${errors.join('; ')}` : ''}.`);
  const w = draftWorkflow(template, scope.problemId, workflowFacts(scope.workspaceRoot, root), sourceSystems(scope.workspaceRoot));
  writeWorkflow(root, w);
  return w;
}

export function statusFor(scope: WorkflowScope): WorkflowStatus {
  ensureWorkflow(scope);
  return syncWorkflow({ workspaceRoot: scope.workspaceRoot, problemRoot: problemRootOf(scope), problemId: scope.problemId })!;
}

function proposalContext(scope: WorkflowScope): ProposalContext {
  return { workspaceRoot: scope.workspaceRoot, problemRoot: problemRootOf(scope), problemId: scope.problemId, resourcesRoot: scope.resourcesRoot };
}

/** Proposes a workflow (the draft, or the planner's refinement) as a decision; the plan gate. */
export function proposeWorkflow(scope: WorkflowScope, w: WorkflowInstance, proposedBy: Proposer): Decision {
  const store = new DecisionStore(scope.workspaceRoot);
  // A newer proposal replaces an older pending one for the same problem.
  for (const d of store.list({ status: 'pending', kind: 'workflow' })) if (d.problemId === scope.problemId) store.withdraw(d.id, 'autode', 'replaced by a newer workflow proposal');
  const d = propose(store, proposalContext(scope), 'workflow', { ...w, status: 'proposed' }, { proposedBy });
  const root = problemRootOf(scope);
  const current = readWorkflow(root);
  if (!current || current.status !== 'approved') writeWorkflow(root, { ...w, status: 'proposed' });
  return d;
}

/** A person approves a workflow decision through a channel that allows it (panel, CLI, file); the engine applies it. */
export async function approveWorkflow(scope: WorkflowScope, decisionId: string, by: string, channel: 'panel' | 'cli', note?: string): Promise<string> {
  const store = new DecisionStore(scope.workspaceRoot);
  store.resolve(decisionId, { decision: 'approved', by, channel, note });
  const r = await applyDecision(store, decisionId, proposalContext(scope));
  return r.message;
}

export { diffWorkflow };
