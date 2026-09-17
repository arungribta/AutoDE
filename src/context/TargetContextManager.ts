import * as vscode from 'vscode';
import { TargetContext } from '../core/types';
import { parseYaml, stringifyYaml } from './Yaml';

/**
 * Manages the reviewed, approved Target Context for the current spec version.
 * Persists to `<contextRoot>/context/target-context.yaml` with atomic writes —
 * a single current record (no version history; it's recomputed fresh per
 * spec version, tied to `specId`/`specVersion` for staleness detection).
 *
 * `contextRoot` is a business problem's own folder (v0.12.0) — deliberately
 * distinct from the *shared* `.ai-context/context/business-context.yaml` /
 * `verified-queries.yaml` (registered-source-derived, global across business
 * problems). Also distinct from `TargetConfigManager`
 * (`.ai-context/target-environment.yaml`), which remains a generic,
 * user-editable dev/staging/prod tool-preference profile. This is the
 * spec-tied, gating record built through the Target Context Q&A and required
 * before a plan can be generated (requirements.md §8.10).
 */
export class TargetContextManager implements vscode.Disposable {
  private context: TargetContext | undefined;
  private readonly contextDir: vscode.Uri;
  private readonly fileUri: vscode.Uri;

  constructor(
    private readonly contextRoot: vscode.Uri,
    private readonly log: (msg: string) => void
  ) {
    this.contextDir = vscode.Uri.joinPath(contextRoot, 'context');
    this.fileUri = vscode.Uri.joinPath(this.contextDir, 'target-context.yaml');
  }

  public dispose(): void {}

  public async initialize(): Promise<void> {
    try {
      const content = await vscode.workspace.fs.readFile(this.fileUri);
      this.context = this.parse(Buffer.from(content).toString('utf8'));
      this.log(`Loaded Target Context for ${this.context.specId} v${this.context.specVersion} (${this.context.status}).`);
    } catch {
      this.context = undefined;
      this.log('No Target Context yet.');
    }
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

  public async save(context: TargetContext): Promise<TargetContext> {
    this.context = context;
    await vscode.workspace.fs.createDirectory(this.contextDir);
    const tempUri = vscode.Uri.joinPath(this.contextDir, `.target-context.tmp.${Date.now()}.yaml`);
    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(this.serialize(context), 'utf8'));
    await vscode.workspace.fs.rename(tempUri, this.fileUri, { overwrite: true });
    this.log(`Saved Target Context v${context.specVersion} (${context.status}).`);
    return this.getContext()!;
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
      status: (str(doc.status) as TargetContext['status']) || 'pending',
      platform: (str(doc.platform) as TargetContext['platform']) || undefined,
      environmentProfile: (str(doc.environmentProfile) as TargetContext['environmentProfile']) || undefined,
      modelingApproach: (str(doc.modelingApproach) as TargetContext['modelingApproach']) || undefined,
      namingConvention: (str(doc.namingConvention) as TargetContext['namingConvention']) || undefined,
      transformationTool: (str(doc.transformationTool) as TargetContext['transformationTool']) || undefined,
      orchestrationTool: (str(doc.orchestrationTool) as TargetContext['orchestrationTool']) || undefined,
      outputFormats: Array.isArray(doc.outputFormats) ? doc.outputFormats as TargetContext['outputFormats'] : undefined,
      platformConfig: (doc.platformConfig && typeof doc.platformConfig === 'object') ? doc.platformConfig as Record<string, string> : undefined,
      answers: (doc.answers && typeof doc.answers === 'object') ? doc.answers as Record<string, string> : {},
      builtAt: str(doc.builtAt) || undefined,
      approvedAt: str(doc.approvedAt) || undefined
    };
  }
}
