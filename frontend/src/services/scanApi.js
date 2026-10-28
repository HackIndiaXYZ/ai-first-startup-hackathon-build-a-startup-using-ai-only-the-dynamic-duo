/**
 * Scan service layer — TrialGuard Phase 3B CP4 (frontend).
 *
 * Talks to the CP2/CP3 backend endpoint over the same-origin Vite proxy:
 *
 *   POST /api/scan → { scannedAt, windowDays, messagesListed,
 *                      messagesDeduped, messagesThreads, messagesSelected,
 *                      messagesInspected, partial?, candidates: [...] }
 *
 * The request is manual-only (the "Scan Now" button) — nothing here scans
 * automatically, on a schedule, or without the user's click. Saving (CP5) goes
 * through saveApi.saveSelected(), which sends ONLY { scanRef, messageIds } —
 * candidate objects are never transmitted (the server resolves them from its
 * own server-issued scan reference).
 *
 * SECURITY: credentials: 'include' carries ONLY the signed HttpOnly session
 * cookie; no token, no session id, and no email bodies are ever available to
 * or through this module. Every candidate is re-whitelisted against a fixed
 * field list so unexpected server fields can never reach the render layer,
 * and missing values stay `null` (the UI renders "Unknown").
 */

const BASE_URL = '/api';

/** Backend sanitized error codes (scan.js) → user-facing reconnect-safe text. */
export const SCAN_ERROR_MESSAGES = {
  not_connected:
    'Connect Gmail before scanning. Use the "Connect Gmail" button above.',
  reconnect_required:
    'Your Gmail authorization has expired or was revoked. Please disconnect Gmail below and connect again, then run the scan.',
  token_expired:
    'Your Gmail authorization has expired or was revoked. Please disconnect Gmail below and connect again, then run the scan.',
  permission_denied:
    'Gmail denied this scan. Please disconnect Gmail below and connect again, making sure you allow read access, then try the scan once more.',
  rate_limited:
    'Gmail limited how quickly scans may run. Please wait a minute and try Scan Now again.',
  gmail_unavailable:
    'Gmail could not be reached for the scan. Please wait a moment and try Scan Now again.',
};

/** The exact candidate shape TrialGuard renders (whitelist). */
const CANDIDATE_FIELDS = [
  'sourceMessageId',
  'classification',
  'serviceName',
  'trialEndDate',
  'renewalDate',
  'invoiceDate',
  'cancellationDeadline',
  'paymentDeadline',
  'paymentIssueType',
  'price',
  'currency',
  'confidence',
];

/** Unknown strings never originate here — nulls do. Values are copied verbatim
    or coerced to null so the UI can consistently render "Unknown". */
function sanitizeCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const key of CANDIDATE_FIELDS) {
    const v = raw[key];
    out[key] = (typeof v === 'string' && v.length > 0) || (typeof v === 'number') ? v : null;
  }
  // Only meaningful classifications are ever displayed.
  if (!['trial', 'renewal', 'cancellation', 'receipt', 'payment_reminder'].includes(out.classification)) {
    return null;
  }
  // paymentIssueType is a controlled-vocabulary field (approved decision):
  // anything outside the three documented values renders as "Unknown" (null).
  if (!['payment_failed', 'payment_action_required', 'access_expiring'].includes(out.paymentIssueType)) {
    out.paymentIssueType = null;
  }
  if (!['high', 'medium', 'low'].includes(out.confidence)) out.confidence = null;
  // currency passes through verbatim; the UI renders "Unknown" when it is null.
  return out;
}

/**
 * Runs one manual read-only Gmail scan.
 * Resolves the sanitized preview DTO (never contains tokens or bodies).
 * Throws an Error whose `.code` mirrors the backend's sanitized code so the
 * UI can pick friendly guidance (reconnect vs. retry).
 */
export async function runScan() {
  let res;
  try {
    res = await fetch(`${BASE_URL}/scan`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
  } catch {
    const e = new Error('Could not reach TrialGuard services. Check that the backend is running.');
    e.code = 'network';
    throw e;
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const code = body && typeof body.error === 'string' ? body.error : 'network';
    const e = new Error(
      (body && typeof body.message === 'string' && body.message) ||
        SCAN_ERROR_MESSAGES[code] ||
        'The scan failed. Please wait a moment and try Scan Now again.'
    );
    e.code = code;
    throw e;
  }

  // Strict shape validation on the success envelope.
  if (!body || !Array.isArray(body.candidates)) {
    const e = new Error('The scan response was not recognized. Please try again.');
    e.code = 'network';
    throw e;
  }

  return {
    scannedAt: typeof body.scannedAt === 'string' ? body.scannedAt : null,
    windowDays: typeof body.windowDays === 'number' ? body.windowDays : 90,
    messagesListed: typeof body.messagesListed === 'number' ? body.messagesListed : null,
    messagesDeduped: typeof body.messagesDeduped === 'number' ? body.messagesDeduped : null,
    // Stage-split counts (approved detection-quality patch A): threads after
    // thread dedupe and the metadata-selected count (≤ retrieval caps) so the
    // UI can label each number accurately instead of deriving them.
    messagesThreads: typeof body.messagesThreads === 'number' ? body.messagesThreads : null,
    messagesSelected: typeof body.messagesSelected === 'number' ? body.messagesSelected : null,
    messagesInspected: typeof body.messagesInspected === 'number' ? body.messagesInspected : null,
    partial: body.partial === true,
    candidates: body.candidates.map(sanitizeCandidate).filter(Boolean),
    // CP5-A: opaque, server-issued save reference + expiry (informational
    // only). Null when the reference could not be issued — saving is simply
    // unavailable for that scan round.
    scanRef: typeof body.scanRef === 'string' && body.scanRef.length > 0 ? body.scanRef : null,
    scanRefExpiresAt:
      typeof body.scanRefExpiresAt === 'string' && body.scanRefExpiresAt.length > 0
        ? body.scanRefExpiresAt
        : null,
  };
}
