import * as vscode from 'vscode';
import { BusinessProblemSpec, DataFlow, SourceEntry, SpecProvenance, SpecStatus } from '../core/types';

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
    const L: string[] = [
      '# AutoDE Business Problem Specification',
      `id: ${spec.id}`,
      `version: ${spec.version}`,
      `status: ${spec.status}`,
      `problemStatement: ${spec.problemStatement}`,
      'objectives:'
    ];
    this.pushList(L, spec.objectives);
    L.push('successCriteria:');
    this.pushList(L, spec.successCriteria);
    L.push('scopeIn:');
    this.pushList(L, spec.scope.in);
    L.push('scopeOut:');
    this.pushList(L, spec.scope.out);
    L.push('constraints:');
    this.pushList(L, spec.constraints);
    L.push('assumptions:');
    this.pushList(L, spec.assumptions);
    if (spec.domain) L.push(`domain: ${spec.domain}`);
    if (spec.stakeholders && spec.stakeholders.length > 0) { L.push('stakeholders:'); this.pushList(L, spec.stakeholders); }
    if (spec.keyEntities && spec.keyEntities.length > 0) { L.push('keyEntities:'); this.pushList(L, spec.keyEntities); }
    const v2: Record<string, unknown> = {};
    if (spec.businessRequirements && spec.businessRequirements.length > 0) v2.businessRequirements = spec.businessRequirements;
    if (spec.dataFlows && spec.dataFlows.length > 0) v2.dataFlows = spec.dataFlows;
    if (spec.transformations && spec.transformations.length > 0) v2.transformations = spec.transformations;
    if (spec.dependencies && spec.dependencies.length > 0) v2.dependencies = spec.dependencies;
    if (spec.acceptanceCriteria && spec.acceptanceCriteria.length > 0) v2.acceptanceCriteria = spec.acceptanceCriteria;
    if (spec.implementationConsiderations && spec.implementationConsiderations.length > 0) v2.implementationConsiderations = spec.implementationConsiderations;
    if (spec.sourceCatalog && spec.sourceCatalog.length > 0) v2.sourceCatalog = spec.sourceCatalog;
    if (spec.provenance && spec.provenance.length > 0) v2.provenance = spec.provenance;
    if (Object.keys(v2).length > 0) {
      L.push(`comprehensive: ${JSON.stringify(v2)}`);
    }
    L.push(`createdAt: ${spec.createdAt}`);
    L.push(`updatedAt: ${spec.updatedAt}`);
    if (spec.approvedAt) L.push(`approvedAt: ${spec.approvedAt}`);
    if (spec.approvedBy) L.push(`approvedBy: ${spec.approvedBy}`);
    return L.join('\n') + '\n';
  }

  private pushList(lines: string[], items: string[]): void {
    for (const item of items) lines.push(`  - ${item}`);
  }

  private parse(content: string): BusinessProblemSpec {
    const scalar = (key: string): string => {
      const m = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    const list = (key: string): string[] => {
      const result: string[] = [];
      const lines = content.split(/\r?\n/);
      let active = false;
      for (const line of lines) {
        if (new RegExp(`^${key}:\\s*$`).test(line)) { active = true; continue; }
        if (active) {
          const item = line.match(/^\s+-\s+(.+)$/);
          if (item) { result.push(item[1].trim()); continue; }
          if (line.trim().length === 0) continue;
          if (!/^\s/.test(line)) break;
        }
      }
      return result;
    };

    const spec: BusinessProblemSpec = {
      id: scalar('id') || `bps-${Date.now().toString(36)}`,
      version: parseInt(scalar('version'), 10) || 1,
      status: (scalar('status') as SpecStatus) || 'draft',
      problemStatement: scalar('problemStatement'),
      objectives: list('objectives'),
      successCriteria: list('successCriteria'),
      scope: { in: list('scopeIn'), out: list('scopeOut') },
      constraints: list('constraints'),
      assumptions: list('assumptions'),
      domain: scalar('domain') || undefined,
      stakeholders: list('stakeholders'),
      keyEntities: list('keyEntities'),
      createdAt: scalar('createdAt'),
      updatedAt: scalar('updatedAt'),
      approvedAt: scalar('approvedAt') || undefined,
      approvedBy: scalar('approvedBy') || undefined
    };

    const comprehensiveLine = scalar('comprehensive');
    if (comprehensiveLine) {
      try {
        const v2 = JSON.parse(comprehensiveLine) as Record<string, unknown>;
        if (Array.isArray(v2.businessRequirements)) spec.businessRequirements = v2.businessRequirements as string[];
        if (Array.isArray(v2.dataFlows)) spec.dataFlows = v2.dataFlows as DataFlow[];
        if (Array.isArray(v2.transformations)) spec.transformations = v2.transformations as string[];
        if (Array.isArray(v2.dependencies)) spec.dependencies = v2.dependencies as string[];
        if (Array.isArray(v2.acceptanceCriteria)) spec.acceptanceCriteria = v2.acceptanceCriteria as string[];
        if (Array.isArray(v2.implementationConsiderations)) spec.implementationConsiderations = v2.implementationConsiderations as string[];
        if (Array.isArray(v2.sourceCatalog)) spec.sourceCatalog = v2.sourceCatalog as SourceEntry[];
        if (Array.isArray(v2.provenance)) spec.provenance = v2.provenance as SpecProvenance[];
      } catch {
        // Ignore a malformed comprehensive block; keep the core spec intact.
      }
    }

    return spec;
  }
}
