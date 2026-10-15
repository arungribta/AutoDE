import * as vscode from 'vscode';
import { SourceContext, SourceContextEntry } from '../engine/types';
import { parseYaml, stringifyYaml } from '../engine/context/Yaml';
import { ContextStore, RevisionedFile, applyReload } from '../engine/context/contextStore';
import { createVscodeFileIo } from './vscodeFileIo';

/**
 * Manages the reviewed Source Context for the current spec version —
 * `not_applicable` for Greenfield, otherwise built via a live connection
 * check or a guided description. Persists to
 * `<contextRoot>/context/source-context.yaml`, atomic writes; a single
 * *current* record, but with real content-revision history: revising an
 * already-approved record bumps `version` and archives the predecessor to
 * `context/history/` (v0.19.0, mirrors `PipelineSpecManager`/
 * `TargetContextManager` exactly). `contextRoot` is a business problem's own
 * folder (v0.12.0). See requirements.md §8.10.
 */
export class SourceContextManager implements vscode.Disposable {
  private context: SourceContext | undefined;
  private readonly contextDir: vscode.Uri;
  private readonly fileUri: vscode.Uri;
  private readonly file: RevisionedFile;

  constructor(
    private readonly contextRoot: vscode.Uri,
    private readonly log: (msg: string) => void
  ) {
    this.contextDir = vscode.Uri.joinPath(contextRoot, 'context');
    this.fileUri = vscode.Uri.joinPath(this.contextDir, 'source-context.yaml');
    this.file = new RevisionedFile(new ContextStore(createVscodeFileIo(vscode)), this.fileUri.fsPath, 'Source Context');
  }

  public dispose(): void {}

  public async initialize(): Promise<void> {
    try {
      const content = await this.file.read();
      if (content === undefined) throw new Error('absent');
      this.context = this.parse(content);
      this.log(`Loaded Source Context for ${this.context.specId} v${this.context.specVersion} (${this.context.status}).`);
    } catch {
      this.context = undefined;
      this.log('No Source Context yet.');
    }
  }

  /** Re-reads the file after an external change (v0.25.0). Returns true when the loaded record changed. */
  public async reload(): Promise<boolean> {
    const result = await this.file.reload((content) => this.parse(content));
    return applyReload(result, 'Source Context', this.log, (context) => { this.context = context; });
  }

  public getFileUri(): vscode.Uri {
    return this.fileUri;
  }

  public getContext(): SourceContext | undefined {
    return this.context ? { ...this.context, answers: { ...this.context.answers } } : undefined;
  }

  /** Resets to a fresh pending record for a spec version — used when (re)opening the source-context flow for Brownfield. */
  public async reset(specId: string, specVersion: number): Promise<SourceContext> {
    const context: SourceContext = { specId, specVersion, status: 'pending', sources: [], answers: {} };
    await this.save(context);
    return this.getContext()!;
  }

  /** Marks source context Non-Applicable for a Greenfield spec — no user action required. */
  public async markNotApplicable(specId: string, specVersion: number): Promise<SourceContext> {
    const context: SourceContext = {
      specId, specVersion, status: 'not_applicable', sources: [], answers: {},
      builtAt: new Date().toISOString(), approvedAt: new Date().toISOString()
    };
    await this.save(context);
    return this.getContext()!;
  }

  /**
   * Content-revision versioning, mirroring `PipelineSpecManager`'s exact
   * pattern (itself modeled on `SpecManager`): revising an already-*approved*
   * predecessor of the *same* spec lineage bumps `version` and archives the
   * predecessor; approving a not-yet-approved record never bumps ("a draft v1
   * becomes an approved v1"). Moving to a *different* spec lineage (a new
   * `specId`/`specVersion` — see `reset()`) starts a fresh `version: 1` for
   * that lineage, but an approved predecessor being replaced is still
   * archived first rather than silently discarded, even across lineages.
   */
  public async save(context: SourceContext): Promise<SourceContext> {
    const previous = this.context;
    const sameLineage = !!previous && previous.specId === context.specId && previous.specVersion === context.specVersion;
    const previousWasApproved = previous?.status === 'approved';
    const version = sameLineage
      ? (previousWasApproved ? (previous!.version ?? 1) + 1 : (previous!.version ?? 1))
      : (context.version ?? 1);
    if (previousWasApproved) {
      await this.archive(previous!);
    }
    const toSave: SourceContext = { ...context, version };
    await this.file.write(this.serialize(toSave));
    this.context = toSave;
    this.log(`Saved Source Context spec-v${toSave.specVersion} rev${toSave.version} (${toSave.status}).`);
    return this.getContext()!;
  }

  /** Archives an about-to-be-replaced, already-approved revision — idempotent, mirrors `PipelineSpecManager`'s `archive()`. */
  private async archive(previous: SourceContext): Promise<void> {
    const historyDir = vscode.Uri.joinPath(this.contextDir, 'history');
    await vscode.workspace.fs.createDirectory(historyDir);
    const target = vscode.Uri.joinPath(historyDir, `source-context.spec${previous.specVersion}.v${previous.version ?? 1}.yaml`);
    try {
      await vscode.workspace.fs.stat(target);
      return; // already archived
    } catch {
      // not present yet — write it
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(this.serialize(previous), 'utf8'));
    this.log(`Archived Source Context spec-v${previous.specVersion} rev${previous.version ?? 1} → context/history/`);
  }

  /** True once ready to gate Generate Plan: either approved, or Not Applicable. */
  public isReadyFor(specId: string, specVersion: number): boolean {
    if (!this.context || this.context.specId !== specId || this.context.specVersion !== specVersion) return false;
    return this.context.status === 'approved' || this.context.status === 'not_applicable';
  }

  private serialize(context: SourceContext): string {
    return '# AutoDE Source Context\n' + stringifyYaml(context as unknown as Record<string, unknown>);
  }

  private parse(content: string): SourceContext {
    const raw = parseYaml(content);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid source-context YAML: root must be an object.');
    }
    const doc = raw as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');

    const parseEntry = (e: unknown): SourceContextEntry | undefined => {
      if (!e || typeof e !== 'object') return undefined;
      const rec = e as Record<string, unknown>;
      const connSummary = rec.connectionSummary as Record<string, unknown> | undefined;
      const fileSummary = rec.fileSummary as Record<string, unknown> | undefined;
      return {
        connectionId: str(rec.connectionId),
        platform: (str(rec.platform) as SourceContextEntry['platform']) || undefined,
        method: (str(rec.method) as SourceContextEntry['method']) || 'described',
        sourceType: (str(rec.sourceType) as SourceContextEntry['sourceType']) || undefined,
        description: str(rec.description) || undefined,
        connectionSummary: connSummary ? {
          database: str(connSummary.database),
          schema: str(connSummary.schema),
          tableCount: typeof connSummary.tableCount === 'number' ? connSummary.tableCount : 0,
          viewCount: typeof connSummary.viewCount === 'number' ? connSummary.viewCount : 0
        } : undefined,
        fileSummary: fileSummary ? {
          fileName: str(fileSummary.fileName),
          format: (str(fileSummary.format) as 'csv' | 'json' | 'ddl') || 'csv',
          tableCount: typeof fileSummary.tableCount === 'number' ? fileSummary.tableCount : 0,
          columnCount: typeof fileSummary.columnCount === 'number' ? fileSummary.columnCount : 0
        } : undefined,
        extractedAt: str(rec.extractedAt) || undefined
      };
    };

    // Legacy single-record shape (pre-v0.19.0: method/sourceType/description/
    // connectionSummary directly on the document) — migrated into a one-entry
    // `sources` list on read, so an older workspace's file keeps working.
    const sources: SourceContextEntry[] = Array.isArray(doc.sources)
      ? doc.sources.map(parseEntry).filter((e): e is SourceContextEntry => !!e)
      : (doc.method || doc.connectionSummary || doc.sourceType || doc.description)
        ? [{
            connectionId: str((doc.connectionSummary as Record<string, unknown> | undefined)?.platform) || 'legacy',
            platform: (str((doc.connectionSummary as Record<string, unknown> | undefined)?.platform) as SourceContextEntry['platform']) || undefined,
            method: (str(doc.method) as SourceContextEntry['method']) || 'described',
            sourceType: (str(doc.sourceType) as SourceContextEntry['sourceType']) || undefined,
            description: str(doc.description) || undefined,
            connectionSummary: doc.connectionSummary ? (() => {
              const cs = doc.connectionSummary as Record<string, unknown>;
              return { database: str(cs.database), schema: str(cs.schema), tableCount: typeof cs.tableCount === 'number' ? cs.tableCount : 0, viewCount: typeof cs.viewCount === 'number' ? cs.viewCount : 0 };
            })() : undefined
          }]
        : [];

    return {
      specId: str(doc.specId),
      specVersion: typeof doc.specVersion === 'number' ? doc.specVersion : 1,
      version: typeof doc.version === 'number' ? doc.version : 1,
      status: (str(doc.status) as SourceContext['status']) || 'pending',
      sources,
      answers: (doc.answers && typeof doc.answers === 'object') ? doc.answers as Record<string, string> : {},
      builtAt: str(doc.builtAt) || undefined,
      approvedAt: str(doc.approvedAt) || undefined
    };
  }
}
