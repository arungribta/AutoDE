import * as crypto from 'node:crypto';

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Snowflake requires an account identifier with no periods in JWT claims — hyphens replace them. */
function normalizeAccountForJwt(account: string): string {
  return account.toUpperCase().replace(/\./g, '-');
}

/**
 * Builds a Snowflake key-pair JWT (RS256) for SQL API v2 authentication, using only
 * Node's built-in `crypto` — no `jsonwebtoken` dependency. Claim shape and the
 * public-key-fingerprint `iss` format are Snowflake's own documented convention:
 * https://docs.snowflake.com/en/developer-guide/sql-api/authenticating
 *
 * `exp` is capped at Snowflake's own hard 60-minute ceiling regardless of what's requested.
 */
export function buildSnowflakeKeyPairJwt(opts: {
  account: string;
  username: string;
  privateKeyPem: string;
  passphrase?: string;
  expiresInSeconds?: number;
}): string {
  const privateKey = crypto.createPrivateKey(
    opts.passphrase ? { key: opts.privateKeyPem, passphrase: opts.passphrase } : opts.privateKeyPem
  );
  const publicKeyDer = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const fingerprint = crypto.createHash('sha256').update(publicKeyDer).digest('base64');

  const account = normalizeAccountForJwt(opts.account);
  const user = opts.username.toUpperCase();
  const iss = `${account}.${user}.SHA256:${fingerprint}`;
  const sub = `${account}.${user}`;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const requested = opts.expiresInSeconds ?? 3300;
  const exp = nowSeconds + Math.max(60, Math.min(requested, 3600));

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iss, sub, iat: nowSeconds, exp };

  const headerPart = base64url(Buffer.from(JSON.stringify(header)));
  const payloadPart = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerPart}.${payloadPart}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);

  return `${signingInput}.${base64url(signature)}`;
}
