import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ToolExecutionMode, ToolSkillDefinition } from '../types';
import { loadToolSkill, loadToolSkillsFromDirectory } from './toolSkills';

/**
 * Tool-skill lifecycle, provenance, review and trust tiers (Phase S2 of
 * docs/mcp-engine-requirements.md §9.1).
 *
 * AutoDE owns one sidecar per imported skill, `<skill>/.autode-skill.json`, and
 * never modifies the foreign `SKILL.md`. Trust belongs to *content*: every
 * review records the checksum of what was reviewed, and a skill whose files have
 * changed since (a `git pull`, a hand edit) is unreviewed again until someone
 * looks at it. The transitions log is the source of truth; `trustTier` is the
 * tier of the content the sidecar was last written for.
 *
 * Published versions are snapshotted to `<skill>/.autode-history/v<N>/` (content plus
 * sidecar) so a pinned `skillVersion` keeps resolving after the live skill is
 * edited, re-published or deprecated.
 *
 * Plain `node:fs`, no `vscode` — the MCP server (phase 3) uses the same rules.
 */

export const SIDECAR_FILENAME = '.autode-skill.json';
/** Written into the tool-skills folder once its pre-S2 skills have been given sidecars. */
export const MIGRATION_MARKER = '.autode-skills-migrated';
const HISTORY_DIR = '.autode-history';
export const HISTORY_DIRNAME = HISTORY_DIR;
/** AutoDE's analysis of a ported skill (PA4, port.ts); like the sidecar, not part of the content. */
const ANALYSIS_FILE = '.autode-port.json';

export type ToolSkillStatus = 'draft' | 'published' | 'deprecated' | 'retired';
export type TrustTier = 'unreviewed' | 'reviewed' | 'trusted';
export const TRUST_TIERS: readonly TrustTier[] = ['unreviewed', 'reviewed', 'trusted'];

export interface ToolSkillProvenance {
  /** `dbt`: a skill found in a dbt package (PA4). */
  source: 'local' | 'git' | 'dbt';
  /** The local folder it was imported from (for Update Skill). */
  location?: string;
  /** SPDX id or name of the licence it carries. */
  licence?: string;
  repoUrl?: string;
  ref?: string;
  resolvedCommit?: string;
  subpath?: string;
  contentChecksum: string;
  importedAt: string;
}

export type ToolSkillAction = 'import' | 'update' | 'migrate' | 'review' | 'publish' | 'deprecate' | 'retire';

export interface ToolSkillTransition {
  at: string;
  by: string;
  action: ToolSkillAction;
  /** Status or tier before (absent on import/migrate). */
  from?: string;
  /** Status or tier after. */
  to: string;
  version: number;
  /** The content this transition applies to. */
  checksum: string;
}

export interface ToolSkillSidecar {
  status: ToolSkillStatus;
  version: number;
  provenance: ToolSkillProvenance;
  trustTier: TrustTier;
  /** Checksum of the content as last published (what `version` names). */
  publishedChecksum?: string;
  transitions: ToolSkillTransition[];
}

/** A skill with its lifecycle state, as the run picker, the review screen and the MCP registry see it. */
export interface ToolSkillState {
  skill: ToolSkillDefinition;
  sidecar: ToolSkillSidecar;
  /** Checksum of the files on disk now. */
  checksum: string;
  /** The tier of the content on disk — `unreviewed` if it changed since its last review. */
  effectiveTier: TrustTier;
  /** True when a tier was granted to earlier content but the files have changed since. */
  changedSinceReview: boolean;
}

// ── Content checksum ────────────────────────────────────────────────────────

function listFiles(dir: string, rel = ''): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (!rel && (e.name === SIDECAR_FILENAME || e.name === HISTORY_DIR || e.name === ANALYSIS_FILE)) continue;
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/**
 * SHA-256 over every file of the skill (path and bytes, sorted by path),
 * excluding AutoDE's sidecar and the history snapshots. Line endings are
 * normalised so a checkout with `core.autocrlf` does not revoke trust.
 */
export function skillContentChecksum(skillDir: string): string {
  const h = crypto.createHash('sha256');
  for (const rel of listFiles(skillDir).sort()) {
    const buf = fs.readFileSync(path.join(skillDir, rel));
    const isText = !buf.subarray(0, 8000).includes(0);
    h.update(rel).update('\0').update(isText ? Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8') : buf).update('\0');
  }
  return h.digest('hex');
}

// ── Sidecar I/O ─────────────────────────────────────────────────────────────

export function readSidecar(skillDir: string): ToolSkillSidecar | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(skillDir, SIDECAR_FILENAME), 'utf8')) as Partial<ToolSkillSidecar>;
    if (!raw || typeof raw !== 'object' || !raw.provenance) return undefined;
    return {
      status: (['draft', 'published', 'deprecated', 'retired'] as const).includes(raw.status as ToolSkillStatus) ? raw.status as ToolSkillStatus : 'draft',
      version: Number.isInteger(raw.version) && (raw.version as number) > 0 ? raw.version as number : 1,
      provenance: raw.provenance,
      trustTier: TRUST_TIERS.includes(raw.trustTier as TrustTier) ? raw.trustTier as TrustTier : 'unreviewed',
      publishedChecksum: raw.publishedChecksum,
      transitions: Array.isArray(raw.transitions) ? raw.transitions : []
    };
  } catch {
    return undefined;
  }
}

export function writeSidecarFile(skillDir: string, sidecar: ToolSkillSidecar): void {
  writeSidecar(skillDir, sidecar);
}

function writeSidecar(skillDir: string, sidecar: ToolSkillSidecar): void {
  const file = path.join(skillDir, SIDECAR_FILENAME);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sidecar, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// ── Trust ───────────────────────────────────────────────────────────────────

/** The tier granted to this exact content: the last review (or migration) of that checksum, else unreviewed. */
export function tierForChecksum(sidecar: ToolSkillSidecar, checksum: string): TrustTier {
  for (let i = sidecar.transitions.length - 1; i >= 0; i--) {
    const t = sidecar.transitions[i];
    if ((t.action === 'review' || t.action === 'migrate') && t.checksum === checksum && TRUST_TIERS.includes(t.to as TrustTier)) return t.to as TrustTier;
  }
  return 'unreviewed';
}

/** The highest mode a tier allows: unreviewed none, reviewed read-only, trusted full. */
export function tierModeCeiling(tier: TrustTier): ToolExecutionMode {
  return tier === 'trusted' ? 'full' : tier === 'reviewed' ? 'read-only' : 'none';
}

const MODE_RANK: Record<ToolExecutionMode, number> = { none: 0, 'read-only': 1, full: 2 };

/** The lower of two modes. */
export function minMode(a: ToolExecutionMode, b: ToolExecutionMode): ToolExecutionMode {
  return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}

/** Only trusted skills may run through Claude Code, whose own tool loop AutoDE cannot audit call by call. */
export function isClaudeCliEligible(tier: TrustTier): boolean {
  return tier === 'trusted';
}

/**
 * Whether a skill may run. Unpinned runs (the picker, `/skill <id>`) need a
 * published skill; a pinned version also resolves when deprecated. Retired and
 * draft skills never run, and an unreviewed one never does either.
 */
export function isSkillRunnable(state: Pick<ToolSkillState, 'sidecar' | 'effectiveTier'>, options: { pinned?: boolean } = {}): boolean {
  const s = state.sidecar.status;
  const statusOk = s === 'published' || (options.pinned === true && s === 'deprecated');
  return statusOk && state.effectiveTier !== 'unreviewed';
}

/** Whether a skill is offered to other agents as an MCP prompt (§5.4): published and reviewed or trusted, for its current content. */
export function isSkillExposable(state: Pick<ToolSkillState, 'sidecar' | 'effectiveTier'>): boolean {
  return state.sidecar.status === 'published' && state.effectiveTier !== 'unreviewed';
}

/** Why a skill cannot run — for the error a user sees. */
export function notRunnableReason(state: ToolSkillState, options: { pinned?: boolean } = {}): string | undefined {
  if (isSkillRunnable(state, options)) return undefined;
  const s = state.sidecar.status;
  if (s === 'retired') return `Skill "${state.skill.name}" is retired.`;
  if (s === 'draft') return `Skill "${state.skill.name}" is a draft — publish it first.`;
  if (s === 'deprecated' && !options.pinned) return `Skill "${state.skill.name}" is deprecated; only plan steps pinned to one of its versions still run it.`;
  return state.changedSinceReview
    ? `Skill "${state.skill.name}" changed since it was reviewed — run "AutoDE: Review Tool Skill" again.`
    : `Skill "${state.skill.name}" has not been reviewed — run "AutoDE: Review Tool Skill" first.`;
}

// ── Loading with state (and the one-time migration) ─────────────────────────

function stateOf(skill: ToolSkillDefinition, sidecar: ToolSkillSidecar, checksum = skillContentChecksum(skill.sourceDir)): ToolSkillState {
  const effectiveTier = tierForChecksum(sidecar, checksum);
  const reviews = sidecar.transitions.filter((t) => t.action === 'review' || t.action === 'migrate');
  const changedSinceReview = !reviews.some((t) => t.checksum === checksum) && reviews.some((t) => t.to !== 'unreviewed');
  return { skill, sidecar, checksum, effectiveTier, changedSinceReview };
}

/**
 * Gives every skill that predates S2 a sidecar — published, version 1, trusted,
 * for its current content — once per tool-skills folder (a marker records it).
 * After that, a skill folder without a sidecar (e.g. copied in by hand) is
 * unreviewed: "no sidecar = trusted" holds only for what was there at upgrade.
 */
export function migrateToolSkills(toolSkillsDir: string, by: string, now = new Date().toISOString()): string[] {
  if (!fs.existsSync(toolSkillsDir) || fs.existsSync(path.join(toolSkillsDir, MIGRATION_MARKER))) return [];
  const migrated: string[] = [];
  for (const skill of loadToolSkillsFromDirectory(toolSkillsDir)) {
    if (readSidecar(skill.sourceDir)) continue;
    const checksum = skillContentChecksum(skill.sourceDir);
    writeSidecar(skill.sourceDir, {
      status: 'published', version: 1, trustTier: 'trusted', publishedChecksum: checksum,
      provenance: { source: 'local', contentChecksum: checksum, importedAt: now },
      transitions: [{ at: now, by, action: 'migrate', to: 'trusted', version: 1, checksum }]
    });
    migrated.push(skill.id);
  }
  fs.writeFileSync(path.join(toolSkillsDir, MIGRATION_MARKER), `Tool skills present before v0.34.0 were given sidecars (trusted) on ${now}. Skills without a sidecar are unreviewed from now on.\n`);
  return migrated;
}

/** A skill without a sidecar after migration: unreviewed, published (nothing to publish without lifecycle management). */
function defaultSidecar(skillDir: string): ToolSkillSidecar {
  const checksum = skillContentChecksum(skillDir);
  return { status: 'published', version: 1, trustTier: 'unreviewed', publishedChecksum: checksum, provenance: { source: 'local', contentChecksum: checksum, importedAt: '' }, transitions: [] };
}

/**
 * Every imported skill with its lifecycle state (migrating pre-S2 skills
 * first). `migrate: false` is for readers that must not write — the MCP
 * server: there, an unmigrated pre-S2 skill counts as unreviewed until the
 * extension has migrated it.
 */
export function loadToolSkillStates(toolSkillsDir: string, by = 'autode', options: { migrate?: boolean } = {}): ToolSkillState[] {
  if (options.migrate !== false) migrateToolSkills(toolSkillsDir, by);
  return loadToolSkillsFromDirectory(toolSkillsDir).map((skill) => stateOf(skill, readSidecar(skill.sourceDir) ?? defaultSidecar(skill.sourceDir)));
}

export function loadToolSkillState(toolSkillsDir: string, skillId: string, by = 'autode'): ToolSkillState | undefined {
  return loadToolSkillStates(toolSkillsDir, by).find((s) => s.skill.id === skillId);
}

/**
 * The skill a run uses. Unpinned: the files on disk. Pinned to `version`: the
 * live files if they are still exactly that published version, else the
 * snapshot in `.autode-history/v<N>/` — with the tier granted to that content.
 */
export function resolveSkillVersion(toolSkillsDir: string, skillId: string, version?: number, by = 'autode'): ToolSkillState | undefined {
  const live = loadToolSkillState(toolSkillsDir, skillId, by);
  if (!live || version === undefined) return live;
  if (version === live.sidecar.version && live.sidecar.publishedChecksum === live.checksum && live.sidecar.status !== 'draft') return live;
  const snapDir = path.join(live.skill.sourceDir, HISTORY_DIR, `v${version}`);
  if (!fs.existsSync(path.join(snapDir, 'SKILL.md'))) return undefined;
  const snap = readSidecar(snapDir);
  if (!snap) return undefined;
  const skill = loadToolSkill(snapDir, skillId);
  const checksum = skillContentChecksum(snapDir);
  // Status is the live skill's (a retired skill stays retired for every version); trust is the snapshot content's, from the live log.
  return stateOf(skill, { ...snap, status: live.sidecar.status, transitions: live.sidecar.transitions }, checksum);
}

// ── Transitions ─────────────────────────────────────────────────────────────

const SCRIPT_FILE = /\.(sh|bash|zsh|ps1|psm1|py|js|mjs|cjs|ts|rb|pl|cmd|bat)$/i;
const ACTING_TOOL = /^(write|edit|multiedit|notebookedit|bash|shell|powershell|autode_write_file|autode_run_command)$/i;

/** Why a skill acts on its own (scripts, write or command tools), or undefined: such a skill isn't published unreviewed (PA4). */
export function actsOnItsOwn(skillDir: string): string | undefined {
  const scripts = listFiles(skillDir).filter((f) => SCRIPT_FILE.test(f) || f.startsWith('scripts/'));
  if (scripts.length) return `carries scripts (${scripts.slice(0, 3).join(', ')}${scripts.length > 3 ? ', …' : ''})`;
  let declared: string[] = [];
  try { declared = loadToolSkill(skillDir).declaredTools ?? []; } catch { return undefined; }
  const acting = declared.filter((t) => ACTING_TOOL.test(t.split('(')[0].trim()));
  return acting.length ? `declares tools that write or run commands (${acting.join(', ')})` : undefined;
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const rel of listFiles(from)) {
    fs.mkdirSync(path.dirname(path.join(to, rel)), { recursive: true });
    fs.copyFileSync(path.join(from, rel), path.join(to, rel));
  }
}

function snapshot(skillDir: string, sidecar: ToolSkillSidecar): void {
  const dir = path.join(skillDir, HISTORY_DIR, `v${sidecar.version}`);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  copyDir(skillDir, dir);
  writeSidecar(dir, sidecar);
}

/**
 * Records a freshly imported skill: unreviewed, version 1; `draft` when
 * lifecycle management is on (publish it to run it), else `published`.
 */
export function recordImport(skillDir: string, provenance: Omit<ToolSkillProvenance, 'contentChecksum' | 'importedAt'>, by: string, options: { managementEnabled?: boolean; now?: string } = {}): ToolSkillSidecar {
  const now = options.now ?? new Date().toISOString();
  const checksum = skillContentChecksum(skillDir);
  const status: ToolSkillStatus = options.managementEnabled ? 'draft' : 'published';
  const sidecar: ToolSkillSidecar = {
    status, version: 1, trustTier: 'unreviewed', publishedChecksum: status === 'published' ? checksum : undefined,
    provenance: { ...provenance, contentChecksum: checksum, importedAt: now },
    transitions: [{ at: now, by, action: 'import', to: status, version: 1, checksum }]
  };
  writeSidecar(skillDir, sidecar);
  if (status === 'published') snapshot(skillDir, sidecar);
  // Migrate the folder's other pre-S2 skills now (this one already has its sidecar), so the marker exists from the first import on.
  migrateToolSkills(path.dirname(skillDir), by, now);
  return sidecar;
}

function current(skillDir: string): { sidecar: ToolSkillSidecar; checksum: string } {
  const sidecar = readSidecar(skillDir) ?? defaultSidecar(skillDir);
  return { sidecar, checksum: skillContentChecksum(skillDir) };
}

/** Grants (or withdraws) a tier for the skill's current content. Not gated by lifecycle management: it is how any imported skill becomes runnable. */
export function setTrustTier(skillDir: string, tier: TrustTier, by: string, now = new Date().toISOString()): ToolSkillSidecar {
  const { sidecar, checksum } = current(skillDir);
  const from = tierForChecksum(sidecar, checksum);
  const updated: ToolSkillSidecar = {
    ...sidecar, trustTier: tier,
    transitions: [...sidecar.transitions, { at: now, by, action: 'review', from, to: tier, version: sidecar.version, checksum }]
  };
  writeSidecar(skillDir, updated);
  return updated;
}

/**
 * Publishes the skill's current content. A first publish keeps the version; a
 * re-publish of changed content bumps it. Each published version is
 * snapshotted to `.autode-history/v<N>/`. Publishing the same content again is refused.
 */
export function publishToolSkill(skillDir: string, by: string, now = new Date().toISOString()): { sidecar: ToolSkillSidecar; versionBumped: boolean } {
  const { sidecar, checksum } = current(skillDir);
  if (sidecar.status === 'retired') throw new Error('A retired skill cannot be published again; import it anew.');
  const wasPublished = sidecar.publishedChecksum !== undefined;
  if (wasPublished && sidecar.publishedChecksum === checksum && sidecar.status === 'published') throw new Error(`Version ${sidecar.version} is already published with this content.`);
  if (tierForChecksum(sidecar, checksum) === 'unreviewed') {
    const acts = actsOnItsOwn(skillDir);
    if (acts) throw new Error(`Review it before publishing: it ${acts}.`);
  }
  const versionBumped = wasPublished && sidecar.publishedChecksum !== checksum;
  const version = versionBumped ? sidecar.version + 1 : sidecar.version;
  const updated: ToolSkillSidecar = {
    ...sidecar, status: 'published', version, publishedChecksum: checksum, trustTier: tierForChecksum(sidecar, checksum),
    transitions: [...sidecar.transitions, { at: now, by, action: 'publish', from: sidecar.status, to: 'published', version, checksum }]
  };
  writeSidecar(skillDir, updated);
  snapshot(skillDir, updated);
  return { sidecar: updated, versionBumped };
}

function setStatus(skillDir: string, action: 'deprecate' | 'retire', to: ToolSkillStatus, allowedFrom: readonly ToolSkillStatus[], by: string, now: string): ToolSkillSidecar {
  const { sidecar, checksum } = current(skillDir);
  if (!allowedFrom.includes(sidecar.status)) throw new Error(`Cannot ${action} a ${sidecar.status} skill.`);
  const updated: ToolSkillSidecar = {
    ...sidecar, status: to,
    transitions: [...sidecar.transitions, { at: now, by, action, from: sidecar.status, to, version: sidecar.version, checksum }]
  };
  writeSidecar(skillDir, updated);
  return updated;
}

/** Deprecated: no longer offered or exposed; plan steps pinned to one of its versions still run. */
export function deprecateToolSkill(skillDir: string, by: string, now = new Date().toISOString()): ToolSkillSidecar {
  return setStatus(skillDir, 'deprecate', 'deprecated', ['published'], by, now);
}

/** Retired: never runs again, pinned or not. Its history stays on disk for audit. */
export function retireToolSkill(skillDir: string, by: string, now = new Date().toISOString()): ToolSkillSidecar {
  return setStatus(skillDir, 'retire', 'retired', ['draft', 'published', 'deprecated'], by, now);
}

// ── Review screen ───────────────────────────────────────────────────────────

/** The review document: everything the skill would act with, in one read-only page. */
export function buildSkillReviewDocument(state: ToolSkillState, allowedTools: readonly string[] | undefined): string {
  const { skill, sidecar } = state;
  const raw = fs.readFileSync(path.join(skill.sourceDir, 'SKILL.md'), 'utf8');
  const p = sidecar.provenance;
  const resources = skill.resourceFiles;
  const lines = [
    `# Review tool skill: ${skill.name}`,
    '',
    `- **Id:** ${skill.id} · **Status:** ${sidecar.status} · **Version:** ${sidecar.version}`,
    `- **Trust for this content:** ${state.effectiveTier}${state.changedSinceReview ? ' — the files changed since the last review' : ''}`,
    `- **Provenance:** ${p.source}${p.repoUrl ? ` ${p.repoUrl}` : ''}${p.ref ? `@${p.ref}` : ''}${p.resolvedCommit ? ` (${p.resolvedCommit})` : ''}${p.subpath ? ` /${p.subpath}` : ''}${p.importedAt ? `, imported ${p.importedAt}` : ''}`,
    `- **Content checksum:** \`${state.checksum}\``,
    `- **Declared tools:** ${skill.declaredTools?.length ? skill.declaredTools.join(', ') : '(none declared — no extra restriction)'}`,
    `- **AutoDE tools it would get:** ${allowedTools === undefined ? 'all workspace tools' : allowedTools.length ? allowedTools.join(', ') : 'none'}`,
    '',
    '## What each tier allows',
    '',
    '- **Reviewed:** runs with read-only tools at most; not through Claude Code.',
    '- **Trusted:** may write files and run commands (each approved individually), and may run through Claude Code (approved once per run, not auditable per call).',
    '- **Unreviewed:** does not run and is not offered to other agents.',
    '',
    `## Resource files (${resources.length})`,
    '',
    ...(resources.length ? resources.map((f) => `- ${f}`) : ['(none)']),
    '',
    '## SKILL.md (verbatim)',
    '',
    '````markdown',
    raw.replace(/\r\n/g, '\n').trimEnd(),
    '````'
  ];
  if (sidecar.transitions.length) {
    lines.push('', '## History', '', ...sidecar.transitions.map((t) => `- ${t.at} — ${t.by}: ${t.action}${t.from ? ` ${t.from} →` : ''} ${t.to} (v${t.version}, ${t.checksum.slice(0, 12)})`));
  }
  return lines.join('\n') + '\n';
}
