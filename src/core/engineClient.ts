import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createAutodeServer } from '../mcp/server';
import { PlatformSession } from '../mcp/platform';
import { EngineAccess, EngineToolSet, ToolExecutionMode } from '../engine/types';

/**
 * The extension's client of the AutoDE engine (docs/specs/mcp-engine.md
 * §7.2, phase 5): the same MCP server other hosts start with `autode mcp`,
 * connected over an in-memory transport — the same protocol, tool list,
 * validation and error envelope, without a child process to manage. It starts
 * on the first call, never at activation.
 *
 * Agents reach it through `AgentExecutionContext.engine`; today the tool-skill
 * runner offers its tools to imported skills, and PA3's in-process executor
 * calls it the way any host agent does.
 */

/** How Claude Code names the tools of an MCP server called `autode`; skills ported from it declare them so. */
export const ENGINE_TOOL_PREFIX = 'mcp__autode__';

export interface EngineToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}

export class EngineError extends Error {
  public constructor(public readonly code: string, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'EngineError';
  }
}

/** The engine tools a skill declared: exact names, `mcp__autode__<name>`, or all of them with `mcp__autode` / `mcp__autode__*`. `undefined` = no narrowing. */
export function declaredEngineTools(declared: readonly string[] | undefined, available: readonly string[]): Set<string> | undefined {
  if (!declared || declared.length === 0) return undefined;
  const names = new Set<string>();
  for (const raw of declared) {
    const d = raw.trim().split('(')[0].trim();
    if (d === 'mcp__autode' || d === `${ENGINE_TOOL_PREFIX}*`) { for (const n of available) names.add(n); continue; }
    const bare = d.startsWith(ENGINE_TOOL_PREFIX) ? d.slice(ENGINE_TOOL_PREFIX.length) : d;
    if (available.includes(bare)) names.add(bare);
  }
  return names;
}

/**
 * The engine tools a skill run gets (§7.4): read-only tools in `'read-only'`; in
 * `'full'` also the ones that only propose a change; never a destructive one
 * (resolving or applying a decision is a person's act, not a skill's) — then
 * narrowed to what the skill declared.
 */
export function selectEngineTools(tools: readonly EngineToolInfo[], mode: ToolExecutionMode, declared: readonly string[] | undefined): EngineToolInfo[] {
  if (mode === 'none') return [];
  const allow = declaredEngineTools(declared, tools.map((t) => t.name));
  return tools.filter((t) => {
    if (t.annotations?.destructiveHint === true) return false;
    if (t.annotations?.readOnlyHint !== true && mode !== 'full') return false;
    return !allow || allow.has(t.name);
  });
}

export interface EngineClientOptions {
  workspaceRoot: string;
  /** Where the bundled `skills/` and `primitive-definitions/` live: the extension's folder. */
  resourcesRoot: string;
  version: string;
  log: (line: string) => void;
  /** The drivers folder setting, read at start. */
  driversRoot?: () => string | undefined;
  /** Consent to run the platform CLI (the extension's own consent), read at start. */
  allowCli?: () => boolean;
  /** Tests: a session with fake adapters. */
  platform?: PlatformSession;
  /** The MCP client name the engine records as the agent (PA3b: the role running a stage). Default `autode-vscode`. */
  clientName?: string;
}

export class EngineClient implements EngineAccess {
  private pending: Promise<{ client: Client; server: Server }> | undefined;
  private tools: EngineToolInfo[] | undefined;

  public constructor(private readonly options: EngineClientOptions) {}

  /** Started on first use; a failed start is forgotten so the next call retries. */
  private connect(): Promise<{ client: Client; server: Server }> {
    if (!this.pending) {
      this.pending = (async () => {
        const o = this.options;
        // Never writes to a platform: platform changes are applied by an --allow-write server after a person approves them.
        const platform = o.platform ?? new PlatformSession({ workspaceRoot: o.workspaceRoot, allowWrite: false, allowCli: o.allowCli?.() === true, driversRoot: o.driversRoot?.() || undefined, log: o.log });
        const server = createAutodeServer({ workspaceRoot: o.workspaceRoot, resourcesRoot: o.resourcesRoot, version: o.version, platform, log: o.log });
        const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);
        const client = new Client({ name: o.clientName ?? 'autode-vscode', version: o.version });
        await client.connect(clientSide);
        return { client, server };
      })();
      this.pending.catch(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  public async listTools(): Promise<EngineToolInfo[]> {
    if (!this.tools) {
      const { client } = await this.connect();
      this.tools = (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown>, annotations: t.annotations }));
    }
    return this.tools;
  }

  /** Calls one tool; its error envelope becomes an `EngineError`. */
  public async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { client } = await this.connect();
    const r = await client.callTool({ name, arguments: args });
    const structured = (r.structuredContent ?? {}) as Record<string, unknown>;
    if (r.isError) throw new EngineError(String(structured.code ?? 'INTERNAL_ERROR'), String(structured.message ?? 'The engine tool failed.'), (structured.details as Record<string, unknown> | undefined) ?? {});
    return structured;
  }

  public async toolSet(mode: ToolExecutionMode, declared: readonly string[] | undefined): Promise<EngineToolSet> {
    return this.setOf(selectEngineTools(await this.listTools(), mode, declared));
  }

  /** Exactly these tools (PA3b: an assignment's, already chosen by tier and role); never a destructive one. */
  public async toolSetNamed(names: readonly string[]): Promise<EngineToolSet> {
    const want = new Set(names);
    return this.setOf((await this.listTools()).filter((t) => want.has(t.name) && t.annotations?.destructiveHint !== true));
  }

  private setOf(picked: EngineToolInfo[]): EngineToolSet {
    const names = new Set(picked.map((t) => t.name));
    return {
      specs: picked.map((t) => ({ name: t.name, description: t.description ?? t.name, parameters: t.inputSchema })),
      call: async (name, input) => {
        // The run's own selection is the boundary, whatever the model asks for.
        if (!names.has(name)) return { text: `Error: the engine tool "${name}" is not available in this run.`, isError: true };
        const { client } = await this.connect();
        const r = await client.callTool({ name, arguments: input });
        const text = (r.content as Array<{ type: string; text?: string }> | undefined)?.find((c) => c.type === 'text')?.text ?? JSON.stringify(r.structuredContent ?? {});
        return { text: r.isError ? `Error: ${text}` : text, isError: r.isError === true };
      }
    };
  }

  public async declaresWrite(declared: readonly string[] | undefined): Promise<boolean> {
    if (!declared || declared.length === 0) return false;
    const tools = await this.listTools();
    const allow = declaredEngineTools(declared, tools.map((t) => t.name)) ?? new Set<string>();
    return tools.some((t) => allow.has(t.name) && t.annotations?.readOnlyHint !== true && t.annotations?.destructiveHint !== true);
  }

  public async dispose(): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    this.tools = undefined;
    if (!pending) return;
    try { const { client } = await pending; await client.close(); } catch { /* never started */ }
  }
}
