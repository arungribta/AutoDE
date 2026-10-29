import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv, { ValidateFunction } from 'ajv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ErrorCode, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { EngineToolError, redact, redactValue, toEnvelope } from './errors';
import { EngineWorkspace } from './workspace';
import { EngineTool, TOOLS } from './tools';
import { PlatformSession, platformTools } from './platform';
import { decisionTools } from './decisions';
import { workspaceTools } from './workspaceTools';
import { platformOperationTools } from './platformOperationTools';
import { workflowTools } from './workflowTools';
import { agentTools } from './agentTools';
import { PRIMITIVE_RESOURCE_TEMPLATE, getPrompt, listPrompts, listResources, readResource } from './catalogs';
import { semanticTools } from './semanticTools';
import { maintenanceTools } from './maintenanceTools';
import { ARTICLE_RESOURCE_TEMPLATE, ASSET_RESOURCE_TEMPLATE, exploreTools } from './exploreTools';

/**
 * The AutoDE MCP server (docs/specs/mcp-engine.md §3, §5; phases 3
 * and 4): the engine's registry, Pipeline Spec, prompts, resources, the
 * read-only context-layer tools and the data-platform tools over stdio.
 * Deterministic — no LLM calls (D5). It writes only proposals (decisions),
 * a new problem's first draft and the active-problem pointer, and observed
 * metadata ingested from files or connections (v0.43.2) — never anything an
 * agent infers. Previously: it never wrote to the workspace
 * (§8). Platform statements are read-only; changes run as approved runbooks in AutoDE's runner.
 *
 *   autode mcp --workspace <root> [--resources <extension root>] [--allow-cli] [--drivers <folder>]
 *   (node dist/mcp-server.js … starts the same server)
 *
 * The entry point is src/cli/main.ts. In a bundle every inlined module sees
 * `require.main === module`, so this module never starts itself.
 *
 * stdout carries the protocol; logs go to stderr, redacted.
 */

/** The extension, and the standalone `autode` package (PA2), which lays its resources out the same way. */
const PACKAGE_NAMES = ['auto-data-engineering-hub', 'autode'];

/** The resources root (bundled `skills/`, `primitive-definitions/`, `package.json`): the nearest ancestor holding AutoDE's package.json — the extension's or the `autode` package's. */
export function findResourcesRoot(start: string = __dirname): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name && PACKAGE_NAMES.includes(pkg.name)) return dir;
    } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function readVersion(resourcesRoot: string | undefined): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(resourcesRoot ?? '', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface ServerOptions {
  workspaceRoot: string;
  resourcesRoot: string;
  version: string;
  log?: (line: string) => void;
  /** `--allow-cli`: consent to run the platform CLI for connections that need it. */
  allowCli?: boolean;
  /** `--drivers <folder>`: user-installed drivers (phase DRV1). */
  driversRoot?: string;
  /** Tests: a session with fake platform adapters. */
  platform?: PlatformSession;
}

/** AutoDE's icon for clients that show one next to the server name — embedded as a data URI, so nothing is fetched (P6). */
export function serverIcons(resourcesRoot: string): Array<{ src: string; mimeType: string; sizes: string[] }> {
  try {
    const png = fs.readFileSync(path.join(resourcesRoot, 'media', 'autode-icon-64.png'));
    return [{ src: `data:image/png;base64,${png.toString('base64')}`, mimeType: 'image/png', sizes: ['64x64'] }];
  } catch {
    return [];
  }
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ValidateFunction>();
function validatorFor(tool: EngineTool): ValidateFunction {
  let v = validators.get(tool.name);
  if (!v) { v = ajv.compile(tool.inputSchema); validators.set(tool.name, v); }
  return v;
}

function textResult(value: Record<string, unknown>): { content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> } {
  const safe = redactValue(value);
  return { content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }], structuredContent: safe };
}

function errorResult(err: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown>; isError: true } {
  const envelope = toEnvelope(err) as unknown as Record<string, unknown>;
  return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }], structuredContent: envelope, isError: true };
}

/** A protocol-level error for prompts and resources, which have no `isError` result; the envelope rides along as `data`. */
function protocolError(err: unknown): McpError {
  const envelope = toEnvelope(err);
  return new McpError(envelope.code === 'NOT_FOUND' || envelope.code === 'UNKNOWN_PRIMITIVE' ? ErrorCode.InvalidParams : ErrorCode.InternalError, envelope.message, envelope);
}

export function createAutodeServer(options: ServerOptions): Server {
  const ws = new EngineWorkspace({ workspaceRoot: options.workspaceRoot, resourcesRoot: options.resourcesRoot });
  const log = (line: string) => (options.log ?? ((l: string) => process.stderr.write(l + '\n')))(redact(line));
  const platform = options.platform ?? new PlatformSession({ workspaceRoot: options.workspaceRoot, allowWrite: false, allowCli: options.allowCli === true, driversRoot: options.driversRoot, log });
  // The decision tools read the client's name (from `initialize`) at call time.
  const ref: { server?: Server } = {};
  // v0.52.3: a run the AutoDE panel starts in Claude Code names its agent role, so the history records the role, not the CLI.
  const clientName = () => process.env.AUTODE_AGENT_NAME?.trim() || ref.server?.getClientVersion()?.name;
  // v0.52.3: a run the panel starts lists only its own tools (AUTODE_TOOLS); hosts get them all.
  const only = (process.env.AUTODE_TOOLS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const allTools: readonly EngineTool[] = [...TOOLS, ...platformTools(platform), ...platformOperationTools(platform), ...workspaceTools(platform), ...workflowTools(clientName, () => allTools), ...agentTools(clientName), ...decisionTools({ session: platform, clientName }), ...semanticTools(), ...exploreTools(), ...maintenanceTools(() => allTools)];
  const tools: readonly EngineTool[] = only.length ? allTools.filter((t) => only.includes(t.name)) : allTools;
  const server = new Server(
    { name: 'autode', title: 'AutoDE', version: options.version, icons: serverIcons(options.resourcesRoot) },
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions: `AutoDE data-engineering engine. Work happens in a business problem: autode_list_problems, autode_start_problem, autode_select_problem. Its workflow is the hub: autode_workflow_status and autode_workflow_next say what to do next; hand stages in with autode_workflow_complete_stage; a person approves gates. Bring the estate in with autode_ingest_file (DDL/CSV/JSON) or autode_ingest_metadata (a connection's schemas). Find transform primitives with autode_search_primitives, read their parameter schema with autode_describe_primitive, and generate SQL with autode_compile_transform rather than writing it by hand. Use autode_resolve and autode_get_context_pack to learn what the estate and the business problem hold, autode_search_assets and autode_get_asset_context for everything known about a table, column, term or metric before deciding about it, autode_lineage and autode_impact for where data comes from and what a change would affect (autode_record_observed_lineage records edges observed on a platform), and autode_check_grounding to check SQL before proposing it (joins and metrics must follow the approved semantic layer). autode_list_connections lists the data platforms (if one is missing, propose it with autode_propose_connection); autode_explain_sql dry-runs SQL without executing it. Nothing you do changes AutoDE's state or a data platform directly: propose changes with the autode_propose_* tools; each becomes a decision a person approves (high stakes: only in the AutoDE panel, the CLI or the decision file; low stakes: ask the user, then autode_resolve_decision). autode_execute_query runs reads only; platform changes are runbooks (autode_propose_runbook), approved by a person and run by AutoDE's runner. autode_approvals_list says what waits for a person.`
    }
  );
  ref.server = server;
  const previousOnClose = server.onclose;
  server.onclose = () => { platform.dispose(); previousOnClose?.(); };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, title: t.annotations.title, description: t.description, inputSchema: t.inputSchema as { type: 'object' }, annotations: t.annotations }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool "${request.params.name}".`);
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const started = Date.now();
    try {
      const validate = validatorFor(tool);
      if (!validate(args)) {
        throw new EngineToolError('VALIDATION_FAILED', `Invalid arguments for ${tool.name}.`, { errors: (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`) });
      }
      const result = await tool.handler(args, ws);
      log(`${tool.name} ok (${Date.now() - started} ms)`);
      return textResult(result);
    } catch (err) {
      const r = errorResult(err);
      log(`${tool.name} failed: ${String(r.structuredContent.code)} ${String(r.structuredContent.message)}`);
      return r;
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    try {
      return { prompts: listPrompts(ws) };
    } catch (err) {
      throw protocolError(err);
    }
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    try {
      const p = getPrompt(ws, request.params.name, (request.params.arguments ?? {}) as Record<string, string>, tools);
      return { description: p.description, messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.text } }] };
    } catch (err) {
      throw protocolError(err);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      return { resources: listResources(ws) };
    } catch (err) {
      throw protocolError(err);
    }
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [PRIMITIVE_RESOURCE_TEMPLATE, ASSET_RESOURCE_TEMPLATE, ARTICLE_RESOURCE_TEMPLATE] }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      const r = await readResource(ws, request.params.uri);
      return { contents: [{ uri: r.uri, mimeType: r.mimeType, text: redact(r.text), _meta: { revision: r.revision } }] };
    } catch (err) {
      throw protocolError(err);
    }
  });

  return server;
}

export function parseArgs(argv: readonly string[]): { workspaceRoot: string; resourcesRoot?: string; allowCli: boolean; driversRoot?: string } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  return { workspaceRoot: path.resolve(get('--workspace') ?? process.cwd()), resourcesRoot: get('--resources'), allowCli: argv.includes('--allow-cli'), driversRoot: get('--drivers') };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const resourcesRoot = args.resourcesRoot ? path.resolve(args.resourcesRoot) : findResourcesRoot();
  if (!resourcesRoot) process.stderr.write('autode: extension resources not found (pass --resources <extension root>); bundled interview prompts and primitives are unavailable.\n');
  const version = readVersion(resourcesRoot);
  const server = createAutodeServer({ workspaceRoot: args.workspaceRoot, resourcesRoot: resourcesRoot ?? args.workspaceRoot, version, allowCli: args.allowCli, driversRoot: args.driversRoot });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`autode MCP server ${version} — workspace ${args.workspaceRoot}\n`);
}
