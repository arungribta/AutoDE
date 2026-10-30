import { unreviewedTurns } from '../engine/maintenance/turns';
import { markInterviewFed } from '../engine/interview/state';
import { buildSchemaIndex } from '../engine/grounding/sqlGrounding';
import { Decision, DecisionError, DecisionStore } from '../engine/decisions/decisionStore';
import { ProposalContext, ProposalKind, ProposalValidationError, applyDecision, processResolved, propose } from '../engine/decisions/proposals';
import { EngineTool } from './tools';
import { AssertionLedger, NewAssertion } from '../engine/context/ledger';
import { createSubjectResolver, isMirror } from '../engine/context/projection';
import { recordChatProposals } from '../engine/context/chatExtraction';
import { createProbeResolver, createSqlProbeExecutor, verifyAssertions, ProbeDialect } from '../engine/context/probes';
import { fragmentsFor } from '../engine/platform/dialects';
import { stakesFor } from '../engine/decisions/decisionStore';
import { validateAssertionProposal } from '../engine/decisions/proposals';
import { layoutPath } from '../engine/workspaceLayout';
import { EngineToolError } from './errors';
import { EngineWorkspace } from './workspace';
import { PlatformSession } from './platform';
import { admitForMode, problemMode, recordAssumption } from '../engine/documents/problemMode';
import { dismissedStatements, unrecordedStatements } from '../engine/context/sessionReview';
import { packSampleExecutor, problemCandidates, problemCoverage } from '../engine/context/capture';
import { describeFinding } from '../engine/context/dataCandidates';
import { renderCoverage } from '../engine/context/coverage';
import { combineProbeExecutors } from '../engine/context/probes';
import { ASSERTION_KINDS } from '../engine/context/assertions';

/**
 * Phase PA1 tools (docs/specs/mcp-engine.md §9.2): agents propose
 * changes, never make them. A proposal is validated, then becomes a pending
 * decision in `.autode/decisions/`. Low-stakes decisions may be resolved here
 * (the tool is destructive, so the host asks its user); high-stakes ones only
 * by a person — the AutoDE panel, the CLI in a terminal, or a committed
 * decision file. Approved decisions are applied by engine code.
 */

export interface DecisionToolsOptions {
  session: PlatformSession;
  /** The MCP client's name from `initialize`, recorded as the proposer. */
  clientName: () => string | undefined;
}

const evidenceSchema = {
  type: 'array', maxItems: 20,
  items: { type: 'object', required: ['ref'], additionalProperties: false, properties: { ref: { type: 'string', minLength: 1 }, quote: { type: 'string', maxLength: 300 } } },
  description: 'Where the proposal comes from (file and line, document section, query id) — shown to the reviewer.'
};
const proposerProps = {
  skill: { type: 'string', description: 'The skill that produced the proposal, if any.' },
  model: { type: 'string', description: 'The model that produced it, if you know it.' },
  evidence: evidenceSchema
};

function view(d: Decision): Record<string, unknown> {
  return {
    id: d.id, kind: d.kind, title: d.title, summary: d.summary, stakes: d.stakes, status: d.status, problemId: d.problemId,
    proposedBy: d.proposedBy, proposedAt: d.proposedAt, allowedChannels: d.allowedChannels,
    validation: d.validation, resolution: d.resolution.decision ? d.resolution : undefined,
    file: `.autode/decisions/${d.id}.yaml`
  };
}

function toToolError(err: unknown): never {
  if (err instanceof ProposalValidationError) {
    throw new EngineToolError('VALIDATION_FAILED', err.message, { errors: err.report.errors, warnings: err.report.warnings, checked: err.report.checks });
  }
  if (err instanceof DecisionError) {
    const code = err.code === 'NOT_FOUND' ? 'NOT_FOUND' : err.code === 'CHANNEL_NOT_ALLOWED' ? 'PERMISSION_DENIED' : 'VALIDATION_FAILED';
    throw new EngineToolError(code, err.message, err.details);
  }
  throw err;
}

export function decisionTools(options: DecisionToolsOptions): EngineTool[] {
  const { session } = options;
  const store = (ws: EngineWorkspace) => new DecisionStore(ws.options.workspaceRoot);
  const context = async (ws: EngineWorkspace, withSchema = false): Promise<ProposalContext> => ({
    workspaceRoot: ws.options.workspaceRoot,
    problemRoot: ws.problemRoot(),
    problemId: ws.activeProblemId(),
    connections: session.config().connections,
    schemaIndex: withSchema ? await ws.contextSources().then((src) => buildSchemaIndex(src.graph.nodes, src.graph.edges)) : undefined
  });
  const deps = () => ({});
  // Decisions resolved in their files (or in the panel) are applied before any answer.
  const sync = async (ws: EngineWorkspace) => processResolved(store(ws), await context(ws), deps());

  const proposalTool = (name: string, kind: ProposalKind, title: string, description: string, payloadKey: string, payloadSchema: Record<string, unknown>, withSchema = false): EngineTool => ({
    name,
    description: `${description} Nothing changes until a person approves the resulting decision; validation errors come back item by item so you can fix and resubmit.`,
    inputSchema: { type: 'object', required: [payloadKey], additionalProperties: false, properties: { [payloadKey]: payloadSchema, ...proposerProps } },
    // Writes a pending decision only; never the proposed change.
    annotations: { title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (args, ws) => {
      try {
        const d = propose(store(ws), await context(ws, withSchema), kind, args[payloadKey], {
          proposedBy: { host: 'mcp', client: options.clientName(), skill: args.skill as string | undefined, model: args.model as string | undefined },
          evidence: args.evidence as Decision['evidence'] | undefined
        });
        // v0.45.12: a specification proposed from the interview closes it; the panel then doesn't resume it.
        const root = ws.problemRoot();
        const spec = args[payloadKey] as { id?: string; version?: number } | undefined;
        if (kind === 'spec_revision' && d.validation.ok && root && spec) markInterviewFed(root, { id: String(spec.id ?? d.id), version: Number(spec.version ?? 0) }, 'mcp');
        return { decision: view(d), next: d.stakes === 'low' ? 'Ask the user, then resolve it with autode_resolve_decision, or leave it for the AutoDE panel.' : `A person must approve it: in the AutoDE panel (Decisions), or by editing ${`.autode/decisions/${d.id}.yaml`} and committing. Tell the user.` };
      } catch (err) { return toToolError(err); }
    }
  });

  return [
    {
      // C4b: facts go through the ledger's own gate (proposed → confirmed by a person), not a decision file.
      name: 'autode_propose_assertion',
      description: 'Propose a fact for AutoDE\'s context (a business term, key, grain, relationship, rule, metric, a classification, or catalog metadata on an asset — kind metadata, predicate tag {key, value}, owner {role: business_owner|technical_owner|data_steward, person}, domain {domain}, certification {status: verified|draft|deprecated}, property {name, value}), with evidence. It is recorded as proposed — seen by conflict detection and context gaps, used by nothing until confirmed. Glossary terms, naming conventions and assumptions are low stakes (autode_review_assertion after asking the user); anything that changes joins, keys, grain, rules or metrics is confirmed by a person in the AutoDE Context Inbox. A fact that corrects an earlier one (same kind, subject and predicate) replaces it once confirmed.',
      inputSchema: { type: 'object', required: ['assertion'], additionalProperties: false, properties: {
        assertion: { type: 'object', required: ['kind', 'subject', 'predicate', 'statement', 'evidence'], properties: { kind: { type: 'string' }, subject: { type: 'array', items: { type: 'string' }, minItems: 1 }, predicate: { type: 'string' }, value: {}, statement: { type: 'string' }, evidence: { type: 'array', minItems: 1, items: { type: 'object', required: ['type', 'ref'], properties: { type: { type: 'string' }, ref: { type: 'string' }, excerpt: { type: 'string' } } } }, specId: { type: 'string' } } },
        skill: { type: 'string', description: 'The skill that produced the proposal, if any.' },
        model: { type: 'string', description: 'The model that produced it, if you know it.' }
      } },
      annotations: { title: 'Propose a fact', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args, ws) => {
        const p = args.assertion as NewAssertion;
        const report = validateAssertionProposal(p);
        if (!report.ok) throw new EngineToolError('VALIDATION_FAILED', `The fact did not pass validation: ${report.errors.join('; ')}`, { errors: report.errors, checked: report.checks });
        const src = await ws.contextSources();
        const resolve = createSubjectResolver(src.graph as Parameters<typeof createSubjectResolver>[0]);
        const refs = p.subject.map((x) => String(x));
        const unresolved = refs.filter((r) => !resolve(r));
        const by = [options.clientName(), args.skill ? `skill:${String(args.skill)}` : '', args.model ? `model:${String(args.model)}` : ''].filter(Boolean).join(':');
        const ledger = new AssertionLedger(layoutPath(ws.options.workspaceRoot, 'ledger'));
        await ledger.load();
        const outcome = { proposed: [{ kind: p.kind, subject: refs.map((r) => resolve(r) ?? r), predicate: p.predicate, value: p.value ?? {}, statement: p.statement, evidence: p.evidence, specId: p.specId, trust: 'inferred' as const, status: 'proposed' as const, createdBy: `mcp:${by || 'client'}`, ...(args.model ? { model: String(args.model) } : {}), ...(unresolved.length ? { flags: ['unresolved_subject'] } : {}) }], dropped: [], duplicates: [] as string[] };
        // C4c: in an exploration problem a proposal counts at once, at assumed trust.
        const mode = problemMode(ws.problemRoot());
        const { recorded, corrections } = await recordChatProposals(ledger, outcome, { admit: (x) => admitForMode(x, mode) });
        if (!recorded.length) return { duplicate: true, message: 'AutoDE already holds this fact (same kind, subject, predicate and value); nothing was added.' };
        const a = recorded[0];
        const stakes = stakesFor('assertion', a);
        if (a.status === 'active') return { assertion: { id: a.id, kind: a.kind, subject: a.subject, predicate: a.predicate, statement: a.statement, status: a.status, trust: a.trust, flags: a.flags }, stakes, next: 'This problem is in exploration mode: the fact counts now, at assumed trust. A person confirms it before the problem is governed.' };
        return {
          assertion: { id: a.id, kind: a.kind, subject: a.subject, predicate: a.predicate, statement: a.statement, status: a.status, trust: a.trust, flags: a.flags, supersedes: a.supersedes },
          stakes, corrects: corrections[0]?.supersedes,
          next: stakes === 'low' ? 'Ask the user, then confirm or reject it with autode_review_assertion — or leave it for the AutoDE Context Inbox.' : 'A person confirms it in the AutoDE Context Inbox. Tell the user.'
        };
      }
    },
    proposalTool('autode_propose_spec_change', 'spec_revision', 'Propose a specification revision',
      'Propose a revised Business Problem Specification for the active problem (the full document, as the autode://spec/business-problem resource reads). Approved, it becomes the new draft; the specification is then approved in AutoDE as usual.',
      'spec', { type: 'object', required: ['problemStatement', 'objectives', 'scope'] }),
    proposalTool('autode_propose_pipeline_spec', 'pipeline_spec', 'Propose a Pipeline Spec',
      'Propose a Pipeline Spec for the active problem (validate it first with autode_validate_pipeline_spec). Approved, it becomes the new draft.',
      'pipelineSpec', { type: 'object' }),
    proposalTool('autode_propose_runbook', 'runbook', 'Propose a runbook',
      'Propose a runbook: the steps that change a data platform for the active problem (deploy a model, set up roles, load data), in order. Each step is one SQL statement on the connection, a Snowflake or Databricks CLI command as an argument list (no shell, no profile or credential flags: AutoDE adds the connection\'s profile), or a Databricks bundle folder; with what it is expected to do and, for anything destructive, its rollback. AutoDE classifies every step itself (read, change, destructive), checks commands against its allowlist and paths against the workspace, and applies the team\'s policy for the connection\'s environment. Once a person approves it, AutoDE\'s runner runs it step by step in VS Code; you never run it.',
      'runbook', { type: 'object', required: ['id', 'title', 'reason', 'connectionId', 'steps'], properties: { id: { type: 'string', minLength: 2 }, title: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 }, connectionId: { type: 'string', minLength: 1 }, stage: { type: 'string' }, explanation: { type: 'string' }, steps: { type: 'array', minItems: 1, items: { type: 'object', required: ['id', 'title', 'kind', 'expect'], properties: { id: { type: 'string', minLength: 1 }, title: { type: 'string', minLength: 1 }, kind: { type: 'string', enum: ['sql', 'cli', 'bundle'] }, sql: { type: 'string' }, argv: { type: 'array', items: { type: 'string' } }, folder: { type: 'string' }, target: { type: 'string' }, expect: { type: 'string', minLength: 1 }, noRollbackReason: { type: 'string' }, timeoutSec: { type: 'integer', minimum: 1, maximum: 3600 }, rollback: { type: 'object', properties: { procedure: { type: 'string' }, steps: { type: 'array', items: { type: 'object' } } } } } } } } }),
    proposalTool('autode_propose_semantic_model', 'semantic_model', 'Propose a semantic model',
      'Propose a shared semantic model (scope shared: <artifactDirectory>/semantic/<name>.yaml, Snowflake semantic model YAML, no extra keys) or a composite of the active problem (scope composite: autode: semantic-composite/1, using shared models; it may add metrics, filters and verified queries and change descriptions and synonyms, never a shared expression, key or join). Give the whole file. Draft from knowledge first (autode_semantic_draft) and check it (autode_semantic_check). A shared model is workspace-wide: a person approves it, and approving the proposal approves that version.',
      'semanticModel', { type: 'object', required: ['scope', 'name', 'content'], additionalProperties: false, properties: { scope: { type: 'string', enum: ['shared', 'composite'] }, name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_-]*$' }, content: { type: 'string', minLength: 1 } } }),
    proposalTool('autode_propose_article', 'article', 'Propose a knowledge article',
      'Propose a knowledge article: what atomic facts can\'t say — pitfalls, history, golden sources, how to reconcile — about assets, terms or domains (about: their ids, e.g. obj:shop/prod/shop.customers). Cite the facts it rests on by id in cites and in the text as [fact:<id>] (find them with autode_list_assertions or autode_get_asset_context); never restate a fact without citing it. A person approves it; approved, agents get it in the packs of tasks over what it is about, and it goes stale when a cited fact changes.',
      'article', { type: 'object', required: ['slug', 'title', 'about', 'cites', 'body'], additionalProperties: false, properties: { slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' }, title: { type: 'string', minLength: 1 }, about: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }, cites: { type: 'array', items: { type: 'string', minLength: 1 } }, body: { type: 'string', minLength: 1 }, domain: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } }),
    proposalTool('autode_propose_vocabulary', 'vocabulary', 'Propose retrieval vocabulary',
      'Propose abbreviations (CUST = customer) and synonyms (client ~ customer) the customer uses, so AutoDE finds the right tables for their words. Low stakes: after asking the user you may approve it with autode_resolve_decision. Candidates mined from names and comments: autode_mine_vocabulary.',
      'vocabulary', { type: 'object', required: ['entries'], additionalProperties: false, properties: { entries: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', required: ['kind', 'from', 'to'], additionalProperties: false, properties: { kind: { type: 'string', enum: ['abbreviation', 'synonym'] }, from: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 } } } } } }),
    proposalTool('autode_propose_connection', 'connection', 'Propose a data-platform connection',
      'Propose a new or changed connection to Snowflake, Databricks or Oracle (a source). Settings that are not secret only — never a password, token or key: credentials come from the platform CLI\'s own configuration (credentials.resolver "cli", ref = the Snowflake CLI connection or Databricks profile name) or from environment variables (resolver "env"). A person approves it (AutoDE panel, `autode decisions approve`, or the decision file); then test it with autode_test_connection.',
      'connection', {
        type: 'object', required: ['platform', 'role', 'credentials'], additionalProperties: false,
        properties: {
          platform: { type: 'string', enum: ['snowflake', 'databricks', 'oracle'] },
          role: { type: 'string', enum: ['source', 'target'] },
          fields: { type: 'object', additionalProperties: { type: 'string' }, description: 'Snowflake: account, username, warehouse, database, schema, snowflakeRole, authMode, keyPath. Databricks: workspaceUrl, httpPath, catalog, schema. Oracle: connectString, username, configDir.' },
          credentials: { type: 'object', required: ['resolver'], additionalProperties: false, properties: { resolver: { type: 'string', enum: ['cli', 'env'] }, ref: { type: 'string' } } },
          scope: { type: 'string', enum: ['team', 'personal'], description: 'team (default): shared settings in the committed file; personal: only this engineer\'s file.' },
          allowSampleDataInPrompts: { type: 'boolean', description: 'Whether row values may reach language models. Default false; say why if you propose true.' }
        }
      }),
    {
      // C4c (§7.4): exploration mode's "assume and continue" at a context gap.
      name: 'autode_record_assumption',
      description: 'In an EXPLORATION-mode problem only: where AutoDE\'s context has a gap (a join, key or grain your assignment lists), record your best guess as a live fact at assumed trust, with the model you are and why you guessed it, and continue. It is labelled an assumption everywhere and listed for hardening when the problem is governed. Refused in a governed problem: there, stop and ask the person.',
      inputSchema: { type: 'object', required: ['kind', 'subject', 'predicate', 'value', 'statement', 'model', 'reason'], additionalProperties: false, properties: {
        kind: { type: 'string', enum: ['key', 'grain', 'relationship', 'business_term', 'metric', 'business_rule', 'quality_expectation', 'decision', 'assumption'] },
        subject: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 }, predicate: { type: 'string', minLength: 1 }, value: {},
        statement: { type: 'string', minLength: 1 }, model: { type: 'string', minLength: 1, description: 'The model making the guess.' },
        reason: { type: 'string', minLength: 1, description: 'Why this guess.' }, stage: { type: 'string', description: 'The stage that needed it.' }
      } },
      annotations: { title: 'Record an assumption (exploration)', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (args, ws) => {
        const root = ws.problemRoot();
        if (!root) throw new EngineToolError('NOT_FOUND', 'No active business problem.');
        if (problemMode(root) !== 'exploration') throw new EngineToolError('PERMISSION_DENIED', 'This problem is governed: stop and ask the person, then propose the fact they give you (autode_propose_assertion).', { mode: 'governed' });
        const kind = String(args.kind) as NewAssertion['kind'];
        if (!ASSERTION_KINDS.includes(kind)) throw new EngineToolError('VALIDATION_FAILED', `Unknown kind "${kind}".`);
        const src = await ws.contextSources();
        const resolve = createSubjectResolver(src.graph as Parameters<typeof createSubjectResolver>[0]);
        const ledger = new AssertionLedger(layoutPath(ws.options.workspaceRoot, 'ledger'));
        await ledger.load();
        try {
          const a = await recordAssumption(ledger, root, { kind, subject: (args.subject as string[]).map((r) => resolve(r) ?? r), predicate: String(args.predicate), value: args.value ?? {}, statement: String(args.statement), model: String(args.model), reason: String(args.reason), stepId: args.stage as string | undefined, createdBy: `mcp:${options.clientName() ?? 'client'}` });
          return { assertion: { id: a.id, kind: a.kind, subject: a.subject, statement: a.statement, status: a.status, trust: a.trust, flags: a.flags }, next: 'Continue with it, and list it among your assumptions in your summary.' };
        } catch (err) { throw new EngineToolError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err)); }
      }
    },
    {
      name: 'autode_review_session',
      description: 'End-of-session review (C4c): from the user\'s messages in your conversation, which read like facts (a key, a rule, a definition, a threshold …) but have no fact recorded from them. Give each message with a stable ref; ask the user to record (autode_propose_assertion, citing the ref) or dismiss each one. Without turns (MM2), the messages AutoDE\'s hook recorded in this workspace (Claude Code) are reviewed; dismiss those that state no fact with autode_dismiss_turns.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { turns: { type: 'array', maxItems: 500, items: { type: 'object', required: ['ref', 'text'], additionalProperties: false, properties: { ref: { type: 'string', minLength: 1 }, text: { type: 'string' } } } } } },
      annotations: { title: 'Review a session for unrecorded facts', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args, ws) => {
        const src = await ws.contextSources();
        if (!args.turns) return { recorded: true, unrecorded: unreviewedTurns(ws.options.workspaceRoot, src.assertions) };
        return { unrecorded: unrecordedStatements(args.turns as Array<{ ref: string; text: string }>, src.assertions, dismissedStatements(ws.options.workspaceRoot)) };
      }
    },
    {
      name: 'autode_capture_coverage',
      description: 'The completeness checklist for the active problem (C4c): for every table its specification or mapping names, whether its key, grain, change column, load pattern, personal-data classification, relationships and description are known, proposed, assumed, a candidate or missing; for every metric it names, its definition, grain and filters. Every item not known comes with the action that closes it. Deterministic; records nothing.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: { title: 'Capture coverage', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (_args, ws) => {
        const root = ws.problemRoot();
        if (!root) throw new EngineToolError('NOT_FOUND', 'No active business problem.');
        const src = await ws.contextSources();
        const report = problemCoverage({ workspaceRoot: ws.options.workspaceRoot, problemRoot: root, sources: src }, { probesAvailable: true });
        return { ...report, markdown: renderCoverage(report) } as unknown as Record<string, unknown>;
      }
    },
    {
      name: 'autode_find_candidates',
      description: 'Facts from the data before any model (C4c): candidate keys, foreign keys, grain, change columns, and personal data by value shape, for the active problem\'s tables, each checked by a fixed, read-only, aggregate-only probe (on connectionId if given, else on the pack\'s samples). Those that pass are recorded as proposed facts, already verified, for a person to confirm (counted at once in an exploration problem). Never returns row values.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { connectionId: { type: 'string', minLength: 1 } } },
      annotations: { title: 'Find candidates from data', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (args, ws) => {
        const root = ws.problemRoot();
        if (!root) throw new EngineToolError('NOT_FOUND', 'No active business problem.');
        let live;
        if (args.connectionId) {
          const entry = session.entry(String(args.connectionId));
          const dialect: ProbeDialect = fragmentsFor(entry.platform);
          const manager = await session.connect(entry);
          live = createSqlProbeExecutor(async (sql) => (await manager.executeQuery(sql, { maxRows: 10 })).rows as Array<Record<string, unknown>>, dialect);
        }
        const executor = combineProbeExecutors([live, packSampleExecutor(ws.options.workspaceRoot, root)]);
        const ledger = new AssertionLedger(layoutPath(ws.options.workspaceRoot, 'ledger'));
        await ledger.load();
        const src = await ws.contextSources();
        const { findings, recorded } = await problemCandidates({ workspaceRoot: ws.options.workspaceRoot, problemRoot: root, sources: src }, executor, { record: ledger });
        return { findings: findings.map((f) => ({ ...f, line: describeFinding(f) })), recorded: recorded.map((a) => ({ id: a.id, kind: a.kind, statement: a.statement, status: a.status, trust: a.trust })), next: recorded.length ? 'A person confirms the recorded facts in the AutoDE Context Inbox (or autode facts). Personal-data findings are classified by a person (autode governance classify).' : 'Nothing new to record.' };
      }
    },
    {
      name: 'autode_review_assertion',
      description: 'Confirm or reject a proposed LOW-stakes fact (glossary term, naming convention, assumption) after asking the user. Other facts are refused here: a person confirms them in the AutoDE Context Inbox.',
      inputSchema: { type: 'object', required: ['id', 'action', 'by'], additionalProperties: false, properties: { id: { type: 'string', minLength: 1 }, action: { type: 'string', enum: ['confirm', 'reject'] }, by: { type: 'string', minLength: 1, description: 'The user who decided.' }, note: { type: 'string' } } },
      annotations: { title: 'Review a low-stakes fact', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      handler: async (args, ws) => {
        const ledger = new AssertionLedger(layoutPath(ws.options.workspaceRoot, 'ledger'));
        await ledger.load();
        const a = ledger.get(String(args.id));
        if (!a || isMirror(a)) throw new EngineToolError('NOT_FOUND', `No fact "${String(args.id)}".`);
        if (a.status !== 'proposed') throw new EngineToolError('VALIDATION_FAILED', `Fact ${a.id} is ${a.status}, not proposed.`, { status: a.status });
        if (stakesFor('assertion', a) !== 'low') throw new EngineToolError('PERMISSION_DENIED', `A ${a.kind} fact is high stakes: a person confirms it in the AutoDE Context Inbox.`, { stakes: 'high', allowedChannels: ['panel', 'cli', 'file'] });
        const actor = `user:${String(args.by)}`;
        if (args.action === 'confirm') await ledger.confirm(a.id, actor);
        else await ledger.reject(a.id, actor, args.note as string | undefined);
        const after = ledger.get(a.id)!;
        return { assertion: { id: after.id, status: after.status, trust: after.trust, statement: after.statement } };
      }
    },
    {
      name: 'autode_verify_assertion',
      description: 'Check a key, grain, relationship or data expectation against live data with a fixed, read-only, aggregate-only probe, and record the result (verified, or needs review with the observed numbers). Never returns row values.',
      inputSchema: { type: 'object', required: ['id', 'connectionId'], additionalProperties: false, properties: { id: { type: 'string', minLength: 1 }, connectionId: { type: 'string', minLength: 1, description: 'A connection from autode_list_connections that holds the table.' } } },
      annotations: { title: 'Verify a fact against data', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: async (args, ws) => {
        const ledger = new AssertionLedger(layoutPath(ws.options.workspaceRoot, 'ledger'));
        await ledger.load();
        const a = ledger.get(String(args.id));
        if (!a || isMirror(a)) throw new EngineToolError('NOT_FOUND', `No fact "${String(args.id)}".`);
        const entry = session.entry(String(args.connectionId));
        const dialect: ProbeDialect = fragmentsFor(entry.platform);
        const manager = await session.connect(entry);
        const executor = createSqlProbeExecutor(async (sql) => (await manager.executeQuery(sql, { maxRows: 10 })).rows as Array<Record<string, unknown>>, dialect);
        const src = await ws.contextSources();
        const [outcome] = await verifyAssertions(ledger, [a], executor, createProbeResolver(src.graph as Parameters<typeof createProbeResolver>[0]));
        const after = ledger.get(a.id)!;
        return { id: a.id, statement: a.statement, outcome, status: after.status, trust: after.trust };
      }
    },
    {
      name: 'autode_list_decisions',
      description: 'List AutoDE decisions — proposals waiting for a person, and what was approved, rejected or applied — with their stakes and who may resolve them.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'applied', 'superseded', 'withdrawn', 'failed'] }, kind: { type: 'string' } } },
      annotations: { title: 'List decisions', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args, ws) => {
        const synced = await sync(ws);
        const list = store(ws).list({ status: args.status as Decision['status'] | undefined, kind: args.kind as Decision['kind'] | undefined });
        return { decisions: list.map(view), appliedNow: synced.applied.map((a) => a.message), incompleteFileResolutions: synced.incomplete };
      }
    },
    {
      name: 'autode_get_decision',
      description: 'One decision with its proposal, validation report, evidence and history.',
      inputSchema: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', minLength: 1 } } },
      annotations: { title: 'Get a decision', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args, ws) => {
        try {
          await sync(ws);
          const s = store(ws);
          const d = s.get(String(args.id));
          return { decision: { ...view(d), evidence: d.evidence, events: d.events }, proposal: s.proposal(d.id) };
        } catch (err) { return toToolError(err); }
      }
    },
    {
      name: 'autode_resolve_decision',
      description: 'Approve or reject a LOW-stakes decision after asking the user. High-stakes decisions are refused here: a person resolves them in the AutoDE panel, with the CLI, or in the decision file.',
      inputSchema: { type: 'object', required: ['id', 'decision', 'by'], additionalProperties: false, properties: { id: { type: 'string', minLength: 1 }, decision: { type: 'string', enum: ['approved', 'rejected'] }, by: { type: 'string', minLength: 1, description: 'The user who decided.' }, note: { type: 'string' } } },
      annotations: { title: 'Resolve a low-stakes decision', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      handler: async (args, ws) => {
        try {
          const s = store(ws);
          const d = s.resolve(String(args.id), { decision: args.decision as 'approved' | 'rejected', by: String(args.by), channel: 'tool', note: args.note as string | undefined });
          if (d.status !== 'approved') return { decision: view(d) };
          const applied = await applyDecision(s, d.id, await context(ws), deps());
          return { decision: view(applied.decision), applied: applied.applied, message: applied.message };
        } catch (err) { return toToolError(err); }
      }
    }
  ];
}
