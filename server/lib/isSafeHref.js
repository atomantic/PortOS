/**
 * Pure http(s)-only scheme check for user-supplied URL fields that later get
 * rendered as a clickable `<a href>` (privacy-org website/portal links,
 * broker opt-out/search URLs, screenshot evidence, …).
 *
 * A stored `javascript:`/`data:`/`vbscript:` URL turns into a stored-XSS
 * payload the moment it's rendered as an href — validating the scheme at
 * write time (Zod `.refine`) and re-checking at render time (client) closes
 * both the write and the read side. `client/src/lib/isSafeHref.js` re-exports
 * this module and `client/src/utils/urlNormalize.js` re-exports that as
 * `isHttpUrl`, so all three names resolve to one rule.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isSafeHref(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
