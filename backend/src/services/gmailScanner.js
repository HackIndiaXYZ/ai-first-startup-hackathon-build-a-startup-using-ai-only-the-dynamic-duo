/**
 * gmailScanner — TrialGuard Phase 3B (CP2 scan + CP3 token refresh).
 *
 * Read-only Gmail orchestration for the manual "Scan Now" MVP:
 *
 *   message.list  ×3 targeted queries  (25 maxResults each) → ids, deduped
 *   message.get   format=metadata      (headers only, capped 25) → classify
 *   message.get   format=full          (bounded ≤12 candidates + ≤4
 *                                      inconclusive-inspection reserve = ≤16)
 *                                      → snippet + decoded body text
 *
 * Snippets and decoded body text come ONLY from messages.get full reads
 * (documented correction): list-stage responses are deliberately NOT used as
 * a text source — only the explicit, budgeted full-get calls below fetch
 * message content. Both snippet and decoded body text are used transiently
 * inside extractSignatures for field extraction only — never stored in
 * Supabase, never logged, never put into any candidate field, and never
 * returned to the browser in any form.
 *
 * Bounded further inspection (approved correction #2): metadata-stage
 * subjects that did NOT classify but look payment/access-related (a
 * documented relevance probe) may receive at most 4 additional snippet
 * reads (`RESERVE_SNIPPET_CAP`) so a loosely-subjectied final reminder like
 * "A final reminder about your account" can still be detected. The full
 * extractSignatures pass must still classify decisively — an inspected
 * reserve message that stays unknown is dropped, never emitted. Every cap
 * truncation (metadata, candidates or reserve) keeps `partial` exact.
 *
 * Response envelope (approved detection-quality patch A + payment patch):
 *   messagesListed     — total ids across all three queries (individual list
 *                        calls may return overlapping ids; overlap is NOT
 *                        converted into a fixed duplicate ratio)
 *   messagesDeduped    — unique message ids after id-overlap dedupe
 *   messagesThreads    — unique threads after thread dedupe (selection pool)
 *   messagesSelected   — messages selected for metadata inspection (≤ 25)
 *   messagesInspected  — metadata gets + full gets actually performed
 *   partial            — true when anything eligible was excluded by any
 *                        retrieval cap (metadata/candidates/reserve-snippet)
 *                        or a rate limit
 *
 * Candidate ranking (paid patch, correction #4): explicit subject deadline
 * evidence ALWAYS sorts before its absence; within each evidence group,
 * classification priority applies (cancellation → payment_reminder → trial
 * → renewal → receipt), never category priority alone.
 *
 * Invariants (approved plan + amendments):
 *   - Gmail access is strictly read-only: this module calls ONLY
 *     gmail.users.messages.list and gmail.users.messages.get. There is no
 *     send/delete/trash/modify path — not even in error handlers.
 *   - Queries use valid Gmail search syntax: `newer_than:90d` window and
 *     `-in:spam -in:trash -in:chats` exclusions; NOT restricted to inbox
 *     (all mail is scanned, except Spam/Trash/Chats).
 *   - Strict retrieval budget: ≤ 3 list calls, ≤ 25 metadata gets, ≤ 12
 *     candidate full gets + ≤ 4 inconclusive-inspection reserve full gets
 *     (≤ 16 total) per scan; full bodies are read transiently for `snippet`
 *     and discarded — never stored, never logged.
 *   - CP3 token handling:
 *       · If the stored access token is expired or within 5 minutes of
 *         expiry, it is refreshed BEFORE any Gmail call using the existing
 *         googleOAuth.refreshAccessToken() implementation.
 *       · The new access token + expiry are persisted to gmail_tokens via a
 *         single UPDATE bound to the row's google_sub — encrypted with the
 *         existing AES-256-GCM tokenEncryption utilities. Plaintext tokens
 *         exist transiently in process memory only; they are never stored,
 *         logged, or returned.
 *       · The existing encrypted refresh token is preserved whenever Google
 *         does not return a new one (the update never touches that column).
 *       · A Gmail API 401 that indicates an expired/invalid access token
 *         triggers AT MOST ONE refresh and ONE scan retry for the whole
 *         request. No refresh loops are possible: once any refresh has been
 *         performed, further auth failures abort with reconnect_required.
 *       · If the refresh token is revoked, invalid, or missing, the scan
 *         aborts with the sanitized `reconnect_required` code and ZERO
 *         Gmail calls where possible (pre-flight) — no tokens are written.
 *   - All token reads and updates are bound to the authoritative google_sub
 *     of the token row (set server-side by the session-bound route). No
 *     client-supplied value can ever influence which account is touched.
 *   - No writes anywhere beyond the gmail_tokens access-token refresh:
 *     detections are never written to Supabase (that is the separate
 *     reviewed save step) and the mailbox is never modified.
 *   - Confidentiality: tokens are decrypted in-process only; logs carry
 *     counts and category codes, never message content or tokens.
 *
 * Input/Output (see scanGmailAccount):
 *   { ok: true,  scannedAt, windowDays, messagesListed, messagesDeduped,
 *     messagesInspected, candidates: [...] }
 *   { ok: false, code: 'reconnect_required' | 'rate_limited' |
 *                      'permission_denied' | 'gmail_unavailable' }
 */

'use strict';

const { google } = require('googleapis');
const googleOAuth = require('./googleOAuth');
const { getClient: getOAuthClient } = googleOAuth;
const { getClient: getSupabase } = require('../db/supabaseClient');
const { decrypt, encrypt } = require('./tokenEncryption');
const { extractSignatures, classificationOf, hasDateEvidence, subjectWarrantsInspection } = require('./detectionRules');
//body part: decodeBody extracts readable text from the payload already returned by format:'full'
const { decodeBody, BODY_CAP } = require('./messageBody');

// ---------------------------------------------------------------------------
const WINDOW_DAYS = 90;      // 90-day lookback window reported in the envelope
// ---------------------------------------------------------------------------
// Search configuration (Plan amendment #1 — valid Gmail API syntax)
// ---------------------------------------------------------------------------
// Date window + Spam/Trash/Chats exclusion. Inbox is deliberately NOT
// required — notifications often skip the inbox via labels/filters.
const EXCLUSIONS = 'newer_than:90d -in:spam -in:trash -in:chats';
const LIST_QUERIES = [
  `subject:(trial OR "free trial" OR "trial ends") ${EXCLUSIONS}`,
  `(renewal OR "renews on" OR subscription OR invoice OR receipt) ${EXCLUSIONS}`,
  `("cancel before" OR "cancellation deadline" OR bill) ${EXCLUSIONS}`,
];

const LIST_MAX_RESULTS = 25;   // per query — hard budget
const METADATA_CAP = 25;       // bounded metadata gets per scan
const FULL_GET_CAP = 12;       // bounded full-piece gets per scan (classified)
const RESERVE_SNIPPET_CAP = 4; // bounded extra full binds for inconclusive-but-relevant subjects (≤16 total)
// Pre-flight refresh window: a token expiring sooner than this is refreshed
// before the scan so it is usable for at least 5 minutes.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

// Payment patch: deadline-protecting classes sort first inside each
// deadline-evidence group (correction #4 — classification is the TIE-break,
// explicit deadline evidence is the primary sort key).
const CLASS_RANK = { cancellation: 0, payment_reminder: 1, trial: 2, renewal: 3, receipt: 4, unknown: 9 };

// ---------------------------------------------------------------------------
// Internal fault signaling (never leaks to the HTTP surface by itself — the
// route maps the final sanitized codes below)
// ---------------------------------------------------------------------------

/** Marker code for a 401 that looks like an expired/invalid access token. */
const AUTH_RETRY = 'auth_retry';

class ScanFault extends Error {
  /** @param {string} code — final sanitized code, or AUTH_RETRY. */
  constructor(code) {
    super('gmail fault');
    this.name = 'ScanFault';
    this.code = code;
  }
}

/** Maps a Gmail/OAuth error to a sanitized stable code. */
function mapGmailError(err) {
  const status = err?.code || err?.response?.status;
  const msg = String(err?.message || '');
  if (status === 401) return 'reconnect_required'; // non-retryable 401 shapes
  if (status === 429) return 'rate_limited';
  if (status === 403) {
    if (/ratelimit|rate limit|quota|userRateLimitExceeded|dailyLimitExceeded/i.test(msg)) {
      return 'rate_limited';
    }
    return 'permission_denied'; // Google denied the request (scope/permission)
  }
  return 'gmail_unavailable';
}

/**
 * True when a Gmail 401 plausibly means "this access token is expired or
 * invalid" (vs. some other auth-layer problem). Only such errors are allowed
 * to trigger the single refresh-and-retry recovery.
 */
function isRefreshableAuthError(err) {
  const status = err?.code || err?.response?.status;
  if (status !== 401) return false;
  const msg = String(err?.message || '');
  return /invalid credentials|invalid_grant|unauthenticated|invalid token|expired|authentication/i.test(msg);
}

/** Final sanitized code for a caught fault at the outer orchestration level. */
function codeFromFault(err) {
  if (err instanceof ScanFault) {
    return err.code === AUTH_RETRY ? 'reconnect_required' : err.code;
  }
  return mapGmailError(err);
}

// ---------------------------------------------------------------------------
// Token refresh (CP3) — reuses googleOAuth + tokenEncryption, no new crypto
// ---------------------------------------------------------------------------

/**
 * Refreshes the access token using the existing decrypted refresh token and
 * persists it encrypted, bound strictly to `googleSub`.
 *
 * @param {{ encrypted_refresh_token?: string|null }} tokenRow
 * @param {string} googleSub — authoritative account binding (never client-supplied)
 * @returns {Promise<{ ok: true, accessToken: string } | { ok: false }>}
 *   `ok:false` means "cannot refresh" (missing/undecryptable RT, Google
 *   rejected the refresh) — the caller then returns reconnect_required.
 *   Database failures propagate: the route's outer guard surfaces a
 *   sanitized 502 rather than a silently unstored token.
 */
async function tryRefresh(tokenRow, googleSub) {
  // Missing refresh token → nothing to refresh from (CP3 requirement 8).
  const rtCiphertext = tokenRow?.encrypted_refresh_token;
  if (typeof rtCiphertext !== 'string' || rtCiphertext.length === 0) return { ok: false };

  let refreshToken;
  try {
    refreshToken = decrypt(rtCiphertext);
  } catch {
    // Undecryptable refresh token (wrong key / tampered row) → fail closed.
    return { ok: false };
  }

  let refreshed;
  try {
    // Reuse the existing Phase 3A refresh implementation (no new OAuth logic).
    refreshed = await googleOAuth.refreshAccessToken(refreshToken);
  } catch (err) {
    // Google rejected the refresh (revoked/invalid RT) — sanitized, no retry loop.
    console.warn('[scan] token refresh rejected (sanitized):', mapGmailError(err));
    return { ok: false };
  }

  if (!refreshed?.accessToken) return { ok: false };

  // Persist ONLY the rotated access token + expiry. The refresh-token column
  // is omitted on purpose: when Google does not reissue a refresh token, the
  // existing ciphertext must survive untouched (CP3 requirement 5). Plaintext
  // never reaches this object — encrypt() happens on the single line below.
  const update = {
    encrypted_access_token: encrypt(refreshed.accessToken),
    token_expiry:
      refreshed.expiryDate
        ? new Date(refreshed.expiryDate).toISOString()
        : new Date(Date.now() + 3600 * 1000).toISOString(),
  };

  // ONE conditional UPDATE bound to the row's google_sub — the same binding
  // the session-authenticated route used to load the row. Another Google
  // account's row can never match this predicate. `.select()` makes the
  // request use RETURNING, so the affected rows come back and persistence is
  // VERIFIED, not assumed (PostgREST/SUPABASE returns no error on a
  // zero-row UPDATE — e.g. the row was deleted by a concurrent disconnect —
  // so only the row count can prove the write landed).
  const { data, error } = await getSupabase()
    .from('gmail_tokens')
    .update(update)
    .eq('google_sub', googleSub)
    .select('google_sub');
  if (error) throw error; // persistence failure → 502 via route's outer guard

  // google_sub is UNIQUE (migration 002), so exactly 1 is the only correct
  // outcome. Zero rows (row concurrently deleted) or more than one would
  // both mean the refreshed token is NOT verified as stored for THIS
  // account — fail closed (generic error → route's outer guard → sanitized
  // 502) instead of scanning on an unverified token.
  const updatedRows = Array.isArray(data) ? data.length : 0;
  if (updatedRows !== 1) {
    console.error('[scan] token persistence verified 0 or multiple rows (sanitized)');
    throw new Error('token persistence did not update exactly one row');
  }

  return { ok: true, accessToken: refreshed.accessToken };
}

// ---------------------------------------------------------------------------
// Gmail client (read-only surface)
// ---------------------------------------------------------------------------

function getGmail(authClient) {
  return google.gmail({ version: 'v1', auth: authClient });
}

function withReadonlyClient(accessToken) {
  const oauth2 = getOAuthClient(); // throws when env config is missing (503 upstream)
  oauth2.credentials = { access_token: accessToken };
  return oauth2;
}

// ---------------------------------------------------------------------------
// Core scan (one attempt; the caller may allow exactly one refresh+retry)
// ---------------------------------------------------------------------------

/**
 * Runs the read-only Gmail orchestration once with the given access token.
 * Throws ScanFault (final code, or AUTH_RETRY at stage boundaries) when the
 * attempt must abort.
 */
async function runScan(accessToken) {
  const gmail = getGmail(withReadonlyClient(accessToken));
  const userId = 'me';

  // 1) LIST — three targeted queries (amendment #1 syntax), union ids.
  const rawIds = [];
  let listed = 0;
  try {
    for (const q of LIST_QUERIES) {
      const res = await gmail.users.messages.list({
        userId, q, maxResults: LIST_MAX_RESULTS,
      });
      const messages = res?.data?.messages || [];
      listed += messages.length;
      for (const m of messages) {
        if (m?.id) rawIds.push({ id: m.id, threadId: m.threadId || m.id });
      }
    }
  } catch (err) {
    if (isRefreshableAuthError(err)) throw new ScanFault(AUTH_RETRY);
    throw new ScanFault(mapGmailError(err));
  }

  // 2) DEDUPE — three separately tracked stages (approved detection-quality
  //    patch A). Gmail's result id is stable per message but separate list
  //    queries overlap; the same message may also legitimately repeat. The
  //    id-stage never assumes 42 listed → 25 unique means a fixed ratio.
  const seenIds = new Set();
  const seenThreads = new Set();
  const uniqueIds = [];       // after id-overlap dedupe (pre-tag)
  const uniqueThreads = [];   // unique threads after thread dedupe — pre-cap
  for (const m of rawIds) {
    if (seenIds.has(m.id)) continue;
    seenIds.add(m.id);
    uniqueIds.push(m);
    if (seenThreads.has(m.threadId)) continue;
    seenThreads.add(m.threadId);
    uniqueThreads.push(m);
  }

  // 2a) Count/flag any cap that excluded eligible messages so partial:true is
  //     exact rather than inferred.
  const capTruncated = uniqueThreads.length > METADATA_CAP;

  // 3) METADATA selection — eligible set capped at METADATA_CAP.
  const unique = uniqueThreads.slice(0, METADATA_CAP);

  // 3) METADATA GET — headers only (no snippet, no body traffic).
  const metadata = [];
  let inspected = 0;
  let rateLimited = false;
  for (const m of unique) {
    try {
      const res = await gmail.users.messages.get({
        userId,
        id: m.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      });
      inspected += 1;
      const data = res?.data || {};
      const headers = {};
      for (const h of data.payload?.headers || []) {
        if (h?.name && h?.value) headers[h.name.toLowerCase()] = h.value;
      }
      metadata.push({
        id: m.id,
        threadId: m.threadId,
        subject: typeof headers.subject === 'string' ? headers.subject : '',
        from: typeof headers.from === 'string' ? headers.from : '',
        dateHeader: typeof headers.date === 'string' ? headers.date : null,
        internalDate: typeof data.internalDate === 'string' ? Number(data.internalDate) || null : null,
      });
    } catch (err) {
      if (isRefreshableAuthError(err)) throw new ScanFault(AUTH_RETRY);
      const code = mapGmailError(err);
      if (code === 'rate_limited') {
        rateLimited = true; // single item hit the rate limiter → partial scan
        break;
      }
      throw new ScanFault(code);
    }
  }

  // 4) SELECT candidates worth a snippet — approved correction #4: explicit
  //    subject deadline evidence first (binary), then classification rank
  //    (cancellation → payment_reminder → trial → renewal → receipt), stable
  //    within identical keys, capped at FULL_GET_CAP.
  const rankedAll = metadata
    .map((m) => ({
      m,
      cls: classificationOf(String(m.subject || '').toLowerCase(), '').classification,
      deadline: hasDateEvidence(String(m.subject || '')),
    }))
    .filter((r) => r.cls !== 'unknown')
    .sort((a, b) =>
      (b.deadline ? 1 : 0) - (a.deadline ? 1 : 0) || CLASS_RANK[a.cls] - CLASS_RANK[b.cls]
    );
  const fullCapTruncated = rankedAll.length > FULL_GET_CAP;
  const ranked = rankedAll.slice(0, FULL_GET_CAP);

  // 4b) BOUNDED FURTHER INSPECTION (corrections #2/#3) — metadata subjects
  //     that did NOT classify but pass the documented relevance probe get at
  //     most RESERVE_SNIPPET_CAP additional snippet reads on top of the
  //     candidates budget (total full gets ≤ 16). Deadline-bearing subjects
  //     probe first. A reserve message still must classify decisively after
  //     its snippet or it is dropped — the probe never classifies.
  const reservePool = metadata
    .map((m) => ({
      m,
      cls: classificationOf(String(m.subject || '').toLowerCase(), '').classification,
      deadline: hasDateEvidence(String(m.subject || '')),
    }))
    .filter((r) => r.cls === 'unknown' && subjectWarrantsInspection(String(r.m.subject || '').toLowerCase()))
    .sort((a, b) => (b.deadline ? 1 : 0) - (a.deadline ? 1 : 0));
  const reserveCapTruncated = reservePool.length > RESERVE_SNIPPET_CAP;
  const reserveSelected = reservePool.slice(0, RESERVE_SNIPPET_CAP);

  // 5) FULL GET — bounded; read ONLY snippet + date, discard everything else.
  //    A single item hitting the rate limiter stops further full gets
  //    (partial scan; classified candidates are always served first)
  //    without failing the whole request.
  const candidates = [];
  const fullGetCandidates = async (list) => {
    for (const { m } of list) {
      try {
        const res = await gmail.users.messages.get({
          userId,
          id: m.id,
          format: 'full',
        });
        inspected += 1;
        const data = res?.data || {};
        const snippet = typeof data.snippet === 'string' ? data.snippet : '';
        //body part: decode the body from the payload already present in the full-get response;
        //bodyText is transient — never stored, logged, put into a candidate, or returned
        const bodyText = decodeBody(data.payload).slice(0, BODY_CAP);
        const headerDate = m.dateHeader
          || (m.internalDate ? new Date(m.internalDate).toISOString() : null);
        const sig = extractSignatures({
          subject: m.subject,
          from: m.from,
          snippet,
          body: bodyText,
          date: headerDate,
        });
        if (sig.classification !== 'unknown') {
          candidates.push({
            sourceMessageId: m.id,
            classification: sig.classification,
            serviceName: sig.serviceName,
            trialEndDate: sig.trialEndDate,
            renewalDate: sig.renewalDate,
            invoiceDate: sig.invoiceDate,
            cancellationDeadline: sig.cancellationDeadline,
            paymentDeadline: sig.paymentDeadline,
            paymentIssueType: sig.paymentIssueType,
            price: sig.price,
            currency: sig.currency,
            confidence: sig.confidence, // 'high' | 'medium' | 'low'
          });
        }
      } catch (err) {
        if (isRefreshableAuthError(err)) throw new ScanFault(AUTH_RETRY);
        const code = mapGmailError(err);
        if (code === 'rate_limited') {
          rateLimited = true; // single item hit the rate limiter → partial scan
          return;
        }
        throw new ScanFault(code);
      }
    }
  };

  await fullGetCandidates(ranked);
  if (!rateLimited) await fullGetCandidates(reserveSelected);

  // Counts only — no message content in any log line. Every stage is
  // reported separately (the approved patch A) so displayed counts are
  // honest rather than derived: listed ids, unique ids, unique threads,
  // metadata-selected, full-get-inspected, candidates.
  console.log(`[scan] lists=${LIST_QUERIES.length} listed=${listed} unique=${uniqueIds.length}` +
    ` threads=${uniqueThreads.length} selected=${unique.length} inspected=${inspected}` +
    ` capped=${capTruncated ? 'y' : 'n'} fullCapped=${fullCapTruncated ? 'y' : 'n'}` +
    ` reserve=${reserveSelected.length} reserveCapped=${reserveCapTruncated ? 'y' : 'n'}` +
    ` candidates=${candidates.length}`);

  return {
    ok: true,
    scannedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    messagesListed: listed,          // total message ids across ALL queries
    messagesDeduped: uniqueIds.length, // unique ids after overlap dedupe
    messagesThreads: uniqueThreads.length, // unique threads after thread dedupe
    messagesSelected: unique.length, // selected for metadata (≤ METADATA_CAP)
    messagesInspected: inspected,    // metadata gets + full gets performed
    partial: rateLimited || capTruncated || fullCapTruncated || reserveCapTruncated || undefined,
    candidates,
  };
}

// ---------------------------------------------------------------------------
// Main scan entry point (CP3 orchestration)
// ---------------------------------------------------------------------------

/**
 * Runs a full read-only scan for one account with CP3 token handling:
 * pre-flight refresh when the stored token is expired/near-expiry, plus at
 * most ONE mid-flight refresh + ONE scan retry when Gmail reports an
 * expired/invalid access token (401). Refresh loops are structurally
 * impossible (single `refreshUsed` guard across the whole request).
 *
 * @param {{ google_sub: string, encrypted_access_token: string,
 *            encrypted_refresh_token?: string|null,
 *            token_expiry?: string|null }} tokenRow
 *   Raw row from gmail_tokens (the caller never sees plaintext tokens).
 * @returns {Promise<object>} ok/scan-result envelope (see module docstring)
 */
async function scanGmailAccount(tokenRow) {
  // The account binding comes from the row the session-authenticated route
  // loaded — never from any request value (CP3 requirement 7).
  const googleSub = typeof tokenRow?.google_sub === 'string' ? tokenRow.google_sub : '';
  if (!googleSub) return { ok: false, code: 'reconnect_required' };

  let accessToken = '';
  try {
    accessToken = typeof tokenRow?.encrypted_access_token === 'string'
      ? decrypt(tokenRow.encrypted_access_token)
      : '';
  } catch {
    accessToken = '';
  }

  const expiryMs = tokenRow?.token_expiry ? Date.parse(tokenRow.token_expiry) : NaN;
  const needsPreFlightRefresh =
    !accessToken ||
    !Number.isFinite(expiryMs) ||
    expiryMs <= Date.now() + EXPIRY_MARGIN_MS;

  let refreshUsed = false;
  if (needsPreFlightRefresh) {
    refreshUsed = true;
    const r = await tryRefresh(tokenRow, googleSub);
    if (!r.ok) {
      // Revoked/invalid/missing refresh token → reconnect required, ZERO
      // Gmail calls were made, nothing plausibly persisted.
      return { ok: false, code: 'reconnect_required' };
    }
    accessToken = r.accessToken;
  }

  try {
    return await runScan(accessToken);
  } catch (err) {
    if (err?.code === AUTH_RETRY && !refreshUsed) {
      // Exactly one refresh attempt and one full-scan retry (requirement 9/11).
      refreshUsed = true;
      const r = await tryRefresh(tokenRow, googleSub); // may throw on DB failure → route 502
      if (r.ok) {
        try {
          return await runScan(r.accessToken);
        } catch (err2) {
          return { ok: false, code: codeFromFault(err2) };
        }
      }
      return { ok: false, code: 'reconnect_required' };
    }
    return { ok: false, code: codeFromFault(err) };
  }
}

module.exports = {
  scanGmailAccount,
  LIST_QUERIES,
  LIST_MAX_RESULTS,
  METADATA_CAP,
  FULL_GET_CAP,
  RESERVE_SNIPPET_CAP,
  EXPIRY_MARGIN_MS,
  AUTH_RETRY,
  mapGmailError,
};
