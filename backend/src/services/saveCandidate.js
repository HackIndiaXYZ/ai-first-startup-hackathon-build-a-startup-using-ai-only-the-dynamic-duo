/**
 * saveCandidate — TrialGuard Phase CP5-B.
 *
 * Server-side validation + DTO→row builder for POST /api/scan/save
 * (approved corrections 1, 5, 6: never trust the client, never invent data,
 * store only the minimum management fields).
 *
 * INPUT: candidates only ever come from the server-side scan reference cache —
 * but they are validated again here so a cached reference can never bypass
 * validation.
 *
 * Every absent/unknown value stays NULL (UI renders "Unknown"); nothing is
 * defaulted, guessed, or fabricated to satisfy the database.
 */

const REASONS = {
  invalid_fields: 'invalid_fields',
  not_in_scan: 'not_in_scan',
  db_error: 'db_error',
};

const CLASSIFICATIONS = ['trial', 'renewal', 'cancellation', 'receipt', 'payment_reminder'];
const PAYMENT_ISSUE_TYPES = ['payment_failed', 'payment_action_required', 'access_expiring'];
const CONFIDENCES = ['high', 'medium', 'low'];

const SERVICE_NAME_MAX = 200;
// Gmail message ids are base64url-ish; keep shape strict but scanner-friendly.
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** "2026-02-30" fails; only real calendar dates in exactly this format pass. */
function isValidIsoDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= days;
}

/**
 * Validates one scanned candidate for saving.
 * @returns {{ ok: boolean, errors: string[]|null, value: object|null }}
 *   value: a fresh, whitelisted DTO (extra/unknown fields are dropped).
 */
function validateCandidate(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['not_an_object'], value: null };

  const out = { price: null, currency: null };
  out.sourceMessageId = raw.sourceMessageId;
  out.classification = raw.classification;
  out.serviceName = raw.serviceName;
  out.trialEndDate = raw.trialEndDate;
  out.renewalDate = raw.renewalDate;
  out.invoiceDate = raw.invoiceDate;
  out.cancellationDeadline = raw.cancellationDeadline;
  out.paymentDeadline = raw.paymentDeadline;
  out.paymentIssueType = raw.paymentIssueType;
  out.confidence = raw.confidence;
  out.price = raw.price;
  out.currency = raw.currency;

  if (typeof out.sourceMessageId !== 'string' || !MESSAGE_ID_RE.test(out.sourceMessageId)) {
    errors.push('sourceMessageId');
  }
  if (!CLASSIFICATIONS.includes(out.classification)) errors.push('classification');

  if (typeof out.serviceName !== 'string') {
    errors.push('serviceName');
  } else {
    out.serviceName = out.serviceName.trim();
    if (out.serviceName.length < 1 || out.serviceName.length > SERVICE_NAME_MAX) {
      errors.push('serviceName');
    }
  }

  for (const field of ['trialEndDate', 'renewalDate', 'invoiceDate', 'cancellationDeadline', 'paymentDeadline']) {
    if (out[field] != null && !isValidIsoDate(out[field])) errors.push(field);
  }

  if (out.paymentIssueType != null && !PAYMENT_ISSUE_TYPES.includes(out.paymentIssueType)) {
    errors.push('paymentIssueType');
  }
  if (out.confidence != null && !CONFIDENCES.includes(out.confidence)) errors.push('confidence');

  if (out.price != null) {
    if (typeof out.price !== 'number' || !Number.isFinite(out.price) || out.price < 0) {
      errors.push('price');
    }
  }
  if (out.currency != null && !(typeof out.currency === 'string' && CURRENCY_RE.test(out.currency))) {
    errors.push('currency');
  }

  if (errors.length > 0) return { ok: false, errors, value: null };
  return { ok: true, errors: null, value: out };
}

/**
 * Maps a validated candidate DTO to the subscriptions row (CP5 plan v2 §2/§5.1).
 * Absent data stays NULL — including plan_name, trial_start_date, price, and
 * currency (unknown currency is never defaulted to 'USD').
 * @param {object} dto validated DTO (validateCandidate().value)
 * @param {string} ownerSub verified session google_sub — server-side only
 */
function candidateToRow(dto, ownerSub) {
  return {
    service_name: dto.serviceName,
    plan_name: null, // scan DTO carries no plan name; never invented
    trial_start_date: null, // unknown — never fabricated
    trial_end_date: dto.trialEndDate ?? null,
    price: dto.price ?? null,
    currency: dto.currency ?? null, // NOT defaulted to 'USD' (approved D2)
    status: 'active', // constant, not data invention
    cancellation_url: null, // extraction is future scope
    owner_sub: ownerSub,
    source: 'scan',
    source_message_id: dto.sourceMessageId,
    renewal_date: dto.renewalDate ?? null,
    payment_deadline: dto.paymentDeadline ?? null,
    payment_issue_type: dto.paymentIssueType ?? null,
    invoice_date: dto.invoiceDate ?? null,
    cancellation_deadline: dto.cancellationDeadline ?? null,
  };
}

module.exports = {
  REASONS,
  validateCandidate,
  candidateToRow,
  isValidIsoDate,
};
