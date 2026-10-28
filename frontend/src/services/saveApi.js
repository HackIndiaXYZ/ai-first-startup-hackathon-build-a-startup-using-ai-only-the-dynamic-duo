/**
 * Save service layer — TrialGuard Phase CP5-C (frontend).
 *
 *   POST /api/scan/save → { saved: [...], alreadySaved: [...], failed: [...] }
 *
 * SECURITY (approved correction 1): the ONLY things ever sent are the opaque
 * server-issued scan reference and the selected message ids. Candidate
 * objects, ownership identifiers, and any other fields are never transmitted
 * — the backend resolves candidates from its own server-side cache and
 * derives ownership from the verified session.
 *
 * FAILED selections stay selected in the UI (useScanNow clears only ids the
 * backend reported as saved/alreadySaved), so a partial failure is always
 * retryable without re-selecting anything.
 */

const BASE_URL = '/api';

/** Backend sanitized save error codes → user-facing text. */
export const SAVE_ERROR_MESSAGES = {
  scan_expired:
    'This scan can no longer be saved because its saving window has expired. Run a new Scan Now, then select and save again.',
};

/** Whitelist of exactly one candidate's worth of row DTO fields (backend). */
const SAVED_ROW_FIELDS = [
  'id',
  'sourceMessageId',
  'serviceName',
  'planName',
  'trialStartDate',
  'trialEndDate',
  'price',
  'currency',
  'status',
  'cancellationUrl',
  'source',
  'renewalDate',
  'paymentDeadline',
  'paymentIssueType',
  'invoiceDate',
  'cancellationDeadline',
];

function sanitizeRow(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const row = {};
  for (const key of SAVED_ROW_FIELDS) row[key] = raw[key];
  return row;
}

/**
 * Saves the selected candidates against a scan reference.
 * Resolves to a per-item truth object; throws only for whole-request
 * failures (auth, expired reference, malformed request, network).
 * @param {string} scanRef opaque server reference (from runScan())
 * @param {string[]} messageIds selected candidate ids (caller dedupes)
 */
export async function saveSelected(scanRef, messageIds) {
  if (typeof scanRef !== 'string' || scanRef.length === 0) {
    const e = new Error('This scan cannot be saved right now — run a new Scan Now first.');
    e.code = 'scan_expired';
    throw e;
  }

  let res;
  try {
    res = await fetch(`${BASE_URL}/scan/save`, {
      method: 'POST',
      credentials: 'include', // signed HttpOnly session cookie ONLY
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ scanRef, messageIds: [...messageIds] }),
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
        SAVE_ERROR_MESSAGES[code] ||
        'Saving failed. Please wait a moment and try again.'
    );
    e.code = code;
    throw e;
  }

  if (!body || !Array.isArray(body.saved) || !Array.isArray(body.alreadySaved) || !Array.isArray(body.failed)) {
    const e = new Error('The save response was not recognized. Please try again.');
    e.code = 'network';
    throw e;
  }

  return {
    saved: body.saved.map(sanitizeRow).filter(Boolean),
    alreadySaved: body.alreadySaved.filter((id) => typeof id === 'string'),
    failed: body.failed.filter(
      (f) => f && typeof f.sourceMessageId === 'string' && typeof f.reason === 'string'
    ),
  };
}
