# CP5 — Save Selected Subscriptions (revised implementation plan, v2)

Status: **PLANNING ONLY — architecture review v2 incorporated. No code, migrations, Supabase writes, Gmail scans, commits, or pushes performed.**

Approved decisions: D1 nullable `plan_name`/`currency`; D2 unknown currency stored as NULL (never `'USD'`); D3 revised duplicate prevention (§5); D4 save cap 10/request; D5 demo records labeled and separated (§7).

Corrections applied: candidate authenticity via server-issued scan references (§4), DB-only uniqueness on `(owner_sub, source_message_id)` (§5.2), server-side-only ownership (§6), demo-data separation (§7), full NOT NULL/default audit (§3), minimal-field privacy (§8), per-item UX outcomes (§9), regression/security tests (§11), rollback (§12).

## 1. Current-state facts (unchanged but re-verified for v2)

- `subscriptions` (migration 001): `user_id uuid NULL`; `service_name`, `plan_name`, `trial_start_date`, `trial_end_date`, `price` NOT NULL; `currency` NOT NULL DEFAULT `'USD'`; `status` CHECK (`active|expired|cancelled`); `cancellation_url` NULL; RLS on, service-role-only access.
- Identity: `sessions.google_sub` (non-null only after a verified OAuth callback); `gmail_tokens` keyed by `google_sub`, AES-256-GCM ciphertext.
- `GET /` and `GET /:id` are unauthenticated and unscoped (v2 §6 fixes this).
- Scanner DTO (12 fields, all nullable except `classification` and `sourceMessageId`): `sourceMessageId`, `classification`, `serviceName`, `trialEndDate`, `renewalDate`, `invoiceDate`, `cancellationDeadline`, `paymentDeadline`, `paymentIssueType`, `price`, `currency`, `confidence`. The frontend whitelist (`scanApi.js`) already enforces exactly this shape.
- Selection state: `useScanNow.selectedIds` (Set of `sourceMessageId`s), reset on every scan and on disconnect — never persisted today.

## 2. NOT NULL / default audit against the nullable DTO (correction 5)

Every existing column mapped, with the save-time resolution rule ("never invent data"):

| Column | Current | Scan DTO field | Save resolution |
|---|---|---|---|
| `service_name` | NOT NULL | `serviceName` (always present in candidates) | Required; reject candidate if absent |
| `plan_name` | NOT NULL | — | **DROP NOT NULL** (v2: nullable, shows "Unknown") |
| `trial_start_date` | NOT NULL | — | **DROP NOT NULL** (never invented) |
| `trial_end_date` | NOT NULL | `trialEndDate` | **DROP NOT NULL** |
| `price` | NOT NULL + `CHECK price >= 0` | `price` | **DROP NOT NULL** (CHECK kept for non-null values) |
| `currency` | NOT NULL DEFAULT `'USD'` | `currency` | **DROP NOT NULL; NULL stays NULL** (D2 — the column default no longer applies on explicit NULL) |
| `status` | NOT NULL, CHECK | — | Always `'active'` on save (constant, not invented data) — unchanged |
| `cancellation_url` | NULL | — | Native URL for self-cancel is NOT extraction MVP; stays NULL (future extraction) |
| `renewalDate` / `paymentDeadline` / `paymentIssueType` / `invoiceDate` / `cancellationDeadline` | not columns today | DTO fields | **NEW nullable columns** so scan-facts persist losslessly (§3) |

No values fabricated anywhere: absent data → NULL → UI "Unknown".

## 3. Migration 004 (exact SQL proposal — execution blocked pending approval)

```sql
-- =============================================================================
-- Migration: 004_save_selected_subscriptions.sql (proposal — DO NOT RUN yet)
-- Idempotent. Adds ownership/provenance + scan-fact columns, relaxes NOT NULLs
-- for scan-derived rows, adds uniqueness scoped to (owner, source message id),
-- labels the six demo rows, and creates supporting indexes. NO existing column
-- value is changed; the six demo rows keep their IDs and all current values
-- (the one-time UPDATE below touches ONLY the new `source` column).
-- =============================================================================
alter table public.subscriptions
  add column if not exists owner_sub         text null,
  add column if not exists source            text not null default 'manual',
  add column if not exists source_message_id text null;

-- Scan-fact columns (nullable; lossless persistence of the approved DTO)
alter table public.subscriptions
  add column if not exists renewal_date        date null,
  add column if not exists payment_deadline    date null,
  add column if not exists payment_issue_type  text null
    check (payment_issue_type in ('payment_failed','payment_action_required','access_expiring')),
  add column if not exists invoice_date        date null,
  add column if not exists cancellation_deadline date null;

-- Relax per the audit in §2 (DROP NOT NULL on an already-nullable column is a no-op)
alter table public.subscriptions
  alter column plan_name        drop not null,
  alter column trial_start_date drop not null,
  alter column trial_end_date   drop not null,
  alter column price            drop not null,
  alter column currency         drop not null;

-- Provenance vocabulary: 'demo' = seeded fiction; 'scan' = user-saved from scan;
-- 'manual' kept for any pre-existing/future non-demo direct insert (default).
alter table public.subscriptions drop constraint if exists subscriptions_source_check;
alter table public.subscriptions
  add constraint subscriptions_source_check check (source in ('demo','manual','scan'));

-- Label the six demo rows (fixed seed IDs — exact match, no others touched)
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

-- D3 (corrected): uniqueness scoped to owner + source message ID only.
-- No service_name/plan_name uniqueness (legitimate duplicates allowed).
create unique index if not exists subscriptions_owner_msgid_unique
  on public.subscriptions (owner_sub, source_message_id)
 where source_message_id is not null;

create index if not exists subscriptions_owner_sub_idx on public.subscriptions (owner_sub);
create index if not exists subscriptions_source_idx    on public.subscriptions (source);
```

## 4. Candidate authenticity — server-issued scan references (correction 1)

**Principle: the save endpoint never reads candidate data from the request.** The frontend sends only a scan reference + message IDs; the server resolves candidates from data it itself derived during the verified-session scan.

### 4.1 `POST /api/scan` extension
After a successful scan, `scan.js` calls the new service (`src/services/scanReferenceCache.js`) with the **already-sanitized candidate DTOs** (whitelist, exactly as sent to the UI — no bodies, no snippets, no headers, no tokens; the scanner has discarded `messages.get` payloads by then) and gets back:

```jsonc
// added to the existing 200 response:
"scanRef": "<opaque token>",              // crypto.randomBytes(32).toString('base64url') — 256-bit, key itself
"scanRefExpiresAt": "2026-10-20T10:12:00.000Z"  // informational for the UI
```

The DTO sent to the UI keeps only `scanRef` and `scanRefExpiresAt` — NOT the cache contents.

### 4.2 Cache invariants (module-level, process-local)
- **Storage:** `Map<ref, { googleSub, expiresAt, candidates: Map<sourceMessageId, dto> }>` in backend memory. Nothing persisted to Supabase, cookies, files, or logs.
- **Contents:** sanitized candidate DTOs only — never message bodies, snippets, headers, tokens, or emails (correction 6). Bounded: candidates per ref clamped to the scanner's own caps (≤ 50).
- **Expiry:** fixed TTL `SCAN_REF_TTL_MS = 10 * 60 * 1000` from issue time. Not extended on use. Expired refs are evicted lazily on the next `issue/get` (no timers, no background daemon — manual-by-design).
- **Memory bound:** `MAX_REFS = 32` per process; issuing ref #33 evicts the oldest (insertion-order eviction via Map). Each ref ≤ 50 small DTOs → worst case ≈ 32 × 50 × ~0.5 KB ≈ 800 KB.
- **Restart semantics:** refs die with the process; a stale frontend ref then errors with the same `scan_expired` code — the UX tells the user to scan again. No persistence, therefore no leak surface.

### 4.3 Validation at save time (`scanRef` + `messageIds` from the body)
1. Shape: `scanRef` is a 43-char base64url token; `messageIds` is an array of 1–10 Gmail-id-shaped strings (D4 cap enforced server-side; duplicate ids in one body are collapsed).
2. Lookup: ref exists in cache **and** `entry.googleSub === req.session.google_sub` **and** `now < expiresAt`. On any mismatch → HTTP 409 `{ error: 'scan_expired', message: user-facing "Run a new scan…" }`. A ref belonging to another account is indistinguishable from an expired one (no oracle).
3. Resolution: each requested `sourceMessageId` must exist in **that ref's** candidate map; ids not present become per-item `failed: { reason: 'not_in_scan' }` (typical case: user saved a scan different from the one they make selections in).
4. Even though cache entries were whitelisted at scan time, each resolved DTO passes the save-time validators again (§5.1) — a cached ref never bypasses validation.
5. Frontend never transmits candidate fields; `ConnectEmail.jsx`/"save" service sends `{ scanRef, messageIds }` only. This removes trust in client DTOs entirely (correction 1).

## 5. Duplicate handling (correction 2 / D3 revised)

- **Strict uniqueness:** partial unique index `(owner_sub, source_message_id) WHERE source_message_id IS NOT NULL` (§3) — the ONLY uniqueness rule Gmail-derived rows answer to. Two legitimate saves of "CloudMind AI (Pro Seat)" from different emails, or of the same service with different plans, both succeed.
- **Idempotency + concurrency:** inserts run as Supabase `upsert(..., onConflict: 'owner_sub,source_message_id', ignoreDuplicates: true)` returning inserted rows; rows absent from the return = already saved. Under concurrent double-clicks both requests hit the same DB statement and the partial index arbitrates — neither can produce a duplicate row (the DB is the referee; no app-level last-write decision).
- **Intra-request dedupe:** collapsing repeated ids in one body BEFORE the batch (§4.3) so one click can't half-run on its own duplicates.
- **Cross-account saves of the same message id are NOT duplicates** (unique key includes `owner_sub`), which is correct: two different accounts can legitimately save their respective copies.
- **Friendly pre-check, not error:** a row whose `(owner_sub, source_message_id)` already exists returns as `alreadySaved` (HTTP 200, per-item result), never a 500 and never a silent drop.

## 6. Ownership & authorization (corrections 1 & 3)

- Owner resolution: `owner_sub = req.session.google_sub` after `session({ requireAuth: true })`. **No request-supplied ownership identifier (`owner_sub`, `user_id`, email…) is ever read** — the save/GET code paths do not even look at those body fields; the body whitelist in `scanApi`/`saveApi` makes their transmission unrepresentable.
- **Route hardening — exact rules:**
  - `POST /api/subscriptions/save-selected`: `requireAuth`; inserts only for the session's `google_sub`.
  - `GET /api/subscriptions`: **requires a session; when the session has a `google_sub`, returns rows `owner_sub = google_sub OR owner_sub IS NULL (demo)`**. When unauthenticated, returns ONLY `owner_sub IS NULL` demo rows (six) — private data is never reachable without an authenticated session, and demo data keeps the existing dashboard functioning.
  - `GET /:id`: same predicate applied to the single-row lookup; a row owned by another account returns 404 (not 403 — no existence oracle for foreign rows). Unauthenticated callers may fetch only demo rows.
  - No `POST`/`PUT`/`DELETE` on user-owned rows exists anywhere else in CP5 — nothing in any route can modify or expose another user's rows.
- `user_id` (legacy uuid) is never populated by CP5 and never readable from the body; demo rows keep it NULL.

## 7. Demo data (D5)

- Six seeded rows preserved exactly (IDs and all existing values). The one-time `UPDATE ... SET source='demo'` touches only the NEW column and matches exactly the six fixed seed IDs (§3). Seed rows never get `owner_sub` and are never writable by `save-selected`.
- Separation at every layer: `source='demo'` vs `'scan'` on each row; `toClient` gains `source`; frontend distinguishes visually (a "Demo data" badge in the dashboard list; saved rows carry a "Saved from Gmail" provenance line) and in any later "yours vs all" filter. A demo row can never receive an `owner_sub`.
- SELECT deny for `save-selected` writes: insert path carries `source='scan'` server-side; the body cannot set `source`, `source_message_id` mismatch against the ref, or anything else (§4.3 item 5).

## 8. Privacy (correction 6)

- Columns added/write-path = minimum viable management set: identity (`owner_sub`), provenance (`source`, `source_message_id`), whitelist DTO facts (`service_name`, `plan_name` nullable, dates incl. `payment_deadline`/`renewal_date`/`payment_issue_type`/`invoice_date`/`cancellation_deadline`, `price`, `currency`, `confidence`), plus `status='active'` constant and NULL `cancellation_url`.
- **Never stored:** message bodies, snippets, headers, `raw` payloads, URLs, access/refresh tokens, session ids, emails. The new environment scans the insert: only whitelisted DTO fields ever move from cache→row.
- `scanRef` (opaque, process-on memory) is the only derived artifact; it dies with the process or after ≤10 min.

## 9. User experience & endpoint contract (correction 7, corrections 1–2 applied)

### `POST /api/subscriptions/save-selected` (exact contract)
**Request** (auth = verified session's `google_sub`; nothing else is honored):
```jsonc
{ "scanRef": "A93fk...", "messageIds": ["msg-a", "msg-b"] }   // 1..10 ids
```
**Response 200** (never throws partial failure; per-item truth):
```jsonc
{
  "saved":        [ /* full sanitized row DTOs incl. id, source:'scan' */ ],
  "alreadySaved": [ "msg-b" ],           // idempotent replays reconcile here
  "failed":       [ { "sourceMessageId": "msg-c", "reason": "not_in_scan" } ]
}
```
Per-item `reason` vocabulary: `not_in_scan`, `invalid_fields`, `db_error` (rare; sanitized).
**Error responses (whole-request):** 401 unauthenticated (`error: 'Not connected.'` — scan-route parity); 409 `scan_expired`; 400 malformed body; 502 `db_unavailable` (sanitized).
- No candidate content in any log. Errors log route + generic messages only (pattern reused from `/scan`).

### Frontend flow
1. Scan completes → DTO includes `scanRef`/`scanRefExpiresAt` (never rendered).
2. Each candidate keeps today's "Save later" checkbox — explicit selection, never predicated on scan or round-trips.
3. With ≥1 selection: 2-step confirm — the button first renders "Saving saves N to your list…", then click → **"Save N"**; once pressed, per-item status panel drives the outcome.
4. Results: `Saved K (listing distinct names + dates)`, `Already saved M`, `Failed F (reasons; checkbox selections remain ticked for retry)`. `selectedIds` clears ONLY for ids that returned saved/alreadySaved; failed/still-failed stay selected. Scan refs expired → banner prompting a fresh scan; selections then reset (a new scan always resets selection — existing invariant).
5. Nothing saves without both the checkbox AND the confirm click; there is no auto-save path anywhere.

## 10. Routes/files touched (implementation stage — none changed yet)

- Backend: `subscriptions.js` (route hardening + `save-selected`; `toClient` gains `source`, nullable-field passthrough), `scan.js` (issue `scanRef` on success), **new** `src/services/scanReferenceCache.js` (+ its own unit script approach), **new** `scripts/test-save-selected.js`; NO changes to `gmailScanner.js`, `detectionRules.js`, `tokenEncryption.js`, `googleOAuth.js`, `session.js`, `supabaseClient.js`.
- Frontend: `saveApi.js` (**new** minimal service — sends only `{scanRef, messageIds}`, whitelists responses), `useScanNow.js` (extend to own save state machine per §9), `ConnectEmail.jsx` (+tests), `Dashboard.jsx` (+tests, demo badge). No dependency additions (D5: zero new packages — everything remains `require('crypto')`/fetch-level).

## 11. Regression & security tests (all with the existing fake-client harness pattern; NO live Supabase)

**Backend (`scripts/test-save-selected.js`, ~30 assertions):**
1. Auth: no session → 401; session without `google_sub` → 401; `google_sub` in body ignored (insert uses session's value).
2. Ref correctness: happy path saves with correct `owner_sub/source/source_message_id`; DTO-vs-cache binding (ref B's id against ref A → `not_in_scan`); foreign-`google_sub` ref → 409 `scan_expired`; expired ref → same; >10 ids → 400; 0 ids → 400; unknown ref → 409.
3. Duplicate: repeat ref+ids → all `alreadySaved`, zero new rows; concurrent double-insert race (two inserts same keys) → one saved, one `alreadySaved` (uniqueness referee); same message id, different owner → distinct rows (isolation).
4. Validation: missing `serviceName`; bad date strings; negative price; bad `paymentIssueType`; unknown extra body fields (any of them) → `invalid_fields` per-item without blocking valid siblings; currency null stays null (D2) — seeded via validator test.
5. Scan.js: ref issued on success only; error path never references the cache; response exposes `scanRef` but never list contents.
6. ownership hardening: `GET` unauth → demo-only; auth → own+demo; other-owner row by id → 404 (no oracle); demo rows never receive `owner_sub`.
7. Demo preservation (hard gate): aggregate checksum/count assert — before save: 6 demo rows with fixed IDs; after 1 save: still exactly 6 demo rows unchanged + 1 new `'scan'` row; unchanged service runs re-run backfill (idempotent no-op).

**Frontend Vitest (~10 new):** save button appears only with ≥1 selection; 2-step confirm; API contract — request body contains ONLY `scanRef`+`messageIds`(no candidate objects, no ownership fields); per-item outcome rendering; failed ids stay selected; new scan resets selection+scan state; dashboard demo badge renders for `source:'demo'` and not for `'scan'`.

**Security review pointers:** client cannot inject rows via crafted bodies (nothing read from body except ids+ref); cache never stores private message content; ref binding prevents cross-account replay; uniqueness referee is the DB, not app state.

## 12. Rollback approach

- **Data:** 004 introduces no rows and changes no existing column values (only the six demo rows' NEW `source` marker). Full rollback SQL (executed only if needed): delete `WHERE source='scan'` → drop indexes `subscriptions_owner_msgid_unique, subscriptions_owner_sub_idx, subscriptions_source_idx` → drop added columns (`owner_sub, source, source_message_id, renewal_date, payment_deadline, payment_issue_type, invoice_date, cancellation_deadline`) → restore `NOT NULL` on `plan_name, trial_start_date, trial_end_date, price, currency` (possible only after deleting scan-derived rows, which is why deletion comes first). Resulting state byte-for-byte equals pre-004 for seeds (their `source` marker disappears with the column; their seeded values were never touched).
- **Code:** `save-selected` route removal returns every save attempt to a graceful 404; frontend save button then shows "Saving is unavailable — please update TrialGuard" (fails open with no data-loss risk). Cache livability deadlines: refs never persisted, so a backend version-restart simply invalidates refs (explicit UX copy in §4.2).
- **No Supabase policy/RLS changes:** v2 keeps service-role-only access, so rollback has no side-effects beyond the columns above.

## 13. Explicitly out of scope (unchanged)

CP6; subscriptions editing/deleting; OAuth/encryption changes; background/scheduled scanning; RLS public policies; new npm dependencies; storing `cancellation_url` extraction; commits/pushes.
