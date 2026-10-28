/**
 * CP5 migration 004 executor — AUTHORIZED EXECUTION ONLY.
 *
 * Executes backend/migrations/004_save_selected_subscriptions.sql against the
 * Supabase project in ONE transaction (BEGIN … COMMIT, ROLLBACK on any error),
 * after verifying preconditions:
 *   - SUPABASE_DB_URL exists in backend/.env (Postgres connection string)
 *   - the target project URL matches the DB connection host
 *   - the six demo rows still exist with the expected UUIDs (no other rows)
 *   - migration 004 is not already applied (any of the 8 columns → abort)
 *
 * It snapshots every row before the DDL and compares all original values
 * afterwards. Never prints credentials. Never inserts/updates subscription
 * CONTENT rows — the only UPDATE is the migration's own demo-source labeling.
 *
 * Usage: node backend/scripts/apply-migration-004.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');

const projectUrl = process.env.SUPABASE_URL;
const dbUrl =
  process.env.SUPABASE_DB_URL ||
  process.env.SUPABASE_DB_CONNECTION_STRING ||
  process.env.DATABASE_URL;

if (!dbUrl) {
  console.log('ABORT: no Postgres connection string found. Add SUPABASE_DB_URL to backend/.env');
  process.exit(1);
}
if (!projectUrl) {
  console.log('ABORT: SUPABASE_URL is not configured.');
  process.exit(1);
}

// ---- target project confirmation (ids only — never secrets) ---------------
const refFromUrl = (projectUrl.match(/^https:\/\/([a-z0-9]+)\./i) || [])[1] || '(unknown ref)';
console.log(`TARGET_PROJECT: ${refFromUrl}`);

const { Client } = require('pg');

const SIX_IDS = [
  'a1b2c3d4-0001-0001-0001-000000000001',
  'a1b2c3d4-0002-0002-0002-000000000002',
  'a1b2c3d4-0003-0003-0003-000000000003',
  'a1b2c3d4-0004-0004-0004-000000000004',
  'a1b2c3d4-0005-0005-0005-000000000005',
  'a1b2c3d4-0006-0006-0006-000000000006',
];

// ---- precheck: the file being run is the reviewed migration -----------------
const migrationPath = path.join(__dirname, '../migrations/004_save_selected_subscriptions.sql');
const raw = fs.readFileSync(migrationPath, 'utf8');
for (const id of SIX_IDS) {
  if (!raw.includes(id)) {
    console.log(`ABORT: migration file no longer targets ${id} — file changed since review.`);
    process.exit(1);
  }
}
if (raw.includes('delete from') || /\bdrop table\b/i.test(raw)) {
  console.log('ABORT: migration file contains a destructive statement — file changed since review.');
  process.exit(1);
}

// Strip comments (-- line comments and /* */ blocks), then split top-level ';'.
function sqlStatements(text) {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (line.trim().startsWith('--') ? '' : line))
    .join('\n');
  return stripped
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

const COLUMN_GROUPS = {
  cp5: ['owner_sub', 'source', 'source_message_id', 'renewal_date', 'payment_deadline', 'payment_issue_type', 'invoice_date', 'cancellation_deadline'],
  relaxedNullable: ['plan_name', 'trial_start_date', 'trial_end_date', 'price', 'currency'],
  original: ['id', 'user_id', 'service_name', 'plan_name', 'trial_start_date', 'trial_end_date', 'price', 'currency', 'status', 'cancellation_url', 'created_at', 'updated_at'],
};

/** Rows that must remain byte-identical (every column of the snapshot). */
function rowValues(row) {
  return JSON.stringify(row);
}

(async () => {
  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }, // Supabase-managed TLS (intermediate CAs)
  });
  await client.connect();
  try {
    // Host sanity check against the project URL ref BEFORE anything is written.
    const [, dbHost] = /@([^:/]+)/.exec(dbUrl) || [];
    if (dbHost && !/^db\./i.test(dbHost.replace(/^.*?aws-0/, 'db.')) && !dbHost.includes('supabase')) {
      console.log(`ABORT: DB host does not look like Supabase (${refFromUrl} expected).`);
      process.exit(1);
    }
    if (dbHost && !/supabase/i.test(dbHost) && /^(localhost|127\.)/.test(dbHost)) {
      console.log('ABORT: DB host is localhost — refusing to migrate a non-Supabase target.');
      process.exit(1);
    }

    // ---- preconditions ----
    const before = (await client.query('select * from public.subscriptions order by created_at asc')).rows;
    if (before.length !== SIX_IDS.length || !before.every((r) => SIX_IDS.includes(r.id))) {
      console.log(`ABORT: expected exactly the six seed rows, found ${before.length}`);
      process.exit(1);
    }
    const colsBefore = (await client.query(
      "select column_name from information_schema.columns where table_schema='public' and table_name='subscriptions'"
    )).rows.map((r) => r.column_name);
    const cp5prefix = COLUMN_GROUPS.cp5.filter((c) => colsBefore.includes(c));
    if (cp5prefix.length > 0) {
      console.log(`ABORT: migration 004 appears already (partially) applied: ${cp5prefix.join(', ')}`);
      process.exit(1);
    }
    const snapshot = before.map(rowValues);

    // ---- run the migration inside ONE transaction ----
    await client.query('begin');
    try {
      const statements = sqlStatements(raw);
      console.log(`RUNNING ${statements.length} statements in one transaction…`);
      for (const [i, stmt] of statements.entries()) {
        await client.query(stmt);
        console.log(`  ok [${i + 1}/${statements.length}]: ${stmt.split('\n')[0].slice(0, 60)}…`);
      }
      await client.query('commit');
      console.log('TRANSACTION COMMITTED.');
    } catch (err) {
      await client.query('rollback');
      console.log(`ROLLED BACK. error: ${err.message} (code ${err.code ?? 'n/a'})`);
      process.exit(1);
    }

    // ---- post-execution verification ----
    const cols = (await client.query(
      "select column_name, is_nullable, column_default from information_schema.columns " +
      "where table_schema='public' and table_name='subscriptions' order by ordinal_position"
    )).rows;
    const byCol = new Map(cols.map((c) => [c.column_name, c]));
    console.log('1. new columns:', COLUMN_GROUPS.cp5.map((c) => `${c}:${byCol.has(c) ? 'OK' : 'MISSING'}`).join(' '));
    console.log('2. relaxed now nullable:', COLUMN_GROUPS.relaxedNullable.map(
      (c) => `${c}:${byCol.get(c)?.is_nullable === 'YES' ? 'NULL-OK' : `still-${byCol.get(c)?.is_nullable}`}`
    ).join(' '));

    const idx = (await client.query(
      "select indexname, indexdef from pg_indexes where schemaname='public' and tablename='subscriptions' order by indexname"
    )).rows;
    for (const { indexname, indexdef } of idx) console.log(`2b. index: ${indexname} :: ${indexdef}`);

    const rows = (await client.query('select * from public.subscriptions order by created_at asc')).rows;
    const demo = rows.filter((r) => r.source === 'demo');
    console.log(`3. rows now: ${rows.length} (expected 6); labeled demo: ${demo.length} (expected 6)`);
    const snapshotUnchanged = rows.length === snapshot.length && rows.every((row, i) => {
      // Compare every ORIGINAL column value with the pre-migration snapshot.
      const orig = JSON.parse(snapshot[i]);
      return COLUMN_GROUPS.original.every((c) => rowValues({ [c]: orig[c] })[0] === (orig[c] === null && row[c] === null ? 'x' : (row[c] == null && orig[c] == null ? 'x' : undefined)) || JSON.stringify({ [c]: row[c] }) === JSON.stringify({ [c]: orig[c] }));
    });
    console.log(`4. original values unchanged: ${snapshotUnchanged ? 'YES' : 'NO'}`);

    const cons = (await client.query(
      "select conname, contype, pg_get_constraintdef(oid) as def from pg_constraint " +
      "where conrelid = 'public.subscriptions'::regclass order by conname"
    )).rows;
    for (const c of cons) console.log(`5. constraint: ${c.conname} (${c.contype}) :: ${c.def}`);

    const err = rows.length === 6 && demo.length === 6 && snapshotUnchanged ? null : 'verification mismatch — see lines above';
    console.log(`6. RESULT: ${err ? 'FAILED' : 'SUCCESS'}${err ? ` — ${err}` : ''}`);
    process.exitCode = err ? 1 : 0;
  } finally {
    await client.end().catch(() => {});
  }
})().catch((err) => {
  console.log(`FATAL: ${err.message}`);
  process.exit(1);
});
