import * as vscode from 'vscode';
import { MappingContext, EntityMapping } from '../engine/types';
import { mappingContextHistoryName, nextMappingContextRevision, parseMappingContext, serializeMappingContext, withMappingUpserted } from '../engine/documents/problemDocuments';
import { ContextStore, RevisionedFile, applyReload } from '../engine/context/contextStore';
import { createVscodeFileIo } from './vscodeFileIo';

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
  private readonly file: RevisionedFile;

  constructor(
    private readonly contextRoot: vscode.Uri,
    private readonly log: (msg: string) => void
  ) {
    this.contextDir = vscode.Uri.joinPath(contextRoot, 'context');
    this.fileUri = vscode.Uri.joinPath(this.contextDir, 'mapping-context.yaml');
    this.file = new RevisionedFile(new ContextStore(createVscodeFileIo(vscode)), this.fileUri.fsPath, 'Mapping Context');
  }

  public dispose(): void {}

  public async initialize(): Promise<void> {
    try {
      const content = await this.file.read();
      if (content === undefined) throw new Error('absent');
      this.context = this.parse(content);
      this.log(`Loaded Mapping Context for ${this.context.specId} v${this.context.specVersion} (${this.context.mappings.length} mapping(s)).`);
    } catch {
      this.context = undefined;
      this.log('No Mapping Context yet.');
    }
  }

  /** Re-reads the file after an external change (v0.25.0). Returns true when the loaded record changed. */
  public async reload(): Promise<boolean> {
    const result = await this.file.reload((content) => this.parse(content));
    return applyReload(result, 'Mapping Context', this.log, (context) => { this.context = context; });
  }

  public getFileUri(): vscode.Uri {
    return this.fileUri;
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
    return this.save(withMappingUpserted(this.context, mapping));
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
    const { toSave, archivePrevious } = nextMappingContextRevision(previous, context);
    if (archivePrevious && previous) {
      await this.archive(previous);
    }
    await this.file.write(this.serialize(toSave));
    this.context = toSave;
    this.log(`Saved Mapping Context spec-v${toSave.specVersion} rev${toSave.version} (${toSave.mappings.length} mapping(s)).`);
    return this.getContext()!;
  }

  private async archive(previous: MappingContext): Promise<void> {
    const historyDir = vscode.Uri.joinPath(this.contextDir, 'history');
    await vscode.workspace.fs.createDirectory(historyDir);
    const target = vscode.Uri.joinPath(historyDir, mappingContextHistoryName(previous));
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
    return serializeMappingContext(context);
  }

  private parse(content: string): MappingContext {
    return parseMappingContext(content);
  }
}
