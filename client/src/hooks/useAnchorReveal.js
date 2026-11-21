/**
 * `useAnchorReveal(getTarget, key, { reveal? })` — scroll a freshly-opened element into view + flash a
 * tint over it.
 *
 * Re-fires when `key` changes; no-op when `key` is falsy or `getTarget()` is null. Use when: Reveal
 * an editorial finding's anchored manuscript text on open / prev-next step (#1601).
 */

import { useEffect } from 'react';

// Class + duration must stay in sync with the `manuscript-anchor-flash`
// keyframe in `client/src/components/pipeline/manuscript/manuscriptAnchorFlash.css` (#1601).
const FLASH_CLASS = 'manuscript-anchor-flash';
const FLASH_MS = 1200;

/**
 * Reveal a freshly-opened editorial finding's anchored text: scroll it into view (centered) and flash a brief tint so the eye lands on the exact passage (#1601). `useAnchorReveal(getTarget, key, { reveal? })`:
 * - `getTarget()` returns the DOM element to reveal, or `null` when the anchor isn't in the current draft (then this is a no-op and the caller's own fallback, e.g. scrolling the note card, applies).
 * - `key` re-fires the reveal whenever it changes (the open comment id), so stepping prev/next re-reveals each note; a falsy `key` is a no-op (how callers disable it).
 * - `reveal(el)` optionally overrides `scrollIntoView`, for the Live editor whose anchor lives inside an internally-scrolling textarea.
 * `getTarget`/`reveal` are excluded from the effect deps on purpose: fire on open/step (the `key`), not on every render that hands a fresh closure.
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
  }, [key]);
}
