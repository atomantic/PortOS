/**
 * Hook providing a post-typing debounce for an imperative panel trigger: `{ registerTrigger,
 * scheduleSuggest }` fires the registered function after a quiet period.
 *
 * Post-typing debounce for an imperative panel trigger: `{ registerTrigger, scheduleSuggest }` re-arms
 * one `debounceMs` timer per keystroke and fires the registered fn only while `enabled` and still
 * mounted. Use when: An editor that asks a sibling AI panel to suggest once the writer pauses
 * (WorkEditor ↔ LiveContinuationPanel).
 */

import { useCallback, useEffect, useRef } from 'react';
import useMounted from '../../hooks/useMounted';

// useLiveSuggest: post-typing debounce for a live AI suggestion panel (extracted from WorkEditor, #3387). The panel registers its imperative suggest fn via `registerTrigger`; the editor calls `scheduleSuggest()` on every keystroke, which (re)arms a single `debounceMs` timer so the trigger fires once the writer pauses.
// `enabled` gates arming entirely (pass `liveMode.enabled && viewMode === 'edit'`) so a deferred fire can't hit a closed panel or a non-typing view; the timer is cleared on unmount and the mounted guard re-checked before firing, so a pending suggest never lands on a dead editor.
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
