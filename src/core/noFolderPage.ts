/**
 * The AutoDE panel when VS Code has no folder open (v0.56.5). An AutoDE
 * workspace is a folder with its own `.autode/`; with none open there is
 * nothing to work in, so the panel says so and offers the two ways to get one.
 * Before, AutoDE fell back to its own install folder (in the development host,
 * the AutoDE repository) and kept a workspace there.
 */
export function noFolderPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 16px; line-height: 1.5; }
    h2 { font-size: 1.1em; margin: 0 0 8px; }
    p { margin: 0 0 12px; color: var(--vscode-descriptionForeground); }
    button { display: block; width: 100%; margin: 0 0 8px; padding: 6px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer; font: inherit;
      background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  </style>
</head>
<body>
  <h2>Open a folder to work in</h2>
  <p>An AutoDE workspace is a folder: its estate, knowledge, problems and decisions live in its <code>.autode/</code> folder. No folder is open in this window, so there is nowhere to keep them yet.</p>
  <button class="primary" id="newWorkspace">New Workspace…</button>
  <button id="openFolder">Open Folder…</button>
  <p>An existing AutoDE workspace is any folder that has a <code>.autode/</code> folder; a folder without one becomes a workspace when you start your first problem there.</p>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('newWorkspace').onclick = () => vscode.postMessage({ type: 'newWorkspace' });
    document.getElementById('openFolder').onclick = () => vscode.postMessage({ type: 'openFolder' });
  </script>
</body>
</html>`;
}
