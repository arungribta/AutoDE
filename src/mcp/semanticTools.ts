import * as fs from 'node:fs';
import { EngineTool, ToolAnnotations } from './tools';
import { EngineToolError } from './errors';
import { EngineWorkspace } from './workspace';
import { createSubjectResolver } from '../engine/context/projection';
import { problemTableIds } from '../engine/context/capture';
import { checkSemanticModel } from '../engine/semantic/checks';
import { draftSemanticModel } from '../engine/semantic/draft';
import { parseSemanticModel, serializeSemanticModel } from '../engine/semantic/model';
import { parseComposite, resolveComposite } from '../engine/semantic/composite';
import { listComposites, listShared, readShared, resolveCompositeFile, sharedLoader } from '../engine/semantic/store';

/**
 * The semantic layer over MCP (C5a; docs/context-layer-requirements.md
 * §6.7): read tools, resolution (deterministic, derived), and — in
 * decisions.ts — `autode_propose_semantic_model`: an agent's change to a
 * shared model or a composite is a proposal a person approves.
 */

const read = (title: string): ToolAnnotations => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

export function semanticTools(): EngineTool[] {
  return [
    {
      name: 'autode_semantic_list',
      description: 'The semantic layer: shared semantic models (Snowflake semantic model YAML, in <artifactDirectory>/semantic/) with their approval status, and the active problem\'s composites (which shared models they use, resolved, stale or unresolved). Read them as resources (autode://semantic/...).',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      annotations: read('List the semantic layer'),
      handler: async (_args, ws) => ({
        shared: listShared(ws.options.workspaceRoot).map((s) => ({ name: s.name, status: s.status, revision: s.revision, approved: s.approved, tables: s.model?.tables.map((t) => t.name) ?? [], errors: s.errors })),
        composites: listComposites(ws.options.workspaceRoot, ws.activeProblemId()).map((c) => ({ name: c.name, problemId: c.problemId, status: c.status, staleBecause: c.staleBecause, uses: c.composite?.uses.map((u) => u.model) ?? [], approved: c.approved, approvalCurrent: c.approvalCurrent, errors: c.errors }))
      })
    },
    {
      name: 'autode_semantic_check',
      description: 'Check a semantic model against the estate and AutoDE\'s facts: the Snowflake format, base tables and columns that exist, expressions over known columns and elements, relationships that agree with known keys, primary keys facts support, metrics their facts define the same way. Give a shared model\'s name, or content (a model or a composite, checked as it would resolve). Records nothing.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1 }, content: { type: 'string', minLength: 1 } } },
      annotations: read('Check a semantic model'),
      handler: async (args, ws) => {
        if (!!args.name === !!args.content) throw new EngineToolError('VALIDATION_FAILED', 'Give name (a shared model) or content, not both.');
        const text = args.name ? (() => { const s = readShared(ws.options.workspaceRoot, String(args.name)); if (!s) throw new EngineToolError('NOT_FOUND', `No shared model "${String(args.name)}".`); return fs.readFileSync(s.file, 'utf8'); })() : String(args.content);
        const src = await ws.contextSources();
        if (/^\s*autode:\s*semantic-composite\//m.test(text)) {
          const c = parseComposite(text);
          if (!c.composite) return { errors: c.errors, findings: [] };
          const r = resolveComposite(c.composite, sharedLoader(ws.options.workspaceRoot));
          return { errors: r.errors, findings: r.model ? checkSemanticModel(r.model, src) : [], revisions: r.revisions };
        }
        const m = parseSemanticModel(text);
        return { errors: m.errors, warnings: m.warnings, findings: m.model ? checkSemanticModel(m.model, src) : [] };
      }
    },
    {
      name: 'autode_semantic_draft',
      description: 'Draft a shared semantic model from what AutoDE knows, deterministically: tables and primary keys from declared keys and confirmed key facts, relationships from foreign keys and confirmed relationship facts, dimensions, time dimensions and facts from column types, metrics from confirmed metric facts, synonyms from bound glossary terms, personal-data notes from classifications. Defaults to the tables the active problem names. Returns the YAML and the facts behind each element; nothing is written: propose it with autode_propose_semantic_model, improving descriptions and synonyms first if you like.',
      inputSchema: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_-]*$' }, description: { type: 'string' }, tables: { type: 'array', items: { type: 'string', minLength: 1 } }, database: { type: 'string', minLength: 1, description: 'The database the base tables live in, when their names have none.' } } },
      annotations: read('Draft a semantic model'),
      handler: async (args, ws) => {
        const src = await ws.contextSources();
        const resolve = createSubjectResolver(src.graph as Parameters<typeof createSubjectResolver>[0]);
        const root = ws.problemRoot();
        const ids = (args.tables as string[] | undefined)?.map((t) => resolve(t) ?? t) ?? (root ? problemTableIds({ workspaceRoot: ws.options.workspaceRoot, problemRoot: root, sources: src }) : []);
        if (!ids.length) throw new EngineToolError('NOT_FOUND', 'No table to draft from: name tables, or open a problem whose specification names tables AutoDE knows.');
        const d = draftSemanticModel({ graph: src.graph, assertions: src.assertions, tableIds: ids, name: String(args.name), description: args.description as string | undefined, database: args.database as string | undefined });
        return { yaml: serializeSemanticModel(d.model), backing: d.backing, notes: d.notes, findings: checkSemanticModel(d.model, src), next: 'Review it with the user, then autode_propose_semantic_model (scope shared). A person approves it.' };
      }
    },
    {
      name: 'autode_semantic_resolve',
      description: 'Resolve one of the active problem\'s composites into its self-contained Snowflake model (<name>.resolved.yaml): deterministic, refused with every reason on a missing model or table, a collision between shared models, or an addition that redefines a shared expression, key or join. Returns the diff against the previous resolution. A person approves the composite within the problem.',
      inputSchema: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1 } } },
      annotations: { title: 'Resolve a composite', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args, ws) => {
        const problemId = ws.activeProblemId();
        if (!problemId) throw new EngineToolError('NOT_FOUND', 'No active business problem.');
        const r = resolveCompositeFile(ws.options.workspaceRoot, problemId, String(args.name));
        if (!r.ok) throw new EngineToolError('VALIDATION_FAILED', `${String(args.name)} doesn't resolve: ${r.errors.join('; ')}`, { errors: r.errors });
        return { resolvedFile: r.resolvedFile, changed: r.changed, diff: r.diff, revisions: r.revisions };
      }
    }
  ];
}

/** Resources: each shared model, and the active problem's composites and resolved models. */
export function semanticResources(ws: EngineWorkspace): Array<{ uri: string; name: string; description: string; mimeType: string; file: string }> {
  const out = listShared(ws.options.workspaceRoot).map((s) => ({ uri: `autode://semantic/shared/${s.name}`, name: `Semantic model ${s.name}`, description: `Shared semantic model (${s.status}).`, mimeType: 'application/yaml', file: s.file }));
  for (const c of listComposites(ws.options.workspaceRoot, ws.activeProblemId())) {
    out.push({ uri: `autode://semantic/composite/${c.name}`, name: `Composite ${c.name}`, description: `The problem's composite (${c.status}).`, mimeType: 'application/yaml', file: c.file });
    if (fs.existsSync(c.resolvedFile)) out.push({ uri: `autode://semantic/resolved/${c.name}`, name: `Resolved ${c.name}`, description: 'Resolved, deployable Snowflake model.', mimeType: 'application/yaml', file: c.resolvedFile });
  }
  return out;
}
