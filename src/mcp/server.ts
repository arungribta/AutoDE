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
import { PRIMITIVE_RESOURCE_TEMPLATE, getPrompt, listPrompts, listResources, readResource } from './catalogs';

/**
 * The AutoDE MCP server (docs/mcp-engine-requirements.md §3, §5; phases 3
 * and 4): the engine's registry, Pipeline Spec, prompts, resources, the
 * read-only context-layer tools and the data-platform tools over stdio.
 * Deterministic — no LLM calls (D5) — and it never writes to the workspace
 * (§8). Platform statements are read-only unless started with --allow-write.
 *
 *   node dist/mcp-server.js --workspace <root> [--resources <extension root>] [--allow-write] [--allow-cli] [--drivers <folder>]
 *
 * stdout carries the protocol; logs go to stderr, redacted.
 */

const PACKAGE_NAME = 'auto-data-engineering-hub';

/** The extension root (bundled `skills/`, `primitive-definitions/`, `package.json`): the nearest ancestor holding AutoDE's package.json. */
export function findResourcesRoot(start: string = __dirname): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === PACKAGE_NAME) return dir;
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
  /** `--allow-write`: platform statements other than SELECT / WITH / SHOW / DESCRIBE / EXPLAIN may run. */
  allowWrite?: boolean;
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
  const platform = options.platform ?? new PlatformSession({ workspaceRoot: options.workspaceRoot, allowWrite: options.allowWrite === true, allowCli: options.allowCli === true, driversRoot: options.driversRoot, log });
  // The decision tools read the client's name (from `initialize`) at call time.
  const ref: { server?: Server } = {};
  const tools: readonly EngineTool[] = [...TOOLS, ...platformTools(platform), ...decisionTools({ session: platform, clientName: () => ref.server?.getClientVersion()?.name })];
  const server = new Server(
    { name: 'autode', title: 'AutoDE', version: options.version, icons: serverIcons(options.resourcesRoot) },
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions: `AutoDE data-engineering engine. Find transform primitives with autode_search_primitives, read their parameter schema with autode_describe_primitive, and generate SQL with autode_compile_transform rather than writing it by hand. Use autode_resolve and autode_get_context_pack to learn what the estate and the business problem hold, and autode_check_grounding to check SQL before proposing it. autode_list_connections lists the data platforms; autode_explain_sql dry-runs SQL without executing it. Nothing you do changes AutoDE's state or a data platform directly: propose changes with the autode_propose_* tools; each becomes a decision a person approves (high stakes: only in the AutoDE panel, the CLI or the decision file; low stakes: ask the user, then autode_resolve_decision). autode_execute_query runs reads only.${platform.options.allowWrite ? ' This server was started with --allow-write: approved platform changes run with autode_apply_decision.' : ''}`
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
      const p = getPrompt(ws, request.params.name, (request.params.arguments ?? {}) as Record<string, string>);
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

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [PRIMITIVE_RESOURCE_TEMPLATE] }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      const r = readResource(ws, request.params.uri);
      return { contents: [{ uri: r.uri, mimeType: r.mimeType, text: redact(r.text), _meta: { revision: r.revision } }] };
    } catch (err) {
      throw protocolError(err);
    }
  });

  return server;
}

export function parseArgs(argv: readonly string[]): { workspaceRoot: string; resourcesRoot?: string; allowWrite: boolean; allowCli: boolean; driversRoot?: string } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  return { workspaceRoot: path.resolve(get('--workspace') ?? process.cwd()), resourcesRoot: get('--resources'), allowWrite: argv.includes('--allow-write'), allowCli: argv.includes('--allow-cli'), driversRoot: get('--drivers') };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const resourcesRoot = args.resourcesRoot ? path.resolve(args.resourcesRoot) : findResourcesRoot();
  if (!resourcesRoot) process.stderr.write('autode: extension resources not found (pass --resources <extension root>); bundled interview prompts and primitives are unavailable.\n');
  const version = readVersion(resourcesRoot);
  const server = createAutodeServer({ workspaceRoot: args.workspaceRoot, resourcesRoot: resourcesRoot ?? args.workspaceRoot, version, allowWrite: args.allowWrite, allowCli: args.allowCli, driversRoot: args.driversRoot });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`autode MCP server ${version} — workspace ${args.workspaceRoot}${args.allowWrite ? ' — platform writes allowed (--allow-write)' : ''}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`autode: ${redact(err instanceof Error ? err.message : String(err))}\n`);
    process.exit(1);
  });
}
