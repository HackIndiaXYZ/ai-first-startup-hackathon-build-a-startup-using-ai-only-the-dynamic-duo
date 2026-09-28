-- =============================================================================
-- Migration: 002_create_auth_tables.sql
-- Description: Creates the sessions and gmail_tokens tables for TrialGuard
--              Phase 3 (Gmail OAuth integration).
--
-- Run this once against your Supabase project using the SQL Editor or CLI:
--   supabase db push   (if using Supabase CLI)
--   — OR —
--   Paste into Supabase Dashboard → SQL Editor → Run
--
-- WARNING — SINGLE-USER PROTOTYPE:
--   RLS is enabled but NO public/anon policies exist. All queries run
--   server-side using the service_role key (bypasses RLS). Do NOT open
--   public access policies until per-user authentication is designed.
--
-- SECURITY:
--   encrypted_access_token and encrypted_refresh_token hold AES-256-GCM
--   ciphertext ONLY, stored as a self-contained base64(iv:ciphertext:authTag)
--   string. Plaintext OAuth tokens are never written to any column. The
--   encryption key lives only in backend/.env (TOKEN_ENCRYPTION_KEY) and is
--   never logged, committed, or sent to the frontend.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- sessions — opaque browser-session registry.
-- The session cookie contains ONLY `id` (a random 256-bit hex string).
-- `google_sub` stays NULL until the OAuth callback completes, so a session
-- row alone never proves authentication.
-- -----------------------------------------------------------------------------
create table if not exists public.sessions (
  id          text        primary key,                 -- crypto.randomBytes(32).toString('hex'); generated backend-side, no DB default
  google_sub  text        null,                        -- Google account id; populated only after a successful OAuth callback
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '30 days')
);

-- Expiry checks and cleanup queries scan by expires_at.
create index if not exists sessions_expires_at_idx
  on public.sessions (expires_at);

-- -----------------------------------------------------------------------------
-- gmail_tokens — encrypted OAuth token storage. One row per connected Google
-- account, keyed by google_sub (Google's stable account identifier).
-- -----------------------------------------------------------------------------
create table if not exists public.gmail_tokens (
  id                       uuid        primary key default gen_random_uuid(),
  google_sub               text        not null unique,   -- one token row per Google account; the join key for sessions.google_sub
  email                    text        not null,          -- Gmail address, plaintext — display only, not a secret
  encrypted_access_token   text        not null,          -- AES-256-GCM ciphertext (iv:ct:tag, base64). Never plaintext.
  encrypted_refresh_token  text        null,              -- NULL is valid: Google reissues refresh tokens only on first consent
  token_expiry             timestamptz not null,          -- access-token expiry; scanner refreshes ~5 min early
  scope                    text        not null,          -- scope string Google actually granted; verify gmail.readonly
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- Reuse set_updated_at() from migration 001 — no new function is created.
drop trigger if exists gmail_tokens_set_updated_at on public.gmail_tokens;
create trigger gmail_tokens_set_updated_at
  before update on public.gmail_tokens
  for each row execute function public.set_updated_at();

-- Enable Row Level Security.
-- No public policies are created here — all access goes through the service_role key.
alter table public.sessions   enable row level security;
alter table public.gmail_tokens enable row level security;

-- Cleanup orphaned token rows (run manually if needed) — a token row whose
-- account is no longer referenced by any authenticated session (e.g. the user
-- cleared cookies without clicking Disconnect):
--   DELETE FROM public.gmail_tokens gt
--     WHERE NOT EXISTS (
--       SELECT 1 FROM public.sessions s WHERE s.google_sub = gt.google_sub
--     );
