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
import { connectionStatus, readReadiness } from '../engine/platform/connectionReadiness';
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
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' }
} as const;

type Values = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]['type'] extends 'string' ? string : boolean };

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
  if (ciIsSet(ctx.io.env)) throw new CliError(EXIT.REFUSED, `Refused: CI is set. A non-interactive run never resolves a decision; resolve ${d.id} in the AutoDE panel, in a terminal, or in .autode/decisions/${d.id}.yaml.`);
  if (!ctx.io.interactive) throw new CliError(EXIT.REFUSED, `Refused: decisions ${sub} needs an interactive terminal (stdin and stdout). Resolve ${d.id} in the AutoDE panel, in a terminal, or in .autode/decisions/${d.id}.yaml.`);
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
