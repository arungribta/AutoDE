import { EngineTool, ToolAnnotations } from './tools';
import { EngineToolError } from './errors';
import { EngineWorkspace } from './workspace';
import { PlatformSession } from './platform';
import { gateQueryResult } from '../engine/platform/sampleData';
import { governanceFacts } from '../engine/governance/governance';
import { loadCatalog, operationById, platformById } from '../engine/platform/operations/load';
import { ConnectionTarget, OperationError, runOnConnection, summarize } from '../engine/platform/operations/service';
import { openContext } from '../engine/context/estateIngest';
import { refreshLineage } from '../engine/lineage/record';
import { accessRunbook, capabilityMatrix, conformanceRun, operationPage, platformPage, skillOperations, skillPage, skillTexts } from '../engine/platform/operations/catalogView';
import { DecisionStore } from '../engine/decisions/decisionStore';
import { OperationProposalError, proposeOperation } from '../engine/platform/operations/proposeService';
import { driftReport } from '../engine/platform/operations/drift';
import { ProposalValidationError, propose } from '../engine/decisions/proposals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml } from '../engine/context/Yaml';
import { layoutPath } from '../engine/workspaceLayout';
import { OnboardingAnswers, OnboardingError, likeAnswers, loadTemplates, onboardingStatus, planOnboarding, proposeConformanceReview, proposeOnboarding, skillName, templateAnswers } from '../engine/platform/onboarding';
import { getCliDescriptor } from '../engine/platform/credentials/cliRegistry';
import { DefinitionCli } from '../engine/platform/credentials/DefinitionCli';
import { DataPlatformProvider } from '../engine/types';

/**
 * Platform operations over MCP (POP1; docs/specs/platform-operations.md §4):
 * the catalog, running a read on a connection, and LIN's observed lineage
 * through its operations. The CLI calls these same handlers, so both give
 * the same answer. A change operation never runs: it comes back as the
 * runbook step to propose.
 */

const read = (title: string, openWorld = false): ToolAnnotations => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: openWorld });

/** A connection as the executor reaches it: one read-only statement at a time, through the connection's CLI or API. */
export async function connectionTarget(session: PlatformSession, connectionId: string): Promise<{ target: ConnectionTarget; allowSampleData: boolean }> {
  const entry = session.entry(connectionId);
  const manager = await session.connect(entry);
  return {
    allowSampleData: entry.allowSampleDataInPrompts,
    target: { connectionId: entry.id, platform: entry.platform, query: async (sql, maxRows) => (await manager.executeQuery(sql, { maxRows, timeoutMs: 300_000 })).rows as Array<Record<string, unknown>>, ...manager.operationTransports() }
  };
}

/** The text under the first heading of a skill that is about installing, signing in or setting up. */
function setupSteps(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && /install|set ?up|sign in/i.test(l));
  if (start < 0) return undefined;
  const level = /^#+/.exec(lines[start])![0].length;
  const end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l) && /^#+/.exec(l)![0].length <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim() || undefined;
}

/** When the platform's definition reaches it by a CLI: is the CLI found, and if not, how to install it and what the setup skill says. */
async function cliSetup(scope: { resourcesRoot?: string; workspaceRoot: string }, platformId: string): Promise<Record<string, unknown> | undefined> {
  const def = loadCatalog(scope).platforms.find((p) => p.item.id === platformId)?.item;
  const cli = def?.access?.cli;
  if (!def || !cli) return undefined;
  const descriptor = getCliDescriptor(platformId as DataPlatformProvider) ?? (def.connection ? new DefinitionCli(def) : undefined);
  if (!descriptor) return undefined;
  if ((await descriptor.detect()).found) return { cli: cli.command, found: true };
  const file = path.join(layoutPath(scope.workspaceRoot, 'toolSkills', skillName(platformId, 'setup')), 'SKILL.md');
  const skillSteps = fs.existsSync(file) ? setupSteps(fs.readFileSync(file, 'utf8')) : undefined;
  return { cli: cli.command, found: false, ...(cli.install ? { install: cli.install } : {}), ...(skillSteps ? { skillSteps } : {}) };
}

const maintainer = { host: 'mcp', client: 'platform-maintainer' } as const;
const failure = (err: unknown) => new EngineToolError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err));

export function platformOperationTools(session: PlatformSession): EngineTool[] {
  return [
    {
      name: 'autode_propose_platform_operation',
      description: "Propose a platform operation (POP3): when you did something on a platform that no operation covers (a query or CLI command you ran read-only), or to fix an operation that drifted (a maintenance item names it), propose the operation file so AutoDE can run it deterministically from then on. Give the operation as an object or its YAML (the format: autode_platform_operations shows any operation in full; the autode-core-platform-operations skill explains it) with a recorded example: the parameters it ran with, the platform, and rows the platform returned. AutoDE checks the format, the read-only guard for reads and that the example binds and maps before a person sees it; a problem comes back item by item. It is a draft until a platform owner approves it in the Platform catalog; an approved team file with the same id keeps running meanwhile.",
      inputSchema: { type: 'object', required: ['operation', 'reason'], additionalProperties: false, properties: {
        operation: { description: 'The operation file: an object, or its YAML text.', anyOf: [{ type: 'object' }, { type: 'string', minLength: 1 }] },
        reason: { type: 'string', minLength: 10, description: 'Why it is needed: what you did that no operation covered, or what drifted.' },
        fixes: { type: 'string', minLength: 1, description: 'The maintenance item it fixes (its key, operation-drift:…), if any.' }
      } },
      annotations: { title: 'Propose a platform operation', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (args, ws: EngineWorkspace) => {
        try {
          const r = proposeOperation({ resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot }, { operation: args.operation, reason: String(args.reason), ...(args.fixes ? { fixes: String(args.fixes) } : {}) }, { host: 'mcp', client: 'platform-maintainer' });
          return { decision: { id: r.decision.id, title: r.decision.title }, file: r.prepared.file, resembles: r.prepared.resembles, superseded: r.superseded, warnings: r.decision.validation.warnings, next: `A platform owner approves it in the Platform catalog (the operation's page), or with autode decisions approve ${r.decision.id}. Tell the user it waits for them. Once approved, name it in the skill that needed it.` } as unknown as Record<string, unknown>;
        } catch (err) {
          if (err instanceof OperationProposalError) throw new EngineToolError('VALIDATION_FAILED', err.message, { problems: err.problems, resembles: err.prepared.resembles });
          throw new EngineToolError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err));
        }
      }
    },
    {
      name: 'autode_platform_template',
      description: "The onboarding template (POP5b): the questions to answer to add a new system to AutoDE. With no arguments, the categories, each with its label, what it is and the transports it can use. With category: the answers to fill in for that category (id, title, transports, access, connection fields, version detection, an implementation and recorded example for each starter operation, and the skills to write) and the capabilities and starter operations the category expects. With like: the answers of a platform AutoDE already has, as a starting point for a similar system (its id and title are replaced, so it is not mistaken for the original). Fill the answers in, then check them with autode_platform_onboard.",
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        category: { type: 'string', minLength: 1, description: 'A category from the list this tool gives with no arguments.' },
        like: { type: 'string', minLength: 1, description: 'A platform already in the catalog to start from.' },
        id: { type: 'string', minLength: 1, description: "The new system's id (lower case, digits, _ or -)." }
      } },
      annotations: read('Platform onboarding template'),
      handler: async (args, ws: EngineWorkspace) => {
        const scope = { resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot };
        try {
          if (args.like) {
            const catalog = loadCatalog(scope);
            const original = platformById(catalog, String(args.like))?.title ?? String(args.like);
            const answers = likeAnswers(catalog, String(args.like), args.id ? String(args.id) : 'my_system', `My system (like ${original})`);
            return { like: String(args.like), answers, next: 'Change what differs (connection fields, statements, recorded examples from a real read-only run), then check it with autode_platform_onboard.' } as unknown as Record<string, unknown>;
          }
          const templates = loadTemplates(scope.resourcesRoot);
          if (!args.category) return { categories: Object.entries(templates).map(([id, t]) => ({ id, label: t.label, description: t.description, transports: t.transports })) } as unknown as Record<string, unknown>;
          const category = String(args.category);
          const t = templates[category];
          if (!t) throw new EngineToolError('NOT_FOUND', `No category ${category} (${Object.keys(templates).join(', ')}).`);
          return { category, answers: templateAnswers(scope, category, args.id ? String(args.id) : undefined), capabilities: t.capabilities, starter: t.starter ?? [], next: 'Fill the answers in, grounding each implementation in a recorded example from a real read-only run, then check them with autode_platform_onboard.' } as unknown as Record<string, unknown>;
        } catch (err) {
          if (err instanceof EngineToolError) throw err;
          throw new EngineToolError('NOT_FOUND', err instanceof Error ? err.message : String(err));
        }
      }
    },
    {
      name: 'autode_platform_onboard',
      description: "Onboard a new system (POP5b). Give the answers (an object, or YAML) from autode_platform_template. With action check: each step with its state and what is missing, what only AutoDE's code can add (said plainly: a new transport, sign-in method or compile dialect stops the work), and the files it would write. Nothing is written. With action propose: when the plan is ready, the files, the skills (as drafts) and one decision that approves them all are written; a person approves it (never you). Once approved the system is on trial: it connects, and only conformance runs read from it, until a person reviews a conformance run on a real connection. When it is not ready nothing is written and the steps come back as the failure. Never put a credential in the answers.",
      inputSchema: { type: 'object', required: ['answers', 'action'], additionalProperties: false, properties: {
        answers: { description: 'The onboarding answers: an object, or its YAML text.', anyOf: [{ type: 'object' }, { type: 'string', minLength: 1 }] },
        action: { type: 'string', enum: ['check', 'propose'], description: 'check writes nothing; propose writes the files and the decision when the plan is ready.' }
      } },
      annotations: { title: 'Onboard a system', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (args, ws: EngineWorkspace) => {
        const scope = { resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot };
        let answers: OnboardingAnswers;
        try {
          const parsed = typeof args.answers === 'string' ? parseYaml(args.answers) : args.answers;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The answers are not an object.');
          answers = parsed as OnboardingAnswers;
        } catch (err) { throw failure(err); }
        try {
          if (args.action === 'check') {
            const plan = planOnboarding(scope, answers);
            const files = plan.status === 'ready' && plan.definition ? [`platform definition: ${plan.definition.id}`, ...plan.operations.map((o) => `operation: ${o.id}`), ...plan.implementations.map((f) => `implementation: ${f.implements} for ${f.platform}`), ...plan.skills.map((k) => `skill: ${k.name}`)] : [];
            return { status: plan.status, steps: plan.steps, neededCode: plan.neededCode, files, next: plan.status === 'ready' ? 'Propose it with action propose.' : plan.status === 'needs-code' ? 'This needs code AutoDE does not have: say so plainly to the user and stop. Nothing was written.' : 'Fill in what is missing and check again.' } as unknown as Record<string, unknown>;
          }
          if (args.action !== 'propose') throw new EngineToolError('VALIDATION_FAILED', 'action is check or propose.');
          const r = proposeOnboarding(scope, answers, maintainer);
          return { decision: { id: r.decision.id, title: r.decision.title }, files: r.files, skills: r.skills, next: `A person approves ${r.decision.id} (autode decisions approve ${r.decision.id}, or the panel); you cannot. Tell the user it waits for them. Once approved the system is on trial: connect to a real one, run autode_platform_conformance, then file the review with autode_propose_conformance_review.` } as unknown as Record<string, unknown>;
        } catch (err) {
          if (err instanceof OnboardingError) throw new EngineToolError('VALIDATION_FAILED', err.message, { status: err.plan.status, steps: err.plan.steps, neededCode: err.plan.neededCode });
          if (err instanceof EngineToolError) throw err;
          throw failure(err);
        }
      }
    },
    {
      name: 'autode_platform_onboarding_status',
      description: "Where a new system is in onboarding (POP5b): none (it did not come through onboarding), draft (waiting for a person to approve it), trial (approved; only conformance runs read from it), or counted (a person reviewed a conformance run). With the last conformance run, the one thing to do next and, when the system is reached by a CLI, whether that CLI is found; if it is not, the install command and the install and sign-in steps of its setup skill.",
      inputSchema: { type: 'object', required: ['platform'], additionalProperties: false, properties: { platform: { type: 'string', minLength: 1 } } },
      annotations: read('Onboarding status'),
      handler: async (args, ws: EngineWorkspace) => {
        const scope = { resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot };
        const id = String(args.platform);
        const status = onboardingStatus(scope, id);
        const setup = await cliSetup(scope, id);
        return { ...status, ...(setup ? { setup } : {}) } as unknown as Record<string, unknown>;
      }
    },
    {
      name: 'autode_propose_conformance_review',
      description: "File the review of a new system's latest conformance run (POP5b), bound to the definition's exact content. A person approves it (never you); that is what makes the system count. It needs the system approved and a conformance run on a real connection (autode_platform_conformance).",
      inputSchema: { type: 'object', required: ['platform'], additionalProperties: false, properties: { platform: { type: 'string', minLength: 1 } } },
      annotations: { title: 'Propose a conformance review', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (args, ws: EngineWorkspace) => {
        try {
          const d = proposeConformanceReview({ resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot }, String(args.platform), maintainer);
          return { decision: { id: d.id, title: d.title }, next: `A person reviews the conformance run and approves ${d.id} (autode decisions approve ${d.id}, or the panel); you cannot. Tell the user it waits for them.` } as unknown as Record<string, unknown>;
        } catch (err) { throw failure(err); }
      }
    },
    {
      name: 'autode_platform_drift',
      description: "Drift in the platform operations (POP3): each operation whose last run on a connection failed because the platform's version is outside its range or a view or column it reads is gone (with the error, the platform version and the skills that name it), and each object kind a platform reported that its definition doesn't name. They are maintenance items for the platform maintainer until fixed (an approved fixed operation closes them) or dismissed with a reason.",
      inputSchema: { type: 'object', additionalProperties: false, properties: { platform: { type: 'string', minLength: 1 } } },
      annotations: read('Platform drift'),
      handler: async (args, ws: EngineWorkspace) => {
        const d = driftReport({ resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot });
        const p = args.platform ? String(args.platform) : undefined;
        return { operations: d.operations.filter((o) => !p || o.platform === p), kinds: d.kinds.filter((k) => !p || k.platform === p) } as unknown as Record<string, unknown>;
      }
    },
    {
      name: 'autode_platform_request_access',
      description: "Request access (POP4b): a runbook that grants AutoDE's role what its capabilities need on a connection (default: those its last conformance run found short, else every capability with grant operations), built from the platform definition's grant operations, bound to the role, databases and schemas in scope. With an active problem it is proposed as a runbook decision for a person who administers the platform to approve and run; without one it comes back to show. Privileges no grant operation covers come back as warnings, in words.",
      inputSchema: { type: 'object', required: ['connectionId'], additionalProperties: false, properties: {
        connectionId: { type: 'string', minLength: 1 },
        role: { type: 'string', minLength: 1, description: "The role AutoDE connects as; default: the connection's role field." },
        capabilities: { type: 'array', items: { type: 'string', minLength: 1 } },
        databases: { type: 'array', items: { type: 'string', minLength: 1 }, description: "Databases (catalogs) in scope; default: the connection's." },
        schemas: { type: 'array', items: { type: 'string', minLength: 1 }, description: "Schemas in scope; default: the connection's." },
        propose: { type: 'boolean', description: 'Propose it as a runbook decision (default true when a problem is active).' }
      } },
      annotations: { title: 'Request access', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (args, ws: EngineWorkspace) => {
        const scope = { resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot };
        let draft;
        try { draft = accessRunbook(scope, { connection: String(args.connectionId), role: args.role as string | undefined, capabilities: args.capabilities as string[] | undefined, databases: args.databases as string[] | undefined, schemas: args.schemas as string[] | undefined }); }
        catch (err) { throw new EngineToolError('VALIDATION_FAILED', err instanceof Error ? err.message : String(err)); }
        const problemRoot = ws.problemRoot();
        if (args.propose === false || !problemRoot) return { ...draft, proposed: false, next: problemRoot ? 'Propose it with autode_propose_runbook when it is right.' : 'No active problem: a runbook is proposed within a problem. Start or select one, then ask again; or give these steps to the platform administrator.' } as unknown as Record<string, unknown>;
        try {
          const d = propose(new DecisionStore(ws.options.workspaceRoot), { workspaceRoot: ws.options.workspaceRoot, problemRoot, problemId: ws.activeProblemId(), connections: session.config().connections, resourcesRoot: ws.options.resourcesRoot }, 'runbook', draft.runbook, { proposedBy: { host: 'mcp', client: 'request-access' } });
          return { ...draft, proposed: true, decision: { id: d.id, title: d.title }, next: `A person who administers the platform approves it (autode decisions approve ${d.id}, or the panel), then runs it in AutoDE's runner.` } as unknown as Record<string, unknown>;
        } catch (err) {
          if (err instanceof ProposalValidationError) throw new EngineToolError('VALIDATION_FAILED', `The runbook did not pass its checks: ${err.report.errors.join('; ')}`, { errors: err.report.errors });
          throw err;
        }
      }
    },
    {
      name: 'autode_platform_operations',
      description: 'The platform operations catalog: every interaction AutoDE has with a platform, as a reviewed file (id, what it does, read or change, its parameters and results, the platforms it has an implementation for, shipped or the team\'s, approved or draft), and each platform\'s definition (category, capabilities and the operations and privileges each needs). With id: one operation in full, including the statement or command per platform. Use these ids instead of writing platform SQL yourself.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1 }, platform: { type: 'string', minLength: 1 }, area: { type: 'string', minLength: 1 }, uses: { type: 'string', minLength: 1, description: 'Only the operations this skill names.' } } },
      annotations: read('Platform operations catalog'),
      handler: async (args, ws: EngineWorkspace) => {
        const scope = { resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot };
        const catalog = loadCatalog(scope);
        if (args.id) {
          const found = catalog.operations.filter((o) => o.item.id === String(args.id));
          if (!found.length) throw new EngineToolError('NOT_FOUND', `No operation ${String(args.id)}.`);
          // POP4a: its page: what relies on it (capabilities, engine features, skills and their stages) and its last runs.
          return { operations: found.map((o) => ({ ...o.item, origin: o.origin, status: o.status, file: o.file, checksum: o.checksum })), page: operationPage(scope, String(args.id), catalog) as unknown as Record<string, unknown> };
        }
        const usedBySkill = args.uses ? skillTexts(scope).texts.find((t) => t.id === String(args.uses)) : undefined;
        if (args.uses && !usedBySkill) throw new EngineToolError('NOT_FOUND', `No skill ${String(args.uses)} whose text AutoDE can read.`);
        const used = usedBySkill ? new Set(skillOperations(usedBySkill.text, catalog).uses.map((u) => u.id)) : undefined;
        const ops = summarize(catalog).filter((o) => (!args.platform || o.platforms.includes(String(args.platform))) && (!args.area || o.area === String(args.area)) && (!used || used.has(o.id)));
        const platforms = catalog.platforms.filter((p) => !args.platform || p.item.id === String(args.platform)).map((p) => ({ id: p.item.id, title: p.item.title, category: p.item.category, transports: p.item.transports, access: p.item.access, capabilities: p.item.capabilities, origin: p.origin, status: p.status, file: p.file }));
        return { operations: ops, platforms, errors: catalog.errors };
      }
    },
    {
      name: 'autode_platform_run',
      description: 'Run one read operation from the catalog on a connection: AutoDE binds the parameters by type (never as text), checks the statement is read-only, runs it through the connection\'s CLI or API, and returns the declared result. Row values come back only when the operation reads names (content metadata) or the connection allows sample data; personal-data columns are masked. A change operation does not run: you get the runbook step to propose with autode_propose_runbook. A platform failure (a missing privilege, an older version) comes back as a gap with its reason.',
      inputSchema: {
        type: 'object', required: ['connectionId', 'operation'], additionalProperties: false,
        properties: { connectionId: { type: 'string', minLength: 1 }, operation: { type: 'string', minLength: 1 }, params: { type: 'object' }, maxRows: { type: 'integer', minimum: 1, maximum: 5000 } }
      },
      annotations: read('Run a platform operation', true),
      handler: async (args, ws: EngineWorkspace) => {
        const scope = { resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot };
        const catalog = loadCatalog(scope);
        const op = operationById(catalog, String(args.operation))?.item;
        const { target, allowSampleData } = await connectionTarget(session, String(args.connectionId));
        try {
          const r = await runOnConnection({ ...scope, catalog }, target, String(args.operation), (args.params as Record<string, unknown>) ?? {}, { maxRows: (args.maxRows as number | undefined) ?? 200, via: 'autode_platform_run' });
          if (!r.ok || !op || op.content === 'metadata') return r as unknown as Record<string, unknown>;
          const classified = allowSampleData ? governanceFacts((await ws.contextSources()).assertions).filter((f) => f.classification === 'pii' || f.classification === 'sensitive-pii').map((f) => f.column) : [];
          const gated = gateQueryResult({ columns: op.returns.map((x) => x.name), rows: r.rows, rowCount: r.rows.length, executionTimeMs: 0 }, { allowSampleData, metadata: false, connectionId: target.connectionId, classified });
          return { ...r, ...gated } as unknown as Record<string, unknown>;
        } catch (err) {
          if (err instanceof OperationError) {
            if (err.code === 'CHANGE') return { change: true, message: err.message, runbookStep: err.step } as Record<string, unknown>;
            throw new EngineToolError(err.code, err.message);
          }
          throw err;
        }
      }
    },
    {
      name: 'autode_platform_catalog',
      description: 'The platform catalog (POP4a): with no arguments, the capability matrix (capabilities as rows; the workspace\'s platforms, then the others, as columns), each cell supported, partly (with what is missing) or not applicable, with the last conformance run on each connection. With platform: that platform\'s page, with only the tabs that apply (overview, capabilities, operations by area, skills, tools, primitives and dialect, privileges, health). With skill: that skill\'s page, the operations it relies on and what skills lint flags (unknown operation ids, SQL it carries itself).',
      inputSchema: { type: 'object', additionalProperties: false, properties: { platform: { type: 'string', minLength: 1 }, skill: { type: 'string', minLength: 1 } } },
      annotations: read('Platform catalog'),
      handler: async (args, ws: EngineWorkspace) => {
        const scope = { resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot };
        if (args.platform) {
          const page = platformPage(scope, String(args.platform));
          if (!page) throw new EngineToolError('NOT_FOUND', `No platform ${String(args.platform)}.`);
          return { page } as unknown as Record<string, unknown>;
        }
        if (args.skill) {
          const page = skillPage(scope, String(args.skill));
          if (!page) throw new EngineToolError('NOT_FOUND', `No skill ${String(args.skill)}.`);
          return { page } as unknown as Record<string, unknown>;
        }
        return { matrix: capabilityMatrix(scope) } as unknown as Record<string, unknown>;
      }
    },
    {
      name: 'autode_platform_conformance',
      description: 'A conformance run on a connection (POP4a): tries each capability\'s read operations, one row at most each, with values from the connection\'s own fields (its database and schema), and records which capabilities work, partly work (with the privileges they need) or weren\'t tried. Read-only; nothing is changed on the platform.',
      inputSchema: { type: 'object', required: ['connectionId'], additionalProperties: false, properties: { connectionId: { type: 'string', minLength: 1 } } },
      annotations: read('Conformance run', true),
      handler: async (args, ws: EngineWorkspace) => {
        const entry = session.entry(String(args.connectionId));
        const { target } = await connectionTarget(session, entry.id);
        return { result: await conformanceRun({ resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot }, target, entry.fields) } as unknown as Record<string, unknown>;
      }
    },
    {
      name: 'autode_refresh_lineage',
      description: 'Read a connection\'s observed lineage into AutoDE: runs the lineage operations its platform definition names (Snowflake access history and object dependencies, Databricks column and table lineage …), read-only, for the databases bound to the connection (or those named), over the last days (default 30), and records each edge as a verified lineage fact. An edge no longer observed is retired with the reason, unless the read was cut off. A failed operation is reported with the privileges the platform needs; the others still run.',
      inputSchema: { type: 'object', required: ['connectionId'], additionalProperties: false, properties: { connectionId: { type: 'string', minLength: 1 }, databases: { type: 'array', maxItems: 50, items: { type: 'string', pattern: '^[A-Za-z0-9_$-]+$' } }, days: { type: 'integer', minimum: 1, maximum: 365 } } },
      annotations: { title: 'Refresh observed lineage', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (args, ws: EngineWorkspace) => {
        const { target } = await connectionTarget(session, String(args.connectionId));
        const cfm = await openContext(ws.options.workspaceRoot);
        try {
          return { result: await refreshLineage({ resourcesRoot: ws.options.resourcesRoot, workspaceRoot: ws.options.workspaceRoot, cfm, target, databases: args.databases as string[] | undefined, days: args.days as number | undefined, actor: 'mcp' }) as unknown as Record<string, unknown> };
        } finally { cfm.dispose(); }
      }
    }
  ];
}
