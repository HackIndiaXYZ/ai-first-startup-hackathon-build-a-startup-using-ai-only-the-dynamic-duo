/**
 * scan routes — TrialGuard Phase 3B CP2.
 *
 *   POST /api/scan        → manual "Scan Now": read-only Gmail scan → preview
 *                           DTO + server-issued scan reference (CP5-A)
 *   POST /api/scan/save   → save selected candidates against the reference (CP5-B)
 *
 * CP2 + CP3 scope (approved):
 *   - Session-protected: `session({ requireAuth: true })` returns 401 for
 *     missing/unbound sessions (existing C3 middleware — no new auth logic).
 *   - Uses the row in gmail_tokens bound to req.session.google_sub. Token
 *     refresh (CP3) happens inside the scanner: pre-flight when expired or
 *     within 5 minutes of expiry, plus at most ONE refresh + ONE retry on a
 *     Gmail 401 that indicates an expired/invalid access token. The new
 *     token is persisted encrypted, bound to the same google_sub. A revoked,
 *     invalid, or missing refresh token → sanitized 401 reconnect_required.
 *   - NEVER writes detections to Supabase (preview only) and never writes to
 *     the mailbox (scanner is list/get only). The ONLY write this route can
 *     cause is the encrypted access-token rotation on gmail_tokens.
 *   - Responses contain counts, codes, and detection previews — never tokens,
 *     cookies, session identifiers, or message bodies. Counts are stage-split
 *     (listed / unique ids / unique threads / selected / inspected) so the UI
 *     can label them accurately and flag cap truncation via partial.
 *
 * CP5 scope (approved plan v2):
 *   POST /api/scan        → also issues a short-lived server-side scan
 *                           reference (scanRef, bound to the verified
 *                           google_sub, 10-minute TTL, bounded memory) — the
 *                           ONLY way the client can later authorize a save.
 *   POST /api/scan/save   → saves selected candidates. The client sends ONLY
 *     { scanRef, messageIds } — NEVER candidate objects: candidates are
 *     resolved from the server cache, re-validated, ownership is derived
 *     exclusively from the verified session, and duplicates reconcile
 *     idempotently via the DB unique index on (owner_sub, source_message_id)
 *     (Postgres 23505 → "alreadySaved", race-safe).
 */

const express = require('express');
const router = express.Router();

const { scanGmailAccount } = require('../services/gmailScanner');
const { getClient } = require('../db/supabaseClient');
const { session } = require('../middleware/session');
const {
  issueScanReference,
  resolveScanReference,
} = require('../services/scanReferenceCache');
const {
  validateCandidate,
  candidateToRow,
  REASONS,
} = require('../services/saveCandidate');

const MAX_SAVE_ITEMS = 10;
const SCANREF_RE = /^[A-Za-z0-9_-]{43}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;

/** Snake_case subscription row → safe client DTO (saved rows only).
    owner_sub is NEVER exposed (it is the identity of the verified session the
    client already knows). sourceMessageId IS echoed: the client holds these
    ids from its own scan (and needs them to reconcile its selection), and a
    message id is a label — never message content. */
function savedRowToClient(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceMessageId: row.source_message_id,
    serviceName: row.service_name,
    planName: row.plan_name,
    trialStartDate: row.trial_start_date,
    trialEndDate: row.trial_end_date,
    price: row.price == null ? null : Number(row.price),
    currency: row.currency,
    status: row.status,
    cancellationUrl: row.cancellation_url,
    source: row.source,
    renewalDate: row.renewal_date,
    paymentDeadline: row.payment_deadline,
    paymentIssueType: row.payment_issue_type,
    invoiceDate: row.invoice_date,
    cancellationDeadline: row.cancellation_deadline,
  };
}

router.post('/', session({ requireAuth: true }), async (req, res, next) => {
  let supabase;
  try {
    supabase = getClient();
  } catch {
    return next({ status: 503, message: 'Database is not configured.' });
  }

  // The account binding comes ONLY from the server-side session — never from
  // any client-supplied value.
  const googleSub = req.session.google_sub;

  // Load the account's encrypted token row (select only what the scanner needs).
  let tokenRow;
  try {
    const { data, error } = await supabase
      .from('gmail_tokens')
      .select('google_sub, encrypted_access_token, encrypted_refresh_token, token_expiry')
      .eq('google_sub', googleSub)
      .maybeSingle();
    if (error) throw error;
    tokenRow = data;
  } catch (err) {
    console.error('[POST /scan] token lookup failed (details suppressed):', err.message);
    return next({ status: 502, message: 'Could not verify the Gmail connection.' });
  }

  if (!tokenRow?.encrypted_access_token) {
    return res.status(409).json({ error: 'not_connected', message: 'Connect Gmail before scanning.' });
  }

  try {
    const result = await scanGmailAccount(tokenRow);
    if (!result.ok) {
      if (result.code === 'reconnect_required' || result.code === 'token_expired') {
        // Sanitized: tells the user what to do (reconnect), leaks nothing.
        // token_expired is kept as a defensive legacy alias from CP2.
        const error = result.code === 'reconnect_required' ? 'reconnect_required' : 'token_expired';
        return res.status(401).json({
          error,
          message: 'The Gmail connection has expired or was revoked. Please reconnect Gmail to continue.',
        });
      }
      if (result.code === 'permission_denied') {
        return res.status(403).json({
          error: 'permission_denied',
          message: 'Gmail access was denied for this scan. Please reconnect Gmail and confirm read access was granted.',
        });
      }
      if (result.code === 'rate_limited') {
        return res.status(503).json({
          error: 'rate_limited',
          message: 'Gmail limited the scan. Please wait a moment and try again.',
        });
      }
      return res.status(502).json({
        error: 'gmail_unavailable',
        message: 'Gmail could not be reached for the scan. Please try again shortly.',
      });
    }
    // CP5-A: AFTER a successful scan, issue a scan reference bound to the
    // verified google_sub. The DTO sent to the UI carries ONLY the opaque
    // token + expiry — never the cached contents (no bodies, no snippets).
    let issued;
    try {
      issued = issueScanReference(googleSub, result.candidates || []);
    } catch (err) {
      // A reference-cache fault must never fail a completed scan: respond
      // without a scanRef and saving simply stays unavailable this round.
      console.error('[POST /scan] scanRef issue failed:', err.message);
      issued = null;
    }
    // Preview DTO only — no persistence, no tokens, no message bodies.
    return res.json({
      scannedAt: result.scannedAt,
      windowDays: result.windowDays,
      messagesListed: result.messagesListed,
      messagesDeduped: result.messagesDeduped,
      messagesThreads: result.messagesThreads,
      messagesSelected: result.messagesSelected,
      messagesInspected: result.messagesInspected,
      partial: result.partial,
      candidates: result.candidates,
      scanRef: issued ? issued.scanRef : null,
      scanRefExpiresAt: issued ? issued.expiresAt : null,
    });
  } catch (err) {
    // Outer guard: unexpected scanner fault → sanitized 502, no internals.
    console.error('[POST /scan] unexpected failure (details suppressed):', err.message);
    return next({ status: 502, message: 'Scan failed. Please try again shortly.' });
  }
});

// -----------------------------------------------------------------------------
// CP5-B: POST /api/scan/save — save selected candidates.
// The request body is { scanRef, messageIds } ONLY. Ownership comes from the
// verified session; candidate data comes ONLY from the server-side cache.
// -----------------------------------------------------------------------------
router.post('/save', session({ requireAuth: true }), async (req, res, next) => {
  let supabase;
  try {
    supabase = getClient();
  } catch {
    return next({ status: 503, message: 'Database is not configured.' });
  }

  const googleSub = req.session.google_sub; // verified identity — never client-supplied

  // ---- Body shape validation (whitelist-first) ----------------------------
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const scanRef = typeof body.scanRef === 'string' && SCANREF_RE.test(body.scanRef) ? body.scanRef : null;
  const rawIds = Array.isArray(body.messageIds) ? body.messageIds : null;
  if (!scanRef || !rawIds || rawIds.length < 1 || rawIds.length > MAX_SAVE_ITEMS) {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'The save request is malformed. Run a new scan and select subscriptions again.',
    });
  }
  const messageIds = [...new Set(rawIds.filter((id) => typeof id === 'string' && MESSAGE_ID_RE.test(id)))];
  if (messageIds.length < 1) {
    return res.status(400).json({
      error: 'invalid_request',
      message: 'The save request has no valid message selections.',
    });
  }

  // ---- Reference resolution (owner-bound, TTL-checked) --------------------
  const entry = resolveScanReference(scanRef, googleSub);
  if (!entry) {
    // Distinguish the three failure modes for the server log only — the client
    // always gets ONE sanitized code with no oracle (no existence leak).
    const existsForAccount = resolveScanReference(scanRef, googleSub, 0);
    if (existsForAccount) {
      console.warn('[POST /scan/save] scan_expired: ref was valid but has expired');
    } else {
      // Either not in cache at all, or belongs to a different account — logged
      // as one bucket to avoid an existence oracle even in server logs.
      console.warn('[POST /scan/save] scan_expired: ref not found or account mismatch');
    }
    return res.status(409).json({
      error: 'scan_expired',
      message: 'This scan can no longer be saved because its saving window has expired. Run a new Scan Now and select subscriptions again.',
    });
  }

  const result = { saved: [], alreadySaved: [], failed: [] };

  for (const messageId of messageIds) {
    const dto = entry.candidates.get(messageId);
    if (!dto) {
      result.failed.push({ sourceMessageId: messageId, reason: REASONS.not_in_scan });
      continue;
    }

    // Re-validate even though the cache was whitelisted at scan time —
    // a server-issued reference can never bypass validation (correction 1).
    const check = validateCandidate(dto);
    if (!check.ok) {
      result.failed.push({ sourceMessageId: messageId, reason: REASONS.invalid_fields });
      continue;
    }

    const row = candidateToRow(check.value, googleSub);
    try {
      const { data, error } = await supabase.from('subscriptions').insert(row).select();
      if (error) throw error;
      if (data && data.length > 0) {
        result.saved.push(savedRowToClient(data[0]));
      } else {
        // Defensive: an insert that reported success but returned nothing.
        result.alreadySaved.push(messageId);
      }
    } catch (err) {
      // PostgREST unique_violation on (owner_sub, source_message_id) — the
      // approved race-safe duplicate referee: the same scan message can never
      // produce a second row, whichever request wins the race.
      if (err && err.code === '23505') {
        result.alreadySaved.push(messageId);
        continue;
      }
      console.error('[POST /scan/save] insert failed (details suppressed):', err.message);
      result.failed.push({ sourceMessageId: messageId, reason: REASONS.db_error });
    }
  }

  // Per-item truth (approved correction 7): 200 even when nothing was saved —
  // the UI reconciles counts; failed selections stay available for retry.
  return res.json(result);
});

module.exports = router;
