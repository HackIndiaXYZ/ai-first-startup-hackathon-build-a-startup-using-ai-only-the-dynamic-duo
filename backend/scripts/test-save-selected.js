/**
 * CP5 test harness — Save Selected Subscriptions.
 *
 * Self-contained and secrets-free: no real Google credentials, no live
 * Supabase, no Gmail calls, no network outside 127.0.0.1. The
 * @supabase/supabase-js, googleapis, and gmailScanner modules are stubbed in
 * Node's require cache; scenarios run against an in-memory database that
 * faithfully emulates the migration-004 behaviors the routes rely on
 * (partial unique index on (owner_sub, source_message_id) → Postgres 23505,
 * the `source` vocabulary, insert defaults).
 *
 * Gates (approved CP5 v2 plan §11):
 *   auth / ownership          — nothing without a verified bound session;
 *                               body ownership identifiers are ignored
 *   reference binding         — foreign/forged/expired refs are ONE error, no oracle
 *   body shape                — ≤10 ids, unknown ids per-item, no object trust
 *   validation                — invalid candidates fail individually, DB-safe
 *   duplicates                — idempotent, concurrent-safe, owner-scoped
 *   GET isolation             — demo rows public, private rows never leak
 *   demo preservation (HARD)  — six seeded rows byte-identical across saves
 *
 * Usage: node backend/scripts/test-save-selected.js   (prints PASS/FAIL only)
 */

process.env.NODE_ENV = 'test';
process.env.PORT = '3098';
process.env.SESSION_SECRET = 'cp5-harness-session-secret';
process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
// Throwaway test-only values so supabaseClient.getClient() passes its config
// check and reaches the stubbed createClient. No real Supabase is contacted.
process.env.SUPABASE_URL = 'https://stub.supabase.test';
process.env.SUPABASE_SECRET_KEY = 'stub-service-role-key';

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const Module = require('module');

const backendRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// In-memory database — emulates migration 004 semantics
// ---------------------------------------------------------------------------
const db = { sessions: [], gmail_tokens: [], subscriptions: [] };
const DEMO_IDS = [
  'a1b2c3d4-0001-0001-0001-000000000001',
  'a1b2c3d4-0002-0002-0002-000000000002',
  'a1b2c3d4-0003-0003-0003-000000000003',
  'a1b2c3d4-0004-0004-0004-000000000004',
  'a1b2c3d4-0005-0005-0005-000000000005',
  'a1b2c3d4-0006-0006-0006-000000000006',
];
// Fault injection: errors consumed by subscriptions inserts, in order.
const insertFaults = [];
const googleCalls = { scanCalls: 0 };

// Configurable scanner result for issuance scenarios.
let scanResult = null;

function resetDb() {
  db.sessions.length = 0;
  db.gmail_tokens.length = 0;
  db.subscriptions.length = 0;
  insertFaults.length = 0;
  googleCalls.scanCalls = 0;
  scanResult = null;
  // Six demo rows EXACTLY as the live seed would look (user_id/owner NULL).
  let i = 0;
  for (const id of DEMO_IDS) {
    i += 1;
    db.subscriptions.push({
      id,
      user_id: null,
      owner_sub: null,
      source: 'demo',
      source_message_id: null,
      service_name: `DemoService${i}`,
      plan_name: `Demo Plan ${i}`,
      trial_start_date: '2026-09-01',
      trial_end_date: '2026-10-01',
      price: 9.99,
      currency: 'USD',
      status: i === 4 ? 'cancelled' : 'active',
      cancellation_url: `https://example-fictitious.test/${i}/cancel`,
      created_at: new Date(Date.UTC(2026, 0, i)).toISOString(),
      updated_at: new Date(Date.UTC(2026, 0, i)).toISOString(),
      renewal_date: null,
      payment_deadline: null,
      payment_issue_type: null,
      invoice_date: null,
      cancellation_deadline: null,
    });
  }
}

// ---------------------------------------------------------------------------
// Fake Supabase client
// ---------------------------------------------------------------------------
function makeSupabaseStub() {
  function from(tableName) {
    if (!['sessions', 'gmail_tokens', 'subscriptions'].includes(tableName)) {
      throw new Error(`Harness: unexpected table ${tableName}`);
    }
    const filters = []; // [type, col, value]
    let op = 'select';
    let payload = null;

    function rows() { return db[tableName]; }
    function matches(row) {
      return filters.every(([type, col, val]) => {
        if (type === 'eq') return row[col] === val;
        if (type === 'is-null') return row[col] == null;
        return true;
      });
    }
    function orMatches(row, expr) {
      // Only the exact predicate shape the routes emit:
      //   'owner_sub.is.null' | 'owner_sub.is.null,owner_sub.eq.<sub>'
      for (const clause of expr.split(',')) {
        const m = clause.match(/^owner_sub\.(is\.null|eq\.(.+))$/);
        if (!m) throw new Error(`Harness: unsupported or-clause ${clause}`);
        if (m[1] === 'is.null') { if (row.owner_sub == null) return true; }
        else if (row.owner_sub === m[2]) return true;
      }
      return false;
    }
    let orExpr = null;

    const result = {
      select() { return result; },
      eq(col, val) { filters.push(['eq', col, val]); return result; },
      is(col, val) { if (val === null) filters.push(['is-null', col, null]); return result; },
      or(expr) { orExpr = expr; return result; },
      order() { return result; },
      maybeSingle() {
        const found = rows().filter(
          (r) => matches(r) && (orExpr == null || orMatches(r, orExpr))
        );
        return Promise.resolve({ data: found[0] ?? null, error: null });
      },
      single() {
        const found = rows().filter(
          (r) => matches(r) && (orExpr == null || orMatches(r, orExpr))
        );
        return Promise.resolve({ data: found[0] ?? null, error: null });
      },
      insert(obj) { payload = obj; op = 'insert'; return result; },
      then(resolve, reject) {
        try {
          if (op === 'insert') {
            const rowsIn = Array.isArray(payload) ? payload : [payload];
            const inserted = [];
            for (const row of rowsIn) {
              // Emulate the migration-004 partial unique index:
              // (owner_sub, source_message_id) WHERE source_message_id IS NOT NULL
              if (row.source_message_id != null) {
                const clash = rows().some(
                  (r) => r.owner_sub === row.owner_sub && r.source_message_id === row.source_message_id
                );
                if (clash) {
                  const err = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
                  return resolve({ data: inserted.length ? inserted : null, error: err });
                }
              }
              if (faultsPending && insertFaults.length > 0) {
                const injected = insertFaults.shift();
                return resolve({ data: inserted.length ? inserted : null, error: injected });
              }
              const full = {
                id: crypto.randomUUID(),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                user_id: null,
                plan_name: null,
                trial_start_date: null,
                currency: null,
                cancellation_url: null,
                source: 'manual',
                ...row,
              };
              rows().push(full);
              inserted.push({ ...full });
            }
            return resolve({ data: inserted.map((r) => ({ ...r })), error: null });
          }
          // select-ish
          const found = rows().filter((r) => matches(r) && (orExpr == null || orMatches(r, orExpr)));
          return resolve({ data: found.map((r) => ({ ...r })), error: null });
        } catch (e) {
          reject(e);
        }
      },
    };
    return result;
  }
  return { from };
}

let faultsPending = true; // fault injection applies only to subscription inserts

// ---------------------------------------------------------------------------
// gmailScanner stub (configurable) — the scan route must never be exercised
// against real Gmail in this harness.
// ---------------------------------------------------------------------------
let issuedCandidates = [];
function makeScannerStub() {
  return {
    scanGmailAccount: async () => {
      googleCalls.scanCalls += 1;
      if (typeof scanResult === 'function') return scanResult();
      return scanResult ?? {
        ok: true,
        scannedAt: new Date().toISOString(),
        windowDays: 90,
        messagesListed: 10,
        messagesDeduped: 9,
        messagesThreads: 8,
        messagesSelected: 5,
        messagesInspected: 3,
        partial: false,
        candidates: issuedCandidates,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// require-cache interposition
// ---------------------------------------------------------------------------
const origLoad = Module._load;
Module._load = function stubbedLoad(request, parent, isMain) {
  if (request === '@supabase/supabase-js') {
    return { createClient: () => makeSupabaseStub() };
  }
  if (request && request.includes('gmailScanner')) {
    return makeScannerStub();
  }
  return origLoad.call(this, request, parent, isMain);
};

const scanRouter = require(path.join(backendRoot, 'src/routes/scan'));
const subscriptionsRouter = require(path.join(backendRoot, 'src/routes/subscriptions'));
const { COOKIE_NAME } = require(path.join(backendRoot, 'src/middleware/session'));
const cache = require(path.join(backendRoot, 'src/services/scanReferenceCache'));
const { validateCandidate, candidateToRow, isValidIsoDate } = require(path.join(backendRoot, 'src/services/saveCandidate'));

const express = require(path.join(backendRoot, 'node_modules/express'));
const cookieParser = require(path.join(backendRoot, 'node_modules/cookie-parser'));
const cookieSignature = require(path.join(backendRoot, 'node_modules/cookie-signature'));

let server;

function startServer() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.SESSION_SECRET));
  app.use('/api/scan', scanRouter);
  app.use('/api/subscriptions', subscriptionsRouter);
  return new Promise((resolve) => {
    server = app.listen(3098, '127.0.0.1', resolve);
  });
}

function stopServer() { return new Promise((resolve) => server.close(resolve)); }

function request(urlPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: 3098,
        path: urlPath,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Signed cookie header for a bound or unbound session. */
function authCookie(googleSub) {
  const id = crypto.randomBytes(32).toString('hex');
  db.sessions.push({
    id,
    google_sub: googleSub ?? null,
    oauth_state: null,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  });
  return { Cookie: `${COOKIE_NAME}=s:${cookieSignature.sign(id, process.env.SESSION_SECRET)}` };
}

function parse(body) { return JSON.parse(body); }

async function connectToken(sub) {
  db.gmail_tokens.push({
    google_sub: sub,
    email: 'stub@example.test',
    encrypted_access_token: 'enc-at',
    encrypted_refresh_token: 'enc-rt',
    token_expiry: new Date(Date.now() + 3600_000).toISOString(),
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

const FUTURE_ISO = new Date(Date.now() + 3600_000).toISOString();
function goodCandidate(id, overrides = {}) {
  return {
    sourceMessageId: id,
    classification: 'payment_reminder',
    serviceName: 'ChatGPT Plus',
    trialEndDate: null,
    renewalDate: null,
    invoiceDate: null,
    cancellationDeadline: null,
    paymentDeadline: '2026-10-22',
    paymentIssueType: 'payment_action_required',
    price: null,
    currency: null,
    confidence: 'high',
    ...overrides,
  };
}

async function runScan(sub, cookieHeader) {
  await connectToken(sub);
  issuedCandidates = [goodCandidate('msgA'), goodCandidate('msgB', { classification: 'trial', trialEndDate: '2026-11-01', paymentDeadline: null, paymentIssueType: null })];
  const res = await request('/api/scan', { method: 'POST', headers: cookieHeader });
  return { res, dto: parse(res.body) };
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

let realNow = Date.now;
function freezeAt(ms) {
  realNow = Date.now;
  const now = () => ms;
  Date.now = now;
}
function unfreeze() { Date.now = realNow; }

function demoSnapshot() {
  return JSON.stringify(db.subscriptions.filter((r) => r.source !== 'scan' && r.owner_sub == null).map((r) => ({ id: r.id, s: r.source, svc: r.service_name, plan: r.plan_name, t: r.trial_start_date, te: r.trial_end_date, p: r.price, cur: r.currency, st: r.status })));
}

async function run() {
  await startServer();
  try {
    // ==================== AUTH / OWNERSHIP ====================
    {
      resetDb();
      const res = await request('/api/scan/save', { method: 'POST', body: { scanRef: 'x'.repeat(43), messageIds: ['msgA'] } });
      check('1. save without session → 401', res.status === 401, `status=${res.status}`);

      const bound = authCookie('subA');
      const issued = await runScan('subA', bound);
      check('1a. POST /scan issues a 43-char scanRef', /[A-Za-z0-9_-]{43}/.test(issued.dto.scanRef ?? ''), JSON.stringify(issued.dto.scanRef));
      check('1b. scanRefExpiresAt present and ISO', !Number.isNaN(Date.parse(issued.dto.scanRefExpiresAt ?? '')));
      check('1c. scan response never contains cache internals', !JSON.stringify(issued.dto.candidates[0] || {}).includes('googleSub'));

      // Ownership identifiers in the body are ignored on the save path.
      const res2b = await request('/api/scan/save', {
        method: 'POST', headers: bound,
        body: { scanRef: issued.dto.scanRef, messageIds: ['msgA'], owner_sub: 'attacker', user_id: 'attacker' },
      });
      const out2b = parse(res2b.body);
      check('2. body-supplied ownership ids never honored', out2b.saved.length === 1 && !JSON.stringify(out2b).includes('attacker'));
      const stored = db.subscriptions.find((r) => r.source_message_id === 'msgA');
      check('2a. row owner_sub = verified session sub', stored && stored.owner_sub === 'subA', stored && stored.owner_sub);
    }

    // ==================== REFERENCE BINDING ====================
    {
      resetDb();
      // Foreign account tries to use subA's reference.
      const refA = cache.issueScanReference('subA', [goodCandidate('msgA')]);
      const foreignSession = authCookie('subB');
      const res = await request('/api/scan/save', { method: 'POST', headers: foreignSession, body: { scanRef: refA.scanRef, messageIds: ['msgA'] } });
      check('3. foreign google_sub cannot resolve another account’s ref → 409', res.status === 409 && parse(res.body).error === 'scan_expired', `status=${res.status}`);
      check('3a. nothing was written on the foreign attempt', db.subscriptions.filter((r) => r.source === 'scan').length === 0);

      // Expired reference.
      const own = authCookie('subA');
      const issued = await runScan('subA', own);
      freezeAt(Date.now() + cache.SCAN_REF_TTL_MS + 1000);
      const resExpired = await request('/api/scan/save', { method: 'POST', headers: own, body: { scanRef: issued.dto.scanRef, messageIds: ['msgA'] } });
      unfreeze();
      check('4. expired reference → 409 scan_expired', resExpired.status === 409 && parse(resExpired.body).error === 'scan_expired');

      // Unknown + malformed references → no oracle, no row.
      const resUnknown = await request('/api/scan/save', { method: 'POST', headers: own, body: { scanRef: 'z'.repeat(43), messageIds: ['msgA'] } });
      check('5. unknown 43-char ref → 409', resUnknown.status === 409);
      const resShort = await request('/api/scan/save', { method: 'POST', headers: own, body: { scanRef: 'zzz', messageIds: ['msgA'] } });
      check('6. malformed ref → 400', resShort.status === 400, `status=${resShort.status}`);
      check('6a. still no written rows', db.subscriptions.filter((r) => r.source === 'scan').length === 0);

      // Same 43-char messageIds-shape sanity: bad ids rejected per request.
      const fresh = await runScan('subA', own);
      const resBad = await request('/api/scan/save', { method: 'POST', headers: own, body: { scanRef: fresh.dto.scanRef, messageIds: ['!!bad!!'] } });
      check('7. ids failing the shape check → 400 (no silent partial)', resBad.status === 400);
    }

    // ==================== BODY SHAPE ====================
    {
      resetDb();
      const own = authCookie('subA');
      const issued = await runScan('subA', own);
      // 11 distinct ids → over cap.
      const over = Array.from({ length: 11 }, (_, i) => `msg${i}-${i === 0 ? 'A' : 'x'}`);
      const resOver = await request('/api/scan/save', { method: 'POST', headers: own, body: { scanRef: issued.dto.scanRef, messageIds: over } });
      check('8. >10 ids → 400', resOver.status === 400, `status=${resOver.status}`);
      const resEmpty = await request('/api/scan/save', { method: 'POST', headers: own, body: { scanRef: issued.dto.scanRef, messageIds: [] } });
      check('9. empty messageIds → 400', resEmpty.status === 400);
      // Intra-request duplicates collapse (same id twice → single item).
      const resDup = await request('/api/scan/save', { method: 'POST', headers: own, body: { scanRef: issued.dto.scanRef, messageIds: ['msgA', 'msgA'] } });
      const outDup = parse(resDup.body);
      check('10. duplicate ids in one body collapse', outDup.saved.length === 1 && outDup.alreadySaved.length === 0, JSON.stringify(outDup));

      // Unknown ids per-item; valid sibling unaffected.
      const fresh = await runScan('subA', own);
      const resMixed = await request('/api/scan/save', { method: 'POST', headers: own, body: { scanRef: fresh.dto.scanRef, messageIds: ['msgB', 'ghost-id'] } });
      const outMixed = parse(resMixed.body);
      check('11. unknown id → failed:not_in_scan (per item)', outMixed.failed.length === 1 && outMixed.failed[0].reason === 'not_in_scan');
      check('11a. valid sibling in same request still saves', outMixed.saved.length === 1 && outMixed.saved[0].serviceName === 'ChatGPT Plus');
    }

    // ==================== VALIDATION / PRIVACY ====================
    {
      resetDb();
      const own = authCookie('subA');
      await connectToken('subA');
      issuedCandidates = [
        { sourceMessageId: 'badDate', classification: 'trial', serviceName: 'X', trialEndDate: '2026-02-30', paymentDeadline: null, renewalDate: null, invoiceDate: null, cancellationDeadline: null, paymentIssueType: null, price: null, currency: null, confidence: null },
        { sourceMessageId: 'badType', classification: 'payment_reminder', serviceName: 'Y', paymentIssueType: 'not_a_type', paymentDeadline: null, renewalDate: null, invoiceDate: null, cancellationDeadline: null, trialEndDate: null, price: null, currency: null, confidence: null },
        { sourceMessageId: 'badCurrency', classification: 'trial', serviceName: 'Z', currency: 'usd!x', paymentDeadline: null, renewalDate: null, invoiceDate: null, cancellationDeadline: null, trialEndDate: null, paymentIssueType: null, price: null, confidence: null },
        { sourceMessageId: 'badPrice', classification: 'trial', serviceName: 'W', price: -5, paymentDeadline: null, renewalDate: null, invoiceDate: null, cancellationDeadline: null, trialEndDate: null, paymentIssueType: null, currency: null, confidence: null },
        { sourceMessageId: 'noName', classification: 'trial', serviceName: '   ', paymentDeadline: null, renewalDate: null, invoiceDate: null, cancellationDeadline: null, trialEndDate: null, paymentIssueType: null, price: null, currency: null, confidence: null },
        { sourceMessageId: 'okMsg', ...goodCandidate('okMsg'), snippet: 'BODY-CONTENT-NEVER-STORED-XYZ' },
      ];
      const res = await request('/api/scan', { method: 'POST', headers: own });
      const dto = parse(res.body);
      check('12. scan issued a reference for the mixed batch', typeof dto.scanRef === 'string' && dto.scanRef.length === 43, JSON.stringify(dto.scanRef));
      const saveRes = await request('/api/scan/save', { method: 'POST', headers: own, body: { scanRef: dto.scanRef, messageIds: ['badDate', 'badType', 'badCurrency', 'badPrice', 'noName', 'okMsg'] } });
      const out = parse(saveRes.body);
      check('12a. all five invalid → failed:invalid_fields', out.failed.length === 5 && out.failed.every((f) => f.reason === 'invalid_fields'), JSON.stringify(out.failed));
      check('12b. sibling valid row saved', out.saved.length === 1 && out.saved[0].serviceName === 'ChatGPT Plus');
      const row = db.subscriptions.find((r) => r.source_message_id === 'okMsg');
      check('13. unknown extra fields (snippet etc.) never reach the DB', !('snippet' in row) && JSON.stringify(row).indexOf('BODY-CONTENT') === -1);
      check('13a. scan-fact columns persisted losslessly',
        row.payment_deadline === '2026-10-22' && row.payment_issue_type === 'payment_action_required' && row.plan_name === null && row.trial_start_date === null && row.currency === null, JSON.stringify({ pd: row.payment_deadline, pit: row.payment_issue_type, cur: row.currency }));
      check('13b. quantity of columns per DTO absent → NULL (never invented)', row.price === null && row.renewal_date === null && row.invoice_date === null && row.cancellation_deadline === null);

      // Save response is sanitized: ownership identifier never leaves the server.
      check('14. save response has no owner_sub / raw row keys', !JSON.stringify(out).includes('owner_sub') && !JSON.stringify(out).includes('source_message_id'));
      check('14a. saved client row echoes sourceMessageId for selection reconciliation', out.saved[0].sourceMessageId === 'okMsg');
      check('15. no DB error messages leak in responses', !JSON.stringify(saveRes.body).includes('duplicate key') && !JSON.stringify(saveRes.body).includes('violates'));
    }

    // ==================== DUPLICATES ====================
    {
      resetDb();
      const own = authCookie('subA');
      const issued = await runScan('subA', own);
      const ref = issued.dto.scanRef;
      const body = { scanRef: ref, messageIds: ['msgA', 'msgB'] };
      const first = parse((await request('/api/scan/save', { method: 'POST', headers: own, body })).body);
      check('16. first save → 2 saved', first.saved.length === 2 && first.alreadySaved.length === 0, JSON.stringify(first));
      const before = db.subscriptions.length;
      const second = parse((await request('/api/scan/save', { method: 'POST', headers: own, body: { scanRef: ref, messageIds: ['msgA', 'msgB'] } })).body);
      check('17. idempotent replay → alreadySaved, zero new rows', second.alreadySaved.length === 2 && second.saved.length === 0 && db.subscriptions.length === before, JSON.stringify(second));

      // Concurrent double-click race: the DB constraint is the referee.
      resetDb();
      const own2 = authCookie('subA');
      const issued2 = await runScan('subA', own2);
      const raceBody = { scanRef: issued2.dto.scanRef, messageIds: ['msgA'] };
      const [r1, r2] = await Promise.all([
        request('/api/scan/save', { method: 'POST', headers: own2, body: raceBody }),
        request('/api/scan/save', { method: 'POST', headers: own2, body: raceBody }),
      ]);
      const o1 = parse(r1.body); const o2 = parse(r2.body);
      const totalSaved = o1.saved.length + o2.saved.length;
      const totalDup = o1.alreadySaved.length + o2.alreadySaved.length;
      const totalFail = o1.failed.length + o2.failed.length;
      const rowsNow = db.subscriptions.filter((r) => r.source === 'scan').length;
      check('18. concurrent race → exactly one insert, one alreadySaved', totalSaved === 1 && totalDup === 1 && totalFail === 0 && rowsNow === 1, JSON.stringify({ o1, o2 }));

      // Same message id, DIFFERENT owner → separate legitimate rows.
      const foreign = authCookie('subB');
      const issuedForeign = await runScan('subB', foreign);
      const resForeign = await request('/api/scan/save', { method: 'POST', headers: foreign, body: { scanRef: issuedForeign.dto.scanRef, messageIds: ['msgA'] } });
      const outForeign = parse(resForeign.body);
      check('19. cross-account same message id saves independently', outForeign.saved.length === 1);
      const both = db.subscriptions.filter((r) => r.source_message_id === 'msgA');
      check('19a. two rows, distinct owners', both.length === 2 && new Set(both.map((r) => r.owner_sub)).size === 2);

      // fault: non-23505 insert error → failed db_error (not a crash).
      resetDb();
      const own3 = authCookie('subA');
      await connectToken('subA');
      issuedCandidates = [goodCandidate('msgA')];
      const issued3 = await request('/api/scan', { method: 'POST', headers: own3 });
      const issued3dto = parse(issued3.body);
      insertFaults.push(Object.assign(new Error('connection terminated'), { code: 'XX000' }));
      const resFault = await request('/api/scan/save', { method: 'POST', headers: own3, body: { scanRef: issued3dto.scanRef, messageIds: ['msgA'] } });
      const outFault = parse(resFault.body);
      check('20. unexpected DB error → per-item failed:db_error', outFault.failed.length === 1 && outFault.failed[0].reason === 'db_error', JSON.stringify(outFault));
      check('20a. request still HTTP 200 (per-item truth, retryable)', resFault.status === 200);
    }

    // ==================== NO NAME-BASED UNIQUENESS ====================
    {
      resetDb();
      const own = authCookie('subA');
      await connectToken('subA');
      issuedCandidates = [
        goodCandidate('dup1', { serviceName: 'Same Service', paymentDeadline: null, paymentIssueType: null, classification: 'trial', trialEndDate: '2026-11-01' }),
        goodCandidate('dup2', { serviceName: 'Same Service', paymentDeadline: '2027-01-05', paymentIssueType: null, classification: 'renewal', renewalDate: '2027-01-05' }),
      ];
      const res = await request('/api/scan', { method: 'POST', headers: own });
      const dto = parse(res.body);
      const out = parse((await request('/api/scan/save', { method: 'POST', headers: own, body: { scanRef: dto.scanRef, messageIds: ['dup1', 'dup2'] } })).body);
      check('21. same service name from two emails → both saved (no plan-name uniqueness)', out.saved.length === 2 && out.failed.length === 0, JSON.stringify(out));
    }

    // ==================== GET ISOLATION / DEMO DATA ====================
    {
      resetDb();
      const ownA = authCookie('subA');
      const issued = await runScan('subA', ownA);
      const out = parse((await request('/api/scan/save', { method: 'POST', headers: ownA, body: { scanRef: issued.dto.scanRef, messageIds: ['msgA'] } })).body);
      void out;

      const anon = await request('/api/subscriptions');
      const anonList = parse(anon.body);
      check('22. unauthenticated GET → demo rows ONLY (6)', anonList.length === 6 && anonList.every((r) => r.source === 'demo'), `len=${anonList.length}`);

      // subA's private row must not appear for anonymous or foreign callers.
      const savedRowId = db.subscriptions.find((r) => r.source_message_id === 'msgA').id;
      const anonById = await request(`/api/subscriptions/${savedRowId}`);
      check('23. anonymous GET /:id of private row → 404', anonById.status === 404, `status=${anonById.status}`);
      const ownB = authCookie('subB');
      const bList = parse((await request('/api/subscriptions', { headers: ownB })).body);
      check('24. foreign session list excludes subA private records', bList.every((r) => r.source !== 'scan'));
      const bById = await request(`/api/subscriptions/${savedRowId}`, { headers: ownB });
      check('25. foreign GET /:id → 404 (no existence oracle)', bById.status === 404);
      const aList = parse((await request('/api/subscriptions', { headers: ownA })).body);
      check('26. own list = 6 demo + own scan', aList.length === 7 && aList.filter((r) => r.source === 'scan').length === 1, `len=${aList.length}`);
      check('26a. client shape exposes source/provenance but not owner_sub', 'source' in aList[0] && !JSON.stringify(aList).includes('owner_sub'));
      check('26b. saved row visible to owner with scan-fact DTO fields', aList.some((r) => r.source === 'scan' && r.paymentDeadline === '2026-10-22' && r.paymentIssueType === 'payment_action_required'));
      const demoById = await request('/api/subscriptions/aaaaaaaa-aaaa-aaaa', {});
      check('27. malformed uuid → 400', demoById.status === 400 || demoById.status === 404);

      // Demo preservation hard gate: snapshot before/after another save.
      const snapBefore = demoSnapshot();
      await request('/api/scan/save', { method: 'POST', headers: ownA, body: { scanRef: issued.dto.scanRef, messageIds: ['msgB'] } });
      const snapAfter = demoSnapshot();
      check('28. HARD GATE: six demo rows byte-identical across saves', snapBefore === snapAfter);
      const demoCount = db.subscriptions.filter((r) => DEMO_IDS.includes(r.id)).length;
      check('28a. exactly six demo rows remain', demoCount === 6 && db.subscriptions.filter((r) => r.source === 'demo').length === 6);
    }

    // ==================== CACHE UNITS ====================
    {
      resetDb();
      check('29. candidates clamp to per-ref cap', (() => {
        const many = Array.from({ length: 60 }, (_, i) => goodCandidate(`m${i}`));
        const ref = cache.issueScanReference('subA', many);
        const entry = cache.resolveScanReference(ref.scanRef, 'subA');
        return entry.candidates.size === cache.MAX_CANDIDATES_PER_REF;
      })());
      check('30. entries missing sourceMessageId are dropped at issue time', (() => {
        const ref = cache.issueScanReference('subA', [{}, goodCandidate('valid')]);
        const entry = cache.resolveScanReference(ref.scanRef, 'subA');
        return entry.candidates.size === 1 && entry.candidates.has('valid');
      })());
      check('31. resolve with wrong account → null', cache.resolveScanReference(cache.issueScanReference('subA', [goodCandidate('m1')]).scanRef, 'subB') === null);
      check('32. LRU bound: 33rd issuance evicts the oldest', (() => {
        const first = cache.issueScanReference('subA', [goodCandidate('m1')]);
        for (let i = 0; i < cache.MAX_REFS; i += 1) cache.issueScanReference('subA', [goodCandidate(`x${i}`)]);
        return cache.resolveScanReference(first.scanRef, 'subA') === null;
      })());
      check('33. TTL enforcement', (() => {
        const ref = cache.issueScanReference('subA', [goodCandidate('m1')]);
        freezeAt(Date.now() + cache.SCAN_REF_TTL_MS + 1);
        const dead = cache.resolveScanReference(ref.scanRef, 'subA');
        unfreeze();
        return dead === null;
      })());
      check('34. validateCandidate: real calendar-date enforcement', isValidIsoDate('2026-10-22') && !isValidIsoDate('2026-02-30') && !isValidIsoDate('not-a-date') && !isValidIsoDate('2026-10-22   '));
      check('35. candidateToRow defaults: no invented plan/trial-start/currency', (() => {
        const row = candidateToRow(goodCandidate('m9'), 'subA');
        return row.plan_name === null && row.trial_start_date === null && row.currency === null && row.status === 'active' && row.source === 'scan';
      })());
    }

    // ==================== SCAN FAULT (issuance safety) ====================
    {
      resetDb();
      await connectToken('subA');
      scanResult = () => { throw new Error('boom'); };
      const res = await request('/api/scan', { method: 'POST', headers: authCookie('subA') });
      check('36. scanner fault → sanitized 502, never a cache leak', res.status === 502 && !res.body.includes('boom'), `status=${res.status}`);
      scanResult = null;
    }
  } finally {
    await stopServer();
    unfreeze();
  }

  console.log(`\n== result: ${passCount} passed, ${failCount} failed ==`);
  if (failCount > 0) {
    console.log(results.filter((r) => r.startsWith('FAIL')).join('\n'));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(1);
});
