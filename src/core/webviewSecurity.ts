/**
 * Webview Content-Security-Policy helpers.
 *
 * VS Code applies a restrictive default Content-Security-Policy to webviews,
 * which blocks inline <script> tags unless they carry a matching nonce. These
 * helpers generate a per-load nonce and inject both the CSP <meta> tag (into
 * <head>) and the nonce attribute (onto every inline <script>) so that
 * single-file HTML webviews can execute their scripts.
 */

import { randomBytes } from 'crypto';

export function getNonce(): string {
  // Cryptographically random, base64: a predictable nonce would defeat the CSP.
  return randomBytes(24).toString('base64');
}

/** Text as a JavaScript expression that is safe inside an inline <script>: a JSON string with < and line separators escaped. */
export function scriptValue(text: string): string {
  return JSON.stringify(text)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function applyCspNonce(html: string, cspSource: string): string {
  const nonce = getNonce();
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} data:;">`;

  return html
    .replace('</head>', `${csp}\n  </head>`)
    .replace(/<script>/g, `<script nonce="${nonce}">`);
}
