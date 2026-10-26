import * as fs from 'node:fs';
import { parseYaml } from '../context/Yaml';
import { layoutPath } from '../workspaceLayout';

/**
 * Who may approve and run a runbook, per environment (v0.45.6): the team's
 * `.autode/config/approvals.yaml` (PA3c adds the gates to the same file).
 *
 *   runbooks:
 *     environments:
 *       dev:  { connections: [snowflake:dev], approvers: any, unattended: true }
 *       prod: { connections: [snowflake:prod], approvers: [priya, arun], secondApprover: true }
 *     allowCommands:                         # the team's own CLI commands, beyond AutoDE's allowlist
 *       - { argv: [snow, git, fetch], class: read }
 *
 * The environment of a connection is the team's to say, never the runbook's:
 * a connection no environment lists is treated as production.
 */

export type StepClass = 'read' | 'change' | 'destructive';
export const STEP_CLASSES: readonly StepClass[] = ['read', 'change', 'destructive'];

export interface EnvironmentPolicy {
  name: string;
  connections: string[];
  /** `any` person, or the named people. */
  approvers: 'any' | string[];
  /** A second, different approver before anything runs. */
  secondApprover: boolean;
  /** Whether "Run remaining" may run several steps on one click. */
  unattended: boolean;
  /** The step classes allowed here. */
  allowedClasses: StepClass[];
}

export interface RunbookPolicy {
  environments: EnvironmentPolicy[];
  allowCommands: Array<{ argv: string[]; class: StepClass }>;
  /** Where it came from, for messages. */
  file?: string;
  errors: string[];
}

const DEFAULTS: Record<string, Omit<EnvironmentPolicy, 'name' | 'connections'>> = {
  dev: { approvers: 'any', secondApprover: false, unattended: true, allowedClasses: ['read', 'change', 'destructive'] },
  sandbox: { approvers: 'any', secondApprover: false, unattended: true, allowedClasses: ['read', 'change', 'destructive'] },
  test: { approvers: 'any', secondApprover: false, unattended: false, allowedClasses: ['read', 'change', 'destructive'] },
  prod: { approvers: [], secondApprover: false, unattended: false, allowedClasses: ['read', 'change', 'destructive'] }
};

export function policyFile(workspaceRoot: string): string {
  return layoutPath(workspaceRoot, 'approvals');
}

export function loadRunbookPolicy(workspaceRoot: string): RunbookPolicy {
  const file = policyFile(workspaceRoot);
  const errors: string[] = [];
  let raw: { runbooks?: { environments?: Record<string, Record<string, unknown>>; allowCommands?: unknown[] } } = {};
  if (fs.existsSync(file)) {
    try { raw = (parseYaml(fs.readFileSync(file, 'utf8')) as typeof raw) ?? {}; } catch (err) { errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  const envs = raw.runbooks?.environments ?? {};
  const names = [...new Set([...Object.keys(DEFAULTS), ...Object.keys(envs)])];
  const environments: EnvironmentPolicy[] = names.map((name) => {
    const d = DEFAULTS[name] ?? DEFAULTS.prod;
    const e = envs[name] ?? {};
    const approvers = e.approvers === 'any' ? 'any' : Array.isArray(e.approvers) ? e.approvers.map(String) : d.approvers;
    const classes = Array.isArray(e.allowedClasses) ? e.allowedClasses.map(String).filter((c): c is StepClass => (STEP_CLASSES as readonly string[]).includes(c)) : d.allowedClasses;
    return {
      name, connections: Array.isArray(e.connections) ? e.connections.map(String) : [],
      approvers, secondApprover: typeof e.secondApprover === 'boolean' ? e.secondApprover : d.secondApprover,
      // Production never runs unattended, whatever the file says.
      unattended: name === 'prod' ? false : typeof e.unattended === 'boolean' ? e.unattended : d.unattended,
      allowedClasses: classes
    };
  });
  const allowCommands: RunbookPolicy['allowCommands'] = [];
  for (const [i, c] of (raw.runbooks?.allowCommands ?? []).entries()) {
    const x = c as { argv?: unknown; class?: unknown };
    if (!Array.isArray(x.argv) || !x.argv.length || !(STEP_CLASSES as readonly unknown[]).includes(x.class)) { errors.push(`runbooks.allowCommands[${i}] needs argv (a list) and class (read, change or destructive).`); continue; }
    allowCommands.push({ argv: x.argv.map(String), class: x.class as StepClass });
  }
  return { environments, allowCommands, file: fs.existsSync(file) ? file : undefined, errors };
}

/** The environment a connection belongs to: the one that lists it; otherwise production. */
export function environmentOf(policy: RunbookPolicy, connectionId: string): EnvironmentPolicy {
  return policy.environments.find((e) => e.connections.includes(connectionId)) ?? policy.environments.find((e) => e.name === 'prod')!;
}

/** Why this person may not approve here (undefined: they may). */
export function approverProblem(env: EnvironmentPolicy, who: string, earlier: readonly string[]): string | undefined {
  if (earlier.map((x) => x.toLowerCase()).includes(who.toLowerCase())) return `${who} already approved this runbook; the second approval must come from someone else.`;
  if (env.approvers === 'any') return undefined;
  if (!env.approvers.length) return `Nobody may approve runbooks for ${env.name} yet: list the approvers under runbooks.environments.${env.name}.approvers in .autode/config/approvals.yaml (a connection no environment lists counts as prod).`;
  return env.approvers.map((x) => x.toLowerCase()).includes(who.toLowerCase()) ? undefined : `${who} is not an approver for ${env.name} (approvers: ${env.approvers.join(', ')}).`;
}

/** How many approvals the environment needs. */
export function approvalsNeeded(env: EnvironmentPolicy): number {
  return env.secondApprover ? 2 : 1;
}
