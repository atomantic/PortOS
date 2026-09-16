/**
 * Shared assertion for a rendered tree's `aria-controls` / `aria-labelledby`
 * IDREFs.
 *
 * A dangling IDREF (an id that names no element in the document) is invisible
 * to every existing `screen.getByRole`/`toHaveAttribute` assertion — those
 * check the attribute's VALUE, never that the value resolves to something
 * real. That is how #7420 survived: `TabPills` wired `aria-controls` onto
 * every tab in a bar that only ever mounts one panel, and nothing failed
 * until a screen reader tried to follow the reference. Each `aria-*` value can
 * be space-separated (the IDREF-list attributes), so split before checking.
 *
 * Node-only consumer (test files); kept in `src/test/` for the same reason as
 * `pageNavTabAssertions.js` — a test-only helper has no business in the
 * browser barrel.
 */

import { expect } from 'vitest';

const IDREF_ATTRS = ['aria-controls', 'aria-labelledby'];

export function expectNoDanglingAriaRefs(container) {
  const doc = container.ownerDocument;
  for (const attr of IDREF_ATTRS) {
    for (const el of container.querySelectorAll(`[${attr}]`)) {
      const ids = el.getAttribute(attr).trim().split(/\s+/).filter(Boolean);
      for (const id of ids) {
        expect(doc.getElementById(id), `${attr}="${id}" on <${el.tagName.toLowerCase()}> has no matching element`).not.toBeNull();
      }
    }
  }
}
