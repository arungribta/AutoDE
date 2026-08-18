import * as vscode from 'vscode';
import { BaseNode, GraphEdge, RetrievalOptions, SubgraphResult, ContextEngineDiagnostics } from './types';

/**
 * Thread-safe in-memory Graph Manager.
 * - Keeps node and edge maps
 * - Provides lookup indexes for FQN, label, and node type
 * - Provides neighborhood traversal with relevance scoring (decay)
 * - Provides serialization for worker transfer
 */
export class GraphManager implements vscode.Disposable {
  private nodes: Map<string, BaseNode> = new Map();
  private edges: Map<string, GraphEdge> = new Map();

  // Indexes
  private fqnIndex: Map<string, string> = new Map(); // fqn -> nodeId
  private labelIndex: Map<string, Set<string>> = new Map(); // label -> set(nodeId)
  private typeIndex: Map<string, Set<string>> = new Map(); // type -> set(nodeId)

  // Simple mutex to serialize mutation operations
  private mutex: Promise<void> = Promise.resolve();

  private lastIndexedAt: Date | null = null;

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

  public getNodeById(id: string): BaseNode | undefined {
    return this.nodes.get(id);
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
   * Neighborhood traversal using BFS up to maxHops, computing relevance per seed
   */
  public traverseNeighborhood(seedIds: string[], options?: RetrievalOptions & { decayFactor?: number; seedScore?: number }): SubgraphResult {
    const start = Date.now();
    const maxHops = (options && options.maxHops) ? options.maxHops : 2;
    const decay = (options && options['decayFactor']) ? options['decayFactor']! : 0.6;
    const seedScore = (options && options['seedScore']) ? options['seedScore']! : 1.0;

    const visited = new Map<string, number>(); // nodeId -> min distance
    const queue: Array<{ id: string; dist: number }> = [];

    for (const sid of seedIds) {
      if (!this.nodes.has(sid)) continue;
      visited.set(sid, 0);
      queue.push({ id: sid, dist: 0 });
    }

    const edgesOutMap = this.buildAdjacency();

    while (queue.length > 0) {
      const { id, dist } = queue.shift()!;
      if (dist >= maxHops) continue;
      const neighbors = edgesOutMap.get(id) || [];
      for (const neighId of neighbors) {
        const prev = visited.get(neighId);
        const nd = dist + 1;
        if (prev === undefined || nd < prev) {
          visited.set(neighId, nd);
          queue.push({ id: neighId, dist: nd });
        }
      }
    }

    // build nodes and edges list
    const nodes: BaseNode[] = [];
    const edges: GraphEdge[] = [];

    for (const nodeId of visited.keys()) {
      const n = this.nodes.get(nodeId);
      if (n) nodes.push(n);
    }

    for (const e of this.edges.values()) {
      if (visited.has(e.source) && visited.has(e.target)) edges.push(e);
    }

    // compute relevance scores
    const relevance = new Map<string, number>();
    for (const sid of seedIds) {
      if (!visited.has(sid)) continue;
      // seed has distance 0
      relevance.set(sid, (relevance.get(sid) || 0) + seedScore);
    }

    for (const [nid, dist] of visited.entries()) {
      if (seedIds.includes(nid)) continue;
      // approximate seed contribution: pick shortest distance to any seed
      // find minimal dist from seeds by walking back via visited map distances
      const minDist = dist; // we recorded min distances already
      const score = seedScore * Math.pow(decay, minDist);
      relevance.set(nid, (relevance.get(nid) || 0) + score);
    }

    // attach relevance to nodes as metadata for downstream pruning (non-destructive)
    const nodesWithMeta = nodes.map((n) => (
      Object.assign({}, n, { metadata: Object.assign({}, n.metadata, { __relevance: relevance.get(n.id) || 0 }) })
    ));

    const latencyMs = Date.now() - start;

    const result: SubgraphResult = {
      nodes: nodesWithMeta,
      edges,
      formattedContext: '', // formatting is left to the retriever/formatter
      tokenCount: 0,
      latencyMs
    };

    return result;
  }

  private buildAdjacency(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const e of this.edges.values()) {
      if (!map.has(e.source)) map.set(e.source, []);
      map.get(e.source)!.push(e.target);
      // if undirected semantics desired, also add reverse
      // map.set(e.target, (map.get(e.target) || []).concat([e.source]));
    }
    return map;
  }
}
