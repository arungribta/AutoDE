import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyCspNonce } from '../core/webviewSecurity';
import { EditorContext, SemanticEdit, applySemanticEdit, mergeDraft, semanticEditorState } from '../engine/semantic/editorState';
import { approveComposite, approveShared, resolveCompositeFile } from '../engine/semantic/store';
import { draftSemanticModel } from '../engine/semantic/draft';
import { problemTableIds } from '../engine/context/capture';
import { layoutPath } from '../engine/workspaceLayout';
import { activeProblemId } from '../engine/documents/problems';

/**
 * The Semantic Model editor (C5a; docs/specs/context-layer.md §6.7):
 * a custom text editor on the semantic layer's YAML — shared models,
 * composites and resolved models. The file is the source of truth: the form
 * and the YAML view change it through ordinary document edits (undo, diffs
 * and git come with it). What the editor shows and how edits change the text
 * live in the engine (`editorState.ts`), so they are tested without VS Code.
 */

export interface SemanticEditorHost {
  /** The estate and facts the checks run against; undefined until the AutoDE panel has loaded the workspace. */
  context(): EditorContext | undefined;
  user(): string;
  /** After an approval or a resolution: refresh *Waiting for you*. */
  changed(): void;
}

export class SemanticModelEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'autoDE.semanticModelEditor';

  constructor(private readonly context: vscode.ExtensionContext, private readonly host: SemanticEditorHost) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = { enableScripts: true };
    const html = fs.readFileSync(path.join(this.context.extensionUri.fsPath, 'media', 'editors', 'semanticModelEditor.html'), 'utf8');
    panel.webview.html = applyCspNonce(html, panel.webview.cspSource);
    const post = () => {
      const ctx = this.host.context();
      let state;
      try { state = ctx ? semanticEditorState(document.uri.fsPath, document.getText(), ctx) : undefined; } catch (err) { state = { kind: 'other', name: '', errors: [err instanceof Error ? err.message : String(err)], warnings: [], findings: [], mode: 'governed' }; }
      void panel.webview.postMessage({ type: 'state', state, text: document.getText(), file: path.basename(document.uri.fsPath), dirty: document.isDirty, ready: !!ctx });
    };
    const sub = vscode.workspace.onDidChangeTextDocument((e) => { if (e.document.uri.toString() === document.uri.toString()) post(); });
    const saved = vscode.workspace.onDidSaveTextDocument((d) => { if (d.uri.toString() === document.uri.toString()) post(); });
    panel.onDidDispose(() => { sub.dispose(); saved.dispose(); });
    panel.webview.onDidReceiveMessage(async (m: { type: string; edit?: SemanticEdit; text?: string }) => {
      try {
        switch (m.type) {
          case 'ready': case 'refresh': post(); return;
          case 'edit': if (m.edit) await this.replace(document, applySemanticEdit(document.getText(), m.edit)); return;
          case 'yaml': if (typeof m.text === 'string') await this.replace(document, m.text); return;
          case 'draft': await this.draft(document); return;
          case 'resolve': await this.resolve(document); post(); return;
          case 'approve': await this.approve(document); post(); return;
          case 'openResolved': {
            const f = document.uri.fsPath.replace(/\.ya?ml$/i, '.resolved.yaml');
            if (fs.existsSync(f)) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(f));
            return;
          }
          case 'openText': await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default'); return;
        }
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    });
  }

  private async replace(document: vscode.TextDocument, text: string): Promise<void> {
    if (text === document.getText()) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
    await vscode.workspace.applyEdit(edit);
  }

  private where(document: vscode.TextDocument): { ctx: EditorContext; state: ReturnType<typeof semanticEditorState> } {
    const ctx = this.host.context();
    if (!ctx) throw new Error('Open the AutoDE panel first: the checks need the workspace\'s estate and facts.');
    return { ctx, state: semanticEditorState(document.uri.fsPath, document.getText(), ctx) };
  }

  /** Adds what a fresh draft has and the model doesn't (tables, elements, relationships); nothing written is changed. */
  private async draft(document: vscode.TextDocument): Promise<void> {
    const { ctx, state } = this.where(document);
    if (state.kind !== 'shared') throw new Error('Draft from knowledge works on a shared model.');
    const problem = activeProblemId(ctx.workspaceRoot);
    const ids = problem ? problemTableIds({ workspaceRoot: ctx.workspaceRoot, problemRoot: layoutPath(ctx.workspaceRoot, 'problems', problem), sources: ctx }) : [];
    if (!ids.length) throw new Error('No table to draft from: the active problem\'s specification names no table AutoDE knows.');
    const d = draftSemanticModel({ graph: ctx.graph, assertions: ctx.assertions, tableIds: ids, name: state.name });
    const merged = mergeDraft(document.getText(), d.model);
    if (!merged.added.length) { void vscode.window.showInformationMessage('The draft adds nothing: the model already has every table, element and relationship AutoDE knows.'); return; }
    await this.replace(document, merged.text);
    void vscode.window.showInformationMessage(`Added from knowledge: ${merged.added.slice(0, 8).join(', ')}${merged.added.length > 8 ? ` and ${merged.added.length - 8} more` : ''}. Undo reverts it.${d.notes.length ? ` Left out: ${d.notes.join('; ')}` : ''}`);
  }

  private async resolve(document: vscode.TextDocument): Promise<void> {
    const { ctx, state } = this.where(document);
    if (state.kind !== 'composite' || !state.problemId) throw new Error('Only a composite in a problem\'s semantic folder is resolved.');
    if (document.isDirty) await document.save();
    const r = resolveCompositeFile(ctx.workspaceRoot, state.problemId, state.name);
    if (!r.ok) throw new Error(`${state.name} doesn't resolve: ${r.errors.join('; ')}`);
    this.host.changed();
    void vscode.window.showInformationMessage(`${path.basename(r.resolvedFile)} ${r.changed ? 'written' : 'unchanged'}.`, ...(r.diff ? ['Show changes'] : [])).then(async (pick) => {
      if (pick === 'Show changes') await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'diff', content: r.diff }));
    });
  }

  /** A person's act: approves the saved file (a shared model workspace-wide; a composite in its problem). */
  private async approve(document: vscode.TextDocument): Promise<void> {
    const { ctx, state } = this.where(document);
    if (document.isDirty) await document.save();
    const by = this.host.user();
    if (state.kind === 'shared') {
      const ok = await vscode.window.showWarningMessage(`Approve the shared semantic model ${state.name} as ${by}?`, { modal: true, detail: 'A workspace-level approval: every business problem that uses this model is affected, and composites resolved from an earlier version become stale.' }, 'Approve');
      if (ok !== 'Approve') return;
      const r = approveShared(ctx.workspaceRoot, state.name, { by, channel: 'panel', findings: state.findings });
      if (!r.ok) throw new Error(r.message);
      void vscode.window.showInformationMessage(r.message);
    } else if (state.kind === 'composite' && state.problemId) {
      const problemRoot = layoutPath(ctx.workspaceRoot, 'problems', state.problemId);
      if (state.mode !== 'exploration') {
        const ok = await vscode.window.showWarningMessage(`Approve the composite ${state.name} as ${by}?`, { modal: true, detail: 'It is approved within its business problem, at its resolved version.' }, 'Approve');
        if (ok !== 'Approve') return;
      }
      const r = approveComposite(ctx.workspaceRoot, state.problemId, state.name, { by, channel: 'panel', findings: state.findings, problemRoot });
      if (!r.ok) throw new Error(r.message);
      void vscode.window.showInformationMessage(r.message);
    } else throw new Error('Only a shared model or a composite is approved.');
    this.host.changed();
  }
}
