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
