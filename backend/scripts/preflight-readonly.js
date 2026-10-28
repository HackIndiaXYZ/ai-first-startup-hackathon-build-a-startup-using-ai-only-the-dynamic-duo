/**
 * READ-ONLY CP5 preflight — authorized verification only.
 *
 * Performs exclusively:
 *   1. SELECT * on public.subscriptions (rows present = which of the six demo
 *      UUIDs exist; how many additional rows; minimal fields printed only).
 *   2. GET /rest/v1/ OpenAPI introspection with the service key (schema level:
 *      column names + required lists for subscriptions) to detect migration 004.
 *
 * It NEVER performs insert / update / delete / upsert of any kind, never runs
 * DDL, never creates tables, and never touches gmail_tokens or sessions.
 * Credentials are loaded from backend/.env through dotenv and never printed.
 *
 * Usage: node backend/scripts/preflight-readonly.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.log('PREFLIGHT ABORTED: Supabase credentials are not configured in backend/.env');
  process.exit(1);
}

const sb = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

const SIX_IDS = [
  'a1b2c3d4-0001-0001-0001-000000000001',
  'a1b2c3d4-0002-0002-0002-000000000002',
  'a1b2c3d4-0003-0003-0003-000000000003',
  'a1b2c3d4-0004-0004-0004-000000000004',
  'a1b2c3d4-0005-0005-0005-000000000005',
  'a1b2c3d4-0006-0006-0006-000000000006',
];

// All columns migration 004 introduces (schema-existence markers).
const CP5_COLUMNS = [
  'owner_sub', 'source', 'source_message_id',
  'renewal_date', 'payment_deadline', 'payment_issue_type',
  'invoice_date', 'cancellation_deadline',
];

(async () => {
  console.log('=== CP5 READ-ONLY PREFLIGHT ===');

  // ---- 1+2: rows ----------------------------------------------------------
  const { data, error } = await sb
    .from('subscriptions')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) {
    console.log('ROWS_ERROR:', error.message);
    process.exit(1);
  }
  console.log('ROWS_TOTAL:', data.length);

  const byId = new Map(data.map((r) => [r.id, r]));
  for (const id of SIX_IDS) {
    const row = byId.get(id);
    if (row) console.log(`DEMO_OK    ${id}  ${row.service_name}`);
    else console.log(`DEMO_MISSING ${id}`);
  }

  const extras = data.filter((r) => !SIX_IDS.includes(r.id));
  console.log('EXTRA_ROWS:', extras.length);
  if (extras.length > 0) {
    const withUser = extras.filter((r) => r.user_id != null).length;
    console.log('EXTRA_WITH_USER_ID:', withUser);
    // Minimal display of extra rows: service name + fiscal dates only.
    for (const r of extras) {
      console.log(`  extra: ${(r.service_name ?? '(unnamed)').slice(0, 40)}  created=${String(r.created_at).slice(0, 10)}`);
    }
  }

  // ---- 3+4: schema introspection (PostgREST OpenAPI) ----------------------
  let applied;
  try {
    const res = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`OpenAPI introspection HTTP ${res.status}`);
    const spec = await res.json();
    const def = spec?.definitions?.subscriptions;
    if (!def) {
      console.log('SCHEMA: subscriptions definition not exposed — cannot introspect via REST');
      applied = 'unknown';
    } else {
      const cols = Object.keys(def.properties || {});
      console.log('SCHEMA_COLUMNS:', JSON.stringify(cols));
      if (Array.isArray(def.required)) {
        console.log('SCHEMA_REQUIRED_COLUMNS:', JSON.stringify(def.required));
      }
      const present = CP5_COLUMNS.filter((c) => cols.includes(c));
      const missing = CP5_COLUMNS.filter((c) => !cols.includes(c));
      console.log('CP5_COLUMNS_PRESENT:', JSON.stringify(present));
      console.log('CP5_COLUMNS_MISSING:', JSON.stringify(missing));
      if (present.length === 0) applied = 'not applied';
      else if (missing.length === 0) applied = 'fully applied';
      else applied = 'partially applied';
    }
  } catch (e) {
    console.log('SCHEMA_CHECK_ERROR:', e.message);
    applied = 'unknown';
  }
  console.log('MIGRATION_004_STATE:', applied);

  // ---- 5: backup availability --------------------------------------------
  // Supabase project backups live in the Dashboard (Database → Backups) and
  // are not reachable through the public REST surface. Nothing is probed.
  console.log('BACKUP_CHECK: not verifiable via API — see report (Dashboard → Database → Backups)');
  console.log('=== PREFLIGHT COMPLETE (read-only) ===');
})();
