/**
 * Auth service layer — TrialGuard Phase 3A C4 (Gmail OAuth, frontend).
 *
 * Talks to the Express backend's committed C3 endpoints (see
 * backend/src/routes/auth.js) over the same-origin Vite proxy:
 *
 *   GET  /api/auth/google       → 302 to Google (full browser redirect; the
 *                                 frontend NEVER sees or exchanges the code)
 *   GET  /api/auth/status      → { connected: false } |
 *                                { connected: true, email: "..." }
 *   POST /api/auth/disconnect  → { success: true }
 *
 * SECURITY: no Google tokens and no session identifiers are ever available
 * here — the session lives in a signed HttpOnly cookie and the tokens in
 * AES-256-GCM ciphertext server-side. Nothing from this module is written to
 * localStorage/sessionStorage. The only data exposed is the display email.
 */

const BASE_URL = '/api';

/** All requests ride the Vite proxy to the Express backend on localhost:3001. */
export const GMAIL_OAUTH_START_URL = `${BASE_URL}/auth/google`;

/** Mapping from sanitizer backend error codes (auth.js ERROR_CODES) to UI text. */
export const CALLBACK_ERROR_MESSAGES = {
  access_denied:
    'Google authorization was cancelled. No email was connected.',
  auth_incomplete:
    'Connection wasn’t completed — your browser did not provide a reusable authorization. Please try connecting again.',
  oauth_state_invalid:
    'Your connection attempt expired or was replayed. For your security it was rejected — please try connecting again.',
  oauth_error:
    'Something went wrong during authorization. Please try connecting again.',
  token_exchange_failed:
    'TrialGuard could not complete the connection with Google. Please try again shortly.',
  identity_failed:
    'TrialGuard could not confirm your Google account identity. Please try again.',
  not_configured:
    'Gmail connection is not available yet. Please try again later.',
  session_conflict:
    'This browser session was already used for another connection attempt. Please try connecting again.',
};

/** Parses the OAuth callback redirect query (success or error) from a location. */
export function parseCallbackParams(queryString) {
  const params = new URLSearchParams(queryString);
  const result = { successEmail: null, errorCode: null };

  if (params.get('connected') === 'true') {
    const email = params.get('email');
    result.successEmail = email && email.includes('@') ? email : null;
  }
  if (params.has('error')) {
    const code = params.get('error');
    result.errorCode = CALLBACK_ERROR_MESSAGES[code] ? code : 'oauth_error';
  }
  return result;
}

/* Internal: fetch with credentials ALWAYS included so the signed HttpOnly
   session cookie rides along (same-origin via proxy). */
async function authFetch(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    credentials: 'include',
    ...options,
  });

  return res;
}

/**
 * Checks whether this browser is connected to a Gmail account.
 * Resolves { connected, email?: string } — the server's cookie alone decides.
 * Rejects on network/service failure (never reports connected on failure).
 */
export async function getAuthStatus() {
  let res;
  try {
    res = await authFetch('/auth/status', { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error('Could not reach TrialGuard services. Check that the backend is running.', {
      cause: err,
    });
  }

  if (res.status === 502) {
    throw new Error('Connection status is temporarily unavailable. Try again in a moment.');
  }
  if (!res.ok) {
    throw new Error(`Connection status failed (${res.status}).`);
  }

  const body = await res.json().catch(() => null);

  // Strict shape validation — ignore anything unexpected the server might send.
  if (body && body.connected === true && typeof body.email === 'string' && body.email.includes('@')) {
    return { connected: true, email: body.email };
  }
  if (body && body.connected === false) {
    return { connected: false };
  }
  throw new Error('Connection status response was not recognized.');
}

/**
 * Disconnects the connected Gmail account for this browser session.
 * Resolves true on success; rejects with a user-facing message otherwise.
 * On success the backend deleted the session row and cleared the cookie.
 */
export async function disconnectGmail() {
  let res;
  try {
    res = await authFetch('/auth/disconnect', {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw new Error('Could not reach TrialGuard services. Check that the backend is running.', {
      cause: err,
    });
  }

  if (res.status === 409) {
    // Nothing to disconnect — treat as already-disconnected success state.
    return true;
  }
  if (!res.ok) {
    throw new Error('Disconnecting failed in TrialGuard. Please try again.');
  }

  const body = await res.json().catch(() => null);
  if (!body || body.success !== true) {
    throw new Error('Disconnecting failed in TrialGuard. Please try again.');
  }
  return true;
}
