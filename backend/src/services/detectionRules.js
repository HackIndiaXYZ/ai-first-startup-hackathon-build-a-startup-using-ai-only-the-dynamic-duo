/**
 * detectionRules — TrialGuard Phase 3B CP1.
 *
 * Pure, dependency-free rule engine that turns one Gmail message
 * (metadata + snippet only — never a stored body) into a candidate
 * subscription detection. All heuristics are deterministic; anything not
 * clearly supported by the text stays `null` — nothing is invented.
 *
 * Amendments honored (approved plan + payment-reminder patch):
 *   - Invoice dates are NEVER converted into renewal dates; the five date
 *     categories (trial end / renewal / cancellation deadline / invoice /
 *     payment deadline) are extracted separately, driven by their
 *     surrounding context words. A payment deadline is NEVER a renewal,
 *     invoice or cancellation date.
 *   - Confidence uses the three calibrated categories high/medium/low
 *     (no fabricated numeric percentages).
 *   - Unknown = null. Missing message date → relative dates resolve to null.
 *
 * Input message shape:
 *   { subject: string, from: string, snippet: string, date: string|null }
 *     date = ISO 8601 string of the Gmail Date header, or null.
 * Output candidate shape:
 *   { classification: 'trial'|'renewal'|'cancellation'|'receipt'|
 *                     'payment_reminder'|'unknown',
 *     serviceName, trialEndDate, renewalDate, invoiceDate,
 *     cancellationDeadline, paymentDeadline,
 *     paymentIssueType: 'payment_failed'|'payment_action_required'|
 *                       'access_expiring'|null,
 *     price, currency,
 *     confidence: 'high'|'medium'|'low' }
 * All *_date values are `YYYY-MM-DD` strings or null.
 */

'use strict';

// ---------------------------------------------------------------------------
// Keyword banks (lowercase; matched against lowercased text)
// ---------------------------------------------------------------------------

const SUBJECT_TRIAL = [
  'free trial', 'trial ends', 'trial end', 'trial started', 'your trial',
  'trial expires', 'trial expiring', 'days free',
];
const TRIAL_CONTEXT = [
  'trial ends', 'trial end', 'trial expires', 'trial expiring', 'free until',
  'no charge until', 'trial will end', 'your trial ends', 'trial period',
  'free trial ends', 'trial converts',
];
const RENEWAL_CONTEXT = [
  'renews on', 'renews the', 'renews until', 'will renew', 'renewal date',
  'auto-renews', 'automatically renew', 'automatically renews', 'next billing',
  'renewed on', 'scheduled to renew', 'billing date', 'renews in',
];
const CANCEL_CONTEXT = [
  'cancel before', 'cancel by', 'cancelled by', 'canceled by',
  'cancellation deadline', 'to avoid charges', 'to avoid being charged',
  'must cancel', 'deadline to cancel', 'cancel on or before',
];
const INVOICE_CONTEXT = [
  'payment received', 'paid on', 'charged on', 'amount charged',
  'payment of', 'invoice date', 'transaction date', 'receipt for',
  'we received', 'you paid', 'charge of', 'receipt issued', 'payment confirmed',
  // Approved detection-quality patch B: billing SUBJECT phrasings. Only
  // multi-word, billing-specific forms — a bare "bill" or "statement" is
  // deliberately NOT an invoice signal (avoids classifying every generic
  // statement or a person named Bill as a subscription receipt).
  'your bill', 'bill from', 'bill for', 'billing statement', 'billing summary',
  'billed on', 'your receipt', 'invoice from',
];
// A price is accepted only when one of these appears within PRICE_WINDOW chars.
const PRICE_CONTEXT = [
  'per month', '/month', '/mo', 'monthly', 'per year', '/year', '/yr',
  'annually', 'then ', 'renew', 'billed', 'charged', 'charge of',
  'payment of', 'costs', 'after the trial', 'after your trial', 'starting',
  'due on', 'amount charged', 'total', 'on your bill',
];

// Approved payment-reminder patch (implemented plan): payment reminders,
// failed payments and subscription access expiration share ONE MVP
// classification (`payment_reminder`) but each concept keeps its own wording.
// All entries are conservative multi-word phrases — bare "reminder", "final
// reminder" or "update your account" is deliberately NOT a classification
// signal (a marketing "Final reminder: 20% off" must stay unknown).
const PAYMENT_HINTS = [
  'update your payment', 'update the payment', 'payment failed', 'failed payment',
  'payment declined', 'payment was declined', 'past due', 'payment reminder',
  'final payment reminder', 'access end', 'access expir', 'lose access',
  'lose your access', 'could not process your payment', 'payment did not go through',
];
// paymentIssueType evidence (approved decision #4) — three controlled values.
// The issue type reflects the PRIMARY ACTION the user must take; the
// access-expiry date is a consequence of that action, so when payment-action
// wording is explicit it outranks access-expiry wording (documented rule —
// see paymentIssueTypeOf).
const PAYMENT_FAILED_HINTS = [
  'payment failed', 'failed payment', 'payment declined', 'payment was declined',
  'payment did not go through', 'could not process your payment',
  'unable to process your payment', 'charge failed', 'payment attempt failed',
];
const PAYMENT_ACTION_HINTS = [
  'update your payment', 'update the payment', 'payment method', 'add a payment',
  'confirm your payment', 'retry payment', 'past due', 'payment is due',
  'payment due', 'payment reminder', 'final payment reminder', 'remitted',
];
const ACCESS_EXPIRY_HINTS = [
  'lose access', 'lose your access', 'access ends', 'access end', 'access expir',
  'will end access', 'no longer have access', 'keep access', 'retain access',
];
// A payment/access deadline date is supported ONLY by this context bank —
// it is never a renewal, invoice or cancellation date (correction #6).
const DEADLINE_CONTEXT = [
  'lose access', 'access end', 'access expir', 'your access ends',
  'update your payment', 'update the payment', 'payment method by',
  'pay by', 'pay before', 'payment due', 'payment is due', 'to keep access',
  'payment must be',
];
// Metadata-stage relevance probe (implemented correction #2): subject-only
// classification stays primary; subjects matching this bank that did NOT
// classify may receive ONE bounded further inspection (≤4 per scan, see
// gmailScanner) because payment/access reminders often phrase the subject
// loosely ("A final reminder about your account"). Bare "reminder" alone is
// excluded; "payment" is allowed here for the bounded probe only — it is a
// hint for spending one capped inspection, never a classification.
const INSPECTION_RELEVANCE_HINTS = [
  'final reminder', 'payment', 'access end', 'access expir', 'last chance',
  'action required', 'past due', 'expiration', 'expiring',
];

// Approved payment-reminder patch (implemented plan): explicit deterministic
// rank — clear cancellation deadlines first, then payment/access deadlines,
// then renewal notices, trials and finally receipts. Deadlines protect the
// user before informational notices.
const TIE_PRIORITY = ['cancellation', 'payment_reminder', 'renewal', 'trial', 'receipt'];

// Approved patch D: an email that INVITES the user to begin a free trial is
// not evidence of an already-decided trial. Such subjects ("Start your free
// trial today") are never represented as confirmed active subscriptions.
const TRIAL_INVITATION = [
  'start your', 'start a', 'get started', 'try free', 'try it free',
  'free trial today', 'days free', 'claim your', 'get your free',
  'sign up for', 'sign up to', 'start with a',
];
// Subject evidence that a trial is ALREADY decided/active (overrides the
// invitation guard).
const ACTIVE_TRIAL_SUBJECT = ['your trial', 'trial ends', 'trial started',
  'trial has started', 'trial period'];

// ---------------------------------------------------------------------------
// Regex banks
// ---------------------------------------------------------------------------

// Absolute dates. Output always normalized to YYYY-MM-DD.
const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};
const MON = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const ABS_DATE_PATTERNS = [
  { re: new RegExp(`\\b(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,|,?\\s)+\\s*(\\d{4})\\b`, 'gi'), order: 'mdy' },   // March 3, 2027
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MON})\\b\\.?(?:,?\\s+(\\d{4})\\b)?`, 'gi'), order: 'dmy' }, // 3 March 2027 / 3 March
  { re: /\b(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\b/g, order: 'iso' },   // 2027-03-03 / 2027/03/03
  { re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, order: 'us' },          // 3/3/2027
];
// Month/day without a year (year inferred — never before the anchor date).
const ABS_DATE_NO_YEAR = new RegExp(`\\b(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'); // March 3
const NUM_DATE_NO_YEAR = /\b(\d{1,2})\/(\d{1,2})\b/g;                                          // 3/3

// Relative dates: "in 14 days", "within 30 days", "2 months from now".
const REL_DATE_RE = /\b(?:in|within|after)\s+(?:about\s+|approx(?:imately)?\s+)?(\d{1,3})\s+(day|days|week|weeks|month|months)\b(?:\s+from\s+(?:today|now))?/gi;

// Prices: $12.99, $1,299.00, €9,99, £49, 12.99 USD, USD 12.99.
const PRICE_RE =
  /(?:(usd|eur|gbp)\s*(\d{1,4}(?:[.,]\d{3})*[.,]\d{2})|([$£€])\s*(\d{1,4}(?:[.,]\d{3})*[.,]\d{2})|(\d{1,4}(?:[.,]\d{3})*[.,]\d{2})\s*(usd|eur|gbp))/gi;

const MAX_REASONABLE_YEAR = 2100;
const CONTEXT_WINDOW = 60;  // chars looked at around a date match
const PRICE_WINDOW = 40;    // chars looked at around a price match

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reads a keyword-bank hit near position `at` inside `lower` text. */
function keywordInWindow(lower, at, bank, window) {
  const lo = Math.max(0, at - window);
  const hi = Math.min(lower.length, at + window);
  const piece = lower.slice(lo, hi);
  return bank.some((k) => piece.includes(k));
}

function pad2(n) { return String(n).padStart(2, '0'); }

function makeYmd(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 2000 || y > MAX_REASONABLE_YEAR || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null; // e.g. Feb 30
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Parse an ISO-8601-ish input to a UTC date, or null. */
function parseIsoDateOrStart(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/);
  if (m) return makeYmd(m[1], m[2], m[3]) ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : null;
}

function addDays(date, n) {
  return new Date(date.getTime() + n * 86400_000);
}
function addMonths(date, n) {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + n);
  return d;
}
function ymdOf(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** Normalizes a price string like `1,299.00` or `9,99` — returns a number. */
function parsePriceNumber(numStr) {
  let s = numStr;
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/,/g, '');               // 1,299.00 → 1299.00
  } else if (s.includes(',') && !s.includes('.')) {
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length <= 2) s = s.replace(',', '.'); // 9,99 → 9.99
    else s = s.replace(/,/g, '');          // 1,299 → 1299 (comma as thousands)
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n < 100000 ? n : null; // payments ≤ 10k/locale mojibake rejected
}

function currencyOf(codeOrSymbol) {
  switch (codeOrSymbol) {
    case 'usd': case '$': return 'USD';
    case 'eur': case '€': return 'EUR';
    case 'gbp': case '£': return 'GBP';
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Scores keyword banks against subject (weight 3) and body (weight 1). */
function classificationOf(subjectLower, bodyLower) {
  function bankScore(bank) {
    // Patch C integrity: one keyword occurrence = one contribution, and a
    // keyword fully contained inside ANOTHER matched keyword of the same bank
    // is subsumed (longest match wins). Otherwise nested entries like
    // 'trial end' + 'trial ends' both hit the same text and inflate a bank's
    // score, breaking the deterministic tie-break.
    const hits = [];
    for (const k of bank) {
      const w = subjectLower.includes(k) ? 3 : bodyLower.includes(k) ? 1 : 0;
      if (w) hits.push({ k, w });
    }
    const distinct = hits.filter(({ k }) =>
      !hits.some(({ k: o }) => o !== k && o.length > k.length && o.includes(k))
    );
    return distinct.reduce((s, h) => s + h.w, 0);
  }
  const scores = {
    trial: bankScore(SUBJECT_TRIAL),
    cancellation: bankScore(CANCEL_CONTEXT),
    renewal: bankScore(RENEWAL_CONTEXT),
    receipt: bankScore(INVOICE_CONTEXT),
    payment_reminder: bankScore(PAYMENT_HINTS),
  };
  // Approved patch C — deterministic ranking: highest score wins; on a tie,
  // explicit deadline-first priority (cancellation → renewal → trial →
  // receipt) replaces object-key order. Weak overlapping evidence (both
  // scores < 4) stays `unknown` — genuinely ambiguous email is never forced
  // into a category.
  let bestScore = 0;
  let winners = [];
  for (const [k, v] of Object.entries(scores)) {
    if (v > bestScore) { bestScore = v; winners = [k]; }
    else if (v === bestScore && v > 0) winners.push(k);
  }
  if (bestScore === 0) return { classification: 'unknown', subjectKeyword: false, tieOrWeak: true };
  if (winners.length > 1) {
    if (bestScore < 4) return { classification: 'unknown', subjectKeyword: false, tieOrWeak: true };
    winners.sort((a, b) => TIE_PRIORITY.indexOf(a) - TIE_PRIORITY.indexOf(b));
  }
  const classification = winners[0];
  return { classification, subjectKeyword: subjectHas(subjectLower, classification), tieOrWeak: winners.length > 1 };
}

function subjectHas(subjectLower, classification) {
  const banks = {
    trial: SUBJECT_TRIAL,
    cancellation: CANCEL_CONTEXT,
    renewal: RENEWAL_CONTEXT,
    receipt: INVOICE_CONTEXT,
    payment_reminder: PAYMENT_HINTS,
  };
  return (banks[classification] || []).some((k) => subjectLower.includes(k));
}

/**
 * True when a text visibly contains any date-like pattern (absolute, written
 * month-day, numeric or relative). Ranking evidence ONLY — the scanner uses
 * it to give subject-deadline-bearing messages priority for the bounded
 * snippet reads ("explicit deadline evidence" before classification order).
 */
function hasDateEvidence(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const probes = [
    ...ABS_DATE_PATTERNS.map((p) => p.re),
    ABS_DATE_NO_YEAR,
    NUM_DATE_NO_YEAR,
    REL_DATE_RE,
  ];
  for (const re of probes) {
    re.lastIndex = 0;
    const hit = re.test(text);
    re.lastIndex = 0;
    if (hit) return true;
  }
  return false;
}

/**
 * Metadata-stage relevance probe for bounded further inspection. Returns
 * true when a subject that did NOT classify may still be a payment/failed
 * payment/access-expiry reminder phrased loosely ("A final reminder about
 * your account"). This NEVER classifies by itself — the scanner spends at
 * most one bounded snippet read (≤4/scan) and the full extractSignatures
 * pass still has to classify decisively or the message is dropped.
 */
function subjectWarrantsInspection(subjectLower) {
  if (typeof subjectLower !== 'string' || subjectLower.length === 0) return false;
  return INSPECTION_RELEVANCE_HINTS.some((k) => subjectLower.includes(k));
}

/**
 * paymentIssueType — deterministic rule (approved decision #4):
 *   1. payment_failed            when failed/declined-payment evidence exists.
 *   2. payment_action_required   when explicit payment-action wording exists
 *                                (update payment method, past due, reminder
 *                                to add/confirm/retry a payment). Access
 *                                loss that stems from such an action is the
 *                                CONSEQUENCE — the action is what the user
 *                                must take, so it wins.
 *   3. access_expiring           when only access-expiry wording exists.
 *   4. null otherwise (never guessed).
 * Evidence may come from subject OR snippet; the family priority above —
 * not the source — decides. `payment_reminder` classification banks are a
 * subset of the union of the three type banks, so every classified
 * payment_reminder has an explicit type; null can only appear for a message
 * that is not classified as payment_reminder at all.
 */
function paymentIssueTypeOf(subjectLower, bodyLower) {
  const text = `${subjectLower}\n${bodyLower || ''}`;
  if (PAYMENT_FAILED_HINTS.some((k) => text.includes(k))) return 'payment_failed';
  if (PAYMENT_ACTION_HINTS.some((k) => text.includes(k))) return 'payment_action_required';
  if (ACCESS_EXPIRY_HINTS.some((k) => text.includes(k))) return 'access_expiring';
  return null;
}

// ---------------------------------------------------------------------------
// Date extraction (context-driven; bill categories stay separate)
// ---------------------------------------------------------------------------

function contextDistance(lower, at, bank) {
  const lo = Math.max(0, at - CONTEXT_WINDOW);
  const hi = Math.min(lower.length, at + CONTEXT_WINDOW);
  const piece = lower.slice(lo, hi);
  let best = Infinity;
  for (const k of bank) {
    let i = piece.indexOf(k);
    while (i !== -1) {
      best = Math.min(best, Math.abs(i + lo - at));
      i = piece.indexOf(k, i + 1);
    }
  }
  return best;
}

/**
 * Nearest keyword bank around position `at` — returns {category, distance}.
 * Equidistant hits fall back to CATEGORY_PRIORITY (cancellation beats trial
 * beats renewal beats invoice — deadlines protect the user first).
 */
const CATEGORY_PRIORITY = ['cancellation', 'payment', 'trial', 'renewal', 'invoice'];

function dateCategory(lower, at) {
  const candidates = [
    { category: 'cancellation', bank: CANCEL_CONTEXT },
    { category: 'payment', bank: DEADLINE_CONTEXT },
    { category: 'trial', bank: TRIAL_CONTEXT },
    { category: 'renewal', bank: RENEWAL_CONTEXT },
    { category: 'invoice', bank: INVOICE_CONTEXT },
  ]
    .map((c) => ({ ...c, distance: contextDistance(lower, at, c.bank) }))
    .filter((c) => Number.isFinite(c.distance));
  if (candidates.length === 0) return { category: null, distance: Infinity }; // unsupported → discarded
  candidates.sort((a, b) =>
    a.distance - b.distance || CATEGORY_PRIORITY.indexOf(a.category) - CATEGORY_PRIORITY.indexOf(b.category)
  );
  return { category: candidates[0].category, distance: candidates[0].distance };
}

/** Collects classified absolute + relative dates from one piece of text. */
function datesInText(text, anchorDate, fromSubject) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const found = [];

  const push = (ymd, at) => {
    if (!ymd) return;
    const { category, distance } = dateCategory(lower, at);
    if (!category) return;
    found.push({ ymd, category, distance, fromSubject });
  };

  for (const p of ABS_DATE_PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      const at = m.index;
      let ymd = null;
      if (p.order === 'iso' || p.order === 'us') {
        const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
        ymd = p.order === 'iso' ? makeYmd(a, b, c) : makeYmd(c, b, a);
      } else {
        const month = MONTHS[m[p.order === 'mdy' ? 1 : 2].toLowerCase()];
        const day = Number(p.order === 'mdy' ? m[2] : m[1]);
        const year = p.order === 'mdy' ? m[3] : m[3]; // both carry year group per regex
        ymd = year ? makeYmd(year, month, day) : null;
      }
      push(ymd, at);
    }
    p.re.lastIndex = 0;
  }

  // Month/day without year: infer a year that never lands before the anchor.
  {
    ABS_DATE_NO_YEAR.lastIndex = 0;
    let m;
    while ((m = ABS_DATE_NO_YEAR.exec(text)) !== null) {
      const month = MONTHS[m[1].toLowerCase()];
      const day = Number(m[2]);
      const baseYear = anchorDate ? anchorDate.getUTCFullYear() : new Date().getUTCFullYear();
      let ymd = makeYmd(baseYear, month, day);
      if (ymd && anchorDate && new Date(`${ymd}T00:00:00Z`).getTime() < anchorDate.getTime()) {
        ymd = makeYmd(baseYear + 1, month, day);
      }
      push(ymd, m.index);
    }
    ABS_DATE_NO_YEAR.lastIndex = 0;
  }
  {
    NUM_DATE_NO_YEAR.lastIndex = 0;
    let m;
    while ((m = NUM_DATE_NO_YEAR.exec(text)) !== null) {
      const month = Number(m[1]);
      const day = Number(m[2]);
      const baseYear = anchorDate ? anchorDate.getUTCFullYear() : new Date().getUTCFullYear();
      let ymd = makeYmd(baseYear, month, day);
      if (ymd && anchorDate && new Date(`${ymd}T00:00:00Z`).getTime() < anchorDate.getTime()) {
        ymd = makeYmd(baseYear + 1, month, day);
      }
      push(ymd, m.index);
    }
    NUM_DATE_NO_YEAR.lastIndex = 0;
  }

  // Relative dates need an anchor (the message's Date header). Without one
  // they resolve to null — never an invented "today" guess.
  if (anchorDate) {
    REL_DATE_RE.lastIndex = 0;
    let m;
    while ((m = REL_DATE_RE.exec(text)) !== null) {
      const n = Number(m[1]);
      const unit = m[2].replace(/s$/, '');
      let ymd = null;
      if (unit === 'day') ymd = ymdOf(addDays(anchorDate, n));
      else if (unit === 'week') ymd = ymdOf(addDays(anchorDate, n * 7));
      else if (unit === 'month') ymd = ymdOf(addMonths(anchorDate, n));
      push(ymd, m.index);
    }
    REL_DATE_RE.lastIndex = 0;
  }

  return found;
}

/**
 * Extracts the four date categories. Invariant (approved amendment #2): one
 * physical date supports AT MOST ONE category — the claim wins that has the
 * strongest source (subject beats body), tie-broken by nearest context
 * keyword distance. Per CATEGORY, the single best claim (subject first, then
 * most specific context) supplies the value; an invoice context can therefore
 * never upgrade a date into `renewalDate` and vice versa, and vague body
 * mentions ("trial period started") never beat a precise subject claim
 * ("trial ends in 14 days").
 */
function extractDates(subject, snippet, anchorDate) {
  const claims = [...datesInText(subject, anchorDate, true), ...datesInText(snippet, anchorDate, false)];

  const out = { trialEndDate: null, renewalDate: null, invoiceDate: null, cancellationDeadline: null, paymentDeadline: null };
  const key = {
    trial: 'trialEndDate',
    renewal: 'renewalDate',
    invoice: 'invoiceDate',
    cancellation: 'cancellationDeadline',
    payment: 'paymentDeadline',
  };

  // Per category, keep only the strongest claim seen so far:
  // sort key = (subject rank, context distance) ascending.
  const bestPerCategory = new Map();
  for (const c of claims) {
    const rank = c.fromSubject ? 0 : 1;
    const prev = bestPerCategory.get(c.category);
    if (!prev || rank < prev.rank || (rank === prev.rank && c.distance < prev.distance)) {
      bestPerCategory.set(c.category, { ymd: c.ymd, rank, distance: c.distance });
    }
  }

  for (const [category, best] of bestPerCategory) {
    const field = key[category];
    if (field) out[field] = best.ymd;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Price extraction
// ---------------------------------------------------------------------------

function extractPrice(subject, snippet) {
  const text = `${subject}\n${snippet}`;
  if (!text) return { price: null, currency: null, conflicts: false };
  let best = null; // {price, currency, distance}
  let distinct = new Set();

  PRICE_RE.lastIndex = 0;
  let m;
  const lower = text.toLowerCase();
  while ((m = PRICE_RE.exec(text)) !== null) {
    const code = m[1] || m[6]; // textual ISO code
    const sym = m[3];          // symbol
    const numStr = m[2] || m[4] || m[5];
    const currency = currencyOf((code || sym || '').toLowerCase());
    if (!currency) continue;
    const price = parsePriceNumber(numStr);
    if (price === null) continue;
    const at = m.index;
    if (!keywordInWindow(lower, at, PRICE_CONTEXT, PRICE_WINDOW)) continue; // unsupported → discarded
    distinct.add(price);
    const distance = contextDistance(lower, at, PRICE_CONTEXT);
    if (!best || distance < best.distance) best = { price, currency, distance };
  }
  PRICE_RE.lastIndex = 0;

  return {
    price: best ? best.price : null,
    currency: best ? best.currency : null,
    conflicts: distinct.size > 1,
  };
}

/** Distance (chars) from `at` to the nearest supporting keyword. */
function contextDistance(lower, at, bank) {
  const lo = Math.max(0, at - PRICE_WINDOW);
  const hi = Math.min(lower.length, at + PRICE_WINDOW);
  const piece = lower.slice(lo, hi);
  let best = Infinity;
  for (const k of bank) {
    let i = piece.indexOf(k);
    while (i !== -1) {
      best = Math.min(best, Math.abs(i + lo - at));
      i = piece.indexOf(k, i + 1);
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Service-name extraction
// ---------------------------------------------------------------------------

const STRIP_TOKENS = new Set([
  'no-reply', 'noreply', 'no_reply', 'donotreply', 'do-not-reply', 'reply',
  'billing', 'team', 'support', 'account', 'newsletter', 'notifications',
  'notification', 'mailer', 'membership', 'payments', 'receipts', 'info',
  'hello', 'mail', 'email', 'news', 'services', 'service', 'updates', 'update',
  'product', 'alerts', 'alert', 'group', 'inc', 'llc', 'ltd', 'goo', 'google',
]);
const SENT_WORD_RE = /[a-z][a-z'’&./-]*/g;

/** Tries to get a human service/company name from the From field. */
function extractServiceName(from) {
  if (!from || typeof from !== 'string') return null;

  const dnMatch = from.match(/^(?:"?([^"<]*?)"?)?\s*<[^>]+>$/);
  const displayName = dnMatch ? dnMatch[1].trim() : from.split('<')[0].trim();
  const emailMatch = from.match(/<([^>]+)>/) || (from.includes('@') ? [null, from.split('@')[0]] : [null, null]);
  const local = emailMatch[1] ? emailMatch[1].split('@')[0] : (from.includes('@') ? from.split('@')[0] : null);
  const domain = from.match(/@([A-Za-z0-9.-]+)/);
  const domainName = domain ? domain[1].toLowerCase() : null;

  // 1) Display name: an EXPLICIT display name (<...> headers or a header
  //    without an @) is trusted; a bare address must fall through to the
  //    domain parser instead. Original casing is kept ("NoteNest").
  const realDisplayName = (dnMatch && dnMatch[1]) || (from && !from.includes('@'));
  if (realDisplayName && displayName) {
    const wordRe = /[A-Za-z][A-Za-z0-9'‘’&-]*/g;
    const rawWords = displayName.match(wordRe) || [];
    const words = rawWords.filter((w) => {
      const lw = w.toLowerCase();
      return w.length > 1 && !STRIP_TOKENS.has(lw) && !w.includes('@') && !/\d/.test(w);
    });
    if (words.length >= 1 && words.join(' ').length >= 3) {
      return words.join(' ');
    }
  }

  // 2) Domain core: skip host prefixes (www/mail/smtp/email/etc.) and TLDs.
  if (domainName) {
    const labels = domainName.replace(/^https?:\/\//, '').split('.').filter(Boolean);
    const hostPrefixes = new Set(['www', 'mail', 'smtp', 'email', 'info', 'billing', 'notify', 'notifications', 'go', 'links', 'tracking', 'mt', 'mx']);
    for (let i = labels.length - 2; i >= 0; i -= 1) {
      const label = labels[i];
      if (hostPrefixes.has(label)) continue;
      if (/^[a-z][a-z0-9-]{2,}$/.test(label)) {
        return titleCase(label.replace(/[-_]/g, ' '));
      }
    }
  }

  // 3) Local part as last resort: billing@opencorecrm.com → Opencorecrm.
  if (local && /^[a-zA-Z][a-zA-Z.'-]{2,}$/.test(local) && !STRIP_TOKENS.has(local.toLowerCase())) {
    return titleCase(local.replace(/[._-]+/g, ' ').trim());
  }
  return null;
}

function titleCase(s) {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * @param {{ subject: string, from: string, snippet: string, date: string|null,
 *           body?: string }} message
 *   body — optional decoded plain text from the message body (messageBody.decodeBody).
 *   When absent, snippet is used for all extraction (identical to previous behaviour).
 *   When present, body is used ONLY for extractDates and extractPrice; classificationOf
 *   and paymentIssueTypeOf remain on the snippet so classification thresholds are unchanged.
 */
function extractSignatures(message) {
  const subject = typeof message?.subject === 'string' ? message.subject : '';
  const from = typeof message?.from === 'string' ? message.from : '';
  const snippet = typeof message?.snippet === 'string' ? message.snippet : '';
  //body part: use decoded body for date/price extraction when provided; fall back to snippet
  const bodyForExtraction = (typeof message?.body === 'string' && message.body.length > 0)
    ? message.body
    : snippet;
  const anchorDate = message?.date ? parseIsoDateOrStart(message.date) : null;

  const subjectLower = subject.toLowerCase();
  const bodyLower = snippet.toLowerCase();
  let classified = classificationOf(subjectLower, bodyLower);

  // Approved patch D — promotional-invitation guard. A subject that merely
  // INVITES the user to begin a trial ("Start your free trial today", "Get
  // 30 days free") is not evidence of an already-decided trial. Unless the
  // subject itself carries explicit active-trial evidence, the message is
  // suppressed (never emitted as a confirmed active subscription); dates and
  // prices stay null-for-unknown either way.
  if (classified.classification === 'trial' &&
      TRIAL_INVITATION.some((p) => subjectLower.includes(p)) &&
      !ACTIVE_TRIAL_SUBJECT.some((p) => subjectLower.includes(p))) {
    classified = { classification: 'unknown', subjectKeyword: false, tieOrWeak: true };
  }
  const { classification, subjectKeyword } = classified;

  const serviceName = extractServiceName(from);
  //body part: extractDates and extractPrice use the richer body text when available
  const dates = extractDates(subject, bodyForExtraction, anchorDate);
  const { price, currency, conflicts } = extractPrice(subject, bodyForExtraction);

  // Approved payment-reminder patch: the issue type is extracted only for
  // classified payment_reminder candidates — never guessed for other
  // classifications or for unknown (corrections #4/#7).
  const paymentIssueType = classification === 'payment_reminder'
    ? paymentIssueTypeOf(subjectLower, bodyLower)
    : null;

  // Confidence calibration (high / medium / low):
  //   high   — classified keyword in the SUBJECT and ≥2 structural facts
  //            (service name, any date, price) all agree.
  //   medium — subject keyword + 1 fact, or a strong body-only signal + ≥1 fact.
  //   low    — ambiguous/weak classification or almost nothing extracted.
  const facts = [serviceName && 'name', Object.values(dates).some(Boolean) && 'date', price !== null && 'price'].filter(Boolean);
  const factCount = facts.length;
  const hasDateFact = facts.includes('date');
  let confidence = 'low';
  if (!conflicts && classification !== 'unknown') {
    // HIGH needs the classification keyword in the subject, ≥2 structural
    // facts, and at least one DATE — dates are the core value of a detection;
    // confidence must not read high when the timeline is missing.
    if (subjectKeyword && factCount >= 2 && hasDateFact) confidence = 'high';
    else if (subjectKeyword && factCount >= 1) confidence = 'medium';
    else if (factCount >= 1) confidence = 'medium';
  }
  if (conflicts) confidence = 'low'; // conflicting amounts → human must review
  // Approved patch D — receipt floor: a receipt with NO invoice date and NO
  // supported price is never medium or high solely from its service name and
  // subject keyword; amounts and timelines are what receipts are for.
  if (classification === 'receipt' && dates.invoiceDate == null && price == null) {
    confidence = 'low';
  }
  // Approved payment-reminder patch: HIGH stays available when there is
  // strong explicit evidence (subject keyword + name/date facts), but the
  // confidence value must never imply a confirmed renewal or charge —
  // renewalDate is set ONLY by renewal-context extraction and a known
  // payment deadline implies nothing about a charge (corrections #3/#6).

  return {
    classification,
    serviceName: serviceName || null,
    trialEndDate: dates.trialEndDate || null,
    renewalDate: dates.renewalDate || null,
    invoiceDate: dates.invoiceDate || null,
    cancellationDeadline: dates.cancellationDeadline || null,
    paymentDeadline: dates.paymentDeadline || null,
    paymentIssueType,
    price: price ?? null,
    currency: currency || null,
    confidence,
  };
}

module.exports = {
  extractSignatures,
  classificationOf,
  extractDates,
  extractPrice,
  extractServiceName,
  parsePriceNumber,
  makeYmd,
  parseIsoDateOrStart,
  hasDateEvidence,
  subjectWarrantsInspection,
  paymentIssueTypeOf,
};
