/**
 * Shared assertion for a page whose tab bar is derived from the nav manifest.
 *
 * Every tabbed page builds its `TABS` (or `SECTIONS`/`RESOURCE_TABS`) with
 * `buildPageNavTabs(getPageNavTabs(group), …)`, so comparing the
 * result back against `getPageNavTabs(group)` proves nothing — it is the same
 * array. The regression worth catching is the MANIFEST drifting out from under
 * the page: a tab reordered, relabelled, added to or dropped from the
 * `tabGroup`. So each page pins the literal id/label list it means to render.
 *
 * A manifest tab with NO presentation entry already throws at module load, so
 * this only has to prove the entries that exist carry something renderable (an
 * icon) and a real destination path.
 *
 * Node-only consumer (test files); kept in `src/test/` for the same reason as
 * `classNameScan.js` — `lib/` carries the enforced barrel + README rule and a
 * test-only helper has no business in the browser barrel.
 */

import { expect } from 'vitest';

// `expected` is the page's intended tab bar as `'<id>:<label>'` strings, in
// render order — spelled out rather than derived so a manifest edit fails here.
export function expectPageNavTabs(tabs, expected) {
  expect(tabs.map((tab) => `${tab.id}:${tab.label}`)).toEqual(expected);
  expect(tabs.filter((tab) => !tab.icon).map((tab) => tab.id)).toEqual([]);
  expect(tabs.filter((tab) => !String(tab.to || '').startsWith('/')).map((tab) => tab.id)).toEqual([]);
}
