import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { parseArgs } from 'node:util';
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
import { driversRoot as defaultDriversRoot } from '../engine/platform/driverStore';
import { DataPlatformProvider } from '../engine/types';
import { Catalog } from '../engine/context/catalog';
import { layoutPath } from '../engine/workspaceLayout';
import { SqlDialect } from '../engine/transforms/types';

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
    })
  };
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
  problems new "<statement>"   Start one: a first draft specification, made active
  problems use <id>            Make another one active (the AutoDE panel follows)

Estate (observed metadata; recorded without a decision):
  estate show                  Systems, environments, bindings, and what the catalog holds
  estate ingest <file>...      DDL (.sql/.ddl), CSV or JSON into the catalog and working set [--system <s>] [--environment <e>]
  estate extract --connection <id> --schema <DB.SCHEMA>...   A connection's schemas [--system <s>] [--profile] [--allow-cli]

Knowledge (confirming, rejecting, editing and adding are a person's: interactive terminal):
  facts [list]                 What waits for review (proposed, needs review), with stakes and what each corrects [--kind k] [--all]
  facts show <id>              One fact: value, evidence, verification, history
  facts confirm <id>...        Confirm; or --from <source> for every documented fact from one source
  facts reject <id> [--note <text>]
  facts edit <id> [--statement <text>] [--value <json>]   Correct it, confirmed
  facts conflicts              Contradicting facts
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

Server:
  mcp [--allow-write] [--allow-cli] [--drivers <folder>]   The AutoDE MCP server over stdio

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
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' }
} as const;

type Values = { [K in Exclude<keyof typeof OPTIONS, 'set' | 'schema'>]?: (typeof OPTIONS)[K]['type'] extends 'string' ? string : boolean } & { set?: string[]; schema?: string[] };

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
      case 'pack': return await cmdPack(ctx, rest);
      case 'vocabulary': return await cmdVocabulary(ctx, rest);
      case 'design-doc': return await cmdDesignDoc(ctx, rest);
      case 'query': case 'explain': return await cmdSql(ctx, command, rest);
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
  const prerequisites = await checkPrerequisites({ driversRoot: drivers, platforms: platforms.length ? platforms : undefined });
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
    ...prerequisites.map((p) => `  ${p.state === 'ready' ? '✓' : p.required && platforms.includes(p.platform) ? '✗' : '·'} ${p.title} — ${p.state}${p.version ? ` ${p.version}` : ''}${p.state !== 'ready' && p.install?.command ? `\n      install: ${p.install.command}` : ''}`),
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
  const answer = (await ctx.io.prompt(`\n${sub === 'approve' ? 'Approve' : 'Reject'} ${d.id} as "${by}"? Type ${sub} to confirm: `)).trim().toLowerCase();
  if (answer !== sub) { ctx.io.out('Not confirmed; nothing changed.'); return EXIT.REFUSED; }
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
    const { id, spec } = startProblem(ctx.workspaceRoot, statement);
    emit(ctx, { ok: true, id, specId: spec.id, active: true }, `Started ${id} (active). Its first draft specification holds the statement; the interview and approval follow (AutoDE panel, or an AutoDE skill in your agent).`);
    return EXIT.OK;
  }
  if (sub === 'use') {
    if (args.length !== 1) throw new CliError(EXIT.USAGE, 'problems use takes one problem id (see autode problems list).');
    if (!listProblems(ctx.workspaceRoot).some((p) => p.id === args[0])) throw new CliError(EXIT.NOT_FOUND, `No business problem "${args[0]}" (see autode problems list).`);
    setActiveProblem(ctx.workspaceRoot, args[0]);
    emit(ctx, { ok: true, id: args[0] }, `${args[0]} is now the active business problem.`);
    return EXIT.OK;
  }
  throw new CliError(EXIT.USAGE, 'problems takes list, new "<statement>" or use <id>.');
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
