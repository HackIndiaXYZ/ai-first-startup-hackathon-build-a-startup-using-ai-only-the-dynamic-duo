/**
 * subscriptions routes — TrialGuard Phase 2 + CP5-B hardening.
 *
 *   GET /api/subscriptions      → list (scoped, see below)
 *   GET /api/subscriptions/:id  → single (scoped, see below)
 *
 * CP5-B scope rules (approved plan v2 §6/§7 — no writes happen here):
 *   - Sessions are loaded but NOT required for the list; unauthenticated
 *     callers see ONLY demo rows (`owner_sub IS NULL`, the six seeded
 *     records). Authenticated callers (verified session with google_sub)
 *     additionally see their own records (`owner_sub = google_sub`).
 *   - No unauthenticated route can ever expose a private (user-owned) record;
 *     a foreign-owned single-record lookup returns 404 so another user can
 *     never even prove a row exists (no existence oracle).
 *   - Ownership identifiers are NEVER accepted from the client — they are
 *     derived exclusively from the verified server-side session.
 *   - Demo rows are labeled `source: 'demo'` (migration 004) and are never
 *     writable from anywhere in CP5.
 *
 * MAPS a Supabase snake_case row to the camelCase shape the React frontend
 * expects. Nullable fields stay null (the UI renders "Unknown") — nothing is
 * defaulted or invented (approved correction 5).
 */

const express = require('express');
const router = express.Router();
const { getClient } = require('../db/supabaseClient');
const { session } = require('../middleware/session');

function toClient(row) {
  return {
    id:                   row.id,
    serviceName:          row.service_name,
    planName:             row.plan_name,
    trialStartDate:       row.trial_start_date,
    trialEndDate:         row.trial_end_date,
    price:                row.price == null ? null : Number(row.price), // numeric(10,2) → number
    currency:             row.currency,
    status:               row.status,
    cancellationUrl:      row.cancellation_url,
    // CP5: provenance + scan-fact fields, lossless and nullable.
    source:               row.source,
    ownerSub:             undefined, // never exposed (verified-session identity)
    sourceMessageId:      row.source_message_id, // the owner already holds this id
    renewalDate:          row.renewal_date,
    paymentDeadline:      row.payment_deadline,
    paymentIssueType:     row.payment_issue_type,
    invoiceDate:          row.invoice_date,
    cancellationDeadline: row.cancellation_deadline,
  };
  // owner_sub stays unexposed; source_message_id is a label, not message
  // content, and these scoped routes only ever return it to the owning user.
}

/** Returns true only for strings that match UUID format. */
function isValidUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// GET /api/subscriptions
router.get('/', session(), async (req, res, next) => {
  let supabase;
  try {
    supabase = getClient();
  } catch (err) {
    return next({ status: 503, message: 'Database is not configured.' });
  }

  try {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('*')
      // Unauthenticated → demo only; authenticated → demo + own records.
      // The or-predicate uses ONLY the server-derived identifier.
      .or(req.session?.google_sub
        ? `owner_sub.is.null,owner_sub.eq.${req.session.google_sub}`
        : 'owner_sub.is.null')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[GET /subscriptions] DB error (details suppressed):', error.message);
      return next({ status: 502, message: 'Could not retrieve subscriptions.' });
    }

    res.json(data.map(toClient));
  } catch (err) {
    console.error('[GET /subscriptions] unexpected failure (details suppressed):', err.message);
    return next({ status: 502, message: 'Could not retrieve subscriptions.' });
  }
});

// GET /api/subscriptions/:id
router.get('/:id', session(), async (req, res, next) => {
  const { id } = req.params;

  if (!isValidUuid(id)) {
    return res.status(400).json({ error: 'Invalid subscription ID format.' });
  }

  let supabase;
  try {
    supabase = getClient();
  } catch (err) {
    return next({ status: 503, message: 'Database is not configured.' });
  }

  try {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('id', id)
      // Same predicate as the list: another user's private record is simply
      // invisible — a 404, exactly as if it did not exist (no oracle).
      .or(req.session?.google_sub
        ? `owner_sub.is.null,owner_sub.eq.${req.session.google_sub}`
        : 'owner_sub.is.null')
      .maybeSingle();

    if (error) {
      console.error(`[GET /subscriptions/id] DB error (details suppressed): ${error.message}`);
      return next({ status: 502, message: 'Could not retrieve subscription.' });
    }

    if (!data) {
      return res.status(404).json({ error: 'Subscription not found.' });
    }

    res.json(toClient(data));
  } catch (err) {
    console.error('[GET /subscriptions/id] unexpected failure (details suppressed):', err.message);
    return next({ status: 502, message: 'Could not retrieve subscription.' });
  }
});

module.exports = router;
