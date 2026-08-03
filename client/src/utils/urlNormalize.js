// Shared client-side URL normalization + detection helpers.
//
// Three brain-capture surfaces (LinksTab, QuickBrainCapture, FeedsTab) each
// prepended `https://` to bare URLs with near-identical-but-subtly-different
// logic. This module consolidates that logic while preserving each call site's
// behavior via options:
//   - `allowGit`  — treat `git@…` strings as already-normalized (LinksTab,
//                   QuickBrainCapture do this; FeedsTab does NOT).
//   - `requireDot`— only prepend `https://` when the value looks domain-like
//                   (contains a `.` or `github.com`), returning null otherwise
//                   (LinksTab's quick-add guard). FeedsTab/QuickBrainCapture
//                   prepend unconditionally for non-scheme input.

const URL_SCHEME_PATTERN = /^(https?:\/\/|git@)/i;
const DOMAIN_PATTERN = /^\S+\.\S+$/;

/**
 * True when a stored/user value is an explicit http(s) URL — the only scheme
 * safe to render as a clickable link (rejects javascript:/data: so a stored
 * URL can't smuggle a script into an href).
 *
 * @param {string} url
 * @returns {boolean}
 */
export const isHttpUrl = (url) => /^https?:\/\//i.test(url || '');

/**
 * Extract a TikTok video id from a share/watch URL so a reference can render
 * TikTok's documented iframe Embed Player instead of loading their embed.js.
 * Returns null for anything that isn't a TikTok video URL — those references
 * render as plain links.
 *
 * The host is ANCHORED so look-alikes (nottiktok.com, evil.com/#tiktok.com/…)
 * don't match — `tiktok.com` must be preceded by start, `//`, or a subdomain dot.
 *
 * @param {string} url
 * @returns {string|null}
 */
export const tiktokVideoId = (url) => {
  const m = /(?:^|\/\/|\.)tiktok\.com\/(?:@[\w.-]+\/video|v|embed(?:\/v2)?|player\/v1)\/(\d+)/.exec(url || '');
  return m ? m[1] : null;
};

/**
 * The TikTok Embed Player URL for a video id (from `tiktokVideoId`).
 *
 * @param {string} id
 * @returns {string}
 */
export const tiktokEmbedSrc = (id) => `https://www.tiktok.com/player/v1/${id}`;

/**
 * Detect whether a raw string should be treated as a URL/link rather than
 * free text. Mirrors QuickBrainCapture's detection: an explicit scheme
 * (http/https/git@) OR a domain-like single token (`foo.bar`).
 *
 * @param {string} raw
 * @returns {boolean}
 */
export function isUrl(raw) {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return false;
  return URL_SCHEME_PATTERN.test(trimmed) || DOMAIN_PATTERN.test(trimmed);
}

/**
 * Normalize a user-entered URL by prepending `https://` when no scheme is
 * present. Behavior is tunable to match each historical call site.
 *
 * @param {string} raw
 * @param {object} [options]
 * @param {boolean} [options.allowGit=true]   Treat `git@…` as already-normalized.
 * @param {boolean} [options.requireDot=false] Only prepend (else return null)
 *   when the value contains a `.` or `github.com`.
 * @returns {string|null} The normalized URL, or null when input is empty (or,
 *   with requireDot, when it doesn't look domain-like).
 */
export function normalizeUrl(raw, { allowGit = true, requireDot = false } = {}) {
  let url = (raw ?? '').trim();
  if (!url) return null;

  const hasScheme =
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    (allowGit && url.startsWith('git@'));

  if (!hasScheme) {
    if (requireDot && !(url.includes('github.com') || url.includes('.'))) {
      return null;
    }
    url = 'https://' + url;
  }
  return url;
}
