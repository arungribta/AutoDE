import * as vscode from 'vscode';
import { BusinessProblemSpec } from '../engine/types';
import { parseBusinessProblemSpec, serializeBusinessProblemSpec, specHistoryName } from '../engine/documents/problemDocuments';
import { ContextStore, RevisionedFile, applyReload } from '../engine/context/contextStore';
import { createVscodeFileIo } from './vscodeFileIo';

/**
 * Manages the Business Problem Specification — the versioned system of record.
 * Persists to `<contextRoot>/spec/business-problem.yaml` with atomic writes.
 *
 * `contextRoot` is a business problem's own folder
 * (`.autode/problems/<id>/`, v0.12.0) — the caller resolves which one;
 * this class has no opinion about multi-problem routing.
 */
export class SpecManager implements vscode.Disposable {
  private spec: BusinessProblemSpec | undefined;
  private readonly specDir: vscode.Uri;
  private readonly specUri: vscode.Uri;
  private readonly file: RevisionedFile;

  constructor(
    private readonly contextRoot: vscode.Uri,
    private readonly log: (msg: string) => void
  ) {
    this.specDir = vscode.Uri.joinPath(contextRoot, 'spec');
    this.specUri = vscode.Uri.joinPath(this.specDir, 'business-problem.yaml');
    this.file = new RevisionedFile(new ContextStore(createVscodeFileIo(vscode)), this.specUri.fsPath, 'Business Problem Specification');
  }

  public dispose(): void {}

  public async initialize(): Promise<void> {
    try {
      const content = await this.file.read();
      if (content === undefined) throw new Error('absent');
      this.spec = this.parse(content);
      this.log(`Loaded Business Problem Specification v${this.spec.version} (${this.spec.status})`);
    } catch {
      this.spec = undefined;
      this.log('No Business Problem Specification yet.');
    }
  }

  /** Re-reads the file after an external change (v0.25.0). Returns true when the loaded spec changed. */
  public async reload(): Promise<boolean> {
    const result = await this.file.reload((content) => this.parse(content));
    return applyReload(result, 'Business Problem Specification', this.log, (spec) => { this.spec = spec; });
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
    // prior draft/approved revision stays traceable in .autode/problems/<id>/spec/history/.
    await this.archive(this.spec, spec);
    await this.file.write(this.serialize(spec));
    this.spec = spec;
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
    await this.file.write(this.serialize(approved));
    this.spec = approved;
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
    const name = specHistoryName(previous);
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

  private serialize(spec: BusinessProblemSpec): string {
    return serializeBusinessProblemSpec(spec);
  }

  private parse(content: string): BusinessProblemSpec {
    return parseBusinessProblemSpec(content);
  }
}
