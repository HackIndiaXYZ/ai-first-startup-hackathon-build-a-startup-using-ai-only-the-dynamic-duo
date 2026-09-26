const express = require('express');
const router = express.Router();
const { getClient } = require('../db/supabaseClient');

/**
 * Maps a Supabase snake_case row to the camelCase shape the React frontend expects.
 * Keep this mapping in sync with the mock data shape in mockSubscriptions.js.
 */
function toClient(row) {
  return {
    id:              row.id,
    serviceName:     row.service_name,
    planName:        row.plan_name,
    trialStartDate:  row.trial_start_date,
    trialEndDate:    row.trial_end_date,
    price:           Number(row.price),   // numeric(10,2) → JS number
    currency:        row.currency,
    status:          row.status,
    cancellationUrl: row.cancellation_url,
  };
}

/** Returns true only for strings that match UUID format. */
function isValidUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// GET /api/subscriptions
router.get('/', async (req, res, next) => {
  let supabase;
  try {
    supabase = getClient();
  } catch (err) {
    return next({ status: 503, message: 'Database is not configured.' });
  }

  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[GET /subscriptions] DB error:', error.message);
    return next({ status: 502, message: 'Could not retrieve subscriptions.' });
  }

  res.json(data.map(toClient));
});

// GET /api/subscriptions/:id
router.get('/:id', async (req, res, next) => {
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

  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error(`[GET /subscriptions/${id}] DB error:`, error.message);
    return next({ status: 502, message: 'Could not retrieve subscription.' });
  }

  if (!data) {
    return res.status(404).json({ error: 'Subscription not found.' });
  }

  res.json(toClient(data));
});

module.exports = router;
