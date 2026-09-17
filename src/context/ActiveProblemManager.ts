import * as vscode from 'vscode';
import { ActiveProblemPointer, BusinessProblemSummary, SpecStatus } from '../core/types';
import { parseYaml } from './Yaml';

/**
 * Tracks which business problem is active (`.ai-context/active-problem.json`)
 * and lists every business problem folder in the workspace for the picker
 * UI. Each business problem lives at `.ai-context/problems/<id>/` with its
 * own spec/plan/context/artifacts subtree — see requirements.md §8.11.
 *
 * Deliberately lightweight: `listProblems()` reads just enough of each
 * `spec/business-problem.yaml` for a picker row, without instantiating a
 * full `SpecManager` per folder.
 */
export class ActiveProblemManager implements vscode.Disposable {
  private readonly problemsDir: vscode.Uri;
  private readonly pointerUri: vscode.Uri;

  constructor(
    private readonly workspaceUri: vscode.Uri,
    private readonly log: (msg: string) => void
  ) {
    this.problemsDir = vscode.Uri.joinPath(workspaceUri, '.ai-context', 'problems');
    this.pointerUri = vscode.Uri.joinPath(workspaceUri, '.ai-context', 'active-problem.json');
  }

  public dispose(): void {}

  /** The folder a given business problem's spec/plan/context/artifacts live under. */
  public problemRoot(problemId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.problemsDir, problemId);
  }

  public async getActiveProblemId(): Promise<string | undefined> {
    try {
      const content = await vscode.workspace.fs.readFile(this.pointerUri);
      const parsed = JSON.parse(Buffer.from(content).toString('utf8')) as ActiveProblemPointer;
      return parsed.problemId || undefined;
    } catch {
      return undefined;
    }
  }

  public async setActiveProblemId(problemId: string): Promise<void> {
    const pointer: ActiveProblemPointer = { problemId, activatedAt: new Date().toISOString() };
    const dir = vscode.Uri.joinPath(this.workspaceUri, '.ai-context');
    await vscode.workspace.fs.createDirectory(dir);
    const tempUri = vscode.Uri.joinPath(dir, `.active-problem.tmp.${Date.now()}.json`);
    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(JSON.stringify(pointer, null, 2), 'utf8'));
    await vscode.workspace.fs.rename(tempUri, this.pointerUri, { overwrite: true });
    this.log(`Active business problem set to ${problemId}.`);
  }

  /** Clears the pointer — the "no active problem" state (e.g. right after "Start New", before the first draft). */
  public async clearActiveProblem(): Promise<void> {
    try { await vscode.workspace.fs.delete(this.pointerUri); } catch { /* already absent */ }
  }

  /** One row per business-problem folder, for the picker — never throws, skips unreadable folders. */
  public async listProblems(): Promise<BusinessProblemSummary[]> {
    const activeId = await this.getActiveProblemId();
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.problemsDir);
    } catch {
      return [];
    }

    const summaries: BusinessProblemSummary[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) continue;
      const specUri = vscode.Uri.joinPath(this.problemsDir, name, 'spec', 'business-problem.yaml');
      try {
        const content = Buffer.from(await vscode.workspace.fs.readFile(specUri)).toString('utf8');
        const doc = parseYaml(content) as Record<string, unknown> | undefined;
        if (!doc || typeof doc !== 'object') continue;
        const str = (v: unknown): string => (typeof v === 'string' ? v : '');
        summaries.push({
          id: name,
          problemStatement: str(doc.problemStatement),
          status: (str(doc.status) as SpecStatus) || 'draft',
          specVersion: typeof doc.version === 'number' ? doc.version : 1,
          updatedAt: str(doc.updatedAt),
          isActive: name === activeId
        });
      } catch {
        // Folder exists but has no readable spec yet — skip it rather than show a broken row.
      }
    }
    summaries.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return summaries;
  }
}
