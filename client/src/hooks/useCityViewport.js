import { useEffect, useState } from 'react';

// Coordinated responsive breakpoints for the CyberCity HUD. The HUD is a fixed
// overlay on top of a full-bleed 3D scene, so it can't rely on the page's normal
// flow/scroll to reflow — it needs to KNOW the viewport bracket to swap between the
// desktop cockpit and the compact/phone disclosure layout (rendering both trees at
// once would double the always-live timers and stack the panels). We branch in JS
// (not just CSS `lg:hidden`) so only one layout mounts and the branch is testable.
//
// Brackets mirror Tailwind's `sm` (640) and `lg` (1024), with a height floor
// for the full cockpit. Its top-left vitals stack and bottom-left map/action rail
// are intentionally independent on a spacious desktop; on a short viewport those
// anchors would otherwise overlap. The compact HUD keeps the same tools reachable
// as one-at-a-time disclosure panels instead.
//   phone   : < 640                    essential status + a single disclosure surface
//   compact : 640 – 1023, or < 900px h condensed rail + collapsed launchers
//   desktop : >= 1024 and >= 900px h   the full multi-panel cockpit
export const CITY_PHONE_MAX = 639;
export const CITY_COMPACT_MAX = 1023;
export const CITY_DESKTOP_MIN_HEIGHT = 900;

export function classifyCityViewport(width, height = Infinity) {
  if (width <= CITY_PHONE_MAX) return 'phone';
  if (width <= CITY_COMPACT_MAX) return 'compact';
  if (height < CITY_DESKTOP_MIN_HEIGHT) return 'compact';
  return 'desktop';
}

export default function useCityViewport() {
  const [mode, setMode] = useState(() =>
    typeof window === 'undefined' ? 'desktop' : classifyCityViewport(window.innerWidth, window.innerHeight),
  );

  useEffect(() => {
    const onResize = () => setMode(classifyCityViewport(window.innerWidth, window.innerHeight));
    onResize(); // sync once in case width changed before the listener attached
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return {
    mode,
    isPhone: mode === 'phone',
    isCompact: mode === 'compact',
    isDesktop: mode === 'desktop',
    // convenience: everything that is NOT the desktop cockpit
    isCondensed: mode !== 'desktop',
  };
}
