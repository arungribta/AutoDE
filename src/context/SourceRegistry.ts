import * as vscode from 'vscode';
import { ContextLayer } from './types';
import { parseYaml, stringifyYaml } from './Yaml';

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
    const doc: Record<string, unknown> = { sources: this.sources };
    return '# AutoDE Source Registry\n# User-identified files that feed the Enterprise Context Layer.\n' + stringifyYaml(doc);
  }

  private parseYaml(content: string): RegisteredSource[] {
    const raw = parseYaml(content);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const sources = (raw as Record<string, unknown>).sources;
    if (!Array.isArray(sources)) return [];

    const result: RegisteredSource[] = [];
    for (const entry of sources) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const str = (v: unknown): string => (typeof v === 'string' ? v : '');
      const path = str(e.path);
      if (!path) continue;
      const kind = (str(e.kind) as SourceKind) || 'business_context';
      result.push({
        path,
        kind,
        layer: (str(e.layer) as ContextLayer) || KIND_TO_LAYER[kind],
        owner: str(e.owner) || undefined,
        addedAt: str(e.addedAt)
      });
    }
    return result;
  }
}
