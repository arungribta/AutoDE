import * as vscode from 'vscode';
import { TargetContext } from '../engine/types';
import { parseYaml, stringifyYaml } from '../engine/context/Yaml';
import { ContextStore, RevisionedFile, applyReload } from '../engine/context/contextStore';
import { createVscodeFileIo } from './vscodeFileIo';

/**
 * Manages the reviewed, approved Target Context for the current spec version.
 * Persists to `<contextRoot>/context/target-context.yaml` with atomic writes —
 * a single *current* record, but with real content-revision history: revising
 * an already-approved record bumps `version` and archives the predecessor to
 * `context/history/` (v0.19.0, mirrors `PipelineSpecManager`/`SourceContextManager`
 * exactly), tied to `specId`/`specVersion` for staleness detection.
 *
 * `contextRoot` is a business problem's own folder (v0.12.0) — deliberately
 * distinct from the *shared* `.autode/knowledge/business-context.yaml` /
 * `verified-queries.yaml` (registered-source-derived, global across business
 * problems). Also distinct from `TargetConfigManager`
 * (`.autode/config/target-environment.yaml`), which remains a generic,
 * user-editable dev/staging/prod tool-preference profile. This is the
 * spec-tied, gating record built through the Target Context Q&A and required
 * before a plan can be generated (requirements.md §8.10).
 */
export class TargetContextManager implements vscode.Disposable {
  private context: TargetContext | undefined;
  private readonly contextDir: vscode.Uri;
  private readonly fileUri: vscode.Uri;
  private readonly file: RevisionedFile;

  constructor(
    private readonly contextRoot: vscode.Uri,
    private readonly log: (msg: string) => void
  ) {
    this.contextDir = vscode.Uri.joinPath(contextRoot, 'context');
    this.fileUri = vscode.Uri.joinPath(this.contextDir, 'target-context.yaml');
    this.file = new RevisionedFile(new ContextStore(createVscodeFileIo(vscode)), this.fileUri.fsPath, 'Target Context');
  }

  public dispose(): void {}

  public async initialize(): Promise<void> {
    try {
      const content = await this.file.read();
      if (content === undefined) throw new Error('absent');
      this.context = this.parse(content);
      this.log(`Loaded Target Context for ${this.context.specId} v${this.context.specVersion} (${this.context.status}).`);
    } catch {
      this.context = undefined;
      this.log('No Target Context yet.');
    }
  }

  /** Re-reads the file after an external change (v0.25.0). Returns true when the loaded record changed. */
  public async reload(): Promise<boolean> {
    const result = await this.file.reload((content) => this.parse(content));
    return applyReload(result, 'Target Context', this.log, (context) => { this.context = context; });
  }

  public getFileUri(): vscode.Uri {
    return this.fileUri;
  }

  public getContext(): TargetContext | undefined {
    return this.context ? { ...this.context, answers: { ...this.context.answers } } : undefined;
  }

  /** Starts (or resets) a pending Target Context for a spec version, discarding any prior answers. */
  public async reset(specId: string, specVersion: number): Promise<TargetContext> {
    const context: TargetContext = { specId, specVersion, status: 'pending', answers: {} };
    await this.save(context);
    return this.getContext()!;
  }

  /**
   * Content-revision versioning, mirroring `SourceContextManager.save()`/
   * `PipelineSpecManager`'s exact pattern: revising an already-*approved*
   * predecessor of the same spec lineage bumps `version` and archives the
   * predecessor; approving a not-yet-approved record never bumps. A different
   * spec lineage (a new `specId`/`specVersion`) starts fresh at `version: 1`,
   * but an approved predecessor being replaced is still archived first.
   */
  public async save(context: TargetContext): Promise<TargetContext> {
    const previous = this.context;
    const sameLineage = !!previous && previous.specId === context.specId && previous.specVersion === context.specVersion;
    const previousWasApproved = previous?.status === 'approved';
    const version = sameLineage
      ? (previousWasApproved ? (previous!.version ?? 1) + 1 : (previous!.version ?? 1))
      : (context.version ?? 1);
    if (previousWasApproved) {
      await this.archive(previous!);
    }
    const toSave: TargetContext = { ...context, version };
    await this.file.write(this.serialize(toSave));
    this.context = toSave;
    this.log(`Saved Target Context spec-v${toSave.specVersion} rev${toSave.version} (${toSave.status}).`);
    return this.getContext()!;
  }

  /** Archives an about-to-be-replaced, already-approved revision — idempotent, mirrors `PipelineSpecManager`'s `archive()`. */
  private async archive(previous: TargetContext): Promise<void> {
    const historyDir = vscode.Uri.joinPath(this.contextDir, 'history');
    await vscode.workspace.fs.createDirectory(historyDir);
    const target = vscode.Uri.joinPath(historyDir, `target-context.spec${previous.specVersion}.v${previous.version ?? 1}.yaml`);
    try {
      await vscode.workspace.fs.stat(target);
      return; // already archived
    } catch {
      // not present yet — write it
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(this.serialize(previous), 'utf8'));
    this.log(`Archived Target Context spec-v${previous.specVersion} rev${previous.version ?? 1} → context/history/`);
  }

  /** True once a Target Context exists, matches the given spec version, and is approved. */
  public isApprovedFor(specId: string, specVersion: number): boolean {
    return !!this.context && this.context.specId === specId && this.context.specVersion === specVersion && this.context.status === 'approved';
  }

  private serialize(context: TargetContext): string {
    return '# AutoDE Target Context\n' + stringifyYaml(context as unknown as Record<string, unknown>);
  }

  private parse(content: string): TargetContext {
    const raw = parseYaml(content);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid target-context YAML: root must be an object.');
    }
    const doc = raw as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    return {
      specId: str(doc.specId),
      specVersion: typeof doc.specVersion === 'number' ? doc.specVersion : 1,
      version: typeof doc.version === 'number' ? doc.version : 1,
      status: (str(doc.status) as TargetContext['status']) || 'pending',
      platform: (str(doc.platform) as TargetContext['platform']) || undefined,
      environmentProfile: (str(doc.environmentProfile) as TargetContext['environmentProfile']) || undefined,
      modelingApproach: (str(doc.modelingApproach) as TargetContext['modelingApproach']) || undefined,
      namingConvention: (str(doc.namingConvention) as TargetContext['namingConvention']) || undefined,
      transformationTool: (str(doc.transformationTool) as TargetContext['transformationTool']) || undefined,
      orchestrationTool: (str(doc.orchestrationTool) as TargetContext['orchestrationTool']) || undefined,
      outputFormats: Array.isArray(doc.outputFormats) ? doc.outputFormats as TargetContext['outputFormats'] : undefined,
      platformConfig: (doc.platformConfig && typeof doc.platformConfig === 'object') ? doc.platformConfig as Record<string, string> : undefined,
      credentialRef: (doc.credentialRef && typeof doc.credentialRef === 'object') ? doc.credentialRef as TargetContext['credentialRef'] : undefined,
      answers: (doc.answers && typeof doc.answers === 'object') ? doc.answers as Record<string, string> : {},
      builtAt: str(doc.builtAt) || undefined,
      approvedAt: str(doc.approvedAt) || undefined
    };
  }
}
