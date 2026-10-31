import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureLayout, layoutPath } from './workspaceLayout';
import { startProblem } from './documents/problems';

/**
 * A new AutoDE workspace for a different subject area (v0.56.1): its own
 * folder with its own `.autode/`, so its estate, knowledge, problems and
 * decisions never mix with another's. A workspace is a folder because that is
 * what git, VS Code, the CLI and the MCP server (`--workspace`) already treat
 * as one. It can bring the team's set-up along (connections and the runbook
 * approval policy: settings, never secrets, never knowledge), and start its
 * first problem from a statement.
 */

export interface CreateWorkspaceInput {
  /** The new folder (created; refused when it exists and isn't empty). */
  folder: string;
  /** The workspace whose team set-up is carried over. */
  from?: string;
  /** What to carry over (default: both, when \`from\` has them). */
  carry?: { connections?: boolean; approvals?: boolean };
  /** Starts the first business problem with this statement, active. */
  statement?: string;
  now?: Date;
}

export interface CreatedWorkspace {
  folder: string;
  /** Workspace-relative files carried over. */
  carried: string[];
  problemId?: string;
}

export function createWorkspace(input: CreateWorkspaceInput): CreatedWorkspace {
  const folder = path.resolve(input.folder);
  if (fs.existsSync(folder)) {
    if (!fs.statSync(folder).isDirectory()) throw new Error(`${folder} is a file, not a folder.`);
    if (fs.readdirSync(folder).length) throw new Error(`${folder} already exists and isn't empty: choose a new folder for the new workspace.`);
  }
  if (input.from && path.resolve(input.from) === folder) throw new Error('The new workspace must be a different folder from the current one.');
  fs.mkdirSync(folder, { recursive: true });
  ensureLayout(folder);
  const carried: string[] = [];
  if (input.from) {
    for (const key of ['connections', 'approvals'] as const) {
      if (input.carry?.[key] === false) continue;
      const src = layoutPath(input.from, key);
      if (!fs.existsSync(src)) continue;
      const dst = layoutPath(folder, key);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      carried.push(path.relative(folder, dst).split(path.sep).join('/'));
    }
  }
  const problem = input.statement?.trim() ? startProblem(folder, input.statement, { now: input.now }) : undefined;
  return { folder, carried, ...(problem ? { problemId: problem.id } : {}) };
}
