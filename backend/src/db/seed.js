/**
 * Seed script — TrialGuard Phase 2
 *
 * Inserts six fictional sample subscriptions into Supabase.
 * Safe to run repeatedly: existing rows with the same ID are skipped (upsert).
 *
 * Usage:
 *   node backend/src/db/seed.js
 *   — or from the backend/ directory —
 *   node src/db/seed.js
 *
 * Requires SUPABASE_URL and SUPABASE_SECRET_KEY in backend/.env
 *
 * WARNING: This is a single-user prototype seed. Records have no user_id.
 * Do not use this seed in a production multi-user environment.
 */

// Load .env relative to this file's location so the script works from any cwd.
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { getClient } = require('./supabaseClient');

/** Returns a YYYY-MM-DD date string offset by `days` from today (UTC midnight). */
function isoOffset(days) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const seeds = [
  // --- Active trials expiring within 7 days (2) ---
  {
    id: 'a1b2c3d4-0001-0001-0001-000000000001',
    service_name: 'StreamVault',
    plan_name: 'Premium Annual',
    trial_start_date: isoOffset(-7),
    trial_end_date: isoOffset(3),
    price: 14.99,
    currency: 'USD',
    status: 'active',
    cancellation_url: 'https://example-streamvault.fictitious/account/cancel',
  },
  {
    id: 'a1b2c3d4-0002-0002-0002-000000000002',
    service_name: 'CloudMind AI',
    plan_name: 'Pro Seat',
    trial_start_date: isoOffset(-10),
    trial_end_date: isoOffset(6),
    price: 29.99,
    currency: 'USD',
    status: 'active',
    cancellation_url: 'https://example-cloudmind.fictitious/billing/cancel',
  },

  // --- Active trials expiring later (2) ---
  {
    id: 'a1b2c3d4-0003-0003-0003-000000000003',
    service_name: 'NoteNest',
    plan_name: 'Team Starter',
    trial_start_date: isoOffset(-5),
    trial_end_date: isoOffset(21),
    price: 9.99,
    currency: 'USD',
    status: 'active',
    cancellation_url: 'https://example-notenest.fictitious/settings/subscription',
  },
  {
    id: 'a1b2c3d4-0005-0005-0005-000000000005',
    service_name: 'DataSift Analytics',
    plan_name: 'Business Tier',
    trial_start_date: isoOffset(-3),
    trial_end_date: isoOffset(30),
    price: 49.99,
    currency: 'USD',
    status: 'active',
    cancellation_url: 'https://example-datasift.fictitious/plans/cancel',
  },

  // --- Expired trial — trial ended, user never cancelled (1) ---
  {
    id: 'a1b2c3d4-0006-0006-0006-000000000006',
    service_name: 'SecureVault',
    plan_name: 'Personal Shield',
    trial_start_date: isoOffset(-20),
    trial_end_date: isoOffset(-5),
    price: 4.99,
    currency: 'USD',
    status: 'active',   // stored as 'active'; the frontend derives 'expired' from the date
    cancellation_url: 'https://example-securevault.fictitious/subscription/end',
  },

  // --- Confirmed cancelled subscription (1) ---
  {
    id: 'a1b2c3d4-0004-0004-0004-000000000004',
    service_name: 'DesignSpark',
    plan_name: 'Creator Plus',
    trial_start_date: isoOffset(-30),
    trial_end_date: isoOffset(-15),
    price: 19.99,
    currency: 'USD',
    status: 'cancelled',
    cancellation_url: 'https://example-designspark.fictitious/account/manage',
  },
];

async function seed() {
  console.log('Seeding subscriptions…');

  const supabase = getClient();

  // upsert: insert rows; on conflict (same id) do nothing — idempotent.
  const { data, error } = await supabase
    .from('subscriptions')
    .upsert(seeds, { onConflict: 'id', ignoreDuplicates: true })
    .select('id, service_name');

  if (error) {
    console.error('Seed failed:', error.message);
    process.exit(1);
  }

  console.log(`Done. ${data.length} row(s) inserted (existing rows skipped).`);
  data.forEach((r) => console.log(`  + ${r.id}  ${r.service_name}`));
}

seed();
