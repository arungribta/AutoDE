import * as vscode from 'vscode';
import { ContextLayer } from './types';

export type SourceKind = 'business_context' | 'verified_queries' | 'data_definitions';

export interface RegisteredSource {
  path: string;
  kind: SourceKind;
  layer: ContextLayer;
  owner?: string;
  addedAt: string;
}

const KIND_TO_LAYER: Record<SourceKind, ContextLayer> = {
  business_context: 'definition',
  verified_queries: 'query',
  data_definitions: 'system'
};

/**
 * Registry of user-identified context source files.
 * Persists to `.ai-context/sources.yaml` (path → {kind, layer, owner}).
 */
export class SourceRegistry implements vscode.Disposable {
  private sources: RegisteredSource[] = [];
  private readonly registryUri: vscode.Uri;
  private readonly contextDir: vscode.Uri;

  constructor(
    private readonly workspaceUri: vscode.Uri,
    private readonly log: (msg: string) => void
  ) {
    this.contextDir = vscode.Uri.joinPath(workspaceUri, '.ai-context');
    this.registryUri = vscode.Uri.joinPath(this.contextDir, 'sources.yaml');
  }

  public dispose(): void {
    // No watchers/handles held.
  }

  public async initialize(): Promise<void> {
    try {
      const content = await vscode.workspace.fs.readFile(this.registryUri);
      this.sources = this.parseYaml(Buffer.from(content).toString('utf8'));
      this.log(`Loaded source registry: ${this.sources.length} source(s)`);
    } catch {
      this.sources = [];
      await this.persist();
      this.log('Initialized empty source registry.');
    }
  }

  public getSources(): RegisteredSource[] {
    return [...this.sources];
  }

  public async addSource(path: string, kind: SourceKind, owner?: string): Promise<RegisteredSource> {
    const existing = this.sources.find((s) => s.path === path);
    if (existing) {
      existing.kind = kind;
      existing.layer = KIND_TO_LAYER[kind];
      if (owner) existing.owner = owner;
      await this.persist();
      return existing;
    }

    const entry: RegisteredSource = {
      path,
      kind,
      layer: KIND_TO_LAYER[kind],
      owner,
      addedAt: new Date().toISOString()
    };
    this.sources.push(entry);
    await this.persist();
    return entry;
  }

  public async removeSource(path: string): Promise<void> {
    this.sources = this.sources.filter((s) => s.path !== path);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const tempUri = vscode.Uri.joinPath(this.contextDir, `.sources.tmp.${Date.now()}.yaml`);
    await vscode.workspace.fs.createDirectory(this.contextDir);
    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(this.serialize(), 'utf8'));
    await vscode.workspace.fs.rename(tempUri, this.registryUri, { overwrite: true });
  }

  private serialize(): string {
    const lines = ['# AutoDE Source Registry', '# User-identified files that feed the Enterprise Context Layer.', 'sources:'];
    for (const s of this.sources) {
      lines.push(`  - path: ${s.path}`);
      lines.push(`    kind: ${s.kind}`);
      lines.push(`    layer: ${s.layer}`);
      if (s.owner) lines.push(`    owner: ${s.owner}`);
      lines.push(`    addedAt: ${s.addedAt}`);
    }
    return lines.join('\n') + '\n';
  }

  private parseYaml(content: string): RegisteredSource[] {
    const result: RegisteredSource[] = [];
    let current: Partial<RegisteredSource> | null = null;

    const flush = () => {
      if (current && current.path) {
        result.push(current as RegisteredSource);
      }
      current = null;
    };

    for (const line of content.split(/\r?\n/)) {
      const pathMatch = line.match(/^\s+-\s+path:\s*(.+)$/);
      if (pathMatch) {
        flush();
        current = { path: pathMatch[1].trim(), kind: 'business_context', layer: 'definition', addedAt: '' };
        continue;
      }
      if (current) {
        const kindMatch = line.match(/^\s+kind:\s*(.+)$/);
        if (kindMatch) {
          current.kind = kindMatch[1].trim() as SourceKind;
          current.layer = KIND_TO_LAYER[current.kind] ?? 'definition';
          continue;
        }
        const layerMatch = line.match(/^\s+layer:\s*(.+)$/);
        if (layerMatch) { current.layer = layerMatch[1].trim() as ContextLayer; continue; }
        const ownerMatch = line.match(/^\s+owner:\s*(.+)$/);
        if (ownerMatch) { current.owner = ownerMatch[1].trim(); continue; }
        const addedAtMatch = line.match(/^\s+addedAt:\s*(.+)$/);
        if (addedAtMatch) { current.addedAt = addedAtMatch[1].trim(); continue; }
      }
    }
    flush();
    return result;
  }
}
