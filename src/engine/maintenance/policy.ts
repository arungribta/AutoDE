import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml } from '../context/Yaml';
import { layoutPath } from '../workspaceLayout';

/**
 * Who acts on knowledge maintenance (MM2; docs/specs/context-layer.md
 * §5.6), from `.autode/config/maintenance.yaml`:
 *
 *   policy: suggest      # suggest (default) | draft | off
 *   draft:
 *     runsPerDay: 3      # agent runs AutoDE may start on its own under `draft`
 *
 * `suggest` creates items only: a person starts the named agent, or a host
 * agent picks items up. `draft` lets AutoDE run the named agent at stage
 * boundaries, within the budget, to draft a proposal. `off` creates no items.
 * Nothing is ever approved without a person.
 *
 * The engineer's own state — dismissed items, the last workspace scan, the
 * drafts AutoDE started — is in `.autode/local/maintenance.json`.
 */

export type MaintenancePolicy = 'suggest' | 'draft' | 'off';
export const MAINTENANCE_POLICIES: readonly MaintenancePolicy[] = ['suggest', 'draft', 'off'];

export interface MaintenanceConfig { policy: MaintenancePolicy; runsPerDay: number; errors: string[] }

export const DEFAULT_RUNS_PER_DAY = 3;

export function parseMaintenanceConfig(text: string | undefined): MaintenanceConfig {
  const config: MaintenanceConfig = { policy: 'suggest', runsPerDay: DEFAULT_RUNS_PER_DAY, errors: [] };
  if (!text?.trim()) return config;
  let raw: unknown;
  try { raw = parseYaml(text); } catch (err) { config.errors.push(`maintenance.yaml: ${err instanceof Error ? err.message : String(err)}`); return config; }
  const r = (raw && typeof raw === 'object' ? raw : {}) as { policy?: unknown; draft?: { runsPerDay?: unknown } };
  if (r.policy !== undefined) {
    if (MAINTENANCE_POLICIES.includes(r.policy as MaintenancePolicy)) config.policy = r.policy as MaintenancePolicy;
    else config.errors.push(`maintenance.yaml: policy must be one of ${MAINTENANCE_POLICIES.join(', ')}; "${String(r.policy)}" is treated as suggest.`);
  }
  const n = r.draft?.runsPerDay;
  if (n !== undefined) {
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) config.runsPerDay = n;
    else config.errors.push('maintenance.yaml: draft.runsPerDay must be a whole number, 0 or more.');
  }
  return config;
}

export function loadMaintenanceConfig(workspaceRoot: string): MaintenanceConfig {
  try { return parseMaintenanceConfig(fs.readFileSync(layoutPath(workspaceRoot, 'maintenancePolicy'), 'utf8')); } catch { return parseMaintenanceConfig(undefined); }
}

export interface Dismissal { by: string; at: string; reason: string }
export interface ScannedDocument { path: string; sha: string }

export interface MaintenanceState {
  dismissed: Record<string, Dismissal>;
  scan?: { at: string; documents: ScannedDocument[] };
  /** Agent runs AutoDE started under `draft`: the budget counts them per day. */
  drafts: Array<{ key: string; role: string; at: string }>;
}

export function readMaintenanceState(workspaceRoot: string): MaintenanceState {
  try {
    const raw = JSON.parse(fs.readFileSync(layoutPath(workspaceRoot, 'maintenanceState'), 'utf8')) as Partial<MaintenanceState>;
    return { dismissed: raw.dismissed && typeof raw.dismissed === 'object' ? raw.dismissed : {}, ...(raw.scan ? { scan: raw.scan } : {}), drafts: Array.isArray(raw.drafts) ? raw.drafts : [] };
  } catch { return { dismissed: {}, drafts: [] }; }
}

export function writeMaintenanceState(workspaceRoot: string, state: MaintenanceState): void {
  const file = layoutPath(workspaceRoot, 'maintenanceState');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

/** Agent runs left today under `draft` (0 under any other policy). */
export function draftRunsLeft(workspaceRoot: string, now = new Date()): number {
  const config = loadMaintenanceConfig(workspaceRoot);
  if (config.policy !== 'draft') return 0;
  const day = now.toISOString().slice(0, 10);
  return Math.max(0, config.runsPerDay - readMaintenanceState(workspaceRoot).drafts.filter((d) => d.at.startsWith(day)).length);
}

export function noteDraftRun(workspaceRoot: string, key: string, role: string, now = new Date()): void {
  const s = readMaintenanceState(workspaceRoot);
  // A month of runs is enough to count today's.
  const since = new Date(now.getTime() - 31 * 864e5).toISOString();
  writeMaintenanceState(workspaceRoot, { ...s, drafts: [...s.drafts.filter((d) => d.at >= since), { key, role, at: now.toISOString() }] });
}
