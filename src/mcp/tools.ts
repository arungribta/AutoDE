import { getPrimitiveVersion, isSelectable, listPrimitives, validateTransformSpec, compileTransformSpec } from '../engine/transforms/registry';
import { SqlDialect, TransformPrimitive } from '../engine/transforms/types';
import { validatePipelineSpec } from '../engine/pipelineSpec/validator';
import { compilePipelineSpec } from '../engine/pipelineSpec/compiler';
import { generateDesignDoc } from '../engine/pipelineSpec/designDocGenerator';
import { PipelineSpec } from '../engine/pipelineSpec/types';
import { resolveText } from '../engine/context/retrieval';
import { PackPurpose, buildContextPack } from '../engine/context/contextPack';
import { ASSERTION_KINDS, AssertionStatus, TRUST_TIERS, TrustTier } from '../engine/context/assertions';
import { isMirror } from '../engine/context/projection';
import { buildSchemaIndex, checkSqlGrounding } from '../engine/grounding/sqlGrounding';
import { UNSCOPED_PROBLEM, outputDirSegments } from '../engine/workspaceLayout';
import { EngineToolError } from './errors';
import { EngineWorkspace } from './workspace';

/**
 * The MCP tools (docs/mcp-engine-requirements.md §5.1, §5.2;
 * context-layer-requirements.md §9 — the read-only part shipped with phase 3).
 * Every tool is read-only and deterministic: no LLM calls (D5), no writes.
 * Inputs are validated against `inputSchema` before a handler runs.
 */

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface EngineTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  /** Returns a JSON object (`structuredContent`). Throws `EngineToolError` for expected failures. */
  handler: (args: Record<string, unknown>, ws: EngineWorkspace) => Promise<Record<string, unknown>>;
}

export const SQL_DIALECTS: readonly SqlDialect[] = ['snowflake', 'spark_sql', 'google_sql', 'postgres', 'tsql', 'ansi'];
const PACK_PURPOSES: readonly PackPurpose[] = ['interview', 'spec', 'plan', 'step', 'chat', 'qa'];
const STATUSES: readonly AssertionStatus[] = ['proposed', 'active', 'rejected', 'superseded', 'needs_review'];
const TRUSTS: readonly TrustTier[] = TRUST_TIERS;

const readOnly = (title: string): ToolAnnotations => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

const dialectSchema = { type: 'string', enum: SQL_DIALECTS, description: 'SQL dialect to compile for.' };
const transformSchema = {
  type: 'object',
  required: ['kind', 'params'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', minLength: 1, description: 'Primitive kind, from autode_search_primitives.' },
    params: { type: 'object', description: 'Parameters, valid against the primitive\'s paramSchema (autode_describe_primitive).' },
    primitiveVersion: { type: 'integer', minimum: 1, description: 'Pins a published version of a declarative primitive.' }
  }
};
const specInput = {
  path: { type: 'string', minLength: 1, description: 'Workspace-relative path to a Pipeline Spec (YAML/JSON). Default: the active business problem\'s spec/pipeline.yaml.' }
};

function primitiveSummary(p: TransformPrimitive<unknown>): Record<string, unknown> {
  return { kind: p.kind, version: p.version ?? null, description: p.description, status: p.status ?? 'published', tier: p.version === undefined && p.status === undefined ? 1 : 2, platforms: null };
}

function requirePrimitive(ws: EngineWorkspace, kind: string, version?: number): TransformPrimitive<unknown> {
  ws.ensurePrimitives();
  const p = getPrimitiveVersion(kind, version);
  if (!p) throw new EngineToolError('UNKNOWN_PRIMITIVE', `Unknown primitive kind "${kind}".`, { known: listPrimitives().map((x) => x.kind) });
  if (version !== undefined && p.version !== undefined && p.version !== version) {
    throw new EngineToolError('UNKNOWN_PRIMITIVE', `Primitive "${kind}" has no version ${version}.`, { live: p.version });
  }
  return p as TransformPrimitive<unknown>;
}

function loadPipelineSpec(ws: EngineWorkspace, args: Record<string, unknown>): { spec: unknown; source: string } {
  if (args.spec !== undefined) return { spec: args.spec, source: 'inline' };
  if (typeof args.path === 'string') {
    const file = ws.resolveInWorkspace(args.path);
    try {
      return { spec: ws.readStructured(file), source: args.path };
    } catch (err) {
      if (err instanceof EngineToolError) throw err;
      throw new EngineToolError('NOT_FOUND', `No readable file at "${args.path}".`);
    }
  }
  const file = ws.problemDocument('spec/pipeline');
  if (!file) throw new EngineToolError('NOT_FOUND', ws.activeProblemId() ? 'The active business problem has no Pipeline Spec yet.' : 'No business problem is active, so there is no default Pipeline Spec; pass "path".');
  return { spec: ws.readStructured(file), source: 'active problem: spec/pipeline.yaml' };
}

function validSpec(ws: EngineWorkspace, args: Record<string, unknown>): { spec: PipelineSpec; source: string } {
  ws.ensurePrimitives();
  const { spec, source } = loadPipelineSpec(ws, args);
  const result = validatePipelineSpec(spec);
  if (!result.valid) throw new EngineToolError('VALIDATION_FAILED', `The Pipeline Spec (${source}) is not valid.`, { result: result as unknown as Record<string, unknown> });
  return { spec: spec as PipelineSpec, source };
}

const slug = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'entity';

export const TOOLS: readonly EngineTool[] = [
  // ── §5.1 registry ──
  {
    name: 'autode_search_primitives',
    description: 'Search the transform-primitive registry (reviewed, deterministic SQL generators). Use this, then autode_describe_primitive, then autode_compile_transform, instead of writing transformation SQL by hand.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Words to match against kind and description; omit to list all.' },
        platform: { ...dialectSchema, description: 'Only primitives declared for this dialect (every current primitive supports all dialects).' },
        includeDeprecated: { type: 'boolean', description: 'Also list draft, deprecated and retired primitives (default false).' }
      }
    },
    annotations: readOnly('Search transform primitives'),
    handler: async (args, ws) => {
      ws.ensurePrimitives();
      const words = String(args.query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const items = listPrimitives()
        .filter((p) => args.includeDeprecated === true || isSelectable(p))
        .filter((p) => words.every((w) => `${p.kind} ${p.description}`.toLowerCase().includes(w)))
        .map((p) => primitiveSummary(p))
        .sort((a, b) => String(a.kind).localeCompare(String(b.kind)));
      return { items, loadErrors: ws.primitiveLoadErrors() };
    }
  },
  {
    name: 'autode_describe_primitive',
    description: 'Describe one transform primitive: its parameter JSON Schema (build params against it), status and, for declarative primitives, example params.',
    inputSchema: { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { type: 'string', minLength: 1 }, version: { type: 'integer', minimum: 1 } } },
    annotations: readOnly('Describe a transform primitive'),
    handler: async (args, ws) => {
      const p = requirePrimitive(ws, String(args.kind), args.version as number | undefined);
      const def = ws.primitiveDefinition(p.kind);
      return { ...primitiveSummary(p), paramSchema: p.paramSchema, previewParams: def && def.version === p.version ? def.previewParams : null };
    }
  },
  {
    name: 'autode_validate_transform',
    description: 'Validate a transform spec ({ kind, params }) against the primitive\'s parameter schema without compiling.',
    inputSchema: transformSchema,
    annotations: readOnly('Validate a transform'),
    handler: async (args, ws) => {
      requirePrimitive(ws, String(args.kind), args.primitiveVersion as number | undefined);
      return validateTransformSpec({ kind: String(args.kind), params: args.params as Record<string, unknown>, primitiveVersion: args.primitiveVersion as number | undefined });
    }
  },
  {
    name: 'autode_compile_transform',
    description: 'Compile a transform spec to code for a target and dialect. Validates first. Returns the code; never writes files.',
    inputSchema: {
      type: 'object', required: ['transform', 'target', 'dialect'], additionalProperties: false,
      properties: {
        transform: transformSchema,
        target: {
          type: 'object', required: ['platform', 'database', 'schema'], additionalProperties: false,
          properties: { platform: { type: 'string', minLength: 1 }, database: { type: 'string' }, schema: { type: 'string' } }
        },
        dialect: dialectSchema
      }
    },
    annotations: readOnly('Compile a transform'),
    handler: async (args, ws) => {
      const t = args.transform as { kind: string; params: Record<string, unknown>; primitiveVersion?: number };
      requirePrimitive(ws, t.kind, t.primitiveVersion);
      const v = validateTransformSpec(t);
      if (!v.valid) throw new EngineToolError('VALIDATION_FAILED', `Invalid params for primitive "${t.kind}".`, { errors: v.errors });
      const compiled = compileTransformSpec(t, args.target as { platform: string; database: string; schema: string }, args.dialect as SqlDialect);
      return { ...compiled };
    }
  },

  // ── §5.2 Pipeline Spec ──
  {
    name: 'autode_validate_pipeline_spec',
    description: 'Validate a Pipeline Spec — by path, inline, or the active business problem\'s.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...specInput, spec: { type: 'object', description: 'An inline Pipeline Spec instead of a file.' } } },
    annotations: readOnly('Validate a Pipeline Spec'),
    handler: async (args, ws) => {
      ws.ensurePrimitives();
      const { spec, source } = loadPipelineSpec(ws, args);
      return { source, ...(validatePipelineSpec(spec) as unknown as Record<string, unknown>) };
    }
  },
  {
    name: 'autode_compile_pipeline_spec',
    description: 'Compile a valid Pipeline Spec to code, entity by entity, with suggested paths in the output folder (autode-output/<problem>/03-build/…, where the extension writes build artifacts). Returns content; never writes files.',
    inputSchema: { type: 'object', required: ['dialect'], additionalProperties: false, properties: { ...specInput, dialect: dialectSchema } },
    annotations: readOnly('Compile a Pipeline Spec'),
    handler: async (args, ws) => {
      const { spec, source } = validSpec(ws, args);
      // Same place ArtifactWriter writes build artifacts (default output folder; the extension's setting is not visible here).
      const base = [...outputDirSegments(ws.activeProblemId() ?? UNSCOPED_PROBLEM), '03-build', `${spec.id}.v${spec.version}`].join('/');
      const entities = compilePipelineSpec(spec, args.dialect as SqlDialect).map((e) => ({
        name: e.name,
        artifacts: e.artifacts.map((a, i) => ({ ...a, suggestedPath: `${base}/${slug(e.name)}/${String(i + 1).padStart(2, '0')}_${slug(a.kind)}.sql` }))
      }));
      return { source, specId: spec.id, specVersion: spec.version, dialect: args.dialect, entities };
    }
  },
  {
    name: 'autode_generate_design_doc',
    description: 'Generate the Markdown design document for a valid Pipeline Spec.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...specInput } },
    annotations: readOnly('Generate a design document'),
    handler: async (args, ws) => {
      const { spec, source } = validSpec(ws, args);
      return { source, markdown: generateDesignDoc(spec) };
    }
  },

  // ── context-layer §9 (read-only part) ──
  {
    name: 'autode_resolve',
    description: 'Resolve free text (a table name, a business term, a question) to the estate objects it refers to, deterministically: the working set first, then the estate catalog (abbreviations, synonyms, the customer\'s vocabulary, comments, glossary).',
    inputSchema: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
    annotations: readOnly('Resolve text to estate objects'),
    handler: async (args, ws) => {
      const src = await ws.contextSources();
      const limit = (args.limit as number | undefined) ?? 20;
      const byId = new Map(src.graph.nodes.map((n) => [n.id, n]));
      const matches: Array<Record<string, unknown>> = resolveText(String(args.text), src.graph).map((m) => {
        const n = byId.get(m.nodeId);
        return { id: m.nodeId, type: n?.type, label: n?.label, score: m.score, via: m.via, matchedText: m.text, source: 'working_set' };
      });
      const seen = new Set(matches.map((m) => m.id));
      const hits = src.catalog ? src.catalog.search(String(args.text)).slice(0, limit) : [];
      for (const h of hits) if (!seen.has(h.id)) matches.push({ id: h.id, type: 'table', score: h.score, via: 'catalog', matched: h.matched, tier: h.tier, visible: h.visible, source: 'catalog' });
      matches.sort((a, b) => Number(b.score) - Number(a.score));
      return { text: args.text, matches: matches.slice(0, limit) };
    }
  },
  {
    name: 'autode_get_context_pack',
    description: 'Build the task-scoped context pack AutoDE itself gives its agents: the relevant estate objects, business facts, conflicts and gaps, within a token budget, with a manifest of what it rests on.',
    inputSchema: {
      type: 'object', required: ['purpose'], additionalProperties: false,
      properties: {
        purpose: { type: 'string', enum: PACK_PURPOSES },
        seeds: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 50, description: 'Object ids to centre the pack on (from autode_resolve).' },
        query: { type: 'string', description: 'The task or question to resolve seeds from, when no seeds are given.' },
        maxTokens: { type: 'integer', minimum: 200, maximum: 32000 }
      }
    },
    annotations: readOnly('Get a context pack'),
    handler: async (args, ws) => {
      const pack = buildContextPack({ purpose: args.purpose as PackPurpose, seeds: args.seeds as string[] | undefined, query: args.query as string | undefined, maxTokens: args.maxTokens as number | undefined }, await ws.contextSources());
      return { text: pack.text, manifest: pack.manifest as unknown as Record<string, unknown> };
    }
  },
  {
    name: 'autode_list_assertions',
    description: 'Query the assertion ledger: the business and technical facts AutoDE holds, with status, trust and evidence. Graph mirrors (raw schema facts) are left out unless asked for.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        subject: { type: 'string', description: 'Only assertions about this object id.' },
        kind: { type: 'string', enum: ASSERTION_KINDS },
        status: { type: 'array', items: { type: 'string', enum: STATUSES }, description: 'Default: proposed, active, needs_review.' },
        trust: { type: 'array', items: { type: 'string', enum: TRUSTS } },
        includeMirrors: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 1000 }
      }
    },
    annotations: readOnly('List assertions'),
    handler: async (args, ws) => {
      const src = await ws.contextSources();
      const statuses = new Set((args.status as AssertionStatus[] | undefined) ?? ['proposed', 'active', 'needs_review']);
      const trusts = args.trust ? new Set(args.trust as TrustTier[]) : undefined;
      const matching = src.assertions.filter((a) => statuses.has(a.status) && (!trusts || trusts.has(a.trust)) && (!args.kind || a.kind === args.kind)
        && (!args.subject || a.subject.includes(String(args.subject))) && (args.includeMirrors === true || !isMirror(a)));
      const limit = (args.limit as number | undefined) ?? 100;
      return {
        total: matching.length,
        assertions: matching.slice(0, limit).map((a) => ({ id: a.id, kind: a.kind, subject: a.subject, predicate: a.predicate, value: a.value, statement: a.statement, status: a.status, trust: a.trust, specId: a.specId ?? null, evidence: a.evidence.map((e) => ({ type: e.type, ref: e.ref })) }))
      };
    }
  },
  {
    name: 'autode_check_grounding',
    description: 'Check generated SQL against the estate AutoDE knows: unresolved tables and columns, ambiguous names, incompatible types. Use it to self-check code before proposing it.',
    inputSchema: {
      type: 'object', required: ['content'], additionalProperties: false,
      properties: { content: { type: 'string', minLength: 1 }, dialect: dialectSchema, name: { type: 'string', description: 'A label for the artifact in the result.' } }
    },
    annotations: readOnly('Check SQL grounding'),
    handler: async (args, ws) => {
      const src = await ws.contextSources();
      const index = buildSchemaIndex(src.graph.nodes, src.graph.edges);
      const result = checkSqlGrounding([{ name: String(args.name ?? 'input.sql'), content: String(args.content) }], index);
      return { ...(result as unknown as Record<string, unknown>), knownTables: index.tables.length };
    }
  }
];
