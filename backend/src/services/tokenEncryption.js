/**
 * Token encryption — AES-256-GCM at rest (Phase 3A).
 *
 * Encrypts OAuth access/refresh tokens before they are written to the
 * `gmail_tokens` table. Only ciphertext ever reaches the database; plaintext
 * token values exist transiently in backend memory only and are never logged,
 * returned in API responses, or persisted anywhere.
 *
 * Environment variables required (set in backend/.env):
 *   TOKEN_ENCRYPTION_KEY — exactly 64 hex chars (32 bytes). Generate with:
 *     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Stored format (single self-contained base64 string):
 *   base64( [1 byte: ivLen][1 byte: authTagLen][iv][ciphertext][authTag] )
 *
 * A fresh random IV is generated for EVERY encrypt() call, so identical
 * plaintexts never produce identical ciphertext and IV reuse is impossible.
 * The GCM auth tag makes any tampering or wrong-key attempt fail loudly as a
 * DecryptionError rather than decrypting to garbage.
 *
 * The client is validated lazily on first use (same pattern as
 * supabaseClient.js) so that importing this module never crashes the server
 * when configuration is pending.
 */

const crypto = require('crypto');

const IV_LENGTH = 12;   // 96-bit IV — recommended for GCM
const TAG_LENGTH = 16;  // 128-bit auth tag — GCM default

/** Thrown when decryption fails (tampered data, wrong key, malformed input). */
class DecryptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/**
 * Returns the validated 32-byte key buffer, or null if the env var is unset.
 * Throws a descriptive error if the value is present but malformed.
 * The key value itself is never logged or included in error messages.
 */
function getKey() {
  const keyHex = process.env.TOKEN_ENCRYPTION_KEY;

  if (!keyHex) return null;

  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is malformed: it must be exactly 64 hex characters (32 bytes).'
    );
  }

  return Buffer.from(keyHex, 'hex');
}

/** True when TOKEN_ENCRYPTION_KEY is present and well-formed. */
function isConfigured() {
  try {
    return getKey() !== null;
  } catch {
    return false;
  }
}

/**
 * Encrypts a plaintext string. Returns a single base64 string that embeds its
 * own IV and auth tag, so each stored value is fully self-contained.
 * @param {string} plaintext
 * @returns {string} base64-packed ciphertext
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encrypt() requires a non-empty string.');
  }

  const key = getKey();
  if (!key) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is not configured. Set it in backend/.env before encrypting tokens.'
    );
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const header = Buffer.from([IV_LENGTH, TAG_LENGTH]);
  return Buffer.concat([header, iv, ciphertext, authTag]).toString('base64');
}

/**
 * Decrypts a value produced by encrypt().
 * Throws DecryptionError for malformed input, a tampered ciphertext/auth tag,
 * or a key other than the one used to encrypt. Never logs its inputs.
 * @param {string} stored — the base64-packed string from the database
 * @returns {string} the original plaintext
 */
function decrypt(stored) {
  const fail = (why) => { throw new DecryptionError(`Token decryption failed (${why}).`); };

  if (typeof stored !== 'string' || stored.length === 0) fail('empty input');

  const key = getKey();
  if (!key) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is not configured. Set it in backend/.env before decrypting tokens.'
    );
  }

  let packed;
  try {
    packed = Buffer.from(stored, 'base64');
  } catch {
    fail('invalid base64');
  }

  if (packed.length < 2 + IV_LENGTH + TAG_LENGTH) fail('too short');

  const ivLen = packed[0];
  const tagLen = packed[1];
  if (ivLen !== IV_LENGTH || tagLen !== TAG_LENGTH) fail('unexpected format');

  const iv = packed.subarray(2, 2 + ivLen);
  const authTag = packed.subarray(packed.length - tagLen);
  const ciphertext = packed.subarray(2 + ivLen, packed.length - tagLen);

  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    fail('auth verification'); // tampered data or wrong key — never decrypt to garbage
  }

  if (plaintext.length === 0) fail('empty plaintext');
  return plaintext;
}

module.exports = { encrypt, decrypt, isConfigured, DecryptionError };
