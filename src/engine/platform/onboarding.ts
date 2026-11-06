import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml, stringifyYaml } from '../context/Yaml';
import { layoutPath } from '../workspaceLayout';
import { Decision, DecisionStore, Proposer } from '../decisions/decisionStore';
import { BundleFile, ConformanceReviewPayload, PlatformBundlePayload, propose } from '../decisions/proposals';
import { skillContentChecksum, writeSidecarFile } from '../skills/lifecycle';
import { Catalog, checkOperation, checkPlatform, checksumOf, loadCatalog, readApprovals } from './operations/load';
import { ApiAuth, ImplementationFile, OperationExample, OperationParam, OperationReturn, PlatformDefinition, PlatformImpl, PlatformOperation } from './operations/types';
import { ConformanceResult, readConformance } from './operations/catalogView';

/**
 * POP5b, onboarding a new system (docs/specs/platform-operations.md §6.5). A person or an agent gives the answers:
 * category, transports, access, connection fields, version detection, an implementation of each starter operation, and
 * skills. `planOnboarding` turns them into the files a hand-written platform has (Redshift's are the check), and
 * says what is missing. Nothing is written unless the plan is ready, and what can only be solved in code is said
 * plainly and stops it. The files are one reviewed bundle. Once approved a system is **on trial**: it connects, and
 * only conformance runs and Try it read from it. It **counts** when a person reviews a conformance run on a real
 * connection, a review bound to the definition's exact content.
 */

export interface OnboardingScope { resourcesRoot?: string; workspaceRoot: string }

export interface TemplateCapability { required?: boolean; operations?: string[]; optional?: string[]; note?: string }
export interface StarterOperation { id: string; title: string; description: string; kind: 'read' | 'change'; content?: 'metadata' | 'data'; area: string; params: OperationParam[]; returns: OperationReturn[] }
export interface CategoryTemplate { label: string; description: string; transports: string[]; capabilities: Record<string, TemplateCapability>; starter?: StarterOperation[]; skills?: string[] }

export function loadTemplates(resourcesRoot: string | undefined): Record<string, CategoryTemplate> {
  if (!resourcesRoot) return {};
  const raw = parseYaml(fs.readFileSync(path.join(resourcesRoot, 'platform-templates', 'categories.yaml'), 'utf8')) as { categories: Record<string, CategoryTemplate & { like?: string }> };
  return Object.fromEntries(Object.entries(raw.categories).map(([id, c]) => [id, c.like ? { ...raw.categories[c.like], ...c } : c]));
}

/** One platform's implementation of an operation, and what the platform returned when it ran. */
export interface ImplementationAnswer { implementation: PlatformImpl; example?: Pick<OperationExample, 'params' | 'rows'> }

export interface SkillAnswer { name: string; description: string; body: string }

/** Everything a platform definition holds, plus its operations and skills. */
export interface OnboardingAnswers extends Partial<Omit<PlatformDefinition, 'formatVersion' | 'capabilities'>> {
  capabilities?: PlatformDefinition['capabilities'];
  /** By operation id: an implementation of an operation the catalog has, or of one in `operations`. */
  implementations?: Record<string, ImplementationAnswer>;
  /** New operations, written whole (a starter, or one only this system has). */
  operations?: PlatformOperation[];
  skills?: SkillAnswer[];
}

export type StepState = 'done' | 'missing' | 'needs-code';
export interface OnboardingStep { id: string; title: string; state: StepState; missing: string[] }

export interface OnboardingPlan {
  /** `ready`: can be proposed. `incomplete`: answers are missing. `needs-code`: a template can't do this; nothing is written. */
  status: 'ready' | 'incomplete' | 'needs-code';
  steps: OnboardingStep[];
  /** What only AutoDE's code can add, said plainly. */
  neededCode: string[];
  definition?: PlatformDefinition;
  implementations: ImplementationFile[];
  operations: PlatformOperation[];
  skills: SkillAnswer[];
}

const TRANSPORTS = ['sql', 'cli', 'http', 'file'];
const SIGN_IN: ReadonlyArray<ApiAuth['method']> = ['bearer', 'basic', 'oauth_client_credentials'];
const COMPILE = ['snowflake', 'spark_sql', 'google_sql', 'postgres', 'tsql', 'redshift', 'ansi'];

const transportOf = (impl: PlatformImpl) => (impl.sql ? 'sql' : impl.cli ? 'cli' : impl.http ? 'http' : impl.file ? 'file' : undefined);

function definitionOf(a: OnboardingAnswers, capabilities: PlatformDefinition['capabilities']): PlatformDefinition {
  const rest: Record<string, unknown> = { ...a };
  for (const k of ['implementations', 'operations', 'skills']) delete rest[k];
  return { formatVersion: 1, ...rest, capabilities } as PlatformDefinition;
}

/** The capabilities the answers don't state, from the template: supported where every required operation has an implementation. */
function capabilitiesOf(a: OnboardingAnswers, t: CategoryTemplate | undefined): PlatformDefinition['capabilities'] {
  if (a.capabilities) return a.capabilities;
  const have = new Set(Object.keys(a.implementations ?? {}));
  const out: PlatformDefinition['capabilities'] = {};
  for (const [cap, c] of Object.entries(t?.capabilities ?? {})) {
    const ops = [...(c.operations ?? []), ...(c.optional ?? [])].filter((o) => have.has(o));
    if (ops.length || (!c.operations?.length && !c.optional?.length)) out[cap] = { support: (c.operations ?? []).every((o) => have.has(o)) ? 'supported' : 'partly', ...(ops.length ? { operations: ops } : {}), ...(c.note ? { note: c.note } : {}) };
  }
  return out;
}

/** The answers checked, step by step, and the files they make. Writes nothing. `catalog` is what the system is added to. */
export function planOnboarding(scope: { resourcesRoot?: string; workspaceRoot?: string }, a: OnboardingAnswers, catalog: Catalog = loadCatalog(scope)): OnboardingPlan {
  const templates = loadTemplates(scope.resourcesRoot);
  const t = a.category ? templates[a.category] : undefined;
  const neededCode: string[] = [];
  const step = (id: string, title: string, missing: string[], code: string[] = []): OnboardingStep => { neededCode.push(...code); return { id, title, state: code.length ? 'needs-code' : missing.length ? 'missing' : 'done', missing: [...missing, ...code] }; };
  const steps: OnboardingStep[] = [];

  const about: string[] = [];
  if (!a.id || !/^[a-z][a-z0-9_-]*$/.test(a.id)) about.push('id: lower case, digits, _ or -');
  if (!a.title || a.title.length < 2) about.push('title');
  if (a.id && catalog.platforms.some((p) => p.item.id === a.id && p.origin === 'shipped')) about.push(`${a.id} is already one of AutoDE's platforms: customise it instead (autode platform customise ${a.id})`);
  if (!t) about.push(`category: one of ${Object.keys(templates).join(', ')}`);
  steps.push(step('category', 'What it is', about));

  const given = (a.transports ?? []) as string[];
  const unknown = given.filter((x) => !TRANSPORTS.includes(x));
  steps.push(step('transports', 'How AutoDE reaches it', given.length ? [] : [`transports: from ${TRANSPORTS.join(', ')}`], unknown.map((x) => `A new transport (${x}): AutoDE reaches systems by ${TRANSPORTS.join(', ')}. Another protocol is code, written once for all systems that use it.`)));

  const access: string[] = [];
  const code: string[] = [];
  if (given.includes('sql') && !a.access?.cli?.statement) access.push('how a statement runs: access.cli.statement');
  if (given.includes('cli') && !a.access?.cli?.command) access.push('the CLI: access.cli.command, and how to install it (access.cli.install)');
  if (given.includes('http') && !a.access?.api?.baseUrlField) access.push('the API: access.api.name and access.api.baseUrlField');
  if (given.includes('file') && !a.access?.file?.rootField) access.push('the folder: access.file.rootField');
  for (const auth of a.access?.api?.auth ?? []) if (!SIGN_IN.includes(auth.method)) code.push(`A new sign-in method (${String(auth.method)}): AutoDE signs in to APIs with ${SIGN_IN.join(', ')}. Another is code, written once, never per platform.`);
  steps.push(step('access', 'Access paths', access, code));

  const fields = a.connection?.fields ?? [];
  steps.push(step('connection', 'Connection fields', fields.length ? [] : ['connection.fields: what a connection is made of (no secret values: a field marked secret is supplied at the call)']));

  const impls = a.implementations ?? {};
  const newOps = [...(a.operations ?? [])];
  const covers = (id: string) => !!impls[id] || newOps.some((o) => o.id === id && !!a.id && !!o.platforms[a.id]);
  const version: string[] = [];
  if (!a.versionOperation) version.push('versionOperation: the read that proves a connection works and gives the version');
  else if (!covers(a.versionOperation)) version.push(`an implementation of ${a.versionOperation}`);
  steps.push(step('version', 'Version detection', version));

  const opMissing: string[] = [];
  const opFiles: ImplementationFile[] = [];
  const merged = new Map(catalog.operations.filter((o) => o.status === 'approved').map((o) => [o.item.id, o.item] as const));
  for (const o of newOps) merged.set(o.id, o);
  for (const [cap, c] of Object.entries(t?.capabilities ?? {})) {
    if (!c.required) continue;
    for (const id of c.operations ?? []) if (!covers(id)) opMissing.push(`${cap} needs an implementation of ${id}`);
  }
  const defined = new Map<string, PlatformDefinition>();
  if (a.id) {
    for (const [id, answer] of Object.entries(impls)) {
      const starter = t?.starter?.find((s) => s.id === id);
      const op = merged.get(id) ?? (starter ? { formatVersion: 1, ...starter, platforms: {} } as PlatformOperation : undefined);
      if (!op) { opMissing.push(`${id} isn't in the catalog: add it to operations, whole`); continue; }
      const via = transportOf(answer?.implementation ?? {});
      if (!via) { opMissing.push(`${id}: fill in its implementation (sql, cli, http or file)`); continue; }
      if (!given.includes(via)) opMissing.push(`${id} uses ${via}, which isn't in transports`);
      const example = answer.example ? { ...answer.example, platform: a.id } : undefined;
      const file: ImplementationFile = { formatVersion: 1, implements: id, platform: a.id, implementation: answer.implementation, ...(answer.example ? { example: answer.example } : {}) };
      if (!merged.has(id) && starter) newOps.push({ ...op, platforms: { [a.id]: answer.implementation }, ...(example ? { example } : {}) });
      else if (!newOps.some((o) => o.id === id)) opFiles.push(file);
      opMissing.push(...checkOperation({ ...op, platforms: { [a.id]: answer.implementation }, ...(example ? { example } : { example: undefined }) } as PlatformOperation, defined).map((e) => `${id}: ${e}`));
      if (op.kind === 'read' && !answer.example?.rows?.length) opMissing.push(`${id} has no recorded example: the parameters it ran with and a row the platform returned`);
    }
    for (const o of a.operations ?? []) {
      opMissing.push(...checkOperation(o, defined).map((e) => `${o.id}: ${e}`));
      if (o.kind === 'read' && !o.example?.rows?.length) opMissing.push(`${o.id} has no recorded example: the parameters it ran with and a row the platform returned`);
    }
  }
  steps.push(step('operations', 'Starter operations', opMissing));

  const skills = a.skills ?? [];
  const skillsMissing = (t?.skills ?? []).filter((s) => a.id && !skills.some((k) => k.name === skillName(a.id!, s))).map((s) => `the ${s} skill: how to install, sign in and troubleshoot (${skillName(a.id ?? 'x', s)}); autode platform template gives its outline`);
  steps.push(step('skills', 'Skills', skillsMissing));

  const compile = a.capabilities?.['compile.target'];
  if (compile && compile.support !== 'not_applicable' && !COMPILE.includes(String(a.dialect?.compile))) {
    const s = step('compile', 'Compiling to it', [], [`A new compile dialect: AutoDE compiles deliverables to ${COMPILE.join(', ')}. Pipeline SQL for another dialect is transform code driven by primitive definitions. Leave compile.target out to onboard the system as a source.`]);
    steps.push(s);
  }

  const capabilities = capabilitiesOf(a, t);
  const definition = a.id ? definitionOf(a, capabilities) : undefined;
  if (definition) {
    const problems = checkPlatform(definition).filter((p) => !(steps.find((s) => s.id === 'category')!.missing.length && /title|category/.test(p)));
    if (problems.length && steps.every((s) => s.state === 'done')) steps.push(step('definition', 'The definition', problems));
  }
  const status = neededCode.length ? 'needs-code' : steps.every((s) => s.state === 'done') ? 'ready' : 'incomplete';
  return { status, steps, neededCode: [...new Set(neededCode)], ...(definition ? { definition } : {}), implementations: opFiles, operations: newOps, skills };
}

export function skillName(platformId: string, purpose: string): string {
  return `${platformId.replace(/_/g, '-')}-${purpose}`;
}

/** What `autode platform template <category>` gives: the answers to fill in. */
export function templateAnswers(scope: { resourcesRoot?: string }, category: string, id = 'my_system'): Record<string, unknown> {
  const t = loadTemplates(scope.resourcesRoot)[category];
  if (!t) throw new Error(`No category ${category} (${Object.keys(loadTemplates(scope.resourcesRoot)).join(', ')}).`);
  const needed = Object.values(t.capabilities).flatMap((c) => (c.required ? c.operations ?? [] : []));
  const blank = { implementation: { '<sql | cli | http | file>': '...' }, example: { params: {}, rows: [{ '<column>': '<what the platform returned>' }] } };
  return {
    id, title: 'My System', category, transports: t.transports.slice(0, 1), access: {}, connection: { fields: [{ name: 'name', label: 'Name', required: true }], idFields: ['name'], roles: ['source'] },
    versionOperation: 'platform.version', implementations: Object.fromEntries(['platform.version', ...needed].map((o) => [o, blank])),
    skills: (t.skills ?? []).map((s) => ({ name: skillName(id, s), description: `Set up ${id}: installing what it needs, signing in, and what to do when it fails.`, body: '# Set up\n\n## Install\n\n## Sign in (non-interactive)\n\n## Troubleshooting\n' }))
  };
}

/** The answers that describe a platform already in the catalog: a starting point for a similar system, and the check that the template can express it. */
export function answersFrom(catalog: Catalog, platformId: string): OnboardingAnswers {
  const p = catalog.platforms.find((x) => x.item.id === platformId && x.status === 'approved')?.item;
  if (!p) throw new Error(`No platform ${platformId}.`);
  const rest: OnboardingAnswers = { ...p };
  delete (rest as { formatVersion?: number }).formatVersion;
  const implementations: Record<string, ImplementationAnswer> = {};
  const operations: PlatformOperation[] = [];
  for (const o of catalog.operations) {
    const impl = o.status === 'approved' ? o.item.platforms[platformId] : undefined;
    if (!impl) continue;
    // Only this platform has it: without the platform there is no operation to add to, so it travels whole.
    if (Object.keys(o.item.platforms).length === 1) { operations.push(o.item); continue; }
    const ex = o.item.example && (o.item.example.platform ?? Object.keys(o.item.platforms)[0]) === platformId ? { params: o.item.example.params, rows: o.item.example.rows } : undefined;
    implementations[o.item.id] = { implementation: impl, ...(ex ? { example: ex } : {}) };
  }
  return { ...rest, implementations, ...(operations.length ? { operations } : {}) };
}

/**
 * A starting point for a similar system: everything `answersFrom` gives, as this system's own. Every operation
 * becomes an implementation to adapt, since the catalog keeps the original's. Recorded examples are left out: they are
 * what another platform returned, so they prove nothing here.
 */
export function likeAnswers(catalog: Catalog, platformId: string, id: string, title: string): OnboardingAnswers {
  const a = answersFrom(catalog, platformId);
  const implementations: Record<string, ImplementationAnswer> = {};
  for (const [op, answer] of Object.entries(a.implementations ?? {})) implementations[op] = { implementation: answer.implementation };
  for (const o of a.operations ?? []) implementations[o.id] = { implementation: o.platforms[platformId] };
  const rest: OnboardingAnswers = { ...a, id, title, implementations };
  delete rest.operations;
  return rest;
}

const rel = (root: string, full: string) => path.relative(root, full).split(path.sep).join('/');

function write(full: string, text: string): void {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

function writeSkill(scope: OnboardingScope, s: SkillAnswer, by: string, now: string): string {
  const dir = layoutPath(scope.workspaceRoot, 'toolSkills', s.name);
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) return rel(scope.workspaceRoot, dir);
  write(path.join(dir, 'SKILL.md'), `---\n${stringifyYaml({ name: s.name, description: s.description }).trimEnd()}\n---\n${s.body.trimEnd()}\n`);
  const checksum = skillContentChecksum(dir);
  writeSidecarFile(dir, { status: 'draft', version: 1, trustTier: 'unreviewed', provenance: { source: 'local', location: 'platform onboarding', contentChecksum: checksum, importedAt: now }, transitions: [{ at: now, by, action: 'import', to: 'draft', version: 1, checksum }] });
  return rel(scope.workspaceRoot, dir);
}

/** Writes the checked files and the one decision that approves them all; the skills stay drafts until published. */
export function proposeOnboarding(scope: OnboardingScope, answers: OnboardingAnswers, proposer: Proposer, now = new Date()): { decision: Decision; files: BundleFile[]; skills: string[] } {
  const plan = planOnboarding(scope, answers);
  if (plan.status !== 'ready' || !plan.definition) throw new OnboardingError(plan);
  const id = plan.definition.id;
  const files: BundleFile[] = [];
  const put = (what: BundleFile['what'], key: string, full: string, value: unknown) => {
    const text = stringifyYaml(value);
    write(full, text);
    files.push({ what, id: key, file: rel(scope.workspaceRoot, full), checksum: checksumOf(text) });
  };
  put('platforms', id, layoutPath(scope.workspaceRoot, 'platformDefinitions', `${id}.yaml`), plan.definition);
  for (const o of plan.operations) put('operations', o.id, layoutPath(scope.workspaceRoot, 'platformOperations', `${o.id}.yaml`), o);
  for (const f of plan.implementations) put('implementations', `${f.implements}@${id}`, layoutPath(scope.workspaceRoot, 'platformImplementations', `${f.implements}.${id}.yaml`), f);
  write(layoutPath(scope.workspaceRoot, 'platformOnboarding', `${id}.yaml`), stringifyYaml(answers));
  const skills = plan.skills.map((s) => writeSkill(scope, s, proposer.client ?? proposer.host ?? 'onboarding', now.toISOString()));
  const store = new DecisionStore(scope.workspaceRoot);
  for (const d of store.list({ status: 'pending', kind: 'platform_bundle' })) {
    if (store.proposal<PlatformBundlePayload>(d.id)?.platform === id) store.markSuperseded(d.id, 'A newer proposal of the same system replaces it.');
  }
  const payload: PlatformBundlePayload = { title: `Onboard ${plan.definition.title}`, platform: id, reason: `A new ${plan.definition.category} system, from the onboarding template.`, files };
  const decision = propose(store, { workspaceRoot: scope.workspaceRoot, resourcesRoot: scope.resourcesRoot }, 'platform_bundle', payload, { proposedBy: proposer });
  return { decision, files, skills };
}

export class OnboardingError extends Error {
  public constructor(public readonly plan: OnboardingPlan) {
    super(plan.status === 'needs-code' ? `This needs code, so nothing was written: ${plan.neededCode.join(' ')}` : `Not ready, so nothing was written: ${plan.steps.flatMap((s) => s.missing).join('; ')}`);
    this.name = 'OnboardingError';
  }
}

export type OnboardingState = 'none' | 'draft' | 'trial' | 'counted';

/**
 * Where a system is in onboarding. `none`: it didn't come through onboarding (a shipped platform, or a pack's, which
 * had its review on import). `draft`: not yet approved. `trial`: approved, its conformance not yet reviewed for this content.
 */
export function onboardingState(scope: { resourcesRoot?: string; workspaceRoot?: string }, platformId: string, catalog?: Catalog): OnboardingState {
  if (!scope.workspaceRoot || !fs.existsSync(layoutPath(scope.workspaceRoot, 'platformOnboarding', `${platformId}.yaml`))) return 'none';
  const c = catalog ?? loadCatalog(scope);
  const def = c.platforms.find((p) => p.item.id === platformId && p.status === 'approved');
  if (!def) return 'draft';
  return readApprovals(scope.workspaceRoot).conformance[platformId]?.checksum === def.checksum ? 'counted' : 'trial';
}

export function onTrial(scope: { resourcesRoot?: string; workspaceRoot?: string }, platformId: string, catalog?: Catalog): boolean {
  return onboardingState(scope, platformId, catalog) === 'trial';
}

function reviewableRun(scope: OnboardingScope, platformId: string): ConformanceResult | undefined {
  return Object.values(readConformance(scope.workspaceRoot)).filter((r) => r.platform === platformId).sort((x, y) => y.at.localeCompare(x.at))[0];
}

export interface OnboardingStatus {
  platform: string;
  state: OnboardingState;
  /** The last conformance run, if any. */
  conformance?: { connection: string; at: string; summary: string };
  /** The one thing to do next. */
  next: string;
}

export function onboardingStatus(scope: OnboardingScope, platformId: string): OnboardingStatus {
  const state = onboardingState(scope, platformId);
  const run = reviewableRun(scope, platformId);
  const conformance = run ? { connection: run.connection, at: run.at, summary: run.summary } : undefined;
  const pending = new DecisionStore(scope.workspaceRoot).list({ status: 'pending' }).find((d) => d.kind === 'platform_bundle' || d.kind === 'platform_conformance');
  const next = state === 'none' ? `${platformId} didn't come through onboarding: nothing to do here.`
    : state === 'draft' ? (pending ? `A person approves ${pending.id} (autode decisions approve ${pending.id}, or the panel). Until then nothing runs.` : `Propose it: autode platform onboard propose <answers.yaml>.`)
      : state === 'counted' ? `${platformId} is onboarded. Publish its skills (autode skills publish) for stages to use them.`
        : !run ? `Connect to a real ${platformId} and run a conformance: autode platform conformance <connection>. Until a person reviews one, only conformance and Try it read from it.`
          : pending?.kind === 'platform_conformance' ? `A person reviews ${pending.id}.`
            : `File the review of the last run: autode platform onboard review ${platformId}.`;
  return { platform: platformId, state, ...(conformance ? { conformance } : {}), next };
}

/** Files the review of the latest conformance run; a person approving it is what makes the system count. */
export function proposeConformanceReview(scope: OnboardingScope, platformId: string, proposer: Proposer): Decision {
  const catalog = loadCatalog(scope);
  const def = catalog.platforms.find((p) => p.item.id === platformId && p.status === 'approved');
  if (!def) throw new Error(`${platformId} isn't approved yet.`);
  const run = reviewableRun(scope, platformId);
  if (!run) throw new Error(`No conformance run on a ${platformId} connection yet: autode platform conformance <connection>.`);
  const payload: ConformanceReviewPayload = { platform: platformId, checksum: def.checksum, connection: run.connection, at: run.at, summary: run.summary };
  return propose(new DecisionStore(scope.workspaceRoot), { workspaceRoot: scope.workspaceRoot, resourcesRoot: scope.resourcesRoot }, 'platform_conformance', payload, { proposedBy: proposer });
}

