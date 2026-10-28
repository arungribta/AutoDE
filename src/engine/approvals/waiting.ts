import { DecisionStore, Decision } from '../decisions/decisionStore';
import { FactView } from '../context/factReview';
import { layoutPath } from '../workspaceLayout';
import { statusFor } from '../workflows/service';
import { readWorkflow } from '../workflows/instance';
import { isDocumentStage } from '../workflows/documentApproval';
import { listRunbooks, Runbook } from '../runner/runbook';
import { semanticWaiting } from '../semantic/store';

/**
 * Waiting for you (v0.45.7, SIMP-1): everything that waits for a person, in
 * one list, whatever mechanism records it — a pending decision (a workflow, a
 * stage gate, a runbook, a connection, a proposal), facts to review in the
 * Context Inbox, a stage document to approve, a runbook that needs its second
 * approver. Each item says where and how it is approved; approving still goes
 * through that mechanism's own code, so nothing is approved twice or by a
 * second rulebook.
 */

export type WaitingKind = 'decision' | 'facts' | 'stage-document' | 'runbook' | 'semantic';

export interface WaitingItem {
  /** Stable: `decision:<id>`, `facts:<problem>`, `stage:<problem>/<stage>`, `runbook:<problem>/<id>`. */
  key: string;
  kind: WaitingKind;
  title: string;
  detail: string;
  stakes: 'low' | 'high';
  problemId?: string;
  since?: string;
  /** Where to open it in VS Code. */
  opens: { view: 'decision' | 'inbox' | 'workflow-stage' | 'workflow' | 'runbook' | 'file'; ref?: string };
  /** The command that approves it in a terminal (a person, at an interactive terminal). */
  cli: string;
}

export interface WaitingInput {
  workspaceRoot: string;
  resourcesRoot: string;
  /** The active problem (its stages, runbooks and facts); decisions of every problem are listed. */
  problemId?: string;
  /** The Context Inbox's facts (proposed or needing review), from the caller's ledger. */
  facts?: readonly FactView[];
}

function decisionItem(d: Decision, store: DecisionStore): WaitingItem {
  let opens: WaitingItem['opens'] = { view: 'decision', ref: d.id };
  let cli = `autode decisions approve ${d.id}`;
  if (d.kind === 'workflow') { opens = { view: 'workflow' }; cli = 'autode workflow approve'; }
  else if (d.kind === 'gate') { const stage = d.subject?.document?.replace(/^workflow:/, ''); opens = { view: 'workflow-stage', ref: stage }; if (stage) cli = `autode workflow approve ${stage}`; }
  else if (d.kind === 'runbook') { const rb = store.proposal<Runbook>(d.id); opens = { view: 'runbook', ref: rb.id }; cli = `autode runbook approve ${rb.id}`; }
  return { key: `decision:${d.id}`, kind: 'decision', title: d.title, detail: `${d.kind} decision ${d.id}${d.summary ? `: ${d.summary}` : ''}`, stakes: d.stakes, problemId: d.problemId, since: d.proposedAt, opens, cli };
}

export function waitingForYou(input: WaitingInput): WaitingItem[] {
  const store = new DecisionStore(input.workspaceRoot);
  const items: WaitingItem[] = store.list({ status: 'pending' }).map((d) => decisionItem(d, store));
  const facts = input.facts ?? [];
  if (facts.length) {
    const high = facts.filter((f) => f.stakes === 'high').length;
    items.push({
      key: `facts:${input.problemId ?? 'workspace'}`, kind: 'facts', title: `${facts.length} fact(s) to review`,
      detail: `${high} high stakes (keys, grain, relationships, rules, metrics), ${facts.length - high} low. Confirm, correct or reject them in the Context Inbox.`,
      stakes: high ? 'high' : 'low', problemId: input.problemId, opens: { view: 'inbox' }, cli: 'autode facts list, then autode facts confirm <id>'
    });
  }
  if (input.problemId) {
    const problemRoot = layoutPath(input.workspaceRoot, 'problems', input.problemId);
    const w = readWorkflow(problemRoot);
    if (w && w.status === 'approved') {
      try {
        const st = statusFor({ workspaceRoot: input.workspaceRoot, resourcesRoot: input.resourcesRoot, problemId: input.problemId });
        for (const v of st.stages) {
          const s = w.stages.find((x) => x.id === v.id);
          if (!s || v.status !== 'awaiting-approval' || s.record.decisionId || !isDocumentStage(s.kind)) continue;
          items.push({ key: `stage:${input.problemId}/${s.id}`, kind: 'stage-document', title: `Approve ${s.title}`, detail: `The ${s.kind} stage's document is drafted and waits for your review.`, stakes: 'high', problemId: input.problemId, opens: { view: 'workflow-stage', ref: s.id }, cli: `autode workflow approve ${s.id}` });
        }
      } catch { /* a workflow that can't be read is reported by the workflow view */ }
    }
    for (const r of listRunbooks(problemRoot).filter((x) => x.status === 'awaiting-second-approval')) {
      items.push({ key: `runbook:${input.problemId}/${r.runbook.id}`, kind: 'runbook', title: `Second approval: ${r.runbook.title}`, detail: `${r.environment} needs a second approver; approved so far by ${r.approvals.map((a) => a.by).join(', ')}.`, stakes: 'high', problemId: input.problemId, since: r.approvals[0]?.at, opens: { view: 'runbook', ref: r.runbook.id }, cli: `autode runbook approve ${r.runbook.id}` });
    }
  }
  // C5a: shared semantic models not approved at their current revision (workspace-level), and the problem's stale composites.
  try {
    for (const s of semanticWaiting(input.workspaceRoot, input.problemId)) items.push({ key: s.key, kind: 'semantic', title: s.title, detail: s.detail, stakes: 'high', problemId: input.problemId, opens: { view: 'file', ref: s.file }, cli: s.cli });
  } catch { /* an unreadable semantic folder is reported by the editor */ }
  // High stakes first, then oldest first.
  return items.sort((a, b) => (a.stakes === b.stakes ? 0 : a.stakes === 'high' ? -1 : 1) || String(a.since ?? '').localeCompare(String(b.since ?? '')));
}
