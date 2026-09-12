import * as vscode from 'vscode';
import { ArtifactWriter } from './ArtifactWriter';

/**
 * Scans the artifact directory for spec-tagged folders (`<specId>.v<version>`,
 * written by `ArtifactWriter` since Phase B) and reports which ones were
 * produced by a specification revision other than the one currently approved —
 * i.e. artifacts nothing has regenerated since the spec changed underneath them.
 *
 * This is filesystem-driven rather than reading `PlanState.artifacts`, because
 * that in-memory list does not survive a VS Code reload; the version-tagged
 * folder name is the only durable record of which spec revision produced a
 * given artifact.
 */

const SPEC_TAG_PATTERN = /^(.+)\.v(\d+)$/;

export interface ArtifactVersionGroup {
  /** Phase directory this group lives under, e.g. `03-build` or `00-uncategorized`. */
  phaseDir: string;
  specId: string;
  specVersion: number;
  /** Total files found under this group (recursively). */
  fileCount: number;
  /** A few example relative paths, for display — not exhaustive. */
  sampleFiles: string[];
  status: 'current' | 'stale' | 'unknown-spec';
  folderUri: vscode.Uri;
}

export interface ArtifactStalenessReport {
  currentSpecId?: string;
  currentSpecVersion?: number;
  groups: ArtifactVersionGroup[];
  /** Files directly under a phase dir with no spec-tag folder (written before Phase B, or with no spec at plan time). */
  untaggedFileCount: number;
}

const MAX_SAMPLE_FILES = 5;

export async function scanArtifactStaleness(
  workspaceRoot: vscode.Uri,
  currentSpec?: { id: string; version: number }
): Promise<ArtifactStalenessReport> {
  const report: ArtifactStalenessReport = {
    currentSpecId: currentSpec?.id,
    currentSpecVersion: currentSpec?.version,
    groups: [],
    untaggedFileCount: 0
  };

  const artifactRoot = ArtifactWriter.resolveArtifactDirectory(workspaceRoot);
  let phaseDirs: [string, vscode.FileType][];
  try {
    phaseDirs = await vscode.workspace.fs.readDirectory(artifactRoot);
  } catch {
    return report; // artifact directory doesn't exist yet — nothing to scan.
  }

  for (const [phaseName, phaseType] of phaseDirs) {
    if (phaseType !== vscode.FileType.Directory) continue;
    const phaseUri = vscode.Uri.joinPath(artifactRoot, phaseName);
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(phaseUri);
    } catch {
      continue;
    }

    for (const [entryName, entryType] of entries) {
      if (entryType === vscode.FileType.Directory) {
        const match = SPEC_TAG_PATTERN.exec(entryName);
        if (match) {
          const specId = match[1];
          const specVersion = parseInt(match[2], 10);
          const folderUri = vscode.Uri.joinPath(phaseUri, entryName);
          const files = await countFilesRecursive(folderUri);
          const status: ArtifactVersionGroup['status'] =
            !currentSpec ? 'unknown-spec'
              : specId !== currentSpec.id ? 'unknown-spec'
                : specVersion === currentSpec.version ? 'current'
                  : 'stale';
          report.groups.push({
            phaseDir: phaseName,
            specId,
            specVersion,
            fileCount: files.length,
            sampleFiles: files.slice(0, MAX_SAMPLE_FILES),
            status,
            folderUri
          });
          continue;
        }
        // A directory that isn't a spec-tag folder (e.g. a multi-file artifact
        // written before Phase B, or with no spec at plan time) — its files
        // count as untagged.
        const nested = await countFilesRecursive(vscode.Uri.joinPath(phaseUri, entryName));
        report.untaggedFileCount += nested.length;
      } else if (entryType === vscode.FileType.File) {
        report.untaggedFileCount += 1;
      }
    }
  }

  return report;
}

async function countFilesRecursive(dirUri: vscode.Uri, relativePrefix = ''): Promise<string[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dirUri);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const [name, type] of entries) {
    const relPath = relativePrefix ? `${relativePrefix}/${name}` : name;
    if (type === vscode.FileType.Directory) {
      files.push(...(await countFilesRecursive(vscode.Uri.joinPath(dirUri, name), relPath)));
    } else if (type === vscode.FileType.File) {
      files.push(relPath);
    }
  }
  return files;
}
