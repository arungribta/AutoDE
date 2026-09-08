import * as vscode from 'vscode';
import { BusinessProblemSpec, SpecStatus } from '../core/types';

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
    this.spec = spec;
    await this.persist();
    this.log(`Saved Business Problem Specification v${spec.version} (${spec.status})`);
  }

  public async approve(): Promise<BusinessProblemSpec | undefined> {
    if (!this.spec) return undefined;
    this.spec.status = 'approved';
    this.spec.approvedAt = new Date().toISOString();
    this.spec.approvedBy = 'user';
    this.spec.updatedAt = new Date().toISOString();
    this.spec.version += 1;
    await this.persist();
    this.log(`Approved Business Problem Specification v${this.spec.version}`);
    return this.getSpec();
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
      keyEntities: spec.keyEntities ? [...spec.keyEntities] : undefined
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

    return {
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
  }
}
