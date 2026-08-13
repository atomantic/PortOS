/**
 * Platform detection — the single source of truth for "is this a Mac?" in the client.
 *
 * Browsers are mid-migration from the deprecated `navigator.platform` to
 * `navigator.userAgentData.platform`, so both are consulted (new API first) and
 * a missing `navigator` (unit tests, SSR) degrades to non-Mac rather than
 * throwing. Import `modKey` instead of hardcoding `⌘` / `Ctrl` in shortcut
 * hints — a hardcoded glyph lies to half the users.
 */
export const isMac = typeof navigator !== 'undefined' &&
  (/mac|iphone|ipad|ipod/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? ''));

export const modKey = isMac ? '⌘' : 'Ctrl';
