/**
 * C3 test harness — TrialGuard Phase 3A OAuth backend integration.
 *
 * Self-contained and secrets-free: no real Google credentials, no live
 * Supabase, no network calls. The @supabase/supabase-js and googleapis
 * modules are stubbed in Node's require cache; scenarios run against an
 * in-memory database. Verifies:
 *
 *   Flow/cookie:
 *     1.  GET /api/auth/google → 302 to accounts.google.com with offline +
 *         consent + gmail.readonly and a 32-byte state bound to the session.
 *         Signed HttpOnly SameSite=Lax cookie issued.
 *     2.  Second browser gets its own session/state.
 *   State lifecycle:
 *     3.  Callback with wrong state → 302 ?error=oauth_state_invalid, NO
 *         token exchange, google_sub stays NULL.
 *     4.  Callback with missing state → same rejection.
 *     5.  Successful callback consumes the state; replaying the same URL
 *         fails at the no-pending-state check with NO second exchange.
 *   Durability (fail-closed refresh-token rule):
 *     6.  No RT from Google + no stored RT → not finalized,
 *         ?error=auth_incomplete; no token row; session stays unauthenticated.
 *     7.  No RT from Google + existing stored RT → RT preserved (payload
 *         omitted refresh column), session then authenticated, ?connected=true.
 *   Disconnect:
 *     8.  POST /api/auth/disconnect deletes token + session rows, clears the
 *         cookie, returns { success: true }.
 *
 * Usage: node backend/scripts/test-auth-routes.js   (prints PASS/FAIL only)
 */

process.env.NODE_ENV = 'test';
process.env.PORT = '3099';
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3001/api/auth/google/callback';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.SESSION_SECRET = 'c3-harness-session-secret';
process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
// Throwaway test-only values so supabaseClient.getClient() passes its config
// check and reaches the stubbed createClient. No real Supabase project is
// contacted — @supabase/supabase-js is fully stubbed in the require cache.
process.env.SUPABASE_URL = 'https://stub.supabase.test';
process.env.SUPABASE_SECRET_KEY = 'stub-service-role-key';

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const Module = require('module');

const backendRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// In-memory database
// ---------------------------------------------------------------------------
const db = { sessions: [], gmail_tokens: [] };

// Per-scenario Google stub configuration.
let googleConfig = {};
const googleCalls = { exchange: 0 };

// query.builder state table names.
const TABLES = ['sessions', 'gmail_tokens'];

// ---------------------------------------------------------------------------
// Fake Supabase client
// ---------------------------------------------------------------------------
function makeSupabaseStub() {
  function from(tableName) {
    if (!TABLES.includes(tableName)) {
      throw new Error(`Harness: unexpected table ${tableName}`);
    }

    // Filter list; each entry [col, val]. Multiple eq() filters AND together.
    const filters = [];
    let op = 'select';
    let payload = null;
    let selectCols = null;

    function rows() {
      return db[tableName];
    }

    function matches(row) {
      return filters.every(([c, v]) => row[c] === v);
    }

    function matchingRows() {
      return rows().filter(matches);
    }

    function pickCols(row) {
      if (!selectCols || selectCols === '*') return { ...row };
      return Object.fromEntries(
        selectCols.split(',').map((c) => [c.trim(), row[c.trim()]])
      );
    }

    const result = {
      select(cols) {
        selectCols = cols;
        return result;
      },
      eq(col, val) {
        filters.push([col, val]);
        return result;
      },
      maybeSingle() {
        return Promise.resolve({
          data: matchingRows()[0] ?? null,
          error: null,
        });
      },
      single() {
        return Promise.resolve({
          data: matchingRows()[0] ?? null,
          error: null,
        });
      },
      update(upd) {
        payload = upd;
        op = 'update';
        return result;
      },
      insert(obj) {
        payload = obj;
        op = 'insert';
        return result;
      },
      delete() {
        op = 'delete';
        return result;
      },
      upsert(obj) {
        payload = obj;
        op = 'upsert';
        return result;
      },
      order() { return result; }, // unused here, keeps chains simple
      then(resolve, reject) {
        try {
          if (op === 'insert' || op === 'upsert') {
            const rowsIn = Array.isArray(payload) ? payload : [payload];
            for (const row of rowsIn) {
              if (op === 'upsert') {
                // upsert on google_sub conflict: replace the existing row.
                const conflictCol = 'google_sub';
                const existing = rows().find((r) => r[conflictCol] === row[conflictCol]);
                if (existing) Object.assign(existing, row);
                else rows().push({ ...row });
              } else {
                rows().push({ ...row });
              }
            }
            return resolve({ data: rowsIn.map((r) => ({ ...r })), error: null });
          }
          if (op === 'update') {
            const matching = matchingRows();
            for (const row of matching) Object.assign(row, payload);
            // PostgREST returns rows only with .select(); auth.js uses
            // update(...).select('oauth_state') to verify consumption.
            const data = selectCols ? matching.map(pickCols) : matching.map((r) => ({ ...r }));
            return resolve({ data, error: null });
          }
          if (op === 'delete') {
            const before = rows().length;
            db[tableName] = rows().filter((r) => !matches(r));
            return resolve({ data: null, error: before !== rows().length ? null : null });
          }
          // select
          return resolve({ data: matchingRows().map(pickCols), error: null });
        } catch (e) {
          reject(e);
        }
      },
    };
    return result;
  }
  return { from };
}

// ---------------------------------------------------------------------------
// Fake Google OAuth2 client
// ---------------------------------------------------------------------------
class FakeOAuth2 {
  generateAuthUrl(opts) {
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      response_type: 'code',
      access_type: opts.access_type,
      prompt: opts.prompt,
      scope: opts.scope.join(' '),
      state: opts.state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async getToken() {
    googleCalls.exchange += 1;
    const tokens = {
      access_token: 'at_' + crypto.randomBytes(6).toString('hex'),
      expiry_date: Date.now() + 3600_000,
      scope: 'https://www.googleapis.com/auth/gmail.readonly misc.scope',
      id_token: 'fake-id-token',
    };
    if (googleConfig.refreshToken) tokens.refresh_token = googleConfig.refreshToken;
    return { tokens };
  }

  async verifyIdToken() {
    return {
      payload: { sub: googleConfig.sub || 'sub_default', email: googleConfig.email || 'user@example.com' },
    };
  }

  async refreshAccessToken() {
    return { credentials: { access_token: 'at_refreshed', expiry_date: Date.now() + 3600_000 } };
  }

  async revokeToken() { /* counted via db state in the harness */ }
  set credentials(v) { /* googleOAuth.js assigns credentials before refresh */ }
  get credentials() { return { refresh_token: googleConfig.refreshToken || 'rt_default' }; }
}

function makeGoogleStub() {
  return {
    google: {
      auth: { OAuth2: FakeOAuth2 },
      gmail: () => ({}),
    },
  };
}

// ---------------------------------------------------------------------------
// require-cache interposition (installed for the process lifetime, since
// supabaseClient.js builds its client lazily at request time)
// ---------------------------------------------------------------------------
const origLoad = Module._load;
Module._load = function stubbedLoad(request, parent, isMain) {
  if (request === '@supabase/supabase-js') {
    return { createClient: () => makeSupabaseStub() };
  }
  if (request === 'googleapis') {
    return makeGoogleStub();
  }
  return origLoad.call(this, request, parent, isMain);
};

const tokenEncryption = require(path.join(backendRoot, 'src/services/tokenEncryption'));
const authRouter = require(path.join(backendRoot, 'src/routes/auth'));
const { COOKIE_NAME } = require(path.join(backendRoot, 'src/middleware/session'));

// ---------------------------------------------------------------------------
// Minimal Express app on a real port (cookie signing is exercised for real)
// ---------------------------------------------------------------------------
const express = require(path.join(backendRoot, 'node_modules/express'));
const cookieParser = require(path.join(backendRoot, 'node_modules/cookie-parser'));

let server;

function startServer() {
  const app = express();
  app.use(cookieParser(process.env.SESSION_SECRET));
  app.use('/api/auth', authRouter);
  return new Promise((resolve) => {
    server = app.listen(3099, '127.0.0.1', resolve);
  });
}

async function stopServer() {
  return new Promise((resolve) => server.close(resolve));
}

function request(urlPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: 3099, path: urlPath, method, headers },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// The signed cookie value as sent back in a Cookie header (s:"..." form).
function signedCookieHeader(res) {
  const raw = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!raw) return null;
  return raw.split(';')[0];
}

function stateFromAuthUrl(location) {
  return new URL(location, 'http://placeholder').searchParams.get('state');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
const results = [];
let passCount = 0;
let failCount = 0;

function check(name, condition, extra) {
  if (condition) {
    passCount += 1;
    results.push(`PASS  ${name}`);
  } else {
    failCount += 1;
    results.push(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function reset() {
  db.sessions.length = 0;
  db.gmail_tokens.length = 0;
  googleCalls.exchange = 0;
  googleConfig = {};
}

async function run() {
  await startServer();

  try {
    // ---------------------------------------------------------------------
    // Scenarios 1–2: start flow, second browser isolation
    // ---------------------------------------------------------------------
    reset();
    console.log('sessions table stub w/ real routes; starting scenario 1');
    const res1 = await request('/api/auth/google');
    check('1. start issues 302 redirect', res1.status === 302, `status=${res1.status}`);

    const authUrlRaw = res1.headers.location || '';
    const authUrl = new URL(authUrlRaw, 'http://placeholder');
    const p = authUrl.searchParams;
    check(
      '1a. redirect targets Google accounts endpoint',
      `${authUrl}`.startsWith('https://accounts.google.com/o/oauth2/v2/auth'),
      authUrlRaw.slice(0, 100)
    );
    check(
      '1b. offline + consent + gmail.readonly in auth URL',
      p.get('access_type') === 'offline' &&
        p.get('prompt') === 'consent' &&
        (p.get('scope') || '').includes('gmail.readonly'),
      authUrlRaw.slice(0, 100)
    );
    const state1 = p.get('state') || '';
    check(
      '1c. state is 32 bytes of base64url (43 chars)',
      /^[A-Za-z0-9_-]{43}$/.test(state1),
      `len=${state1.length}`
    );

    const raw1 = (res1.headers['set-cookie'] || []).find((c) => c.startsWith(`${COOKIE_NAME}=`));
    check(
      '1d. cookie is HttpOnly, SameSite=Lax, signed (s: prefix after decode)',
      !!raw1 &&
        /HttpOnly/i.test(raw1) &&
        /SameSite=Lax/i.test(raw1) &&
        signedCookieHeader(res1).startsWith(`${COOKIE_NAME}=s%3A`),
      raw1 ? raw1.slice(0, 80) : '(no cookie)'
    );

    check(
      '1e. exactly one session row storing this state',
      db.sessions.filter((s) => s.oauth_state === state1).length === 1 &&
        db.sessions.length === 1,
      `sessions=${db.sessions.length}`
    );

    // Second independent "browser": reuse browser 1's cookie, but assert the
    // flow rebinds the SAME session row to a NEW state (fresh attempt) rather
    // than creating an unbounded number of sessions.
    const res2 = await request('/api/auth/google', {
      headers: { cookie: signedCookieHeader(res1) },
    });
    const state2 = stateFromAuthUrl(res2.headers.location || '');
    check(
      '2. repeat visit issues a fresh state on the same session',
      res2.status === 302 &&
        state2 !== state1 &&
        db.sessions.length === 1 &&
        db.sessions[0].oauth_state === state2,
      `oldState !== newState: ${state1 !== state2}`
    );

    // ---------------------------------------------------------------------
    // Scenario 3: tampered state → reject without token exchange
    // ---------------------------------------------------------------------
    const resT = await request('/api/auth/google/callback?code=fake-code&state=TAMPERED', {
      headers: { cookie: signedCookieHeader(res2) },
    });
    check(
      '3. tampered state rejected with no token exchange',
      resT.status === 302 &&
        (resT.headers.location || '').includes('error=oauth_state_invalid') &&
        googleCalls.exchange === 0 &&
        db.sessions.every((s) => s.google_sub === null),
      `exchanges=${googleCalls.exchange}`
    );

    // ---------------------------------------------------------------------
    // Scenario 4: missing state → reject without token exchange
    // ---------------------------------------------------------------------
    const resM = await request('/api/auth/google/callback?code=fake-code', {
      headers: { cookie: signedCookieHeader(res2) },
    });
    check(
      '4. missing state rejected with no token exchange',
      resM.status === 302 &&
        (resM.headers.location || '').includes('error=oauth_state_invalid') &&
        googleCalls.exchange === 0,
      `exchanges=${googleCalls.exchange}`
    );

    // ---------------------------------------------------------------------
    // Scenarios 5–7: status endpoint sanity before / after connect
    // ---------------------------------------------------------------------
    reset();
    const resS1 = await request('/api/auth/status');
    check(
      '3a. status with no session: { connected: false }',
      resS1.status === 200 && JSON.parse(resS1.body).connected === false,
      `body=${resS1.body.slice(0, 60)}`
    );

    // ---------------------------------------------------------------------
    // Scenario 5–6: happy path + replay
    // ---------------------------------------------------------------------
    reset();
    googleConfig = { refreshToken: 'rt_new_value', sub: 'sub_abc', email: 'user@example.com' };

    const resH = await request('/api/auth/google');
    const cookieH = signedCookieHeader(resH);
    const stateH = stateFromAuthUrl(resH.headers.location || '');
    const resCb = await request(
      `/api/auth/google/callback?code=one-time-code&state=${stateH}`,
      { headers: { cookie: cookieH } }
    );
    const locCb = resCb.headers.location || '';
    check(
      '5. happy path: exchange + connected=true redirect with email',
      resCb.status === 302 &&
        locCb.includes('connected=true') &&
        locCb.includes('email=user%40example.com') &&
        googleCalls.exchange === 1,
      `loc=${decodeURIComponent(locCb).slice(0, 90)}, exchanges=${googleCalls.exchange}`
    );
    check(
      '6a. token row stored with encrypted AT + RT instead of plaintext',
      db.gmail_tokens.length === 1 &&
        db.gmail_tokens[0].google_sub === 'sub_abc' &&
        /^\S+$/.test(db.gmail_tokens[0].encrypted_access_token) &&
        /^\S+$/.test(db.gmail_tokens[0].encrypted_refresh_token) &&
        !JSON.stringify(db.gmail_tokens[0]).includes('at_')
    );
    check(
      '6b. session bound to google_sub after success',
      db.sessions.some((s) => s.google_sub === 'sub_abc')
    );
    const encRt = db.gmail_tokens[0]?.encrypted_refresh_token;
    check(
      '6c. stored RT decrypts to the Google-issued value',
      typeof encRt === 'string' &&
        tokenEncryption.decrypt(encRt) === 'rt_new_value'
    );

    // Replay the exact same callback URL against the SAME session cookie.
    const resReplay = await request(
      `/api/auth/google/callback?code=one-time-code&state=${stateH}`,
      { headers: { cookie: cookieH } }
    );
    check(
      '5b. replay hits no-pending-state rejection with no second exchange',
      resReplay.status === 302 &&
        (resReplay.headers.location || '').includes('error=oauth_state_invalid') &&
        googleCalls.exchange === 1,
      `exchanges=${googleCalls.exchange}`
    );

    // Status endpoint while connected.
    const resS2 = await request('/api/auth/status', {
      headers: { cookie: signedCookieHeader(resCb) ? signedCookieHeader(resCb) : cookieH },
    });
    check(
      '6d. status while connected: { connected: true, email }',
      resS2.status === 200 &&
        JSON.parse(resS2.body).connected === true &&
        JSON.parse(resS2.body).email === 'user@example.com',
      `body=${resS2.body.slice(0, 60)}`
    );

    // ---------------------------------------------------------------------
    // Scenario 6 (fail-closed): no RT from Google + no stored RT
    // ---------------------------------------------------------------------
    reset();
    googleConfig = { refreshToken: undefined, sub: 'sub_nc', email: 'nc@example.com' };

    const resN1 = await request('/api/auth/google');
    const stateN = stateFromAuthUrl(resN1.headers.location || '');
    const resN2 = await request(
      `/api/auth/google/callback?code=code-nc&state=${stateN}`,
      { headers: { cookie: signedCookieHeader(resN1) } }
    );
    const locN = resN2.headers.location || '';
    check(
      '7. fail-closed: no RT anywhere → not finalized; auth_incomplete',
      resN2.status === 302 &&
        locN.includes('error=auth_incomplete') &&
        db.gmail_tokens.length === 0 &&
        db.sessions.every((s) => s.google_sub === null) &&
        googleCalls.exchange === 1,
      `loc=${decodeURIComponent(locN).slice(0, 90)}`
    );

    // ---------------------------------------------------------------------
    // Scenario 7 (preserve): no RT from Google + existing stored RT
    // ---------------------------------------------------------------------
    reset();
    const existingCipher = tokenEncryption.encrypt('the-original-refresh-token');
    db.gmail_tokens.push({
      google_sub: 'sub_preserve',
      email: 'pres@example.com',
      encrypted_access_token: tokenEncryption.encrypt('old-access'),
      encrypted_refresh_token: existingCipher,
      token_expiry: new Date().toISOString(),
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
    });
    googleConfig = { refreshToken: undefined, sub: 'sub_preserve', email: 'pres@example.com' };

    const resP1 = await request('/api/auth/google');
    const stateP = stateFromAuthUrl(resP1.headers.location || '');
    const resP2 = await request(
      `/api/auth/google/callback?code=code-p&state=${stateP}`,
      { headers: { cookie: signedCookieHeader(resP1) } }
    );
    const locP = resP2.headers.location || '';
    const rowP = db.gmail_tokens.find((t) => t.google_sub === 'sub_preserve');
    check(
      '8. preserve: existing RT byte-identical, connection finalizes',
      resP2.status === 302 &&
        locP.includes('connected=true') &&
        !!rowP &&
        rowP.encrypted_refresh_token === existingCipher &&
        tokenEncryption.decrypt(rowP.encrypted_refresh_token) === 'the-original-refresh-token' &&
        db.sessions.some((s) => s.google_sub === 'sub_preserve'),
      `loc=${decodeURIComponent(locP).slice(0, 90)}`
    );

    // ---------------------------------------------------------------------
    // Scenario 8: disconnect
    // ---------------------------------------------------------------------
    reset();
    googleConfig = { refreshToken: 'rt_disc', sub: 'sub_disc', email: 'disc@example.com' };
    const resD1 = await request('/api/auth/google');
    const stateD = stateFromAuthUrl(resD1.headers.location || '');
    const resD2 = await request(
      `/api/auth/google/callback?code=code-d&state=${stateD}`,
      { headers: { cookie: signedCookieHeader(resD1) } }
    );
    const cookieD = signedCookieHeader(resD2) || signedCookieHeader(resD1);
    check(
      '8a. pre-disconnect setup: session authenticated',
      db.sessions.some((s) => s.google_sub === 'sub_disc') && db.gmail_tokens.length === 1
    );

    const resDisc = await request('/api/auth/disconnect', {
      method: 'POST',
      headers: { cookie: cookieD },
    });
    let discBody = {};
    try { discBody = JSON.parse(resDisc.body || '{}'); } catch { /* noop */ }
    const clearedCookie = (resDisc.headers['set-cookie'] || []).find((c) =>
      c.startsWith(`${COOKIE_NAME}=`) && /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(c)
    );
    check(
      '8. disconnect deletes rows, clears cookie, { success: true }',
      resDisc.status === 200 &&
        discBody.success === true &&
        db.gmail_tokens.length === 0 &&
        db.sessions.length === 0 &&
        !!clearedCookie,
      `status=${resDisc.status}, rows: tokens=${db.gmail_tokens.length} sessions=${db.sessions.length}`
    );

    // Status after disconnect (fresh, cookie-less).
    const resS3 = await request('/api/auth/status');
    check(
      '8b. status after disconnect: { connected: false }',
      resS3.status === 200 && JSON.parse(resS3.body).connected === false
    );

    // ---------------------------------------------------------------------
    // Scenario 9: concurrent callbacks race for the same state — the
    // conditional UPDATE (id + oauth_state predicate) must allow exactly
    // ONE consume → one token exchange; the loser aborts with
    // oauth_state_invalid having performed NO token work.
    // ---------------------------------------------------------------------
    reset();
    googleConfig = { refreshToken: 'rt_race', sub: 'sub_race', email: 'race@example.com' };
    const resR1 = await request('/api/auth/google');
    const cookieR = signedCookieHeader(resR1);
    const stateR = stateFromAuthUrl(resR1.headers.location || '');

    const [raceA, raceB] = await Promise.all([
      request(`/api/auth/google/callback?code=code-A&state=${stateR}`, {
        headers: { cookie: cookieR },
      }),
      request(`/api/auth/google/callback?code=code-B&state=${stateR}`, {
        headers: { cookie: cookieR },
      }),
    ]);
    const raceLocs = [raceA, raceB].map((r) => r.headers.location || '');
    const raceWinners = raceLocs.filter((l) => l.includes('connected=true')).length;
    const raceLosers = raceLocs.filter((l) => l.includes('error=oauth_state_invalid')).length;
    check(
      '9. concurrent callbacks: exactly one consume wins, one loses pre-exchange',
      raceWinners === 1 && raceLosers === 1 && googleCalls.exchange === 1,
      `winners=${raceWinners}, losers=${raceLosers}, exchanges=${googleCalls.exchange}`
    );
    check(
      '9a. exactly one token row and one bound session after the race',
      db.gmail_tokens.length === 1 &&
        db.sessions.filter((s) => s.google_sub === 'sub_race').length === 1
    );

    // Direct predicate check: a stale-state UPDATE must match 0 rows.
    const { data: staleRows } = await makeSupabaseStub()
      .from('sessions')
      .update({ oauth_state: null })
      .eq('id', db.sessions[0].id)
      .eq('oauth_state', stateR) // already consumed by the race winner
      .select('oauth_state');
    check(
      '9b. stale-state conditional UPDATE matches zero rows (no double consume)',
      Array.isArray(staleRows) && staleRows.length === 0
    );
  } catch (err) {
    results.push(`ABORT ${err.stack}`);
    failCount += 1;
  } finally {
    await stopServer();
  }

  console.log('\n===== C3 auth-routes harness =====');
  results.forEach((r) => console.log(r));
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}

run();
