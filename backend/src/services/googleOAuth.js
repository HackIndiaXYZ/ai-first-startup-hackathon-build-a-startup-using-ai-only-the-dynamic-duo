/**
 * Google OAuth service — TrialGuard Phase 3A.
 *
 * Wraps the googleapis OAuth2 client for the single Gmail-readonly flow:
 *   - builds the authorization redirect URL (offline access, consent prompt)
 *   - exchanges the authorization code for tokens
 *   - refreshes an access token from the stored encrypted refresh token
 *   - revokes tokens on disconnect
 *
 * The client is created lazily on first use (same pattern as
 * supabaseClient.js) so importing this module never crashes the server while
 * configuration is pending. Secret values are never logged and never leave
 * this process.
 *
 * Environment variables required (set in backend/.env):
 *   GOOGLE_CLIENT_ID      — OAuth 2.0 Web application client ID
 *   GOOGLE_CLIENT_SECRET  — matching client secret (server-side only)
 *   GOOGLE_REDIRECT_URI   — must match the URI registered in Google Cloud
 *                           Console exactly (http://localhost:3001/api/auth/google/callback)
 */

const { google } = require('googleapis');

const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

// Identity scopes are required so Google issues an ID token with the code
// exchange response — verifyIdToken resolves sub/email from it. Without at
// least 'openid', the token response contains NO id_token (documented:
// https://developers.google.com/identity/protocols/oauth2/native-app), which
// breaks identity resolution entirely.
const OIDC_SCOPES = ['openid', 'email'];

let _oauth2Client = null;

/** Returns the shared OAuth2 client, creating it on first call. */
function getClient() {
  if (_oauth2Client) return _oauth2Client;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Google OAuth is not configured. ' +
      'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI in backend/.env'
    );
  }

  _oauth2Client = new google.auth.OAuth2({ clientId, clientSecret, redirectUri });
  return _oauth2Client;
}

/** True when all three GOOGLE_* variables are present. */
function isConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI
  );
}

/**
 * Builds the Google authorization URL for a new connection attempt.
 * The caller generates and stores the one-time CSRF state and supplies it here.
 *
 * @param {string} state — one-time CSRF state (already persisted on the session)
 * @returns {string} absolute URL to redirect the browser to
 */
function getAuthUrl(state) {
  return getClient().generateAuthUrl({
    access_type: 'offline',   // required to receive a refresh token
    prompt: 'consent',        // force consent so a refresh token is reissued
    scope: [GMAIL_READONLY_SCOPE, ...OIDC_SCOPES],
    state,
  });
}

/**
 * Exchanges an authorization code for Google tokens.
 *
 * @param {string} code — one-time authorization code from the callback
 * @returns {{ accessToken: string, refreshToken: string|null,
 *             expiryDate: number|null, scope: string, sub: string, email: string }}
 *   sub/email come from the verified ID-token payload Google returns with the
 *   code exchange (not from any client-supplied value).
 */
async function exchangeCodeForTokens(code) {
  const { tokens } = await getClient().getToken(code);

  // Resolve the Google account identity from the verified token payload so we
  // never key a connection on anything client-supplied. The audience is
  // explicitly bound to OUR client id — an ID token minted for another OAuth
  // client (or tampered with) fails verification.
  const info = await getClient().verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = info?.payload || {};

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    expiryDate: tokens.expiry_date || null,
    scope: tokens.scope || GMAIL_READONLY_SCOPE,
    sub: payload.sub,
    email: payload.email,
  };
}

/**
 * Refreshes the access token using a (decrypted) refresh token.
 *
 * @param {string} refreshToken — plaintext refresh token, decrypted in-process
 * @returns {{ accessToken: string, expiryDate: number|null }}
 */
async function refreshAccessToken(refreshToken) {
  const client = getClient();
  client.credentials = { refresh_token: refreshToken };

  const { credentials } = await client.refreshAccessToken();

  // Defensive: Google only reissues refresh tokens on the first consent.
  // Do not let a refresh response erase the working refresh token we have.
  if (!credentials.refresh_token) credentials.refresh_token = refreshToken;

  return {
    accessToken: credentials.access_token,
    expiryDate: credentials.expiry_date || null,
  };
}

/**
 * Revokes Google tokens for the account (best-effort, used on disconnect).
 * @param {string} token — an access or refresh token to revoke
 */
async function revokeToken(token) {
  try {
    await getClient().revokeToken(token);
  } catch (err) {
    // Revoke failures (already expired, connectivity) must not block disconnect.
    console.warn('[googleOAuth] Token revocation skipped:', err.message);
  }
}

module.exports = {
  GMAIL_READONLY_SCOPE,
  getClient,
  isConfigured,
  getAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  revokeToken,
};
