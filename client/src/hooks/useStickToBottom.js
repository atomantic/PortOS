import { useLayoutEffect, useRef } from 'react';

// Within this many pixels of the bottom still counts as "at the bottom", so a
// fractional layout height or a momentum-scroll overshoot does not unpin.
const BOTTOM_SLACK_PX = 24;

/**
 * Keep a scrollable container pinned to its bottom while content grows, until
 * the user scrolls up — the live-log contract: new lines keep the newest text
 * in view, but a reader who scrolled back to inspect something is not yanked
 * down by every line that lands. Scrolling back to the bottom re-pins.
 *
 * @param {import('react').RefObject<HTMLElement>} containerRef - the element
 *   with `overflow-y: auto`. It may be conditionally rendered: pass the same
 *   condition as `enabled` so the listener attaches to the mounted element.
 * @param {{ enabled?: boolean, revision?: unknown }} [options]
 *   `enabled` false detaches entirely (a finished transcript scrolls freely);
 *   `revision` is any value that changes when content is appended (the output
 *   array itself works, since a buffer that is capped at N entries keeps its
 *   length while its contents move). Each change re-pins when still pinned.
 */
export default function useStickToBottom(containerRef, { enabled = true, revision } = {}) {
  const pinnedRef = useRef(true);

  // Layout effects, not passive ones: the pin runs before paint so the user
  // never sees the panel open at the top and then jump.
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
