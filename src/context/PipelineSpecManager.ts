import * as vscode from 'vscode';
import { PipelineSpec } from '../core/pipelineSpec/types';
import { CURRENT_PIPELINE_SPEC_VERSION } from '../core/pipelineSpec/types';
import { validatePipelineSpec } from '../core/pipelineSpec/validator';
import { parseYaml, stringifyYaml } from './Yaml';

/**
 * Manages the Pipeline Spec — modeled directly on `SpecManager.ts`'s exact,
 * already-working pattern for the Business Problem Specification: persists
 * to `<contextRoot>/spec/pipeline.yaml` with atomic writes, archives every
 * prior revision to `spec/history/`, and only bumps `version` when revising
 * an already-*approved* predecessor.
 */
export class PipelineSpecManager implements vscode.Disposable {
  private spec: PipelineSpec | undefined;
  private readonly specDir: vscode.Uri;
  private readonly specUri: vscode.Uri;

  constructor(
    private readonly contextRoot: vscode.Uri,
    private readonly log: (msg: string) => void
  ) {
    this.specDir = vscode.Uri.joinPath(contextRoot, 'spec');
    this.specUri = vscode.Uri.joinPath(this.specDir, 'pipeline.yaml');
  }

  public dispose(): void {}

  public async initialize(): Promise<void> {
    try {
      const content = await vscode.workspace.fs.readFile(this.specUri);
      this.spec = this.parse(Buffer.from(content).toString('utf8'));
      this.log(`Loaded Pipeline Spec v${this.spec.version} (${this.spec.status})`);
    } catch {
      this.spec = undefined;
      this.log('No Pipeline Spec yet.');
    }
  }

  public getSpec(): PipelineSpec | undefined {
    return this.spec ? this.clone(this.spec) : undefined;
  }

  public hasApprovedSpec(): boolean {
    return this.spec?.status === 'approved';
  }

  public async saveSpec(spec: PipelineSpec): Promise<void> {
    const { valid, errors } = validatePipelineSpec(spec);
    if (!valid) {
      throw new Error(`Invalid Pipeline Spec: ${errors.join('; ')}`);
    }
    await this.archive(this.spec, spec);
    this.spec = spec;
    await this.persist();
    this.log(`Saved Pipeline Spec v${spec.version} (${spec.status})`);
  }

  /**
   * Approval does NOT bump the version — a draft v1 becomes an approved v1,
   * mirroring `SpecManager.approve()` exactly. The version is bumped only
   * when a new revision is synthesized from an already-approved predecessor
   * (see `pipelineSpecSynthesis.ts`'s `parsePipelineSpecResponse`).
   */
  public async approve(): Promise<PipelineSpec | undefined> {
    if (!this.spec) return undefined;
    if (this.spec.status === 'approved') {
      this.log(`Pipeline Spec v${this.spec.version} is already approved.`);
      return this.getSpec();
    }
    const now = new Date().toISOString();
    const approved: PipelineSpec = { ...this.spec, status: 'approved', approvedAt: now, approvedBy: 'user', updatedAt: now };
    await this.archive(this.spec, approved);
    this.spec = approved;
    await this.persist();
    this.log(`Approved Pipeline Spec v${this.spec.version}`);
    return this.getSpec();
  }

  public getSpecUri(): vscode.Uri {
    return this.specUri;
  }

  /** The `spec/` directory this manager persists into — used to place sibling artifacts like the design doc. */
  public getSpecDir(): vscode.Uri {
    return this.specDir;
  }

  private async archive(previous: PipelineSpec | undefined, incoming: PipelineSpec): Promise<void> {
    if (!previous) return;
    if (this.serialize(previous) === this.serialize(incoming)) return;
    const historyDir = vscode.Uri.joinPath(this.specDir, 'history');
    await vscode.workspace.fs.createDirectory(historyDir);
    const name = `pipeline.v${previous.version}.${previous.status}.yaml`;
    const target = vscode.Uri.joinPath(historyDir, name);
    try {
      await vscode.workspace.fs.stat(target);
      return; // already archived
    } catch {
      // not present yet — write it
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(this.serialize(previous), 'utf8'));
    this.log(`Archived Pipeline Spec v${previous.version} (${previous.status}) → spec/history/${name}`);
  }

  private clone(spec: PipelineSpec): PipelineSpec {
    // A leniently-loaded, specVersion-mismatched document (see `parse()`) may not have
    // `entities` in the current shape at all — clone defensively rather than assume it.
    if (!Array.isArray(spec.entities)) {
      return { ...spec };
    }
    return {
      ...spec,
      entities: spec.entities.map((entity) => ({
        ...entity,
        source: { ...entity.source },
        target: { ...entity.target },
        transforms: entity.transforms.map((t) => ({ ...t, params: { ...t.params } })),
        quality: entity.quality ? { rules: entity.quality.rules.map((r) => ({ ...r })) } : undefined,
        governance: entity.governance ? { columns: entity.governance.columns.map((c) => ({ ...c })) } : undefined
      }))
    };
  }

  private async persist(): Promise<void> {
    if (!this.spec) return;
    await vscode.workspace.fs.createDirectory(this.specDir);
    const tempUri = vscode.Uri.joinPath(this.specDir, `.pipeline.tmp.${Date.now()}.yaml`);
    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(this.serialize(this.spec), 'utf8'));
    await vscode.workspace.fs.rename(tempUri, this.specUri, { overwrite: true });
  }

  private serialize(spec: PipelineSpec): string {
    return '# AutoDE Pipeline Spec\n' + stringifyYaml(spec as unknown as Record<string, unknown>);
  }

  /**
   * A document whose `specVersion` doesn't match `CURRENT_PIPELINE_SPEC_VERSION`
   * is loaded leniently with a logged warning rather than a hard failure —
   * schema evolution must never brick an already-approved pipeline (Phase
   * 2B-iv's stated discipline). Only a current-version document is required
   * to pass full Ajv validation.
   */
  private parse(content: string): PipelineSpec {
    const raw = parseYaml(content);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid Pipeline Spec YAML: root must be an object.');
    }
    const doc = raw as Record<string, unknown>;
    const specVersion = typeof doc.specVersion === 'number' ? doc.specVersion : 0;
    if (specVersion !== CURRENT_PIPELINE_SPEC_VERSION) {
      this.log(`Pipeline Spec was authored against specVersion ${specVersion}, current is ${CURRENT_PIPELINE_SPEC_VERSION} — loading leniently.`);
      return doc as unknown as PipelineSpec;
    }
    const { valid, errors } = validatePipelineSpec(doc);
    if (!valid) {
      throw new Error(`Invalid Pipeline Spec: ${errors.join('; ')}`);
    }
    return doc as unknown as PipelineSpec;
  }
}
