import { useEffect, useRef, useState } from 'react';

// Track a container element's width via ResizeObserver. Returns [ref, width]
// — attach the ref to the element you want to measure, read width on each
// render. Width is 0 until the first observer callback fires; consumers
// should treat 0 as "not yet measured" and skip layout math.
export default function useContainerWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w) setWidth(Math.floor(w));
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
