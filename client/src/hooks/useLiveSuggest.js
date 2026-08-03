import { useCallback, useEffect, useRef } from 'react';
import useMounted from './useMounted';

// useLiveSuggest — post-typing debounce for a live AI suggestion panel.
//
// Extracted from WorkEditor (#3387). The panel registers its imperative
// suggest fn via `registerTrigger`; the editor calls `scheduleSuggest()` on
// every keystroke, which (re)arms a single `debounceMs` timer so the trigger
// only fires once the writer pauses.
//
// `enabled` gates arming entirely — pass `liveMode.enabled && viewMode === 'edit'`
// so a deferred fire can't hit a closed panel or a non-typing view. The timer is
// cleared on unmount and the mounted guard is re-checked before firing, so a
// pending suggest can never land on a dead editor.
export default function useLiveSuggest({ enabled, debounceMs = 2500 }) {
  const mountedRef = useMounted();
  const triggerRef = useRef(null);
  const timerRef = useRef(null);

  const registerTrigger = useCallback((fn) => { triggerRef.current = fn; }, []);

  const scheduleSuggest = useCallback(() => {
    if (!enabled) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (mountedRef.current) triggerRef.current?.();
    }, debounceMs);
  }, [enabled, debounceMs, mountedRef]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return { registerTrigger, scheduleSuggest };
}
