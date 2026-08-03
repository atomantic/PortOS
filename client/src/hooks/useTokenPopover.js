import { useCallback, useEffect, useRef, useState } from 'react';

// useTokenPopover — hover/click state machine for the prose-token popover.
//
// Extracted from WorkEditor (#3387). Owns two pieces of state:
//
//   `pop`    — the open popover: `{ kind, refId, anchorEl, pinned }`, or null.
//              `anchorEl` is the DOM ELEMENT (not a frozen DOMRect) so the
//              popover can re-read getBoundingClientRect on each reflow and
//              stay attached to its token through scrolling and resizes.
//   `hotRef` — `{ kind, refId }` cross-link hot state that ties prose tokens to
//              SceneCard chips and bible rows. Lit on hover BEFORE the popover
//              opens, and cleared only when the popover actually closes.
//
// Timing: 200ms to open, 150ms grace to close, so the popover doesn't flicker
// as the cursor crosses a token. While pinned (opened by click), hover-driven
// opens are ignored — the user explicitly pinned it and shouldn't see it ripped
// out from under them; they close it first (X or Escape) before another token
// can take over.
export default function useTokenPopover() {
  const [pop, setPop] = useState(null);
  const [hotRef, setHotRef] = useState(null);

  const openTimerRef = useRef(null);
  const closeTimerRef = useRef(null);
  // Mirror of `pop?.pinned` so callbacks can read pinned state without
  // re-binding (and so setPop updaters stay pure — StrictMode replays the
  // updater and would emit duplicate setHotRef side effects otherwise).
  const pinnedRef = useRef(false);
  useEffect(() => { pinnedRef.current = !!pop?.pinned; }, [pop?.pinned]);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const onTokenEnter = useCallback(({ kind, refId, anchor }) => {
    if (pinnedRef.current) return;
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    setHotRef({ kind, refId });
    openTimerRef.current = setTimeout(() => {
      setPop({ kind, refId, anchorEl: anchor, pinned: false });
    }, 200);
  }, []);

  // Schedule the 150ms grace close. Idempotent: clears any existing close timer
  // first so rapid enter/leave events can't pile up multiple pending timeouts
  // that fire later and clear pop/hotRef unexpectedly. The timer also nulls its
  // own ref after firing so external clearTimeouts on a stale id are a no-op.
  //
  // hotRef is only cleared when the popover actually closes (i.e. it wasn't
  // pinned). When pinned, the popover stays visible and the cross-link
  // highlights (SceneCard chips / bible rows) must stay lit too — clearing
  // hotRef there would leave the popover orphaned from its visual targets.
  const scheduleClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      if (pinnedRef.current) return;
      setPop(null);
      setHotRef(null);
    }, 150);
  }, []);

  const onTokenLeave = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    scheduleClose();
  }, [scheduleClose]);

  // Cursor crossed from token onto the popover itself: cancel the pending close
  // so the user can click links inside without it dismissing on them.
  const onPopoverEnter = useCallback(() => {
    clearTimers();
  }, [clearTimers]);

  // Cursor left the popover (and didn't go back to a token): schedule the same
  // 150ms grace close as token-leave.
  const onPopoverLeave = useCallback(() => {
    scheduleClose();
  }, [scheduleClose]);

  const onTokenClick = useCallback(({ kind, refId, anchor }) => {
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    setPop({ kind, refId, anchorEl: anchor, pinned: true });
  }, []);

  // Closing the popover (whether by Escape, X click, or auto-leave) must also
  // drop the hot state and any pending hover timers; otherwise SceneCard chips
  // and bible rows can stay highlighted indefinitely after the cursor has moved
  // on.
  const closePopover = useCallback(() => {
    clearTimers();
    setPop(null);
    setHotRef(null);
  }, [clearTimers]);

  useEffect(() => () => {
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  return { pop, hotRef, onTokenEnter, onTokenLeave, onTokenClick, onPopoverEnter, onPopoverLeave, closePopover };
}
