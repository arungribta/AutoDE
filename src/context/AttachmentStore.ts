import * as vscode from 'vscode';
import { IntakeAttachment } from '../core/types';
import { parseYaml, stringifyYaml } from './Yaml';

/**
 * Persists attachments (raw content + any structured extract) beyond the
 * ephemeral discovery session they were added during, so later flows — most
 * notably Pipeline Spec synthesis (Phase 2B-i) — can still read what an
 * attachment contributed even after the discovery conversation has ended.
 *
 * `<contextRoot>/attachments/<id>.yaml`, atomic write — the same convention
 * every other persisted artifact in this codebase already follows.
 */
export class AttachmentStore {
  private readonly dir: vscode.Uri;

  constructor(contextRoot: vscode.Uri) {
    this.dir = vscode.Uri.joinPath(contextRoot, 'attachments');
  }

  public async save(attachment: IntakeAttachment): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.dir);
    const target = vscode.Uri.joinPath(this.dir, `${attachment.id}.yaml`);
    const tempUri = vscode.Uri.joinPath(this.dir, `.${attachment.id}.tmp.${Date.now()}.yaml`);
    const content = '# AutoDE Attachment\n' + stringifyYaml(attachment as unknown as Record<string, unknown>);
    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(content, 'utf8'));
    await vscode.workspace.fs.rename(tempUri, target, { overwrite: true });
  }

  public async list(): Promise<IntakeAttachment[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.dir);
    } catch {
      return [];
    }
    const attachments: IntakeAttachment[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith('.yaml')) continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.dir, name));
        const raw = parseYaml(Buffer.from(bytes).toString('utf8'));
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          attachments.push(raw as IntakeAttachment);
        }
      } catch {
        continue; // an unreadable/corrupt attachment file must not block loading the rest
      }
    }
    return attachments;
  }
}
