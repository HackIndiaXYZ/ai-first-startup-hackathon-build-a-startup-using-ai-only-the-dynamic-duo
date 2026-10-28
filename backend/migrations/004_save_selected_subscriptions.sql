-- =============================================================================
-- Migration: 004_save_selected_subscriptions.sql
-- Description: Adds ownership/provenance + scan-fact columns to the existing
--              subscriptions table, relaxes NOT NULLs for scan-derived rows,
--              adds uniqueness scoped to (owner, source message id), labels
--              the six demo rows, and creates supporting indexes.
--
-- TrialGuard Phase CP5 — "Save Selected Subscriptions".
--
-- RUN ONCE against the Supabase project (SQL Editor or `supabase db push`)
-- ONLY after explicit approval — do NOT run automatically:
--   supabase db push          (if using the Supabase CLI)
--   — OR —
--   Paste into Supabase Dashboard → SQL Editor → Run
--
-- SAFETY PROPERTIES (approved CP5 plan v2, §3/§12):
--   - Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS, DROP NOT NULL is a
--     no-op on nullable columns, DROP CONSTRAINT IF EXISTS + re-ADD, and a
--     fixed-id UPDATE that converges).
--   - NO existing column value changes. The single UPDATE below touches ONLY
--     the NEW `source` column, and matches exactly the six fixed seed IDs.
--   - Uniqueness is scoped to (owner_sub, source_message_id) — NOT to
--     service/plan names, so legitimate same-service records can coexist.
--   - PostgREST note: partial unique indexes cannot back an ON CONFLICT target
--     clause, so the save endpoint uses plain INSERT and treats Postgres
--     error 23505 (unique_violation) as "already saved" — see
--     backend/src/routes/scan.js (POST /save).
--
-- PRIVACY: no email bodies, snippets, headers, or tokens are stored here;
-- ownership is the opaque Google account id from the verified server session.
-- =============================================================================

-- Ownership / provenance columns ----------------------------------------------
alter table public.subscriptions
  add column if not exists owner_sub         text null,
  add column if not exists source            text not null default 'manual',
  add column if not exists source_message_id text null;

-- Scan-fact columns (all nullable — never fabricated just to fit the schema) --
alter table public.subscriptions
  add column if not exists renewal_date          date null,
  add column if not exists payment_deadline      date null,
  add column if not exists payment_issue_type    text null
    check (payment_issue_type in ('payment_failed','payment_action_required','access_expiring')),
  add column if not exists invoice_date          date null,
  add column if not exists cancellation_deadline date null;

-- Relax NOT NULLs per the approved schema audit (§2 of CP5 plan v2) ------------
-- Unknown values are stored as NULL; the UI renders "Unknown". DROP NOT NULL
-- on an already-nullable column is a harmless no-op (idempotency).
alter table public.subscriptions
  alter column plan_name        drop not null,
  alter column trial_start_date drop not null,
  alter column trial_end_date   drop not null,
  alter column price            drop not null,
  alter column currency         drop not null;

-- Provenance vocabulary: 'demo' = seeded sample data; 'scan' = user-saved from
-- a verified scan; 'manual' kept for any pre-existing/future direct insert.
alter table public.subscriptions drop constraint if exists subscriptions_source_check;
alter table public.subscriptions
  add constraint subscriptions_source_check check (source in ('demo','manual','scan'));

-- Label the six demo rows (fixed seed IDs; exact match, no other row touched).
update public.subscriptions
   set source = 'demo'
 where id in (
   'a1b2c3d4-0001-0001-0001-000000000001',
   'a1b2c3d4-0002-0002-0002-000000000002',
   'a1b2c3d4-0003-0003-0003-000000000003',
   'a1b2c3d4-0004-0004-0004-000000000004',
   'a1b2c3d4-0005-0005-0005-000000000005',
   'a1b2c3d4-0006-0006-0006-000000000006'
 );

-- Uniqueness scoped to owner + source message id ONLY (approved D3) -----------
-- Same service/plan by the same user remains allowed; re-saving the same scan
-- message cannot create a second row; two different owners never collide.
create unique index if not exists subscriptions_owner_msgid_unique
  on public.subscriptions (owner_sub, source_message_id)
 where source_message_id is not null;

-- Supporting indexes ----------------------------------------------------------
create index if not exists subscriptions_owner_sub_idx on public.subscriptions (owner_sub);
create index if not exists subscriptions_source_idx    on public.subscriptions (source);
