import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PLUGIN_HOSTS, PluginHost, buildPlugin, installPlugin, serverEntry } from '../engine/agents/plugin';
import { spawnSync } from 'node:child_process';
import { waitingForYou } from '../engine/approvals/waiting';
import { Runbook, approveRunbook, checkRunbook, listRunbooks } from '../engine/runner/runbook';
import { loadRunbookPolicy } from '../engine/runner/policy';
import { CatalogEntry, CatalogGroup, Runner, probeInstaller, skillCatalog, spawnRunner } from '../engine/agents/skillCatalog';
import * as port from '../engine/skills/port';
import * as lifecycle from '../engine/skills/lifecycle';
import * as gov from '../engine/governance/governance';
import { buildSchemaIndex } from '../engine/grounding/sqlGrounding';
import { problemMappings } from '../engine/agents/modelDraft';
import { approveStageDocument, documentApprovalProblems, isDocumentStage, stageDocumentFile } from '../engine/workflows/documentApproval';
import * as readline from 'node:readline';
import { parseArgs } from 'node:util';
import { EXPLORATION_DISCLAIMER, hardeningReport, problemMode, renderHardening, setProblemMode } from '../engine/documents/problemMode';
import { problemCandidates, problemCoverage } from '../engine/context/capture';
import { renderCoverage } from '../engine/context/coverage';
import { describeFinding } from '../engine/context/dataCandidates';
import * as sem from '../engine/semantic/store';
import { checkSemanticModel, SemanticFinding } from '../engine/semantic/checks';
import { draftSemanticModel } from '../engine/semantic/draft';
import { resolveComposite } from '../engine/semantic/composite';
import { newCompositeText } from '../engine/semantic/editorState';
import { ExploreRequest, exploreSources, handleExploreRequest } from '../engine/explore/sources';
import { renderAssetMarkdown, renderGraph, renderOverview, renderSearch, renderSemantic } from '../engine/explore/render';
import type { AssetContext, AssetType, ExploreOverview, GraphSlice, Layer, SearchResult, SemanticOverview } from '../engine/explore/explore';
import { problemTableIds } from '../engine/context/capture';
import { createSubjectResolver } from '../engine/context/projection';
import { EngineWorkspace } from '../mcp/workspace';
import { EngineTool, SQL_DIALECTS, TOOLS } from '../mcp/tools';
import { EngineToolError, redact, toEnvelope } from '../mcp/errors';
import { PlatformSession } from '../mcp/platform';
import { findResourcesRoot, main as mcpMain, readVersion } from '../mcp/server';
import { Decision, DecisionError, DecisionStatus, DecisionStore, stakesFor } from '../engine/decisions/decisionStore';
import { applyDecision } from '../engine/decisions/proposals';
import { parseBusinessProblemSpec, parseMappingContext, parsePipelineSpecDocument } from '../engine/documents/problemDocuments';
import { validatePipelineSpec } from '../engine/pipelineSpec/validator';
import { conformanceFailures, loadProfiles, packConformance, probeCandidates, readPackDocument, readPackFile, sampleProbeExecutor } from '../engine/context/packChecks';
import { ProbeDialect, ProbeExecutor, combineProbeExecutors, createProbeResolver, createSqlProbeExecutor, probeAssertions } from '../engine/context/probes';
import { checkPrerequisites } from '../engine/platform/prerequisites';
import { connectionStatus, forgetReadiness, readReadiness, recordReadiness } from '../engine/platform/connectionReadiness';
import { ConnectionDraft, ConnectionRole, loadConnectionsConfig, removeConnection, saveConnection, validateConnectionDraft } from '../engine/platform/connectionsConfig';
import { credentialNeeds, discoverCliConnections, draftEntry, setupFields } from '../engine/platform/connectionSetup';
import { listProblems, setActiveProblem, startProblem } from '../engine/documents/problems';
import { IngestResult, ingestConnection, ingestFile, openContext } from '../engine/context/estateIngest';
import { FactView, ReviewAction, bulkConfirmDocumented, factView, inbox, reviewFact } from '../engine/context/factReview';
import { BusinessPackManager } from '../engine/context/businessPackManager';
import { DOCUMENT_ROLES, DocumentAuthority, DocumentRole } from '../engine/context/pack';
import { buildVocabulary, mergeVocabularyFile, mineAbbreviations, parseVocabularyFile, VocabularyProposal } from '../engine/context/vocabulary';
import { isMirror } from '../engine/context/projection';
import { platformTools } from '../mcp/platform';
import { WorkflowScope, diffWorkflow, draftFrom, ensureWorkflow, historyFor, proposeWorkflow, redraft, statusFor, suggestFor, templatesFor } from '../engine/workflows/service';
import { WorkflowError, completeStage, nextAssignment, reopenStage, skipStage, startStage } from '../engine/workflows/runtime';
import { Actor, actorLabel } from '../engine/workflows/events';
import { readWorkflow } from '../engine/workflows/instance';
import { driversRoot as defaultDriversRoot } from '../engine/platform/driverStore';
import { DataPlatformProvider, SkillDefinition, SourceContext, SourceContextEntry } from '../engine/types';
import { TARGET_OPTIONS, readTargetContext, sourceEntryForSystem, sourceSystemChoices, targetConnectionChoices, targetContextFile, writeTargetContextDraft } from '../engine/context/problemContexts';
import { sourceContextFile, writeSourceContextDraft } from '../engine/agents/sourceContextDraft';
import { parseYaml } from '../engine/context/Yaml';
import { findSourceFiles } from '../engine/context/sourceFiles';
import { Catalog } from '../engine/context/catalog';
import { layoutPath } from '../engine/workspaceLayout';
import { SqlDialect } from '../engine/transforms/types';
import { guardHookEvent } from '../engine/runner/hostGuard';
import { isOpenInterview, readInterview, recordInterview, startInterview, summarizeInterview, writeInterview } from '../engine/interview/state';
import { interviewSkills } from '../engine/skills/skillRegistry';
import { loadSkillPack } from '../engine/agents/definitions';

/**
 * The `autode` command line (docs/mcp-engine-requirements.md §9.2, PA2;
 * reference: docs/cli.md). Deterministic commands read the workspace and
 * report; the CLI holds no model credentials and calls no LLM (§3.1).
 * Only `decisions approve | reject` change AutoDE's state, and only from an
 * interactive terminal with `CI` unset (D6). `autode mcp` is the MCP server.
 *
 * validate / compile / grounding call the same handlers as the MCP tools, so
 * the CLI and the server can't disagree.
 */

/** Stable exit codes (docs/cli.md). A validation failure outranks a pending decision. */
export const EXIT = {
  OK: 0,
  /** A check or validation failed; findings are printed. */
  FAILED: 1,
  /** Unknown command or bad arguments. */
  USAGE: 2,
  /** `check`: a pending high-stakes decision affects the problem. */
  PENDING_DECISION: 3,
  /** Needs a person at an interactive terminal (no TTY, or CI is set), or the decision's stakes refuse the channel. */
  REFUSED: 4,
  /** A named file, problem, decision or connection doesn't exist. */
  NOT_FOUND: 5,
  /** A data platform could not be reached or refused the request. */
  PLATFORM: 6,
  INTERNAL: 70
} as const;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** stdin and stdout are a terminal. */
  interactive: boolean;
  /** Asks one question on the terminal. */
  prompt: (question: string) => Promise<string>;
  /** Tests: a session with fake platform adapters. */
  platform?: (options: { workspaceRoot: string; allowCli: boolean; driversRoot?: string }) => PlatformSession;
  /** Tests: runs a vendor command (probes and installs) instead of spawning it. */
  run?: Runner;
  /** All of stdin (the host's event for `autode hook`). */
  readStdin?: () => Promise<string>;
}

export function nodeIo(): CliIo {
  return {
    out: (t) => process.stdout.write(t.endsWith('\n') ? t : t + '\n'),
    err: (t) => process.stderr.write(t.endsWith('\n') ? t : t + '\n'),
    env: process.env,
    cwd: process.cwd(),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    prompt: (question) => new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
    }),
    readStdin: () => new Promise((resolve) => {
      const chunks: Buffer[] = [];
      process.stdin.on('data', (c: Buffer) => chunks.push(c));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      process.stdin.on('error', () => resolve(''));
    })
  };
}

/**
 * `autode hook guard` (v0.45.11): the plugin's PreToolUse hook. The host sends its event as JSON on stdin;
 * a platform-changing `snow` or `databricks` command is blocked with exit 2 and the reason on stderr (the
 * hosts' convention), everything else passes with exit 0. Input it can't read passes: the guard checks
 * shell commands, nothing else.
 */
async function hookCommand(args: readonly string[], io: CliIo): Promise<number> {
  if (args[0] !== 'guard') { io.err('autode hook guard  (reads the host\'s PreToolUse event on stdin)'); return EXIT.USAGE; }
  let event: unknown;
  try { event = JSON.parse((await (io.readStdin ?? (async () => ''))()) || 'null'); } catch { return EXIT.OK; }
  const v = guardHookEvent(event, io.cwd);
  if (!v.block) return EXIT.OK;
  io.err(v.reason ?? 'Blocked by AutoDE.');
  return 2;
}

const USAGE = `autode <command> [options]

Deterministic (never change AutoDE's state):
  validate [path]              Business problem, Pipeline Spec and mapping documents; workspace primitives; connections.yaml
  compile --dialect <d> [path] Compile a Pipeline Spec to SQL (stdout, or --out <folder>)
  grounding <file.sql>...      Check SQL against the estate AutoDE knows
  conformance [--connection <id>]  Pack contracts against the catalog, samples and (read-only) live probes
  probe [--connection <id>]    Probe keys, grains, relationships and expectations (aggregates only; nothing is recorded)
  doctor                       Prerequisites, drivers, connections and their readiness
  check                        CI gate: validate, and no pending high-stakes decision affects the problem

Business problems:
  problems list                Every business problem; * marks the active one
  problems new "<statement>" [--exploration]   Start one: a first draft specification, made active
                               (--exploration, terminal: proceed on recorded assumptions, under a disclaimer)
  problems mode [exploration|governed]   (terminal) Show or switch the active problem's mode
  problems hardening           What exploration mode left to confirm: assumptions, model-only facts, checks that only warned
  problems use <id>            Make another one active (the AutoDE panel follows)
  interview show               The requirements interview: parts covered, open questions, answers and who gave them
  interview answer <question-id> "<answer>"   Answer an open question (the panel and agent hosts continue from it)

Estate (observed metadata; recorded without a decision):
  estate show                  Systems, environments, bindings, and what the catalog holds
  estate ingest <file>...      DDL (.sql/.ddl), CSV or JSON into the catalog and working set [--system <s>] [--environment <e>]
  estate files                 Source files shared in the workspace (DDL, data, load scripts): the system each suggests, and whether it is in the estate
  estate extract --connection <id> --schema <DB.SCHEMA>...   A connection's schemas [--system <s>] [--profile] [--allow-cli]

Workflow (the planned stages of a problem; approving is a person's: interactive terminal):
  workflow templates           The workflow templates (bundled and this workspace's)
  workflow status              Each stage: done, ready, waiting (and for what), stale, skipped
  workflow plan [--template <id>]   Draft the workflow from a template (default: AutoDE's suggestion) and propose it for approval
  workflow next                What to do now, and by which role
  workflow start <stage>       Mark a stage in progress (working ahead of its dependencies is allowed, with a warning)
  workflow complete <stage> --output <file>... --summary <text>   Hand in a stage; its gate decision goes to a person
  workflow approve [<stage>]   (terminal) Approve the pending workflow, a stage's gate, or a stage's document
                               (specification, target or source context, mapping, Pipeline Spec)
  workflow skip <stage> --reason <text>     A default or optional stage only
  workflow reopen <stage> --reason <text>   Everything downstream becomes stale
  workflow history [<stage>]   Who did what, when, through which channel, and why

Knowledge (confirming, rejecting, editing and adding are a person's: interactive terminal):
  facts [list]                 What waits for review (proposed, needs review), with stakes and what each corrects [--kind k] [--all]
  facts show <id>              One fact: value, evidence, verification, history
  facts confirm <id>...        Confirm; or --from <source> for every documented fact from one source
  facts reject <id> [--note <text>]
  facts edit <id> [--statement <text>] [--value <json>]   Correct it, confirmed
  facts conflicts              Contradicting facts

Semantic layer (approving is a person's: interactive terminal):
  semantic show                Shared semantic models (approved, changed, unapproved) and the active problem's composites (resolved, stale)
  semantic draft <name> [--tables t1,t2] [--database <db>]   Draft a shared model from confirmed facts and the estate (never overwrites)
  semantic compose <name> --models <m1,m2>   Start a composite of the active problem over shared models
  semantic resolve <composite> Resolve it into <name>.resolved.yaml (deterministic; refused on a collision or a redefinition)
  semantic check <name>        Check a shared model or composite against the estate and the facts
  semantic approve <name>      (terminal) Approve a shared model (workspace-wide) or a composite (in its problem)

Knowledge Explorer (what AutoDE knows; the same answers as the VS Code Explorer and MCP):
  explore                      Overview: objects, facts by status, systems, semantic models
  explore search <words…> [--layer physical|context|semantic] [--type table,column,glossary_term,…] [--system <s>] [--platform <p>] [--all]   Search names, aliases, synonyms, descriptions and facts; facet counts
  explore semantic             The semantic layer: each model's logical tables, metrics, relationships, verified queries and instructions
  explore browse [<id>]        The estate as a tree: databases, then a database's schemas, a schema's tables, a table's columns
  explore asset <id|name>      Everything known about one asset: schema, meaning, relationships, governance, facts, decisions, used by
  explore graph [<id|name>] [--hops 1-3] [--system <s>] [--model <m>] [--columns]   The graph around an asset; with no asset, the landscape: tables and every relationship between them

Capture coverage:
  coverage                     What a complete picture of the problem needs, per table and metric: known, proposed, assumed, missing, and the action for each
  capture candidates [--connection <id>] [--record]   Keys, foreign keys, grain, change columns and personal data from the data, each probed

Governance (personal data):
  governance show [--table <t>]   Columns that look like personal data, and how each is classified
  governance classify <table.column> --as pii|sensitive-pii|confidential|none [--strategy hash|redact]   (terminal) Record it, confirmed
  pack list                    The active problem's documents (contracts, BRDs, samples …)
  pack add <file> --role <r> --authority signed|draft --doc-version <v> [--table <obj id>]   (terminal)
  pack apply [<doc id>...]     Read structured documents through their confirmed profiles into facts
  vocabulary mine              Abbreviations mined from table and column names and comments
  vocabulary accept            (terminal) Pick mined entries to add to .autode/knowledge/vocabulary.yaml
  design-doc [path] [--out <file>]   The Pipeline Spec's design document
  query --connection <id> "<sql>"    One read-only statement (row values only where the connection allows sample data)
  explain --connection <id> "<sql>"  Dry-run: the platform's plan, nothing runs

Connections:
  connections list             Each connection, whether it is ready, and what MCP clients still need
  connections test <id>        Connect read-only and record readiness on this machine
  connections add              (terminal) Set one up: pick a Snowflake CLI connection or Databricks profile, or give fields;
                               tested before it is saved. Flags: --platform --role --resolver cli|env --ref <name>
                               --set key=value (repeat) --scope team|personal --allow-sample-data --no-test
  connections remove <id>      (terminal) Remove it from the connections files

Human (an interactive terminal; refused when CI is set):
  decisions list [--status <s>] [--kind <k>]
  decisions show <id>
  decisions approve <id> [--note <text>] [--by <name>]
  decisions reject <id> [--note <text>] [--by <name>]

Skills (AutoDE's own, this workspace's imported ones, interview packs, and the vendor skills AutoDE works with):
  skills list [--group autode|workspace|interview|external]   The catalog, with whether external skills are installed
  skills show <name>           One skill: what it does, its stage kinds and platforms, licence, source, how to install
  skills check <name>          Probe an external skill's install command on this machine (nothing is installed)
  skills install <name>        (terminal) Run the vendor's own install command after you confirm, then check it worked
  skills analyze <source> [--ref <r>] [--skill <path>]   Port a skill: what a skill in a folder, Git URL or dbt package does (nothing is copied)
  skills import <source> [--ref <r>] [--skill <path>] [--replace]   Import it into this workspace, unreviewed
  skills update <id>           (terminal) Re-fetch an imported skill from its source, show the diff, apply after you confirm
  skills review <id> [--tier reviewed|trusted]   (terminal) Review an imported skill's current content
  skills publish <id>          (terminal) Publish it (a skill with scripts or write tools must be reviewed first)

Waiting for you:
  approvals [list]             Everything that waits for a person, in one list: decisions, facts to review, stage
                               documents, runbooks needing a second approver; each with the command that approves it

A problem's target and source context (they reference the workspace: a target connection, estate systems):
  context show                 The problem's target and source context, the workspace's target connections and estate systems
  context target --connection <id> --set modelingApproach=… --set transformationTool=… --set orchestrationTool=…
                 --set namingConvention=… [--set database=…] [--schema <s>]   Draft the target context (or --platform, with no connection)
  context sources --system <id,…> [--summary <text>]   Draft the source context from estate systems (--summary: a source with no connection)

Runbooks (platform changes, approved by a person; they run in VS Code's Runbook tab):
  runbook list                 The problem's runbooks: environment, approvals, status, steps run
  runbook show <id>            Every step: the engine's classification, what runs, its dry run and rollback, its state; the log
  runbook approve <id>         (terminal) Approve: a pending runbook decision, or the second approval an environment needs

Agent hosts (Claude Code, Cortex Code, GitHub Copilot CLI):
  plugin path [--out <folder>]   Build AutoDE's plugin folder (agents, skills, commands, .mcp.json) and print where it is
  plugin install --host claude|cortex|copilot [--scope project|user]   Copy AutoDE's agents and skills into the host's folders
                               and wire its MCP server (or print the step, where the host has no file for it)
  hook guard                   The plugin's PreToolUse hook: blocks platform-changing snow/databricks commands (host event JSON on stdin; exit 2 = blocked)

Server:
  mcp [--allow-cli] [--drivers <folder>]   The AutoDE MCP server over stdio (platform changes: runbooks)

Common options:
  --workspace <folder>   The project holding .autode/ (default: the current folder)
  --problem <id>         One business problem (default: the active one, else every problem)
  --json                 Machine-readable output
  --version, --help

Exit codes: 0 ok · 1 failed · 2 usage · 3 pending high-stakes decision · 4 refused (needs a person) · 5 not found · 6 platform error · 70 internal`;

const OPTIONS = {
  workspace: { type: 'string' },
  problem: { type: 'string' },
  resources: { type: 'string' },
  json: { type: 'boolean' },
  dialect: { type: 'string' },
  out: { type: 'string' },
  connection: { type: 'string' },
  'allow-cli': { type: 'boolean' },
  drivers: { type: 'string' },
  status: { type: 'string' },
  kind: { type: 'string' },
  note: { type: 'string' },
  by: { type: 'string' },
  platform: { type: 'string' },
  role: { type: 'string' },
  resolver: { type: 'string' },
  ref: { type: 'string' },
  scope: { type: 'string' },
  set: { type: 'string', multiple: true },
  'allow-sample-data': { type: 'boolean' },
  'no-test': { type: 'boolean' },
  system: { type: 'string' },
  environment: { type: 'string' },
  schema: { type: 'string', multiple: true },
  profile: { type: 'boolean' },
  all: { type: 'boolean' },
  from: { type: 'string' },
  statement: { type: 'string' },
  value: { type: 'string' },
  authority: { type: 'string' },
  table: { type: 'string' },
  'max-rows': { type: 'string' },
  'doc-version': { type: 'string' },
  template: { type: 'string' },
  output: { type: 'string', multiple: true },
  summary: { type: 'string' },
  reason: { type: 'string' },
  host: { type: 'string' },
  group: { type: 'string' },
  skill: { type: 'string' },
  replace: { type: 'boolean' },
  tier: { type: 'string' },
  as: { type: 'string' },
  strategy: { type: 'string' },
  exploration: { type: 'boolean' },
  record: { type: 'boolean' },
  tables: { type: 'string' },
  database: { type: 'string' },
  models: { type: 'string' },
  hops: { type: 'string' },
  type: { type: 'string' },
  layer: { type: 'string' },
  model: { type: 'string' },
  columns: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' }
} as const;

type Values = { [K in Exclude<keyof typeof OPTIONS, 'set' | 'schema' | 'output'>]?: (typeof OPTIONS)[K]['type'] extends 'string' ? string : boolean } & { set?: string[]; schema?: string[]; output?: string[] };

class CliError extends Error {
  public constructor(public readonly exit: number, message: string) { super(message); }
}

interface Ctx {
  io: CliIo;
  values: Values;
  workspaceRoot: string;
  resourcesRoot: string;
  version: string;
  json: boolean;
}

/** `CI` counts as set unless it is empty, `0` or `false`. */
export function ciIsSet(env: NodeJS.ProcessEnv): boolean {
  const v = (env.CI ?? '').trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

export async function run(argv: readonly string[], io: CliIo = nodeIo()): Promise<number> {
  // The server parses its own flags; everything after `mcp` is passed through.
  if (argv[0] === 'mcp') {
    await mcpMain(argv.slice(1));
    return EXIT.OK;
  }
  if (argv[0] === 'hook') return hookCommand(argv.slice(1), io);
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true }) as { values: Values; positionals: string[] };
  } catch (err) {
    io.err(`autode: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  const { values, positionals } = parsed;
  const resourcesRoot = values.resources ? path.resolve(io.cwd, values.resources) : findResourcesRoot();
  const version = readVersion(resourcesRoot);
  if (values.version) { io.out(version); return EXIT.OK; }
  const [command, ...rest] = positionals;
  if (values.help || !command) { io.out(USAGE); return command || values.help ? EXIT.OK : EXIT.USAGE; }
  const ctx: Ctx = { io, values, workspaceRoot: path.resolve(io.cwd, values.workspace ?? '.'), resourcesRoot: resourcesRoot ?? io.cwd, version, json: values.json === true };
  try {
    switch (command) {
      case 'validate': return await cmdValidate(ctx, rest);
      case 'compile': return await cmdCompile(ctx, rest);
      case 'grounding': return await cmdGrounding(ctx, rest);
      case 'conformance': return await cmdConformance(ctx);
      case 'probe': return await cmdProbe(ctx);
      case 'doctor': return await cmdDoctor(ctx);
      case 'check': return await cmdCheck(ctx);
      case 'decisions': return await cmdDecisions(ctx, rest);
      case 'connections': return await cmdConnections(ctx, rest);
      case 'problems': return await cmdProblems(ctx, rest);
      case 'estate': return await cmdEstate(ctx, rest);
      case 'facts': return await cmdFacts(ctx, rest);
      case 'governance': return await cmdGovernance(ctx, rest);
      case 'coverage': return await cmdCoverage(ctx);
      case 'capture': return await cmdCapture(ctx, rest);
      case 'semantic': return await cmdSemantic(ctx, rest);
      case 'explore': return await cmdExplore(ctx, rest);
      case 'workflow': return await cmdWorkflow(ctx, rest);
      case 'pack': return await cmdPack(ctx, rest);
      case 'vocabulary': return await cmdVocabulary(ctx, rest);
      case 'design-doc': return await cmdDesignDoc(ctx, rest);
      case 'query': case 'explain': return await cmdSql(ctx, command, rest);
      case 'plugin': return cmdPlugin(ctx, rest);
      case 'skills': return await cmdSkills(ctx, rest);
      case 'runbook': return await cmdRunbook(ctx, rest);
      case 'approvals': return await cmdApprovals(ctx, rest);
      case 'context': return await cmdContext(ctx, rest);
      case 'interview': return cmdInterview(ctx, rest);
      default:
        io.err(`autode: unknown command "${command}".\n\n${USAGE}`);
        return EXIT.USAGE;
    }
  } catch (err) {
    return fail(ctx, err);
  }
}

function fail(ctx: Ctx, err: unknown): number {
  if (err instanceof CliError) { ctx.io.err(`autode: ${redact(err.message)}`); return err.exit; }
  if (err instanceof DecisionError) {
    ctx.io.err(`autode: ${redact(err.message)}`);
    return err.code === 'NOT_FOUND' ? EXIT.NOT_FOUND : err.code === 'CHANNEL_NOT_ALLOWED' ? EXIT.REFUSED : EXIT.FAILED;
  }
  const envelope = toEnvelope(err);
  if (ctx.json) ctx.io.out(JSON.stringify({ ok: false, error: envelope }, null, 2));
  else ctx.io.err(`autode: ${envelope.message}${envelope.details && Object.keys(envelope.details).length ? `\n${JSON.stringify(envelope.details, null, 2)}` : ''}`);
  switch (envelope.code) {
    case 'VALIDATION_FAILED': return EXIT.FAILED;
    case 'NOT_FOUND': case 'UNKNOWN_PRIMITIVE': return EXIT.NOT_FOUND;
    case 'PERMISSION_DENIED': case 'WRITE_NOT_ALLOWED': return EXIT.REFUSED;
    case 'CONNECTION_FAILED': case 'AUTH_FAILED': case 'TIMEOUT': case 'PLATFORM_ERROR': return EXIT.PLATFORM;
    default: return EXIT.INTERNAL;
  }
}

function emit(ctx: Ctx, json: Record<string, unknown>, text: string): void {
  ctx.io.out(ctx.json ? JSON.stringify(json, null, 2) : redact(text));
}

function workspace(ctx: Ctx, problemId?: string): EngineWorkspace {
  return new EngineWorkspace({ workspaceRoot: ctx.workspaceRoot, resourcesRoot: ctx.resourcesRoot, problemId });
}

/** `--problem`, else the active problem, else every problem in the workspace. */
function targetProblems(ctx: Ctx): string[] {
  const ws = workspace(ctx);
  if (ctx.values.problem) {
    if (!ws.problemIds().includes(ctx.values.problem)) throw new CliError(EXIT.NOT_FOUND, `No business problem "${ctx.values.problem}" under .autode/problems/ (known: ${ws.problemIds().join(', ') || 'none'}).`);
    return [ctx.values.problem];
  }
  const active = ws.activeProblemId();
  return active && ws.problemIds().includes(active) ? [active] : ws.problemIds();
}

/** The one problem a command works on: --problem, the active one, or the only one. */
function singleProblem(ctx: Ctx): string | undefined {
  const all = targetProblems(ctx);
  if (all.length > 1) throw new CliError(EXIT.USAGE, `This workspace has ${all.length} business problems and none is active; pass --problem <id> (${all.join(', ')}).`);
  return all[0];
}

function tool(name: string): EngineTool {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`internal: no tool ${name}`);
  return t;
}

const rel = (ctx: Ctx, file: string) => path.relative(ctx.workspaceRoot, file).split(path.sep).join('/');

// ── validate / check ─────────────────────────────────────────────────────────

interface Finding { problem?: string; document: string; ok: boolean; errors: string[] }

/** Every check `validate` runs: per problem documents, then workspace-wide primitives and connections. */
function runValidations(ctx: Ctx, problems: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const id of problems) {
    const ws = workspace(ctx, id);
    const root = ws.problemRoot()!;
    const doc = (relPath: string, check: (text: string) => string[]) => {
      const file = path.join(root, ...relPath.split('/'));
      if (!fs.existsSync(file)) return;
      let errors: string[];
      try { errors = check(fs.readFileSync(file, 'utf8')); } catch (err) { errors = [err instanceof Error ? err.message : String(err)]; }
      findings.push({ problem: id, document: relPath, ok: errors.length === 0, errors });
    };
    doc('spec/business-problem.yaml', (t) => { parseBusinessProblemSpec(t); return []; });
    ws.ensurePrimitives();
    doc('spec/pipeline.yaml', (t) => {
      // The same parse as the extension, then the schema and primitive-parameter checks.
      let raw: unknown;
      try { raw = ws.readStructured(path.join(root, 'spec', 'pipeline.yaml')); } catch (err) { return [err instanceof EngineToolError ? `${err.message} ${String(err.details.parseError ?? '')}`.trim() : String(err)]; }
      parsePipelineSpecDocument(t);
      return validatePipelineSpec(raw).errors;
    });
    doc('context/mapping-context.yaml', (t) => { parseMappingContext(t); return []; });
  }
  const ws = workspace(ctx);
  const primitiveErrors = ws.primitiveLoadErrors();
  findings.push({ document: 'primitives (bundled and .autode/config/primitives/)', ok: primitiveErrors.length === 0, errors: [...primitiveErrors] });
  const config = platformSession(ctx).config();
  if (config.fileExists || config.localFileExists) findings.push({ document: config.file, ok: config.errors.length === 0, errors: config.errors });
  return findings;
}

function renderFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `${f.ok ? '✓' : '✗'} ${f.problem ? `${f.problem}: ` : ''}${f.document}${f.errors.map((e) => `\n    - ${e}`).join('')}`).join('\n');
}

async function cmdValidate(ctx: Ctx, rest: string[]): Promise<number> {
  if (rest.length > 1) throw new CliError(EXIT.USAGE, 'validate takes at most one path.');
  if (rest[0]) {
    const ws = workspace(ctx, ctx.values.problem);
    const file = path.resolve(ctx.io.cwd, rest[0]);
    if (!fs.existsSync(file)) throw new CliError(EXIT.NOT_FOUND, `No file "${rest[0]}".`);
    const r = await tool('autode_validate_pipeline_spec').handler({ path: rel(ctx, file) }, ws) as { valid: boolean; errors: string[]; source: string };
    emit(ctx, { ok: r.valid, findings: [{ document: r.source, ok: r.valid, errors: r.errors }] }, renderFindings([{ document: r.source, ok: r.valid, errors: r.errors }]));
    return r.valid ? EXIT.OK : EXIT.FAILED;
  }
  const findings = runValidations(ctx, targetProblems(ctx));
  const ok = findings.every((f) => f.ok);
  emit(ctx, { ok, findings }, renderFindings(findings));
  return ok ? EXIT.OK : EXIT.FAILED;
}

/** Pending high-stakes decisions in the problems' scope; a decision a person resolved in its committed file counts as resolved. */
function blockingDecisions(ctx: Ctx, problems: readonly string[]): Decision[] {
  const store = new DecisionStore(ctx.workspaceRoot);
  // Stakes are recomputed, never read from the file: an edited `stakes: low` must not pass the gate.
  const high = (d: Decision) => { try { return stakesFor(d.kind, store.proposal(d.id)) === 'high'; } catch { return true; } };
  return store.list({ status: 'pending' })
    .filter((d) => !(d.resolution.decision && d.resolution.by.trim()))
    .filter((d) => !d.problemId || problems.length === 0 || problems.includes(d.problemId))
    .filter(high);
}

async function cmdCheck(ctx: Ctx): Promise<number> {
  const problems = targetProblems(ctx);
  const findings = runValidations(ctx, problems);
  const pending = blockingDecisions(ctx, problems);
  const valid = findings.every((f) => f.ok);
  const exit = !valid ? EXIT.FAILED : pending.length ? EXIT.PENDING_DECISION : EXIT.OK;
  const lines = [
    renderFindings(findings),
    pending.length
      ? `✗ ${pending.length} pending high-stakes decision(s) — a person must approve or reject them (AutoDE panel, \`autode decisions approve <id>\` in a terminal, or the decision file):${pending.map((d) => `\n    - ${d.id} ${d.kind}: ${d.title}${d.problemId ? ` (${d.problemId})` : ''}`).join('')}`
      : '✓ no pending high-stakes decision',
    exit === EXIT.OK ? 'check passed' : 'check failed'
  ];
  emit(ctx, { ok: exit === EXIT.OK, exitCode: exit, problems, findings, pendingDecisions: pending.map(decisionView) }, lines.join('\n'));
  return exit;
}

// ── compile / grounding ──────────────────────────────────────────────────────

async function cmdCompile(ctx: Ctx, rest: string[]): Promise<number> {
  const dialect = ctx.values.dialect as SqlDialect | undefined;
  if (!dialect || !SQL_DIALECTS.includes(dialect)) throw new CliError(EXIT.USAGE, `compile needs --dialect, one of: ${SQL_DIALECTS.join(', ')}.`);
  if (rest.length > 1) throw new CliError(EXIT.USAGE, 'compile takes at most one path.');
  const args: Record<string, unknown> = { dialect };
  let ws: EngineWorkspace;
  if (rest[0]) {
    const file = path.resolve(ctx.io.cwd, rest[0]);
    if (!fs.existsSync(file)) throw new CliError(EXIT.NOT_FOUND, `No file "${rest[0]}".`);
    args.path = rel(ctx, file);
    ws = workspace(ctx, ctx.values.problem);
  } else {
    const id = singleProblem(ctx);
    if (!id) throw new CliError(EXIT.NOT_FOUND, 'No business problem in this workspace; pass the path of a Pipeline Spec.');
    ws = workspace(ctx, id);
  }
  const r = await tool('autode_compile_pipeline_spec').handler(args, ws) as { specId: string; specVersion: number; entities: Array<{ name: string; artifacts: Array<{ kind: string; content: string; suggestedPath: string }> }> };
  const artifacts = r.entities.flatMap((e) => e.artifacts.map((a) => ({ entity: e.name, ...a })));
  if (ctx.values.out) {
    const outDir = path.resolve(ctx.io.cwd, ctx.values.out);
    const written: string[] = [];
    for (const a of artifacts) {
      // The entity folder and file name of the suggested path, under the chosen folder.
      const file = path.join(outDir, ...a.suggestedPath.split('/').slice(-2));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, a.content.endsWith('\n') ? a.content : a.content + '\n');
      written.push(file);
    }
    emit(ctx, { ok: true, specId: r.specId, specVersion: r.specVersion, dialect, written }, written.map((f) => `wrote ${path.relative(ctx.io.cwd, f)}`).join('\n') || 'nothing to compile');
  } else {
    emit(ctx, { ok: true, ...r }, artifacts.map((a) => `-- ${a.suggestedPath}\n${a.content.trimEnd()}\n`).join('\n') || '-- nothing to compile');
  }
  return EXIT.OK;
}

async function cmdGrounding(ctx: Ctx, files: string[]): Promise<number> {
  if (!files.length) throw new CliError(EXIT.USAGE, 'grounding needs at least one SQL file.');
  const ws = workspace(ctx, ctx.values.problem);
  const results: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  let failed = false;
  for (const f of files) {
    const file = path.resolve(ctx.io.cwd, f);
    if (!fs.existsSync(file)) throw new CliError(EXIT.NOT_FOUND, `No file "${f}".`);
    const r = await tool('autode_check_grounding').handler({ content: fs.readFileSync(file, 'utf8'), name: f, ...(ctx.values.dialect ? { dialect: ctx.values.dialect } : {}) }, ws) as {
      tablesChecked: number; tablesResolved: number; columnsChecked: number; columnsResolved: number; unresolved: Array<{ kind: string; ref: string }>; ambiguous: string[]; typeIssues: Array<{ detail: string }>; knownTables: number
    };
    const bad = r.unresolved.length > 0 || r.typeIssues.length > 0;
    failed = failed || bad;
    results.push({ file: f, ...r });
    lines.push(`${bad ? '✗' : '✓'} ${f}: tables ${r.tablesResolved}/${r.tablesChecked}, columns ${r.columnsResolved}/${r.columnsChecked} (estate: ${r.knownTables} table(s))`
      + r.unresolved.map((u) => `\n    - unresolved ${u.kind} ${u.ref}`).join('')
      + r.ambiguous.map((a) => `\n    - ambiguous table ${a}`).join('')
      + r.typeIssues.map((t) => `\n    - ${t.detail}`).join(''));
  }
  emit(ctx, { ok: !failed, results }, lines.join('\n'));
  return failed ? EXIT.FAILED : EXIT.OK;
}

// ── conformance / probe ──────────────────────────────────────────────────────

function platformSession(ctx: Ctx): PlatformSession {
  const options = { workspaceRoot: ctx.workspaceRoot, allowCli: ctx.values['allow-cli'] === true, driversRoot: ctx.values.drivers };
  return ctx.io.platform?.(options) ?? new PlatformSession({ ...options, allowWrite: false, env: ctx.io.env, log: (l) => ctx.io.err(redact(l)) });
}

const probeDialect = (platform: DataPlatformProvider): ProbeDialect => platform === 'databricks' ? 'spark_sql' : platform === 'oracle' ? 'oracle' : platform === 'snowflake' ? 'snowflake' : 'ansi';

/** A read-only, aggregate-only probe executor on `--connection`, if given. */
async function liveExecutor(ctx: Ctx, session: PlatformSession): Promise<ProbeExecutor | undefined> {
  if (!ctx.values.connection) return undefined;
  const entry = session.entry(ctx.values.connection);
  const manager = await session.connect(entry);
  return createSqlProbeExecutor(async (sql) => (await manager.executeQuery(sql, { maxRows: 10 })).rows as Array<Record<string, unknown>>, probeDialect(entry.platform));
}

async function cmdConformance(ctx: Ctx): Promise<number> {
  const id = singleProblem(ctx);
  if (!id) throw new CliError(EXIT.NOT_FOUND, 'No business problem in this workspace.');
  const ws = workspace(ctx, id);
  const pack = readPackFile(path.join(ws.problemRoot()!, 'pack'));
  const session = platformSession(ctx);
  try {
    const log = (m: string) => ctx.io.err(m);
    const read = (d: { path: string }) => readPackDocument(ctx.workspaceRoot, d);
    const executor = combineProbeExecutors([await liveExecutor(ctx, session), sampleProbeExecutor(pack, read, log)]);
    const catalogDir = layoutPath(ctx.workspaceRoot, 'catalog');
    const catalog = new Catalog(catalogDir);
    if (fs.existsSync(catalogDir)) await catalog.load();
    const { reports, markdown, skipped } = await packConformance(pack, loadProfiles(ctx.workspaceRoot, log), read, catalog, executor, log);
    const failures = conformanceFailures(reports);
    emit(ctx, { ok: failures === 0, problem: id, failures, reports, skipped }, reports.length ? `${markdown}\n${failures} failing clause(s).` : 'No contract in the pack has a confirmed profile yet — nothing to check.');
    return failures ? EXIT.FAILED : EXIT.OK;
  } finally { session.dispose(); }
}

async function cmdProbe(ctx: Ctx): Promise<number> {
  const id = singleProblem(ctx);
  const ws = workspace(ctx, id);
  const session = platformSession(ctx);
  try {
    const pack = id ? readPackFile(path.join(ws.problemRoot()!, 'pack')) : { documents: [] };
    const executor = combineProbeExecutors([await liveExecutor(ctx, session), sampleProbeExecutor(pack as ReturnType<typeof readPackFile>, (d) => readPackDocument(ctx.workspaceRoot, d), (m) => ctx.io.err(m))]);
    if (!executor) throw new CliError(EXIT.NOT_FOUND, 'Nothing to probe with: pass --connection <id>, or add a sample of the table to the pack.');
    const src = await ws.contextSources();
    const outcomes = await probeAssertions(probeCandidates(src.assertions), executor, createProbeResolver(src.graph as Parameters<typeof createProbeResolver>[0]));
    const failed = outcomes.filter((o) => o.result?.pass === false);
    const passed = outcomes.filter((o) => o.result?.pass === true);
    const lines = outcomes.map((o) => o.result && o.result.pass !== undefined ? `${o.result.pass ? '✓' : '✗'} ${o.statement} — ${o.result.detail}${o.result.source === 'sample' ? ' (sample data)' : ''}` : `· ${o.statement} — ${o.skipped ?? o.result?.detail ?? 'undecided'}`);
    lines.push(`${passed.length} passed, ${failed.length} failed, ${outcomes.length - passed.length - failed.length} not decided. Nothing was recorded; verify facts in the AutoDE panel or with autode_verify_assertion.`);
    emit(ctx, { ok: failed.length === 0, outcomes }, lines.join('\n'));
    return failed.length ? EXIT.FAILED : EXIT.OK;
  } finally { session.dispose(); }
}

// ── doctor ───────────────────────────────────────────────────────────────────

async function cmdDoctor(ctx: Ctx): Promise<number> {
  const ws = workspace(ctx);
  const session = platformSession(ctx);
  const config = session.config();
  const readiness = readReadiness(ctx.workspaceRoot);
  const drivers = defaultDriversRoot(ctx.values.drivers, ctx.io.env);
  const platforms = [...new Set(config.connections.map((c) => c.platform))];
  const prerequisites = await checkPrerequisites({ driversRoot: drivers, platforms: platforms.length ? platforms : undefined, resourcesRoot: ctx.resourcesRoot, workspaceRoot: ctx.workspaceRoot });
  const connections = config.connections.map((c) => ({ id: c.id, platform: c.platform, role: c.role, origin: c.origin, status: connectionStatus(c, readiness[c.id]) }));
  // Only a required prerequisite of a platform this workspace uses is a failure.
  const missing = prerequisites.filter((p) => p.required && p.state !== 'ready' && platforms.includes(p.platform));
  const hasAutode = fs.existsSync(layoutPath(ctx.workspaceRoot, 'root'));
  const ok = config.errors.length === 0 && missing.length === 0;
  const lines = [
    `autode ${ctx.version} · Node ${process.versions.node} · ${os.platform()}`,
    `resources: ${ctx.resourcesRoot}`,
    `workspace: ${ctx.workspaceRoot} ${hasAutode ? `(.autode/: ${ws.problemIds().length} problem(s), active: ${ws.activeProblemId() ?? 'none'})` : '(no .autode/ folder — AutoDE has not worked here yet)'}`,
    `drivers: ${drivers}`,
    '',
    'Prerequisites:',
    ...prerequisites.map((p) => `  ${p.state === 'ready' ? '✓' : p.required && platforms.includes(p.platform) ? '✗' : '·'} ${p.title} — ${p.state}${p.version ? ` ${p.version}` : ''}${p.state !== 'ready' && p.install?.command ? `\n      install: ${p.install.command}` : ''}${p.state !== 'ready' ? (p.install?.options ?? []).filter((o) => o.available).map((o) => `\n      install with ${o.manager}: ${o.commands.map((c) => c.join(' ')).join(' && ')}${o.needs ? ` (needs ${o.needs})` : ''}`).join('') : ''}${p.state !== 'ready' && p.install?.docs && !p.install?.command ? `\n      guide: ${p.install.docs}${p.install.verifiedAt ? ` (checked ${p.install.verifiedAt})` : ''}` : ''}`),
    '',
    `Connections (${config.file}${config.fileExists ? '' : ', not present'}):`,
    ...(connections.length ? connections.map((c) => `  ${c.status.autode === 'ready' ? '✓' : '·'} ${c.id} (${c.role}, ${c.origin}) — ${c.status.autode}${c.status.checkedAt ? ` at ${c.status.checkedAt}` : ''}; MCP: ${c.status.mcp.ready ? 'ready' : c.status.mcp.note}`) : ['  none']),
    ...config.errors.map((e) => `  ✗ ${e}`)
  ];
  emit(ctx, { ok, version: ctx.version, node: process.versions.node, workspace: ctx.workspaceRoot, hasAutode, resources: ctx.resourcesRoot, drivers, prerequisites, connections, configErrors: config.errors }, lines.join('\n'));
  return ok ? EXIT.OK : EXIT.FAILED;
}

// ── decisions ────────────────────────────────────────────────────────────────

const DECISION_STATUSES: readonly DecisionStatus[] = ['pending', 'approved', 'rejected', 'applied', 'superseded', 'withdrawn', 'failed'];

function decisionView(d: Decision): Record<string, unknown> {
  return { id: d.id, kind: d.kind, title: d.title, stakes: d.stakes, status: d.status, problemId: d.problemId ?? null, proposedBy: d.proposedBy, proposedAt: d.proposedAt, file: `.autode/decisions/${d.id}.yaml` };
}

async function cmdDecisions(ctx: Ctx, rest: string[]): Promise<number> {
  const [sub, id, ...extra] = rest;
  const store = new DecisionStore(ctx.workspaceRoot);
  if (sub === 'list') {
    const status = ctx.values.status as DecisionStatus | undefined;
    if (status && !DECISION_STATUSES.includes(status)) throw new CliError(EXIT.USAGE, `--status is one of: ${DECISION_STATUSES.join(', ')}.`);
    const list = store.list({ status, kind: ctx.values.kind as Decision['kind'] | undefined, problemId: ctx.values.problem });
    emit(ctx, { ok: true, decisions: list.map(decisionView) }, list.length
      ? list.map((d) => `${d.id}  ${d.status.padEnd(10)} ${d.stakes.padEnd(4)} ${d.kind.padEnd(16)} ${d.title}${d.status === 'pending' && d.resolution.decision ? `  (${d.resolution.decision} in the file — applied when AutoDE next syncs)` : ''}`).join('\n')
      : 'No decisions.');
    return EXIT.OK;
  }
  if (sub !== 'show' && sub !== 'approve' && sub !== 'reject') throw new CliError(EXIT.USAGE, 'decisions takes list, show <id>, approve <id> or reject <id>.');
  if (!id || extra.length) throw new CliError(EXIT.USAGE, `decisions ${sub} takes one decision id.`);
  const d = store.get(id);
  if (sub === 'show') {
    const proposal = store.proposal(d.id);
    emit(ctx, { ok: true, decision: { ...decisionView(d), summary: d.summary, validation: d.validation, evidence: d.evidence, allowedChannels: d.allowedChannels, events: d.events }, proposal }, describeDecision(d, proposal));
    return EXIT.OK;
  }

  // approve / reject: a person at an interactive terminal (D6).
  requirePerson(ctx, `decisions ${sub}`, `A non-interactive run never resolves a decision; resolve ${d.id} in the AutoDE panel, in a terminal, or in .autode/decisions/${d.id}.yaml.`);
  if (d.status !== 'pending') throw new CliError(EXIT.FAILED, `Decision ${d.id} is ${d.status}, not pending.`);
  const decision = sub === 'approve' ? 'approved' : 'rejected';
  const by = (ctx.values.by ?? safeUsername()).trim();
  ctx.io.out(describeDecision(d, store.proposal(d.id)));
  // C4c: in an exploration problem a stage gate takes one step (y), not a typed word.
  const oneStep = d.kind === 'gate' && !!d.problemId && problemMode(layoutPath(ctx.workspaceRoot, 'problems', d.problemId)) === 'exploration';
  const answer = (await ctx.io.prompt(oneStep ? `\n${sub === 'approve' ? 'Approve' : 'Reject'} ${d.id} as "${by}" (exploration mode)? [y/N] ` : `\n${sub === 'approve' ? 'Approve' : 'Reject'} ${d.id} as "${by}"? Type ${sub} to confirm: `)).trim().toLowerCase();
  if (oneStep ? answer !== 'y' && answer !== 'yes' : answer !== sub) { ctx.io.out('Not confirmed; nothing changed.'); return EXIT.REFUSED; }
  const resolved = store.resolve(d.id, { decision, by, channel: 'cli', note: ctx.values.note });
  if (resolved.status !== 'approved') { emit(ctx, { ok: true, decision: decisionView(resolved) }, `Rejected ${d.id}.`); return EXIT.OK; }
  const problemRoot = resolved.problemId ? layoutPath(ctx.workspaceRoot, 'problems', resolved.problemId) : undefined;
  const applied = await applyDecision(store, resolved.id, { workspaceRoot: ctx.workspaceRoot, problemRoot, problemId: resolved.problemId, connections: platformSession(ctx).config().connections });
  emit(ctx, { ok: applied.decision.status !== 'failed', decision: decisionView(applied.decision), applied: applied.applied, message: applied.message }, applied.message);
  return applied.decision.status === 'failed' ? EXIT.FAILED : EXIT.OK;
}

/** Commands only a person runs: an interactive terminal, and CI not set (D6). */
function requirePerson(ctx: Ctx, what: string, otherwise: string): void {
  if (ciIsSet(ctx.io.env)) throw new CliError(EXIT.REFUSED, `Refused: CI is set. ${otherwise}`);
  if (!ctx.io.interactive) throw new CliError(EXIT.REFUSED, `Refused: ${what} needs an interactive terminal (stdin and stdout). ${otherwise}`);
}

// ── problems and estate (v0.43.2) ────────────────────────────────────────────

async function cmdProblems(ctx: Ctx, rest: string[]): Promise<number> {
  const [sub, ...args] = rest;
  if (sub === 'list') {
    const list = listProblems(ctx.workspaceRoot);
    emit(ctx, { ok: true, problems: list }, list.length
      ? list.map((p) => `${p.isActive ? '*' : ' '} ${p.id}  ${p.status} v${p.specVersion}  ${p.problemStatement.replace(/\s+/g, ' ').slice(0, 90)}`).join('\n')
      : 'No business problems yet. Start one with `autode problems new "<problem statement>"`.');
    return EXIT.OK;
  }
  if (sub === 'new') {
    const statement = args.join(' ').trim();
    if (!statement) throw new CliError(EXIT.USAGE, 'problems new takes the problem statement, in quotes.');
    if (ctx.values.exploration) {
      requirePerson(ctx, 'Starting a problem in exploration mode', 'Start it governed, then switch it in the AutoDE panel or a terminal.');
      if ((await ctx.io.prompt(`${EXPLORATION_DISCLAIMER}\nType explore to acknowledge: `)).trim().toLowerCase() !== 'explore') { ctx.io.out('Not acknowledged; nothing was started.'); return EXIT.REFUSED; }
    }
    const { id, spec } = startProblem(ctx.workspaceRoot, statement);
    const problemRoot = layoutPath(ctx.workspaceRoot, 'problems', id);
    startInterview(problemRoot, spec.problemStatement, interviewParts(ctx));
    if (ctx.values.exploration) setProblemMode(problemRoot, 'exploration', { by: (ctx.values.by ?? safeUsername()).trim(), channel: 'cli', acknowledged: true });
    emit(ctx, { ok: true, id, specId: spec.id, active: true, mode: problemMode(problemRoot) }, `Started ${id} (active${ctx.values.exploration ? ', exploration mode' : ''}). Its first draft specification holds the statement; the interview follows (AutoDE panel, an AutoDE skill in your agent, or \`autode interview\`), then approval.`);
    return EXIT.OK;
  }
  if (sub === 'mode' || sub === 'hardening') {
    const id = singleProblem(ctx);
    if (!id) throw new CliError(EXIT.NOT_FOUND, 'No business problem in this workspace.');
    const problemRoot = layoutPath(ctx.workspaceRoot, 'problems', id);
    if (sub === 'hardening') {
      const r = hardeningReport(problemRoot, ctx.workspaceRoot);
      emit(ctx, { ok: true, problem: id, mode: problemMode(problemRoot), ...r }, renderHardening(r));
      return EXIT.OK;
    }
    const want = args[0];
    if (!want) { emit(ctx, { ok: true, problem: id, mode: problemMode(problemRoot) }, `${id} is ${problemMode(problemRoot)}.`); return EXIT.OK; }
    if (want !== 'exploration' && want !== 'governed') throw new CliError(EXIT.USAGE, 'problems mode takes exploration or governed.');
    requirePerson(ctx, 'Switching a problem\'s mode', 'Switch it in the AutoDE panel, or in a terminal.');
    const word = want === 'exploration' ? 'explore' : 'governed';
    if ((await ctx.io.prompt(`${want === 'exploration' ? EXPLORATION_DISCLAIMER : 'Governed mode blocks where a check fails, and lists what exploration left to harden.'}\nType ${word} to switch ${id}: `)).trim().toLowerCase() !== word) { ctx.io.out('Nothing changed.'); return EXIT.REFUSED; }
    const r = setProblemMode(problemRoot, want, { by: (ctx.values.by ?? safeUsername()).trim(), channel: 'cli', acknowledged: want === 'exploration' }, { workspaceRoot: ctx.workspaceRoot });
    emit(ctx, { ok: true, problem: id, mode: r.record.mode, changed: r.changed, hardening: r.hardening }, `${id} is ${r.record.mode}${r.changed ? '' : ' already'}.${r.hardening ? `\n\n${renderHardening(r.hardening)}` : ''}`);
    return EXIT.OK;
  }
  if (sub === 'use') {
    if (args.length !== 1) throw new CliError(EXIT.USAGE, 'problems use takes one problem id (see autode problems list).');
    if (!listProblems(ctx.workspaceRoot).some((p) => p.id === args[0])) throw new CliError(EXIT.NOT_FOUND, `No business problem "${args[0]}" (see autode problems list).`);
    setActiveProblem(ctx.workspaceRoot, args[0]);
    emit(ctx, { ok: true, id: args[0] }, `${args[0]} is now the active business problem.`);
    return EXIT.OK;
  }
  throw new CliError(EXIT.USAGE, 'problems takes list, new "<statement>" [--exploration], use <id>, mode [exploration|governed] or hardening.');
}

const ingestLine = (r: IngestResult) => `✓ ${r.source} → system ${r.system} (${r.environment}): ${r.tables} table(s), ${r.columns} column(s); catalogued ${r.catalogued}, ${r.promoted} in the working set${r.warnings.length ? `\n    ! ${r.warnings.join(' ')}` : ''}`;

async function cmdEstate(ctx: Ctx, rest: string[]): Promise<number> {
  const [sub, ...args] = rest;
  const log = (m: string) => ctx.io.err(m);
  if (sub === 'show') {
    const cfm = await openContext(ctx.workspaceRoot, () => undefined);
    try {
      const estate = cfm.getEstate();
      const entries = cfm.getCatalog().all();
      const bySystem = new Map<string, number>();
      for (const e of entries) bySystem.set(`${e.system}/${e.environment}`, (bySystem.get(`${e.system}/${e.environment}`) ?? 0) + 1);
      const stats = cfm.getContextStats();
      const lines = [
        'Systems:',
        ...(estate.systems.length ? estate.systems.map((sys) => `  ${sys.id} — ${sys.name}, ${sys.role}`) : ['  none']),
        'Bindings:',
        ...(estate.bindings.length ? estate.bindings.map((b) => `  ${b.connection ?? b.file} → ${b.system}${b.environment ? ` (${b.environment})` : ''}${b.schemas?.length ? ` [${b.schemas.join(', ')}]` : ''}`) : ['  none']),
        `Catalog: ${entries.length} table(s)${bySystem.size ? ` — ${[...bySystem.entries()].map(([k, n]) => `${k}: ${n}`).join(', ')}` : ''}`,
        `Working set (what agents get as context): ${stats.tables} table(s), ${stats.columns} column(s), ${stats.terms} business term(s), ${stats.rules} rule(s)`
      ];
      emit(ctx, { ok: true, estate, catalog: [...bySystem.entries()].map(([key, tables]) => ({ key, tables })), stats }, lines.join('\n'));
      return EXIT.OK;
    } finally { cfm.dispose(); }
  }
  if (sub === 'files') {
    const files = findSourceFiles(ctx.workspaceRoot);
    emit(ctx, { ok: true, files }, files.length
      ? files.map((f) => `  ${f.ingested ? '✓' : '·'} ${f.path.padEnd(40)} ${f.kind.padEnd(11)} ${f.ingested ? `in the estate as ${f.ingested}` : f.kind === 'load-script' ? 'read it for what is loaded' : `suggested system: ${f.suggestedSystem}${f.tables ? ` (${f.tables} tables)` : ''} — autode estate ingest ${f.path} --system ${f.suggestedSystem}`}`).join('\n')
      : 'No source files in the workspace.');
    return EXIT.OK;
  }
  if (sub === 'ingest') {
    if (!args.length) throw new CliError(EXIT.USAGE, 'estate ingest takes one or more files (.sql, .ddl, .csv, .json).');
    const files = args.map((a) => path.resolve(ctx.io.cwd, a));
    for (const f of files) if (!fs.existsSync(f)) throw new CliError(EXIT.NOT_FOUND, `No file "${f}".`);
    const cfm = await openContext(ctx.workspaceRoot, log);
    try {
      const results: IngestResult[] = [];
      for (const f of files) {
        try { results.push(await ingestFile(cfm, f, { system: ctx.values.system, environment: ctx.values.environment })); } catch (err) { throw new CliError(EXIT.FAILED, err instanceof Error ? err.message : String(err)); }
      }
      emit(ctx, { ok: true, results }, results.map(ingestLine).join('\n'));
      return EXIT.OK;
    } finally { cfm.dispose(); }
  }
  if (sub === 'extract') {
    if (args.length) throw new CliError(EXIT.USAGE, 'estate extract takes options: --connection <id> --schema <DB.SCHEMA> (repeatable).');
    if (!ctx.values.connection) throw new CliError(EXIT.USAGE, 'estate extract needs --connection <id> (see autode connections list).');
    const session = platformSession(ctx);
    const cfm = await openContext(ctx.workspaceRoot, log);
    try {
      const entry = session.entry(ctx.values.connection);
      const manager = await session.connect(entry);
      const r = await ingestConnection(cfm, manager, entry.id, { schemas: ctx.values.schema, system: ctx.values.system, environment: ctx.values.environment, profile: ctx.values.profile === true });
      emit(ctx, { ok: true, results: [r] }, ingestLine(r));
      return EXIT.OK;
    } catch (err) {
      if (err instanceof Error && /Name the schemas/.test(err.message)) throw new CliError(EXIT.USAGE, err.message);
      throw err;
    } finally { cfm.dispose(); session.dispose(); }
  }
  throw new CliError(EXIT.USAGE, 'estate takes show, ingest <file>... or extract --connection <id> --schema <DB.SCHEMA>.');
}

// ── workflow (PA3a, v0.44.0) ────────────────────────────────────────────────

const STATUS_MARK: Record<string, string> = { done: '✓', ready: '→', 'in-progress': '…', 'awaiting-approval': '?', 'awaiting-check': '?', pending: '·', stale: '!', skipped: '−' };

async function cmdApprovals(ctx: Ctx, rest: string[]): Promise<number> {
  const [sub = 'list'] = rest;
  if (sub !== 'list') throw new CliError(EXIT.USAGE, 'approvals list (approve each item with the command it shows).');
  const ws = workspace(ctx);
  const cfm = await openContext(ctx.workspaceRoot, () => undefined);
  let facts: FactView[] = [];
  try { facts = inbox(cfm.getLedger()).facts; } finally { cfm.dispose?.(); }
  const items = waitingForYou({ workspaceRoot: ctx.workspaceRoot, resourcesRoot: ctx.resourcesRoot, problemId: ctx.values.problem ?? ws.activeProblemId(), facts });
  emit(ctx, { ok: true, items }, items.length
    ? items.map((i) => `  ${i.stakes === 'high' ? '!' : '·'} ${i.title}${i.problemId ? ` [${i.problemId}]` : ''}\n      ${i.detail}\n      approve: ${i.cli}`).join('\n') + `\n${items.length} item(s) wait for a person.`
    : 'Nothing waits for you.');
  return EXIT.OK;
}

/** The interview's parts: AutoDE's interview skills, and the workspace's own JSON parts by id. */
function interviewParts(ctx: Ctx): SkillDefinition[] {
  const overrides = layoutPath(ctx.workspaceRoot, 'skills');
  return interviewSkills(loadSkillPack(ctx.resourcesRoot).skills, fs.existsSync(overrides) ? overrides : undefined);
}

/** `autode interview show | answer` (v0.45.12): the requirements interview on disk, continued from a terminal. */
function cmdInterview(ctx: Ctx, rest: string[]): number {
  const [sub = 'show', questionId, ...words] = rest;
  const problemId = singleProblem(ctx);
  if (!problemId) throw new CliError(EXIT.NOT_FOUND, 'No business problem: start one with `autode problems new`.');
  const problemRoot = layoutPath(ctx.workspaceRoot, 'problems', problemId);
  const parts = interviewParts(ctx);
  let s = readInterview(problemRoot, ctx.workspaceRoot);
  if (sub === 'show') {
    if (!s) { emit(ctx, { ok: true, problemId, interview: null }, `${problemId} has no interview yet: it starts in the AutoDE panel, in an agent host, or with \`autode problems new\`.`); return EXIT.OK; }
    const v = summarizeInterview(s, parts);
    emit(ctx, { ok: true, problemId, interview: v }, [
      `${problemId}: interview ${v.status}${v.feeds ? ` (fed specification v${v.feeds.version})` : ''}, ${v.answered.length} answer(s), ${v.open.length} open question(s)`,
      ...v.parts.map((p) => `  ${p.status === 'addressed' ? '✓' : p.status === 'partial' ? '◐' : '·'} ${p.name}`),
      ...(v.open.length ? ['Open:', ...v.open.map((q) => `  ${q.id} [${q.field}] ${q.prompt}${q.options?.length ? ` (${q.options.join(' / ')})` : ''}`)] : []),
      ...(v.answered.length ? ['Answered:', ...v.answered.map((a) => `  ${a.questionId} [${a.field}] ${a.value}${a.by ? ` — ${a.by}${a.channel ? `, ${a.channel}` : ''}` : ''}`)] : [])
    ].join('\n'));
    return EXIT.OK;
  }
  if (sub === 'answer') {
    const value = words.join(' ').trim();
    if (!questionId || !value) throw new CliError(EXIT.USAGE, 'interview answer <question-id> "<answer>"');
    if (!s || !isOpenInterview(s)) throw new CliError(EXIT.NOT_FOUND, s ? 'The interview already fed a specification; change the specification instead.' : 'No interview yet.');
    const r = recordInterview(s, { answers: [{ questionId, value }] }, { by: safeUsername(), channel: 'cli' });
    if (!r.answered.length) throw new CliError(EXIT.NOT_FOUND, r.errors.join(' '));
    s = r.session;
    writeInterview(problemRoot, s);
    const open = summarizeInterview(s, parts).open;
    emit(ctx, { ok: true, problemId, answered: r.answered, open }, `Recorded. ${open.length ? `${open.length} question(s) still open.` : 'No open questions: continue the interview in the panel or an agent host.'}`);
    return EXIT.OK;
  }
  throw new CliError(EXIT.USAGE, 'interview show | answer <question-id> "<answer>"');
}

async function cmdContext(ctx: Ctx, rest: string[]): Promise<number> {
  const [sub = 'show'] = rest;
  const problemId = singleProblem(ctx);
  if (!problemId) throw new CliError(EXIT.NOT_FOUND, 'No business problem: start one with `autode problems new`.');
  const problemRoot = layoutPath(ctx.workspaceRoot, 'problems', problemId);
  const rel = (f: string) => path.relative(ctx.workspaceRoot, f).split(path.sep).join('/');
  if (sub === 'show') {
    const target = readTargetContext(problemRoot);
    let source: SourceContext | undefined;
    try { source = parseYaml(fs.readFileSync(sourceContextFile(problemRoot), 'utf8')) as SourceContext; } catch { /* none yet */ }
    const connections = targetConnectionChoices(ctx.workspaceRoot);
    const systems = sourceSystemChoices(ctx.workspaceRoot);
    emit(ctx, { ok: true, problemId, target: target ?? null, source: source ?? null, targetConnections: connections, sourceSystems: systems, options: TARGET_OPTIONS }, [
      `Target context: ${target ? `${target.status} — ${target.platform ?? '?'}${target.connectionId ? ` via ${target.connectionId}` : ''}, ${target.modelingApproach ?? '?'}, ${target.transformationTool ?? '?'} / ${target.orchestrationTool ?? '?'}, ${target.namingConvention ?? '?'}${target.platformConfig?.schema ? `, ${target.platformConfig.database ?? ''}.${target.platformConfig.schema}` : ''}` : 'none yet'}`,
      `Source context: ${source ? `${source.status} — ${source.sources.map((e) => e.system ?? `${e.connectionId} (${e.method})`).join(', ') || 'no sources'}` : 'none yet'}`,
      `Target connections: ${connections.map((c) => `${c.id} (${c.platform})`).join(', ') || 'none — `autode connections add`'}`,
      `Estate source systems: ${systems.map((s) => s.id).join(', ') || 'none — `autode estate ingest` or `autode estate extract`'}`
    ].join('\n'));
    return EXIT.OK;
  }
  if (sub === 'target') {
    const set = Object.fromEntries((ctx.values.set ?? []).map((kv) => { const i = kv.indexOf('='); return i > 0 ? [kv.slice(0, i), kv.slice(i + 1)] : [kv, '']; }));
    const unknown = Object.keys(set).filter((k) => !['modelingApproach', 'transformationTool', 'orchestrationTool', 'namingConvention', 'database'].includes(k));
    if (unknown.length) throw new CliError(EXIT.USAGE, `context target: unknown --set ${unknown.join(', ')} (modelingApproach, transformationTool, orchestrationTool, namingConvention, database).`);
    let written;
    try { written = writeTargetContextDraft(ctx.workspaceRoot, problemRoot, { connectionId: ctx.values.connection, platform: ctx.values.platform, ...set, schema: ctx.values.schema?.[0] }); }
    catch (err) { throw new CliError(EXIT.FAILED, `The target context isn't valid: ${err instanceof Error ? err.message : String(err)}`); }
    emit(ctx, { ok: true, target: written }, `Drafted ${rel(targetContextFile(problemRoot))} (${written.platform}${written.connectionId ? ` via ${written.connectionId}` : ''}). Approve it as the target stage's document: \`autode workflow approve <stage>\` or the Workflow view.`);
    return EXIT.OK;
  }
  if (sub === 'sources') {
    const ids = (ctx.values.system ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const entries: SourceContextEntry[] = [];
    for (const id of ids) {
      const e = sourceEntryForSystem(ctx.workspaceRoot, id);
      if (!e) throw new CliError(EXIT.NOT_FOUND, `No source system "${id}" in the estate (${sourceSystemChoices(ctx.workspaceRoot).map((s) => s.id).join(', ') || 'none yet'}).`);
      entries.push(e);
    }
    if (ctx.values.summary) entries.push({ connectionId: 'described', method: 'described', description: ctx.values.summary });
    if (!entries.length) throw new CliError(EXIT.USAGE, 'context sources --system <id,…> [--summary <text for a source with no connection>]');
    let written;
    try { written = writeSourceContextDraft(problemRoot, entries, {}, new Date(), ctx.workspaceRoot); }
    catch (err) { throw new CliError(EXIT.FAILED, `The source context isn't valid: ${err instanceof Error ? err.message : String(err)}`); }
    emit(ctx, { ok: true, source: written }, `Drafted ${rel(sourceContextFile(problemRoot))} (${written.sources.map((e) => e.system ?? 'described').join(', ')}). Approve it as the source stage's document: \`autode workflow approve <stage>\` or the Workflow view.`);
    return EXIT.OK;
  }
  throw new CliError(EXIT.USAGE, 'context show | target --connection <id> --set modelingApproach=… [--set …] [--schema <s>] | sources --system <id,…> [--summary <text>]');
}

async function cmdRunbook(ctx: Ctx, rest: string[]): Promise<number> {
  const [sub = 'list', id] = rest;
  const problemId = singleProblem(ctx);
  if (!problemId) throw new CliError(EXIT.NOT_FOUND, 'No business problem: start one with `autode problems new`.');
  const problemRoot = layoutPath(ctx.workspaceRoot, 'problems', problemId);
  const policy = loadRunbookPolicy(ctx.workspaceRoot);
  const store = new DecisionStore(ctx.workspaceRoot);
  const pending = store.list({ status: 'pending', kind: 'runbook' }).filter((d) => d.problemId === problemId);
  const records = listRunbooks(problemRoot);
  if (sub === 'list') {
    const lines = [
      ...pending.map((d) => `  ? ${d.title} — waits for approval (decision ${d.id})`),
      ...records.map((r) => `  ${r.status === 'ran' ? '✓' : r.status === 'failed' ? '✗' : '·'} ${r.runbook.id.padEnd(28)} ${r.environment.padEnd(8)} ${r.status}  ${r.runbook.steps.filter((s) => r.steps[s.id]?.state === 'done').length}/${r.runbook.steps.length} steps  approvals: ${r.approvals.map((a) => a.by).join(', ') || 'none'}`)
    ];
    emit(ctx, { ok: true, pending: pending.map((d) => ({ id: d.id, title: d.title })), runbooks: records.map((r) => ({ id: r.runbook.id, environment: r.environment, status: r.status, approvals: r.approvals, steps: r.steps })) }, lines.length ? lines.join('\n') : 'No runbooks in this problem.');
    return EXIT.OK;
  }
  if (!id) throw new CliError(EXIT.USAGE, `runbook ${sub} needs an id.`);
  const record = records.find((r) => r.runbook.id === id);
  const decision = pending.find((d) => store.proposal<Runbook>(d.id).id === id);
  if (sub === 'show') {
    const rb = record?.runbook ?? (decision ? store.proposal<Runbook>(decision.id) : undefined);
    if (!rb) throw new CliError(EXIT.NOT_FOUND, `No runbook "${id}".`);
    const check = checkRunbook(rb, { workspaceRoot: ctx.workspaceRoot, connections: platformSession(ctx).config().connections, policy });
    const lines = [
      `${rb.id}: ${rb.title}`, `Why: ${rb.reason}`, `Connection: ${rb.connectionId} (${check.environment.name})`, record ? `Status: ${record.status}; approvals: ${record.approvals.map((a) => `${a.by} (${a.channel})`).join(', ') || 'none'}` : `Waits for approval: decision ${decision!.id}`,
      ...(check.ok ? [] : check.errors.map((e) => `✗ ${e}`)),
      ...check.steps.map((s) => `  ${s.id} [${s.class}] ${s.title}\n      runs: ${s.run.sql ?? s.run.argv?.join(' ')}${s.dryRun ? `\n      dry run: ${s.dryRun.label}` : ''}${s.rollback ? `\n      rollback: ${s.rollback.steps ? s.rollback.steps.map((x) => x.run.sql ?? x.run.argv?.join(' ')).join('; ') : s.rollback.procedure}` : ''}${record ? `\n      state: ${record.steps[s.id]?.state ?? 'pending'}` : ''}`),
      rb.explanation ? `The agent's explanation: ${rb.explanation}` : ''
    ].filter(Boolean);
    emit(ctx, { ok: check.ok, runbook: rb, check, record }, lines.join('\n'));
    return EXIT.OK;
  }
  if (sub === 'approve') {
    if (decision) return cmdDecisions(ctx, ['approve', decision.id]);
    if (!record) throw new CliError(EXIT.NOT_FOUND, `No runbook "${id}" waits for approval.`);
    if (record.status !== 'awaiting-second-approval') throw new CliError(EXIT.FAILED, `${id} is ${record.status}; it needs no approval now.`);
    requirePerson(ctx, 'Approving', 'Approve it in the Runbook tab in VS Code.');
    const by = (ctx.values.by ?? safeUsername()).trim();
    const answer = (await ctx.io.prompt(`Give the second approval of runbook ${id} (${record.environment}) as "${by}"? Type approve to confirm: `)).trim().toLowerCase();
    if (answer !== 'approve') { ctx.io.out('Not confirmed; nothing changed.'); return EXIT.REFUSED; }
    const r = approveRunbook(problemRoot, record, by, 'cli', policy);
    if (!r.record) throw new CliError(EXIT.REFUSED, r.problem ?? 'Not approved.');
    emit(ctx, { ok: true, status: r.record.status }, `Runbook ${id}: ${r.record.status === 'approved' ? 'approved; run it from its Runbook tab in VS Code' : 'approval recorded'}.`);
    return EXIT.OK;
  }
  throw new CliError(EXIT.USAGE, 'runbook list | show <id> | approve <id>');
}

async function cmdSkills(ctx: Ctx, rest: string[]): Promise<number> {
  const [sub = 'list', name] = rest;
  const home = ctx.io.env.AUTODE_HOME ?? os.homedir();
  const cat = skillCatalog({ resourcesRoot: ctx.resourcesRoot, workspaceRoot: ctx.workspaceRoot, home, env: ctx.io.env });
  const line = (e: CatalogEntry) => `  ${e.name.padEnd(38)} ${e.group === 'external' ? `${(e.owner ?? '').padEnd(12)} ${e.availability}${e.availability === 'installable' ? (e.installed?.length ? ', installed' : ', not installed') : e.availability === 'host-only' && e.installed?.length ? ', available' : ''}` : `${e.stageKinds.join(', ') || '—'}${e.platforms.length && !e.platforms.includes('any') ? ` [${e.platforms.join(', ')}]` : ''}${e.maturity ? ` · ${e.maturity}` : ''}${e.status ? ` · ${e.status}` : ''}`}`;
  if (sub === 'list') {
    const groups: CatalogGroup[] = ['autode', 'workspace', 'interview', 'external'];
    if (ctx.values.group && !groups.includes(ctx.values.group as CatalogGroup)) throw new CliError(EXIT.USAGE, `--group is one of ${groups.join(', ')}.`);
    const entries = cat.entries.filter((e) => !ctx.values.group || e.group === ctx.values.group);
    const title: Record<CatalogGroup, string> = { autode: 'AutoDE skills', workspace: 'This workspace\'s imported skills', interview: 'Interview packs', external: 'External skills (references; not shipped with AutoDE)' };
    const text = groups.filter((g) => entries.some((e) => e.group === g)).map((g) => `${title[g]}:\n${entries.filter((e) => e.group === g).map(line).join('\n')}`).join('\n\n');
    emit(ctx, { ok: cat.errors.length === 0, skills: entries, errors: cat.errors }, [text || 'No skills.', ...cat.errors.map((e) => `✗ ${e}`)].join('\n'));
    return cat.errors.length ? EXIT.FAILED : EXIT.OK;
  }
  if (['analyze', 'import', 'update', 'review', 'publish'].includes(sub)) return cmdPortSkill(ctx, sub, name);
  const e = cat.entries.find((x) => x.name === name);
  if (!name) throw new CliError(EXIT.USAGE, `skills ${sub} needs a skill name.`);
  if (!e) throw new CliError(EXIT.NOT_FOUND, `No skill "${name}" (see \`autode skills list\`).`);
  if (sub === 'show') {
    const lines = [
      `${e.name} (${e.group})`, e.summary,
      e.stageKinds.length ? `Stage kinds: ${e.stageKinds.join(', ')}` : '', e.platforms.length ? `Platforms: ${e.platforms.join(', ')}` : '',
      e.version !== undefined ? `Version: ${e.version}${e.maturity ? ` (${e.maturity})` : ''}` : '', e.roles?.length ? `Used by: ${e.roles.join(', ')}` : '',
      e.owner ? `Owner: ${e.owner}` : '', e.status ? `State: ${e.status}` : '', e.source ? `Source: ${e.source}` : '',
      e.licence ? `Licence: ${e.licence.name}${e.licence.url ? ` (${e.licence.url})` : ''}. ${e.licence.summary ?? ''}` : '',
      e.availability ? `Availability: ${e.availability}${e.installed ? ` — ${e.installed.length ? `found: ${e.installed.join(', ')}` : 'not found on this machine'}` : ''}` : '',
      e.installer ? `Install: ${e.installer.command.join(' ')} (last verified ${e.installer.verifiedAt ?? '—'}; \`autode skills check ${e.name}\` probes it first)` : ''
    ].filter(Boolean);
    emit(ctx, { ok: true, skill: e }, lines.join('\n'));
    return EXIT.OK;
  }
  if (sub === 'check' || sub === 'install') {
    if (!e.installer) throw new CliError(EXIT.FAILED, e.availability === 'host-only' ? `${e.name} exists only inside its vendor's host; there is nothing to install elsewhere.` : `${e.name} has no install command: ${e.availability === 'importable' ? 'it is imported through AutoDE (check its licence first)' : 'see its source'}.`);
    const run = ctx.io.run ?? spawnRunner;
    const probe = probeInstaller(e.installer, run);
    if (sub === 'check' || !probe.ok) { emit(ctx, { ok: probe.ok, skill: e.name, probe }, `${probe.ok ? '✓' : '✗'} ${probe.reason}`); return probe.ok ? EXIT.OK : EXIT.FAILED; }
    requirePerson(ctx, 'Installing', `Run it yourself: ${e.installer.command.join(' ')}`);
    // With --json, stdout carries only the JSON result.
    (ctx.json ? ctx.io.err : ctx.io.out)([`This runs the vendor's own command: ${e.installer.command.join(' ')}`, e.licence ? `Licence: ${e.licence.name}. ${e.licence.summary ?? ''}` : '', e.installer.docs ? `Vendor docs: ${e.installer.docs}` : ''].filter(Boolean).join('\n'));
    const answer = (await ctx.io.prompt('Type install to run it: ')).trim().toLowerCase();
    if (answer !== 'install') { (ctx.json ? ctx.io.err : ctx.io.out)('Not confirmed; nothing was run.'); return EXIT.REFUSED; }
    // The vendor's output goes straight to the terminal; AutoDE then checks the result, not the exit code.
    const r = (ctx.io.run ?? ((argv: string[]) => { const x = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', shell: false, windowsHide: true }); return { code: x.status, stdout: '', stderr: '', error: x.error?.message }; }))(e.installer.command);
    const after = skillCatalog({ resourcesRoot: ctx.resourcesRoot, workspaceRoot: ctx.workspaceRoot, home, env: ctx.io.env }).entries.find((x) => x.name === e.name);
    const found = after?.installed ?? [];
    emit(ctx, { ok: found.length > 0, skill: e.name, exitCode: r.code, installed: found }, found.length ? `✓ ${e.name} is installed: ${found.join(', ')}` : `✗ ${e.installer.command.join(' ')} ${r.code === 0 ? 'finished' : `exited with ${r.code ?? r.error}`}, but ${e.name} wasn't found in a host's skills folder. Check the vendor's output above${e.installer.docs ? `, or ${e.installer.docs}` : ''}.`);
    return found.length ? EXIT.OK : EXIT.FAILED;
  }
  throw new CliError(EXIT.USAGE, 'skills list | show <name> | check <name> | install <name> | analyze <source> | import <source> | update <id> | review <id> | publish <id>');
}

/**
 * Port a skill (PA4): analyze and import from a folder, a Git URL or a dbt package; update re-fetches and shows
 * the diff; review and publish are a person's acts in a terminal.
 */
async function cmdPortSkill(ctx: Ctx, sub: string, arg: string | undefined): Promise<number> {
  if (!arg) throw new CliError(EXIT.USAGE, sub === 'analyze' || sub === 'import' ? `skills ${sub} <folder | Git URL> [--ref <branch or tag>] [--skill <path in it>]${sub === 'import' ? ' [--replace]' : ''}` : `skills ${sub} <id>`);
  const say = (text: string) => (ctx.json ? ctx.io.err : ctx.io.out)(text);
  const by = (ctx.values.by ?? safeUsername()).trim();
  if (sub === 'analyze' || sub === 'import') {
    const isGit = /^(https:\/\/|git@|ssh:\/\/|file:\/\/)/.test(arg) || arg.endsWith('.git');
    const kind = isGit ? 'git' : fs.existsSync(path.join(arg, 'dbt_project.yml')) || /[\\/]dbt_packages[\\/]/.test(arg) ? 'dbt' : 'local';
    let run: port.PortRun;
    try { run = port.portSource({ kind, location: arg, ref: ctx.values.ref }, { resourcesRoot: ctx.resourcesRoot, workspaceRoot: ctx.workspaceRoot, subpath: ctx.values.skill }); }
    catch (err) { if (err instanceof port.PortError) throw new CliError(EXIT.FAILED, err.message); throw err; }
    try {
      if (!run.analysis) {
        emit(ctx, { ok: false, skills: run.skills }, `${run.skills.length} skills found; choose one with --skill:\n${run.skills.map((s) => `  ${(s.subpath || '.').padEnd(40)} ${s.name}: ${s.description.slice(0, 80)}`).join('\n')}`);
        return EXIT.USAGE;
      }
      const a = run.analysis;
      if (sub === 'analyze') { emit(ctx, { ok: a.problems.length === 0, analysis: a, provenance: run.staged.provenance }, run.report!); return a.problems.length ? EXIT.FAILED : EXIT.OK; }
      if (a.problems.length) { emit(ctx, { ok: false, analysis: a }, `${run.report}\n✗ Not imported.`); return EXIT.REFUSED; }
      let r: ReturnType<typeof port.importSkill>;
      try { r = port.importSkill({ workspaceRoot: ctx.workspaceRoot, stagedDir: run.staged.dir, analysis: a, provenance: run.staged.provenance, by, managementEnabled: port.managementEnabledIn(ctx.workspaceRoot), replace: ctx.values.replace }); }
      catch (err) { if (err instanceof port.PortError) throw new CliError(EXIT.REFUSED, err.message); throw err; }
      emit(ctx, { ok: true, id: r.id, sidecar: r.sidecar, analysis: a }, `${run.report}\n✓ Imported as ${r.id} (${r.sidecar.status}, unreviewed). Next: \`autode skills review ${r.id}\` in your terminal${r.sidecar.status === 'draft' ? `, then \`autode skills publish ${r.id}\`` : ''}.`);
      return EXIT.OK;
    } finally { run.staged.cleanup(); }
  }
  const dir = path.join(port.toolSkillsDir(ctx.workspaceRoot), arg);
  const state = lifecycle.loadToolSkillState(port.toolSkillsDir(ctx.workspaceRoot), arg, `user:${by}`);
  if (!state) throw new CliError(EXIT.NOT_FOUND, `No imported skill "${arg}" (see \`autode skills list --group workspace\`).`);
  if (sub === 'update') {
    let up: ReturnType<typeof port.stageUpdate>;
    try { up = port.stageUpdate(dir); } catch (err) { if (err instanceof port.PortError) throw new CliError(EXIT.FAILED, err.message); throw err; }
    try {
      const diff = port.diffSkill(dir, up.freshDir);
      const commit = up.staged.provenance.resolvedCommit;
      if (!diff.length) { emit(ctx, { ok: true, changed: false, commit }, `${arg} is up to date with its source${commit ? ` (commit ${commit.slice(0, 12)})` : ''}.`); return EXIT.OK; }
      const fresh = port.analyzeSkill(up.freshDir, state.sidecar.provenance.subpath ?? '', port.analysisContext(ctx.resourcesRoot, ctx.workspaceRoot, up.staged.dir));
      const text = [`Changes in ${arg}${commit ? ` (to commit ${commit.slice(0, 12)})` : ''}:`, ...diff.map((d) => `\n${d.change === 'removed' ? '-' : d.change === 'added' ? '+' : '~'} ${d.path}${d.diff ? `\n${d.diff}` : ''}`), '', port.capabilityReport(fresh, up.staged.provenance)].join('\n');
      if (fresh.problems.length) { emit(ctx, { ok: false, diff, analysis: fresh }, `${text}\n✗ The new version can't be imported.`); return EXIT.REFUSED; }
      requirePerson(ctx, 'Updating a skill', `Run \`autode skills update ${arg}\` in a terminal, or use Update Skill in VS Code.`);
      say(text);
      if ((await ctx.io.prompt(`The new content is unreviewed until you review it again. Type update to apply: `)).trim().toLowerCase() !== 'update') { say('Not confirmed; nothing changed.'); return EXIT.REFUSED; }
      const sc = port.applyUpdate(dir, up.staged, up.freshDir, fresh, `user:${by}`);
      emit(ctx, { ok: true, changed: true, sidecar: sc }, `✓ ${arg} updated; it is unreviewed. Next: \`autode skills review ${arg}\`.`);
      return EXIT.OK;
    } finally { up.staged.cleanup(); }
  }
  if (sub === 'review') {
    const tier = (ctx.values.tier ?? 'reviewed') as lifecycle.TrustTier;
    if (!lifecycle.TRUST_TIERS.includes(tier)) throw new CliError(EXIT.USAGE, `--tier is one of ${lifecycle.TRUST_TIERS.join(', ')}.`);
    requirePerson(ctx, 'Reviewing a skill', 'Review it in VS Code (AutoDE: Review Tool Skill) or in a terminal.');
    const a = port.readAnalysis(dir);
    say([lifecycle.buildSkillReviewDocument(state, state.skill.declaredTools), a ? port.capabilityReport(a, state.sidecar.provenance) : ''].join('\n'));
    if ((await ctx.io.prompt(`Type ${tier} to mark this content ${tier}: `)).trim().toLowerCase() !== tier) { say('Not confirmed; nothing changed.'); return EXIT.REFUSED; }
    const sc = lifecycle.setTrustTier(dir, tier, `user:${by}`);
    emit(ctx, { ok: true, sidecar: sc }, `✓ ${arg} is ${tier} for its current content.${sc.status === 'draft' ? ` Next: \`autode skills publish ${arg}\`.` : ''}`);
    return EXIT.OK;
  }
  requirePerson(ctx, 'Publishing a skill', 'Publish it in VS Code (AutoDE: Publish Tool Skill) or in a terminal.');
  if ((await ctx.io.prompt(`Publish ${arg} (${state.effectiveTier})? Type publish: `)).trim().toLowerCase() !== 'publish') { say('Not confirmed; nothing changed.'); return EXIT.REFUSED; }
  try {
    const r = lifecycle.publishToolSkill(dir, `user:${by}`);
    emit(ctx, { ok: true, sidecar: r.sidecar }, `✓ ${arg} published as version ${r.sidecar.version}.`);
    return EXIT.OK;
  } catch (err) { throw new CliError(EXIT.REFUSED, err instanceof Error ? err.message : String(err)); }
}

function cmdPlugin(ctx: Ctx, rest: string[]): number {
  const [sub] = rest;
  const entry = serverEntry(ctx.resourcesRoot, ctx.io.env);
  if (sub === 'path') {
    const out = ctx.values.out ? path.resolve(ctx.io.cwd, ctx.values.out) : path.join(ctx.resourcesRoot, 'dist', 'plugin', 'autode');
    const r = buildPlugin({ resourcesRoot: ctx.resourcesRoot, outDir: out, version: ctx.version, entry });
    emit(ctx, { ok: r.errors.length === 0, dir: r.dir, files: r.files.map((f) => path.relative(r.dir, f).split(path.sep).join('/')), errors: r.errors },
      [r.dir, `Claude Code: claude --plugin-dir "${r.dir}" (or add it to a plugin marketplace). Cortex Code reads the same layout.`, ...r.errors.map((e) => `✗ ${e}`)].join('\n'));
    return r.errors.length ? EXIT.FAILED : EXIT.OK;
  }
  if (sub === 'install') {
    const host = ctx.values.host as PluginHost | undefined;
    if (!host || !PLUGIN_HOSTS.includes(host)) throw new CliError(EXIT.USAGE, `plugin install needs --host, one of: ${PLUGIN_HOSTS.join(', ')}.`);
    const scope = ctx.values.scope ?? 'project';
    if (scope !== 'project' && scope !== 'user') throw new CliError(EXIT.USAGE, '--scope is project or user.');
    const r = installPlugin({ host, scope, resourcesRoot: ctx.resourcesRoot, workspaceRoot: ctx.workspaceRoot, home: ctx.io.env.AUTODE_HOME ?? os.homedir(), entry });
    const lines = [
      `Installed AutoDE for ${host} (${scope}): ${r.written.length} files.`,
      ...r.written.map((f) => `  ${f}`),
      r.mcp.file ? (r.mcp.changed ? `MCP server set in ${r.mcp.file}.` : `MCP server already set in ${r.mcp.file}.`) : `Next: ${r.mcp.instruction}`,
      ...r.notes, ...r.errors.map((e) => `✗ ${e}`),
      'Then ask the agent to continue your AutoDE problem (the autode-core-orchestrator skill).'
    ];
    emit(ctx, { ok: r.errors.length === 0, host, scope, written: r.written, mcp: r.mcp, notes: r.notes, errors: r.errors }, lines.join('\n'));
    return r.errors.length ? EXIT.FAILED : EXIT.OK;
  }
  throw new CliError(EXIT.USAGE, 'plugin path | install --host claude|cortex|copilot [--scope project|user]');
}

async function cmdWorkflow(ctx: Ctx, rest: string[]): Promise<number> {
  const [sub = 'status', ...args] = rest;
  if (sub === 'templates') {
    const { templates, errors } = templatesFor({ workspaceRoot: ctx.workspaceRoot, resourcesRoot: ctx.resourcesRoot });
    emit(ctx, { ok: errors.length === 0, templates: templates.map((t) => ({ id: t.id, version: t.version, title: t.title, origin: t.origin, stages: t.stages.map((x) => ({ id: x.id, kind: x.kind, inclusion: x.inclusion, when: x.when })) })), errors },
      [...templates.map((t) => `${t.id} v${t.version} (${t.origin}) — ${t.title}\n${t.stages.map((x) => `    ${x.inclusion.padEnd(11)} ${x.id} [${x.kind}]${x.when ? ` when ${x.when}` : ''}`).join('\n')}`), ...errors.map((e) => `✗ ${e}`)].join('\n'));
    return errors.length ? EXIT.FAILED : EXIT.OK;
  }
  const problemId = singleProblem(ctx);
  if (!problemId) throw new CliError(EXIT.NOT_FOUND, 'No business problem: start one with `autode problems new`.');
  const scope: WorkflowScope = { workspaceRoot: ctx.workspaceRoot, resourcesRoot: ctx.resourcesRoot, problemId };
  const rctx = { workspaceRoot: ctx.workspaceRoot, problemRoot: layoutPath(ctx.workspaceRoot, 'problems', problemId), problemId };
  const by = (ctx.values.by ?? safeUsername()).trim();
  const who: Actor = { kind: 'person', name: by };
  try {
    if (sub === 'status') {
      const st = statusFor(scope);
      emit(ctx, { ok: true, ...st }, [`${problemId} — ${st.template}${st.approved ? '' : ' (not approved yet)'}`, ...st.stages.map((x) => `  ${STATUS_MARK[x.status] ?? ' '} ${x.id.padEnd(18)} ${x.status}${x.why ? ` — ${x.why}` : ''}`), st.next ? `Next: ${st.next.id} (${st.next.status})` : 'Nothing to do now.'].join('\n'));
      return EXIT.OK;
    }
    if (sub === 'plan') {
      const suggestion = suggestFor(scope);
      const w = redraftOrKeep(scope, ctx.values.template, who);
      const { templates } = templatesFor(scope);
      const diff = diffWorkflow(w, templates.find((t) => t.id === w.template.id)!);
      const d = proposeWorkflow(scope, w, { host: 'cli', client: by });
      const lines = [
        `Workflow for ${problemId}: ${w.template.id}${!ctx.values.template && suggestion ? ` (suggested: ${suggestion.reason})` : ''}`,
        ...w.stages.map((x) => `  ${x.included ? '+' : '−'} ${x.id} [${x.kind}]${x.included ? '' : ` — ${x.reason ?? 'optional, not included'}`}${x.systems?.length ? ` (per source system: ${x.systems.join(', ')})` : ''}`),
        ...diff.dropped.map((x) => `  left out: ${x.id} — ${x.reason ?? 'no reason'}`),
        d.validation.ok ? `Proposed as decision ${d.id}. Approve it with \`autode workflow approve\` (or in the panel).` : `✗ ${d.validation.errors.join('; ')}`
      ];
      emit(ctx, { ok: d.validation.ok, decisionId: d.id, workflow: w, diff, validation: d.validation }, lines.join('\n'));
      return EXIT.OK;
    }
    if (sub === 'history') {
      if (args.length > 1) throw new CliError(EXIT.USAGE, 'workflow history takes at most one stage id.');
      const events = historyFor(scope, args[0]);
      emit(ctx, { ok: true, events }, events.length ? events.map((e) => `${e.at.replace('T', ' ').slice(0, 19)}  ${e.type.padEnd(10)} ${e.stage ? `${e.stage.padEnd(16)} ` : ''.padEnd(17)}by ${actorLabel(e.actor)}${e.channel ? ` (${e.channel})` : ''}${e.template ? ` · ${e.template}` : ''}${e.decisionId ? ` · ${e.decisionId}` : ''}${e.reason ? ` — ${e.reason}` : ''}${e.files?.length ? ` [${e.files.join(', ')}]` : ''}`).join('\n') : 'No history yet.');
      return EXIT.OK;
    }
    if (sub === 'next') {
      ensureWorkflow(scope);
      const n = nextAssignment(rctx);
      emit(ctx, { ok: true, next: n ?? null }, n ? `${n.stage.id} (${n.stage.status}): ${n.instructions}` : 'Nothing to do now: every included stage is done or waiting for something outside AutoDE.');
      return EXIT.OK;
    }
    if (sub === 'start') {
      if (args.length !== 1) throw new CliError(EXIT.USAGE, 'workflow start takes one stage id.');
      const r = startStage(rctx, args[0], who, 'cli');
      emit(ctx, { ok: true, ...r }, `${args[0]} is in progress.${r.warning ? `\n! ${r.warning}` : ''}`);
      return EXIT.OK;
    }
    if (sub === 'complete') {
      if (args.length !== 1) throw new CliError(EXIT.USAGE, 'workflow complete takes one stage id.');
      const r = completeStage(rctx, args[0], { outputs: (ctx.values.output ?? []).map((o) => rel(ctx, path.resolve(ctx.io.cwd, o))), summary: ctx.values.summary ?? '', who, channel: 'cli' });
      emit(ctx, { ok: true, ...r }, r.message);
      return EXIT.OK;
    }
    if (sub === 'skip' || sub === 'reopen') {
      if (args.length !== 1 || !ctx.values.reason) throw new CliError(EXIT.USAGE, `workflow ${sub} takes one stage id and --reason <text>.`);
      if (sub === 'skip') { const v = skipStage(rctx, args[0], ctx.values.reason, who, 'cli'); emit(ctx, { ok: true, stage: v }, `${args[0]} skipped: ${ctx.values.reason}`); }
      else { const r = reopenStage(rctx, args[0], who, ctx.values.reason, 'cli'); emit(ctx, { ok: true, ...r }, `${args[0]} re-opened.${r.stale.length ? ` Now stale: ${r.stale.join(', ')}.` : ''}`); }
      return EXIT.OK;
    }
    if (sub === 'approve') {
      const store = new DecisionStore(ctx.workspaceRoot);
      const pending = store.list({ status: 'pending' }).filter((d) => d.problemId === problemId);
      const target = args[0]
        ? pending.find((d) => d.kind === 'gate' && d.subject?.document === `workflow:${args[0]}`)
        : pending.find((d) => d.kind === 'workflow') ?? pending.find((d) => d.kind === 'gate');
      const stage = args[0] ? readWorkflow(rctx.problemRoot)?.stages.find((x) => x.id === args[0]) : undefined;
      if (!target && stage && isDocumentStage(stage.kind)) {
        // v0.45.1: a stage whose output is a document with its own approval (spec, contexts, mapping, Pipeline Spec).
        requirePerson(ctx, 'Approving', 'Approve it in the AutoDE panel or the Workflow view instead.');
        const problems = documentApprovalProblems(rctx.problemRoot, stage.kind);
        if (problems.length) throw new CliError(EXIT.FAILED, problems.join(' '));
        const file = stageDocumentFile(rctx.problemRoot, stage.kind)!;
        const oneStep = problemMode(rctx.problemRoot) === 'exploration';
        const answer = (await ctx.io.prompt(oneStep ? `Approve ${path.relative(ctx.workspaceRoot, file)} (${stage.title}) as "${by}" (exploration mode)? [y/N] ` : `Approve ${path.relative(ctx.workspaceRoot, file)} (${stage.title}) as "${by}"? Type approve to confirm: `)).trim().toLowerCase();
        if (oneStep ? answer !== 'y' && answer !== 'yes' : answer !== 'approve') { ctx.io.out('Not confirmed; nothing changed.'); return EXIT.REFUSED; }
        const r = approveStageDocument(rctx, stage.id, { kind: 'person', name: by }, 'cli');
        emit(ctx, { ok: true, stage: r.stage, file: path.relative(ctx.workspaceRoot, r.file).split(path.sep).join('/') }, r.message);
        return EXIT.OK;
      }
      if (!target) throw new CliError(EXIT.NOT_FOUND, args[0] ? `Nothing of stage ${args[0]} waits for approval.` : 'No workflow or stage approval is pending.');
      return cmdDecisions(ctx, ['approve', target.id]);
    }
  } catch (err) {
    if (err instanceof WorkflowError) throw new CliError(err.code === 'NOT_FOUND' ? EXIT.NOT_FOUND : err.code === 'CHECK_FAILED' ? EXIT.FAILED : EXIT.REFUSED, err.message);
    throw err;
  }
  throw new CliError(EXIT.USAGE, 'workflow takes templates, status, plan, next, start, complete, approve, skip or reopen.');
}

/** A new draft from the chosen template (or the suggestion); an approved workflow is re-planned from itself. */
function redraftOrKeep(scope: WorkflowScope, templateId: string | undefined, who: Actor) {
  const current = readWorkflow(layoutPath(scope.workspaceRoot, 'problems', scope.problemId));
  if (current && current.status === 'approved') {
    // Re-planning: a fresh draft from the current facts, proposed as a revision. The same template keeps the
    // shared stages' state when approved; a new template restarts the workflow (owner, 2026-10-21).
    const id = templateId ?? current.template.id;
    if (!templatesFor(scope).templates.some((x) => x.id === id)) throw new CliError(EXIT.NOT_FOUND, `No workflow template "${id}".`);
    return draftFrom(scope, id, templateId ? who : undefined);
  }
  return redraft(scope, templateId, templateId ? who : undefined);
}

// ── facts, pack, vocabulary, design doc, SQL (v0.43.3) ───────────────────────

const actorOf = (ctx: Ctx) => `user:${(ctx.values.by ?? safeUsername()).trim()}`;

function factLine(f: FactView): string {
  const tags = [f.stakes === 'high' ? 'high stakes' : 'low stakes', f.status, f.trust, ...(f.flags ?? [])].join(', ');
  return `${f.id}  [${f.kind}] ${f.statement}\n    ${tags}${f.supersedes ? `; corrects: ${f.supersedes.statement ?? f.supersedes.id}` : ''}${f.verification ? `; probe ${f.verification.result}${f.verification.detail ? ` (${f.verification.detail})` : ''}` : ''}${f.reviewReason ? `; ${f.reviewReason}` : ''}\n    from ${f.createdBy ?? 'unknown'}${f.evidence[0] ? `, ${f.evidence[0].ref}` : ''}`;
}

async function cmdFacts(ctx: Ctx, rest: string[]): Promise<number> {
  const [sub = 'list', ...ids] = rest;
  const cfm = await openContext(ctx.workspaceRoot, () => undefined);
  try {
    const ledger = cfm.getLedger();
    if (sub === 'list') {
      const box = inbox(ledger);
      const byId = new Map(ledger.assertions().map((a) => [a.id, a] as const));
      const facts = ctx.values.all ? ledger.assertions().filter((a) => !isMirror(a)).map((a) => factView(a, byId)) : box.facts;
      const shown = facts.filter((f) => !ctx.values.kind || f.kind === ctx.values.kind);
      emit(ctx, { ok: true, facts: shown, conflicts: box.conflicts }, shown.length
        ? `${shown.map(factLine).join('\n')}\n${shown.length} fact(s)${ctx.values.all ? '' : ' waiting for review'}; ${box.conflicts.length} conflict(s).`
        : `Nothing waits for review.${box.conflicts.length ? ` ${box.conflicts.length} conflict(s): autode facts conflicts.` : ''}`);
      return EXIT.OK;
    }
    if (sub === 'conflicts') {
      const box = inbox(ledger);
      emit(ctx, { ok: true, conflicts: box.conflicts }, box.conflicts.length ? box.conflicts.map((c) => `${c.rule} on ${c.key}: ${c.ids.map((id) => `${id} "${ledger.get(id)?.statement ?? ''}"`).join(' vs ')}`).join('\n') : 'No conflicts.');
      return EXIT.OK;
    }
    if (sub === 'show') {
      if (ids.length !== 1) throw new CliError(EXIT.USAGE, 'facts show takes one fact id.');
      const a = ledger.get(ids[0]);
      if (!a || isMirror(a)) throw new CliError(EXIT.NOT_FOUND, `No fact "${ids[0]}".`);
      const v = factView(a, new Map(ledger.assertions().map((x) => [x.id, x] as const)));
      emit(ctx, { ok: true, fact: { ...v, evidence: a.evidence } }, `${factLine(v)}\n    value: ${JSON.stringify(a.value)}\n    subject: ${a.subject.join(', ')}\n    evidence:${a.evidence.map((e) => `\n      - ${e.type}: ${e.ref}${'quote' in e && e.quote ? ` — "${String(e.quote)}"` : ''}`).join('')}`);
      return EXIT.OK;
    }
    if (sub !== 'confirm' && sub !== 'reject' && sub !== 'edit') throw new CliError(EXIT.USAGE, 'facts takes list, show <id>, confirm <id>..., reject <id>, edit <id>, or conflicts.');
    requirePerson(ctx, `facts ${sub}`, 'Review facts in the AutoDE panel (Context Inbox), or in a terminal.');
    const actor = actorOf(ctx);
    if (sub === 'confirm' && ctx.values.from) {
      const n = ledger.assertions().filter((a) => a.createdBy === ctx.values.from && a.status === 'proposed' && a.trust === 'documented' && !isMirror(a)).length;
      if (!n) throw new CliError(EXIT.NOT_FOUND, `No documented fact from "${ctx.values.from}" waits for confirmation (bulk confirmation is for documented facts from one source).`);
      if ((await ctx.io.prompt(`Confirm ${n} documented fact(s) from ${ctx.values.from}? Type confirm: `)).trim().toLowerCase() !== 'confirm') { ctx.io.out('Nothing changed.'); return EXIT.REFUSED; }
      const done = await bulkConfirmDocumented(ledger, ctx.values.from, actor);
      await cfm.persistCompiledGraph();
      emit(ctx, { ok: true, confirmed: done }, `Confirmed ${done} documented fact(s) from ${ctx.values.from}.`);
      return EXIT.OK;
    }
    if (!ids.length || (sub !== 'confirm' && ids.length > 1)) throw new CliError(EXIT.USAGE, sub === 'confirm' ? 'facts confirm takes fact ids (or --from <source>).' : `facts ${sub} takes one fact id.`);
    for (const id of ids) { const a = ledger.get(id); if (!a || isMirror(a)) throw new CliError(EXIT.NOT_FOUND, `No fact "${id}".`); ctx.io.out(factLine(factView(a, new Map()))); }
    if (sub === 'edit' && ctx.values.statement === undefined && ctx.values.value === undefined) throw new CliError(EXIT.USAGE, 'facts edit needs --statement and/or --value <json>.');
    if ((await ctx.io.prompt(`${sub === 'confirm' ? 'Confirm' : sub === 'reject' ? 'Reject' : 'Replace with your edit and confirm'} ${ids.length > 1 ? `these ${ids.length} facts` : 'this fact'}? Type ${sub}: `)).trim().toLowerCase() !== sub) { ctx.io.out('Nothing changed.'); return EXIT.REFUSED; }
    const lines: string[] = [];
    for (const id of ids) {
      try { lines.push(await reviewFact(ledger, id, sub as ReviewAction, actor, { statement: ctx.values.statement, value: ctx.values.value, note: ctx.values.note })); } catch (err) { throw new CliError(EXIT.FAILED, err instanceof Error ? err.message : String(err)); }
    }
    await cfm.persistCompiledGraph();
    emit(ctx, { ok: true, results: lines }, lines.join('\n'));
    return EXIT.OK;
  } finally { cfm.dispose(); }
}

/** C4c: the completeness checklist for the active problem (deterministic, records nothing). */
async function cmdCoverage(ctx: Ctx): Promise<number> {
  const id = singleProblem(ctx);
  if (!id) throw new CliError(EXIT.NOT_FOUND, 'No business problem in this workspace.');
  const ws = workspace(ctx, id);
  const sources = await ws.contextSources();
  const report = problemCoverage({ workspaceRoot: ctx.workspaceRoot, problemRoot: ws.problemRoot()!, sources }, { probesAvailable: true });
  emit(ctx, { ok: true, problem: id, ...report }, renderCoverage(report));
  return EXIT.OK;
}

/** C4c: candidate keys, foreign keys, grain, change columns and personal data from the data, probed; `--record` records those that pass. */
async function cmdCapture(ctx: Ctx, rest: string[]): Promise<number> {
  if (rest[0] !== 'candidates') throw new CliError(EXIT.USAGE, 'capture takes candidates [--connection <id>] [--record].');
  const id = singleProblem(ctx);
  if (!id) throw new CliError(EXIT.NOT_FOUND, 'No business problem in this workspace.');
  const problemRoot = layoutPath(ctx.workspaceRoot, 'problems', id);
  const session = platformSession(ctx);
  const cfm = await openContext(ctx.workspaceRoot, (m) => ctx.io.err(m));
  try {
    const executor = combineProbeExecutors([await liveExecutor(ctx, session), sampleProbeExecutor(readPackFile(path.join(problemRoot, 'pack')), (d) => readPackDocument(ctx.workspaceRoot, d), (m) => ctx.io.err(m))]);
    const { findings, recorded } = await problemCandidates({ workspaceRoot: ctx.workspaceRoot, problemRoot, sources: cfm.getPackSources() }, executor, { record: ctx.values.record ? cfm.getLedger() : undefined });
    if (recorded.length) await cfm.persistCompiledGraph();
    const lines = findings.map(describeFinding);
    if (!executor) lines.push('No connection or sample to probe with: pass --connection <id>, or add a sample of the table to the pack.');
    lines.push(ctx.values.record ? `${recorded.length} fact(s) recorded${recorded.some((a) => a.status === 'proposed') ? ': confirm them with `autode facts`' : ''}.` : 'Nothing was recorded: add --record to record those that passed.');
    emit(ctx, { ok: true, findings, recorded: recorded.map((a) => ({ id: a.id, kind: a.kind, statement: a.statement, status: a.status, trust: a.trust })) }, lines.join('\n'));
    return EXIT.OK;
  } finally { cfm.dispose(); session.dispose(); }
}

/** C5b: the Knowledge Explorer in a terminal — the same engine answers as the VS Code Explorer and the MCP tools. */
async function cmdExplore(ctx: Ctx, rest: string[]): Promise<number> {
  const [sub = 'overview', ...words] = rest;
  const problemId = singleProblem(ctx);
  const ws = workspace(ctx, problemId);
  const sources = exploreSources(ctx.workspaceRoot, await ws.contextSources(), problemId);
  const ask = (request: ExploreRequest) => handleExploreRequest(request, sources, ctx.workspaceRoot);
  const list = (v: string | undefined) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  if (sub === 'overview') {
    const o = ask({ type: 'overview' }).overview as ExploreOverview;
    emit(ctx, { ok: true, overview: o }, renderOverview(o));
    return EXIT.OK;
  }
  if (sub === 'search') {
    const types = list(ctx.values.type ?? ctx.values.kind);
    const r = ask({ type: 'search', query: words.join(' '), ...(list(ctx.values.layer) ? { layers: list(ctx.values.layer) as Layer[] } : {}), ...(types ? { assetTypes: types as AssetType[] } : {}), ...(ctx.values.system ? { systems: [ctx.values.system] } : {}), ...(ctx.values.platform ? { platforms: [ctx.values.platform] } : {}), ...(ctx.values.environment ? { environments: [ctx.values.environment] } : {}), limit: ctx.values.all ? 1000 : 25 }).result as SearchResult;
    emit(ctx, { ok: true, ...r }, renderSearch(r));
    return r.total ? EXIT.OK : EXIT.NOT_FOUND;
  }
  if (sub === 'browse') {
    const level = ask({ type: 'browse', ...(words.length ? { parent: words.join(' ') } : {}) }).level as { parent?: { label: string }; children: Array<{ id: string; label: string; assetType: string; system?: string; environment?: string; children: number }>; truncated: number };
    const lines = level.children.map((c) => `  ${c.assetType.padEnd(8)} ${c.label}${c.assetType === 'database' ? `  (${c.system}/${c.environment})` : ''}${c.children ? `  ${c.children}` : ''}  [${c.id}]`);
    emit(ctx, { ok: true, ...level }, [level.parent ? `${level.parent.label}:` : 'Databases:', ...(lines.length ? lines : ['  nothing']), ...(level.truncated ? [`  … and ${level.truncated} more`] : [])].join('\n'));
    return EXIT.OK;
  }
  if (sub === 'semantic') {
    const o = ask({ type: 'semantic' }).semantic as SemanticOverview;
    emit(ctx, { ok: true, semantic: o }, renderSemantic(o));
    return EXIT.OK;
  }
  const ref = words.join(' ');
  if (sub === 'graph' && !ref) {
    const r = ask({ type: 'landscape', ...(ctx.values.system ? { system: ctx.values.system } : {}), ...(ctx.values.model ? { model: ctx.values.model } : {}), ...(ctx.values.columns ? { includeColumns: true } : {}) });
    emit(ctx, { ok: true, graph: r.slice }, renderGraph(r.slice as GraphSlice));
    return EXIT.OK;
  }
  if (!ref) throw new CliError(EXIT.USAGE, `explore ${sub} <id|name> (find it with autode explore search <words>).`);
  if (sub === 'asset') {
    const r = ask({ type: 'asset', id: ref });
    if (!r.context) throw new CliError(EXIT.NOT_FOUND, String(r.error));
    emit(ctx, { ok: true, context: r.context }, renderAssetMarkdown(r.context as AssetContext));
    return EXIT.OK;
  }
  if (sub === 'graph') {
    const r = ask({ type: 'graph', id: ref, ...(ctx.values.hops ? { hops: Number(ctx.values.hops) } : {}) });
    if (!r.slice) throw new CliError(EXIT.NOT_FOUND, String(r.error));
    emit(ctx, { ok: true, graph: r.slice }, renderGraph(r.slice as GraphSlice));
    return EXIT.OK;
  }
  throw new CliError(EXIT.USAGE, `Unknown explore command "${sub}": overview, search, browse, semantic, asset or graph.`);
}

/** C5a: the semantic layer — shared models and the active problem's composites. */
async function cmdSemantic(ctx: Ctx, rest: string[]): Promise<number> {
  const [sub = 'show', name] = rest;
  const ws = ctx.workspaceRoot;
  const problemId = singleProblem(ctx);
  const findingLine = (f: SemanticFinding) => `  ${f.severity === 'error' ? '✗' : '!'} ${f.where}: ${f.message}`;
  if (sub === 'show') {
    const shared = sem.listShared(ws);
    const composites = sem.listComposites(ws, problemId);
    const lines = [
      'Shared semantic models:', ...(shared.length ? shared.map((s) => `  ${s.name.padEnd(24)} ${s.status}${s.approved ? ` (approved by ${s.approved.by} at ${s.approved.revision})` : ''}  ${s.model?.tables.length ?? 0} table(s)  rev ${s.revision}`) : ['  none yet: autode semantic draft <name>']),
      `Composites${problemId ? ` of ${problemId}` : ''}:`, ...(composites.length ? composites.map((c) => `  ${c.name.padEnd(24)} ${c.status}${c.staleBecause.length ? ` — ${c.staleBecause.join('; ')}` : ''}  uses ${c.composite?.uses.map((u) => u.model).join(', ') ?? '?'}${c.approvalCurrent ? `  approved by ${c.approved?.by}` : ''}`) : ['  none yet: autode semantic compose <name> --models <m1,m2>'])
    ];
    emit(ctx, { ok: true, shared: shared.map(({ model: _m, ...s }) => s), composites: composites.map(({ composite: _c, ...c }) => c) }, lines.join('\n'));
    return EXIT.OK;
  }
  if (sub === 'compose') {
    if (!name || !problemId) throw new CliError(EXIT.USAGE, 'semantic compose <name> --models <shared1,shared2>, in a workspace with an active problem.');
    const dir = sem.semanticPaths(ws).compositeDir(problemId);
    const file = path.join(dir, `${name}.yaml`);
    if (fs.existsSync(file)) throw new CliError(EXIT.FAILED, `${rel(ctx, file)} exists.`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, newCompositeText(name, (ctx.values.models ?? '').split(',').map((x) => x.trim()).filter(Boolean)));
    emit(ctx, { ok: true, file: rel(ctx, file) }, `Wrote ${rel(ctx, file)}: add what the use case needs, then autode semantic resolve ${name}.`);
    return EXIT.OK;
  }
  if (sub === 'resolve') {
    if (!name || !problemId) throw new CliError(EXIT.USAGE, 'semantic resolve <composite>, in a workspace with an active problem.');
    const r = sem.resolveCompositeFile(ws, problemId, name);
    if (!r.ok) { emit(ctx, { ok: false, errors: r.errors }, `✗ ${name} doesn't resolve:\n${r.errors.map((e) => `  - ${e}`).join('\n')}`); return EXIT.FAILED; }
    emit(ctx, { ok: true, resolvedFile: rel(ctx, r.resolvedFile), changed: r.changed, revisions: r.revisions, diff: r.diff }, `✓ ${rel(ctx, r.resolvedFile)} ${r.changed ? 'written' : 'unchanged'} (${Object.entries(r.revisions).map(([m, v]) => `${m}@${v}`).join(', ')})${r.diff ? `\n${r.diff}` : ''}`);
    return EXIT.OK;
  }
  const cfm = await openContext(ws, (m) => ctx.io.err(m));
  try {
    const sources = cfm.getPackSources();
    const composite = problemId && name ? sem.readComposite(ws, problemId, name) : undefined;
    const findingsFor = (): { errors: string[]; findings: SemanticFinding[] } => {
      if (composite) {
        if (!composite.composite) return { errors: composite.errors, findings: [] };
        const r = resolveComposite(composite.composite, sem.sharedLoader(ws));
        return { errors: r.errors, findings: r.model ? checkSemanticModel(r.model, sources) : [] };
      }
      const s = name ? sem.readShared(ws, name) : undefined;
      if (!s) throw new CliError(EXIT.NOT_FOUND, `No shared model or composite "${name ?? ''}" (autode semantic show).`);
      return { errors: s.errors, findings: s.model ? checkSemanticModel(s.model, { ...sources, ...(s.binding ? { binding: s.binding } : {}) }) : [] };
    };
    if (sub === 'check') {
      if (!name) throw new CliError(EXIT.USAGE, 'semantic check <shared model or composite>.');
      const { errors, findings } = findingsFor();
      const bad = errors.length + findings.filter((f) => f.severity === 'error').length;
      emit(ctx, { ok: bad === 0, errors, findings }, [...errors.map((e) => `  ✗ ${e}`), ...findings.map(findingLine), bad ? `${bad} error(s).` : `✓ ${name} passes${findings.length ? ` (${findings.length} warning(s))` : ''}.`].join('\n'));
      return bad ? EXIT.FAILED : EXIT.OK;
    }
    if (sub === 'draft') {
      if (!name) throw new CliError(EXIT.USAGE, 'semantic draft <name> [--tables t1,t2] [--database <db>].');
      const resolve = createSubjectResolver(sources.graph as Parameters<typeof createSubjectResolver>[0]);
      const ids = ctx.values.tables ? ctx.values.tables.split(',').map((t) => t.trim()).filter(Boolean).map((t) => resolve(t) ?? t)
        : problemId ? problemTableIds({ workspaceRoot: ws, problemRoot: layoutPath(ws, 'problems', problemId), sources }) : [];
      if (!ids.length) throw new CliError(EXIT.NOT_FOUND, 'No table to draft from: pass --tables, or name the tables in the active problem\'s specification.');
      const d = draftSemanticModel({ graph: sources.graph, assertions: sources.assertions, tableIds: ids, name, database: ctx.values.database });
      let written: sem.SharedEntry;
      try { written = sem.writeDraft(ws, name, d.model, d.backing, d.notes, d.binding); } catch (err) { throw new CliError(EXIT.FAILED, err instanceof Error ? err.message : String(err)); }
      const findings = checkSemanticModel(d.model, { ...sources, ...(d.binding ? { binding: d.binding } : {}) });
      emit(ctx, { ok: true, file: rel(ctx, written.file), notes: d.notes, findings }, [`Drafted ${rel(ctx, written.file)}: ${d.model.tables.length} table(s), ${d.model.relationships?.length ?? 0} relationship(s).`, ...d.notes.map((n) => `  · ${n}`), ...findings.map(findingLine), `Review it, then a person approves it: autode semantic approve ${name}.`].join('\n'));
      return EXIT.OK;
    }
    if (sub === 'approve') {
      if (!name) throw new CliError(EXIT.USAGE, 'semantic approve <shared model or composite>.');
      requirePerson(ctx, 'Approving a semantic model', 'Approve it in the Semantic Model editor in VS Code, or in a terminal.');
      const { errors, findings } = findingsFor();
      if (errors.length) throw new CliError(EXIT.FAILED, `${name} isn't valid: ${errors.join('; ')}`);
      const by = (ctx.values.by ?? safeUsername()).trim();
      ctx.io.out([...findings.map(findingLine)].join('\n'));
      if (composite && problemId) {
        const problemRoot = layoutPath(ws, 'problems', problemId);
        const oneStep = problemMode(problemRoot) === 'exploration';
        const answer = (await ctx.io.prompt(oneStep ? `Approve the composite ${name} as "${by}" (exploration mode)? [y/N] ` : `Approve the composite ${name} as "${by}"? Type approve: `)).trim().toLowerCase();
        if (oneStep ? answer !== 'y' && answer !== 'yes' : answer !== 'approve') { ctx.io.out('Nothing changed.'); return EXIT.REFUSED; }
        const r = sem.approveComposite(ws, problemId, name, { by, channel: 'cli', findings, problemRoot });
        emit(ctx, { ok: r.ok, message: r.message, warnings: r.warnings }, r.message);
        return r.ok ? EXIT.OK : EXIT.FAILED;
      }
      if ((await ctx.io.prompt(`Approve the shared semantic model ${name} as "${by}"? Every problem that uses it is affected. Type approve: `)).trim().toLowerCase() !== 'approve') { ctx.io.out('Nothing changed.'); return EXIT.REFUSED; }
      const r = sem.approveShared(ws, name, { by, channel: 'cli', findings });
      emit(ctx, { ok: r.ok, message: r.message }, r.message);
      return r.ok ? EXIT.OK : EXIT.FAILED;
    }
  } finally { cfm.dispose(); }
  throw new CliError(EXIT.USAGE, 'semantic takes show, check <name>, draft <name>, compose <name>, resolve <composite> or approve <name>.');
}

/** GOV: personal data in the problem's sources, and a person's classification of a column. */
async function cmdGovernance(ctx: Ctx, rest: string[]): Promise<number> {
  const [sub = 'show', target] = rest;
  const cfm = await openContext(ctx.workspaceRoot, () => undefined);
  try {
    const sources = cfm.getPackSources();
    const facts = gov.governanceFacts(sources.assertions);
    if (sub === 'show') {
      const index = buildSchemaIndex(sources.graph.nodes, sources.graph.edges);
      const id = singleProblem(ctx);
      const mapped = id ? problemMappings(layoutPath(ctx.workspaceRoot, 'problems', id)).map((m) => m.sourceFqn.toLowerCase()) : [];
      const wanted = ctx.values.table ? [ctx.values.table.toLowerCase()] : mapped;
      const tables = index.tables.filter((t) => !wanted.length || wanted.some((w) => gov.sameTable(t.fqn, w)));
      const candidates = gov.governanceCandidates(tables.map((t) => ({ fqn: t.fqn, columns: [...t.columns.keys()] })), facts);
      const text = candidates.length
        ? candidates.map((c) => `  ${`${c.table}.${c.column}`.padEnd(44)} ${c.fact ? `${c.fact.classification}${c.fact.strategy ? ` (${c.fact.strategy})` : ''} · ${c.fact.status}` : `suggested ${c.suggested}${c.strategy ? ` (${c.strategy})` : ''} · not classified`}`).join('\n')
        : `No personal data found by name in ${tables.length} table(s).`;
      emit(ctx, { ok: true, candidates, tables: tables.length }, `${text}\n\nClassify a column: autode governance classify <table.column> --as pii|sensitive-pii|confidential|none [--strategy hash|redact]`);
      return EXIT.OK;
    }
    if (sub !== 'classify') throw new CliError(EXIT.USAGE, 'governance show [--table <t>] | classify <table.column> --as <classification> [--strategy hash|redact] [--note <text>]');
    const dot = target?.lastIndexOf('.') ?? -1;
    if (!target || dot <= 0) throw new CliError(EXIT.USAGE, 'governance classify takes <table.column>.');
    const classification = ctx.values.as as gov.Classification | undefined;
    if (!classification || !gov.CLASSIFICATIONS.includes(classification)) throw new CliError(EXIT.USAGE, `--as is one of ${gov.CLASSIFICATIONS.join(', ')}.`);
    const strategy = ctx.values.strategy as 'hash' | 'redact' | undefined;
    if (strategy && strategy !== 'hash' && strategy !== 'redact') throw new CliError(EXIT.USAGE, '--strategy is hash or redact.');
    requirePerson(ctx, 'Classifying personal data', 'Classify it in the AutoDE panel (AutoDE: Classify Personal Data…), or in a terminal; an agent proposes the fact for you to confirm.');
    const table = target.slice(0, dot), column = target.slice(dot + 1);
    if ((await ctx.io.prompt(`${table}.${column} is ${classification}${strategy ? `, masked by ${strategy}` : ''}. Type classify to record it: `)).trim().toLowerCase() !== 'classify') { ctx.io.out('Nothing changed.'); return EXIT.REFUSED; }
    let a: Awaited<ReturnType<typeof gov.classifyColumn>>;
    try { a = await gov.classifyColumn(cfm.getLedger(), sources.graph.nodes.map((n) => n.id), { table, column, classification, strategy, by: actorOf(ctx), channel: 'cli', note: ctx.values.note }); }
    catch (err) { throw new CliError(EXIT.FAILED, err instanceof Error ? err.message : String(err)); }
    await cfm.persistCompiledGraph();
    emit(ctx, { ok: true, fact: a.id, statement: a.statement }, `✓ ${a.statement} (fact ${a.id}, confirmed)`);
    return EXIT.OK;
  } finally { cfm.dispose(); }
}

async function packManager(ctx: Ctx): Promise<{ pm: BusinessPackManager; dispose: () => void }> {
  const id = singleProblem(ctx);
  if (!id) throw new CliError(EXIT.NOT_FOUND, 'No business problem in this workspace: start one with `autode problems new`.');
  const cfm = await openContext(ctx.workspaceRoot, (m) => ctx.io.err(m));
  const pm = new BusinessPackManager(path.join(layoutPath(ctx.workspaceRoot, 'problems', id), 'pack'), ctx.workspaceRoot, () => cfm, (m) => ctx.io.err(m));
  await pm.load();
  return { pm, dispose: () => cfm.dispose() };
}

async function cmdPack(ctx: Ctx, rest: string[]): Promise<number> {
  const [sub = 'list', ...args] = rest;
  const { pm, dispose } = await packManager(ctx);
  try {
    if (sub === 'list') {
      const docs = pm.getPack().documents;
      emit(ctx, { ok: true, documents: docs }, docs.length ? docs.map((d) => `${d.id}  ${d.role}, ${d.authority}, v${d.version}  ${d.path}${d.table ? ` (sample of ${d.table})` : ''}${d.profileId ? ` · profile ${d.profileId}` : ''}`).join('\n') : 'No documents in this problem\'s pack yet: autode pack add <file> --role … --authority … --doc-version ….');
      return EXIT.OK;
    }
    if (sub === 'add') {
      requirePerson(ctx, 'pack add', 'Add documents in the AutoDE panel, or in a terminal; an agent may add draft documents with autode_pack_add.');
      if (args.length !== 1) throw new CliError(EXIT.USAGE, 'pack add takes one file.');
      const role = ctx.values.role as DocumentRole | undefined;
      const authority = ctx.values.authority as DocumentAuthority | undefined;
      if (!role || !DOCUMENT_ROLES.includes(role)) throw new CliError(EXIT.USAGE, `--role is one of: ${DOCUMENT_ROLES.join(', ')}.`);
      if (authority !== 'signed' && authority !== 'draft') throw new CliError(EXIT.USAGE, '--authority is signed (its clauses become confirmed facts) or draft (documented facts, to review).');
      if (!ctx.values['doc-version']) throw new CliError(EXIT.USAGE, '--doc-version is needed (the document\'s own version, e.g. 1.2).');
      if (role === 'sample' && !ctx.values.table) throw new CliError(EXIT.USAGE, 'A sample needs --table <object id> (the table it is a sample of, from autode estate show or autode_resolve).');
      const file = path.resolve(ctx.io.cwd, args[0]);
      if (!fs.existsSync(file)) throw new CliError(EXIT.NOT_FOUND, `No file "${args[0]}".`);
      const doc = await pm.addDocument({ path: file, role, authority, version: ctx.values['doc-version'] as string, table: ctx.values.table });
      emit(ctx, { ok: true, document: doc }, `Added ${doc.id} (${doc.role}, ${doc.authority}). Read it in with: autode pack apply ${doc.id}`);
      return EXIT.OK;
    }
    if (sub === 'apply') {
      const docs = pm.getPack().documents.filter((d) => !args.length || args.includes(d.id));
      if (args.length && docs.length !== args.length) throw new CliError(EXIT.NOT_FOUND, `No document ${args.filter((a) => !docs.some((d) => d.id === a)).join(', ')} in the pack.`);
      const results: Array<Record<string, unknown>> = [];
      let blocked = false;
      for (const d of docs) {
        const r = await pm.applyDocument(d.id);
        results.push({ id: d.id, ...r });
        if (r.status === 'needs_profile' || r.status === 'needs_llm' || r.status === 'error') blocked = true;
      }
      const lines = results.map((r) => {
        switch (r.status) {
          case 'applied': return `✓ ${String(r.id)}: ${JSON.stringify(r.reconcile)} (profile ${String(r.profileId)})`;
          case 'registered': return `· ${String(r.id)}: sample registered for probes`;
          case 'needs_profile': return `✗ ${String(r.id)}: ${String(r.reason)}. Profiles are in .autode/knowledge/profiles/; a person sets status: confirmed.`;
          case 'needs_llm': return `✗ ${String(r.id)}: ${String(r.reason)} — read it with your host's model (AutoDE panel, or the extraction prompt in an MCP host).`;
          default: return `✗ ${String(r.id)}: ${String(r.reason ?? r.status)}`;
        }
      });
      emit(ctx, { ok: !blocked, results }, lines.join('\n') || 'No documents to apply.');
      return blocked ? EXIT.FAILED : EXIT.OK;
    }
    throw new CliError(EXIT.USAGE, 'pack takes list, add <file> or apply [<doc id>...].');
  } finally { dispose(); }
}

async function minedVocabulary(ctx: Ctx): Promise<VocabularyProposal[]> {
  const cfm = await openContext(ctx.workspaceRoot, () => undefined);
  try {
    const file = layoutPath(ctx.workspaceRoot, 'vocabulary');
    const vocab = buildVocabulary(parseVocabularyFile(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined));
    const items = cfm.getCatalog().all().flatMap((e) => [{ name: e.table.label, comment: e.table.description }, ...(e.columns ?? []).map((c) => ({ name: c.label, comment: c.description }))]);
    return mineAbbreviations(items, vocab);
  } finally { cfm.dispose(); }
}

async function cmdVocabulary(ctx: Ctx, rest: string[]): Promise<number> {
  const [sub = 'mine'] = rest;
  const mined = await minedVocabulary(ctx);
  const line = (p: VocabularyProposal, i: number) => `${i + 1}. ${p.kind === 'abbreviation' ? `${p.from.toUpperCase()} = ${p.to}` : `${p.from} means ${p.to}`}  (${p.support} name(s)/comment(s)${p.example ? `, e.g. ${p.example}` : ''})`;
  if (sub === 'mine') {
    emit(ctx, { ok: true, proposals: mined }, mined.length ? mined.map(line).join('\n') : 'Nothing new to propose from the catalog\'s names and comments.');
    return EXIT.OK;
  }
  if (sub === 'accept') {
    requirePerson(ctx, 'vocabulary accept', 'Accept vocabulary in the AutoDE panel (Propose Vocabulary), in a terminal, or approve an agent\'s autode_propose_vocabulary.');
    if (!mined.length) { ctx.io.out('Nothing new to propose.'); return EXIT.OK; }
    ctx.io.out(mined.map(line).join('\n'));
    const answer = (await ctx.io.prompt('Which are right for this customer? Numbers separated by commas, "all", or blank for none: ')).trim().toLowerCase();
    const picked = answer === 'all' ? mined : answer.split(/[\s,]+/).filter(Boolean).map((n) => mined[Number(n) - 1]).filter((p): p is VocabularyProposal => !!p);
    if (!picked.length) { ctx.io.out('Nothing added.'); return EXIT.OK; }
    const file = layoutPath(ctx.workspaceRoot, 'vocabulary');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, mergeVocabularyFile(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined, picked));
    emit(ctx, { ok: true, added: picked }, `Added ${picked.length} entr${picked.length === 1 ? 'y' : 'ies'} to ${'.autode/knowledge/vocabulary.yaml'}.`);
    return EXIT.OK;
  }
  throw new CliError(EXIT.USAGE, 'vocabulary takes mine or accept.');
}

async function cmdDesignDoc(ctx: Ctx, rest: string[]): Promise<number> {
  if (rest.length > 1) throw new CliError(EXIT.USAGE, 'design-doc takes at most one path.');
  const args: Record<string, unknown> = {};
  let ws: EngineWorkspace;
  if (rest[0]) {
    const file = path.resolve(ctx.io.cwd, rest[0]);
    if (!fs.existsSync(file)) throw new CliError(EXIT.NOT_FOUND, `No file "${rest[0]}".`);
    args.path = rel(ctx, file);
    ws = workspace(ctx, ctx.values.problem);
  } else {
    const id = singleProblem(ctx);
    if (!id) throw new CliError(EXIT.NOT_FOUND, 'No business problem in this workspace; pass the path of a Pipeline Spec.');
    ws = workspace(ctx, id);
  }
  const r = await tool('autode_generate_design_doc').handler(args, ws) as { markdown: string; source: string };
  if (ctx.values.out) {
    const out = path.resolve(ctx.io.cwd, ctx.values.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, r.markdown);
    emit(ctx, { ok: true, written: out }, `wrote ${path.relative(ctx.io.cwd, out)}`);
  } else {
    emit(ctx, { ok: true, ...r }, r.markdown);
  }
  return EXIT.OK;
}

/** `query` and `explain` run the MCP tools' own handlers: the same read-only guard and the same sample-data gate. */
async function cmdSql(ctx: Ctx, command: 'query' | 'explain', rest: string[]): Promise<number> {
  if (!ctx.values.connection) throw new CliError(EXIT.USAGE, `${command} needs --connection <id> (see autode connections list).`);
  const sql = rest.join(' ').trim();
  if (!sql) throw new CliError(EXIT.USAGE, `${command} takes the SQL statement, in quotes.`);
  const session = platformSession(ctx);
  try {
    const name = command === 'query' ? 'autode_execute_query' : 'autode_explain_sql';
    const t = platformTools(session).find((x) => x.name === name)!;
    const args: Record<string, unknown> = { connectionId: ctx.values.connection, sql };
    if (command === 'query' && ctx.values['max-rows']) args.maxRows = Number(ctx.values['max-rows']);
    const r = await t.handler(args, workspace(ctx, ctx.values.problem)) as Record<string, unknown>;
    if (ctx.json) { emit(ctx, { ok: true, ...r }, ''); return EXIT.OK; }
    if (command === 'explain') {
      // The plan comes back as rows (one text column on most platforms).
      const plan = Array.isArray(r.plan) ? (r.plan as Array<Record<string, unknown>>) : [];
      ctx.io.out(plan.map((row) => Object.values(row).map(String).join('\t')).join('\n') || JSON.stringify(r, null, 2));
      return EXIT.OK;
    }
    const rows = (r.rows as Array<Record<string, unknown>> | undefined) ?? [];
    const columns = (r.columns as string[] | undefined) ?? (rows[0] ? Object.keys(rows[0]) : []);
    const body = rows.map((row) => columns.map((c) => String(row[c] ?? '')).join('\t'));
    ctx.io.out([columns.join('\t'), ...body, `${String(r.rowCount ?? rows.length)} row(s)${r.withheld ? ' — row values withheld: this connection does not allow sample data' : ''}${r.truncated ? ' (truncated)' : ''}`].join('\n'));
    return EXIT.OK;
  } finally { session.dispose(); }
}

// ── connections (v0.43.1) ────────────────────────────────────────────────────

const PLATFORMS = ['snowflake', 'databricks', 'oracle'] as const;

async function cmdConnections(ctx: Ctx, rest: string[]): Promise<number> {
  const [sub, id, ...extra] = rest;
  if (sub === 'list') { if (id) throw new CliError(EXIT.USAGE, 'connections list takes no argument.'); return connectionsList(ctx); }
  if (sub === 'add') { if (id) throw new CliError(EXIT.USAGE, 'connections add takes options, not arguments (see --help).'); return connectionsAdd(ctx); }
  if (sub === 'test' || sub === 'remove') {
    if (!id || extra.length) throw new CliError(EXIT.USAGE, `connections ${sub} takes one connection id (see autode connections list).`);
    return sub === 'test' ? connectionsTest(ctx, id) : connectionsRemove(ctx, id);
  }
  throw new CliError(EXIT.USAGE, 'connections takes list, test <id>, add or remove <id>.');
}

function connectionsList(ctx: Ctx): number {
  const config = loadConnectionsConfig(ctx.workspaceRoot, ctx.io.env);
  const readiness = readReadiness(ctx.workspaceRoot);
  const rows = config.connections.map((c) => ({ id: c.id, platform: c.platform, role: c.role, origin: c.origin, credentials: c.credentials, status: connectionStatus(c, readiness[c.id]), needs: credentialNeeds(c, ctx.io.env) }));
  const lines = rows.length ? rows.map((r) => {
    const missing = r.needs.variables.filter((v) => !v.set).map((v) => v.name);
    return `${r.status.autode === 'ready' ? '✓' : '·'} ${r.id}  ${r.role}, ${r.credentials.resolver}${r.credentials.ref ? `:${r.credentials.ref}` : ''}, ${r.origin} — ${r.status.autode}${r.status.checkedAt ? ` at ${r.status.checkedAt}` : ''}`
      + `\n    ${r.needs.summary}${missing.length ? ` Not set here: ${missing.join(', ')}.` : ''}`;
  }) : [`No connections. Add one with \`autode connections add\`, or write ${config.file} (docs/mcp-setup.md).`];
  emit(ctx, { ok: config.errors.length === 0, file: config.file, localFile: config.localFile, connections: rows, configErrors: config.errors }, [...lines, ...config.errors.map((e) => `✗ ${e}`)].join('\n'));
  return config.errors.length ? EXIT.FAILED : EXIT.OK;
}

async function connectionsTest(ctx: Ctx, id: string): Promise<number> {
  const session = platformSession(ctx);
  try {
    const entry = session.entry(id);
    try {
      await session.connect(entry, true);
    } catch (err) {
      recordReadiness(ctx.workspaceRoot, entry, false, platformReason(err));
      throw err;
    }
    const record = recordReadiness(ctx.workspaceRoot, entry, true, `connected (${entry.platform}, CLI)`);
    emit(ctx, { ok: true, id: entry.id, readiness: record }, `✓ ${entry.id} connected. Recorded as ready on this machine.`);
    return EXIT.OK;
  } finally { session.dispose(); }
}

/** The classified message plus what the platform itself said — the part an engineer acts on. Redacted. */
function platformReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const raw = err instanceof EngineToolError && typeof err.details.raw === 'string' && err.details.raw !== message ? ` (${err.details.raw.slice(0, 500)})` : '';
  return redact(`${message}${raw}`);
}

/** One answer from the terminal; `choices` are matched case-insensitively, blank takes the default. */
async function ask(ctx: Ctx, question: string, options: { default?: string; choices?: readonly string[]; required?: boolean } = {}): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const suffix = options.default ? ` [${options.default}]` : options.required ? '' : ' (optional)';
    const answer = (await ctx.io.prompt(`${question}${suffix}: `)).trim() || options.default || '';
    if (options.choices && answer && !options.choices.some((c) => c.toLowerCase() === answer.toLowerCase())) { ctx.io.out(`  Choose one of: ${options.choices.join(', ')}.`); continue; }
    if (options.required && !answer) { ctx.io.out('  This one is needed.'); continue; }
    return options.choices ? (options.choices.find((c) => c.toLowerCase() === answer.toLowerCase()) ?? answer) : answer;
  }
  throw new CliError(EXIT.USAGE, `No usable answer for "${question}".`);
}

function parseSet(values: readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values ?? []) {
    const i = v.indexOf('=');
    if (i <= 0) throw new CliError(EXIT.USAGE, `--set takes key=value, not "${v}".`);
    out[v.slice(0, i).trim()] = v.slice(i + 1).trim();
  }
  return out;
}

async function connectionsAdd(ctx: Ctx): Promise<number> {
  requirePerson(ctx, 'connections add', `Write ${'.autode/config/connections.yaml'} instead (docs/mcp-setup.md), or have an agent propose it (autode_propose_connection) for a person to approve.`);
  const v = ctx.values;
  const env = ctx.io.env;
  const platform = (v.platform ?? await ask(ctx, `Platform (${PLATFORMS.join(', ')})`, { choices: PLATFORMS, required: true })) as (typeof PLATFORMS)[number];
  if (!PLATFORMS.includes(platform)) throw new CliError(EXIT.USAGE, `--platform is one of: ${PLATFORMS.join(', ')}.`);
  const role = (v.role ?? (platform === 'oracle' ? 'source' : await ask(ctx, 'Role (source, target)', { choices: ['source', 'target'], default: 'source' }))) as ConnectionRole;
  const discovered = await discoverCliConnections(env);
  let resolver = v.resolver;
  let ref = v.ref;
  if (!resolver) {
    const known = platform === 'snowflake' ? discovered.snowflake.map((n) => ({ name: n, note: 'Snowflake CLI connection' }))
      : platform === 'databricks' ? discovered.databricks.map((p) => ({ name: p.name, note: p.host ? `profile, ${p.host}` : 'profile' })) : [];
    if (known.length) {
      ctx.io.out(`Your ${platform === 'snowflake' ? 'Snowflake CLI connections (connections.toml)' : 'Databricks profiles (.databrickscfg)'}:`);
      known.forEach((k, i) => ctx.io.out(`  ${i + 1}. ${k.name} — ${k.note}`));
      const pick = await ask(ctx, `Use which one? A number, or "env" to give the settings yourself (secret from environment variables)`, { choices: [...known.map((_k, i) => String(i + 1)), 'env'], default: '1' });
      if (pick === 'env') resolver = 'env'; else { resolver = 'cli'; ref = known[Number(pick) - 1].name; }
    } else {
      resolver = 'env';
      if (platform !== 'oracle') ctx.io.out(`No ${platform === 'snowflake' ? 'Snowflake CLI connection' : 'Databricks profile'} found on this machine; the secret will come from an environment variable.`);
    }
  }
  if (resolver !== 'cli' && resolver !== 'env') throw new CliError(EXIT.USAGE, 'Outside VS Code --resolver is cli or env (VS Code\'s secret storage is only reachable from the extension).');
  if (ref === undefined && resolver === 'env') ref = await ask(ctx, 'A short name for it, used in its environment variable names (e.g. prod)');
  const fields = parseSet(v.set);
  if (platform === 'oracle' && discovered.oracleAliases.length && !fields.connectString) ctx.io.out(`tnsnames.ora aliases here: ${discovered.oracleAliases.slice(0, 20).join(', ')}`);
  for (const f of setupFields(platform, resolver)) {
    if (fields[f.field] !== undefined) continue;
    const answer = await ask(ctx, `${f.label}${f.personal ? ' — kept in your personal file' : ''}`, { required: f.required });
    if (answer) fields[f.field] = answer;
  }
  const draft: ConnectionDraft = { platform, role, fields, credentials: { resolver, ref: ref ?? '' }, scope: (v.scope as ConnectionDraft['scope']) ?? 'team', allowSampleDataInPrompts: v['allow-sample-data'] === true };
  const problems = validateConnectionDraft(draft);
  if (problems.length) { emit(ctx, { ok: false, errors: problems }, problems.map((p) => `✗ ${p}`).join('\n')); return EXIT.FAILED; }
  const entry = draftEntry(draft);
  const needs = credentialNeeds(draft, env);
  const missing = needs.variables.filter((x) => !x.set).map((x) => x.name);
  ctx.io.out([
    '',
    `Connection ${entry.id} (${platform}, ${role}${draft.scope === 'personal' ? ', personal' : ''})`,
    ...Object.entries(entry.fields).map(([k, val]) => `  ${k}: ${val}`),
    `  credentials: ${resolver}${draft.credentials.ref ? ` (${draft.credentials.ref})` : ''}`,
    `  sample data in prompts: ${draft.allowSampleDataInPrompts ? 'allowed' : 'not allowed'}`,
    `  ${needs.summary}${missing.length ? ` Not set in this terminal: ${missing.join(', ')}.` : ''}`
  ].join('\n'));
  let tested = false;
  if (v['no-test'] !== true) {
    const session = platformSession(ctx);
    try {
      ctx.io.out('Testing the connection (read-only)…');
      await session.connect(entry, true);
      tested = true;
      ctx.io.out('✓ Connected.');
    } catch (err) {
      ctx.io.err(`✗ The connection failed: ${platformReason(err)}`);
      ctx.io.err(`Nothing was saved. Fix it and run the command again${missing.length ? ` (set ${missing.join(', ')} first)` : ''}, or add --no-test to save it untested.`);
      return EXIT.PLATFORM;
    } finally { session.dispose(); }
  }
  const files = draft.scope === 'personal' ? '.autode/local/connections.yaml' : '.autode/config/connections.yaml (and your personal fields in .autode/local/connections.yaml)';
  if ((await ctx.io.prompt(`Type save to write ${files}: `)).trim().toLowerCase() !== 'save') { ctx.io.out('Not saved.'); return EXIT.REFUSED; }
  const saved = saveConnection(ctx.workspaceRoot, draft, env);
  const after = loadConnectionsConfig(ctx.workspaceRoot, env).connections.find((c) => c.id === saved.id);
  if (tested && after) recordReadiness(ctx.workspaceRoot, after, true, `connected (${platform}, CLI)`);
  const next = [
    ...saved.written.map((f) => `wrote ${f}`),
    tested ? 'Recorded as ready on this machine.' : 'Saved untested: run `autode connections test ' + saved.id + '` when its credentials are in place.',
    draft.scope !== 'personal' ? 'Commit .autode/config/connections.yaml so your team has it; each engineer supplies their own credentials.' : '',
    resolver === 'env' && needs.variables.length ? `MCP clients need ${needs.variables.map((x) => x.name).join(' and ')} in their environment (the "env" block of .mcp.json).` : ''
  ].filter(Boolean);
  emit(ctx, { ok: true, id: saved.id, written: saved.written, tested, needs }, next.join('\n'));
  return EXIT.OK;
}

async function connectionsRemove(ctx: Ctx, id: string): Promise<number> {
  requirePerson(ctx, 'connections remove', 'Edit .autode/config/connections.yaml instead.');
  const entry = loadConnectionsConfig(ctx.workspaceRoot, ctx.io.env).connections.find((c) => c.id.toLowerCase() === id.toLowerCase());
  if (!entry) throw new CliError(EXIT.NOT_FOUND, `No connection "${id}" (see autode connections list).`);
  if ((await ctx.io.prompt(`Remove ${entry.id} from the connections files? Type remove to confirm: `)).trim().toLowerCase() !== 'remove') { ctx.io.out('Not removed.'); return EXIT.REFUSED; }
  const changed = removeConnection(ctx.workspaceRoot, entry.id, ctx.io.env);
  forgetReadiness(ctx.workspaceRoot, entry.id);
  emit(ctx, { ok: true, id: entry.id, written: changed }, [...changed.map((f) => `updated ${f}`), `Removed ${entry.id}.`].join('\n'));
  return EXIT.OK;
}

function describeDecision(d: Decision, proposal: unknown): string {
  const body = JSON.stringify(proposal, null, 2);
  return [
    `${d.id} — ${d.title}`,
    `kind: ${d.kind} · stakes: ${d.stakes} · status: ${d.status}${d.problemId ? ` · problem: ${d.problemId}` : ''}`,
    `proposed by ${[d.proposedBy.host, d.proposedBy.client, d.proposedBy.skill && `skill ${d.proposedBy.skill}`, d.proposedBy.model].filter(Boolean).join(' · ')} at ${d.proposedAt}`,
    d.summary,
    `validation: ${d.validation.ok ? 'passed' : 'FAILED'}${d.validation.errors.map((e) => `\n  ✗ ${e}`).join('')}${d.validation.warnings.map((w) => `\n  ! ${w}`).join('')}`,
    ...(d.evidence.length ? ['evidence:', ...d.evidence.map((e) => `  - ${e.ref}${e.quote ? ` — "${e.quote}"` : ''}`)] : []),
    'proposal:',
    body.length > 4000 ? `${body.slice(0, 4000)}\n… (${body.length} characters; the full proposal is in .autode/decisions/${d.id}.proposal.json)` : body
  ].join('\n');
}

function safeUsername(): string {
  try { return os.userInfo().username; } catch { return 'unknown'; }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const code = await run(argv);
  // `mcp` keeps running on stdin; every other command ends here.
  if (argv[0] !== 'mcp') process.exitCode = code;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`autode: ${redact(err instanceof Error ? err.stack ?? err.message : String(err))}\n`);
    process.exit(EXIT.INTERNAL);
  });
}
