import * as vscode from 'vscode';
import { BusinessProblemSpec, DataFlow, SourceEntry, SpecProvenance, SpecStatus } from '../core/types';
import { parseYaml, stringifyYaml } from './Yaml';

/**
 * Manages the Business Problem Specification — the versioned system of record.
 * Persists to `.ai-context/spec/business-problem.yaml` with atomic writes.
 */
export class SpecManager implements vscode.Disposable {
  private spec: BusinessProblemSpec | undefined;
  private readonly specDir: vscode.Uri;
  private readonly specUri: vscode.Uri;

  constructor(
    private readonly workspaceUri: vscode.Uri,
    private readonly log: (msg: string) => void
  ) {
    this.specDir = vscode.Uri.joinPath(workspaceUri, '.ai-context', 'spec');
    this.specUri = vscode.Uri.joinPath(this.specDir, 'business-problem.yaml');
  }

  public dispose(): void {}

  public async initialize(): Promise<void> {
    try {
      const content = await vscode.workspace.fs.readFile(this.specUri);
      this.spec = this.parse(Buffer.from(content).toString('utf8'));
      this.log(`Loaded Business Problem Specification v${this.spec.version} (${this.spec.status})`);
    } catch {
      this.spec = undefined;
      this.log('No Business Problem Specification yet.');
    }
  }

  public getSpec(): BusinessProblemSpec | undefined {
    return this.spec ? this.clone(this.spec) : undefined;
  }

  public hasApprovedSpec(): boolean {
    return this.spec?.status === 'approved';
  }

  public getSpecId(): string | undefined {
    return this.spec?.id;
  }

  public getSpecVersion(): number | undefined {
    return this.spec?.version;
  }

  public async saveSpec(spec: BusinessProblemSpec): Promise<void> {
    // Archive whatever is currently persisted before it is replaced, so that every
    // prior draft/approved revision stays traceable in .ai-context/spec/history/.
    await this.archive(this.spec, spec);
    this.spec = spec;
    await this.persist();
    this.log(`Saved Business Problem Specification v${spec.version} (${spec.status})`);
  }

  /**
   * Approves the current specification.
   *
   * Approval does NOT bump the version: a draft v1 becomes an approved v1. The
   * version is bumped only when the business problem materially changes and a new
   * revision is drafted (see AgentHub.generateSpec).
   */
  public async approve(): Promise<BusinessProblemSpec | undefined> {
    if (!this.spec) return undefined;
    if (this.spec.status === 'approved') {
      this.log(`Business Problem Specification v${this.spec.version} is already approved.`);
      return this.getSpec();
    }
    const now = new Date().toISOString();
    const approved: BusinessProblemSpec = {
      ...this.spec,
      status: 'approved',
      approvedAt: now,
      approvedBy: 'user',
      updatedAt: now
    };
    await this.archive(this.spec, approved);
    this.spec = approved;
    await this.persist();
    this.log(`Approved Business Problem Specification v${this.spec.version}`);
    return this.getSpec();
  }

  /** Location of the persisted specification, used to open it in an editor. */
  public getSpecUri(): vscode.Uri {
    return this.specUri;
  }

  /** Persists the previous revision to spec/history/ when it differs from the incoming one. */
  private async archive(previous: BusinessProblemSpec | undefined, incoming: BusinessProblemSpec): Promise<void> {
    if (!previous) return;
    if (this.serialize(previous) === this.serialize(incoming)) return;
    const historyDir = vscode.Uri.joinPath(this.specDir, 'history');
    await vscode.workspace.fs.createDirectory(historyDir);
    const name = `business-problem.v${previous.version}.${previous.status}.yaml`;
    const target = vscode.Uri.joinPath(historyDir, name);
    try {
      await vscode.workspace.fs.stat(target);
      return; // already archived
    } catch {
      // not present yet — write it
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(this.serialize(previous), 'utf8'));
    this.log(`Archived specification v${previous.version} (${previous.status}) → spec/history/${name}`);
  }

  private clone(spec: BusinessProblemSpec): BusinessProblemSpec {
    return {
      ...spec,
      objectives: [...spec.objectives],
      successCriteria: [...spec.successCriteria],
      scope: { in: [...spec.scope.in], out: [...spec.scope.out] },
      constraints: [...spec.constraints],
      assumptions: [...spec.assumptions],
      stakeholders: spec.stakeholders ? [...spec.stakeholders] : undefined,
      keyEntities: spec.keyEntities ? [...spec.keyEntities] : undefined,
      businessRequirements: spec.businessRequirements ? [...spec.businessRequirements] : undefined,
      transformations: spec.transformations ? [...spec.transformations] : undefined,
      dependencies: spec.dependencies ? [...spec.dependencies] : undefined,
      acceptanceCriteria: spec.acceptanceCriteria ? [...spec.acceptanceCriteria] : undefined,
      implementationConsiderations: spec.implementationConsiderations ? [...spec.implementationConsiderations] : undefined,
      dataFlows: spec.dataFlows
        ? spec.dataFlows.map((flow) => ({ ...flow, transformations: flow.transformations ? [...flow.transformations] : undefined }))
        : undefined,
      sourceCatalog: spec.sourceCatalog ? spec.sourceCatalog.map((entry) => ({ ...entry })) : undefined,
      provenance: spec.provenance ? spec.provenance.map((entry) => ({ ...entry })) : undefined
    };
  }

  private async persist(): Promise<void> {
    if (!this.spec) return;
    await vscode.workspace.fs.createDirectory(this.specDir);
    const tempUri = vscode.Uri.joinPath(this.specDir, `.business-problem.tmp.${Date.now()}.yaml`);
    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(this.serialize(this.spec), 'utf8'));
    await vscode.workspace.fs.rename(tempUri, this.specUri, { overwrite: true });
  }

  private serialize(spec: BusinessProblemSpec): string {
    const doc: Record<string, unknown> = {
      id: spec.id,
      version: spec.version,
      status: spec.status,
      problemStatement: spec.problemStatement,
      objectives: spec.objectives,
      successCriteria: spec.successCriteria,
      scope: { in: spec.scope.in, out: spec.scope.out },
      constraints: spec.constraints,
      assumptions: spec.assumptions,
      domain: spec.domain,
      stakeholders: spec.stakeholders,
      keyEntities: spec.keyEntities,
      // ── Comprehensive (v2) fields — persist as NATIVE YAML (no JSON stopgap) ──
      businessRequirements: spec.businessRequirements,
      dataFlows: spec.dataFlows,
      transformations: spec.transformations,
      dependencies: spec.dependencies,
      acceptanceCriteria: spec.acceptanceCriteria,
      implementationConsiderations: spec.implementationConsiderations,
      sourceCatalog: spec.sourceCatalog,
      provenance: spec.provenance,
      createdAt: spec.createdAt,
      updatedAt: spec.updatedAt,
      approvedAt: spec.approvedAt,
      approvedBy: spec.approvedBy
    };
    // The `yaml` library drops `undefined` top-level keys, so optional fields are
    // omitted automatically; empty arrays are preserved (read back as []).
    return '# AutoDE Business Problem Specification\n' + stringifyYaml(doc);
  }

  private parse(content: string): BusinessProblemSpec {
    const raw = parseYaml(content);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid specification YAML: root must be an object.');
    }
    const doc = raw as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

    // Backward compatibility: legacy files stored scope as flat `scopeIn:`/`scopeOut:`.
    const scopeRaw = (doc.scope && typeof doc.scope === 'object' && !Array.isArray(doc.scope))
      ? doc.scope as Record<string, unknown>
      : {};
    const inScope = list(scopeRaw.in);
    const outScope = list(scopeRaw.out);
    const scope = {
      in: inScope.length > 0 ? inScope : list(doc.scopeIn),
      out: outScope.length > 0 ? outScope : list(doc.scopeOut)
    };

    const spec: BusinessProblemSpec = {
      id: str(doc.id) || `bps-${Date.now().toString(36)}`,
      version: typeof doc.version === 'number' ? doc.version : parseInt(str(doc.version), 10) || 1,
      status: (str(doc.status) as SpecStatus) || 'draft',
      problemStatement: str(doc.problemStatement),
      objectives: list(doc.objectives),
      successCriteria: list(doc.successCriteria),
      scope,
      constraints: list(doc.constraints),
      assumptions: list(doc.assumptions),
      domain: str(doc.domain) || undefined,
      stakeholders: list(doc.stakeholders),
      keyEntities: list(doc.keyEntities),
      createdAt: str(doc.createdAt),
      updatedAt: str(doc.updatedAt),
      approvedAt: str(doc.approvedAt) || undefined,
      approvedBy: str(doc.approvedBy) || undefined
    };

    // v2 fields: native YAML keys now; legacy files may still carry a
    // `comprehensive: <JSON>` block that was read as a flow mapping (or string).
    const v2 = this.resolveV2Block(doc);
    const br = list(v2.businessRequirements ?? doc.businessRequirements);
    if (br.length > 0) spec.businessRequirements = br;
    const transformations = list(v2.transformations ?? doc.transformations);
    if (transformations.length > 0) spec.transformations = transformations;
    const deps = list(v2.dependencies ?? doc.dependencies);
    if (deps.length > 0) spec.dependencies = deps;
    const ac = list(v2.acceptanceCriteria ?? doc.acceptanceCriteria);
    if (ac.length > 0) spec.acceptanceCriteria = ac;
    const ic = list(v2.implementationConsiderations ?? doc.implementationConsiderations);
    if (ic.length > 0) spec.implementationConsiderations = ic;
    const flows = this.parseDataFlows(v2.dataFlows ?? doc.dataFlows);
    if (flows) spec.dataFlows = flows;
    const catalog = this.parseSourceCatalog(v2.sourceCatalog ?? doc.sourceCatalog);
    if (catalog) spec.sourceCatalog = catalog;
    const provenance = this.parseProvenance(v2.provenance ?? doc.provenance);
    if (provenance) spec.provenance = provenance;

    return spec;
  }

  /** Returns the legacy `comprehensive:` block (flow-mapped object or JSON string) when present. */
  private resolveV2Block(doc: Record<string, unknown>): Record<string, unknown> {
    const comp = doc.comprehensive;
    if (!comp) return {};
    if (typeof comp === 'string') {
      try {
        const parsed = JSON.parse(comp) as unknown;
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : {};
      } catch {
        return {};
      }
    }
    return (typeof comp === 'object' && !Array.isArray(comp)) ? comp as Record<string, unknown> : {};
  }

  private parseDataFlows(v: unknown): DataFlow[] | undefined {
    if (!Array.isArray(v)) return undefined;
    const flows: DataFlow[] = [];
    for (const raw of v) {
      if (!raw || typeof raw !== 'object') continue;
      const f = raw as Record<string, unknown>;
      const str = (x: unknown): string => (typeof x === 'string' ? x : '');
      flows.push({
        id: str(f.id),
        source: str(f.source),
        target: str(f.target),
        description: str(f.description),
        transformations: (Array.isArray(f.transformations) ? f.transformations.filter((x) => typeof x === 'string') : undefined) as string[] | undefined,
        frequency: str(f.frequency) || undefined
      });
    }
    return flows.length > 0 ? flows : undefined;
  }

  private parseSourceCatalog(v: unknown): SourceEntry[] | undefined {
    if (!Array.isArray(v)) return undefined;
    const catalog: SourceEntry[] = [];
    for (const raw of v) {
      if (!raw || typeof raw !== 'object') continue;
      const s = raw as Record<string, unknown>;
      const str = (x: unknown): string => (typeof x === 'string' ? x : '');
      catalog.push({
        name: str(s.name),
        type: (str(s.type) as SourceEntry['type']) || 'other',
        description: str(s.description) || undefined,
        availability: str(s.availability) || undefined
      });
    }
    return catalog.length > 0 ? catalog : undefined;
  }

  private parseProvenance(v: unknown): SpecProvenance[] | undefined {
    if (!Array.isArray(v)) return undefined;
    const prov: SpecProvenance[] = [];
    for (const raw of v) {
      if (!raw || typeof raw !== 'object') continue;
      const p = raw as Record<string, unknown>;
      const str = (x: unknown): string => (typeof x === 'string' ? x : '');
      prov.push({
        field: str(p.field),
        source: (str(p.source) as SpecProvenance['source']) || 'synthesis',
        questionId: str(p.questionId) || undefined,
        skill: str(p.skill) || undefined
      });
    }
    return prov.length > 0 ? prov : undefined;
  }
}
