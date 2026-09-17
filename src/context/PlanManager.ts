import * as vscode from 'vscode';
import { PersistedPlan } from '../core/types';
import { parseYaml, stringifyYaml } from './Yaml';

/**
 * Manages the persisted workflow plan — the durable counterpart to `AgentHub`'s
 * in-memory `PlanState`. Persists to `<contextRoot>/plan/plan.yaml` with atomic
 * writes and a version-on-change `history/` archive, mirroring `SpecManager`
 * exactly: a plan is a governed artifact, not transient UI state, and every
 * re-plan is worth keeping rather than silently overwriting.
 *
 * `contextRoot` is a business problem's own folder (v0.12.0) — see `SpecManager`.
 */
export class PlanManager implements vscode.Disposable {
  private plan: PersistedPlan | undefined;
  private readonly planDir: vscode.Uri;
  private readonly planUri: vscode.Uri;

  constructor(
    private readonly contextRoot: vscode.Uri,
    private readonly log: (msg: string) => void
  ) {
    this.planDir = vscode.Uri.joinPath(contextRoot, 'plan');
    this.planUri = vscode.Uri.joinPath(this.planDir, 'plan.yaml');
  }

  public dispose(): void {}

  public async initialize(): Promise<void> {
    try {
      const content = await vscode.workspace.fs.readFile(this.planUri);
      this.plan = this.parse(Buffer.from(content).toString('utf8'));
      this.log(`Loaded plan v${this.plan.version} (${this.plan.status}, ${this.plan.steps.length} steps).`);
    } catch {
      this.plan = undefined;
      this.log('No persisted plan yet.');
    }
  }

  public getPlan(): PersistedPlan | undefined {
    return this.plan ? this.clone(this.plan) : undefined;
  }

  /** Location of the persisted plan, used to open it in an editor. */
  public getPlanUri(): vscode.Uri {
    return this.planUri;
  }

  /**
   * Updates just the phase metadata (inferred phases + overrides) on the
   * current plan version in place, without bumping the version or archiving —
   * a phase override is a correction to the review state, not a new plan
   * generation. A no-op if no plan has been saved yet.
   */
  public async patchInferredPhases(
    inferredPhases: PersistedPlan['inferredPhases'],
    phaseOverrides: PersistedPlan['phaseOverrides']
  ): Promise<void> {
    if (!this.plan) return;
    this.plan = { ...this.plan, inferredPhases, phaseOverrides, updatedAt: new Date().toISOString() };
    await this.persist();
  }

  /**
   * Updates the Plan Approval / Stage Confirmation gate fields (v0.13.0) on the
   * current plan version in place — an approval/confirmation click is a status
   * change on the existing plan, not a new generation, so this mirrors
   * `patchInferredPhases` rather than going through `savePlan`. A no-op if no
   * plan has been saved yet.
   */
  public async patchGates(fields: Partial<Pick<PersistedPlan, 'planApproved' | 'planApprovedAt' | 'stagesConfirmed' | 'stagesConfirmedAt'>>): Promise<void> {
    if (!this.plan) return;
    this.plan = { ...this.plan, ...fields, updatedAt: new Date().toISOString() };
    await this.persist();
  }

  /**
   * Persists a newly generated (or re-generated) plan as the next version,
   * archiving whatever was current to `plan/history/`. Every call bumps the
   * version — there is no in-place update of an existing version.
   */
  public async savePlan(next: Omit<PersistedPlan, 'version' | 'createdAt' | 'updatedAt'>): Promise<PersistedPlan> {
    const now = new Date().toISOString();
    const version = (this.plan && this.plan.id === next.id ? this.plan.version : 0) + 1;
    const persisted: PersistedPlan = {
      ...next,
      version,
      createdAt: this.plan && this.plan.id === next.id ? this.plan.createdAt : now,
      updatedAt: now
    };
    await this.archive(this.plan);
    this.plan = persisted;
    await this.persist();
    this.log(`Saved plan v${version} (${persisted.status}, ${persisted.generationReason}, ${persisted.steps.length} steps).`);
    return this.clone(persisted);
  }

  /** Archives the previous revision to plan/history/ when one exists and differs from what's about to replace it. */
  private async archive(previous: PersistedPlan | undefined): Promise<void> {
    if (!previous) return;
    const historyDir = vscode.Uri.joinPath(this.planDir, 'history');
    await vscode.workspace.fs.createDirectory(historyDir);
    const name = `plan.v${previous.version}.${previous.status}.yaml`;
    const target = vscode.Uri.joinPath(historyDir, name);
    try {
      await vscode.workspace.fs.stat(target);
      return; // already archived
    } catch {
      // not present yet — write it
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(this.serialize(previous), 'utf8'));
    this.log(`Archived plan v${previous.version} (${previous.status}) → plan/history/${name}`);
  }

  private async persist(): Promise<void> {
    if (!this.plan) return;
    await vscode.workspace.fs.createDirectory(this.planDir);
    const tempUri = vscode.Uri.joinPath(this.planDir, `.plan.tmp.${Date.now()}.yaml`);
    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(this.serialize(this.plan), 'utf8'));
    await vscode.workspace.fs.rename(tempUri, this.planUri, { overwrite: true });
  }

  private clone(plan: PersistedPlan): PersistedPlan {
    return {
      ...plan,
      steps: plan.steps.map((step) => ({
        ...step,
        dependsOn: step.dependsOn ? [...step.dependsOn] : undefined,
        validationRules: step.validationRules ? [...step.validationRules] : undefined
      })),
      inferredPhases: plan.inferredPhases
        ? plan.inferredPhases.map((phase) => ({ ...phase, dependsOn: [...phase.dependsOn] }))
        : undefined,
      phaseOverrides: plan.phaseOverrides ? { ...plan.phaseOverrides } : undefined
    };
  }

  private serialize(plan: PersistedPlan): string {
    return '# AutoDE Workflow Plan\n' + stringifyYaml(plan as unknown as Record<string, unknown>);
  }

  private parse(content: string): PersistedPlan {
    const raw = parseYaml(content);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid plan YAML: root must be an object.');
    }
    const doc = raw as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const num = (v: unknown): number => (typeof v === 'number' ? v : parseInt(str(v), 10) || 1);

    return {
      id: str(doc.id) || `plan-${Date.now().toString(36)}`,
      version: num(doc.version),
      specId: str(doc.specId) || undefined,
      specVersion: typeof doc.specVersion === 'number' ? doc.specVersion : undefined,
      implementationType: (doc.implementationType === 'greenfield' || doc.implementationType === 'brownfield') ? doc.implementationType : undefined,
      objective: str(doc.objective),
      schemaContext: str(doc.schemaContext),
      status: (str(doc.status) as PersistedPlan['status']) || 'idle',
      steps: Array.isArray(doc.steps) ? (doc.steps as PersistedPlan['steps']) : [],
      inferredPhases: Array.isArray(doc.inferredPhases) ? (doc.inferredPhases as PersistedPlan['inferredPhases']) : undefined,
      targetEnvironment: (doc.targetEnvironment && typeof doc.targetEnvironment === 'object') ? doc.targetEnvironment as PersistedPlan['targetEnvironment'] : undefined,
      phaseOverrides: (doc.phaseOverrides && typeof doc.phaseOverrides === 'object' && !Array.isArray(doc.phaseOverrides)) ? doc.phaseOverrides as PersistedPlan['phaseOverrides'] : undefined,
      generationReason: (doc.generationReason === 're-plan' ? 're-plan' : 'initial'),
      planApproved: doc.planApproved === true,
      planApprovedAt: str(doc.planApprovedAt) || undefined,
      stagesConfirmed: doc.stagesConfirmed === true,
      stagesConfirmedAt: str(doc.stagesConfirmedAt) || undefined,
      createdAt: str(doc.createdAt),
      updatedAt: str(doc.updatedAt)
    };
  }
}
