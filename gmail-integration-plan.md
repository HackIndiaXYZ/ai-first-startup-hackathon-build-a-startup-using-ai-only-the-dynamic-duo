# TrialGuard — Phase 3 Gmail Integration Plan (Revised)

## Top-Level Overview

Phase 3 adds Gmail OAuth 2.0 connection, server-side token management with encryption at
rest, and keyword-based subscription email discovery to TrialGuard. It is divided into
three sequential milestones that must be implemented and tested in order:

- **Phase 3A** — Secure OAuth flow: opaque session ID, pre-OAuth session creation, state
  binding, encrypted token storage, connection status, and disconnect with cleanup.
- **Phase 3B** — Gmail API scanning: use stored encrypted tokens to query Gmail with
  subscription-related keywords, persist email metadata only, and expose scan results
  via a dedicated endpoint.
- **Phase 3C** — Frontend review UI: a new "Connect Email" page showing connection status,
  scan trigger, and a reviewable list of discovered candidate emails. Discovered emails are
  never automatically added to the subscriptions table.

**Constraints carried forward from earlier phases:**
- No TypeScript, Next.js, Python, Docker, Prisma, or LangChain.
- All OAuth secrets, session state, and tokens stay on the backend only.
  The React frontend never receives tokens, encryption keys, or raw Google credentials.
- Gmail scope: `https://www.googleapis.com/auth/gmail.readonly`
  This is a RESTRICTED scope. Google may require app verification and additional
  security review before approving public deployment. For the hackathon prototype,
  TrialGuard operates in testing mode with manually added test users in the Google
  Cloud Console. Do not submit to Google verification review for the hackathon.
- Token storage: new `gmail_tokens` table in Supabase, with access tokens and refresh
  tokens encrypted at rest using AES-256-GCM before being written to the database.
- User identity within a session: an opaque, cryptographically random session ID stored
  in a signed httpOnly cookie. The session ID maps to a server-side record; it is never
  derived from or equal to the Google `sub` claim or any token value.
- AI extraction and cancellation automation are out of scope for Phase 3.
- Discovered emails are potential subscription signals only. Metadata-only scanning
  cannot reliably confirm trial dates or billing terms. Never automatically create
  subscriptions table rows from scan results. Detailed extraction is deferred to Phase 4.
- Phase 1 and Phase 2 functionality must remain fully working throughout.

**Single-user prototype warning:**
This design is scoped for one connected Gmail account at a time as a hackathon demo.
It is NOT suitable for multi-user public deployment without per-user authentication,
isolated session stores, and a proper secrets management strategy.

---

## Security Model Summary

The following decisions apply across all three phases and must be respected uniformly:

### Session design
- A new opaque session ID is created BEFORE the OAuth redirect, not after.
- The session ID is generated using `crypto.randomBytes(32)` and stored in a
  `sessions` table in Supabase, with a `google_sub` column populated only after
  the OAuth callback succeeds.
- The session cookie carries only this opaque ID — never the Google `sub` claim,
  never a token value, never an email address.
- Session ownership is verified on every protected request by looking up the session
  ID in the database. A session without a matching `google_sub` is not authenticated.

### OAuth CSRF protection
- When the OAuth redirect is initiated, the session ID is stored server-side and the
  `state` parameter passed to Google is a signed HMAC of the session ID (using
  `SESSION_SECRET`). On callback, the state is re-derived from the session ID in the
  cookie and compared to the returned `state`. A mismatch aborts the flow.
- This binds the OAuth callback to the exact session that initiated it.

### Token encryption at rest
- Access tokens and refresh tokens are encrypted using AES-256-GCM before being
  written to the `gmail_tokens` table. Encryption uses a key derived from
  `TOKEN_ENCRYPTION_KEY` (a 32-byte hex string stored in `backend/.env`).
- The encryption key never leaves the backend process and is never written to any
  log, API response, or database column.
- Decryption happens in memory, immediately before the token is passed to the
  Google API client. Decrypted token values are never assigned to long-lived variables.
- Each encrypted value stores its own IV (initialisation vector) alongside the
  ciphertext so that IV reuse across rows is impossible.

### Refresh token preservation
- `prompt: consent` and `access_type: offline` are requested to allow refresh token
  issuance. However, Google does NOT issue a new refresh token on every consent —
  it only issues one when no valid refresh token exists for the client.
- On the OAuth callback upsert: if Google returns a new refresh token, store it
  (encrypted). If Google does not return a refresh token and a valid encrypted one
  already exists in the database row, KEEP the existing one. Never overwrite a valid
  refresh token with null.

### Session and token expiry / cleanup
- Session rows have a `expires_at` column. Sessions expire 30 days after creation.
- `requireSession` middleware rejects sessions where `expires_at` is in the past and
  deletes the expired session row.
- When a user disconnects: revoke the Google access token (best-effort), delete the
  `gmail_tokens` row, delete the `sessions` row, and clear the session cookie.
- Orphaned token rows (gmail_tokens rows whose session_id no longer exists in the
  sessions table) can accumulate if a user clears cookies without disconnecting.
  A cleanup query in the disconnect handler and a documented manual SQL cleanup
  statement in the migration file address this for the prototype.

### What is never logged
- Access tokens, refresh tokens, encrypted ciphertext values, IVs.
- The `TOKEN_ENCRYPTION_KEY` value.
- The `SESSION_SECRET` value.
- Any Google API credential material.
- Full email body content.

---

## Phase 3A — Secure Gmail OAuth Connection

### Intent
Allow a user to connect their Gmail account via OAuth 2.0. Create a session before the
redirect. Bind the OAuth `state` to that session. On callback, validate state, decrypt
nothing yet, store encrypted tokens, populate the session's `google_sub`, and set the
session cookie. Provide status and disconnect endpoints. Preserve any valid existing
refresh token on reconnect.

### Expected Outcomes
- The Connect Email page shows "Not connected" or "Connected as user@gmail.com"
  based on whether the current session has a linked `google_sub` in the database.
- Clicking "Connect Gmail" creates a server-side session, then redirects to Google.
- After consent, tokens are encrypted and stored; the session is updated; the browser
  lands on `/connect-email` with a working session cookie.
- Clicking "Disconnect" revokes the access token, deletes both the token row and the
  session row, clears the cookie, and redirects to the unauthenticated state.
- `/api/health` works with no cookies and is unaffected by all auth machinery.
- No token value, encryption key, or `sub` claim is ever sent to the React frontend.

### Todo List

1. **Install backend OAuth and session dependencies**
   - Add `googleapis` to `backend/package.json` dependencies.
   - Add `cookie-parser` to `backend/package.json` dependencies.
   - `crypto` is a built-in Node.js module — no install needed.
   - Update `backend/.env.example` with all new variables (see Cross-Cutting section).

2. **Create migration 002 — sessions and gmail_tokens tables**
   - New file: `backend/migrations/002_create_auth_tables.sql`
   - **Table: `sessions`**
     - `id` text primary key — the opaque random session ID (hex string)
     - `google_sub` text null — populated after OAuth callback; null means not yet authed
     - `created_at` timestamptz not null default now()
     - `expires_at` timestamptz not null — set to `now() + interval '30 days'` on insert
   - Index on `expires_at` for cleanup queries.
   - **Table: `gmail_tokens`**
     - `id` uuid primary key default gen_random_uuid()
     - `google_sub` text not null unique — stable Google account identifier
     - `email` text not null — Gmail address, stored in plaintext for display only
     - `encrypted_access_token` text not null — AES-256-GCM ciphertext + IV, base64 encoded
     - `encrypted_refresh_token` text null — same format; nullable (may not be reissued)
     - `token_expiry` timestamptz not null
     - `scope` text not null
     - `created_at` timestamptz not null default now()
     - `updated_at` timestamptz not null default now()
   - Add `set_updated_at` trigger on `gmail_tokens` (same function as `subscriptions`).
   - Enable RLS on both tables; no public policies.
   - Add a comment in the migration file with a manual orphan-cleanup query:
     ```sql
     -- Cleanup orphaned token rows (run manually if needed):
     -- DELETE FROM gmail_tokens WHERE google_sub NOT IN (SELECT google_sub FROM sessions WHERE google_sub IS NOT NULL);
     ```

3. **Create the token encryption utility**
   - New file: `backend/src/services/tokenEncryption.js`
   - Reads `TOKEN_ENCRYPTION_KEY` from env (required: 64-char hex string = 32 bytes).
   - Exports:
     - `encrypt(plaintext)` — generates a random 12-byte IV, encrypts with AES-256-GCM,
       returns a single base64-encoded string containing `iv:ciphertext:authTag` so each
       stored value is self-contained.
     - `decrypt(stored)` — splits the stored string, derives IV, ciphertext, and auth tag,
       decrypts and returns the plaintext. Throws a named `DecryptionError` on failure.
   - Neither function logs its input or output.
   - Throws a clear startup error if `TOKEN_ENCRYPTION_KEY` is absent or not 64 hex chars.

4. **Create the Google OAuth helper module**
   - New file: `backend/src/services/googleOAuth.js`
   - Reads `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` from env.
   - Exports:
     - `getOAuthClient()` — lazy singleton `google.auth.OAuth2` instance. Returns null
       and logs a warning (not a crash) if credentials are absent, so callers can return 503.
     - `getAuthUrl(state)` — generates the consent URL with `access_type: 'offline'`,
       `prompt: 'consent'`, the `gmail.readonly` scope, and the provided state value.
     - `exchangeCode(code)` — exchanges the auth code for tokens; returns
       `{ tokens, sub, email }` where `sub` and `email` are decoded from the ID token.
       Throws a named `OAuthExchangeError` on failure — never re-throws raw Google errors.
     - `refreshAccessToken(encryptedRefreshToken)` — decrypts the refresh token in memory,
       calls the Google refresh endpoint, returns `{ newAccessToken, newExpiry }`.
       The decrypted value is not retained beyond the function call.
     - `revokeToken(encryptedAccessToken)` — decrypts in memory, calls Google's revoke
       endpoint. Errors are caught and logged server-side; the caller is not expected to
       handle revocation failures as blocking.

5. **Create the session middleware module**
   - New file: `backend/src/middleware/session.js`
   - Exports:
     - `createSession(res)` — generates `crypto.randomBytes(32).toString('hex')`, inserts
       a row into `sessions` with `google_sub: null`, sets the signed httpOnly session
       cookie (`trialguard_session`), and returns the new session ID.
     - `setSessionCookie(res, sessionId)` — sets the cookie. Attributes: `httpOnly: true`,
       `sameSite: 'lax'`, `signed: true`, `maxAge: 30 days`,
       `secure: process.env.NODE_ENV === 'production'`.
     - `clearSessionCookie(res)` — expires the cookie immediately.
     - `requireSession` — Express middleware that:
       1. Reads `req.signedCookies['trialguard_session']`.
       2. Returns 401 if absent or HMAC invalid.
       3. Queries the `sessions` table by ID.
       4. Returns 401 if not found or `expires_at` is past (and deletes the stale row).
       5. Returns 401 if `google_sub` is null (session exists but OAuth not completed).
       6. Attaches `req.sessionId` and `req.googleSub` and calls `next()`.
   - Uses `getClient()` from `supabaseClient.js` for DB queries.

6. **Create the auth routes**
   - New file: `backend/src/routes/auth.js`
   - Returns 503 from all routes (except `/status`) if `getOAuthClient()` returns null.
   - **`GET /api/auth/google`**
     - Calls `createSession(res)` to get a new `sessionId`.
     - Derives `state = HMAC-SHA256(sessionId, SESSION_SECRET)` using Node.js `crypto`.
     - Calls `getAuthUrl(state)` and redirects the browser.
   - **`GET /api/auth/google/callback`**
     - Reads `sessionId` from the signed session cookie.
     - Re-derives the expected state and compares to `req.query.state`. Aborts with 400
       on mismatch — this is the CSRF check.
     - Calls `exchangeCode(req.query.code)` to get `{ tokens, sub, email }`.
     - Encrypts `tokens.access_token` and (if present) `tokens.refresh_token` using
       `tokenEncryption.encrypt()`.
     - Upserts into `gmail_tokens`:
       - Always updates `encrypted_access_token`, `token_expiry`, `scope`, `email`.
       - Only updates `encrypted_refresh_token` if the new value is non-null (preserves
         existing valid refresh token when Google does not issue a replacement).
     - Updates the `sessions` row to set `google_sub = sub`.
     - Redirects browser to `FRONTEND_URL + '/connect-email'` (no sensitive data in URL).
     - On any error: clears the session cookie and redirects to
       `FRONTEND_URL + '/connect-email?error=auth_failed'`.
   - **`GET /api/auth/status`**
     - Does NOT require `requireSession` — safe to call without a cookie.
     - Reads the session cookie if present; looks up the session row.
     - If the session row has a `google_sub`, queries `gmail_tokens` for the email address.
     - Returns `{ connected: true, email }` or `{ connected: false }`.
     - Never returns `sub`, tokens, session IDs, or any credential.
   - **`POST /api/auth/disconnect`**
     - Requires `requireSession`.
     - Loads `encrypted_access_token` from `gmail_tokens` for `req.googleSub`.
     - Calls `revokeToken(encrypted_access_token)` — best effort, logs failure, continues.
     - Deletes the `gmail_tokens` row for `req.googleSub`.
     - Deletes the `sessions` row for `req.sessionId`.
     - Calls `clearSessionCookie(res)`.
     - Returns `{ success: true }`.
   - Mount at `/api/auth` in `backend/index.js`.

7. **Wire cookie-parser into the Express app**
   - In `backend/index.js`, add `cookieParser(process.env.SESSION_SECRET)` before all
     route mounting. Signed cookies require the secret to be passed here.

### Relevant Context
- Lazy-singleton pattern for config validation: `backend/src/db/supabaseClient.js`.
- 503-on-missing-config pattern: `backend/src/routes/subscriptions.js:31-34`.
- Error sanitisation: `backend/src/middleware/errorHandler.js`.
- No existing session, auth, or token handling in the codebase — clean slate.
- Vite proxy forwards `/api/*` to port 3001, so the session cookie set at port 3001
  will be sent by the browser on all subsequent `fetch('/api/...')` calls through
  the proxy, provided `credentials: 'include'` is set in fetch options.
  The `frontend/src/services/api.js` `request()` function must add
  `credentials: 'include'` so the browser sends the session cookie on every API call.

### Acceptance Criteria
- [ ] `GET /api/auth/status` returns `{ connected: false }` with no cookie.
- [ ] `GET /api/auth/google` creates a session row, sets a cookie, and redirects to Google.
- [ ] Tampered or mismatched `state` on callback returns 400 and does not store tokens.
- [ ] After valid OAuth consent, `sessions` row has `google_sub` populated.
- [ ] `gmail_tokens` row stores only ciphertext — no plaintext token in any DB column.
- [ ] `GET /api/auth/status` returns `{ connected: true, email }` with a valid session.
- [ ] Reconnecting without disconnecting preserves the existing `encrypted_refresh_token`
      when Google does not issue a new one.
- [ ] `POST /api/auth/disconnect` deletes both the `sessions` and `gmail_tokens` rows.
- [ ] `GET /api/auth/status` returns `{ connected: false }` after disconnect.
- [ ] Expired session cookie returns 401 from `requireSession`-protected endpoints.
- [ ] No token value, sub claim, or encryption key appears in any API response or server log.
- [ ] `GET /api/health` returns 200 with no cookie — completely unaffected.

### Status
[ ] pending

---

## Phase 3B — Gmail API Scanning

### Intent
Use the session and encrypted tokens established in Phase 3A to query Gmail for emails
matching subscription-related keywords. Store only metadata (subject, sender, date,
snippet) in a `scanned_emails` table. Expose results through a dedicated
`GET /api/email/results` endpoint. Handle transparent token refresh. Never store or
forward full email bodies. Never automatically create subscription records.

### Expected Outcomes
- `POST /api/email/scan` requires a valid authenticated session and returns counts only.
- Scan results are stored as potential subscription signals — not as subscriptions.
- `GET /api/email/results` returns paginated metadata for review.
- Running the scan twice does not create duplicate rows.
- Expired tokens are refreshed transparently; revoked tokens return 401.
- Google API errors never reach the client as raw messages.

### Todo List

1. **Create migration 003 — scanned_emails table**
   - New file: `backend/migrations/003_create_scanned_emails.sql`
   - **Table: `scanned_emails`**
     - `id` uuid primary key default gen_random_uuid()
     - `google_sub` text not null — FK reference to `gmail_tokens.google_sub`
     - `gmail_message_id` text not null — Gmail's stable message ID (safe to expose)
     - `subject` text — may be null if Gmail returns no Subject header
     - `sender` text — the From header value
     - `received_at` timestamptz — parsed from the Date header
     - `snippet` text — Gmail's own 200-char plain-text snippet; never extracted body content
     - `labels` text[] — Gmail label names (e.g. INBOX, CATEGORY_PROMOTIONS)
     - `reviewed` boolean not null default false — user acknowledgement flag (UI use only)
     - `created_at` timestamptz not null default now()
   - Unique constraint on `(google_sub, gmail_message_id)` — idempotency key.
   - Index on `(google_sub)` for per-user queries.
   - Index on `(google_sub, received_at DESC)` for sorted result retrieval.
   - Enable RLS; no public policies.
   - Comment in migration:
     ```
     -- scanned_emails rows are potential subscription signals discovered by keyword search.
     -- They are NOT subscriptions. Do not automatically populate the subscriptions table
     -- from this data. Manual review and AI extraction (Phase 4) are required first.
     ```

2. **Create the token encryption utility** (if not already done in Phase 3A step 3)
   - Dependency: `backend/src/services/tokenEncryption.js` must exist and be tested
     before this phase proceeds.

3. **Create the Gmail scanner service module**
   - New file: `backend/src/services/gmailScanner.js`
   - Imports `googleOAuth.js` and `tokenEncryption.js`.
   - Exports `scanInbox(googleSub)`:
     - Loads the `gmail_tokens` row for `googleSub`.
     - Decrypts the access token in memory using `tokenEncryption.decrypt()`.
     - If `token_expiry` is within 5 minutes of now, calls `googleOAuth.refreshAccessToken()`
       with the encrypted refresh token, updates the DB row with the new encrypted access
       token and expiry, then uses the new decrypted access token.
     - If refresh fails (revoked or network error), deletes the `gmail_tokens` row and
       throws a named `TokenRefreshError` so the route can return 401.
     - Constructs the Gmail search query from a centralised constant (see step 4).
     - Calls `gmail.users.messages.list` with `maxResults: 100` and the query.
     - For each message ID, calls `gmail.users.messages.get` with
       `format: 'metadata'` and `metadataHeaders: ['Subject', 'From', 'Date']`.
       Never requests `format: 'full'` or `format: 'raw'`.
     - Extracts subject, sender, date, snippet, and labelIds from the metadata response.
     - Returns an array of plain metadata objects — no token values included.
     - Logs scan start and total API call count at INFO level; never logs token values.

4. **Define the keyword search query constant**
   - Centralised in `gmailScanner.js` as a named constant, not inlined.
   - Gmail query string (subject-field OR terms):
     ```
     subject:(free trial OR trial period OR your trial starts OR subscription confirmation
              OR welcome to OR account created OR billing starts OR cancel anytime
              OR trial ends OR days left in your trial OR trial expires)
     ```
   - The query targets only the Subject field to minimise data exposure.
   - Add a comment explaining that this list is intentionally conservative and will be
     refined when AI extraction (Phase 4) is introduced.

5. **Add a configurable inter-request delay**
   - Implement a simple `sleep(ms)` utility (one line: `new Promise(r => setTimeout(r, ms))`).
   - Default delay between `messages.get` calls: `GMAIL_SCAN_DELAY_MS` env var,
     defaulting to 50ms if not set.
   - Document the var in `.env.example`. This is not a full rate-limiter — it is
     a courtesy delay to avoid quota bursts in the hackathon prototype.

6. **Create the email routes**
   - New file: `backend/src/routes/email.js`
   - All routes require `requireSession` middleware from Phase 3A.
   - **`POST /api/email/scan`**
     - Calls `scanInbox(req.googleSub)`.
     - On `TokenRefreshError`: returns 401 `{ error: 'Gmail connection lost. Please reconnect.' }`.
     - On success: upserts all results into `scanned_emails` using
       `onConflict: '(google_sub, gmail_message_id)', ignoreDuplicates: true`.
     - Returns `{ scanned: N, stored: M }` counts only — no email content in response.
   - **`GET /api/email/scan/status`**
     - Returns `{ count: N, lastScannedAt: ISO-timestamp-or-null }` for the current user.
     - Queries `scanned_emails` for count and max `created_at` where `google_sub = req.googleSub`.
   - **`GET /api/email/results`**
     - Returns paginated email metadata for the current user.
     - Query params: `page` (default 1), `limit` (default 20, max 100).
     - Orders by `received_at DESC`.
     - Returns `{ results: [...], total: N, page: P, limit: L }`.
     - Each result object: `{ id, gmailMessageId, subject, sender, receivedAt, snippet, labels, reviewed }`.
     - No token values, no google_sub, no internal IDs other than `id` (UUID).
   - Mount in `backend/index.js` at `/api/email`.

7. **Token refresh write-back**
   - After a successful refresh in `gmailScanner.js`, the DB upsert for the `gmail_tokens`
     row must apply the same refresh-token preservation rule as Phase 3A:
     only overwrite `encrypted_refresh_token` if Google returned a new one.

### Relevant Context
- `requireSession` from `backend/src/middleware/session.js` (Phase 3A).
- `tokenEncryption.js` from Phase 3A step 3 — decryption happens here, not in routes.
- `getClient()` from `supabaseClient.js` for all DB operations.
- `scanned_emails` rows are potential signals, not subscriptions. No code path writes
  to the `subscriptions` table based on scan results.
- `gmail_message_id` is not secret — it is Google's own public identifier.
- The `snippet` field comes directly from Google's API response metadata, not from
  any body parsing performed by TrialGuard.

### Acceptance Criteria
- [ ] `POST /api/email/scan` with no session returns 401.
- [ ] `POST /api/email/scan` with valid session returns `{ scanned: N, stored: M }`.
- [ ] Running scan twice: second call returns `{ stored: 0 }` (no new rows created).
- [ ] `GET /api/email/scan/status` returns count and timestamp for the current user.
- [ ] `GET /api/email/results` returns paginated metadata with correct field names.
- [ ] No `scanned_emails` row contains a token value or `encrypted_*` field.
- [ ] `subscriptions` table row count is unchanged after a scan.
- [ ] A scan with an expired but refreshable token succeeds transparently.
- [ ] A scan with a revoked token returns 401 and the `gmail_tokens` row is deleted.
- [ ] Raw Google API error messages never appear in any response body.
- [ ] Server logs contain scan count and timing but no token values.

### Status
[ ] pending

---

## Phase 3C — Connect Email Frontend Page

### Intent
Add a "Connect Email" page to the React dashboard that shows Gmail connection status,
allows OAuth initiation, triggers scans, and displays discovered candidate emails for
user review. All sensitive operations are backend-only; the frontend receives only
safe metadata (email address for display, subject lines, sender names, dates, snippets).
Discovered emails are presented as potential subscription signals requiring user review —
never as confirmed subscriptions.

### Expected Outcomes
- The Sidebar shows an active "Connect Email" nav item.
- The page has three states: unauthenticated, authenticated-no-results, and results.
- An unauthenticated user sees a clear explanation and a "Connect Gmail" button.
- An authenticated user sees their Gmail address, scan controls, and results list.
- Scan results are labelled as "Potential subscription emails found in your inbox".
- A "Disconnect" button fully reverts the connection state.
- All existing Phase 1/2 functionality is unaffected.
- `npm run lint` and `npm run build` both pass.

### Todo List

1. **Add `credentials: 'include'` to the frontend API service**
   - In `frontend/src/services/api.js`, add `credentials: 'include'` to the `request()`
     function's default fetch options. This causes the browser to send the session cookie
     on all API calls routed through the Vite proxy. Without this, the backend never
     receives the cookie.
   - This is the only change needed to the existing fetch wrapper.

2. **Add API service functions for Phase 3**
   - In `frontend/src/services/api.js`, add:
     - `getAuthStatus()` — `GET /api/auth/status` (no credentials check needed — open endpoint)
     - `triggerScan()` — `POST /api/email/scan`
     - `getScanStatus()` — `GET /api/email/scan/status`
     - `getScannedEmails(page, limit)` — `GET /api/email/results?page=P&limit=L`
     - `disconnectGmail()` — `POST /api/auth/disconnect`
   - Do NOT add a `initiateGmailConnect()` fetch function. OAuth initiation requires
     `window.location.href = '/api/auth/google'` so the browser navigates to the backend
     directly and the session cookie is set correctly. A fetch call cannot do this.

3. **Create the useGmailConnection hook**
   - New file: `frontend/src/hooks/useGmailConnection.js`
   - Calls `getAuthStatus()` on mount via `useEffect` + `useCallback`, following the
     pattern in `useSubscriptions.js`.
   - Exposes: `{ connected, email, loading, error, refresh }`.

4. **Handle the OAuth return redirect in App.jsx**
   - After OAuth completes, the backend redirects to `FRONTEND_URL + '/connect-email'`.
   - Since `App.jsx` uses state-based navigation (no router), add a `useEffect` on mount
     that checks `window.location.pathname`. If it is `'/connect-email'`, call
     `setCurrentPage('connect-email')`.
   - Also check for `?error=auth_failed` in the query string and expose it as a prop
     to the ConnectEmail page so an error banner can be shown.
   - This does not require adding `react-router-dom`.

5. **Build the ConnectEmail page**
   - New files: `frontend/src/pages/ConnectEmail.jsx` and `ConnectEmail.css`.
   - Register as `case 'connect-email'` in `App.jsx`'s `renderPage()` switch.
   - Accept an `authError` prop (boolean/string) passed from `App.jsx`.
   - **Unauthenticated state:**
     - Heading: "Connect your Gmail account"
     - Explanation paragraph (exact wording important for trust):
       "TrialGuard will read subject lines, sender names, and dates from emails
       that match subscription keywords. It does not read email body content.
       Access is read-only and can be revoked at any time."
     - "Connect Gmail" button: sets `window.location.href = '/api/auth/google'`.
     - If `authError` prop is set, show an error banner: "Connection failed. Please try again."
   - **Authenticated state:**
     - "Connected" badge showing the Gmail address.
     - "Scan Inbox" button that calls `triggerScan()`.
     - Last-scanned timestamp from `getScanStatus()`.
     - "Disconnect" button that calls `disconnectGmail()` then calls `refresh()`.
   - **Scanning in-progress state:**
     - Disable "Scan Inbox" button and show spinner while `triggerScan()` is pending.
     - Show "Scanning your inbox…" label next to the spinner.
   - **Results section** (rendered after a scan or when results exist):
     - Section heading: "Potential subscription emails found in your inbox"
     - Sub-heading note: "These are candidate emails only. Review them and confirm
       which represent real subscriptions. They will not be added automatically."
     - Renders `<ScannedEmailList emails={...} />`.
     - Pagination controls if total > limit.

6. **Build the ScannedEmailList component**
   - New files: `frontend/src/components/ScannedEmailList.jsx` and `ScannedEmailList.css`.
   - Accepts `emails` (array) prop.
   - Renders a list (not a full table on mobile) with one row per email showing:
     Subject, From, Date (formatted), and Snippet (truncated to ~120 chars with ellipsis).
   - Empty state: "No potential subscription emails found. Try scanning your inbox."
   - No delete, edit, or "add to subscriptions" actions in Phase 3.
   - Responsive: single-column on mobile, multi-column on desktop.

7. **Add "Connect Email" to Sidebar**
   - In `frontend/src/components/Sidebar.jsx`, add to `NAV_ITEMS`:
     `{ id: 'connect-email', label: 'Connect Email', icon: '✉', active: true }`
   - Position: after Dashboard, before My Subscriptions.
   - Because `active: true`, the existing disabled/Soon badge logic will not apply.

8. **Update Sidebar footer text**
   - Change "Phase 1 — MVP" to "Phase 3 — Gmail Integration".

### Relevant Context
- Navigation pattern: `App.jsx` state switch + `Sidebar.jsx` NAV_ITEMS array.
- Page pattern: `frontend/src/pages/Dashboard.jsx` — three-state layout (loading/error/content).
- Hook pattern: `frontend/src/hooks/useSubscriptions.js`.
- API service: `frontend/src/services/api.js` — `request()` wrapper.
- CSS: reuse `.spinner`, `.dashboard-state`, `.dashboard-state--error` from `Dashboard.css`.
- `window.location.href` (not fetch) required for OAuth initiation — documented in step 2.
- `credentials: 'include'` in fetch options required for cookie forwarding through proxy.

### Acceptance Criteria
- [ ] Sidebar shows active "Connect Email" item with no "Soon" badge.
- [ ] Clicking "Connect Email" renders the ConnectEmail page.
- [ ] Unauthenticated state shows explanation text and "Connect Gmail" button.
- [ ] "Connect Gmail" button navigates browser to `/api/auth/google` (no fetch).
- [ ] `authError` prop causes error banner to display.
- [ ] After OAuth, browser lands on Connect Email page showing Gmail address and "Connected" badge.
- [ ] "Scan Inbox" is disabled and shows spinner while scan is in progress.
- [ ] After scan, results section appears with correct heading labelling them as candidates.
- [ ] ScannedEmailList renders subject, sender, date, and truncated snippet per row.
- [ ] Empty state renders when no results exist.
- [ ] "Disconnect" returns page to unauthenticated state.
- [ ] Dashboard, subscription cards, and stats are completely unaffected.
- [ ] `npm run lint` passes with exit code 0.
- [ ] `npm run build` passes with exit code 0.

### Status
[ ] pending

---

## Cross-Cutting Implementation Notes

### New environment variables (add to `backend/.env.example`)
```
# Google OAuth 2.0 — never expose to frontend
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3001/api/auth/google/callback
FRONTEND_URL=http://localhost:5173

# Session signing — used by cookie-parser for HMAC verification
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=replace-with-64-char-hex-string

# Token encryption key — AES-256-GCM, must be exactly 32 bytes (64 hex chars)
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# NEVER log, commit, or send this value anywhere outside this file.
TOKEN_ENCRYPTION_KEY=replace-with-64-char-hex-string

# Gmail scan courtesy delay in milliseconds (default: 50)
GMAIL_SCAN_DELAY_MS=50
```

### New backend npm dependencies
- `googleapis` — Google API Node.js client (OAuth2 + Gmail API)
- `cookie-parser` — Cookie parsing and HMAC signing for Express

### New migrations (run in order against Supabase SQL Editor)
1. `backend/migrations/002_create_auth_tables.sql` — `sessions` + `gmail_tokens` tables.
   **Must be run before testing Phase 3A.**
2. `backend/migrations/003_create_scanned_emails.sql` — `scanned_emails` table.
   **Can wait until Phase 3B.**

### New backend source files
```
backend/src/
  ├── routes/
  │   ├── auth.js              (Phase 3A)
  │   └── email.js             (Phase 3B)
  ├── services/
  │   ├── tokenEncryption.js   (Phase 3A)
  │   ├── googleOAuth.js       (Phase 3A)
  │   └── gmailScanner.js      (Phase 3B)
  └── middleware/
      └── session.js           (Phase 3A)
```

### Modified backend files
- `backend/index.js` — add `cookie-parser` middleware, mount `/api/auth` and `/api/email` routers.
- `backend/.env.example` — add all new variables above.
- `backend/package.json` — add `googleapis` and `cookie-parser` dependencies.

### New frontend source files
```
frontend/src/
  ├── pages/
  │   ├── ConnectEmail.jsx        (Phase 3C)
  │   └── ConnectEmail.css        (Phase 3C)
  ├── hooks/
  │   └── useGmailConnection.js   (Phase 3C)
  └── components/
      ├── ScannedEmailList.jsx    (Phase 3C)
      └── ScannedEmailList.css    (Phase 3C)
```

### Modified frontend files
- `frontend/src/services/api.js` — add `credentials: 'include'` + new endpoint functions.
- `frontend/src/App.jsx` — add `connect-email` case, OAuth redirect detection on mount.
- `frontend/src/components/Sidebar.jsx` — add Connect Email nav item, update footer.

### Phase dependency chain
```
Phase 3A (sessions + tokens + OAuth flow)
    ↓  requireSession middleware must exist
Phase 3B (Gmail scan + results endpoint)
    ↓  all API endpoints must be tested
Phase 3C (frontend UI)
```

### External setup required before any code runs
1. **Google Cloud Console:**
   - Create a project and enable the **Gmail API**.
   - Create an **OAuth 2.0 Client ID** (type: Web Application).
   - Add `http://localhost:3001/api/auth/google/callback` as an authorised redirect URI.
   - Add test user Gmail addresses under **OAuth consent screen → Test users**.
   - Note: `gmail.readonly` is a **RESTRICTED** scope. Google may require verification
     for public deployment. For the hackathon, keep the app in testing mode.
2. **Run migration 002** in Supabase SQL Editor before testing Phase 3A.
3. **Run migration 003** in Supabase SQL Editor before testing Phase 3B.
4. **Populate `backend/.env`** with all variables listed above.
