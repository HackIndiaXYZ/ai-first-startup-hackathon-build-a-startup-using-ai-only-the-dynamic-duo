/**
 * CP2 + CP3 test harness — TrialGuard Phase 3B gmail scan route.
 *
 * Fully mocked and secrets-free: googleapis + @supabase/supabase-js are
 * stubbed in Node's require cache; no network, no real Gmail, no real OAuth,
 * no .env reads. Covers:
 *
 *   A1  unauthenticated POST /api/scan (no cookie) → 401
 *   A2  unbound session (cookie without google_sub) → 401
 *   A3  bound session without a token row → 409 not_connected
 *   H1  happy path (valid token): 3 lists (valid syntax, ≤25), thread dedupe
 *       (5 ids → 4), bounded full gets (marketing never fetched), detection
 *       DTOs exact, unknowns null, counts envelope, ZERO refresh calls
 *   E1  empty results → 200 with candidates: []
 *   E2  429 from list → 503 rate_limited (sanitized), no refresh
 *   E3  403 non-quota → 403 permission_denied (sanitized)
 *   E4  500 → 502 gmail_unavailable (sanitized)
 *   E5  mid-flight 401 with revoked refresh token → exactly ONE refresh
 *       attempt, then 401 reconnect_required; token row untouched
 *   R0  missing refresh token + expired access token → 401
 *       reconnect_required, ZERO Gmail calls, ZERO refresh calls
 *   R1  revoked refresh token (pre-flight) → 401 reconnect_required,
 *       exactly one refresh attempt, ZERO Gmail calls, row untouched
 *   R2  expired access token + valid RT → pre-flight refresh → 200; new AT
 *       persisted ENCRYPTED (decrypt round-trip), expiry refreshed, RT
 *       ciphertext preserved byte-for-byte, one gmail_tokens UPDATE bound
 *       to the right google_sub with only {encrypted_access_token,
 *       token_expiry}; new AT (not the stale one) used against Gmail
 *   R3  Gmail 401 mid-flight (valid RT) → exactly ONE refresh + ONE retry →
 *       200; 6 list calls total (3 + 3 retry); new AT persisted
 *   R4  401 after pre-flight refresh → NO second refresh (pagination-safe:
 *       refreshCalls == 1), 401 reconnect_required, no retry loop
 *   R7  persistence verification (approved CP3 correction): zero-row or
 *       database-error refresh UPDATE → FAIL CLOSED sanitized 502; row
 *       untouched; no scan on an unverified token
 *   R5  account isolation: a second account's gmail_tokens row is
 *       byte-identical across every scenario
 *   R6  plaintext-token audit: no AT/RT plaintext in any response or log;
 *       persisted values are ciphertext (≠ plaintext) that round-trip
 *   W1  read-only invariant: gmail surface receives NO write ops (cumulative
 *       over ALL scenarios, never reset); methods ⊆ {list, get}; get
 *       formats ⊆ {metadata, full}
 *   W2  persistence audit: ZERO ops on subscriptions/sessions; gmail_tokens
 *       ops are ONLY the exact refresh updates (bound to google_sub, few
 *       fields); six subscription seeds byte-identical
 *
 * CP3 semantics note: CP2's "expired token → immediate 401 token_expired"
 * and "mid-flight 401 → immediate 401" checks were intentionally replaced —
 * with refresh implemented, those paths now attempt one refresh first; the
 * sanitized reconnect error is still the outcome whenever refresh is
 * impossible. No other CP2 assertion was weakened.
 *
 * Usage: node backend/scripts/test-gmail-scan.js   (prints PASS/FAIL only)
 */

process.env.NODE_ENV = 'test';
process.env.PORT = '3098';
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3001/api/auth/google/callback';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.SESSION_SECRET = 'cp2-harness-session-secret';
process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
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
const SUB_SEED = [
  ['1a2b3c4d-0001', 'StreamVault', 'Premium Annual', '14.99', 'USD', 'active', 'https://example-streamvault.fictitious/account/cancel'],
  ['1a2b3c4d-0002', 'CloudMind AI', 'Pro Seat', '29.99', 'USD', 'active', 'https://example-cloudmind.fictitious/billing/cancel'],
  ['1a2b3c4d-0003', 'NoteNest', 'Team Starter', '9.99', 'USD', 'active', 'https://example-notenest.fictitious/settings/subscription'],
  ['1a2b3c4d-0005', 'DataSift Analytics', 'Business Tier', '49.99', 'USD', 'active', 'https://example-datasift.fictitious/plans/cancel'],
  ['1a2b3c4d-0006', 'SecureVault', 'Personal Shield', '4.99', 'USD', 'active', 'https://example-securevault.fictitious/subscription/end'],
  ['1a2b3c4d-0004', 'DesignSpark', 'Creator Plus', '19.99', 'USD', 'cancelled', 'https://example-designspark.fictitious/account/manage'],
];

const db = { sessions: [], gmail_tokens: [], subscriptions: [] };

function seedSubscriptions() {
  db.subscriptions = SUB_SEED.map(([id, serviceName, planName, price, currency, status, cancellationUrl]) => ({
    id, service_name: serviceName, plan_name: planName,
    trial_start_date: '2026-09-14', trial_end_date: '2026-10-14',
    price, currency, status, cancellation_url: cancellationUrl,
    created_at: new Date().toISOString(),
  }));
}
seedSubscriptions();

// Every non-SELECT database operation, recorded for the persistence audit.
// dbOps is scratch (exceptions reset per scenario); dbOpsAll is cumulative
// and backing all final audits.
const dbOps = [];
const dbOpsAll = [];

// Fault knobs for the persistence-verification tests (R7): force a database
// failure, or a zero-row update outcome, on the gmail_tokens refresh UPDATE.
const dbFault = { updateError: null, zeroRowUpdate: false };

// ---------------------------------------------------------------------------
// Per-scenario Gmail + Google stub configuration
// ---------------------------------------------------------------------------
let gmailConfig = { lists: [], snippets: {}, listError: null, getError: null, getErrorOnce: null };
const gmailCalls = { list: 0, getMeta: 0, getFull: 0, writeOps: 0, listQueries: [], getFormats: [] };
const emailLog = []; // console output capture for the leak audit

// CP3 Google stub config + counters (cumulative; never auto-reset).
const googleCfg = { refreshError: null, refreshAccessToken: 'at_refreshed', refreshExpiryDate: null };
let refreshCalls = 0;
const refreshRtsSeen = []; // plaintext refresh tokens passed into the refresh call
const atSeen = [];         // access tokens assigned to the OAuth2 client (what Gmail would use)

const HEADERS = {
  m1: { subject: 'Your Netflix free trial ends on October 28, 2026', from: 'Netflix <info@netflix.com>', date: 'Wed, 14 Oct 2026 09:30:00 +0000' },
  m2: { subject: 'Your Adobe Creative Cloud subscription renews on March 1, 2027', from: 'Adobe <account@adobe.example>', date: 'Wed, 14 Oct 2026 10:00:00 +0000' },
  m3: { subject: 'Subscription reminder for your Adobe plan', from: 'Adobe <account@adobe.example>', date: 'Wed, 14 Oct 2026 10:05:00 +0000' },
  m4: { subject: 'The Weekly Bit: our 10 favorite productivity apps (deals inside)', from: 'The Weekly Bit <digest@weeklybit.press>', date: 'Wed, 14 Oct 2026 11:00:00 +0000' },
  m5: { subject: 'Receipt for your payment to NoteNest', from: 'NoteNest Billing <billing@notenest.io>', date: 'Fri, 2 Oct 2026 08:00:00 +0000' },
};
const SNIPPETS = {
  m1: 'You will be charged $15.99 per month starting October 28, 2026 unless you cancel before then.',
  m2: 'We will charge the card on file $59.99 on your renewal date. No action is needed.',
  m3: 'This is a duplicate reminder delivered on the same Gmail thread.',
  m5: 'Payment received October 2, 2026. Amount charged: $9.99. Your next billing date will be November 2, 2026.',
};
// q1 → m1, m4 | q2 → m2, m3 | q3 → m5   (m3 shares thread t2 with m2)
const LISTS = [
  [{ id: 'm1', threadId: 't1' }, { id: 'm4', threadId: 't4' }],
  [{ id: 'm2', threadId: 't2' }, { id: 'm3', threadId: 't2' }],
  [{ id: 'm5', threadId: 't5' }],
];
const INTERNAL = { m1: '1791044600000', m2: '1791046800000', m3: '1791047100000', m4: '1791050400000', m5: '1789910400000' };

// Patch-A fixtures: ids without entries in HEADERS render as empty subjects
// (stub falls back to HEADERS[id] || {}), so they stay unclassified and cost
// exactly one metadata get each — ideal for cap/audit scenarios.
(function buildH2List() {
  const h2 = [[], [], []];
  for (let i = 1; i <= 20; i += 1) h2[0].push({ id: `n${i}`, threadId: `x${i}` });
  for (let i = 5; i <= 12; i += 1) h2[1].push({ id: `n${i}`, threadId: `x${i}` }); // id overlaps
  for (let i = 21; i <= 27; i += 1) h2[1].push({ id: `n${i}`, threadId: i === 22 ? 'x21' : `x${i}` }); // one shared thread
  global.H2_LISTS = h2;
})();

// Patch-A fixture: 15 classified trial emails (distinct ids/threads) to prove
// the FULL-GET cap (12) also flags partial:true without dropping candidates
// silently.
(function buildClassifiedBatch() {
  for (let i = 1; i <= 15; i += 1) {
    HEADERS[`bt${i}`] = { subject: `Your batch trial ends on October ${i}, 2027`, from: `Batch Workflows <billing@batchworkflows.example>`, date: 'Wed, 14 Oct 2026 12:00:00 +0000' };
    SNIPPETS[`bt${i}`] = 'Reminder: cancel before the deadline if you do not want the paid plan.';
  }
})();

function headersList(h) {
  return [
    { name: 'Subject', value: h.subject },
    { name: 'From', value: h.from },
    { name: 'Date', value: h.date },
  ];
}

class FakeOAuth2 {
  #creds = { access_token: 'at_scan' };

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
  async verifyIdToken(opts) {
    if (typeof opts?.idToken !== 'string' || !opts.idToken) {
      throw new Error('The verifyIdToken method requires an ID Token');
    }
    if (opts.audience === undefined) throw new Error('harness: exchange must bind an explicit audience');
    return { payload: { sub: 'sub_scan', email: 'scanuser@example.com' } };
  }
  async getToken() {
    return { tokens: { access_token: 'at_scan', expiry_date: Date.now() + 3600_000, scope: 'https://www.googleapis.com/auth/gmail.readonly', id_token: 'fake-id-token' } };
  }
  set credentials(v) {
    if (v && typeof v === 'object' && 'access_token' in v) atSeen.push(v.access_token);
    this.#creds = { ...this.#creds, ...v };
  }
  get credentials() { return this.#creds; }
  async refreshAccessToken() {
    refreshCalls += 1;
    refreshRtsSeen.push(this.#creds.refresh_token);
    if (googleCfg.refreshError) throw googleCfg.refreshError;
    return {
      credentials: {
        access_token: googleCfg.refreshAccessToken,
        expiry_date: googleCfg.refreshExpiryDate ?? Date.now() + 3600_000,
      },
    };
  }
}

function makeGoogleStub() {
  const fakeGmail = {
    users: {
      messages: {
        async list({ q, maxResults }) {
          gmailCalls.list += 1;
          gmailCalls.listQueries.push({ q, maxResults });
          if (gmailConfig.listError) throw gmailConfig.listError;
          // Index modulo the configured cycle so a mid-flight 401 RETRY of the
          // whole scan re-reads the same per-attempt list fixtures.
          const cycle = gmailConfig.lists.length || 1;
          const messages = gmailConfig.lists[(gmailCalls.list - 1) % cycle] || [];
          return { data: { messages, resultSizeEstimate: messages.length } };
        },
        async get({ id, format, metadataHeaders }) {
          gmailCalls.getFormats.push(format);
          if (format === 'metadata') gmailCalls.getMeta += 1; else gmailCalls.getFull += 1;
          if (gmailConfig.getErrorOnce) {
            const e = gmailConfig.getErrorOnce;
            gmailConfig.getErrorOnce = null; // one-shot 401 → triggers exactly one refresh+retry
            throw e;
          }
          if (gmailConfig.getError) throw gmailConfig.getError;
          if (id === 'mX_never') throw new Error('harness: nobody should fetch this');
          if (format === 'metadata') {
            return { data: { id, threadId: id === 'm2' ? 't2' : id === 'm4' ? 't4' : id === 'm5' ? 't5' : id === 'm1' ? 't1' : 'tx', snippet: '(metadata has no snippet)', internalDate: INTERNAL[id], payload: { headers: headersList(HEADERS[id] || {}) } } };
          }
          // format 'full' — the ONLY other allowed format.
          if (gmailCalls.getFull > 50) throw new Error('harness: full-get budget blown');
          return { data: { id, threadId: 't', snippet: SNIPPETS[id] || '', internalDate: INTERNAL[id], payload: { parts: [], body: { data: 'NEVER-STORED-BODY' } } } };
        },
        // WRITE-OPERATION TRAPS: the scanner must never route here.
        async send() { gmailCalls.writeOps += 1; return { data: {} }; },
        async trash() { gmailCalls.writeOps += 1; return { data: {} }; },
        async delete() { gmailCalls.writeOps += 1; return { data: {} }; },
        async modify() { gmailCalls.writeOps += 1; return { data: {} }; },
        async batchModify() { gmailCalls.writeOps += 1; return { data: {} }; },
      },
      labels: { list: async () => { gmailCalls.writeOps += 1; return { data: {} }; } },
      settings: { getAutoForwarding: async () => { gmailCalls.writeOps += 1; return { data: {} }; } },
    },
  };
  return { google: { auth: { OAuth2: FakeOAuth2 }, gmail: () => fakeGmail } };
}

// ---------------------------------------------------------------------------
// Fake Supabase client
// ---------------------------------------------------------------------------
const TABLES = ['sessions', 'gmail_tokens', 'subscriptions'];

function makeSupabaseStub() {
  function from(tableName) {
    if (!TABLES.includes(tableName)) throw new Error(`Harness: unexpected table ${tableName}`);
    const filters = [];
    let op = 'select';
    let payload = null;
    let selectCols = null;
    function rows() { return db[tableName]; }
    function matches(row) { return filters.every(([c, v]) => row[c] === v); }
    function matchingRows() { return rows().filter(matches); }
    function pickCols(row) {
      if (!selectCols || selectCols === '*') return { ...row };
      return Object.fromEntries(selectCols.split(',').map((c) => [c.trim(), row[c.trim()]]));
    }
    const result = {
      select(cols) { selectCols = cols; return result; },
      eq(col, val) { filters.push([col, val]); return result; },
      maybeSingle() { return Promise.resolve({ data: matchingRows()[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: matchingRows()[0] ?? null, error: null }); },
      update(upd) { payload = upd; op = 'update'; return result; },
      insert(obj) { payload = obj; op = 'insert'; return result; },
      delete() { op = 'delete'; return result; },
      upsert(obj) { payload = obj; op = 'upsert'; return result; },
      order() { return result; },
      then(resolve, reject) {
        try {
          // Audit EVERY mutation (any table) — persistence checks rely on this.
          if (op !== 'select') {
            const entry = { table: tableName, op, filter: JSON.parse(JSON.stringify(filters.slice())), payload: JSON.parse(JSON.stringify(payload ?? null)), select: JSON.parse(JSON.stringify(selectCols)) };
            dbOps.push(entry);
            dbOpsAll.push(entry);
          }
          if (op === 'insert' || op === 'upsert') {
            const rowsIn = Array.isArray(payload) ? payload : [payload];
            for (const row of rowsIn) {
              if (op === 'upsert' && tableName === 'gmail_tokens') {
                const existing = rows().find((r) => r.google_sub === row.google_sub);
                if (existing) Object.assign(existing, row); else rows().push({ ...row });
              } else rows().push({ ...row });
            }
            return resolve({ data: rowsIn.map((r) => ({ ...r })), error: null });
          }
          if (op === 'update') {
            let matching = matchingRows();
            // R7 faults (persistence verification): a zeroRowUpdate simulates
            // a concurrent delete of the row (PostgREST reports no error for
            // zero affected rows); updateError simulates a real DB failure.
            if (dbFault.updateError) {
              dbFault.updateError = null; // one-shot; NO rows are mutated
              return resolve({ data: null, error: new Error('simulated database failure') });
            }
            if (dbFault.zeroRowUpdate) matching = [];
            for (const row of matching) Object.assign(row, payload);
            const data = selectCols ? matching.map(pickCols) : matching.map((r) => ({ ...r }));
            return resolve({ data, error: null });
          }
          if (op === 'delete') {
            db[tableName] = rows().filter((r) => !matches(r));
            return resolve({ data: null, error: null });
          }
          return resolve({ data: matchingRows().map(pickCols), error: null });
        } catch (e) { reject(e); }
      },
    };
    return result;
  }
  return { from };
}

// ---------------------------------------------------------------------------
// require-cache interposition + module deps
// ---------------------------------------------------------------------------
const origLoad = Module._load;
Module._load = function stubbedLoad(request, parent, isMain) {
  if (request === '@supabase/supabase-js') return { createClient: () => makeSupabaseStub() };
  if (request === 'googleapis') return makeGoogleStub();
  return origLoad.call(this, request, parent, isMain);
};

const tokenEncryption = require(path.join(backendRoot, 'src/services/tokenEncryption'));
const authRouter = require(path.join(backendRoot, 'src/routes/auth'));
const scanRouter = require(path.join(backendRoot, 'src/routes/scan'));
const { COOKIE_NAME } = require(path.join(backendRoot, 'src/middleware/session'));
const errorHandler = require(path.join(backendRoot, 'src/middleware/errorHandler'));

const express = require(path.join(backendRoot, 'node_modules/express'));
const cookieParser = require(path.join(backendRoot, 'node_modules/cookie-parser'));

function makeApp() {
  const app = express();
  app.use(cookieParser(process.env.SESSION_SECRET));
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/scan', scanRouter);
  // Parity with backend/index.js: the global error handler turns next({status,...})
  // into JSON (without it Express's default HTML error page would be returned).
  app.use(errorHandler);
  return app;
}

let server;
function startServer(app) {
  return new Promise((resolve) => { server = app.listen(3098, '127.0.0.1', resolve); });
}
function stopServer() { return new Promise((resolve) => server.close(resolve)); }

function request(urlPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 3098, path: urlPath, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function signedCookieHeader(res) {
  const raw = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return raw ? raw.split(';')[0] : null;
}

// Console capture (leak audit) — records and forwards.
['log', 'warn', 'error'].forEach((k) => {
  const orig = console[k].bind(console);
  console[k] = (...args) => { emailLog.push(args.map(String).join(' ')); orig(...args); };
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
const results = [];
let passCount = 0;
let failCount = 0;
function check(name, condition, extra) {
  if (condition) { passCount += 1; results.push(`PASS  ${name}`); }
  else { failCount += 1; results.push(`FAIL  ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`); }
}

async function makeBoundSession(email) {
  // Real flow start → signed cookie; then bind the session server-side
  // (as an OAuth callback would). No real Google flow — the googleapis stub
  // never leaves this process.
  const res0 = await request('/api/auth/google');
  const cookie = signedCookieHeader(res0);
  const sub = `sub_${email.split('@')[0]}`;
  const sess = db.sessions[db.sessions.length - 1];
  sess.google_sub = sub;
  return { cookie, sub, sess };
}

/** Reconfigures the main account's token row (encrypts at/rt when given). */
function setTokenRow(fields) {
  const row = db.gmail_tokens[0];
  if ('at' in fields) row.encrypted_access_token = fields.at ? tokenEncryption.encrypt(fields.at) : null;
  if ('expiryMs' in fields) row.token_expiry = fields.expiryMs === null ? null : new Date(fields.expiryMs).toISOString();
  if ('rt' in fields) row.encrypted_refresh_token = fields.rt ? tokenEncryption.encrypt(fields.rt) : null;
}

function resetGmailCounters() {
  gmailCalls.list = 0; gmailCalls.getMeta = 0; gmailCalls.getFull = 0;
  gmailCalls.listQueries = []; gmailCalls.getFormats = [];
  // NOTE: writeOps is NEVER reset — it is a cumulative invariant.
}

async function run() {
  await startServer(makeApp());
  let snapshot = null;
  try {
    resetGmailCounters();
    const SUBS_SNAPSHOT = JSON.stringify(db.subscriptions);

    // ---------------------------------------------------------------
    // Auth scenarios (A1–A3)
    // ---------------------------------------------------------------
    const resA1 = await request('/api/scan', { method: 'POST' });
    check('A1. no cookie → 401 unauthenticated', resA1.status === 401, resA1.status);

    const res0 = await request('/api/auth/google');
    const unboundCookie = signedCookieHeader(res0);
    const resA2 = await request('/api/scan', { method: 'POST', headers: { cookie: unboundCookie } });
    check('A2. cookie without bound account → 401 unauthenticated', resA2.status === 401, resA2.status);

    const { cookie: boundCookie, sub, sess } = await makeBoundSession('scanuser@example.com');
    const resA3 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    check('A3. bound session without token row → 409 not_connected', resA3.status === 409 && JSON.parse(resA3.body).error === 'not_connected', { s: resA3.status, b: resA3.body.slice(0, 60) });

    // Seed the main account's token row + a SECOND account's row (isolation).
    db.gmail_tokens.push({
      google_sub: sub, email: 'scanuser@example.com',
      encrypted_access_token: tokenEncryption.encrypt('at_valid'),
      encrypted_refresh_token: tokenEncryption.encrypt('rt_valid'),
      token_expiry: new Date(Date.now() + 3600_000).toISOString(),
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    db.gmail_tokens.push({
      google_sub: 'sub_other', email: 'other@example.com',
      encrypted_access_token: tokenEncryption.encrypt('at_other'),
      encrypted_refresh_token: tokenEncryption.encrypt('rt_other'),
      token_expiry: new Date(Date.now() + 3600_000).toISOString(),
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    const OTHER_SNAPSHOT = JSON.stringify(db.gmail_tokens[1]);
    setTokenRow({ at: 'at_valid', rt: 'rt_valid', expiryMs: Date.now() + 3600_000 });

    // ---------------------------------------------------------------
    // H1. Happy path (valid token, NO refresh)
    // ---------------------------------------------------------------
    snapshot = {
      tokens: JSON.parse(JSON.stringify(db.gmail_tokens)),
      sess: JSON.parse(JSON.stringify(sess)),
    };
    resetGmailCounters();
    gmailConfig = { lists: LISTS, snippets: SNIPPETS, listError: null, getError: null, getErrorOnce: null };
    dbOps.length = 0;

    const resH = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    const bodyH = resH.status === 200 ? JSON.parse(resH.body) : null;
    check('H1. scan returns 200 preview', resH.status === 200, { s: resH.status, b: resH.body.slice(0, 80) });
    check('H1a. exactly 3 list calls with caps and amendment-#1 syntax',
      gmailCalls.list === 3 &&
        gmailCalls.listQueries.every((x) => Number(x.maxResults) <= 25) &&
        gmailCalls.listQueries.every((x) => /newer_than:90d/.test(x.q)) &&
        gmailCalls.listQueries.every((x) => /-in:spam/i.test(x.q) && /-in:trash/i.test(x.q)),
      JSON.stringify(gmailCalls.listQueries));
    check('H1b. thread dedupe: 5 listed ids → 4 metadata gets', gmailCalls.getMeta === 4, { meta: gmailCalls.getMeta });
    check('H1c. full gets bounded to classified candidates only (3: m1,m2,m5)',
      gmailCalls.getFull === 3 && gmailCalls.getFormats.filter((f) => f === 'full').length === 3,
      { full: gmailCalls.getFull, formats: gmailCalls.getFormats });
    check('H1d. marketing message (m4) never classified nor fetched fully',
      bodyH && !bodyH.candidates.some((c) => c.sourceMessageId === 'm4') && gmailCalls.getFull === 3,
      bodyH ? bodyH.candidates.map((c) => c.sourceMessageId) : null);
    check('H1e. counts envelope (listed / unique ids / unique threads / selected / inspected / candidates)',
      bodyH && bodyH.windowDays === 90 &&
        bodyH.messagesListed === 5 && bodyH.messagesDeduped === 5 &&
        bodyH.messagesThreads === 4 && bodyH.messagesSelected === 4 &&
        bodyH.messagesInspected === 7 && bodyH.candidates.length === 3,
      bodyH ? { l: bodyH.messagesListed, u: bodyH.messagesDeduped, t: bodyH.messagesThreads, s: bodyH.messagesSelected, i: bodyH.messagesInspected, c: bodyH.candidates.length } : null);
    check('H1f0. happy-path scan is NOT flagged partial (no cap was hit: threads 4 ≤ 25, ranked 3 ≤ 12)', bodyH && bodyH.partial !== true, bodyH ? bodyH.partial : null);
    const c1 = bodyH?.candidates?.[0], c2 = bodyH?.candidates?.[1], c3 = bodyH?.candidates?.[2];
    check('H1f. candidate m1: trial/Netflix full DTO (payment fields never populated outside payment_reminder)',
      JSON.stringify(c1) === JSON.stringify({ sourceMessageId: 'm1', classification: 'trial', serviceName: 'Netflix', trialEndDate: '2026-10-28', renewalDate: null, invoiceDate: null, cancellationDeadline: null, paymentDeadline: null, paymentIssueType: null, price: 15.99, currency: 'USD', confidence: 'high' }), c1);
    check('H1g. candidate m2: renewal/Adobe (same-thread m3 deduped away)',
      JSON.stringify(c2) === JSON.stringify({ sourceMessageId: 'm2', classification: 'renewal', serviceName: 'Adobe', trialEndDate: null, renewalDate: '2027-03-01', invoiceDate: null, cancellationDeadline: null, paymentDeadline: null, paymentIssueType: null, price: 59.99, currency: 'USD', confidence: 'high' }), c2);
    check('H1h. candidate m5: receipt/NoteNest — invoice date and renewal date both present and SEPARATE',
      JSON.stringify(c3) === JSON.stringify({ sourceMessageId: 'm5', classification: 'receipt', serviceName: 'NoteNest', trialEndDate: null, renewalDate: '2026-11-02', invoiceDate: '2026-10-02', cancellationDeadline: null, paymentDeadline: null, paymentIssueType: null, price: 9.99, currency: 'USD', confidence: 'high' }), c3);
    check('H1r. valid token → ZERO refresh calls; stored row byte-identical (still the pre-CP3 AT)',
      refreshCalls === 0 && JSON.stringify(db.gmail_tokens) === JSON.stringify(snapshot.tokens) && atSeen.includes('at_valid'), { refreshCalls, at: atSeen.slice(-2) });

    // ---------------------------------------------------------------
    // H2 (patch A): overlap dedupe, thread dedupe, exact stage counts, and
    //     metadata-cap truncation flagged partial:true.
    //   L1: 20 messages n1..n20 (threads x1..x20)
    //   L2: n5..n12 AGAIN (8 id overlaps) + n21..n27 with n21/n22 sharing a thread
    //   Listed = 35; unique ids = 27; unique threads = 26; cap → selected 25;
    //   no subject keywords → 0 full gets, 0 candidates; partial TRUE.
    // ---------------------------------------------------------------
    resetGmailCounters();
    gmailConfig = { lists: H2_LISTS, snippets: {}, listError: null, getError: null, getErrorOnce: null };
    const resH2 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    const bodyH2 = resH2.status === 200 ? JSON.parse(resH2.body) : null;
    check('H2. overlap+thread scenario → 200 with counts envelope', resH2.status === 200, { s: resH2.status });
    check('H2a. listed counts raw ids (35 = 20 + 8 overlaps + 7 new) — overlap NOT converted into a fixed duplicate ratio',
      bodyH2 && bodyH2.messagesListed === 35, bodyH2 ? bodyH2.messagesListed : null);
    check('H2b. unique-ids stage = 27 (35 listed − 8 id overlaps)',
      bodyH2 && bodyH2.messagesDeduped === 27, bodyH2 ? bodyH2.messagesDeduped : null);
    check('H2c. unique-threads stage = 26 (n21/n22 share one thread; not 27-25=2 assumed dups)',
      bodyH2 && bodyH2.messagesThreads === 26, bodyH2 ? bodyH2.messagesThreads : null);
    check('H2d. metadata-cap truncation: selected 25 < threads 26, partial TRUE',
      bodyH2 && bodyH2.messagesSelected === 25 && bodyH2.partial === true,
      bodyH2 ? { s: bodyH2.messagesSelected, p: bodyH2.partial } : null);
    check('H2e. inspected = 25 metadata gets only; zero full gets; zero candidates',
      bodyH2 && bodyH2.messagesInspected === 25 && bodyH2.candidates.length === 0 && gmailCalls.getFull === 0,
      { i: bodyH2?.messagesInspected, f: gmailCalls.getFull });

    // ---------------------------------------------------------------
    // H3 (patch A): FULL-GET cap truncation → partial:true (bounded ≤12).
    //   Single query returning 15 classified trial emails → ranked 15 > 12.
    // ---------------------------------------------------------------
    resetGmailCounters();
    gmailConfig = { lists: [[...Array(15).keys()].map((i) => ({ id: `bt${i + 1}`, threadId: `bt${i + 1}` }))], snippets: {}, listError: null, getError: null, getErrorOnce: null };
    const resH3 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    const bodyH3 = resH3.status === 200 ? JSON.parse(resH3.body) : null;
    check('H3. 15 classified messages → 12 full gets + partial TRUE (full-get cap)',
      resH3.status === 200 && bodyH3 && bodyH3.messagesSelected === 15 &&
        bodyH3.candidates.length === 12 && bodyH3.messagesInspected === 27 &&
        bodyH3.partial === true && gmailCalls.getFull === 12,
      { s: bodyH3?.messagesSelected, c: bodyH3?.candidates.length, i: bodyH3?.messagesInspected, p: bodyH3?.partial, f: gmailCalls.getFull });

    // ---------------------------------------------------------------
    // P-series (approved payment-reminder patch): pipeline, budgeted
    // inconclusive-inspection reserve, deadline-first ranking, and caps.
    // ---------------------------------------------------------------

    // P1: the representative payment/access deadline email. The NEW subject
    // bank ('access ends') classifies it at the METADATA stage → one full get
    // for dates; every other date category stays null-for-unknown.
    HEADERS.pm1 = { subject: 'Final reminder: Your Plus access ends soon', from: 'OpenAI <noreply@openai.com>', date: 'Wed, 14 Oct 2026 09:00:00 +0000' };
    SNIPPETS.pm1 = "You'll lose access to Plus on Oct 22, 2026. Please update your payment method by Oct 22, 2026 to keep access to Plus benefits.";
    resetGmailCounters();
    gmailConfig = { lists: [[], [{ id: 'pm1', threadId: 'tpm1' }], []], snippets: SNIPPETS, listError: null, getError: null, getErrorOnce: null };
    const resP1 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    const bodyP1 = resP1.status === 200 ? JSON.parse(resP1.body) : null;
    check('P1. payment/access deadline email → 200 with payment_reminder candidate',
      resP1.status === 200 && bodyP1 && bodyP1.candidates.length === 1, { s: resP1.status, c: bodyP1?.candidates?.length });
    check('P1a. exact DTO: OpenAI / payment_reminder / action deadline 2026-10-22; renewal stays null (never inferred)',
      JSON.stringify(bodyP1?.candidates?.[0]) === JSON.stringify({ sourceMessageId: 'pm1', classification: 'payment_reminder', serviceName: 'OpenAI', trialEndDate: null, renewalDate: null, invoiceDate: null, cancellationDeadline: null, paymentDeadline: '2026-10-22', paymentIssueType: 'payment_action_required', price: null, currency: null, confidence: 'high' }),
      bodyP1?.candidates?.[0]);
    check('P1b. counts: 1 listed / 1 thread / 1 selected / inspected 2 (1 metadata + 1 full) / not partial',
      bodyP1 && bodyP1.messagesListed === 1 && bodyP1.messagesDeduped === 1 && bodyP1.messagesThreads === 1 &&
        bodyP1.messagesSelected === 1 && bodyP1.messagesInspected === 2 && bodyP1.partial !== true && gmailCalls.getFull === 1,
      { l: bodyP1?.messagesListed, i: bodyP1?.messagesInspected, p: bodyP1?.partial, f: gmailCalls.getFull });

    // P2: bounded reserve — metadata subjects that did NOT classify but are
    // payment/access-relevant get ≤4 extra snippet reads. A probed message
    // that still does not classify decisively is DROPPED, never emitted.
    HEADERS.pr1 = { subject: 'A final reminder about your openai account', from: 'OpenAI <noreply@openai.com>', date: 'Wed, 14 Oct 2026 11:30:00 +0000' };
    SNIPPETS.pr1 = 'Please update your payment method by February 3, 2027 to keep your subscription active.';
    HEADERS.pr2 = { subject: 'Final reminder: 20% off ends tonight', from: 'MegaSale <deals@megasale.test>', date: 'Wed, 14 Oct 2026 12:30:00 +0000' };
    SNIPPETS.pr2 = 'Shop the sale before midnight and save on everything in the store.';
    resetGmailCounters();
    gmailConfig = { lists: [[{ id: 'pr1', threadId: 'tpr1' }], [{ id: 'pr2', threadId: 'tpr2' }], []], snippets: SNIPPETS, listError: null, getError: null, getErrorOnce: null };
    const resP2 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    const bodyP2 = resP2.status === 200 ? JSON.parse(resP2.body) : null;
    check('P2. reserve probe rescues a loosely-subjectied payment reminder',
      resP2.status === 200 && bodyP2 && bodyP2.candidates.length === 1 && bodyP2.candidates[0].sourceMessageId === 'pr1',
      { s: resP2.status, c: bodyP2?.candidates?.map((c) => c.sourceMessageId) });
    check('P2a. rescued candidate: payment_reminder / action required / deadline 2027-02-03 (never a renewal); confidence stays medium because the subject carries no classification keyword (high needs subject evidence)',
      JSON.stringify(bodyP2?.candidates?.[0]) === JSON.stringify({ sourceMessageId: 'pr1', classification: 'payment_reminder', serviceName: 'OpenAI', trialEndDate: null, renewalDate: null, invoiceDate: null, cancellationDeadline: null, paymentDeadline: '2027-02-03', paymentIssueType: 'payment_action_required', price: null, currency: null, confidence: 'medium' }),
      bodyP2?.candidates?.[0]);
    check('P2b. marketing final-reminder was probed (2 reserve full gets) but NOT emitted; no partial flag (cap 4 not hit)',
      bodyP2 && bodyP2.messagesInspected === 4 && bodyP2.candidates.length === 1 && bodyP2.partial !== true && gmailCalls.getFull === 2,
      { i: bodyP2?.messagesInspected, p: bodyP2?.partial, f: gmailCalls.getFull });

    // P3 (correction #4 ranking): 15 classified (6 deadline-bearing trials,
    // 1 payment reminder, 8 trials without subject dates) > FULL_GET_CAP 12 →
    // deadline evidence sorts FIRST, then class order; payment_reminder beats
    // undated trials; the two undated trials with the lowest keys are cut.
    const pAll = [...Array(15).keys()].map((i) => ({ id: `p${String(i + 1).padStart(2, '0')}`, threadId: `tp${String(i + 1).padStart(2, '0')}` }));
    for (let i = 1; i <= 15; i += 1) {
      const id = `p${String(i).padStart(2, '0')}`;
      if (i <= 6) HEADERS[id] = { subject: `Your trial ends on October ${i}, 2027`, from: `Batch Workflows ${i} <billing@batchworkflows.example>`, date: 'Wed, 14 Oct 2026 13:00:00 +0000' };
      else if (i === 7) HEADERS[id] = { subject: 'Your Netflix payment failed', from: 'Netflix <info@netflix.com>', date: 'Wed, 14 Oct 2026 13:05:00 +0000' };
      else HEADERS[id] = { subject: 'Your free trial — see every plan feature', from: `Vortex Suite ${i} <team@vortexsuite.example>`, date: 'Wed, 14 Oct 2026 13:10:00 +0000' };
    }
    resetGmailCounters();
    gmailConfig = { lists: [pAll] /* cycle returns the same list every query; dedupe collapses */ , snippets: SNIPPETS, listError: null, getError: null, getErrorOnce: null };
    const resP3 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    const bodyP3 = resP3.status === 200 ? JSON.parse(resP3.body) : null;
    const p3Ids = bodyP3 ? bodyP3.candidates.map((c) => c.sourceMessageId) : [];
    check('P3. 15 classified > cap → 12 full gets, partial TRUE',
      resP3.status === 200 && bodyP3 && bodyP3.candidates.length === 12 && bodyP3.partial === true && gmailCalls.getFull === 12,
      { s: bodyP3?.partial, c: bodyP3?.candidates.length, f: gmailCalls.getFull });
    check('P3a. deadline-bearing subjects first (p01..p06), then the payment reminder (p07)',
      ['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07'].every((id, idx) => p3Ids[idx] === id), p3Ids);
    check('P3b. undated trials fill the remaining 5 slots in metadata order (p08..p12); p14/p15 cut silently but flagged partial',
      p3Ids.slice(7).join(',') === 'p08,p09,p10,p11,p12' && !p3Ids.includes('p14') && !p3Ids.includes('p15'), p3Ids);
    check('P3c. rescued payment candidate: payment_failed evidence without a deadline stays deadline-null',
      (() => { const p07 = bodyP3?.candidates?.find((c) => c.sourceMessageId === 'p07'); return p07 && p07.classification === 'payment_reminder' && p07.paymentIssueType === 'payment_failed' && p07.paymentDeadline === null && p07.renewalDate === null && p07.price === null; })(),
      bodyP3?.candidates?.find((c) => c.sourceMessageId === 'p07'));

    // P4 (corrections #2/#3 budget): 12 classified + 6 reserve-eligible.
    // Classified candidates budget is served FIRST (12), then exactly 4 of 6
    // reserve probes → total full gets EXACTLY 16, both caps truncated.
    const qAll = [...Array(18).keys()].map((i) => ({ id: `q${String(i + 1).padStart(2, '0')}`, threadId: `tq${String(i + 1).padStart(2, '0')}` }));
    for (let i = 1; i <= 18; i += 1) {
      const id = `q${String(i).padStart(2, '0')}`;
      if (i <= 12) HEADERS[id] = { subject: `Your trial ends on November ${i}, 2027`, from: `Batch Workflows <billing@batchworkflows.example>`, date: 'Wed, 14 Oct 2026 14:00:00 +0000' };
      else HEADERS[id] = { subject: `A final reminder about your banner${i} account`, from: `Banner Note ${i} <hello@banner.example>`, date: 'Wed, 14 Oct 2026 14:05:00 +0000' };
    }
    for (let i = 13; i <= 16; i += 1) {
      SNIPPETS[`q${String(i).padStart(2, '0')}`] = `Please update your payment method by February ${i}, 2027 to keep your subscription active.`;
    }
    // q17/q18 get NO snippet (undefined) → probed, still unknown → dropped.
    resetGmailCounters();
    gmailConfig = { lists: [qAll] /* cycle returns the same list every query; dedupe collapses */ , snippets: SNIPPETS, listError: null, getError: null, getErrorOnce: null };
    const resP4 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    const bodyP4 = resP4.status === 200 ? JSON.parse(resP4.body) : null;
    check('P4. total full-get budget enforced EXACTLY at 16 (12 classified + 4 reserve) with both caps flagged partial',
      resP4.status === 200 && bodyP4 && bodyP4.candidates.length === 16 && gmailCalls.getFull === 16 && bodyP4.partial === true,
      { s: bodyP4?.partial, c: bodyP4?.candidates.length, f: gmailCalls.getFull });
    check('P4a. all four probed snippets became payment candidates with deadlines; the two snippet-less probes were dropped',
      bodyP4 && bodyP4.candidates.filter((c) => c.classification === 'payment_reminder').length === 4 &&
        bodyP4.candidates.filter((c) => c.classification === 'payment_reminder').every((c) => c.paymentDeadline !== null && c.paymentIssueType === 'payment_action_required'),
      bodyP4?.candidates?.filter((c) => c.classification === 'payment_reminder'));
    check('P4b. count accounting: 18 metadata gets + 16 full gets = 34 inspected',
      bodyP4 && bodyP4.messagesSelected === 18 && bodyP4.messagesInspected === 34,
      { s: bodyP4?.messagesSelected, i: bodyP4?.messagesInspected });

    // P5: a rate-limited FIRST get aborts gracefully → 200 + partial (never 500).
    resetGmailCounters();
    gmailConfig = { lists: [[{ id: 'r1', threadId: 'tr1' }]], snippets: SNIPPETS, listError: null, getError: null, getErrorOnce: { code: 429, message: 'Too many requests' } };
    HEADERS.r1 = { subject: 'Your free trial — see every plan feature', from: 'Vortex Suite <team@vortexsuite.example>', date: 'Wed, 14 Oct 2026 15:00:00 +0000' };
    const resP5 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    const bodyP5 = resP5.status === 200 ? JSON.parse(resP5.body) : null;
    check('P5. rate-limited metadata get → 200 partial with zero candidates (loop refactor keeps graceful stop)',
      resP5.status === 200 && bodyP5 && bodyP5.partial === true && bodyP5.candidates.length === 0, { s: resP5.status, p: bodyP5?.partial });

    // ---------------------------------------------------------------
    // E-series: traditional Gmail errors (sanitized, no refresh)
    // ---------------------------------------------------------------
    gmailCalls.list = 0; gmailCalls.getMeta = 0; gmailCalls.getFull = 0; gmailCalls.getFormats = []; gmailCalls.listQueries = [];
    gmailConfig = { lists: [[], [], []], snippets: {}, listError: null, getError: null, getErrorOnce: null };
    const resE1 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    check('E1. empty mailbox window → 200 with empty candidates', resE1.status === 200 && JSON.parse(resE1.body).candidates.length === 0, { s: resE1.status, b: resE1.body.slice(0, 60) });

    gmailConfig = { lists: [[], [], []], snippets: {}, listError: { code: 429, message: 'Too many requests' }, getError: null, getErrorOnce: null };
    const resE2 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    check('E2. 429 → 503 rate_limited (sanitized), no refresh attempted', resE2.status === 503 && JSON.parse(resE2.body).error === 'rate_limited' && refreshCalls === 0, { s: resE2.status, b: resE2.body.slice(0, 60), refreshCalls });

    gmailConfig = { lists: [[], [], []], snippets: {}, listError: { code: 403, message: 'Insufficient Permission' }, getError: null, getErrorOnce: null };
    const resE3 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    check('E3. 403 non-quota → 403 permission_denied (sanitized)', resE3.status === 403 && JSON.parse(resE3.body).error === 'permission_denied', { s: resE3.status, b: resE3.body.slice(0, 70) });

    gmailConfig = { lists: [[], [], []], snippets: {}, listError: { code: 500, message: 'Backend Error' }, getError: null, getErrorOnce: null };
    const resE4 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    check('E4. 500 → 502 gmail_unavailable (sanitized)', resE4.status === 502 && JSON.parse(resE4.body).error === 'gmail_unavailable', { s: resE4.status, b: resE4.body.slice(0, 70) });

    // E5: mid-flight 401 whose refresh token Google rejects.
    gmailCalls.list = 0; gmailCalls.getMeta = 0; gmailCalls.getFull = 0; gmailCalls.getFormats = []; gmailCalls.listQueries = [];
    gmailConfig = { lists: LISTS, snippets: SNIPPETS, listError: null, getError: null, getErrorOnce: { code: 401, message: 'Invalid Credentials' } };
    googleCfg.refreshError = { code: 400, message: 'invalid_grant' };
    const beforeE5 = JSON.stringify(db.gmail_tokens[0]);
    const resE5 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    check('E5. mid-flight 401 + revoked RT → exactly ONE refresh attempt then 401 reconnect_required, row untouched',
      resE5.status === 401 && JSON.parse(resE5.body).error === 'reconnect_required' &&
        refreshCalls === 1 && JSON.stringify(db.gmail_tokens[0]) === beforeE5 && gmailCalls.list === 3,
      { s: resE5.status, b: resE5.body.slice(0, 70), refreshCalls, lists: gmailCalls.list });

    // ---------------------------------------------------------------
    // R0. Missing refresh token + expired access token
    // ---------------------------------------------------------------
    googleCfg.refreshError = null;
    resetGmailCounters();
    gmailConfig = { lists: LISTS, snippets: SNIPPETS, listError: null, getError: null, getErrorOnce: null };
    setTokenRow({ at: 'at_stale', rt: null, expiryMs: Date.now() - 60_000 });
    const startRefresh = refreshCalls;
    const resR0 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    check('R0. expired AT + NO refresh token → 401 reconnect_required, ZERO refresh + Gmail calls',
      resR0.status === 401 && JSON.parse(resR0.body).error === 'reconnect_required' &&
        refreshCalls === startRefresh && gmailCalls.list === 0 && gmailCalls.getMeta + gmailCalls.getFull === 0,
      { s: resR0.status, b: resR0.body.slice(0, 70), refreshCalls, lists: gmailCalls.list });

    // ---------------------------------------------------------------
    // R1. Revoked refresh token (pre-flight)
    // ---------------------------------------------------------------
    setTokenRow({ at: 'at_stale', rt: 'rt_valid', expiryMs: Date.now() - 60_000 });
    googleCfg.refreshError = { code: 400, message: 'invalid_grant' };
    dbOps.length = 0;
    const beforeR1 = JSON.stringify(db.gmail_tokens[0]);
    const resR1 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    check('R1. revoked RT → 401 reconnect_required, exactly one refresh attempt, ZERO Gmail calls, nothing persisted',
      resR1.status === 401 && JSON.parse(resR1.body).error === 'reconnect_required' &&
        refreshCalls === startRefresh + 1 && gmailCalls.list + gmailCalls.getMeta + gmailCalls.getFull === 0 &&
        dbOps.length === 0 && JSON.stringify(db.gmail_tokens[0]) === beforeR1,
      { s: resR1.status, b: resR1.body.slice(0, 70), refreshCalls, ops: dbOps.length });

    // ---------------------------------------------------------------
    // R2. Successful pre-flight refresh + encrypted persistence (+ RT preservation)
    // ---------------------------------------------------------------
    googleCfg.refreshError = null;
    googleCfg.refreshAccessToken = 'at_refreshed';
    googleCfg.refreshExpiryDate = Date.now() + 3600_000;
    resetGmailCounters();
    dbOps.length = 0;
    const opsBeforeR2 = dbOps.length;
    setTokenRow({ at: 'at_stale', expiryMs: Date.now() - 60_000 }); // rt ciphertext left untouched
    const rtBeforeR2 = db.gmail_tokens[0].encrypted_refresh_token;
    const resR2 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    const bodyR2 = resR2.status === 200 ? JSON.parse(resR2.body) : null;
    const rowR2 = db.gmail_tokens[0];
    const refreshOps = dbOps.slice(opsBeforeR2).filter((o) => o.table === 'gmail_tokens');
    let ciphertextOk = false;
    try { ciphertextOk = typeof rowR2.encrypted_access_token === 'string' && rowR2.encrypted_access_token !== 'at_refreshed' && tokenEncryption.decrypt(rowR2.encrypted_access_token) === 'at_refreshed'; } catch { ciphertextOk = false; }
    check('R2. expired AT + valid RT → refresh once → 200 full preview',
      resR2.status === 200 && bodyR2 && bodyR2.candidates.length === 3 && refreshCalls === startRefresh + 2,
      { s: resR2.status, body2: bodyR2 ? bodyR2.candidates.length : null, refreshCalls });
    check('R2a. new AT persisted encrypted: ciphertext ≠ plaintext, decrypts to at_refreshed', ciphertextOk, rowR2.encrypted_access_token?.slice(0, 12));
    check('R2b. token_expiry refreshed to the Google-issued expiry (≥ +50 min margin satisfied)',
      typeof rowR2.token_expiry === 'string' && Date.parse(rowR2.token_expiry) >= Date.now() + 50 * 60_000, rowR2.token_expiry);
    check('R2c. refresh token ciphertext preserved byte-for-byte (Google returned no new one)',
      rowR2.encrypted_refresh_token === rtBeforeR2,
      { same: rowR2.encrypted_refresh_token === rtBeforeR2 });
    check('R2d. exactly ONE gmail_tokens UPDATE, bound to the RIGHT google_sub, ONLY {encrypted_access_token, token_expiry}',
      refreshOps.length === 1 &&
        refreshOps[0].op === 'update' &&
        refreshOps[0].filter.length === 1 && refreshOps[0].filter[0][0] === 'google_sub' && refreshOps[0].filter[0][1] === sub &&
        Object.keys(refreshOps[0].payload).sort().join(',') === 'encrypted_access_token,token_expiry',
      JSON.stringify(refreshOps));
    check('R2e. Gmail received the REFRESHED access token, never the stale one',
      atSeen.includes('at_refreshed') && atSeen.includes('at_stale') === false,
      { seen: Array.from(new Set(atSeen)) });
    check('R2f. refresh used the DECRYPTED stored refresh token (correct plaintext, no spoofing)',
      refreshRtsSeen.includes('rt_valid'), { seen: refreshRtsSeen.length });
    check('R2g. zero ops on subscriptions/sessions during refresh scans',
      dbOps.slice(opsBeforeR2).every((o) => o.table === 'gmail_tokens'), dbOps.slice(opsBeforeR2));

    // ---------------------------------------------------------------
    // R3. Mid-flight 401 → exactly ONE refresh + ONE retry → 200
    // ---------------------------------------------------------------
    resetGmailCounters();
    dbOps.length = 0;
    setTokenRow({ at: 'at_valid', rt: 'rt_valid', expiryMs: Date.now() + 3600_000 });
    gmailConfig = { lists: LISTS, snippets: SNIPPETS, listError: null, getError: null, getErrorOnce: { code: 401, message: 'Invalid Credentials' } };
    const resR3 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    const bodyR3 = resR3.status === 200 ? JSON.parse(resR3.body) : null;
    check('R3. Gmail 401 mid-flight → one refresh, one retry → 200 full preview',
      resR3.status === 200 && bodyR3 && bodyR3.candidates.length === 3 && refreshCalls === startRefresh + 3,
      { s: resR3.status, candidates: bodyR3 ? bodyR3.candidates.length : null, refreshCalls });
    check('R3a. exactly one scan retry happened (6 list calls total: 3 + 3)',
      gmailCalls.list === 6 && gmailCalls.getMeta === 5 && gmailCalls.getFull === 3,
      { l: gmailCalls.list, m: gmailCalls.getMeta, f: gmailCalls.getFull });
    check('R3b. both the old and the refreshed AT were used (metadata from both attempts)',
      atSeen.includes('at_valid') && atSeen.includes('at_refreshed'), { seen: Array.from(new Set(atSeen)) });
    check('R3c. new AT persisted again (encrypted), bound to google_sub',
      tokenEncryption.decrypt(db.gmail_tokens[0].encrypted_access_token) === 'at_refreshed' &&
        dbOps.filter((o) => o.table === 'gmail_tokens' && o.op === 'update').length === 1 &&
        dbOps.every((o) => o.table === 'gmail_tokens'), dbOps);

    // ---------------------------------------------------------------
    // R4. No refresh loops: 401 after pre-flight refresh → NO second refresh
    // ---------------------------------------------------------------
    resetGmailCounters();
    dbOps.length = 0;
    setTokenRow({ at: 'at_stale2', rt: 'rt_valid', expiryMs: Date.now() - 60_000 });
    gmailConfig = { lists: LISTS, snippets: SNIPPETS, listError: null, getError: { code: 401, message: 'Invalid Credentials' }, getErrorOnce: null };
    googleCfg.refreshAccessToken = 'at_refreshed2';
    const beforeR4 = refreshCalls;
    const resR4 = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    check('R4. 401 after pre-flight refresh → 401 reconnect_required, refreshCalls stays 1 (NO loop), lists ran once',
      resR4.status === 401 && JSON.parse(resR4.body).error === 'reconnect_required' &&
        refreshCalls === beforeR4 + 1 && gmailCalls.list === 3,
      { s: resR4.status, b: resR4.body.slice(0, 70), refreshCalls, lists: gmailCalls.list });

    // ---------------------------------------------------------------
    // R7. Persist-verified refresh (approved CP3 correction): the refresh
    //     UPDATE must affect EXACTLY ONE row before the scan may use the
    //     refreshed token. Zero-row (e.g. concurrent disconnect deleted the
    //     row) or DB-error outcomes must FAIL CLOSED with a sanitized 502 —
    //     never a success envelope built on an unverified token.
    // ---------------------------------------------------------------

    // R7a (zero rows). Google REFRESH succeeds here on purpose: the only
    // failure is the DB side, proving the scanner fix is the row-count check.
    resetGmailCounters();
    dbOps.length = 0;
    googleCfg.refreshError = null;
    googleCfg.refreshAccessToken = 'at_zrow';
    googleCfg.refreshExpiryDate = Date.now() + 3600_000;
    setTokenRow({ at: 'at_zrow_stale', rt: 'rt_valid', expiryMs: Date.now() - 60_000 });
    const refreshCallsBeforeZ = refreshCalls;
    const rowBeforeZ = JSON.stringify(db.gmail_tokens[0]);
    dbFault.zeroRowUpdate = true; // one-shot; cleared below
    const resR7z = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    dbFault.zeroRowUpdate = false;
    resR7z
    check('R7a. zero-row refresh UPDATE → FAIL CLOSED 502 (never 200), exactly one refresh attempt, ZERO Gmail calls',
      resR7z.status === 502 && JSON.parse(resR7z.body).error === 'Scan failed. Please try again shortly.' &&
        refreshCalls === refreshCallsBeforeZ + 1 && gmailCalls.list === 0,
      { s: resR7z.status, b: resR7z.body.slice(0, 70), refreshCalls, lists: gmailCalls.list });
    check('R7a2. zero-row outcome mutated NOTHING: row byte-identical before/after, no subscriptions/sessions ops',
      JSON.stringify(db.gmail_tokens[0]) === rowBeforeZ && dbOps.every((o) => o.table === 'gmail_tokens'),
      { same: JSON.stringify(db.gmail_tokens[0]) === rowBeforeZ });

    // R7b (database error).
    resetGmailCounters();
    dbOps.length = 0;
    setTokenRow({ at: 'at_dberr_stale', rt: 'rt_valid', expiryMs: Date.now() - 60_000 });
    const refreshCallsBeforeD = refreshCalls;
    dbFault.updateError = new Error('simulated database failure'); // one-shot
    const resR7d = await request('/api/scan', { method: 'POST', headers: { cookie: boundCookie } });
    check('R7b. database-error refresh UPDATE → FAIL CLOSED 502, NO Gmail call beyond pre-flight list, no retry loop',
      resR7d.status === 502 && JSON.parse(resR7d.body).error === 'Scan failed. Please try again shortly.' &&
        refreshCalls === refreshCallsBeforeD + 1 && gmailCalls.list === 0,
      { s: resR7d.status, b: resR7d.body.slice(0, 70), refreshCalls, lists: gmailCalls.list });

    // Restore a healthy token row for the remaining audits.
    googleCfg.refreshAccessToken = 'at_valid';
    setTokenRow({ at: 'at_valid', rt: 'rt_valid', expiryMs: Date.now() + 3600_000 });

    // ---------------------------------------------------------------
    // Final audits (cumulative across ALL scenarios)
    // ---------------------------------------------------------------
    check('W1. read-only Gmail invariant: zero write ops across ALL scenarios', gmailCalls.writeOps === 0, { writeOps: gmailCalls.writeOps });
    check('W1a. only list/get formats metadata+full used', gmailCalls.getFormats.every((f) => f === 'metadata' || f === 'full'), gmailCalls.getFormats);
    const allOps = dbOpsAll.filter((o) => o.table !== 'gmail_tokens');
    const tokOps = dbOpsAll.filter((o) => o.table === 'gmail_tokens');
    check('W2. scan scenarios write NOTHING except token refresh: zero subscription ops; session ops only the two auth-setup ones (never binding google_sub)',
      allOps.filter((o) => o.table === 'subscriptions').length === 0 &&
        allOps.filter((o) => o.table === 'sessions').every((o) =>
          o.op === 'insert' || (o.op === 'update' && Object.keys(o.payload).join(',') === 'oauth_state')),
      allOps);
    check('W2a. gmail_tokens writes are ONLY refresh updates with safe fields + correct google_sub binding (R2 + R3 + R4 pre-flight + R7 attempts)',
      tokOps.length === 5 &&
        tokOps.every((o) => o.op === 'update' &&
          o.filter.some(([c, v]) => c === 'google_sub' && v === sub) &&
          Object.keys(o.payload).every((k) => k === 'encrypted_access_token' || k === 'token_expiry') &&
          o.select === 'google_sub'),
      JSON.stringify(tokOps));
    check('W2b. second account gmail_tokens row byte-identical across ALL scenarios', JSON.stringify(db.gmail_tokens[1]) === OTHER_SNAPSHOT, '');
    check('W2c. six subscription seeds byte-identical across ALL scenarios', JSON.stringify(db.subscriptions) === SUBS_SNAPSHOT, '');
    check('R5. session row untouched across all scenarios', JSON.stringify(sess) === JSON.stringify(snapshot.sess), '');

    const bodyStr = resA1.body + resA2.body + resA3.body + resE1.body + resE2.body + resE3.body + resE3.body + resE4.body + resE5.body + resP1.body + resP2.body + resP3.body + resP4.body + resP5.body + resR0.body + resR1.body + resR2.body + resR3.body + resR4.body + resR7z.body + resR7d.body;
    check('R6. responses leak no plaintext tokens / cookies / message bodies',
      !/at_valid|at_stale|at_refreshed|rt_valid|at_other|Bearer|NEVER-STORED-BODY/.test(bodyStr) &&
        !bodyStr.includes(sess.id), bodyStr.slice(0, 90));
    const logs = emailLog.join('\n');
    check('R6a. logs leak no tokens, message content, or emails',
      !logs.includes('@netflix') && !logs.includes('@adobe') && !logs.includes('@notenest') &&
        !logs.includes('Netflix free trial') && !/Bearer\s/i.test(logs) &&
        !/at_(valid|stale2?|refreshed2?)|rt_(valid|other)/.test(logs),
      logs.split('\n').slice(0, 4));
    check('R6b. no plaintext access token was EVER passed as a DB value',
      db.gmail_tokens.every((r) => !/^(at_|rt_)/.test(String(r.encrypted_access_token ?? '')) && !/^(at_|rt_)/.test(String(r.encrypted_refresh_token ?? ''))), '');
  } catch (err) {
    results.push(`ABORT ${err.stack}`);
    failCount += 1;
  } finally {
    await stopServer();
  }

  console.log('\n===== CP2+CP3 gmail-scan harness =====');
  results.forEach((r) => console.log(r));
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}

run();
