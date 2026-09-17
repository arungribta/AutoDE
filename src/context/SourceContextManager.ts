import * as vscode from 'vscode';
import { SourceContext } from '../core/types';
import { parseYaml, stringifyYaml } from './Yaml';

/**
 * Manages the reviewed Source Context for the current spec version —
 * `not_applicable` for Greenfield, otherwise built via a live connection
 * check or a guided description. Persists to
 * `<contextRoot>/context/source-context.yaml`, atomic writes, single current
 * record (mirrors `TargetContextManager`). `contextRoot` is a business
 * problem's own folder (v0.12.0). See requirements.md §8.10.
 */
export class SourceContextManager implements vscode.Disposable {
  private context: SourceContext | undefined;
  private readonly contextDir: vscode.Uri;
  private readonly fileUri: vscode.Uri;

  constructor(
    private readonly contextRoot: vscode.Uri,
    private readonly log: (msg: string) => void
  ) {
    this.contextDir = vscode.Uri.joinPath(contextRoot, 'context');
    this.fileUri = vscode.Uri.joinPath(this.contextDir, 'source-context.yaml');
  }

  public dispose(): void {}

  public async initialize(): Promise<void> {
    try {
      const content = await vscode.workspace.fs.readFile(this.fileUri);
      this.context = this.parse(Buffer.from(content).toString('utf8'));
      this.log(`Loaded Source Context for ${this.context.specId} v${this.context.specVersion} (${this.context.status}).`);
    } catch {
      this.context = undefined;
      this.log('No Source Context yet.');
    }
  }

  public getContext(): SourceContext | undefined {
    return this.context ? { ...this.context, answers: { ...this.context.answers } } : undefined;
  }

  /** Resets to a fresh pending record for a spec version — used when (re)opening the source-context flow for Brownfield. */
  public async reset(specId: string, specVersion: number): Promise<SourceContext> {
    const context: SourceContext = { specId, specVersion, status: 'pending', answers: {} };
    await this.save(context);
    return this.getContext()!;
  }

  /** Marks source context Non-Applicable for a Greenfield spec — no user action required. */
  public async markNotApplicable(specId: string, specVersion: number): Promise<SourceContext> {
    const context: SourceContext = {
      specId, specVersion, status: 'not_applicable', answers: {},
      builtAt: new Date().toISOString(), approvedAt: new Date().toISOString()
    };
    await this.save(context);
    return this.getContext()!;
  }

  public async save(context: SourceContext): Promise<SourceContext> {
    this.context = context;
    await vscode.workspace.fs.createDirectory(this.contextDir);
    const tempUri = vscode.Uri.joinPath(this.contextDir, `.source-context.tmp.${Date.now()}.yaml`);
    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(this.serialize(context), 'utf8'));
    await vscode.workspace.fs.rename(tempUri, this.fileUri, { overwrite: true });
    this.log(`Saved Source Context v${context.specVersion} (${context.status}).`);
    return this.getContext()!;
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
    const connSummary = doc.connectionSummary as Record<string, unknown> | undefined;
    return {
      specId: str(doc.specId),
      specVersion: typeof doc.specVersion === 'number' ? doc.specVersion : 1,
      status: (str(doc.status) as SourceContext['status']) || 'pending',
      method: (str(doc.method) as SourceContext['method']) || undefined,
      sourceType: (str(doc.sourceType) as SourceContext['sourceType']) || undefined,
      description: str(doc.description) || undefined,
      connectionSummary: connSummary ? {
        platform: str(connSummary.platform),
        database: str(connSummary.database),
        schema: str(connSummary.schema),
        tableCount: typeof connSummary.tableCount === 'number' ? connSummary.tableCount : 0,
        viewCount: typeof connSummary.viewCount === 'number' ? connSummary.viewCount : 0
      } : undefined,
      answers: (doc.answers && typeof doc.answers === 'object') ? doc.answers as Record<string, string> : {},
      builtAt: str(doc.builtAt) || undefined,
      approvedAt: str(doc.approvedAt) || undefined
    };
  }
}
