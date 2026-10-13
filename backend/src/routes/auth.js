/**
 * Auth routes — TrialGuard Phase 3A.
 *
 *   GET  /api/auth/google            → starts the OAuth flow (redirect to Google)
 *   GET  /api/auth/google/callback   → Google redirect target (server-side exchange)
 *   GET  /api/auth/status            → { connected: false } | { connected: true, email }
 *   POST /api/auth/disconnect        → revokes tokens + deletes rows/cookie
 *
 * OAuth-state lifecycle (per the approved design — steps 1–5 are an ordered
 * sequence; step 6 is a single atomic conditional UPDATE):
 *   1. Resolve the session from the signed cookie.
 *   2. Require a stored oauth_state on that session.
 *   3. Require a callback state query parameter.
 *   4. Timing-safe compare the two.
 *   5. On mismatch/absence: reject WITHOUT any token work, session untouched
 *      (stays google_sub NULL → unauthenticated).
 *   6. On match: consume the state with ONE conditional UPDATE (id + current
 *      state predicate, atomic under Postgres row locks) — concurrent callbacks
 *      for the same state cannot both win. Proceed to exchange only after
 *      the consumed result is verified; replays find no pending state and fail.
 *   7. Exchange the code; persist tokens (encrypted) + set sessions.google_sub.
 *   8. Redirect back to the frontend with a sanitized ?error=code on failure.
 *
 * Refresh-token rule (fail-closed):
 *   - Google returned a refresh token → encrypt & store it.
 *   - Google returned none + existing encrypted refresh token for that
 *     google_sub → preserve (omit the column from the update).
 *   - Neither → do NOT finalize; session stays unauthenticated; redirect with
 *     ?error=auth_incomplete. Never overwrite an existing token with NULL.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const googleOAuth = require('../services/googleOAuth');
const { encrypt, decrypt } = require('../services/tokenEncryption');
const { getClient } = require('../db/supabaseClient');
const { session, createSession, destroySession } = require('../middleware/session');

const FRONTEND_URL = () =>
  process.env.FRONTEND_URL || 'http://localhost:5173';

const ERROR_CODES = {
  access_denied: 'access_denied',
  auth_incomplete: 'auth_incomplete',
  oauth_state_invalid: 'oauth_state_invalid',
  oauth_error: 'oauth_error',
  token_exchange_failed: 'token_exchange_failed',
  identity_failed: 'identity_failed',
  not_configured: 'not_configured',
  session_conflict: 'session_conflict',
};

/** Redirects to the frontend connect page with a sanitized error/success code. */
function redirectToFrontend(res, params) {
  const qs = new URLSearchParams(params).toString();
  return res.redirect(302, `${FRONTEND_URL()}/connect-email?${qs}`);
}

/** Applies a plain object update to a session row (null deletes the column). */
function sessionUpdate(supabase, id, update) {
  return supabase.from('sessions').update(update).eq('id', id);
}

// -----------------------------------------------------------------------------
// GET /api/auth/google — begin the OAuth flow
// -----------------------------------------------------------------------------
router.get('/google', session(), async (req, res, next) => {
  if (!googleOAuth.isConfigured()) {
    return next({ status: 503, message: 'Google OAuth is not configured.' });
  }

  try {
    const supabase = getClient();

    // Reuse the session this browser already holds; create one otherwise.
    if (!req.session) {
      req.session = await createSession(req, res);
    }

    // Fresh 32-byte state per attempt; single-use, never exposed as a session id.
    const state = crypto.randomBytes(32).toString('base64url');

    // Bind the state to THIS session row.
    const { error } = await sessionUpdate(supabase, req.session.id, {
      oauth_state: state,
    });
    if (error) throw error;

    // 302 to Google's consent screen (offline + consent + gmail.readonly).
    return res.redirect(302, googleOAuth.getAuthUrl(state));
  } catch (err) {
    console.error('[GET /auth/google] failed (no secrets in message):', err.message);
    return next({ status: 502, message: 'Could not start Google authorization.' });
  }
});

// -----------------------------------------------------------------------------
// GET /api/auth/google/callback — Google redirects here
// -----------------------------------------------------------------------------
router.get('/google/callback', session(), async (req, res, next) => {
  const callbackError = req.query.error;
  const callbackCode = typeof req.query.code === 'string' ? req.query.code : null;
  const callbackState = typeof req.query.state === 'string' ? req.query.state : null;

  // --- Step 1: user denied consent at Google ---------------------------------
  if (callbackError) {
    console.warn('[oauth callback] Google returned error:', callbackError);
    return redirectToFrontend(res, { error: ERROR_CODES.access_denied });
  }

  // --- Authenticated identity check before touching Google ------------------
  try {
    const supabase = getClient();

    if (!req.session) {
      // Wrong/tampered/missing cookie → no session row to advance.
      return redirectToFrontend(res, { error: ERROR_CODES.oauth_state_invalid });
    }

    // Steps 2–5 run BEFORE any binding/already-bound check so a REPLAY of a
    // completed callback fails here with no token work and leaves the
    // (already-authenticated) session untouched.
    const storedState = req.session.oauth_state;
    const hasStoredState = typeof storedState === 'string' && storedState.length > 0;
    const hasCallbackState = typeof callbackState === 'string' && callbackState.length > 0;
    const sameLength = hasStoredState && hasCallbackState &&
      storedState.length === callbackState.length;

    // Timing-safe compare: fixed-width SHA-256 digests of both states.
    let statesMatch = false;
    if (hasStoredState && hasCallbackState && sameLength) {
      const a = crypto.createHash('sha256').update(storedState).digest();
      const b = crypto.createHash('sha256').update(callbackState).digest();
      statesMatch = crypto.timingSafeEqual(a, b);
    }

    if (statesMatch && callbackCode) {
      // Potential fresh, valid attempt — but a session that is already bound
      // to an account must never be rebound (step 5 guard).
      if (req.session.google_sub) {
        console.warn('[oauth callback] already-bound session rejected');
        return redirectToFrontend(res, { error: ERROR_CODES.session_conflict });
      }
    } else {
      // Mismatch / missing state / missing code — reject WITHOUT any token
      // work, without touching the session's authentication binding.
      console.warn('[oauth callback] state validation failed; no token exchange');
      return redirectToFrontend(res, { error: ERROR_CODES.oauth_state_invalid });
    }

    // --- Step 6: ATOMIC conditional consume (single-use), verify the write --
    // One SQL statement: UPDATE sessions SET oauth_state = NULL
    //   WHERE id = <this session> AND oauth_state = <the value we validated>.
    // Postgres row-level locking makes this genuinely atomic: of two concurrent
    // callbacks carrying the same state, the first UPDATE matches 1 row and
    // the second re-evaluates the predicate on the locked row (now NULL) and
    // matches 0 rows. `.select('oauth_state')` returns the affected rows, so
    // exactly one row proves THIS request won the consume; zero rows means a
    // concurrent request already consumed the state (or it is gone) and we
    // abort BEFORE exchanging the code. No application-level race is possible.
    const { data: cleared, error: clearError } = await supabase
      .from('sessions')
      .update({ oauth_state: null })
      .eq('id', req.session.id)
      .eq('oauth_state', storedState)
      .select('oauth_state');

    const consumedOk = !clearError && Array.isArray(cleared) &&
      cleared.length === 1 && cleared[0].oauth_state === null;

    if (!consumedOk) {
      // Could not prove single-use consumption → do not proceed to Google.
      console.error('[oauth callback] failed to consume oauth_state; aborting before exchange');
      return redirectToFrontend(res, { error: ERROR_CODES.oauth_state_invalid });
    }

    // --- Step 7: exchange & persist ---------------------------------------
    try {
      const tokens = await googleOAuth.exchangeCodeForTokens(callbackCode);

      if (!tokens.sub || !tokens.email) {
        console.error('[oauth callback] could not resolve Google identity');
        return redirectToFrontend(res, { error: ERROR_CODES.identity_failed });
      }

      // Scope verification: the account must hold gmail.readonly.
      const grantedScopes = String(tokens.scope || '').split(' ');
      if (!grantedScopes.includes(googleOAuth.GMAIL_READONLY_SCOPE)) {
        console.error('[oauth callback] gmail.readonly scope missing');
        return redirectToFrontend(res, { error: ERROR_CODES.auth_incomplete });
      }

      // Refresh-token durability decision (fail-closed).
      const { data: existing } = await supabase
        .from('gmail_tokens')
        .select('encrypted_refresh_token')
        .eq('google_sub', tokens.sub)
        .maybeSingle();

      const hasExistingRt = Boolean(existing?.encrypted_refresh_token);
      const newRt = tokens.refreshToken || null;

      if (!newRt && !hasExistingRt) {
        // Cannot make the connection durable → do not finalize.
        console.warn('[oauth callback] no refresh token available; not finalizing');
        return redirectToFrontend(res, { error: ERROR_CODES.auth_incomplete });
      }

      const upsert = {
        google_sub: tokens.sub,
        email: tokens.email,
        // Ciphertext only — plaintext never leaves the process boundary.
        encrypted_access_token: encrypt(tokens.accessToken),
        token_expiry: tokens.expiryDate
          ? new Date(tokens.expiryDate).toISOString()
          : new Date(Date.now() + 3600 * 1000).toISOString(),
        scope: tokens.scope,
      };
      if (newRt) {
        upsert.encrypted_refresh_token = encrypt(newRt); // canonical fresh RT
      }
      // else: omit the column — the existing ciphertext survives untouched.

      const { error: tokErr } = await supabase
        .from('gmail_tokens')
        .upsert(upsert, { onConflict: 'google_sub' });
      if (tokErr) throw tokErr;

      // Only NOW mark the session authenticated.
      const { error: sessErr } = await sessionUpdate(supabase, req.session.id, {
        google_sub: tokens.sub,
      });
      if (sessErr) throw sessErr;

      return redirectToFrontend(res, { connected: 'true', email: tokens.email });
    } catch (err) {
      console.error('[oauth callback] token exchange failed (details suppressed):', err.message);
      return redirectToFrontend(res, { error: ERROR_CODES.token_exchange_failed });
    }
  } catch (err) {
    // Outer guard: never leak internals; session remains unauthenticated.
    console.error('[oauth callback] unexpected failure (details suppressed):', err.message);
    return redirectToFrontend(res, { error: ERROR_CODES.oauth_error });
  }
});

// -----------------------------------------------------------------------------
// GET /api/auth/status
// -----------------------------------------------------------------------------
router.get('/status', session(), async (req, res) => {
  if (!req.session?.google_sub) {
    return res.json({ connected: false });
  }
  // Only the display email is exposed — never tokens, scope, or ids.
  try {
    const { data } = await getClient()
      .from('gmail_tokens')
      .select('email')
      .eq('google_sub', req.session.google_sub)
      .maybeSingle();
    if (!data?.email) {
      // Token row missing → the connection is not usable; treat as disconnected.
      return res.json({ connected: false });
    }
    return res.json({ connected: true, email: data.email });
  } catch (err) {
    console.warn('[auth/status] lookup failed:', err.message);
    // Fail closed: an unreachable database must not report connected=true.
    return res.status(502).json({ connected: false, error: 'Status unavailable.' });
  }
});

// -----------------------------------------------------------------------------
// POST /api/auth/disconnect
// -----------------------------------------------------------------------------
router.post('/disconnect', session(), async (req, res, next) => {
  if (!req.session?.google_sub) {
    return res.status(409).json({ error: 'No connection to disconnect.' });
  }

  try {
    const supabase = getClient();
    const googleSub = req.session.google_sub;

    // Load the encrypted refresh token for revocation (decrypt in-process).
    const { data: tokenRow } = await supabase
      .from('gmail_tokens')
      .select('encrypted_refresh_token, encrypted_access_token')
      .eq('google_sub', googleSub)
      .maybeSingle();

    // Best-effort revoke: decrypt inside this process only.
    // Best-effort revoke: decrypt inside this process only.
    if (tokenRow?.encrypted_refresh_token || tokenRow?.encrypted_access_token) {
      try {
        const stored = tokenRow.encrypted_refresh_token || tokenRow.encrypted_access_token;
        await googleOAuth.revokeToken(decrypt(stored));
      } catch (e) {
        console.warn('[disconnect] revoke skipped:', e.message?.slice(0, 80));
      }
    }

    // Delete the token row (no cache, no soft-delete in this phase).
    const { error: delTokErr } = await supabase
      .from('gmail_tokens')
      .delete()
      .eq('google_sub', googleSub);
    if (delTokErr) throw delTokErr;

    // Delete the session row + clear the cookie.
    await destroySession(req, res);

    return res.json({ success: true });
  } catch (err) {
    console.error('[disconnect] failed (details suppressed):', err.message);
    return next({ status: 502, message: 'Disconnect failed. Please try again.' });
  }
});

module.exports = router;
