/**
 * Supabase client — server-side only.
 *
 * Uses the secret service-role key so queries bypass Row Level Security.
 * This key MUST NOT be exposed to the frontend or committed to version control.
 *
 * Environment variables required (set in backend/.env):
 *   SUPABASE_URL        — your project URL  (https://<ref>.supabase.co)
 *   SUPABASE_SECRET_KEY — service_role JWT  (Dashboard → Project Settings → API)
 *
 * Legacy alias also accepted:
 *   SUPABASE_SERVICE_ROLE_KEY — identical to SUPABASE_SECRET_KEY
 *
 * The client is created lazily on first use so that the /api/health endpoint
 * remains available even when credentials are not yet configured.
 */

const { createClient } = require('@supabase/supabase-js');

let _client = null;

/**
 * Returns the shared Supabase client, creating it on first call.
 * Throws a descriptive Error (not process.exit) so the caller can return a
 * safe 503 to the client rather than crashing the entire server.
 */
function getClient() {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'Supabase credentials are not configured. ' +
      'Set SUPABASE_URL and SUPABASE_SECRET_KEY in backend/.env'
    );
  }

  _client = createClient(url, key, {
    auth: {
      // Disable auto-refresh — this client is a service account, not a browser session.
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  return _client;
}

module.exports = { getClient };
