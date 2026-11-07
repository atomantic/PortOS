import { useEffect, useState } from 'react';

// A CSS media query as React state, tracking live changes. Use it when a
// layout must render exactly ONE of two trees (so ids/labels stay unique and
// the DOM isn't doubled); CSS-only show/hide belongs in Tailwind variants.
export default function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return undefined;
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, [query]);
  return matches;
}
