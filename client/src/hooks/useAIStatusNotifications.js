import { useEffect, useRef } from 'react';
import toast from '../components/ui/Toast';
import socket from '../services/socket';

/**
 * Subscribe to server-side AI operation status events and render them as
 * live-updating toasts so the user can see what AI providers/models are
 * being called, when a model is being loaded into memory, and when each
 * call finishes.
 *
 * Phases (from server/services/aiStatusEvents.js):
 *   start          — request kicked off
 *   model:loading  — provider auto-loading a model (slow, always show)
 *   model:loaded   — model is in memory and ready
 *   complete       — call finished
 *   error          — call failed
 *
 * UX rules:
 *   - Each op id maps to one toast; phases mutate the same toast.
 *   - "Silent" ops (callers that didn't pass `op`/`opLabel`) only render
 *     toasts when something user-visible happens: model loading, model loaded,
 *     errors, or calls that take longer than a couple seconds.
 *   - Non-silent ops render from the start so the user sees feedback for
 *     explicit actions (Generate Summary, etc.) even on fast calls.
 */
export function useAIStatusNotifications() {
  // Per-op state: { silent, opened, slowTimer? }
  const opsRef = useRef(new Map());

  useEffect(() => {
    const SLOW_CALL_MS = 2500;

    const phaseIcon = {
      start: '🤖',
      'model:loading': '📦',
      'model:loaded': '✅',
      complete: '✓',
      error: '✕'
    };

    const showLoading = (event) => {
      const state = opsRef.current.get(event.id) || { silent: false };
      // Once a toast is opened, the deferred slow-call timer is no longer needed —
      // letting it fire later would re-show a stale start message and clobber
      // the model:loading/model:loaded toast we just opened.
      if (state.slowTimer) {
        clearTimeout(state.slowTimer);
        state.slowTimer = undefined;
      }
      state.opened = true;
      opsRef.current.set(event.id, state);
      toast.loading(event.message, { id: event.id, icon: phaseIcon[event.phase] || '🤖' });
    };

    const handleStatus = (event) => {
      const state = opsRef.current.get(event.id) || { silent: !!event.silent, opened: false };
      opsRef.current.set(event.id, state);

      if (event.phase === 'start') {
        if (!state.silent) showLoading(event);
        // For silent ops, defer toast until something user-visible happens or
        // until the call exceeds SLOW_CALL_MS.
        else if (!state.opened) {
          state.slowTimer = setTimeout(() => {
            const cur = opsRef.current.get(event.id);
            if (cur && !cur.opened) {
              showLoading({ id: event.id, message: event.message, phase: 'start' });
            }
          }, SLOW_CALL_MS);
        }
        return;
      }

      if (event.phase === 'model:loading' || event.phase === 'model:loaded') {
        // Always surface model load events regardless of silent flag — these
        // are the ones the user is most likely to be waiting on.
        showLoading(event);
        return;
      }

      if (event.phase === 'complete') {
        if (state.slowTimer) clearTimeout(state.slowTimer);
        if (state.opened) {
          // Update the existing toast to a brief success that auto-dismisses.
          toast.success(event.message, { id: event.id, duration: 2500 });
        }
        opsRef.current.delete(event.id);
        return;
      }

      if (event.phase === 'error') {
        if (state.slowTimer) clearTimeout(state.slowTimer);
        // Always show errors, even for silent ops — failures matter.
        toast.error(event.message || 'AI call failed', { id: event.id, duration: 6000, icon: '✕' });
        opsRef.current.delete(event.id);
      }
    };

    socket.on('ai:status', handleStatus);
    return () => {
      socket.off('ai:status', handleStatus);
      for (const s of opsRef.current.values()) {
        if (s.slowTimer) clearTimeout(s.slowTimer);
      }
      opsRef.current.clear();
    };
  }, []);
}
