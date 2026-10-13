/**
 * Session middleware — TrialGuard Phase 3A.
 *
 * Opaque, signed, HttpOnly, SameSite=Lax cookie backed by a `public.sessions`
 * row in Supabase. The cookie contains ONLY the session id (256-bit hex); the
 * signature comes from SESSION_SECRET via cookie-parser. A session row alone
 * never proves authentication — `google_sub` stays NULL until a completed
 * OAuth callback sets it.
 *
 * Environment variables required (set in backend/.env):
 *   SESSION_SECRET — string for signing the session cookie. Generate with:
 *     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

const crypto = require('crypto');
const { getClient } = require('../db/supabaseClient');

const COOKIE_NAME = 'trialguard_session';
const SESSION_TTL_DAYS = 30;

/**
 * Reads the session id from the signed cookie and loads its row.
 * Returns the row or null when the cookie is absent, unsigned/tampered, or the
 * row is missing or expired. Expired rows are deleted on sight (best-effort).
 */
async function loadSession(req) {
  // Read ONLY the signature-verified cookie (cookie-parser with a secret
  // populates req.signedCookies). A raw or tampered value in req.cookies
  // must never resolve to a session row.
  const id = req.signedCookies ? req.signedCookies[COOKIE_NAME] : undefined;
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/i.test(id)) return null;

  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from('sessions')
      .select('id, google_sub, oauth_state, created_at, expires_at')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    if (new Date(data.expires_at).getTime() <= Date.now()) {
      await supabase.from('sessions').delete().eq('id', id);
      return null;
    }
    return data;
  } catch (err) {
    // Never leak DB internals into the request path.
    console.warn('[session] load failed:', err.message);
    return null;
  }
}

/**
 * Creates a session row and sets the signed HttpOnly cookie.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<{ id: string }>} the new session row
 */
async function createSession(req, res) {
  const id = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const supabase = getClient();
  const { error } = await supabase
    .from('sessions')
    .insert({ id, google_sub: null, oauth_state: null, expires_at: expiresAt });
  if (error) throw error;

  setCookie(res, id);
  return { id };
}

/** Sets the session cookie with the hardened options used across the flow. */
function setCookie(res, id) {
  res.cookie(COOKIE_NAME, id, {
    httpOnly: true,
    secure: false,           // localhost dev; flip to true when served over HTTPS
    sameSite: 'lax',         // survives the Google top-level redirect back
    signed: true,
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

/** Clears the session cookie regardless of its prior value. */
function clearCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    signed: true,
    path: '/',
  });
}

/**
 * Middleware factory: attaches req.session (row or null). When
 * `requireAuth` is true, unauthenticated requests get a 401 JSON response
 * instead of proceeding. "Authenticated" means the session row has a
 * non-null google_sub.
 */
function session({ requireAuth = false } = {}) {
  return async (req, res, next) => {
    try {
      req.session = await loadSession(req);
    } catch (err) {
      console.error('[session] unexpected load error:', err.message);
      req.session = null;
    }

    if (requireAuth && (typeof req.session?.google_sub !== 'string' || !req.session.google_sub)) {
      return res.status(401).json({ error: 'Not connected.' });
    }
    next();
  };
}

/**
 * Deletes the sessions row (by id) and clears the cookie. Used by
 * POST /api/auth/disconnect and by the 403 foreign-session callback path.
 */
async function destroySession(req, res) {
  const id = req.session?.id;
  if (id) {
    try {
      await getClient().from('sessions').delete().eq('id', id);
    } catch (err) {
      console.warn('[session] delete failed:', err.message);
    }
  }
  clearCookie(res);
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_DAYS,
  session,
  createSession,
  destroySession,
  clearCookie,
};
