import * as fs from 'node:fs';
import * as path from 'node:path';
import * as port from '../engine/skills/port';
import * as lifecycle from '../engine/skills/lifecycle';
import { AUTODE_READ_TOOLS, AUTODE_WRITE_TOOLS } from '../engine/skills/toolAllowList';

/**
 * The Port a Skill wizard's state and messages (PA4), without vscode so a test can drive it.
 * Source → (choose a skill) → capability report (with the model's proposal, if asked for) → import →
 * review → publish. Every step that changes the workspace is confirmed by the person in the panel.
 */

export interface PortSkillHost {
  user(): string;
  workspaceRoot(): string | undefined;
  resourcesRoot: string;
  managementEnabled(): boolean;
  pickFolder(title: string): Promise<string | undefined>;
  confirm(title: string, detail: string, action: string): Promise<boolean>;
  /** The panel's model, when one is configured: the proposal step is offered only then. */
  complete?: (system: string, user: string) => Promise<string>;
  /** Opens AutoDE's review screen for an imported skill (the person grants the tier there). */
  review(id: string): Promise<void>;
  post(model: PortSkillModel): void;
  log(line: string): void;
  onChange(): void;
}

export type PortStep = 'source' | 'choose' | 'report' | 'imported';

export interface PortSkillModel {
  step: PortStep;
  busy: boolean;
  source: { kind: port.PortSourceKind; location: string; ref?: string };
  examples: boolean;
  canPropose: boolean;
  skills?: port.DiscoveredSkill[];
  analysis?: port.SkillAnalysis;
  report?: string;
  imported?: { id: string; status: string; tier: string; canPublish: boolean; why?: string };
  note?: { ok: boolean; text: string };
}

type SourceInput = { kind: port.PortSourceKind; location?: string; ref?: string };

export type PortSkillMsg =
  | { type: 'ready' }
  | ({ type: 'source' } & SourceInput)
  | { type: 'browse'; source?: SourceInput }
  | { type: 'example' }
  | { type: 'analyze'; source?: SourceInput }
  | { type: 'choose'; subpath: string }
  | { type: 'propose' }
  | { type: 'decide'; decision: 'accept' | 'reject'; classification?: port.SkillClass }
  | { type: 'import' }
  | { type: 'review' }
  | { type: 'publish' }
  | { type: 'reset' };

export class PortSkillSession {
  private step: PortStep = 'source';
  private busy = false;
  private source: PortSkillModel['source'] = { kind: 'git', location: '' };
  private staged?: port.StagedSource;
  private skills?: port.DiscoveredSkill[];
  private analysis?: port.SkillAnalysis;
  private imported?: string;
  private note?: PortSkillModel['note'];

  public constructor(private readonly host: PortSkillHost) {}

  private get examplesDir(): string { return path.join(this.host.resourcesRoot, 'examples', 'skills'); }

  public model(): PortSkillModel {
    const report = this.analysis && this.staged ? port.capabilityReport(this.analysis, this.staged.provenance) : this.analysis ? port.capabilityReport(this.analysis) : undefined;
    return {
      step: this.step, busy: this.busy, source: this.source, examples: fs.existsSync(this.examplesDir), canPropose: !!this.host.complete,
      skills: this.skills, analysis: this.analysis, report, imported: this.importedState(), note: this.note
    };
  }

  private importedState(): PortSkillModel['imported'] {
    const root = this.host.workspaceRoot();
    if (!this.imported || !root) return undefined;
    const s = lifecycle.loadToolSkillState(port.toolSkillsDir(root), this.imported, this.host.user());
    if (!s) return undefined;
    const acts = s.effectiveTier === 'unreviewed' ? lifecycle.actsOnItsOwn(s.skill.sourceDir) : undefined;
    const already = s.sidecar.status === 'published' && s.sidecar.publishedChecksum === s.checksum;
    return { id: s.skill.id, status: s.sidecar.status, tier: s.effectiveTier, canPublish: !acts && !already && s.sidecar.status !== 'retired', why: acts ? `Review it first: it ${acts}.` : already ? 'Published.' : undefined };
  }

  private setSource(s: SourceInput): void { this.source = { kind: s.kind, location: (s.location ?? '').trim(), ref: s.ref?.trim() || undefined }; }

  private post(): void { this.host.post(this.model()); }

  public dispose(): void { this.staged?.cleanup(); this.staged = undefined; }

  public async onMessage(m: PortSkillMsg): Promise<void> {
    if (this.busy && m.type !== 'ready') return;
    this.note = undefined;
    this.busy = true;
    this.post();
    try { await this.handle(m); }
    catch (err) { this.note = { ok: false, text: err instanceof Error ? err.message : String(err) }; }
    finally { this.busy = false; this.post(); }
  }

  private async handle(m: PortSkillMsg): Promise<void> {
    const root = this.host.workspaceRoot();
    switch (m.type) {
      case 'ready': return;
      case 'source': this.setSource(m); return;
      case 'browse': {
        if (m.source) this.setSource(m.source);
        const picked = await this.host.pickFolder(this.source.kind === 'dbt' ? 'A dbt project or package folder' : 'A skill folder, or a folder of skills');
        if (picked) this.source = { ...this.source, kind: this.source.kind === 'git' ? 'local' : this.source.kind, location: picked };
        return;
      }
      case 'example': this.source = { kind: 'local', location: this.examplesDir }; return this.handle({ type: 'analyze' });
      case 'reset': this.dispose(); this.step = 'source'; this.skills = this.analysis = this.imported = undefined; return;
      case 'analyze': {
        if (m.source) this.setSource(m.source);
        if (!root) throw new Error('Open a workspace folder first.');
        if (!this.source.location) throw new Error(this.source.kind === 'git' ? 'Enter the repository\'s URL.' : 'Choose a folder.');
        this.dispose();
        this.analysis = this.imported = undefined;
        const run = port.portSource(this.source, { resourcesRoot: this.host.resourcesRoot, workspaceRoot: root });
        this.staged = run.staged;
        this.skills = run.skills;
        this.analysis = run.analysis;
        this.step = run.analysis ? 'report' : 'choose';
        this.host.log(`Port a skill: analysed ${this.source.location}${run.staged.provenance.resolvedCommit ? ` @ ${run.staged.provenance.resolvedCommit.slice(0, 12)}` : ''}: ${run.skills.length} skill(s).`);
        return;
      }
      case 'choose': {
        if (!root || !this.staged) throw new Error('Analyse a source first.');
        const s = this.skills?.find((x) => x.subpath === m.subpath);
        if (!s) throw new Error(`No skill at ${m.subpath}.`);
        this.analysis = port.analyzeSkill(path.join(this.staged.dir, s.subpath), s.subpath, port.analysisContext(this.host.resourcesRoot, root, this.staged.dir));
        this.step = 'report';
        return;
      }
      case 'propose': {
        if (!this.host.complete || !this.analysis || !this.staged) return;
        const md = fs.readFileSync(path.join(this.staged.dir, this.analysis.subpath, 'SKILL.md'), 'utf8');
        const tools = [...AUTODE_READ_TOOLS, ...AUTODE_WRITE_TOOLS];
        const p = port.buildPortAnalysisPrompt(this.analysis, md, tools);
        const raw = await this.host.complete(p.system, p.user);
        const json = /\{[\s\S]*\}/.exec(raw)?.[0];
        let parsed: unknown;
        try { parsed = JSON.parse(json ?? ''); } catch { throw new Error('The model\'s answer was not JSON; nothing was proposed.'); }
        const r = port.parsePortProposal(parsed, tools);
        if (!r.proposal) throw new Error(`The model's proposal was refused: ${r.errors.join(' ')}`);
        this.analysis = { ...this.analysis, proposal: r.proposal };
        return;
      }
      case 'decide': if (this.analysis) this.analysis = port.decideProposal(this.analysis, m.decision, m.classification); return;
      case 'import': {
        if (!root || !this.analysis || !this.staged) throw new Error('Analyse a skill first.');
        const a = this.analysis;
        const replace = a.overlaps.some((o) => o.with === a.id && /already imported/.test(o.why));
        const detail = [`It is copied into .autode/config/skills/tool-skills/${a.id}/, unreviewed${this.host.managementEnabled() ? ' and a draft' : ''}: it can't run or join an assignment or a context pack until you review it.`,
          replace ? 'A skill with this id is imported already: it is replaced, and its review and versions start over.' : '',
          a.licence ? `Licence: ${a.licence.name}. ${a.licence.note ?? ''}` : 'No licence found.'].filter(Boolean).join('\n\n');
        if (!(await this.host.confirm(`Import ${a.name}?`, detail, replace ? 'Replace' : 'Import'))) return;
        const r = port.importSkill({ workspaceRoot: root, stagedDir: this.staged.dir, analysis: a, provenance: this.staged.provenance, by: this.host.user(), managementEnabled: this.host.managementEnabled(), replace });
        this.imported = r.id;
        this.step = 'imported';
        this.note = { ok: true, text: `Imported as ${r.id} (${r.sidecar.status}, unreviewed). Review it next.` };
        this.host.log(`Port a skill: imported ${r.id} from ${r.sidecar.provenance.repoUrl ?? r.sidecar.provenance.location} (${r.sidecar.status}, unreviewed).`);
        this.dispose();
        this.host.onChange();
        return;
      }
      case 'review': if (this.imported) { await this.host.review(this.imported); this.host.onChange(); } return;
      case 'publish': {
        if (!root || !this.imported) return;
        if (!(await this.host.confirm(`Publish ${this.imported}?`, 'Published and reviewed, it can run, join assignments of the stage kinds it declares and, as a knowledge skill, context packs.', 'Publish'))) return;
        const r = lifecycle.publishToolSkill(path.join(port.toolSkillsDir(root), this.imported), this.host.user());
        this.note = { ok: true, text: `Published ${this.imported} as version ${r.sidecar.version}.` };
        this.host.onChange();
        return;
      }
    }
  }
}
