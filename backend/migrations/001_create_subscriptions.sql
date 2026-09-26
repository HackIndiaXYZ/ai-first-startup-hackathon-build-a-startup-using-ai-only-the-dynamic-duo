-- =============================================================================
-- Migration: 001_create_subscriptions.sql
-- Description: Creates the subscriptions table for TrialGuard Phase 2.
--
-- Run this once against your Supabase project using the SQL Editor or CLI:
--   supabase db push   (if using Supabase CLI)
--   — OR —
--   Paste into Supabase Dashboard → SQL Editor → Run
--
-- WARNING — SINGLE-USER PROTOTYPE:
--   user_id is nullable and RLS is enabled but NO public/anon policies exist.
--   All queries run server-side using the service_role key (bypasses RLS).
--   This design is intentional for the Phase 2 prototype. Do NOT open public
--   access policies until per-user authentication is implemented in a later phase.
-- =============================================================================

-- Create the table
create table if not exists public.subscriptions (
  id                uuid          primary key default gen_random_uuid(),

  -- Nullable for the single-user prototype; add NOT NULL + FK to auth.users in Phase 3.
  user_id           uuid          null,

  service_name      text          not null,
  plan_name         text          not null,
  trial_start_date  date          not null,
  trial_end_date    date          not null,
  price             numeric(10,2) not null check (price >= 0),
  currency          text          not null default 'USD',

  -- Allowed values match the frontend resolvedStatus logic.
  status            text          not null default 'active'
                                  check (status in ('active', 'expired', 'cancelled')),

  cancellation_url  text          null,

  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now()
);

-- Index for future user-scoped queries
create index if not exists subscriptions_user_id_idx
  on public.subscriptions (user_id);

-- Index for expiration-date queries (reminders, stats)
create index if not exists subscriptions_trial_end_date_idx
  on public.subscriptions (trial_end_date);

-- Automatically update updated_at on every row modification
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- Enable Row Level Security.
-- No public policies are created here — all access goes through the service_role key.
alter table public.subscriptions enable row level security;
