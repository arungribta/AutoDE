import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml } from '../engine/context/Yaml';
import { AssertionLedger } from '../engine/context/ledger';
import { projectGraph } from '../engine/context/projection';
import { detectConflicts } from '../engine/context/conflicts';
import { Catalog, glossaryAliases } from '../engine/context/catalog';
import { buildVocabulary, parseVocabularyFile } from '../engine/context/vocabulary';
import { ContextPackSources } from '../engine/context/contextPack';
import { catalogWatermarks, mergeWatermarks } from '../engine/context/estate';
import { computeRevision } from '../engine/context/contextStore';
import { loadPrimitiveDefinitionsFromDirectory, mergePrimitiveDefinitions } from '../engine/transforms/declarative/loader';
import { createDeclarativePrimitive } from '../engine/transforms/declarative/adapter';
import { PrimitiveDefinition } from '../engine/transforms/declarative/types';
import { registerPrimitiveVersion, registerPrimitives, resetDeclarativePrimitives, resetVersionedPrimitives } from '../engine/transforms/registry';
import { interviewSkills } from '../engine/skills/skillRegistry';
import { loadSkillPack } from '../engine/agents/definitions';
import { ToolSkillState, loadToolSkillStates } from '../engine/skills/lifecycle';
import { knowledgeSkills } from '../engine/skills/port';
import { SkillDefinition } from '../engine/types';
import { LayoutKey, layoutPath } from '../engine/workspaceLayout';
import { EngineToolError } from './errors';

/**
 * What the MCP server reads from a workspace — `.autode/**` and the
 * extension's bundled resources — strictly read-only (docs/mcp-engine-
 * requirements.md §5, §8: the server gets no write access to `.autode/`).
 *
 * Each source is re-read only when its files change (path + size + mtime),
 * so a long-running server follows edits made by the extension or by hand.
 */

export interface WorkspaceOptions {
  workspaceRoot: string;
  /** Where the extension's bundled `skills/` and `primitive-definitions/` live. */
  resourcesRoot: string;
  /** The business problem to read, instead of the active one (`.autode/local/`, absent in CI) — the CLI's `--problem`. */
  problemId?: string;
}

/** The per-problem documents exposed as resources (§5.5), relative to the active problem's folder. */
export const PROBLEM_DOCUMENTS: Readonly<Record<string, { rel: string; name: string; description: string }>> = {
  'spec/business-problem': { rel: 'spec/business-problem.yaml', name: 'Business Problem Specification', description: 'Intent, scope, objectives and decisions of the active business problem.' },
  'spec/pipeline': { rel: 'spec/pipeline.yaml', name: 'Pipeline Specification', description: 'Entities and transform steps of the active business problem.' },
  'context/source': { rel: 'context/source-context.yaml', name: 'Source context', description: 'Source systems of the active problem.' },
  'context/target': { rel: 'context/target-context.yaml', name: 'Target context', description: 'Target environment of the active problem.' },
  'context/mapping': { rel: 'context/mapping-context.yaml', name: 'Mapping context', description: 'Source-to-target mappings of the active problem.' },
  'context/semantic-layer': { rel: 'context/semantic-layer.yaml', name: 'Semantic layer', description: 'Semantic layer of the active problem.' }
};

function fingerprint(paths: readonly string[]): string {
  const parts: string[] = [];
  const add = (p: string) => {
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        for (const e of fs.readdirSync(p).sort()) add(path.join(p, e));
      } else {
        parts.push(`${p}:${st.size}:${st.mtimeMs}`);
      }
    } catch {
      parts.push(`${p}:-`);
    }
  };
  for (const p of paths) add(p);
  return parts.join('|');
}

export class EngineWorkspace {
  public readonly contextDir: string;
  private primitivesKey = '';
  private primitiveDefs = new Map<string, PrimitiveDefinition>();
  private primitiveErrors: string[] = [];
  private contextKey = '';
  private cachedSources: ContextPackSources | undefined;

  public constructor(public readonly options: WorkspaceOptions) {
    this.contextDir = layoutPath(options.workspaceRoot, 'root');
  }

  // ── Paths ────────────────────────────────────────────────────────────────

  private at(key: LayoutKey, ...more: string[]): string {
    return layoutPath(this.options.workspaceRoot, key, ...more);
  }

  /** A workspace-relative path, refused if it escapes the workspace. */
  public resolveInWorkspace(rel: string): string {
    const full = path.resolve(this.options.workspaceRoot, rel);
    const root = path.resolve(this.options.workspaceRoot);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new EngineToolError('PERMISSION_DENIED', `Path "${rel}" is outside the workspace.`);
    }
    return full;
  }

  public activeProblemId(): string | undefined {
    if (this.options.problemId !== undefined) return /^[A-Za-z0-9_.-]+$/.test(this.options.problemId) ? this.options.problemId : undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(this.at('activeProblem'), 'utf8')) as { problemId?: string };
      return typeof raw.problemId === 'string' && /^[A-Za-z0-9_.-]+$/.test(raw.problemId) ? raw.problemId : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every business problem folder under `.autode/problems/`. */
  public problemIds(): string[] {
    try {
      return fs.readdirSync(this.at('problems'), { withFileTypes: true }).filter((e) => e.isDirectory() && /^[A-Za-z0-9_.-]+$/.test(e.name)).map((e) => e.name).sort();
    } catch {
      return [];
    }
  }

  public problemRoot(): string | undefined {
    const id = this.activeProblemId();
    return id ? this.at('problems', id) : undefined;
  }

  /** The active problem's document for a resource key, if it exists on disk. */
  public problemDocument(key: string): string | undefined {
    const doc = PROBLEM_DOCUMENTS[key];
    const root = this.problemRoot();
    if (!doc || !root) return undefined;
    const file = path.join(root, ...doc.rel.split('/'));
    return fs.existsSync(file) ? file : undefined;
  }

  public readWithRevision(file: string): { text: string; revision: string } {
    const bytes = fs.readFileSync(file);
    return { text: bytes.toString('utf8'), revision: computeRevision(bytes) };
  }

  /** Parses a YAML or JSON document. */
  public readStructured(file: string): unknown {
    const text = fs.readFileSync(file, 'utf8');
    try {
      return /\.json$/i.test(file) ? JSON.parse(text) : parseYaml(text);
    } catch (err) {
      throw new EngineToolError('VALIDATION_FAILED', `${path.basename(file)} is not valid ${/\.json$/i.test(file) ? 'JSON' : 'YAML'}.`, { parseError: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── Primitives ───────────────────────────────────────────────────────────

  /** Registers bundled + workspace Tier-2 definitions (and archived revisions for pins) into the engine registry, when they changed. */
  public ensurePrimitives(): void {
    const bundledDir = path.join(this.options.resourcesRoot, 'primitive-definitions');
    const overrideDir = this.at('primitives');
    const key = fingerprint([bundledDir, overrideDir]);
    if (key === this.primitivesKey) return;
    resetDeclarativePrimitives();
    resetVersionedPrimitives();
    const bundled = loadPrimitiveDefinitionsFromDirectory(bundledDir);
    const overrides = fs.existsSync(overrideDir) ? loadPrimitiveDefinitionsFromDirectory(overrideDir) : { definitions: [], errors: [] };
    const merged = mergePrimitiveDefinitions(bundled.definitions, overrides.definitions);
    registerPrimitives(merged.map((d) => createDeclarativePrimitive(d)));
    const historyDir = path.join(overrideDir, 'history');
    if (fs.existsSync(historyDir)) for (const d of loadPrimitiveDefinitionsFromDirectory(historyDir).definitions) registerPrimitiveVersion(createDeclarativePrimitive(d));
    this.primitiveDefs = new Map(merged.map((d) => [d.kind, d]));
    this.primitiveErrors = [...bundled.errors, ...overrides.errors].map((e) => `${e.file}: ${e.error}`);
    this.primitivesKey = key;
  }

  public primitiveDefinition(kind: string): PrimitiveDefinition | undefined {
    this.ensurePrimitives();
    return this.primitiveDefs.get(kind);
  }

  public primitiveLoadErrors(): readonly string[] {
    this.ensurePrimitives();
    return this.primitiveErrors;
  }

  // ── Skills ───────────────────────────────────────────────────────────────

  /** The interview's parts (v0.45.12): AutoDE's interview skills, replaced by id by the workspace's `.autode/config/skills/*.json`. */
  public interviewSkills(): SkillDefinition[] {
    const overrideDir = this.at('skills');
    return interviewSkills(loadSkillPack(this.options.resourcesRoot).skills, fs.existsSync(overrideDir) ? overrideDir : undefined);
  }

  /** Imported tool skills with their S2 state — never migrated here (the server does not write). */
  public toolSkills(): ToolSkillState[] {
    return loadToolSkillStates(this.at('toolSkills'), 'mcp', { migrate: false });
  }

  // ── Context layer ────────────────────────────────────────────────────────

  private activeSpecId(): string | undefined {
    const file = this.problemDocument('spec/business-problem');
    if (!file) return undefined;
    try {
      const spec = parseYaml(fs.readFileSync(file, 'utf8')) as { id?: unknown } | undefined;
      return typeof spec?.id === 'string' ? spec.id : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * What context packs are built from — the projection of the ledger, its
   * conflicts and the catalog — exactly as the extension builds them, but read
   * only: nothing is promoted into the working set and nothing is saved.
   */
  public async contextSources(): Promise<ContextPackSources> {
    const ledgerDir = this.at('ledger');
    const catalogDir = this.at('catalog');
    const vocabFiles = [this.at('vocabulary')];
    const key = fingerprint([ledgerDir, catalogDir, ...vocabFiles, this.at('activeProblem'), this.problemDocument('spec/business-problem') ?? '', this.at('toolSkills')]);
    if (this.cachedSources && key === this.contextKey) return this.cachedSources;

    const ledger = new AssertionLedger(ledgerDir);
    if (fs.existsSync(ledgerDir)) await ledger.load();
    const assertions = ledger.assertions();
    const graph = projectGraph(assertions, { activeSpecId: this.activeSpecId() });
    const catalog = new Catalog(catalogDir);
    if (fs.existsSync(catalogDir)) await catalog.load();
    const vocabFile = vocabFiles.find((f) => fs.existsSync(f));
    catalog.setVocabulary(buildVocabulary(vocabFile ? parseVocabularyFile(fs.readFileSync(vocabFile, 'utf8')) : undefined));
    catalog.setAliases(glossaryAliases(catalog.all(), graph.nodes));
    if (catalog.size > 0) await catalog.buildIndex();
    this.cachedSources = {
      graph,
      assertions,
      conflicts: detectConflicts(assertions),
      catalogRevisions: mergeWatermarks(catalogWatermarks(graph.nodes), catalog.watermarks()),
      catalog,
      knowledgeSkills: knowledgeSkills(this.options.workspaceRoot)
    };
    this.contextKey = key;
    return this.cachedSources;
  }
}
