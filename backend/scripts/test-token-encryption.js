/**
 * Self-test for src/services/tokenEncryption.js — Phase 3A (Checkpoint 2, C2).
 *
 * Run from the backend/ directory:
 *   node scripts/test-token-encryption.js
 *
 * Design rules:
 *   - Generates its own throwaway keys INSIDE this process; no secrets on the
 *     command line, in shell env, or in any file.
 *   - Never prints keys, plaintext samples, or ciphertext values — only
 *     PASS/FAIL, lengths, and error CLASS names.
 *   - Exits 0 only if every assertion passes.
 */

const assert = require('assert');
const {
  encrypt,
  decrypt,
  isConfigured,
  DecryptionError,
} = require('../src/services/tokenEncryption');

const crypto = require('crypto');

/** Fresh random 32-byte key as hex — generated in-process, never printed. */
function freshKeyHex() {
  return crypto.randomBytes(32).toString('hex');
}

// A fake token shaped like a real Google access token. NEVER printed.
const SAMPLE_TOKEN = 'ya29.selftest-' + crypto.randomBytes(24).toString('base64url');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}  ->  ${err.constructor.name}: ${err.message}`);
  }
}

console.log('== tokenEncryption self-test ==\n');

// ---------------------------------------------------------------------------
// 1. Key validation
// ---------------------------------------------------------------------------
console.log('-- key validation --');

delete process.env.TOKEN_ENCRYPTION_KEY;
check('isConfigured() is false when the key is unset', () => {
  assert.strictEqual(isConfigured(), false);
});

check('encrypt() throws when the key is unset', () => {
  assert.throws(() => encrypt(SAMPLE_TOKEN), /TOKEN_ENCRYPTION_KEY/);
});

process.env.TOKEN_ENCRYPTION_KEY = 'abc123'; // malformed on purpose
check('isConfigured() is false when the key is malformed', () => {
  assert.strictEqual(isConfigured(), false);
});

check('malformed key throws and names the env var', () => {
  assert.throws(() => encrypt(SAMPLE_TOKEN), /TOKEN_ENCRYPTION_KEY/);
});

check('malformed-key error never echoes the malformed value', () => {
  try {
    encrypt(SAMPLE_TOKEN);
    assert.fail('expected a throw');
  } catch (err) {
    assert.ok(!err.message.includes('abc123'), 'error leaked the key value');
  }
});

// ---------------------------------------------------------------------------
// 2. Round-trip
// ---------------------------------------------------------------------------
console.log('\n-- round-trip --');

process.env.TOKEN_ENCRYPTION_KEY = freshKeyHex();
check('isConfigured() is true with a valid key', () => {
  assert.strictEqual(isConfigured(), true);
});

const stored = encrypt(SAMPLE_TOKEN);
check('encrypt() returns a non-empty string', () => {
  assert.ok(typeof stored === 'string' && stored.length > 0);
});

check('ciphertext is longer than the plaintext', () => {
  assert.ok(stored.length > SAMPLE_TOKEN.length);
});

check('decrypt(encrypt(x)) returns the original value', () => {
  assert.strictEqual(decrypt(stored) === SAMPLE_TOKEN, true);
});

const storedAgain = encrypt(SAMPLE_TOKEN);
check('two encryptions of the same value differ (fresh IV per call)', () => {
  assert.notStrictEqual(stored, storedAgain);
});

check('both ciphertexts decrypt to the same value', () => {
  assert.strictEqual(decrypt(stored) === decrypt(storedAgain), true);
});

check('different plaintext produces different ciphertext', () => {
  const other = encrypt(SAMPLE_TOKEN + 'x');
  assert.notStrictEqual(stored, other);
  assert.strictEqual(decrypt(other) === SAMPLE_TOKEN + 'x', true);
});

// ---------------------------------------------------------------------------
// 3. Tamper detection
// ---------------------------------------------------------------------------
console.log('\n-- tamper detection --');

function flipByte(base64, byteIndex) {
  const buf = Buffer.from(base64, 'base64');
  buf[byteIndex] ^= 0x01;
  return buf.toString('base64');
}

check('flipping a ciphertext byte throws DecryptionError', () => {
  const tampered = flipByte(stored, Math.floor(stored.length * 0.6));
  assert.throws(() => decrypt(tampered), DecryptionError);
});

check('flipping a byte in the auth tag throws DecryptionError', () => {
  const buf = Buffer.from(stored, 'base64');
  const tampered = flipByte(stored, buf.length - 1); // last byte = end of auth tag
  assert.throws(() => decrypt(tampered), DecryptionError);
});

check('wrong key throws DecryptionError', () => {
  const keyA = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = freshKeyHex(); // different key
  try {
    assert.throws(() => decrypt(stored), DecryptionError);
  } finally {
    process.env.TOKEN_ENCRYPTION_KEY = keyA;
  }
});

// ---------------------------------------------------------------------------
// 4. Malformed stored values
// ---------------------------------------------------------------------------
console.log('\n-- malformed stored values --');

check('empty stored value throws DecryptionError', () => {
  assert.throws(() => decrypt(''), DecryptionError);
});

check('garbage input throws DecryptionError', () => {
  assert.throws(() => decrypt('this is not a token at all'), DecryptionError);
});

check('truncated ciphertext throws DecryptionError', () => {
  const truncated = stored.slice(0, Math.floor(stored.length / 2));
  assert.throws(() => decrypt(truncated), DecryptionError);
});

check('error is a named DecryptionError instance', () => {
  try {
    decrypt('garbage');
    assert.fail('expected a throw');
  } catch (err) {
    assert.ok(err instanceof DecryptionError);
    assert.strictEqual(err.name, 'DecryptionError');
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
delete process.env.TOKEN_ENCRYPTION_KEY;

console.log(`\n== result: ${passed} passed, ${failed} failed ==`);
process.exit(failed === 0 ? 0 : 1);
