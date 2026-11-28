// Opens validated HTTP(S) links in a new tab with opener and referrer isolation.

import { isHttpUrl } from './urlNormalize.js';

export function openExternalUrl(url) {
  if (!isHttpUrl(url)) return false;
  window.open(url, '_blank', 'noopener,noreferrer');
  // With noopener the browser may return null even when it opens the tab.
  return true;
}
