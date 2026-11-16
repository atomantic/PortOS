// Shared client-side URL normalization + detection helpers (`isUrl`, `normalizeUrl`, `isHttpUrl` / `isHttpsUrl`, `tiktokVideoId` / `tiktokEmbedSrc`).
//
// `normalizeUrl` has optional git/`requireDot` modes; `isHttpUrl` / `isHttpsUrl` are safe-href checks; the TikTok helpers do host-anchored video-id extraction + Embed Player URL (so a reference embeds without loading TikTok's embed.js).
// Consolidates three brain-capture surfaces' (LinksTab, QuickBrainCapture, FeedsTab) near-identical `https://`-prepending, preserving each call site via `allowGit` (treat `git@…` as normalized;
// not FeedsTab) and `requireDot` (prepend only when domain-like, else null; LinksTab's quick-add guard).

import { isSafeHref } from '../lib/isSafeHref.js';

const URL_SCHEME_PATTERN = /^(https?:\/\/|git@)/i;
const DOMAIN_PATTERN = /^\S+\.\S+$/;

/**
 * True when a stored/user value is an explicit http(s) URL, the only scheme safe to render as a link (rejects javascript:/data: so a stored URL can't smuggle a script into an href).
 * Alias of `isSafeHref` from `client/src/lib/isSafeHref.js` (mirrors `server/lib/isSafeHref.js`), kept so existing importers don't change.
 */
export const isHttpUrl = isSafeHref;

/**
 * True only for a syntactically valid HTTPS URL, for provider-issued browser handoffs where a local process response must never become a script URL in the PortOS page.
 */
export const isHttpsUrl = (url) =>
  typeof url === 'string' && URL.canParse(url) && new URL(url).protocol === 'https:';

/**
 * Extract a TikTok video id from a share/watch URL so a reference renders TikTok's iframe Embed Player instead of loading embed.js; null for anything else (plain link).
 * The host is ANCHORED so look-alikes (nottiktok.com, evil.com/#tiktok.com/…) don't match: `tiktok.com` must follow start, `//`, or a subdomain dot.
 */
export const tiktokVideoId = (url) => {
  const m = /(?:^|\/\/|\.)tiktok\.com\/(?:@[\w.-]+\/video|v|embed(?:\/v2)?|player\/v1)\/(\d+)/.exec(url || '');
  return m ? m[1] : null;
};

/**
 * The TikTok Embed Player URL for a video id (from `tiktokVideoId`).
 */
export const tiktokEmbedSrc = (id) => `https://www.tiktok.com/player/v1/${id}`;

/**
 * Detect whether a raw string is a URL/link rather than free text (mirrors QuickBrainCapture): an explicit scheme (http/https/git@) OR a domain-like single token (`foo.bar`).
 */
export function isUrl(raw) {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return false;
  return URL_SCHEME_PATTERN.test(trimmed) || DOMAIN_PATTERN.test(trimmed);
}

/**
 * Normalize a user-entered URL by prepending `https://` when no scheme is present; tunable to match each historical call site.
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
