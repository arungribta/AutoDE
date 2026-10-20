import { BaseNode, GraphEdge, RetrievalOptions, SubgraphResult, ContextEngineDiagnostics } from './types';
import { expandNeighborhood } from './retrieval';

/**
 * Thread-safe in-memory Graph Manager.
 * - Keeps node and edge maps
 * - Provides lookup indexes for FQN, label, and node type
 * - Provides neighborhood traversal with relevance scoring (decay)
 * - Provides serialization for worker transfer
 */
/** The in-memory context graph (moved into the engine in v0.43.2 so the CLI and MCP server load an estate with the same code). */
export class GraphManager {
  private nodes: Map<string, BaseNode> = new Map();
  private edges: Map<string, GraphEdge> = new Map();

  // Indexes
  private fqnIndex: Map<string, string> = new Map(); // fqn -> nodeId
  private labelIndex: Map<string, Set<string>> = new Map(); // label -> set(nodeId)
  private typeIndex: Map<string, Set<string>> = new Map(); // type -> set(nodeId)

  // Simple mutex to serialize mutation operations
  private mutex: Promise<void> = Promise.resolve();

  private lastIndexedAt: Date | null = null;
  /** Re-keyed ids (old → current, Phase K1): lookups by an old id still find the object. */
  private aliases: ReadonlyMap<string, string> = new Map();

  constructor() {}

  // Disposable
  public dispose(): void {
    this.clear();
  }

  // Acquire simple mutex
  private async lock<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.mutex.then(() => fn());
    // chain so next callers wait
    this.mutex = p.then(() => undefined).catch(() => undefined);
    return p;
  }

  public async addNode(node: BaseNode): Promise<void> {
    await this.lock(async () => {
      this.nodes.set(node.id, node);
      // index by label
      const label = (node.label || '').toLowerCase();
      if (!this.labelIndex.has(label)) this.labelIndex.set(label, new Set());
      this.labelIndex.get(label)!.add(node.id);
      // index by type
      if (!this.typeIndex.has(node.type)) this.typeIndex.set(node.type, new Set());
      this.typeIndex.get(node.type)!.add(node.id);
      // index fqn if available
      const anyNode = node as any;
      if (anyNode.fqn && typeof anyNode.fqn === 'string') {
        this.fqnIndex.set(String(anyNode.fqn).toLowerCase(), node.id);
      }
      this.lastIndexedAt = new Date();
    });
  }

  public async addEdge(edge: GraphEdge): Promise<void> {
    await this.lock(async () => {
      this.edges.set(edge.id, edge);
      this.lastIndexedAt = new Date();
    });
  }

  /**
   * Removes every node (and any edge touching one) whose `origin.sourceRef`
   * matches — used to replace previously-derived content (e.g. a prior spec
   * version's synthesized nodes) before re-synthesizing from the current one,
   * rather than accumulating stale nodes across revisions.
   */
  public async removeNodesBySourceRef(sourceRef: string): Promise<void> {
    await this.removeNodesWhere((node) => node.origin?.sourceRef === sourceRef);
  }

  /** Removes every node matching `predicate`, and any edge touching one. */
  public async removeNodesWhere(predicate: (node: BaseNode) => boolean): Promise<void> {
    await this.lock(async () => {
      const idsToRemove: string[] = [];
      for (const [id, node] of this.nodes.entries()) {
        if (predicate(node)) idsToRemove.push(id);
      }
      for (const id of idsToRemove) {
        this.nodes.delete(id);
        for (const [label, set] of this.labelIndex.entries()) {
          set.delete(id);
          if (set.size === 0) this.labelIndex.delete(label);
        }
        for (const [type, set] of this.typeIndex.entries()) {
          set.delete(id);
          if (set.size === 0) this.typeIndex.delete(type);
        }
        for (const [fqn, fqnId] of this.fqnIndex.entries()) {
          if (fqnId === id) this.fqnIndex.delete(fqn);
        }
      }
      if (idsToRemove.length > 0) {
        const removeIds = new Set(idsToRemove);
        for (const [edgeId, edge] of this.edges.entries()) {
          if (removeIds.has(edge.source) || removeIds.has(edge.target)) this.edges.delete(edgeId);
        }
        this.lastIndexedAt = new Date();
      }
    });
  }

  public getNodeById(id: string): BaseNode | undefined {
    return this.nodes.get(id) ?? this.nodes.get(this.aliases.get(id) ?? '');
  }

  public setAliases(aliases: ReadonlyMap<string, string>): void {
    this.aliases = aliases;
  }

  public findByFqn(fqn: string): BaseNode | undefined {
    const id = this.fqnIndex.get(fqn.toLowerCase());
    return id ? this.nodes.get(id) : undefined;
  }

  public findByLabel(label: string): BaseNode[] {
    const set = this.labelIndex.get(label.toLowerCase());
    if (!set) return [];
    return Array.from(set).map((id) => this.nodes.get(id)!).filter(Boolean);
  }

  public getNodesByType(type: string): BaseNode[] {
    const set = this.typeIndex.get(type);
    if (!set) return [];
    return Array.from(set).map((id) => this.nodes.get(id)!).filter(Boolean);
  }

  public getDiagnostics(): ContextEngineDiagnostics {
    const memMB = this.estimateMemoryMB();
    return {
      totalNodes: this.nodes.size,
      totalEdges: this.edges.size,
      memoryUsageMB: memMB,
      isWorkerReady: true,
      lastIndexedAt: this.lastIndexedAt
    };
  }

  private estimateMemoryMB(): number {
    // naive estimation: sum of JSON lengths
    let total = 0;
    for (const n of this.nodes.values()) total += JSON.stringify(n).length;
    for (const e of this.edges.values()) total += JSON.stringify(e).length;
    // bytes to MB
    return Math.round((total / 1024 / 1024) * 100) / 100;
  }

  public clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.fqnIndex.clear();
    this.labelIndex.clear();
    this.typeIndex.clear();
    this.lastIndexedAt = null;
  }

  /**
   * Serialize a transferable snapshot suitable for worker message passing.
   */
  public serializeSnapshot(): { nodes: BaseNode[]; edges: GraphEdge[]; generatedAt: string } {
    const nodes = Array.from(this.nodes.values());
    const edges = Array.from(this.edges.values());
    return { nodes, edges, generatedAt: new Date().toISOString() };
  }

  /**
   * Load from worker snapshot (thread-safe)
   */
  public async loadSnapshot(snapshot: { nodes: BaseNode[]; edges: GraphEdge[] }): Promise<void> {
    await this.lock(async () => {
      this.clear();
      for (const n of snapshot.nodes) {
        this.nodes.set(n.id, n);
        const label = (n.label || '').toLowerCase();
        if (!this.labelIndex.has(label)) this.labelIndex.set(label, new Set());
        this.labelIndex.get(label)!.add(n.id);
        if (!this.typeIndex.has(n.type)) this.typeIndex.set(n.type, new Set());
        this.typeIndex.get(n.type)!.add(n.id);
        const anyN = n as any;
        if (anyN.fqn) this.fqnIndex.set(String(anyN.fqn).toLowerCase(), n.id);
      }
      for (const e of snapshot.edges) {
        this.edges.set(e.id, e);
      }
      this.lastIndexedAt = new Date();
    });
  }

  /**
   * Neighborhood traversal with distance decay. Since v0.30.0 the logic lives
   * in the engine (`expandNeighborhood`, used by context packs) and walks
   * edges in both directions, so a table reaches the terms and rules that
   * point at it.
   */
  public traverseNeighborhood(seedIds: string[], options?: RetrievalOptions & { decayFactor?: number; seedScore?: number }): SubgraphResult {
    const start = Date.now();
    const seedScore = options?.seedScore ?? 1.0;
    const reached = expandNeighborhood(
      { nodes: [...this.nodes.values()], edges: [...this.edges.values()] },
      seedIds,
      { maxHops: options?.maxHops ?? 2, decay: options?.decayFactor ?? 0.6 }
    );
    const nodes: BaseNode[] = [];
    for (const [id, r] of reached) {
      const n = this.nodes.get(id);
      if (n) nodes.push(Object.assign({}, n, { metadata: Object.assign({}, n.metadata, { __relevance: seedScore * r.relevance }) }));
    }
    const edges = [...this.edges.values()].filter((e) => reached.has(e.source) && reached.has(e.target));
    return { nodes, edges, formattedContext: '', tokenCount: 0, latencyMs: Date.now() - start };
  }
}
