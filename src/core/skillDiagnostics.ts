import * as path from 'node:path';
import * as vscode from 'vscode';
import { Catalog, loadCatalog } from '../engine/platform/operations/load';
import { lintSkillText } from '../engine/platform/operations/catalogView';
import { layoutPath } from '../engine/workspaceLayout';

/**
 * POP4b: the skill editor's checks as you type. A team skill's `SKILL.md` (a team copy of an AutoDE skill or an
 * imported one, under `.autode/config/skills/tool-skills/`) gets the engine's findings as diagnostics: the format
 * and metadata rules, operation ids that don't exist, and platform queries the skill carries itself. The same
 * findings as `autode skills lint` and `autode_skill_check`.
 */
export function registerSkillDiagnostics(context: vscode.ExtensionContext, workspaceRoot: () => string | undefined): vscode.Disposable[] {
  // Hosts without the languages API (and the test host) get no diagnostics; the CLI and MCP checks stay.
  if (!vscode.languages?.createDiagnosticCollection) return [];
  const diagnostics = vscode.languages.createDiagnosticCollection('autode-skills');
  let catalog: Catalog | undefined;
  const timers = new Map<string, NodeJS.Timeout>();

  const folderOf = (doc: vscode.TextDocument): string | undefined => {
    const root = workspaceRoot();
    if (!root || path.basename(doc.uri.fsPath) !== 'SKILL.md') return undefined;
    const dir = path.dirname(doc.uri.fsPath);
    return path.relative(layoutPath(root, 'toolSkills'), dir).split(path.sep).length === 1 && !path.relative(layoutPath(root, 'toolSkills'), dir).startsWith('..') ? path.basename(dir) : undefined;
  };

  const check = (doc: vscode.TextDocument) => {
    const folder = folderOf(doc);
    if (!folder) return;
    catalog ??= loadCatalog({ resourcesRoot: context.extensionUri.fsPath, workspaceRoot: workspaceRoot() });
    diagnostics.set(doc.uri, lintSkillText(doc.getText(), folder, catalog).map((f) => {
      const line = Math.max(0, Math.min(f.line - 1, doc.lineCount - 1));
      const d = new vscode.Diagnostic(doc.lineAt(line).range, f.message, f.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      d.source = 'AutoDE';
      return d;
    }));
  };

  const later = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); check(doc); }, 300));
  };

  vscode.workspace.textDocuments.forEach(check);
  return [
    diagnostics,
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidChangeTextDocument((e) => later(e.document)),
    // An operation file saved (a team one added or approved) changes which ids exist.
    vscode.workspace.onDidSaveTextDocument((doc) => { if (/\.ya?ml$/i.test(doc.uri.fsPath)) catalog = undefined; check(doc); }),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri))
  ];
}
