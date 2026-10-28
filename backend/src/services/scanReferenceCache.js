/**
 * scanReferenceCache — TrialGuard Phase CP5-A.
 *
 * SERVER-ISSUED, SERVER-RESOLVED scan references (approved correction 1):
 * the frontend can never present candidate data for saving — it can only name
 * a reference the server itself issued for ITS OWN verified scan. The save
 * route (POST /api/scan/save) resolves selected message ids strictly against
 * the cached scan of the SAME authenticated Google account.
 *
 * Invariants:
 *   - ISSUE: after a successful manual scan. The cache stores ONLY the
 *     already-sanitized candidate DTOs (the exact same whitelist objects the
 *     response returns to the UI) — never message bodies, snippets, headers,
 *     tokens, or raw Gmail payloads (approved privacy rule).
 *   - BINDING: every lookup must pass the caller's google_sub (server-side
 *     session identity). A foreign or forged reference is indistinguishable
 *     from an expired one (same failure result — no existence oracle).
 *   - EXPIRY: fixed 10-minute TTL from issuance, never extended. Expired
 *     entries are swept lazily on access — no timers, no background work
 *     (manual-by-design mirrors the scan itself).
 *   - BOUNDS: at most MAX_REFS references per process (oldest evicted) and at
 *     most MAX_CANDIDATES_PER_REF candidates each — worst case ≈ hundreds of
 *     KB, bounded regardless of usage.
 *   - TRANSIENT: process-restart clears the cache entirely; nothing is ever
 *     persisted to Supabase, files, or logs. The user's next scan issues a
 *     fresh reference (the frontend communicates this via the `scan_expired`
 *     code).
 */

const crypto = require('crypto');

const SCAN_REF_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_REFS = 32;
const MAX_CANDIDATES_PER_REF = 50;

/** ref → { googleSub, expiresAt (epoch ms), candidates: Map<sourceMessageId, dto>} */
const refs = new Map();

function sweep(now) {
  for (const [ref, entry] of refs) {
    if (entry.expiresAt <= now) refs.delete(ref);
  }
}

/**
 * Issues a new reference for a completed scan.
 * @param {string} googleSub verified account id (from the server session)
 * @param {Array<object>} candidates sanitized candidate DTOs from the scan
 * @returns {{ scanRef: string, expiresAt: string }} opaque token + ISO expiry
 */
function issueScanReference(googleSub, candidates) {
  const now = Date.now();
  sweep(now);
  while (refs.size >= MAX_REFS) {
    // Map preserves insertion order → first key is the oldest reference.
    refs.delete(refs.keys().next().value);
  }

  const ref = crypto.randomBytes(32).toString('base64url'); // 43 chars, 256-bit
  const candidatesById = new Map();
  if (Array.isArray(candidates)) {
    for (const dto of candidates.slice(0, MAX_CANDIDATES_PER_REF)) {
      if (dto && typeof dto === 'object' && typeof dto.sourceMessageId === 'string') {
        candidatesById.set(dto.sourceMessageId, dto);
      }
    }
  }

  refs.set(ref, { googleSub, expiresAt: now + SCAN_REF_TTL_MS, candidates: candidatesById });
  return { scanRef: ref, expiresAt: new Date(now + SCAN_REF_TTL_MS).toISOString() };
}

/**
 * Resolves a reference ONLY for its owner, while live.
 * @returns {object|null} the cache entry, or null when unknown/expired/foreign
 */
function resolveScanReference(ref, googleSub, now = Date.now()) {
  sweep(now);
  if (typeof ref !== 'string') return null;
  const entry = refs.get(ref);
  if (!entry) return null;
  if (entry.googleSub !== googleSub) return null;
  if (entry.expiresAt <= now) return null;
  return entry;
}

module.exports = {
  issueScanReference,
  resolveScanReference,
  SCAN_REF_TTL_MS,
  MAX_REFS,
  MAX_CANDIDATES_PER_REF,
};
