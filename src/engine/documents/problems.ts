import * as fs from 'node:fs';
import * as path from 'node:path';
import { ActiveProblemPointer, BusinessProblemSpec, BusinessProblemSummary, SpecStatus } from '../types';
import { parseYaml } from '../context/Yaml';
import { layoutPath } from '../workspaceLayout';
import { generateProblemSlug } from './problemSlug';
import { writeBusinessProblemSpec } from './problemDocuments';

/**
 * Business problems of a workspace without VS Code (parity step 1a, v0.43.2):
 * list them, choose the active one, and start a new one — the same folders
 * (`.autode/problems/<id>/`), pointer (`.autode/local/active-problem.json`)
 * and first draft the panel uses, so a problem started in a terminal or by an
 * agent opens in the panel and the other way round.
 */

const PROBLEM_ID = /^[A-Za-z0-9_.-]+$/;

export function activeProblemId(workspaceRoot: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(layoutPath(workspaceRoot, 'activeProblem'), 'utf8')) as Partial<ActiveProblemPointer>;
    return typeof raw.problemId === 'string' && PROBLEM_ID.test(raw.problemId) ? raw.problemId : undefined;
  } catch {
    return undefined;
  }
}

/** Every problem folder, newest first; a folder without a readable spec is listed with an empty statement. */
export function listProblems(workspaceRoot: string): BusinessProblemSummary[] {
  const dir = layoutPath(workspaceRoot, 'problems');
  const active = activeProblemId(workspaceRoot);
  let names: string[];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && PROBLEM_ID.test(e.name)).map((e) => e.name); } catch { return []; }
  const out: BusinessProblemSummary[] = names.map((id) => {
    let doc: Record<string, unknown> = {};
    try { doc = (parseYaml(fs.readFileSync(path.join(dir, id, 'spec', 'business-problem.yaml'), 'utf8')) as Record<string, unknown>) ?? {}; } catch { /* no spec yet */ }
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    return { id, problemStatement: str(doc.problemStatement), status: (str(doc.status) as SpecStatus) || 'draft', specVersion: typeof doc.version === 'number' ? doc.version : 1, updatedAt: str(doc.updatedAt), isActive: id === active };
  });
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.id.localeCompare(b.id));
}

/** Makes a problem the active one for this engineer (the panel follows the pointer file). */
export function setActiveProblem(workspaceRoot: string, problemId: string, now: Date = new Date()): void {
  if (!PROBLEM_ID.test(problemId) || !fs.existsSync(layoutPath(workspaceRoot, 'problems', problemId))) throw new Error(`No business problem "${problemId}" under .autode/problems/.`);
  const file = layoutPath(workspaceRoot, 'activeProblem');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ problemId, activatedAt: now.toISOString() } satisfies ActiveProblemPointer, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Starts a business problem: a folder named from the statement (as the panel
 * names it), a first draft specification holding just the statement, and the
 * problem made active. Nothing is approved: the interview, the specification
 * and its approval follow.
 */
export function startProblem(workspaceRoot: string, problemStatement: string, options: { activate?: boolean; now?: Date } = {}): { id: string; spec: BusinessProblemSpec } {
  const statement = problemStatement.trim();
  if (!statement) throw new Error('A business problem needs a problem statement.');
  const now = (options.now ?? new Date()).toISOString();
  const id = generateProblemSlug(statement, listProblems(workspaceRoot).map((p) => p.id));
  const root = layoutPath(workspaceRoot, 'problems', id);
  fs.mkdirSync(root, { recursive: true });
  const spec: BusinessProblemSpec = {
    id: `bps-${Date.parse(now).toString(36)}`, version: 1, status: 'draft', problemStatement: statement,
    objectives: [], successCriteria: [], scope: { in: [], out: [] }, constraints: [], assumptions: [],
    createdAt: now, updatedAt: now, problemStatementApproved: false
  };
  writeBusinessProblemSpec(root, spec);
  if (options.activate !== false) setActiveProblem(workspaceRoot, id, new Date(now));
  return { id, spec };
}
