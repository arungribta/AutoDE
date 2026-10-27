import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSkillMarkdown } from './toolSkills';
import { resolveAllowedToolNames } from './toolAllowList';
import { HISTORY_DIRNAME, SIDECAR_FILENAME, ToolSkillProvenance, ToolSkillSidecar, loadToolSkillStates, recordImport, readSidecar, skillContentChecksum, writeSidecarFile } from './lifecycle';
import { ToolGuide, loadToolGuides } from '../platform/prerequisites';
import { layoutPath } from '../workspaceLayout';
import { PackSkill, SKILL_PLATFORMS, loadSkillPack } from '../agents/definitions';
import { STAGE_KINDS } from '../workflows/stageKinds';

/**
 * Port a skill (PA4, mcp-engine §9.2): bring a skill written for any agent into
 * AutoDE, from a local folder, a Git repository or a dbt package, without code.
 *
 * - **Staging** reads the source without copying anything into the workspace. A
 *   Git repository is cloned shallow and without checkout into a temporary folder;
 *   its file list is checked against the caps, for path escapes and for symlinks
 *   before any file is checked out. A local folder is walked the same way.
 * - **Analysis** is deterministic: frontmatter, declared and mentioned tools, CLIs
 *   and MCP servers, scripts, resources, size, licence, overlaps, and a heuristic
 *   class (knowledge or procedure). A model can propose a better class, tool mapping
 *   and prerequisites; that stays a proposal a person accepts.
 * - **The capability report** says what the skill does, what becomes an
 *   approval-gated decision, what it reads, whether it runs scripts, and the limit
 *   of §3.1 for skills that write or execute.
 * - **Import** copies the chosen skill into `.autode/config/skills/tool-skills/<id>/`,
 *   unreviewed (S2: trust is bound to the content checksum), with its provenance and
 *   analysis. **Update** re-fetches, shows a diff, and the new content is unreviewed.
 */

export type PortSourceKind = 'local' | 'git' | 'dbt';
export interface PortSource { kind: PortSourceKind; location: string; ref?: string }
export interface PortCaps { maxFiles: number; maxBytes: number; maxFileBytes: number }
/** A source (a whole repository or folder) and one skill in it. */
export const SOURCE_CAPS: PortCaps = { maxFiles: 2000, maxBytes: 30_000_000, maxFileBytes: 5_000_000 };
export const SKILL_CAPS: PortCaps = { maxFiles: 200, maxBytes: 5_000_000, maxFileBytes: 1_000_000 };
/** AutoDE's analysis of an imported skill, beside its sidecar (excluded from the content checksum). */
export const ANALYSIS_FILENAME = '.autode-port.json';

export class PortError extends Error {}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__']);
const AUTODE_FILES = new Set([SIDECAR_FILENAME, HISTORY_DIRNAME, ANALYSIS_FILENAME]);

export interface StagedSource {
  dir: string;
  provenance: Omit<ToolSkillProvenance, 'contentChecksum' | 'importedAt'>;
  files: number;
  bytes: number;
  cleanup(): void;
}

export type GitRunner = (args: string[], cwd?: string) => { status: number | null; stdout: string; stderr: string };
export const gitRunner: GitRunner = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? r.error.message : '') };
};

/** A path inside a skill or repository: relative, no `..`, no drive or root. */
function safeRelative(p: string): boolean {
  const n = p.replace(/\\/g, '/');
  return !!n && !n.startsWith('/') && !/^[A-Za-z]:/.test(n) && !n.split('/').some((s) => s === '..');
}

/** Walks a local folder within the caps; refuses symlinks (a skill is copied as plain files). */
function walk(root: string, caps: PortCaps, rel = '', acc = { files: 0, bytes: 0, list: [] as string[] }): typeof acc {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || (!rel && AUTODE_FILES.has(e.name))) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    const st = fs.lstatSync(path.join(root, r));
    if (st.isSymbolicLink()) throw new PortError(`${r} is a symbolic link: skills are imported as plain files.`);
    if (st.isDirectory()) { walk(root, caps, r, acc); continue; }
    if (!st.isFile()) continue;
    if (st.size > caps.maxFileBytes) throw new PortError(`${r} is ${st.size} bytes; the most a file may be is ${caps.maxFileBytes}.`);
    acc.files++; acc.bytes += st.size; acc.list.push(r);
    if (acc.files > caps.maxFiles) throw new PortError(`More than ${caps.maxFiles} files: too big to import.`);
    if (acc.bytes > caps.maxBytes) throw new PortError(`More than ${caps.maxBytes} bytes: too big to import.`);
  }
  return acc;
}

/**
 * Stages a source for discovery and analysis. Nothing reaches the workspace: a local folder is read in
 * place, a Git repository is cloned into a temporary folder and checked out only after its file list
 * passed the caps and the path checks.
 */
export function stageSource(src: PortSource, caps: PortCaps = SOURCE_CAPS, git: GitRunner = gitRunner): StagedSource {
  if (src.kind === 'local' || src.kind === 'dbt') {
    const dir = path.resolve(src.location);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new PortError(`${src.location} is not a folder.`);
    const w = walk(dir, caps);
    return { dir, provenance: { source: src.kind, location: dir }, files: w.files, bytes: w.bytes, cleanup: () => undefined };
  }
  if (!/^(https:\/\/|git@|ssh:\/\/|file:\/\/)/.test(src.location) && !fs.existsSync(src.location)) throw new PortError(`${src.location} is not a Git URL (https://, git@, ssh:// or file://) or a local repository.`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autode-port-'));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const clone = git(['clone', '--depth', '1', '--no-checkout', ...(src.ref ? ['--branch', src.ref] : []), '--', src.location, tmp]);
    if (clone.status !== 0) throw new PortError(`git clone failed: ${clone.stderr.trim().split('\n').pop() ?? 'unknown error'}`);
    const tree = git(['ls-tree', '-r', '-l', '-z', 'HEAD'], tmp);
    if (tree.status !== 0) throw new PortError(`Could not list the repository: ${tree.stderr.trim()}`);
    let files = 0, bytes = 0;
    for (const entry of tree.stdout.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      const [mode, , , size] = entry.slice(0, tab).split(/\s+/);
      const p = entry.slice(tab + 1);
      if (!safeRelative(p)) throw new PortError(`The repository has a path that escapes it: ${p}. Nothing was copied.`);
      if (mode === '120000') throw new PortError(`${p} is a symbolic link: skills are imported as plain files. Nothing was copied.`);
      if (mode === '160000') throw new PortError(`${p} is a Git submodule: import the submodule's repository directly. Nothing was copied.`);
      const n = Number(size) || 0;
      if (n > caps.maxFileBytes) throw new PortError(`${p} is ${n} bytes; the most a file may be is ${caps.maxFileBytes}. Nothing was copied.`);
      files++; bytes += n;
      if (files > caps.maxFiles) throw new PortError(`The repository has more than ${caps.maxFiles} files. Nothing was copied.`);
      if (bytes > caps.maxBytes) throw new PortError(`The repository is larger than ${caps.maxBytes} bytes. Nothing was copied.`);
    }
    const co = git(['checkout', '--quiet', 'HEAD', '--', '.'], tmp);
    if (co.status !== 0) throw new PortError(`git checkout failed: ${co.stderr.trim()}`);
    const commit = git(['rev-parse', 'HEAD'], tmp).stdout.trim();
    return { dir: tmp, provenance: { source: 'git', repoUrl: src.location, ref: src.ref, resolvedCommit: commit || undefined }, files, bytes, cleanup };
  } catch (err) { cleanup(); throw err; }
}

export interface DiscoveredSkill { subpath: string; name: string; description: string }

/** Every skill (a folder with SKILL.md) in a staged source, dbt packages' `dbt_packages/*` included. */
export function discoverSkills(stagedDir: string): DiscoveredSkill[] {
  const out: DiscoveredSkill[] = [];
  const visit = (rel: string, depth: number) => {
    if (depth > 6) return;
    const dir = path.join(stagedDir, rel);
    const md = path.join(dir, 'SKILL.md');
    if (fs.existsSync(md)) {
      const p = parseSkillMarkdown(fs.readFileSync(md, 'utf8'));
      out.push({ subpath: rel.replace(/\\/g, '/'), name: p.name ?? (path.basename(dir) || 'skill'), description: p.description ?? '' });
      return;
    }
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) visit(rel ? path.join(rel, e.name) : e.name, depth + 1);
  };
  visit('', 0);
  return out.sort((a, b) => a.subpath.localeCompare(b.subpath));
}

// ── Analysis ────────────────────────────────────────────────────────────────

export type SkillClass = 'knowledge' | 'procedure';

export interface LicenceInfo { name: string; spdx?: string; file?: string; redistribution: boolean | 'unknown'; note?: string }

export interface SkillAnalysis {
  id: string;
  name: string;
  description: string;
  subpath: string;
  files: number;
  bytes: number;
  /** As declared in `allowed-tools`. */
  declaredTools: string[];
  /** AutoDE's file and command tools they map to. */
  mappedTools: string[];
  /** Declared tools AutoDE has no counterpart for. */
  unmappedTools: string[];
  /** AutoDE engine tools it names (`mcp__autode__…`). */
  engineTools: string[];
  /** Other MCP servers it names (`mcp__<server>__…`). */
  mcpServers: string[];
  /** CLIs its instructions run, with AutoDE's install guide where there is one. */
  clis: Array<{ name: string; guide?: string }>;
  scripts: string[];
  resources: string[];
  /** It writes files or proposes changes (write tools, engine proposal tools). */
  writes: boolean;
  /** It runs scripts or commands. */
  executes: boolean;
  classification: { value: SkillClass; reason: string; by: 'heuristic' | 'model' | 'person' };
  licence?: LicenceInfo;
  overlaps: Array<{ with: string; why: string }>;
  /** AutoDE metadata it declares (stage kinds, platforms), when present. */
  autode?: { stageKinds: string[]; platforms: string[] };
  /** Reasons it can't be imported. */
  problems: string[];
  warnings: string[];
  /** A model's proposal (classification, tool mapping, prerequisites), never applied by itself. */
  proposal?: PortProposal;
}

const SCRIPT_EXT = /\.(sh|bash|zsh|ps1|psm1|py|js|mjs|cjs|ts|rb|pl|cmd|bat)$/i;
const WRITE_DECLARED = /^(write|edit|multiedit|notebookedit|bash|shell|powershell)$/i;
const KNOWN_CLIS: Record<string, string | undefined> = {
  snow: 'snowflake-cli', databricks: 'databricks-cli', dbt: undefined, git: undefined, python: undefined, python3: undefined, pip: undefined, uv: undefined,
  npm: undefined, npx: undefined, node: undefined, psql: undefined, sqlcmd: undefined, bq: undefined, aws: undefined, az: undefined, gcloud: undefined,
  terraform: undefined, kubectl: undefined, docker: undefined, curl: undefined, sqlplus: undefined
};
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'by', 'from', 'it', 'its', 'use', 'when', 'is', 'are', 'that', 'this', 'as', 'at', 'be', 'an', 'into', 'each', 'any', 'skill', 'autode', 'data']);

export function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** The licence a skill carries: its frontmatter `license`, else a LICENSE file in the skill or the repository. */
export function detectLicence(skillDir: string, repoRoot: string | undefined, declared: string | undefined): LicenceInfo | undefined {
  const files = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING'];
  const find = (dir: string) => files.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  const file = find(skillDir) ?? (repoRoot ? find(repoRoot) : undefined);
  const text = file ? fs.readFileSync(file, 'utf8').slice(0, 20_000) : '';
  const hay = `${declared ?? ''}\n${text}`;
  const rel = file ? path.relative(repoRoot ?? skillDir, file).replace(/\\/g, '/') : undefined;
  if (!hay.trim()) return undefined;
  if (/databricks license/i.test(hay)) return { name: 'Databricks License', file: rel, redistribution: false, note: 'Use only with Databricks Services; not redistributable. Reference it instead (the external skills catalog).' };
  if (/apache license[\s\S]{0,60}version 2\.0|\bapache-2\.0\b/i.test(hay)) return { name: 'Apache License 2.0', spdx: 'Apache-2.0', file: rel, redistribution: true, note: 'Keep the licence and the NOTICE file, if any, with the skill.' };
  if (/\bMIT License\b|permission is hereby granted, free of charge|^\s*MIT\s*$/im.test(hay)) return { name: 'MIT License', spdx: 'MIT', file: rel, redistribution: true, note: 'Keep the copyright notice with the skill.' };
  if (/\bBSD\b[\s\S]{0,40}licen[cs]e|redistribution and use in source and binary forms/i.test(hay)) return { name: 'BSD licence', spdx: 'BSD-3-Clause', file: rel, redistribution: true, note: 'Keep the copyright notice with the skill.' };
  if (/mozilla public license|\bMPL-2\.0\b/i.test(hay)) return { name: 'Mozilla Public License 2.0', spdx: 'MPL-2.0', file: rel, redistribution: true, note: 'Changes to its files stay under MPL-2.0.' };
  if (/gnu (affero |lesser )?general public license|\b(A|L)?GPL-[23]/i.test(hay)) return { name: 'GNU GPL family', file: rel, redistribution: true, note: 'Copyleft: check with your legal team before shipping it inside anything you distribute.' };
  if (/creative commons|\bCC-BY/i.test(hay)) return { name: 'Creative Commons', file: rel, redistribution: true, note: 'Keep the attribution the licence asks for.' };
  return { name: declared?.trim() || 'unrecognised licence', file: rel, redistribution: 'unknown', note: 'Read the licence before publishing the skill.' };
}

export interface AnalysisContext {
  /** Skills already in the workspace and AutoDE's own, for overlaps. */
  installed: ReadonlyArray<{ id: string; description: string }>;
  autode: ReadonlyArray<{ id: string; description: string }>;
  guides?: readonly ToolGuide[];
  /** The repository or folder the skill came from (for its licence). */
  repoRoot?: string;
  stageKinds?: readonly string[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill';

/** The deterministic analysis of one skill folder. */
export function analyzeSkill(skillDir: string, subpath: string, ctx: AnalysisContext): SkillAnalysis {
  const problems: string[] = [];
  const warnings: string[] = [];
  let listing = { files: 0, bytes: 0, list: [] as string[] };
  try { listing = walk(skillDir, SKILL_CAPS); } catch (err) { problems.push(err instanceof Error ? err.message : String(err)); }
  const mdFile = path.join(skillDir, 'SKILL.md');
  const raw = fs.existsSync(mdFile) ? fs.readFileSync(mdFile, 'utf8') : '';
  if (!raw) problems.push('There is no SKILL.md.');
  const parsed = parseSkillMarkdown(raw);
  const name = parsed.name?.trim() || path.basename(skillDir);
  const description = parsed.description?.trim() ?? '';
  if (!description) warnings.push('No description: hosts decide when to use a skill from its description.');
  const declared = parsed.allowedTools ?? [];
  const mapped = resolveAllowedToolNames(declared) ?? [];
  const engineTools = [...new Set(declared.map((t) => /^mcp__autode__(\w+)/.exec(t)?.[1]).filter((x): x is string => !!x))];
  const isMapped = (t: string) => (resolveAllowedToolNames([t]) ?? []).length > 0 || /^mcp__autode__/.test(t);
  const unmapped = declared.filter((t) => !isMapped(t) && !/^mcp__/.test(t));
  const body = parsed.body ?? raw;
  const mcpServers = [...new Set([...declared, ...body.match(/mcp__\w+__\w+/g) ?? []].map((t) => /^mcp__(\w+?)__/.exec(t)?.[1]).filter((x): x is string => !!x && x !== 'autode'))];
  const code = [...body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n') + '\n' + [...body.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).join('\n');
  const cliNames = new Set<string>();
  for (const line of code.split('\n')) {
    const first = line.trim().replace(/^\$\s*/, '').split(/\s+/)[0]?.toLowerCase() ?? '';
    if (first in KNOWN_CLIS && /\s/.test(line.trim())) cliNames.add(first);
  }
  const guideIds = new Set((ctx.guides ?? []).map((g) => g.id));
  const guideFor = (n: string) => { const g = KNOWN_CLIS[n]; return g && (!ctx.guides || guideIds.has(g)) ? g : undefined; };
  const clis = [...cliNames].sort().map((n) => ({ name: n, guide: guideFor(n) }));
  const scripts = listing.list.filter((f) => SCRIPT_EXT.test(f) || f.startsWith('scripts/'));
  const resources = listing.list.filter((f) => f !== 'SKILL.md' && !scripts.includes(f));
  const proposalTools = engineTools.filter((t) => /^autode_(propose|record|ingest|pack_add|pack_apply|interview_record|refresh)/.test(t));
  const writes = declared.some((t) => WRITE_DECLARED.test(t.split('(')[0].trim())) || proposalTools.length > 0;
  const executes = scripts.length > 0 || declared.some((t) => /^(bash|shell|powershell)$/i.test(t.split('(')[0].trim())) || clis.length > 0;
  const classification = { value: (executes || writes ? 'procedure' : 'knowledge') as SkillClass, by: 'heuristic' as const,
    reason: executes ? 'it runs scripts or commands' : writes ? 'it writes files or proposes changes' : 'it gives guidance and declares no tools that act' };
  const licence = detectLicence(skillDir, ctx.repoRoot, parsed.license);
  if (licence?.redistribution === false) problems.push(`Its licence (${licence.name}) doesn't allow copying it into your workspace. ${licence.note ?? ''}`.trim());
  if (!licence) warnings.push('No licence found: ask its author before sharing it with your team.');
  else if (licence.redistribution === 'unknown') warnings.push(`Licence not recognised (${licence.name}): read it before publishing.`);
  const id = slug(name);
  const overlaps: SkillAnalysis['overlaps'] = [];
  for (const s of ctx.installed) if (s.id === id) overlaps.push({ with: s.id, why: 'a skill with this id is already imported (importing replaces it)' });
  for (const s of ctx.autode) {
    if (s.id === id) overlaps.push({ with: s.id, why: 'the same name as an AutoDE skill' });
    else { const j = jaccard(words(`${name} ${description}`), words(s.description)); if (j >= 0.3) overlaps.push({ with: s.id, why: `similar purpose to AutoDE's skill (${Math.round(j * 100)}% of words in common)` }); }
  }
  let autode: SkillAnalysis['autode'];
  const meta = parsed.metadata ?? {};
  const kinds = Array.isArray(meta.stageKinds) ? (meta.stageKinds as unknown[]).map(String) : [];
  if (kinds.length) {
    const unknown = kinds.filter((k) => ctx.stageKinds && !ctx.stageKinds.includes(k));
    if (unknown.length) warnings.push(`metadata.stageKinds names unknown stage kinds: ${unknown.join(', ')}.`);
    autode = { stageKinds: kinds.filter((k) => !unknown.includes(k)), platforms: Array.isArray(meta.platforms) ? (meta.platforms as unknown[]).map(String) : ['any'] };
  }
  if (unmapped.length) warnings.push(`AutoDE has no counterpart for these declared tools: ${unmapped.join(', ')}. Where AutoDE runs it, the skill doesn't get them.`);
  if (mcpServers.length) warnings.push(`It uses other MCP servers (${mcpServers.join(', ')}): they must be configured in the host that runs it.`);
  return {
    id, name, description, subpath, files: listing.files, bytes: listing.bytes, declaredTools: declared, mappedTools: mapped, unmappedTools: unmapped,
    engineTools, mcpServers, clis, scripts, resources, writes, executes, classification, licence, overlaps, autode, problems, warnings
  };
}

// ── The model's proposal (classification, tool mapping, prerequisites) ─────

export interface PortProposal {
  classification: SkillClass;
  why: string;
  toolMapping: Array<{ mentioned: string; autodeTool: string | null; note?: string }>;
  prerequisites: Array<{ name: string; kind: 'cli' | 'mcp-server' | 'other'; note?: string }>;
  summary: string;
  /** `proposed` until a person accepts or edits it. */
  status: 'proposed' | 'accepted' | 'rejected';
}

export function buildPortAnalysisPrompt(a: SkillAnalysis, skillMd: string, autodeTools: readonly string[]): { system: string; user: string } {
  return {
    system: [
      'You review an agent skill that a data engineer wants to bring into AutoDE. You propose; the engineer decides.',
      'Respond with one JSON object only: { "classification": "knowledge" | "procedure", "why": "<one sentence>", "summary": "<what the skill does, two sentences>", "toolMapping": [ { "mentioned": "<tool or command the skill uses>", "autodeTool": "<one of the AutoDE tools listed, or null>", "note": "<optional>" } ], "prerequisites": [ { "name": "<CLI, MCP server or other>", "kind": "cli" | "mcp-server" | "other", "note": "<optional>" } ] }',
      'knowledge: guidance, conventions or reference an agent reads as context. procedure: steps an agent carries out with tools.',
      'Map only to the AutoDE tools listed; use null when none fits. List only prerequisites the skill actually needs.'
    ].join('\n'),
    user: [
      `## AutoDE tools\n${autodeTools.join(', ')}`,
      `## What AutoDE found\nDeclared tools: ${a.declaredTools.join(', ') || 'none'}. Scripts: ${a.scripts.join(', ') || 'none'}. CLIs: ${a.clis.map((c) => c.name).join(', ') || 'none'}. MCP servers: ${a.mcpServers.join(', ') || 'none'}.`,
      `## SKILL.md\n${skillMd.slice(0, 20_000)}`
    ].join('\n\n')
  };
}

export function parsePortProposal(raw: unknown, autodeTools: readonly string[]): { proposal?: PortProposal; errors: string[] } {
  const errors: string[] = [];
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const cls = o.classification;
  if (cls !== 'knowledge' && cls !== 'procedure') errors.push('classification is knowledge or procedure.');
  const known = new Set(autodeTools);
  const toolMapping = (Array.isArray(o.toolMapping) ? o.toolMapping : []).map((m) => m as Record<string, unknown>).filter((m) => typeof m.mentioned === 'string')
    .map((m) => ({ mentioned: String(m.mentioned), autodeTool: typeof m.autodeTool === 'string' && known.has(m.autodeTool) ? m.autodeTool : null, note: typeof m.note === 'string' ? m.note : undefined }));
  const prerequisites = (Array.isArray(o.prerequisites) ? o.prerequisites : []).map((p) => p as Record<string, unknown>).filter((p) => typeof p.name === 'string')
    .map((p) => ({ name: String(p.name), kind: (p.kind === 'cli' || p.kind === 'mcp-server' ? p.kind : 'other') as PortProposal['prerequisites'][number]['kind'], note: typeof p.note === 'string' ? p.note : undefined }));
  if (errors.length) return { errors };
  return { errors, proposal: { classification: cls as SkillClass, why: String(o.why ?? ''), summary: String(o.summary ?? ''), toolMapping, prerequisites, status: 'proposed' } };
}

/** A person's decision on the model's proposal: accepting it applies its classification. */
export function decideProposal(a: SkillAnalysis, decision: 'accept' | 'reject', classification?: SkillClass): SkillAnalysis {
  if (!a.proposal) return a;
  if (decision === 'reject') return { ...a, proposal: { ...a.proposal, status: 'rejected' } };
  const value = classification ?? a.proposal.classification;
  return { ...a, proposal: { ...a.proposal, status: 'accepted' }, classification: { value, by: classification ? 'person' : 'model', reason: a.proposal.why || a.classification.reason } };
}

// ── The capability report ───────────────────────────────────────────────────

export function capabilityReport(a: SkillAnalysis, provenance?: Pick<ToolSkillProvenance, 'source' | 'repoUrl' | 'ref' | 'resolvedCommit' | 'location'>): string {
  const L: string[] = [];
  L.push(`# ${a.name}`, '', a.description || '_No description._', '');
  if (a.proposal?.summary) L.push(`**Summary (${a.proposal.status === 'accepted' ? 'accepted' : 'proposed by the model'}):** ${a.proposal.summary}`, '');
  L.push('## What it is', '',
    `- **Kind:** ${a.classification.value} (${a.classification.by}: ${a.classification.reason}). ${a.classification.value === 'knowledge' ? 'Once published and reviewed, AutoDE adds it to the context packs whose question it matches.' : 'An agent carries it out with tools.'}`,
    `- **Size:** ${a.files} file(s), ${a.bytes} bytes${a.subpath ? `, from \`${a.subpath}\`` : ''}.`);
  if (provenance) L.push(`- **Source:** ${provenance.source}${provenance.repoUrl ? ` ${provenance.repoUrl}` : provenance.location ? ` ${provenance.location}` : ''}${provenance.ref ? ` @ ${provenance.ref}` : ''}${provenance.resolvedCommit ? ` (commit ${provenance.resolvedCommit.slice(0, 12)})` : ''}.`);
  if (a.licence) L.push(`- **Licence:** ${a.licence.name}${a.licence.file ? ` (\`${a.licence.file}\`)` : ''}. ${a.licence.note ?? ''}`);
  if (a.autode) L.push(`- **AutoDE stages:** ${a.autode.stageKinds.join(', ') || 'none'} on ${a.autode.platforms.join(', ')}. Published and reviewed, it can be chosen for those stages' assignments.`);
  L.push('', '## What it can do', '',
    `- **Reads:** the workspace's files${a.mappedTools.some((t) => /read|list|search/.test(t)) ? ' (through AutoDE\'s read tools)' : ''}${a.engineTools.length ? `, and AutoDE's context through ${a.engineTools.filter((t) => !/^autode_(propose|record)/.test(t)).join(', ') || 'no read tools'}` : ''}.`,
    `- **Becomes approval-gated decisions:** ${a.engineTools.filter((t) => /^autode_propose/.test(t)).join(', ') || 'nothing (it proposes no change to AutoDE)'}. Every change it proposes to AutoDE's state is a decision a person approves.`,
    `- **Writes files:** ${a.writes ? 'yes, each write approved where AutoDE runs it' : 'no'}.`,
    `- **Runs scripts or commands:** ${a.executes ? `yes (${[...a.scripts, ...a.clis.map((c) => c.name)].join(', ') || 'shell'}), each approved where AutoDE runs it` : 'no'}.`);
  if (a.writes || a.executes) L.push('', '> **Limit (mcp-engine §3.1):** AutoDE enforces a skill\'s tools only where it runs the skill (VS Code, the CLI). In another host the host\'s own tools run, and AutoDE\'s decision gates are what protect AutoDE\'s state. It can\'t be published unreviewed.');
  if (a.clis.length || a.mcpServers.length || a.proposal?.prerequisites.length) {
    L.push('', '## Needs', '');
    for (const c of a.clis) L.push(`- CLI \`${c.name}\`${c.guide ? ` (AutoDE can guide its install: ${c.guide})` : ''}.`);
    for (const s of a.mcpServers) L.push(`- MCP server \`${s}\`, configured in the host.`);
    for (const p of a.proposal?.prerequisites ?? []) if (!a.clis.some((c) => c.name === p.name) && !a.mcpServers.includes(p.name)) L.push(`- ${p.kind} \`${p.name}\`${p.note ? `: ${p.note}` : ''} (proposed by the model).`);
  }
  if (a.declaredTools.length || a.proposal?.toolMapping.length) {
    L.push('', '## Tools', '', `Declared: ${a.declaredTools.join(', ') || 'none'}. AutoDE grants: ${a.mappedTools.join(', ') || 'none'}${a.engineTools.length ? `, engine: ${a.engineTools.join(', ')}` : ''}.`);
    for (const m of a.proposal?.toolMapping ?? []) L.push(`- ${m.mentioned} → ${m.autodeTool ?? 'no AutoDE counterpart'}${m.note ? ` (${m.note})` : ''}`);
  }
  if (a.overlaps.length) L.push('', '## Overlaps', '', ...a.overlaps.map((o) => `- \`${o.with}\`: ${o.why}.`));
  if (a.problems.length) L.push('', '## Can\'t be imported', '', ...a.problems.map((p) => `- ${p}`));
  if (a.warnings.length) L.push('', '## Check before publishing', '', ...a.warnings.map((w) => `- ${w}`));
  if (a.scripts.length) L.push('', '## Scripts', '', ...a.scripts.map((s) => `- \`${s}\``));
  return L.join('\n') + '\n';
}

// ── Import and update ───────────────────────────────────────────────────────

export function toolSkillsDir(workspaceRoot: string): string {
  return layoutPath(workspaceRoot, 'toolSkills');
}

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || AUTODE_FILES.has(e.name)) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b);
    else if (e.isFile()) fs.copyFileSync(a, b);
  }
}

export function readAnalysis(skillDir: string): SkillAnalysis | undefined {
  try { return JSON.parse(fs.readFileSync(path.join(skillDir, ANALYSIS_FILENAME), 'utf8')) as SkillAnalysis; } catch { return undefined; }
}

export function writeAnalysis(skillDir: string, a: SkillAnalysis): void {
  fs.writeFileSync(path.join(skillDir, ANALYSIS_FILENAME), JSON.stringify(a, null, 2) + '\n');
}

/**
 * Copies an analysed skill into the workspace: unreviewed (S2), a draft when lifecycle management is on.
 * Refused while the analysis has problems; replacing an imported skill of the same id needs `replace`.
 */
export function importSkill(input: { workspaceRoot: string; stagedDir: string; analysis: SkillAnalysis; provenance: StagedSource['provenance']; by: string; managementEnabled?: boolean; replace?: boolean }): { id: string; dir: string; sidecar: ToolSkillSidecar } {
  const a = input.analysis;
  if (a.problems.length) throw new PortError(`It can't be imported: ${a.problems.join(' ')}`);
  const dir = path.join(toolSkillsDir(input.workspaceRoot), a.id);
  if (fs.existsSync(dir)) {
    if (!input.replace) throw new PortError(`A skill "${a.id}" is already imported: replace it (its review and versions start over), or use Update Skill.`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  copyTree(path.join(input.stagedDir, a.subpath), dir);
  const sidecar = recordImport(dir, { ...input.provenance, subpath: a.subpath || undefined, licence: a.licence?.spdx ?? a.licence?.name }, input.by, { managementEnabled: input.managementEnabled });
  writeAnalysis(dir, a);
  return { id: a.id, dir, sidecar };
}

export interface FileDiff { path: string; change: 'added' | 'removed' | 'changed'; diff?: string }

/** A line diff (longest common subsequence), as unified-style lines; capped for large files. */
export function lineDiff(before: string, after: string, max = 400): string {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  if (a.length * b.length > 4_000_000) return `(${a.length} → ${b.length} lines; too large to diff here)`;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; continue; }
    if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) out.push(`+ ${b[j++]}`);
    else out.push(`- ${a[i++]}`);
    if (out.length >= max) { out.push('… (more changes)'); break; }
  }
  return out.join('\n');
}

function listRel(dir: string): string[] {
  try { return walk(dir, { maxFiles: 100_000, maxBytes: Number.MAX_SAFE_INTEGER, maxFileBytes: Number.MAX_SAFE_INTEGER }).list.sort(); } catch { return []; }
}

/** What changed between an imported skill and a fresh copy of its source. */
export function diffSkill(importedDir: string, freshDir: string): FileDiff[] {
  const before = new Set(listRel(importedDir));
  const after = new Set(listRel(freshDir));
  const out: FileDiff[] = [];
  for (const p of [...new Set([...before, ...after])].sort()) {
    if (!before.has(p)) out.push({ path: p, change: 'added', diff: lineDiff('', fs.readFileSync(path.join(freshDir, p), 'utf8')) });
    else if (!after.has(p)) out.push({ path: p, change: 'removed' });
    else {
      const x = fs.readFileSync(path.join(importedDir, p), 'utf8'), y = fs.readFileSync(path.join(freshDir, p), 'utf8');
      if (x.replace(/\r\n/g, '\n') !== y.replace(/\r\n/g, '\n')) out.push({ path: p, change: 'changed', diff: lineDiff(x, y) });
    }
  }
  return out;
}

/** Re-stages an imported skill's source (the same Git repository or folder) for Update Skill. */
export function stageUpdate(skillDir: string, git: GitRunner = gitRunner): { staged: StagedSource; freshDir: string } {
  const sc = readSidecar(skillDir);
  if (!sc) throw new PortError('This skill has no import record.');
  const p = sc.provenance;
  const src: PortSource | undefined = p.source === 'git' && p.repoUrl ? { kind: 'git', location: p.repoUrl, ref: p.ref } : p.location ? { kind: p.source === 'dbt' ? 'dbt' : 'local', location: p.location } : undefined;
  if (!src) throw new PortError('Its source was not recorded (imported before v0.46.0): import it again from its source.');
  const staged = stageSource(src, SOURCE_CAPS, git);
  const freshDir = path.join(staged.dir, p.subpath ?? '');
  if (!fs.existsSync(path.join(freshDir, 'SKILL.md'))) { staged.cleanup(); throw new PortError(`The source no longer has a skill at ${p.subpath ?? 'its root'}.`); }
  return { staged, freshDir };
}

/**
 * Applies an update: the skill's files become the fresh copy, a transition is recorded, and the new
 * content is unreviewed (S2 binds trust to the content checksum), so it can't run until reviewed again.
 */
export function applyUpdate(skillDir: string, staged: StagedSource, freshDir: string, analysis: SkillAnalysis, by: string, now = new Date().toISOString()): ToolSkillSidecar {
  if (analysis.problems.length) throw new PortError(`The new version can't be imported: ${analysis.problems.join(' ')}`);
  const sc = readSidecar(skillDir);
  if (!sc) throw new PortError('This skill has no import record.');
  for (const e of fs.readdirSync(skillDir, { withFileTypes: true })) if (!AUTODE_FILES.has(e.name)) fs.rmSync(path.join(skillDir, e.name), { recursive: true, force: true });
  copyTree(freshDir, skillDir);
  const checksum = skillContentChecksum(skillDir);
  const updated: ToolSkillSidecar = {
    ...sc, trustTier: 'unreviewed',
    provenance: { ...sc.provenance, resolvedCommit: staged.provenance.resolvedCommit ?? sc.provenance.resolvedCommit, contentChecksum: checksum },
    transitions: [...sc.transitions, { at: now, by, action: 'update', from: sc.provenance.resolvedCommit ?? sc.provenance.contentChecksum.slice(0, 12), to: staged.provenance.resolvedCommit ?? checksum.slice(0, 12), version: sc.version, checksum }]
  };
  writeSidecarFile(skillDir, updated);
  writeAnalysis(skillDir, { ...analysis, subpath: sc.provenance.subpath ?? '' });
  return updated;
}

// ── Knowledge skills in context packs ───────────────────────────────────────

export interface KnowledgeSkill { id: string; name: string; description: string; text: string }

/** Published, reviewed knowledge skills of the workspace: what context packs may include. */
export function knowledgeSkills(workspaceRoot: string): KnowledgeSkill[] {
  const out: KnowledgeSkill[] = [];
  for (const s of loadToolSkillStates(toolSkillsDir(workspaceRoot), 'context', { migrate: false })) {
    if (s.sidecar.status !== 'published' || s.effectiveTier === 'unreviewed') continue;
    const a = readAnalysis(s.skill.sourceDir);
    if (a?.classification.value !== 'knowledge') continue;
    out.push({ id: s.skill.id, name: s.skill.name, description: s.skill.description ?? '', text: s.skill.instructions });
  }
  return out;
}

// ── Imported skills in assignments ──────────────────────────────────────────

/**
 * Published, reviewed imported skills that declare AutoDE stage kinds (`metadata.stageKinds`), as skills an
 * assignment can carry (PA4: one lifecycle). Their names need not follow AutoDE's convention; platforms default
 * to `any`. They add instructions, never tools: the stage's tier still decides what the agent may do.
 */
export function teamSkillPack(workspaceRoot: string, stageKinds: readonly string[]): PackSkill[] {
  const out: PackSkill[] = [];
  for (const s of loadToolSkillStates(toolSkillsDir(workspaceRoot), 'assignment', { migrate: false })) {
    if (s.sidecar.status !== 'published' || s.effectiveTier === 'unreviewed') continue;
    const meta = parseSkillMarkdown(fs.readFileSync(path.join(s.skill.sourceDir, 'SKILL.md'), 'utf8')).metadata ?? {};
    const kinds = (Array.isArray(meta.stageKinds) ? meta.stageKinds : []).map(String).filter((k) => stageKinds.includes(k));
    if (!kinds.length) continue;
    const platforms = (Array.isArray(meta.platforms) ? meta.platforms : []).map(String).filter((p) => (SKILL_PLATFORMS as readonly string[]).includes(p));
    out.push({
      id: s.skill.id, name: s.skill.name, description: s.skill.description ?? '', allowedTools: s.skill.declaredTools ?? [], instructions: s.skill.instructions,
      dir: s.skill.sourceDir, resources: s.skill.resourceFiles ?? [],
      meta: { scope: 'team', stageKinds: kinds, platforms: platforms.length ? platforms : ['any'], version: s.sidecar.version, owner: String(meta.owner ?? 'team'), maturity: 'preview' }
    });
  }
  return out;
}

/** AutoDE's skills and the team's published, reviewed imported ones (AutoDE's win a name clash): what plans and assignments choose from. */
export function stageSkills(resourcesRoot: string, workspaceRoot: string): PackSkill[] {
  const autode = loadSkillPack(resourcesRoot).skills;
  return [...autode, ...teamSkillPack(workspaceRoot, Object.keys(STAGE_KINDS)).filter((t) => !autode.some((k) => k.id === t.id))];
}

// ── One entry point for every surface ───────────────────────────────────────

/** What analysis compares a skill with: the workspace's imported skills, AutoDE's own, the install guides and the stage kinds. */
export function analysisContext(resourcesRoot: string, workspaceRoot: string, repoRoot?: string): AnalysisContext {
  return {
    installed: loadToolSkillStates(toolSkillsDir(workspaceRoot), 'port', { migrate: false }).map((s) => ({ id: s.skill.id, description: s.skill.description ?? '' })),
    autode: loadSkillPack(resourcesRoot).skills.map((k) => ({ id: k.id, description: `${k.name} ${k.description}` })),
    guides: loadToolGuides(resourcesRoot, workspaceRoot).guides,
    stageKinds: Object.keys(STAGE_KINDS),
    repoRoot
  };
}

export interface PortRun { staged: StagedSource; skills: DiscoveredSkill[]; analysis?: SkillAnalysis; report?: string }

/**
 * Stages a source, discovers its skills and analyses the chosen one (`subpath`; the only one when there is
 * one). The caller cleans up `staged`. With several skills and no choice, `analysis` is absent.
 */
export function portSource(src: PortSource, opts: { resourcesRoot: string; workspaceRoot: string; subpath?: string; git?: GitRunner }): PortRun {
  const staged = stageSource(src, SOURCE_CAPS, opts.git);
  try {
    const skills = discoverSkills(staged.dir);
    if (!skills.length) throw new PortError('No skill found: a skill is a folder with a SKILL.md.');
    const want = opts.subpath?.replace(/\\/g, '/').replace(/\/+$/, '');
    const chosen = want !== undefined ? skills.find((s) => s.subpath === want) : skills.length === 1 ? skills[0] : undefined;
    if (opts.subpath !== undefined && !chosen) throw new PortError(`No skill at ${opts.subpath}; found: ${skills.map((s) => s.subpath || '(root)').join(', ')}.`);
    if (!chosen) return { staged, skills };
    const analysis = analyzeSkill(path.join(staged.dir, chosen.subpath), chosen.subpath, analysisContext(opts.resourcesRoot, opts.workspaceRoot, staged.dir));
    return { staged, skills, analysis, report: capabilityReport(analysis, staged.provenance) };
  } catch (err) { staged.cleanup(); throw err; }
}

/** The workspace's lifecycle-management setting, read from `.vscode/settings.json` for surfaces outside VS Code. */
export function managementEnabledIn(workspaceRoot: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(workspaceRoot, '.vscode', 'settings.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
    return (JSON.parse(raw) as Record<string, unknown>)['autoDataEngineeringHub.toolSkillManagementEnabled'] === true;
  } catch { return false; }
}
