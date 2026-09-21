import * as vscode from 'vscode';
import { MappingContext, EntityMapping, ColumnMapping, ContextStatus } from '../core/types';
import { parseYaml, stringifyYaml } from './Yaml';

/**
 * Manages the Mapping Context — Step 6 of the Source & Target Context
 * Architecture plan, per the architecture review's Q2: a separate,
 * independent object from `SourceContext`/`TargetContext` (mappings are
 * inherently relational and don't belong inside either side). Persists to
 * `<contextRoot>/context/mapping-context.yaml`, atomic writes; the exact same
 * content-revision versioning pattern as `SourceContextManager`/
 * `TargetContextManager`/`PipelineSpecManager` — revising an already-approved
 * record bumps `version` and archives the predecessor to `context/history/`.
 */
export class MappingContextManager implements vscode.Disposable {
  private context: MappingContext | undefined;
  private readonly contextDir: vscode.Uri;
  private readonly fileUri: vscode.Uri;

  constructor(
    private readonly contextRoot: vscode.Uri,
    private readonly log: (msg: string) => void
  ) {
    this.contextDir = vscode.Uri.joinPath(contextRoot, 'context');
    this.fileUri = vscode.Uri.joinPath(this.contextDir, 'mapping-context.yaml');
  }

  public dispose(): void {}

  public async initialize(): Promise<void> {
    try {
      const content = await vscode.workspace.fs.readFile(this.fileUri);
      this.context = this.parse(Buffer.from(content).toString('utf8'));
      this.log(`Loaded Mapping Context for ${this.context.specId} v${this.context.specVersion} (${this.context.mappings.length} mapping(s)).`);
    } catch {
      this.context = undefined;
      this.log('No Mapping Context yet.');
    }
  }

  public getContext(): MappingContext | undefined {
    return this.context ? { ...this.context, mappings: this.context.mappings.map((m) => ({ ...m, columns: m.columns.map((c) => ({ ...c })) })) } : undefined;
  }

  /** Resets to a fresh, empty record for a spec version. */
  public async reset(specId: string, specVersion: number): Promise<MappingContext> {
    const context: MappingContext = { specId, specVersion, status: 'pending', mappings: [] };
    await this.save(context);
    return this.getContext()!;
  }

  /**
   * Adds or replaces one `EntityMapping` (by id) and persists. The whole
   * container's `status` drops back to `'built'` on any mapping change once
   * it was `'approved'` — an approved mapping set that then gets edited is no
   * longer the thing that was approved, so it must be re-reviewed, never
   * silently treated as still-approved.
   */
  public async upsertMapping(mapping: EntityMapping): Promise<MappingContext> {
    const current = this.context ?? { specId: '', specVersion: 1, status: 'pending' as const, mappings: [] };
    const mappings = current.mappings.filter((m) => m.id !== mapping.id);
    mappings.push(mapping);
    const status = current.status === 'approved' ? 'built' : current.status;
    return this.save({ ...current, status, mappings, builtAt: new Date().toISOString() });
  }

  public async removeMapping(mappingId: string): Promise<MappingContext> {
    const current = this.context;
    if (!current) throw new Error('No Mapping Context to remove from.');
    const status = current.status === 'approved' ? 'built' : current.status;
    return this.save({ ...current, status, mappings: current.mappings.filter((m) => m.id !== mappingId) });
  }

  /** Same versioning contract as `SourceContextManager.save()` — see its doc comment for the exact bump/archive semantics. */
  public async save(context: MappingContext): Promise<MappingContext> {
    const previous = this.context;
    const sameLineage = !!previous && previous.specId === context.specId && previous.specVersion === context.specVersion;
    const previousWasApproved = previous?.status === 'approved';
    const version = sameLineage
      ? (previousWasApproved ? (previous!.version ?? 1) + 1 : (previous!.version ?? 1))
      : (context.version ?? 1);
    if (previousWasApproved) {
      await this.archive(previous!);
    }
    const toSave: MappingContext = { ...context, version };
    this.context = toSave;
    await vscode.workspace.fs.createDirectory(this.contextDir);
    const tempUri = vscode.Uri.joinPath(this.contextDir, `.mapping-context.tmp.${Date.now()}.yaml`);
    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(this.serialize(toSave), 'utf8'));
    await vscode.workspace.fs.rename(tempUri, this.fileUri, { overwrite: true });
    this.log(`Saved Mapping Context spec-v${toSave.specVersion} rev${toSave.version} (${toSave.mappings.length} mapping(s)).`);
    return this.getContext()!;
  }

  private async archive(previous: MappingContext): Promise<void> {
    const historyDir = vscode.Uri.joinPath(this.contextDir, 'history');
    await vscode.workspace.fs.createDirectory(historyDir);
    const target = vscode.Uri.joinPath(historyDir, `mapping-context.spec${previous.specVersion}.v${previous.version ?? 1}.yaml`);
    try {
      await vscode.workspace.fs.stat(target);
      return;
    } catch {
      // not present yet — write it
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(this.serialize(previous), 'utf8'));
    this.log(`Archived Mapping Context spec-v${previous.specVersion} rev${previous.version ?? 1} → context/history/`);
  }

  private serialize(context: MappingContext): string {
    return '# AutoDE Mapping Context\n' + stringifyYaml(context as unknown as Record<string, unknown>);
  }

  private parse(content: string): MappingContext {
    const raw = parseYaml(content);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid mapping-context YAML: root must be an object.');
    }
    const doc = raw as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

    const parseColumn = (c: unknown): ColumnMapping | undefined => {
      if (!c || typeof c !== 'object') return undefined;
      const rec = c as Record<string, unknown>;
      const sourceColumn = str(rec.sourceColumn);
      const targetColumn = str(rec.targetColumn);
      if (!sourceColumn || !targetColumn) return undefined;
      return { sourceColumn, targetColumn, transformExpression: str(rec.transformExpression) || undefined };
    };

    const parseMapping = (m: unknown): EntityMapping | undefined => {
      if (!m || typeof m !== 'object') return undefined;
      const rec = m as Record<string, unknown>;
      const id = str(rec.id);
      const sourceEntityId = str(rec.sourceEntityId);
      const targetName = str(rec.targetName);
      if (!id || !sourceEntityId || !targetName) return undefined;
      const columns = Array.isArray(rec.columns) ? rec.columns.map(parseColumn).filter((c): c is ColumnMapping => !!c) : [];
      return {
        id, sourceEntityId, targetName, columns,
        sourceFqn: str(rec.sourceFqn),
        targetEntityId: str(rec.targetEntityId) || undefined,
        notes: str(rec.notes) || undefined
      };
    };

    const mappings = Array.isArray(doc.mappings) ? doc.mappings.map(parseMapping).filter((m): m is EntityMapping => !!m) : [];

    return {
      specId: str(doc.specId),
      specVersion: typeof doc.specVersion === 'number' ? doc.specVersion : 1,
      version: typeof doc.version === 'number' ? doc.version : 1,
      status: (str(doc.status) as ContextStatus) || 'pending',
      sourceContextVersion: num(doc.sourceContextVersion),
      targetContextVersion: num(doc.targetContextVersion),
      mappings,
      builtAt: str(doc.builtAt) || undefined,
      approvedAt: str(doc.approvedAt) || undefined
    };
  }
}
