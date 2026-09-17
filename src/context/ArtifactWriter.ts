import * as vscode from 'vscode';
import { GeneratedArtifact, WorkflowPhase } from '../core/types';

const PHASE_DIRS: Record<WorkflowPhase, string> = {
  discover: '01-discover',
  model: '02-model',
  build: '03-build',
  validate: '04-validate'
};

/**
 * Persists generated artifacts into the user's repository under a visible,
 * configurable folder (default `artifacts/`, resolved beneath the active
 * business problem's own folder — v0.12.0), organized by workflow phase.
 * Writes are atomic (temp file → rename).
 */
export class ArtifactWriter {
  public constructor(
    private readonly contextRoot: vscode.Uri,
    private readonly log: (msg: string) => void
  ) {}

  public async write(artifact: GeneratedArtifact): Promise<vscode.Uri> {
    const phaseDir = artifact.phase ? PHASE_DIRS[artifact.phase] : '00-uncategorized';
    const relativePath = this.resolveRelativePath(artifact);
    const segments = relativePath.split(/[\\/]+/).filter(Boolean);
    const fileName = segments.pop() || this.defaultFileName(artifact);
    // A spec-tagged subfolder (not a filename prefix) so multi-file artifacts —
    // e.g. a dbt project's `dbt_project.yml` — keep the exact filenames external
    // tooling expects, while still recording which spec revision produced them
    // (needed for stale-artifact detection: PlanState.artifacts is in-memory only
    // and doesn't survive a reload, so the filesystem path is the only durable
    // record of specId/specVersion).
    const versionTag = ArtifactWriter.specTag(artifact);

    const dirUri = versionTag
      ? vscode.Uri.joinPath(this.getArtifactDirectory(), phaseDir, versionTag, ...segments)
      : vscode.Uri.joinPath(this.getArtifactDirectory(), phaseDir, ...segments);
    const targetUri = vscode.Uri.joinPath(dirUri, fileName);
    const tempUri = vscode.Uri.joinPath(dirUri, `.${fileName}.tmp.${Date.now()}`);

    await vscode.workspace.fs.createDirectory(dirUri);
    await this.archiveExisting(dirUri, fileName);
    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(artifact.content, 'utf8'));
    await vscode.workspace.fs.rename(tempUri, targetUri, { overwrite: true });

    const loggedPath = [phaseDir, versionTag, ...segments, fileName].filter(Boolean).join('/');
    this.log(`Artifact written: ${loggedPath}`);
    return targetUri;
  }

  /**
   * Archives whatever currently sits at `<dirUri>/<fileName>` to a `history/`
   * subfolder before it's overwritten, so re-running a step within the same
   * spec version doesn't silently discard the previous artifact — each rerun
   * within a `<specId>.v<version>` folder now keeps every prior copy, not just
   * the folder-level tag across spec versions.
   */
  private async archiveExisting(dirUri: vscode.Uri, fileName: string): Promise<void> {
    const existingUri = vscode.Uri.joinPath(dirUri, fileName);
    let existing: Uint8Array;
    try {
      existing = await vscode.workspace.fs.readFile(existingUri);
    } catch {
      return; // nothing to archive yet
    }
    const historyDir = vscode.Uri.joinPath(dirUri, 'history');
    await vscode.workspace.fs.createDirectory(historyDir);
    const archivedName = `${Date.now()}.${fileName}`;
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(historyDir, archivedName), existing);
    this.log(`Archived previous artifact revision: history/${archivedName}`);
  }

  /** The `<specId>.v<version>` folder name an artifact is written under, or `undefined` when it carries no spec stamp. */
  public static specTag(artifact: Pick<GeneratedArtifact, 'specId' | 'specVersion'>): string | undefined {
    return artifact.specId ? `${artifact.specId}.v${artifact.specVersion ?? 1}` : undefined;
  }

  public async writeAll(artifacts: GeneratedArtifact[]): Promise<vscode.Uri[]> {
    const written: vscode.Uri[] = [];
    for (const artifact of artifacts) {
      written.push(await this.write(artifact));
    }
    return written;
  }

  public getArtifactDirectory(): vscode.Uri {
    return ArtifactWriter.resolveArtifactDirectory(this.contextRoot);
  }

  /**
   * Resolves the configured artifact root beneath a business problem's
   * context root. Exposed statically so callers that do not own an
   * ArtifactWriter instance (e.g. the webview provider's "open artifacts
   * folder" action) resolve the same location without duplicating the
   * configuration logic.
   */
  public static resolveArtifactDirectory(contextRoot: vscode.Uri): vscode.Uri {
    const configured = vscode.workspace
      .getConfiguration('autoDataEngineeringHub')
      .get<string>('artifactDirectory', 'artifacts');
    const safe = (configured || 'artifacts').replace(/^[\\/]+|[\\/]+$/g, '') || 'artifacts';
    return vscode.Uri.joinPath(contextRoot, safe);
  }

  private resolveRelativePath(artifact: GeneratedArtifact): string {
    if (artifact.filePath && artifact.filePath.trim().length > 0) {
      return artifact.filePath;
    }
    return this.defaultFileName(artifact);
  }

  private defaultFileName(artifact: GeneratedArtifact): string {
    const ext = this.extensionFor(artifact.language);
    const base = (artifact.title || artifact.id || 'artifact')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return `${base || 'artifact'}${ext}`;
  }

  private extensionFor(language: GeneratedArtifact['language']): string {
    switch (language) {
      case 'sql': return '.sql';
      case 'yaml': return '.yaml';
      case 'markdown': return '.md';
      case 'python': return '.py';
      case 'json': return '.json';
      default: return '.txt';
    }
  }
}
