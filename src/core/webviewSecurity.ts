/**
 * Webview Content-Security-Policy helpers.
 *
 * VS Code applies a restrictive default Content-Security-Policy to webviews,
 * which blocks inline <script> tags unless they carry a matching nonce. These
 * helpers generate a per-load nonce and inject both the CSP <meta> tag (into
 * <head>) and the nonce attribute (onto every inline <script>) so that
 * single-file HTML webviews can execute their scripts.
 */

export function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function applyCspNonce(html: string, cspSource: string): string {
  const nonce = getNonce();
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} https: data:;">`;

  return html
    .replace('</head>', `${csp}\n  </head>`)
    .replace(/<script>/g, `<script nonce="${nonce}">`);
}
