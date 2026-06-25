import { useEffect } from 'react';

// Class + duration must stay in sync with the `manuscript-anchor-flash`
// keyframe in `client/src/index.css` (#1601).
const FLASH_CLASS = 'manuscript-anchor-flash';
const FLASH_MS = 1200;

/**
 * Reveal a freshly-opened editorial finding's anchored text: scroll it into
 * view (centered) and flash a brief tint over it so the eye lands on the exact
 * passage instead of hunting through a long scene (#1601).
 *
 *   useAnchorReveal(getTarget, key, { reveal? })
 *
 * - `getTarget()` returns the DOM element to reveal (the located highlight /
 *   underline mark), or `null` when the anchor isn't present in the current
 *   draft — in which case this is a no-op and the caller's own fallback (e.g.
 *   scrolling the note card) handles it gracefully.
 * - `key` re-fires the reveal whenever it changes (the open comment id), so
 *   stepping prev/next through a triage pass re-reveals each note. Falsy `key`
 *   (nothing open, or anchor not located) is a no-op — that's how callers
 *   disable the reveal (pass `null`).
 * - `reveal(el)` optionally overrides the default `scrollIntoView` — used by the
 *   Live editor, whose anchor lives inside an internally-scrolling textarea.
 *
 * `getTarget`/`reveal` are intentionally excluded from the effect deps: the
 * reveal should fire on open/step (the `key`), not on every render that hands a
 * fresh closure.
 */
export default function useAnchorReveal(getTarget, key, { reveal } = {}) {
  useEffect(() => {
    if (!key) return undefined;
    const target = getTarget();
    if (!target) return undefined;
    if (reveal) reveal(target);
    else if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    target.classList?.add(FLASH_CLASS);
    const timer = window.setTimeout(() => target.classList?.remove(FLASH_CLASS), FLASH_MS);
    return () => {
      window.clearTimeout(timer);
      target.classList?.remove(FLASH_CLASS);
    };
    // `getTarget`/`reveal` excluded by design — fire on open/step (`key`), not
    // on every render that hands a fresh closure.
  }, [key]);
}
