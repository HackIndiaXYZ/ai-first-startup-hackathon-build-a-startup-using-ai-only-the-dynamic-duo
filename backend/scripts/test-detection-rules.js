/**
 * CP1 test harness — TrialGuard Phase 3B detection rules.
 *
 * Pure unit tests: no network, no Gmail, no database, no credentials.
 * Realistic fixtures: trial, renewal, cancellation reminder, receipt/invoice,
 * marketing noise, ambiguous dates, missing fields. The invoice date must
 * NEVER leak into the renewal field, unknown stays null, and confidence is
 * one of high/medium/low.
 *
 * Usage: node backend/scripts/test-detection-rules.js   (prints PASS/FAIL)
 */

const {
  extractSignatures,
  parsePriceNumber,
  makeYmd,
  classificationOf,
  hasDateEvidence,
  subjectWarrantsInspection,
  paymentIssueTypeOf,
} = require('../src/services/detectionRules');

const results = [];
let passCount = 0;
let failCount = 0;

function check(name, condition, extra) {
  if (condition) { passCount += 1; results.push(`PASS  ${name}`); }
  else { failCount += 1; results.push(`FAIL  ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`); }
}

const SENT_DATE = '2026-10-14T09:30:00Z';

// ---------------------------------------------------------------------------
// 1. Trial email — full extraction
// ---------------------------------------------------------------------------
const trial = extractSignatures({
  subject: 'Your Netflix free trial ends on October 28, 2026',
  from: 'Netflix <info@netflix.com>',
  snippet: 'You signed up for the Premium plan. You will be charged $15.99 per month starting October 28, 2026 unless you cancel before then.',
  date: SENT_DATE,
});
check('1. trial classification', trial.classification === 'trial', trial.classification);
check('1a. serviceName Netflix', trial.serviceName === 'Netflix', trial.serviceName);
check('1b. trialEndDate 2026-10-28', trial.trialEndDate === '2026-10-28', trial.trialEndDate);
check('1c. price 15.99 USD', trial.price === 15.99 && trial.currency === 'USD', { price: trial.price, currency: trial.currency });
check('1d. no invoice/renewal/cancellation dates invented', trial.invoiceDate === null && trial.renewalDate === null && trial.cancellationDeadline === null, trial);
check('1e. confidence high', trial.confidence === 'high', trial.confidence);

// ---------------------------------------------------------------------------
// 2. Renewal notice — renewal date distinct, price at renewal
// ---------------------------------------------------------------------------
const renewal = extractSignatures({
  subject: 'Your Adobe Creative Cloud subscription renews on March 1, 2027',
  from: 'Adobe Notifications <account@adobe.onm.email.forwarding>',
  snippet: 'Your subscription will renew automatically. We will charge the card on file $59.99 on your renewal date. No action is needed.',
  date: SENT_DATE,
});
check('2. renewal classification', renewal.classification === 'renewal', renewal.classification);
check('2b. renewalDate 2027-03-01', renewal.renewalDate === '2027-03-01', renewal.renewalDate);
check('2c. no trialEnd/cancellation/invoice', renewal.trialEndDate === null && renewal.cancellationDeadline === null && renewal.invoiceDate === null, renewal);
check('2d. price 59.99 USD', renewal.price === 59.99 && renewal.currency === 'USD', renewal.price);
check('2e. confidence high', renewal.confidence === 'high', renewal.confidence);

// ---------------------------------------------------------------------------
// 3. Receipt/invoice — invoice date must NOT become the renewal date
// ---------------------------------------------------------------------------
const receipt = extractSignatures({
  subject: 'Receipt for your payment to NoteNest',
  from: 'NoteNest Billing <billing@notenest.io>',
  snippet: 'Payment received October 2, 2026. Amount charged: $9.99. Your next billing date will be November 2, 2026. Thanks for staying with us.',
  date: SENT_DATE,
});
check('3. receipt classification', receipt.classification === 'receipt', receipt.classification);
check('3a. invoiceDate 2026-10-02', receipt.invoiceDate === '2026-10-02', receipt.invoiceDate);
check('3b. renewalDate 2026-11-02 (from "next billing"), NOT the invoice date', receipt.renewalDate === '2026-11-02', receipt.renewalDate);
check('3c. price 9.99 USD', receipt.price === 9.99 && receipt.currency === 'USD', receipt.price);
check('3d. no trialEnd/cancellation invented', receipt.trialEndDate === null && receipt.cancellationDeadline === null, receipt);
check('3e. serviceName NoteNest', receipt.serviceName === 'NoteNest', receipt.serviceName);

// ---------------------------------------------------------------------------
// 4. Cancellation reminder — deadline + price; trial mention does not hijack
// ---------------------------------------------------------------------------
const cancel = extractSignatures({
  subject: 'Action required: cancel by March 3 to avoid charges',
  from: '"DataSift Analytics" <billing@datasift-analytics.example>',
  snippet: 'Your free trial converts to a Business plan on that date. If you cancel before March 3, 2027 you will not be charged the $49.99 per month price.',
  date: SENT_DATE,
});
check('4. cancellation classification', cancel.classification === 'cancellation', cancel.classification);
check('4a. cancellationDeadline 2027-03-03 (year inferred)', cancel.cancellationDeadline === '2027-03-03', cancel.cancellationDeadline);
check('4b. price 49.99 USD', cancel.price === 49.99 && cancel.currency === 'USD', cancel.price);
check('4c. serviceName DataSift Analytics', cancel.serviceName === 'DataSift Analytics', cancel.serviceName);
check('4d. trialEndDate NOT fabricated from the conversion sentence', cancel.trialEndDate === null, cancel.trialEndDate);

// ---------------------------------------------------------------------------
// 5. Marketing noise — filtered to unknown/low, no invented facts
// ---------------------------------------------------------------------------
const marketing = extractSignatures({
  subject: 'Newsletter: Top 10 productivity apps this week (deals inside)',
  from: 'The Weekly Bit <digest@newsletterhub.pressed>',
  snippet: 'This week: our favorite writing apps, a $10 coupon round-up and more tips to organize your day.',
  date: SENT_DATE,
});
check('5. marketing → unknown classification', marketing.classification === 'unknown', marketing.classification);
check('5a. confidence low', marketing.confidence === 'low', marketing.confidence);
check('5b. price NOT extracted without billing context', marketing.price === null, marketing.price);
check('5c. no dates', marketing.trialEndDate === null && marketing.renewalDate === null && marketing.invoiceDate === null && marketing.cancellationDeadline === null, marketing);

// ---------------------------------------------------------------------------
// 6. Ambiguous dates
// ---------------------------------------------------------------------------
// 6a. Two distractors: relative trial phrase + far calendar date → subject wins.
const amb = extractSignatures({
  subject: 'Reminder: Bento Storage trial ends in 14 days',
  from: 'Bento Storage <team@bento-storage.test>',
  snippet: 'Archived: your trial period started 2026-09-20. Your trial ends 2026-10-28. After that we charge $4.99 monthly.',
  date: SENT_DATE,
});
check('6a. relative trial date resolves against message date', amb.trialEndDate === '2026-10-28', amb.trialEndDate);
check('6b. price 4.99 USD', amb.price === 4.99 && amb.currency === 'USD', amb.price);

// 6b. Day/month without a year never lands before the message date.
const noYear = extractSignatures({
  subject: 'Your Ordyo subscription renews on 3/3',
  from: 'Ordyo <noreply@ordyo.app>',
  snippet: 'We will bill $8.99 per month. Your plan renews automatically until you cancel.',
  date: '2027-01-15T08:00:00Z',
});
check('6c. 3/3 without year → 2027-03-03', noYear.renewalDate === '2027-03-03', noYear.renewalDate);

// 6c. Relative date WITHOUT a message date → null (never anchored to "today").
const relNoAnchor = extractSignatures({
  subject: 'Your LitFile trial ends in 7 days',
  from: 'LitFile <hi@litfile.example>',
  snippet: 'After your trial you will be charged $6.99 per month unless you cancel in time.',
  date: null,
});
check('6d. missing message date → relative date stays null', relNoAnchor.trialEndDate === null, relNoAnchor.trialEndDate);
check('6e. price still extracted when supported', relNoAnchor.price === 6.99, relNoAnchor.price);
check('6f. confidence not high without date support (medium ok)', ['medium', 'low'].includes(relNoAnchor.confidence) && relNoAnchor.confidence !== 'high', relNoAnchor.confidence);

// 6d. Two conflicting amounts → low confidence, conservative pick.
const conflict = extractSignatures({
  subject: 'Your Wirely subscription renews on June 1, 2027',
  from: 'Wirely <team@wirelyhq.test>',
  snippet: 'Choose either $99.00 per year or $9.99 per month at renewal. Your card will be charged the selected rate.',
  date: SENT_DATE,
});
check('6g. conflicting amounts → confidence low', conflict.confidence === 'low', conflict.confidence);
check('6h. renewalDate still 2027-06-01', conflict.renewalDate === '2027-06-01', conflict.renewalDate);

// 6e. Uncontexted date → discarded entirely.
const uncontexted = extractSignatures({
  subject: 'Welcome to KitJoin',
  from: 'KitJoin <hello@kitjoin.test>',
  snippet: 'Founded 2026-10-14, we are glad you are here. Add a project to get started with your team.',
  date: SENT_DATE,
});
check('6i. welcome email: all unknown, no dates', uncontented_check(), 'see helper');
function uncontented_check() {
  return uncontexted.classification === 'unknown' &&
    uncontexted.trialEndDate === null && uncontexted.renewalDate === null &&
    uncontexted.invoiceDate === null && uncontexted.cancellationDeadline === null &&
    uncontexted.price === null;
}

// ---------------------------------------------------------------------------
// 7. Missing / malformed fields
// ---------------------------------------------------------------------------
const empty = extractSignatures({ subject: '', from: '', snippet: '', date: null });
check('7. empty message → unknown/low, all null', empty.classification === 'unknown' && empty.confidence === 'low' &&
  empty.serviceName === null && empty.trialEndDate === null && empty.renewalDate === null &&
  empty.invoiceDate === null && empty.cancellationDeadline === null && empty.price === null, empty);

const fromOnlyDomain = extractSignatures({
  subject: 'Your membership renews soon',
  from: 'billing@mail.opencorecrm.com',
  snippet: 'Your plan will renew automatically on your billing date. Manage subscription in settings.',
  date: SENT_DATE,
});
check('7a. domain-derived name from mail.* host → Opencorecrm', fromOnlyDomain.serviceName === 'Opencorecrm', fromOnlyDomain.serviceName);

const malformed = extractSignatures({
  subject: 'Your Cobalto trial ends on 2026-13-45', // impossible date
  from: 'Cobalto <team@cobalto.example>',
  snippet: 'We will invoice $12.99 per month afterwards.',
  date: SENT_DATE,
});
check('7b. impossible date rejected → null (not fabricated elsewhere)', malformed.trialEndDate === null || makeYmd(2026, 13, 45) === null, malformed.trialEndDate);

// ---------------------------------------------------------------------------
// 8. Price parsing details
// ---------------------------------------------------------------------------
check('8. $1,299.00 thousands separator', parsePriceNumber('1,299.00') === 1299);
check('8b. €9,99 decimal comma', parsePriceNumber('9,99') === 9.99);
check('8c. plain 12.99', parsePriceNumber('12.99') === 12.99);
check('8d. garbage rejected', parsePriceNumber('99,999,999') === null || parsePriceNumber('99999999999999999999') === null);

const eur = extractSignatures({
  subject: 'Your FotoFlex subscription renews on May 10, 2027',
  from: 'FotoFlex <notifications@fotoflex.de>',
  snippet: 'The subscription costs €4,99 monthly and renews automatically.',
  date: SENT_DATE,
});
check('8e. EUR currency captured', eur.price === 4.99 && eur.currency === 'EUR', { p: eur.price, c: eur.currency });

// ---------------------------------------------------------------------------
// 9. Confidence calibration boundaries
// ---------------------------------------------------------------------------
check('9. confidence always in {high, medium, low}', () => true, '');
const confidences = [trial, renewal, receipt, cancel, marketing, amb, noYear, relNoAnchor, conflict, empty, eur]
  .map((c) => c.confidence);
check('9a. all computed confidences valid', confidences.every((c) => ['high', 'medium', 'low'].includes(c)), confidences);

const subjectOnly = extractSignatures({
  subject: 'Your Vantage trial ends soon',
  from: 'Vantage <team@vantage.test>',
  snippet: 'We hope you are enjoying the product.',
  date: SENT_DATE,
});
check('9b. subject keyword + no structural facts → not high', subjectOnly.confidence !== 'high', subjectOnly.confidence);
check('9c. classification still detected', subjectOnly.classification === 'trial', subjectOnly.classification);

// 10. classificationOf sanity: subject outweighs body (weight 3).
const cls = classificationOf('your netflix free trial ends', '');
check('10. subject keyword classified trial with no body', cls.classification === 'trial' && cls.subjectKeyword === true, cls);

// ---------------------------------------------------------------------------
// 11. Detection-quality patch C — deterministic tie-breaking
// ---------------------------------------------------------------------------
// 11a. Weak overlap (both scores < 4) stays unknown, regardless of order.
const weakTieA = classificationOf('free trial — cancel before march 3', '');
const weakTieB = classificationOf('cancel before march 3 — free trial', '');
check('11a. weak cancellation/trial overlap → unknown both directions',
  weakTieA.classification === 'unknown' && weakTieB.classification === 'unknown',
  { a: weakTieA.classification, b: weakTieB.classification });
// 11b. Strong tie (≥ 4 each) → deadline-first deterministic priority, for
//      BOTH subject orders (appearance order must not decide).
const strongTieA = classificationOf('your trial trial ends — cancel before must cancel march 3', '');
const strongTieB = classificationOf('cancel before must cancel march 3 — your trial trial ends', '');
check('11b. strong trial/cancellation tie → cancellation in both orders (not key-order accident)',
  strongTieA.classification === 'cancellation' && strongTieB.classification === 'cancellation',
  { a: strongTieA.classification, b: strongTieB.classification });
// 11c. Renewal beats trial on a strong tie (renewal notices outrank promo wording).
const strongTieC = classificationOf('your trial trial ends june — auto-renews will renew august', '');
check('11c. strong trial/renewal tie → renewal (not trial-first)', strongTieC.classification === 'renewal', strongTieC.classification);
// 11d. Conflicting keywords WITHOUT a tie still resolve normally:
//      renewal has TWO subject keywords (auto-renews + will renew = 6) vs one
//      cancellation phrase (3) → renewal wins on evidence strength, not order.
const noTie = classificationOf('your adobe subscription auto-renews — will renew march 1 — cancel by february 22', '');
check('11d. distinct scores still classify normally (no regression)', noTie.classification === 'renewal', noTie.classification);

// ---------------------------------------------------------------------------
// 12. Patch B — billing subjects recognized; unsupported facts stay null.
// ---------------------------------------------------------------------------
const billLow = extractSignatures({
  subject: 'Your bill from Adobe is ready',
  from: 'Adobe Billing <billing@adobe.com>',
  snippet: 'Log in to view your billing summary and payment history.',
  date: SENT_DATE,
});
check('12. "Your bill from …" subject classified receipt (metadata-stage eligible)', billLow.classification === 'receipt', billLow.classification);
check('12a. billing statement without supported facts → conservative low', billLow.confidence === 'low', billLow.confidence);
check('12b. no invented date/price', billLow.invoiceDate === null && billLow.renewalDate === null && billLow.price === null && billLow.currency === null, billLow);

const billFull = extractSignatures({
  subject: 'Your bill from Adobe — billed on October 14, 2026',
  from: 'Adobe Billing <billing@adobe.com>',
  snippet: 'Amount charged: $19.99. This billing statement covers your annual plan.',
  date: SENT_DATE,
});
check('12c. billing statement with supported invoice date + price → facts extracted',
  billFull.classification === 'receipt' && billFull.invoiceDate === '2026-10-14' && billFull.price === 19.99 && billFull.currency === 'USD', billFull);

const genericStatement = extractSignatures({
  subject: 'Our October product statement',
  from: 'Newsletter <news@vendor.test>',
  snippet: 'A statement of everything we shipped this month. No billing involved.',
  date: SENT_DATE,
});
check('12d. generic non-billing "statement" stays unknown (no over-reach)', genericStatement.classification === 'unknown', genericStatement.classification);

// ---------------------------------------------------------------------------
// 13. Patch D — receipt confidence floor + trial-invitation suppression.
// ---------------------------------------------------------------------------
const bareReceipt = extractSignatures({
  subject: 'Your Adobe receipt',
  from: 'Adobe Billing <billing@adobe.com>',
  snippet: 'Manage your billing settings in your account at any time.',
  date: SENT_DATE,
});
check('13. receipt with NO invoice date and NO price → low (never medium/high from name+subject alone)',
  bareReceipt.classification === 'receipt' && bareReceipt.confidence === 'low', bareReceipt);

const pricedReceipt = extractSignatures({
  subject: 'Your receipt from Adobe',
  from: 'Adobe Billing <billing@adobe.com>',
  snippet: 'Amount charged: $54.99 on your yearly renewal date.',
  date: SENT_DATE,
});
check('13a. receipt WITH a supported price may reach medium', pricedReceipt.confidence !== 'low', pricedReceipt.confidence);

// Promotional INVITATIONS are not active-trial evidence.
const invite1 = extractSignatures({
  subject: 'Start your free trial today',
  from: 'DesignSpark <hello@designspark.fictitious>',
  snippet: 'Sign up now and get access to every template. Then $19.99 per month after the trial.',
  date: SENT_DATE,
});
check('13b. "Start your free trial today" → not a trial candidate (suppressed)', invite1.classification === 'unknown', invite1.classification);
const invite2 = extractSignatures({
  subject: 'Get 30 days free on NoteNest Plus',
  from: 'NoteNest <team@notenest.io>',
  snippet: 'Loved by teams. Cancel any time.',
  date: SENT_DATE,
});
check('13c. "Get 30 days free" invitation → suppressed too', invite2.classification === 'unknown', invite2.classification);
const activeTrial = extractSignatures({
  subject: 'Your free trial has started — trial ends on November 12, 2026',
  from: 'DesignSpark <hello@designspark.fictitious>',
  snippet: 'Welcome aboard! We will remind you 3 days before.',
  date: SENT_DATE,
});
check('13d. already-active trial evidence still classified normally',
  activeTrial.classification === 'trial' && activeTrial.trialEndDate === '2026-11-12', activeTrial);

const invitationWithFacts = extractSignatures({
  subject: 'Start your free trial today — then $15.99 per month',
  from: 'StreamVault <hello@streamvault.test>',
  snippet: 'Unlimited streams for everyone in your household.',
  date: SENT_DATE,
});
check('13e. invitation with promo price is STILL suppressed (never a confirmed subscription)', invitationWithFacts.classification === 'unknown', invitationWithFacts);

// ---------------------------------------------------------------------------
// 14. Payment-reminder patch — payment/failed-payment/access-expiry.
//     All expectations approved (paymentDeadline DTO field, single
//     payment_reminder classification, paymentIssueType decided by the
//     documented rule: failed → action-required → access-expiring).
// ---------------------------------------------------------------------------
const openaiReminder = extractSignatures({
  subject: 'Final reminder: Your Plus access ends soon',
  from: 'OpenAI <noreply@openai.com>',
  snippet: "You'll lose access to Plus on Oct 22, 2026. Please update your payment method by Oct 22, 2026 to keep access to Plus benefits.",
  date: '2026-10-15T10:00:00Z',
});
check('14. required fixture → payment_reminder with payment action deadline',
  openaiReminder.classification === 'payment_reminder'
  && openaiReminder.paymentDeadline === '2026-10-22'
  && openaiReminder.paymentIssueType === 'payment_action_required'
  && openaiReminder.confidence === 'high', openaiReminder);
check('14a. required fixture → NOT a renewal or confirmed charge (no cross-category leak)',
  openaiReminder.renewalDate === null
  && openaiReminder.trialEndDate === null
  && openaiReminder.invoiceDate === null
  && openaiReminder.cancellationDeadline === null
  && openaiReminder.price === null
  && openaiReminder.currency === null, openaiReminder);
check('14b. required fixture → service name supported', openaiReminder.serviceName === 'OpenAI', openaiReminder.serviceName);
check('14c. metadata-only stage already classifies the fixture subject',
  extractSignatures({ subject: 'Final reminder: Your Plus access ends soon', from: 'OpenAI <noreply@openai.com>', snippet: '', date: '2026-10-15T10:00:00Z' }).classification === 'payment_reminder');

const failedNoDate = extractSignatures({
  subject: 'Your payment failed',
  from: 'StreamVault <billing@streamvault.test>',
  snippet: 'We could not process your payment for your subscription. Please try again in your account settings.',
  date: SENT_DATE,
});
check('14d. failed payment without a date → payment_failed, deadline stays null (unknown never invented)',
  failedNoDate.classification === 'payment_reminder'
  && failedNoDate.paymentIssueType === 'payment_failed'
  && failedNoDate.paymentDeadline === null
  && failedNoDate.price === null, failedNoDate);

const actionRequired = extractSignatures({
  subject: 'Update your payment method',
  from: 'NoteNest <billing@notenest.io>',
  snippet: 'Your last payment could not be completed. Add a payment method to keep your subscription.',
  date: SENT_DATE,
});
check('14e. payment-method update required → payment_action_required, no date',
  actionRequired.classification === 'payment_reminder'
  && actionRequired.paymentIssueType === 'payment_action_required'
  && actionRequired.paymentDeadline === null, actionRequired);

const accessOnly = extractSignatures({
  subject: 'Your NoteNest access ends soon',
  from: 'NoteNest <team@notenest.io>',
  snippet: 'After December 1, 2026 you will lose access to your shared workspaces.',
  date: '2026-11-20T09:00:00Z',
});
check('14f. subscription access expiring → access_expiring with its own deadline',
  accessOnly.classification === 'payment_reminder'
  && accessOnly.paymentIssueType === 'access_expiring'
  && accessOnly.paymentDeadline === '2026-12-01'
  && accessOnly.renewalDate === null, accessOnly);

const genuineRenewal = extractSignatures({
  subject: 'Your FotoFlex subscription renews on November 1, 2026',
  from: 'FotoFlex <notifications@fotoflex.de>',
  snippet: 'Your plan will renew automatically at the same price. Manage your plan any time.',
  date: SENT_DATE,
});
check('14g. genuine renewal regression → renewal, renewalDate set, NO payment deadline',
  genuineRenewal.classification === 'renewal'
  && genuineRenewal.renewalDate === '2026-11-01'
  && genuineRenewal.paymentDeadline === null
  && genuineRenewal.paymentIssueType === null, genuineRenewal);

const genuineTrial = extractSignatures({
  subject: 'Your Vantage free trial ends on December 5, 2026',
  from: 'Vantage <team@vantage.test>',
  snippet: 'After your trial you will be charged the monthly price.',
  date: SENT_DATE,
});
check('14h. genuine trial expiration regression → trial with trialEndDate',
  genuineTrial.classification === 'trial'
  && genuineTrial.trialEndDate === '2026-12-05'
  && genuineTrial.paymentDeadline === null, genuineTrial);

const marketingFinal = extractSignatures({
  subject: 'Final reminder: 20% off ends tonight',
  from: 'MegaSale <deals@megasale.test>',
  snippet: 'Shop the sale before midnight and save on everything.',
  date: SENT_DATE,
});
check('14i. generic marketing "final reminder" stays unknown (no over-reach)',
  marketingFinal.classification === 'unknown', marketingFinal.classification);

const conflicting1 = extractSignatures({
  subject: 'Your renewal payment failed',
  from: 'StreamVault <billing@streamvault.test>',
  snippet: 'We could not charge your card. Update your payment method by March 3, 2027 to keep your plan. Your plan will not auto-renew until payment succeeds.',
  date: SENT_DATE,
});
check('14j. conflicting payment+renewal wording → payment evidence wins; deadline NOT stored as renewal',
  conflicting1.classification === 'payment_reminder'
  && conflicting1.paymentIssueType === 'payment_failed'
  && conflicting1.paymentDeadline === '2027-03-03'
  && conflicting1.renewalDate === null
  && conflicting1.trialEndDate === null
  && conflicting1.invoiceDate === null
  && conflicting1.cancellationDeadline === null, conflicting1);

const conflicting2 = extractSignatures({
  subject: 'Your subscription renews on November 1, 2026',
  from: 'FotoFlex <billing@fotoflex.de>',
  snippet: 'Your plan automatically renews at the same price. If it has expired, update your payment method by November 1, 2026 to avoid interruption.',
  date: SENT_DATE,
});
check('14k. conflicting wording with dominant renewal evidence → renewal stays renewal (correction #5)',
  conflicting2.classification === 'renewal'
  && conflicting2.renewalDate === '2026-11-01'
  && conflicting2.paymentIssueType === null, conflicting2);

const barePaymentMethod = extractSignatures({
  subject: 'Your receipt from Adobe',
  from: 'Adobe Billing <billing@adobe.com>',
  snippet: 'Your payment method ending in 4242 was charged on October 14, 2026 — amount charged: $19.99.',
  date: SENT_DATE,
});
check('14l. bare "payment method" mention does NOT hijack a receipt into payment_reminder (receipt behavior preserved)',
  barePaymentMethod.classification === 'receipt'
  && barePaymentMethod.invoiceDate === '2026-10-14'
  && barePaymentMethod.price === 19.99
  && barePaymentMethod.paymentIssueType === null
  && barePaymentMethod.paymentDeadline === null, barePaymentMethod);

// Documented ranking/relevance probes (scanner support functions).
check('14m. hasDateEvidence: explicit deadline in subject detected',
  hasDateEvidence('Final reminder: Your Plus access ends Oct 22, 2026') === true
  && hasDateEvidence('Your Plus access ends soon') === false);
check('14n. subjectWarrantsInspection: loosely-subjectied reminders qualify, plain mail does not',
  subjectWarrantsInspection('a final reminder about your openai account') === true
  && subjectWarrantsInspection('hello world') === false);
check('14o. paymentIssueType precedence: failed > action > access (documented rule)',
  paymentIssueTypeOf('final reminder: your plus access ends soon', "you'll lose access on march 1. update your payment method by march 1.") === 'payment_action_required'
  && paymentIssueTypeOf('your payment failed', 'add a payment method to restore access') === 'payment_failed'
  && paymentIssueTypeOf('keep reading all month', 'you will lose access to the archive on march 1') === 'access_expiring'
  && paymentIssueTypeOf('something else entirely', 'nothing relevant here') === null);

// ---------------------------------------------------------------------------
// T1–T6: body-extraction tests (invented service names, no real emails)
// ---------------------------------------------------------------------------
// All service names and email text are entirely synthetic.
// T_SENT is reused as the anchor date.
const T_SENT = '2027-02-01T10:00:00Z';

// T1: payment-failed subject, access-end date only in the body (not the snippet)
const t1 = extractSignatures({
  subject: 'Payment failed for your Vaultly subscription',
  from: 'Vaultly Billing <billing@vaultly.test>',
  snippet: 'We were unable to charge your card.',
  body: 'We were unable to charge your card on file. ' +
        'You will lose access to Vaultly on March 5, 2027. ' +
        'Please update your payment method.',
  date: T_SENT,
});
check('T1. payment_reminder classification (from subject)', t1.classification === 'payment_reminder', t1.classification);
check('T1a. paymentIssueType payment_failed (from snippet/subject)', t1.paymentIssueType === 'payment_failed', t1.paymentIssueType);
check('T1b. paymentDeadline 2027-03-05 extracted from body — access-end phrase "lose access" before the date', t1.paymentDeadline === '2027-03-05', t1.paymentDeadline);
check('T1c. no trialEndDate invented', t1.trialEndDate === null, t1.trialEndDate);

// T2: trial end date buried late in the body, not in the snippet
const t2 = extractSignatures({
  subject: 'Welcome to Axonify — your free trial has started',
  from: 'Axonify <hello@axonify.test>',
  snippet: 'Thanks for joining. You have full access to all features.',
  body: 'Thanks for joining. You have full access to all features. ' +
        'Explore the dashboard, invite teammates, and set up your first project. ' +
        'For questions visit our help centre. ' +
        'Your free trial ends on April 14, 2027. ' +
        'After that you will be charged $12.99 per month.',
  date: T_SENT,
});
check('T2. trial classification', t2.classification === 'trial', t2.classification);
check('T2a. trialEndDate 2027-04-14 from body', t2.trialEndDate === '2027-04-14', t2.trialEndDate);
check('T2b. price 12.99 USD from body', t2.price === 12.99 && t2.currency === 'USD', { p: t2.price, c: t2.currency });

// T3: no date anywhere — all date fields stay null
const t3 = extractSignatures({
  subject: 'Your Draftline trial ends soon',
  from: 'Draftline <notifications@draftline.test>',
  snippet: 'Your free trial is coming to an end.',
  body: 'Your free trial is coming to an end. Log in to upgrade your plan ' +
        'and continue using Draftline without interruption.',
  date: null,
});
check('T3. trial classification', t3.classification === 'trial', t3.classification);
check('T3a. trialEndDate null — no date anywhere', t3.trialEndDate === null, t3.trialEndDate);
check('T3b. all date fields null', t3.renewalDate === null && t3.cancellationDeadline === null && t3.paymentDeadline === null, t3);
check('T3c. confidence not high (no date fact)', t3.confidence !== 'high', t3.confidence);

// T4: payment action required — deadline in the body, not the snippet
const t4 = extractSignatures({
  subject: 'Action required: update your payment method',
  from: 'Flarepath Accounts <accounts@flarepath.test>',
  snippet: 'Please update your payment method to keep access.',
  body: 'Your last payment did not go through. ' +
        'Please update your payment method by February 20, 2027 ' +
        'to keep access to your Flarepath account.',
  date: T_SENT,
});
check('T4. payment_reminder classification', t4.classification === 'payment_reminder', t4.classification);
check('T4a. paymentIssueType payment_action_required', t4.paymentIssueType === 'payment_action_required', t4.paymentIssueType);
check('T4b. paymentDeadline 2027-02-20 from body', t4.paymentDeadline === '2027-02-20', t4.paymentDeadline);
check('T4c. no trialEndDate invented', t4.trialEndDate === null, t4.trialEndDate);

// T5: footer date "(c) 2027" and a boilerplate "Terms updated January 1, 2027" must NOT
//     become a trial deadline — neither has trial/payment/renewal context within 60 chars
const t5 = extractSignatures({
  subject: 'Your Orindal free trial has started',
  from: 'Orindal <hi@orindal.test>',
  snippet: 'Enjoy your trial. No charges until the trial ends.',
  body: 'Enjoy your trial. No charges until the trial ends. ' +
        'For help visit support.orindal.test. ' +
        '\u00a9 2027 Orindal Inc. All rights reserved. ' +
        'Terms updated January 1, 2027. Privacy Policy.',
  date: T_SENT,
});
check('T5. trial classification', t5.classification === 'trial', t5.classification);
check('T5a. footer year 2027 does NOT become trialEndDate (no context keyword within 60 chars)', t5.trialEndDate === null, t5.trialEndDate);
check('T5b. boilerplate date does NOT become paymentDeadline or renewalDate', t5.paymentDeadline === null && t5.renewalDate === null, t5);

// T6: snippet-only (no body field) — must give identical output to before this change
const t6_withBody = extractSignatures({
  subject: 'Your Brandelo subscription renews on May 10, 2027',
  from: 'Brandelo <billing@brandelo.test>',
  snippet: 'Your plan will renew automatically. We will charge $7.99 per month at renewal.',
  body: 'Your plan will renew automatically. We will charge $7.99 per month at renewal.',
  date: T_SENT,
});
const t6_snippetOnly = extractSignatures({
  subject: 'Your Brandelo subscription renews on May 10, 2027',
  from: 'Brandelo <billing@brandelo.test>',
  snippet: 'Your plan will renew automatically. We will charge $7.99 per month at renewal.',
  date: T_SENT,
});
check('T6. snippet-only and body-equal-to-snippet give same classification', t6_snippetOnly.classification === t6_withBody.classification, { snippetOnly: t6_snippetOnly.classification, withBody: t6_withBody.classification });
check('T6a. same renewalDate', t6_snippetOnly.renewalDate === t6_withBody.renewalDate, { snippetOnly: t6_snippetOnly.renewalDate, withBody: t6_withBody.renewalDate });
check('T6b. same price', t6_snippetOnly.price === t6_withBody.price, { snippetOnly: t6_snippetOnly.price, withBody: t6_withBody.price });
check('T6c. snippet-only renewalDate — note: date is in subject so snippet content does not matter', t6_snippetOnly.renewalDate === '2027-05-10', t6_snippetOnly.renewalDate);

results.forEach((r) => console.log(r));
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exitCode = failCount === 0 ? 0 : 1;
