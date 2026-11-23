/**
 * `useStickToBottom(containerRef, { enabled, revision })` keeps an `overflow-y-auto` container pinned
 * to its bottom as content grows.
 *
 * A user scroll up unpins, scrolling back to the bottom re-pins, and enabling opens at the tail. Use
 * when: A live log or transcript panel (the CoS agent card's running output). Pass the growing array
 * as `revision`.
 */

import { useLayoutEffect, useRef } from 'react';

// Within this many pixels of the bottom still counts as "at the bottom" (fractional layout heights, momentum overshoot).
const BOTTOM_SLACK_PX = 24;

/**
 * Keep a scrollable container pinned to its bottom while content grows, until the user scrolls up (the live-log contract: new lines stay in view, but a reader who scrolled back isn't yanked down); scrolling back to the bottom re-pins.
 * @param {import('react').RefObject<HTMLElement>} containerRef - the element
 *   with `overflow-y: auto`. It may be conditionally rendered: pass the same
 *   condition as `enabled` so the listener attaches to the mounted element.
 * @param {{ enabled?: boolean, revision?: unknown }} [options]
 *   `enabled` false detaches entirely; `revision` is any value that changes when content is appended (the output array works, since a capped buffer keeps its length while contents move); each change re-pins when still pinned.
 */
export default function useStickToBottom(containerRef, { enabled = true, revision } = {}) {
  const pinnedRef = useRef(true);

  // Layout effects, not passive: the pin runs before paint so the panel never opens at the top and jumps.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!enabled || !el) return undefined;
    // A freshly enabled surface opens at its tail; the user's own scrolling
    // decides from there.
    pinnedRef.current = true;
    el.scrollTop = el.scrollHeight;
    const onScroll = () => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [containerRef, enabled]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!enabled || !el || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [containerRef, enabled, revision]);
}
