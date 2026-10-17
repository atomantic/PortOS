import { useEffect, useRef, useState } from 'react';

// Track a container element's width via ResizeObserver. Returns [ref, width]
// — attach the ref to the element you want to measure, read width on each
// render. Width is 0 until the first observer callback fires; consumers
// should treat 0 as "not yet measured" and skip layout math.
//
// The element is re-checked after every render, not only on mount: a page
// that renders a loading skeleton first attaches the ref later, and a
// mount-only effect never observed it (FableLoom's graph then picked its
// orientation from the wrong width).
export default function useContainerWidth() {
  const ref = useRef(null);
  const observedRef = useRef({ el: null, ro: null });
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    const observed = observedRef.current;
    if (el === observed.el || typeof ResizeObserver === 'undefined') return;
    observed.ro?.disconnect();
    observed.el = el;
    observed.ro = null;
    if (!el) return;
    observed.ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w) setWidth(Math.floor(w));
    });
    observed.ro.observe(el);
  });
  useEffect(() => () => {
    observedRef.current.ro?.disconnect();
    observedRef.current = { el: null, ro: null };
  }, []);
  return [ref, width];
}
