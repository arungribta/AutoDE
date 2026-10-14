import * as vscode from 'vscode';
import { SemanticLayerSnapshot, ContextStatus } from '../core/types';
import { GraphManager } from './GraphManager';
import { parseYaml, stringifyYaml } from './Yaml';
import { RevisionedFile, applyReload } from './RevisionedFile';

/**
 * Manages the Unified Semantic Layer snapshot — Step 6's second piece,
 * per the architecture review's Q3. The semantic layer itself is NOT a
 * second modeling system: it's the one already-unified `GraphManager` graph
 * (source and target nodes coexist via `Origin.environment` tagging). This
 * manager just captures an explicit, spec-pinned, versioned point-in-time
 * snapshot of that graph's content — generated only on an explicit "Build"
 * action, never automatically — so an approved artifact can be traced back
 * to exactly the graph state it was generated against, even after the live
 * graph keeps evolving. Metadata persists to
 * `<contextRoot>/context/semantic-layer.yaml`; the captured graph content
 * itself persists to `<contextRoot>/context/semantic-layer.snapshot.json`,
 * both archived together on revision, mirroring `MappingContextManager`'s
 * exact versioning contract.
 */
export class SemanticLayerManager implements vscode.Disposable {
  private snapshot: SemanticLayerSnapshot | undefined;
  private readonly contextDir: vscode.Uri;
  private readonly metaFileUri: vscode.Uri;
  private readonly graphFileUri: vscode.Uri;
  private readonly file: RevisionedFile;

  constructor(
    private readonly contextRoot: vscode.Uri,
    private readonly graphManager: GraphManager,
    private readonly log: (msg: string) => void
  ) {
    this.contextDir = vscode.Uri.joinPath(contextRoot, 'context');
    this.file = new RevisionedFile(vscode, this.contextDir, 'semantic-layer.yaml', 'Unified Semantic Layer snapshot');
    this.metaFileUri = this.file.getUri();
    this.graphFileUri = vscode.Uri.joinPath(this.contextDir, 'semantic-layer.snapshot.json');
  }

  public dispose(): void {}

  public async initialize(): Promise<void> {
    try {
      const content = await this.file.read();
      if (content === undefined) throw new Error('absent');
      this.snapshot = this.parse(content);
      this.log(`Loaded Unified Semantic Layer snapshot for ${this.snapshot.specId} v${this.snapshot.specVersion} (${this.snapshot.nodeCount} node(s), ${this.snapshot.edgeCount} edge(s)).`);
    } catch {
      this.snapshot = undefined;
      this.log('No Unified Semantic Layer snapshot yet.');
    }
  }

  /** Re-reads the metadata file after an external change (v0.25.0). Returns true when the loaded snapshot changed. */
  public async reload(): Promise<boolean> {
    const result = await this.file.reload((content) => this.parse(content));
    return applyReload(result, 'Unified Semantic Layer snapshot', this.log, (snapshot) => { this.snapshot = snapshot; });
  }

  public getFileUri(): vscode.Uri {
    return this.metaFileUri;
  }

  public getSnapshot(): SemanticLayerSnapshot | undefined {
    return this.snapshot ? { ...this.snapshot } : undefined;
  }

  /** The captured graph content of the current snapshot, if any — for verification/inspection, not for driving prompts (that's still `ContextFileManager.buildContextPrompt()`). */
  public async getGraphContent(): Promise<{ nodes: unknown[]; edges: unknown[]; generatedAt: string } | undefined> {
    try {
      const content = await vscode.workspace.fs.readFile(this.graphFileUri);
      return JSON.parse(Buffer.from(content).toString('utf8'));
    } catch {
      return undefined;
    }
  }

  /**
   * Captures the live graph's current content and counts, then saves — the
   * one explicit "Build Semantic Layer" action. Never runs implicitly.
   */
  public async build(specId: string, specVersion: number): Promise<SemanticLayerSnapshot> {
    const graphSnapshot = this.graphManager.serializeSnapshot();
    await vscode.workspace.fs.createDirectory(this.contextDir);
    const tempGraphUri = vscode.Uri.joinPath(this.contextDir, `.semantic-layer.snapshot.tmp.${Date.now()}.json`);
    await vscode.workspace.fs.writeFile(tempGraphUri, Buffer.from(JSON.stringify({ nodes: graphSnapshot.nodes, edges: graphSnapshot.edges, generatedAt: graphSnapshot.generatedAt }), 'utf8'));
    await vscode.workspace.fs.rename(tempGraphUri, this.graphFileUri, { overwrite: true });

    const current = this.snapshot;
    const status: ContextStatus = current && current.specId === specId && current.specVersion === specVersion && current.status === 'approved' ? 'built' : (current?.status ?? 'pending');
    return this.save({
      specId,
      specVersion,
      status,
      nodeCount: graphSnapshot.nodes.length,
      edgeCount: graphSnapshot.edges.length,
      builtAt: new Date().toISOString()
    });
  }

  /** Same versioning contract as `MappingContextManager.save()`/`SourceContextManager.save()`. */
  public async save(snapshot: SemanticLayerSnapshot): Promise<SemanticLayerSnapshot> {
    const previous = this.snapshot;
    const sameLineage = !!previous && previous.specId === snapshot.specId && previous.specVersion === snapshot.specVersion;
    const previousWasApproved = previous?.status === 'approved';
    const version = sameLineage
      ? (previousWasApproved ? (previous!.version ?? 1) + 1 : (previous!.version ?? 1))
      : (snapshot.version ?? 1);
    if (previousWasApproved) {
      await this.archive(previous!);
    }
    const toSave: SemanticLayerSnapshot = { ...snapshot, version };
    await this.file.write(this.serialize(toSave));
    this.snapshot = toSave;
    this.log(`Saved Unified Semantic Layer snapshot spec-v${toSave.specVersion} rev${toSave.version} (${toSave.nodeCount} node(s), ${toSave.edgeCount} edge(s)).`);
    return this.getSnapshot()!;
  }

  private async archive(previous: SemanticLayerSnapshot): Promise<void> {
    const historyDir = vscode.Uri.joinPath(this.contextDir, 'history');
    await vscode.workspace.fs.createDirectory(historyDir);
    const metaTarget = vscode.Uri.joinPath(historyDir, `semantic-layer.spec${previous.specVersion}.v${previous.version ?? 1}.yaml`);
    try {
      await vscode.workspace.fs.stat(metaTarget);
      return;
    } catch {
      // not present yet — write it (and the graph content alongside it)
    }
    await vscode.workspace.fs.writeFile(metaTarget, Buffer.from(this.serialize(previous), 'utf8'));
    const graphTarget = vscode.Uri.joinPath(historyDir, `semantic-layer.spec${previous.specVersion}.v${previous.version ?? 1}.json`);
    try {
      const graphContent = await vscode.workspace.fs.readFile(this.graphFileUri);
      await vscode.workspace.fs.writeFile(graphTarget, graphContent);
    } catch {
      // no graph content had been captured yet for this revision — metadata alone is still archived
    }
    this.log(`Archived Unified Semantic Layer snapshot spec-v${previous.specVersion} rev${previous.version ?? 1} → context/history/`);
  }

  private serialize(snapshot: SemanticLayerSnapshot): string {
    return '# AutoDE Unified Semantic Layer Snapshot (metadata — graph content lives in semantic-layer.snapshot.json)\n' + stringifyYaml(snapshot as unknown as Record<string, unknown>);
  }

  private parse(content: string): SemanticLayerSnapshot {
    const raw = parseYaml(content);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid semantic-layer YAML: root must be an object.');
    }
    const doc = raw as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);
    return {
      specId: str(doc.specId),
      specVersion: num(doc.specVersion, 1),
      version: num(doc.version, 1),
      status: (str(doc.status) as ContextStatus) || 'pending',
      nodeCount: num(doc.nodeCount),
      edgeCount: num(doc.edgeCount),
      builtAt: str(doc.builtAt) || undefined,
      approvedAt: str(doc.approvedAt) || undefined
    };
  }
}
