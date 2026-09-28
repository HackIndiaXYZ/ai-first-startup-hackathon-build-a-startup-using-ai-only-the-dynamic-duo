-- =============================================================================
-- Migration: 003_add_oauth_state_to_sessions.sql
-- Description: Adds the one-time OAuth state column to the existing sessions
--              table for TrialGuard Phase 3A. No existing columns change;
--              no data is written or removed.
--
-- Run manually in Supabase SQL Editor (idempotent).
-- =============================================================================

-- oauth_state — one-time CSRF state for the OAuth authorization attempt
-- currently in flight for this session.
--
-- Written by GET /api/auth/google (32 random bytes, base64url) when the
-- authorization redirect is issued. On callback, the session is resolved by
-- its primary key (sessions.id from the signed cookie), the callback state is
-- compared against the stored value with a timing-safe comparison, and only
-- after a successful match is oauth_state cleared — immediately, and before
-- the authorization code is exchanged. A mismatched, missing, or replayed
-- state rejects the callback without any token work, and a replayed callback
-- afterwards finds no pending oauth_state and fails. NULL in steady state.
-- Never returned to the frontend, never used as a lookup key.
alter table public.sessions
  add column if not exists oauth_state text null;
