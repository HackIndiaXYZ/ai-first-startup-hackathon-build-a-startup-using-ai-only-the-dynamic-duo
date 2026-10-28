'use strict';

//body part: exported cap used by gmailScanner to slice before passing to extractSignatures
const BODY_CAP = 4000;

//body part: maximum raw text length before tag-stripping, to bound regex work on large HTML
const RAW_CAP = 200000;

//body part: minimum trimmed length of a text/plain part before falling back to text/html
const PLAIN_MIN = 40;

/**
 * Strips HTML to plain text. Called only on text/html parts.
 * Removes style/script blocks first, replaces block tags with spaces so
 * adjacent words do not merge, drops remaining tags, decodes entities
 * (&amp; decoded last so &amp;lt; does not double-decode), collapses whitespace.
 * @param {string} raw
 * @returns {string}
 */
function stripHtml(raw) {
  //body part: cut oversized HTML before any regex work
  let s = raw.length > RAW_CAP ? raw.slice(0, RAW_CAP) : raw;
  //body part: remove <style> and <script> blocks including their content
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  //body part: block-level tags become a space so words on adjacent lines don't run together
  s = s.replace(/<\/?(br|p|div|td|tr|li|h[1-6]|blockquote|pre|hr)[^>]*>/gi, ' ');
  //body part: all remaining inline tags are dropped (no space — inline elements share word context)
  s = s.replace(/<[^>]*>/g, '');
  //body part: decode entities — &amp; must be last so &amp;lt; is not decoded twice
  s = s.replace(/&nbsp;/gi, ' ');
  s = s.replace(/&lt;/gi, '<');
  s = s.replace(/&gt;/gi, '>');
  s = s.replace(/&amp;/gi, '&');
  //body part: collapse runs of whitespace (including newlines) into a single space
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Recursively extracts readable text from a Gmail messages.get `full` payload.
 *
 * Preference rules:
 *   - multipart/alternative: prefer text/plain; fall back to text/html (stripped)
 *     only when the plain part's trimmed length is under PLAIN_MIN characters.
 *   - multipart/mixed and other multipart/*: return the first non-empty child.
 *   - text/plain: decoded and whitespace-normalised.
 *   - text/html: tag-stripped via stripHtml().
 *   - anything else (image/*, application/*, …): return ''.
 *
 * The result is always capped at BODY_CAP characters.
 * Never stored, never logged, never put into a candidate or HTTP response.
 *
 * @param {object|null|undefined} payload  res.data.payload from messages.get format:'full'
 * @param {number} [_depth]  internal recursion counter — callers omit this
 * @returns {string}
 */
function decodeBody(payload, _depth) {
  if (!payload) return '';
  const depth = typeof _depth === 'number' ? _depth : 0;
  //body part: depth guard — bail out on pathological nesting
  if (depth > 10) return '';

  const mime = typeof payload.mimeType === 'string' ? payload.mimeType.toLowerCase() : '';

  //body part: recurse into multipart/* containers
  if (mime.startsWith('multipart/') && Array.isArray(payload.parts)) {
    if (mime === 'multipart/alternative') {
      //body part: scan direct children for the first text/plain and text/html parts
      let plainText = '';
      let htmlText = '';
      for (const part of payload.parts) {
        const partMime = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
        if (partMime === 'text/plain' && plainText === '') {
          plainText = decodeBody(part, depth + 1);
        } else if (partMime === 'text/html' && htmlText === '') {
          htmlText = decodeBody(part, depth + 1);
        }
      }
      //body part: use plain unless it is too short, then try html; cap either way
      if (plainText.trim().length >= PLAIN_MIN) return plainText.slice(0, BODY_CAP);
      if (htmlText.length > 0) return htmlText.slice(0, BODY_CAP);
      return plainText.slice(0, BODY_CAP);
    }
    //body part: multipart/mixed and others — return the first non-empty child
    for (const part of payload.parts) {
      const text = decodeBody(part, depth + 1);
      if (text.length > 0) return text.slice(0, BODY_CAP);
    }
    return '';
  }

  //body part: leaf part — decode body.data if present
  const data = payload.body && typeof payload.body.data === 'string' ? payload.body.data : '';
  if (data.length === 0) return '';

  //body part: Buffer.from with 'base64' handles both standard base64 and base64url (- and _)
  const raw = Buffer.from(data, 'base64').toString('utf8');

  if (mime === 'text/plain') {
    //body part: normalise whitespace for plain text parts
    return raw.replace(/\s+/g, ' ').trim().slice(0, BODY_CAP);
  }
  if (mime === 'text/html') {
    return stripHtml(raw).slice(0, BODY_CAP);
  }
  //body part: binary or unrecognised part type — discard entirely
  return '';
}

module.exports = { decodeBody, BODY_CAP };
