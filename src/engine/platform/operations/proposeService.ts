import { Decision, DecisionStore, Proposer } from '../../decisions/decisionStore';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PlatformFilePayload, propose } from '../../decisions/proposals';
import { loadCatalog } from './load';
import { OperationProposalInput, PreparedProposal, prepareOperationProposal, writeOperationProposal } from './proposal';

export class OperationProposalError extends Error {
  public constructor(public readonly problems: string[], public readonly prepared: PreparedProposal) {
    super(`The operation can't be proposed: ${problems.join(' ')}`);
    this.name = 'OperationProposalError';
  }
}

/**
 * POP3: checks an agent's (or a person's) operation, writes it under `proposed/` and files the decision for its
 * exact checksum. An older pending proposal of the same operation is superseded: the reviewer sees one.
 */
export function proposeOperation(scope: { resourcesRoot?: string; workspaceRoot: string }, input: OperationProposalInput, proposer: Proposer): { decision: Decision; prepared: PreparedProposal; superseded: string[] } {
  const prepared = prepareOperationProposal(scope, input);
  if (prepared.problems.length || !prepared.op) throw new OperationProposalError(prepared.problems, prepared);
  const store = new DecisionStore(scope.workspaceRoot);
  const superseded: string[] = [];
  const id = prepared.op.id;
  const approvedFile = loadCatalog(scope).operations.find((o) => o.item.id === id && o.status === 'approved')?.file;
  for (const d of store.list({ status: 'pending', kind: 'platform_operation' })) {
    const p = store.proposal<PlatformFilePayload>(d.id);
    if (!p || (p.operation ?? operationOfFile(p.file)) !== id) continue;
    store.markSuperseded(d.id, 'A newer proposal of the same operation replaces it.');
    superseded.push(d.id);
    // Its draft file goes too (never the file in effect), so the catalog shows one proposal.
    if (/\/proposed\//.test(p.file) && p.file !== approvedFile && p.file !== prepared.file) { try { fs.unlinkSync(path.join(scope.workspaceRoot, p.file)); } catch { /* already gone */ } }
  }
  const { file, checksum } = writeOperationProposal(scope.workspaceRoot, prepared);
  const payload: PlatformFilePayload = { file, checksum, operation: id, reason: input.reason.trim(), ...(input.fixes ? { fixes: input.fixes } : {}), ...(prepared.resembles.length ? { resembles: prepared.resembles.map((r) => r.id) } : {}) };
  const decision = propose(store, { workspaceRoot: scope.workspaceRoot, resourcesRoot: scope.resourcesRoot }, 'platform_operation', payload, { proposedBy: proposer });
  return { decision, prepared, superseded };
}

/** The pending proposals of one operation (or all), for the catalog's operation page. */
export function pendingOperationProposals(workspaceRoot: string, operationId?: string): Array<{ decision: string; title: string; file: string; reason?: string; fixes?: string; resembles: string[]; proposedBy?: string; at: string }> {
  const store = new DecisionStore(workspaceRoot);
  return store.list({ status: 'pending', kind: 'platform_operation' }).flatMap((d) => {
    const p = store.proposal<PlatformFilePayload>(d.id);
    if (!p || !/\/platform-operations\//.test(p.file)) return [];
    const id = p.operation ?? operationOfFile(p.file);
    if (operationId && id !== operationId) return [];
    return [{ decision: d.id, title: d.title, file: p.file, ...(p.reason ? { reason: p.reason } : {}), ...(p.fixes ? { fixes: p.fixes } : {}), resembles: p.resembles ?? [], ...(d.proposedBy ? { proposedBy: [d.proposedBy.host, d.proposedBy.client].filter(Boolean).join(' ') } : {}), at: d.proposedAt }];
  });
}

/** The operation id a team file is named for: `<id>.yaml`, or a proposal's `<id>.<hash>.yaml`. */
function operationOfFile(file: string): string {
  return file.split('/').pop()!.replace(/\.ya?ml$/, '').replace(/\.[0-9a-f]{8}$/, '');
}
