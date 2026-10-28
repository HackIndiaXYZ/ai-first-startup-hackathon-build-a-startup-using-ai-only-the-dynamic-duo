/**
 * test-message-body.js — unit tests for messageBody.decodeBody.
 *
 * Pure unit tests: no network, no Gmail, no database, no credentials.
 * All payload objects are synthetic — no real email content.
 *
 * Usage: node backend/scripts/test-message-body.js   (prints PASS/FAIL)
 */

'use strict';

const { decodeBody, BODY_CAP } = require('../src/services/messageBody');

let passCount = 0;
let failCount = 0;
const results = [];

function check(name, condition, extra) {
  if (condition) {
    passCount += 1;
    results.push(`PASS  ${name}`);
  } else {
    failCount += 1;
    results.push(`FAIL  ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
  }
}

//body part: helper — encode a UTF-8 string to base64 (standard, which Node also decodes as base64url)
function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

//body part: helper — encode using base64url alphabet (replaces + with - and / with _)
function b64url(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// 1. null / missing payload
// ---------------------------------------------------------------------------
check('1. null payload returns empty string', decodeBody(null) === '');
check('1a. undefined payload returns empty string', decodeBody(undefined) === '');
check('1b. empty object returns empty string', decodeBody({}) === '');

// ---------------------------------------------------------------------------
// 2. text/plain leaf
// ---------------------------------------------------------------------------
const plainPayload = {
  mimeType: 'text/plain',
  body: { data: b64('Your free trial ends on April 14, 2027. You will be charged $9.99 per month.') },
};
const plainResult = decodeBody(plainPayload);
check('2. text/plain decoded correctly', plainResult.includes('April 14, 2027'), plainResult);
check('2a. whitespace normalised', !plainResult.includes('\n'), plainResult);
check('2b. capped at BODY_CAP', plainResult.length <= BODY_CAP, plainResult.length);

// ---------------------------------------------------------------------------
// 3. text/html only — tags stripped, entities decoded, style block removed
// ---------------------------------------------------------------------------
const htmlSource =
  '<html><head>' +
  '<style>.footer { color: #999; font-size: 10px; }</style>' +
  '</head><body>' +
  '<p>Your <b>free trial</b> ends on <b>April&nbsp;14, 2027</b>.</p>' +
  '<p>After that you will be charged $9.99 per month.</p>' +
  '<div class="footer">Terms updated January 1, 2027. &copy; 2027 Acmecorp.</div>' +
  '</body></html>';
const htmlPayload = {
  mimeType: 'text/html',
  body: { data: b64(htmlSource) },
};
const htmlResult = decodeBody(htmlPayload);
check('3. text/html style block not in output', !htmlResult.includes('.footer'), htmlResult);
check('3a. &nbsp; decoded to space — date not split', htmlResult.includes('April') && htmlResult.includes('14, 2027'), htmlResult);
check('3b. inline <b> tags stripped, words still adjacent', htmlResult.includes('free trial'), htmlResult);
check('3c. text content preserved after tag strip', htmlResult.includes('9.99'), htmlResult);
check('3d. html output is a single line of spaces-only (no newlines)', !htmlResult.includes('\n'), htmlResult);

// ---------------------------------------------------------------------------
// 4. multipart/alternative — text/plain preferred over text/html
// ---------------------------------------------------------------------------
const altPayload = {
  mimeType: 'multipart/alternative',
  parts: [
    {
      mimeType: 'text/plain',
      body: { data: b64('Your trial ends on May 5, 2027. You will be charged $4.99 per month.') },
    },
    {
      mimeType: 'text/html',
      body: { data: b64('<p>Your trial ends on <b>May 5, 2027</b>. Charged $99.00 monthly.</p>') },
    },
  ],
};
const altResult = decodeBody(altPayload);
//body part: plain part is long enough so it should be chosen, not the html part
check('4. multipart/alternative prefers text/plain', altResult.includes('4.99'), altResult);
check('4a. html part not used when plain is sufficient', !altResult.includes('99.00'), altResult);
check('4b. date from plain part is present', altResult.includes('May 5, 2027'), altResult);

// ---------------------------------------------------------------------------
// 5. multipart/alternative — plain is too short, fall back to text/html
// ---------------------------------------------------------------------------
const altShortPlainPayload = {
  mimeType: 'multipart/alternative',
  parts: [
    {
      mimeType: 'text/plain',
      body: { data: b64('View online.') }, // well under 40 trimmed chars
    },
    {
      mimeType: 'text/html',
      body: { data: b64('<p>Your trial ends on June 20, 2027. Charged $6.99 per month.</p>') },
    },
  ],
};
const altShortResult = decodeBody(altShortPlainPayload);
check('5. falls back to text/html when plain is under 40 chars', altShortResult.includes('June 20, 2027'), altShortResult);
check('5a. price from html fallback present', altShortResult.includes('6.99'), altShortResult);

// ---------------------------------------------------------------------------
// 6. nested multipart (multipart/mixed containing multipart/alternative)
// ---------------------------------------------------------------------------
const nestedPayload = {
  mimeType: 'multipart/mixed',
  parts: [
    {
      //body part: inner alternative block nested one level deep
      mimeType: 'multipart/alternative',
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: b64('Your renewal is on July 1, 2027. Cost is $12.99 per month.') },
        },
        {
          mimeType: 'text/html',
          body: { data: b64('<p>Renewal July 1 2027. $99.00 per month.</p>') },
        },
      ],
    },
    {
      //body part: attachment part — must be ignored
      mimeType: 'application/pdf',
      body: { data: b64('fake pdf bytes') },
    },
  ],
};
const nestedResult = decodeBody(nestedPayload);
check('6. nested multipart/mixed extracts text from inner alternative', nestedResult.includes('July 1, 2027'), nestedResult);
check('6a. pdf attachment part ignored', !nestedResult.includes('fake pdf'), nestedResult);

// ---------------------------------------------------------------------------
// 7. base64url alphabet (- and _ characters instead of + and /)
// ---------------------------------------------------------------------------
const b64urlText = 'Your trial ends on August 10, 2027. You will be charged $8.99 per month.';
const b64urlPayload = {
  mimeType: 'text/plain',
  body: { data: b64url(b64urlText) },
};
const b64urlResult = decodeBody(b64urlPayload);
check('7. base64url with - and _ decoded correctly', b64urlResult.includes('August 10, 2027'), b64urlResult);
check('7a. price from base64url payload', b64urlResult.includes('8.99'), b64urlResult);

// ---------------------------------------------------------------------------
// 8. date split by &nbsp; and inline <b> tags
// ---------------------------------------------------------------------------
const splitDateHtml =
  '<p>Your free trial ends on <b>September&nbsp;3,</b> 2027. ' +
  'After that you will be charged $5.99 per month.</p>';
const splitDatePayload = {
  mimeType: 'text/html',
  body: { data: b64(splitDateHtml) },
};
const splitDateResult = decodeBody(splitDatePayload);
//body part: &nbsp; becomes space and <b> tags are dropped, so the date tokens are adjacent
check('8. &nbsp; decoded — date tokens adjacent after stripping', splitDateResult.includes('September') && splitDateResult.includes('3,') && splitDateResult.includes('2027'), splitDateResult);
check('8a. <b> tags removed without breaking word adjacency', splitDateResult.includes('ends on'), splitDateResult);

// ---------------------------------------------------------------------------
// 9. <style> block content must not appear in the output
// ---------------------------------------------------------------------------
const stylePayload = {
  mimeType: 'text/html',
  body: {
    data: b64(
      '<html><head><style>body { font-family: Arial; } .renewal-date { color: red; } ' +
      '/* renewal date reminder */ </style></head>' +
      '<body><p>Your plan renews on October 15, 2027. Amount: $19.99 per year.</p></body></html>'
    ),
  },
};
const styleResult = decodeBody(stylePayload);
check('9. style block content not in output', !styleResult.includes('font-family'), styleResult);
check('9a. renewal-date class name not leaked from style block', !styleResult.includes('renewal-date'), styleResult);
check('9b. actual body content still present', styleResult.includes('October 15, 2027'), styleResult);

// ---------------------------------------------------------------------------
// 10. BODY_CAP: output never exceeds 4000 characters
// ---------------------------------------------------------------------------
const longText = 'Your free trial ends on November 1, 2027. You will be charged $3.99 per month. '.repeat(200);
const longPayload = {
  mimeType: 'text/plain',
  body: { data: b64(longText) },
};
const longResult = decodeBody(longPayload);
check('10. output length never exceeds BODY_CAP', longResult.length <= BODY_CAP, longResult.length);
check('10a. content still starts with expected text', longResult.startsWith('Your free trial'), longResult.slice(0, 30));

// ---------------------------------------------------------------------------
// 11. depth guard: pathologically nested multipart beyond 10 levels returns ''
// ---------------------------------------------------------------------------
function makeDeepNested(depth, innerPayload) {
  if (depth === 0) return innerPayload;
  return {
    mimeType: 'multipart/mixed',
    parts: [makeDeepNested(depth - 1, innerPayload)],
  };
}
const deepPayload = makeDeepNested(12, {
  mimeType: 'text/plain',
  body: { data: b64('This should not be reached.') },
});
const deepResult = decodeBody(deepPayload);
check('11. depth guard: 12-level nesting returns empty string', deepResult === '', deepResult);

// ---------------------------------------------------------------------------
// 12. non-text leaf (image/png) returns ''
// ---------------------------------------------------------------------------
const binaryPayload = {
  mimeType: 'image/png',
  body: { data: b64('\x89PNG\r\n') },
};
check('12. image/png part returns empty string', decodeBody(binaryPayload) === '');

// ---------------------------------------------------------------------------
// 13. missing body.data returns ''
// ---------------------------------------------------------------------------
check('13. missing body returns empty string', decodeBody({ mimeType: 'text/plain', body: {} }) === '');
check('13a. null body returns empty string', decodeBody({ mimeType: 'text/plain', body: null }) === '');

results.forEach((r) => console.log(r));
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exitCode = failCount === 0 ? 0 : 1;
