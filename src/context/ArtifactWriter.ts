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
 * configurable folder (default `auto-de/`), organized by workflow phase.
 * Writes are atomic (temp file → rename).
 */
export class ArtifactWriter {
  public constructor(
    private readonly workspaceUri: vscode.Uri,
    private readonly log: (msg: string) => void
  ) {}

  public async write(artifact: GeneratedArtifact): Promise<vscode.Uri> {
    const phaseDir = artifact.phase ? PHASE_DIRS[artifact.phase] : '00-uncategorized';
    const relativePath = this.resolveRelativePath(artifact);
    const segments = relativePath.split(/[\\/]+/).filter(Boolean);
    const fileName = segments.pop() || this.defaultFileName(artifact);

    const dirUri = vscode.Uri.joinPath(this.getArtifactDirectory(), phaseDir, ...segments);
    const targetUri = vscode.Uri.joinPath(dirUri, fileName);
    const tempUri = vscode.Uri.joinPath(dirUri, `.${fileName}.tmp.${Date.now()}`);

    await vscode.workspace.fs.createDirectory(dirUri);
    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(artifact.content, 'utf8'));
    await vscode.workspace.fs.rename(tempUri, targetUri, { overwrite: true });

    this.log(`Artifact written: ${phaseDir}/${[...segments, fileName].join('/')}`);
    return targetUri;
  }

  public async writeAll(artifacts: GeneratedArtifact[]): Promise<vscode.Uri[]> {
    const written: vscode.Uri[] = [];
    for (const artifact of artifacts) {
      written.push(await this.write(artifact));
    }
    return written;
  }

  public getArtifactDirectory(): vscode.Uri {
    const configured = vscode.workspace
      .getConfiguration('autoDataEngineeringHub')
      .get<string>('artifactDirectory', 'auto-de');
    const safe = (configured || 'auto-de').replace(/^[\\/]+|[\\/]+$/g, '') || 'auto-de';
    return vscode.Uri.joinPath(this.workspaceUri, safe);
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
