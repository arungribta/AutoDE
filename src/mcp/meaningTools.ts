import { EngineTool, ToolAnnotations } from './tools';
import { EngineToolError } from './errors';
import { AssertionLedger } from '../engine/context/ledger';
import { recordChatProposals } from '../engine/context/chatExtraction';
import type { Assertion } from '../engine/context/assertions';
import { governanceFacts } from '../engine/governance/governance';
import { columnPolicies, loadPolicies } from '../engine/governance/policies';
import { qualityCandidates, qualityProposals } from '../engine/quality/candidates';
import { WorkspaceGraph, workspaceMeaning } from '../engine/ontology/service';
import { layoutPath } from '../engine/workspaceLayout';

/**
 * Reasoning through meaning over MCP (ONT2; docs/specs/context-layer.md §6.8, §11): quality-rule candidates from what
 * is known (keys, grain, relationships, classifications, a concept's hints), proposed as facts a person confirms; and
 * the team's policies with the columns each applies to. Resolution through concepts is in autode_resolve; matching
 * through meaning in autode_match_columns.
 */

const read = (title: string): ToolAnnotations => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

export function meaningTools(clientName: () => string | undefined): EngineTool[] {
  const candidates = async (ws: Parameters<EngineTool['handler']>[1], tables?: string[]) => {
    const src = await ws.contextSources();
    const idx = workspaceMeaning({ workspaceRoot: ws.options.workspaceRoot, resourcesRoot: ws.options.resourcesRoot }, src as unknown as { graph: WorkspaceGraph; assertions: Assertion[] });
    return qualityCandidates(idx, tables?.length ? { tables } : {});
  };
  return [
    {
      name: 'autode_quality_candidates',
      description: 'Quality-rule candidates from what AutoDE knows, deterministic, each with its reason and the facts it rests on: a key is unique and never null (confirmed key facts and declared primary keys); a grain is unique; a relationship\'s columns reference the other table (confirmed relationships and declared foreign keys); an e-mail column classified personal data has an e-mail\'s pattern; and a concept\'s hints for the columns that are its attributes, in tables that represent it (a payment\'s date is never null, its amount above zero). Candidates already recorded as quality facts carry existing. Propose the ones that hold with autode_propose_quality_rules.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { tables: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Only these tables (ids or fully qualified names).' } } },
      annotations: read('Quality-rule candidates'),
      handler: async (args, ws) => ({ candidates: await candidates(ws, args.tables as string[] | undefined) })
    },
    {
      name: 'autode_propose_quality_rules',
      description: 'Propose quality-rule candidates (as autode_quality_candidates lists them; give each one\'s subject and check) as quality facts for the Context Inbox: documented when they rest on a fact or a declared key, inferred when they come from a concept\'s hint. A person confirms each; nothing is applied until then. Candidates already recorded are skipped.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['rules'], properties: { rules: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['subject', 'check'], properties: { subject: { type: 'string', minLength: 1 }, check: { type: 'string', minLength: 1 } } } } } },
      annotations: { title: 'Propose quality rules', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args, ws) => {
        const all = await candidates(ws);
        const wanted = args.rules as Array<{ subject: string; check: string }>;
        const chosen = wanted.map((w) => all.find((c) => c.subject === w.subject && c.check === w.check));
        const missing = wanted.filter((_w, i) => !chosen[i]);
        if (missing.length) throw new EngineToolError('VALIDATION_FAILED', `Not a candidate: ${missing.map((m) => `${m.subject} ${m.check}`).join('; ')} (autode_quality_candidates lists them).`);
        const proposals = qualityProposals(chosen.filter((c): c is NonNullable<typeof c> => !!c), `mcp:${clientName() ?? 'client'}`, ws.activeProblemId());
        const ledger = new AssertionLedger(layoutPath(ws.options.workspaceRoot, 'ledger'));
        await ledger.load();
        const outcome = { proposed: proposals, dropped: [] as string[], duplicates: [] as string[] };
        const { recorded } = await recordChatProposals(ledger, outcome);
        return { proposed: recorded.map((a) => ({ id: a.id, statement: a.statement, trust: a.trust })), duplicates: outcome.duplicates.length + (chosen.length - proposals.length), next: 'A person confirms them in the AutoDE Context Inbox. Tell the user.' };
      }
    },
    {
      name: 'autode_policies',
      description: 'The team\'s policies (.autode/config/policies.yaml: a regulation, the classifications it covers, the controls it requires: masking, retention, access) and, for every classified column, the policies that apply to it. The governance check of a Pipeline Spec runs on them: a masking duty unmet is an error, retention and access are reported as owed.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: read('Policies and the columns they apply to'),
      handler: async (_args, ws) => {
        const p = loadPolicies(ws.options.workspaceRoot);
        const facts = governanceFacts((await ws.contextSources()).assertions);
        return { file: '.autode/config/policies.yaml', policies: p.policies, errors: p.errors, columns: columnPolicies(facts, p.policies) };
      }
    }
  ];
}
