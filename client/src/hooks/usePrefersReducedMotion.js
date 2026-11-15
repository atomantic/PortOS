/**
 * The user's `prefers-reduced-motion` setting as a boolean, tracking live changes.
 *
 * Use when: An imperative animation (a rAF canvas loop, a three.js frameloop) that must stop
 * scheduling frames itself — CSS animations honor the media query on their own.
 */

import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

// The user's `prefers-reduced-motion` setting as React state, tracking live
// changes. CSS animations honor the media query on their own; this is for the
// imperative ones — a requestAnimationFrame loop, a three.js frameloop — that
// have to stop scheduling frames themselves.
export default function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia?.(QUERY).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(QUERY);
    if (!media) return undefined;
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  return reduced;
}
