import { useEffect, useRef } from 'react';

// Returns a ref whose `.current` is true while the component is mounted.
// Use to gate post-await setState so an async resolve after unmount doesn't
// trigger a "set state on unmounted component" warning. The ref is reset
// to true on every mount so React 18 StrictMode's mount→cleanup→remount
// cycle doesn't leave it permanently false.
export default function useMounted() {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  return mountedRef;
}
