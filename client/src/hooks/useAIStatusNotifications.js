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
 *   - Silent-op *errors* are coalesced per-provider within a short rolling
 *     window (see COALESCE below). An unattended background job that fans out
 *     one AI call per record (e.g. a multi-goal check-in via `Promise.all` in
 *     server/services/goalCheckIn.js) can produce N systematic failures at
 *     once — each with a unique op id, so Toast's content dedupe can't collapse
 *     them. Instead of N stacked red toasts the user never watched start, they
 *     get ONE toast that counts the failures. User-triggered ops (those that
 *     passed `op` → not silent) still toast immediately, individually, with the
 *     provider's real reason — that behavior is load-bearing for #2733's
 *     single-voice Go-deeper design and is intentionally left untouched.
 */
export function useAIStatusNotifications() {
  // Per-op state: { silent, opened, slowTimer? }
  const opsRef = useRef(new Map());
  // Per-provider silent-error coalescing: providerKey -> { toastId, count, timer }
  const silentErrorsRef = useRef(new Map());

  useEffect(() => {
    const SLOW_CALL_MS = 2500;
    // Rolling window over which concurrent silent-op failures from the same
    // provider collapse into a single counted toast. A burst from `Promise.all`
    // arrives near-simultaneously, well inside this window; genuinely
    // spaced-out failures (> window apart) each show their real reason again.
    const SILENT_ERROR_WINDOW_MS = 4000;

    const phaseIcon = {
      start: '🤖',
      'model:loading': '📦',
      'model:loaded': '✅',
      complete: '✓',
      error: '✕'
    };

    // Collapse a burst of silent-op failures from one provider into a single
    // toast keyed by provider. The first failure in the window shows the real
    // reason; subsequent failures update the SAME toast with a running count.
    const coalesceSilentError = (event) => {
      const key = event.providerId || event.providerName || '__unknown_provider__';
      const providerLabel = event.providerName || event.providerId || 'AI provider';
      const entry = silentErrorsRef.current.get(key);

      if (!entry) {
        const toastId = `ai-silent-error::${key}`;
        const fresh = { toastId, count: 1, timer: undefined };
        fresh.timer = setTimeout(() => silentErrorsRef.current.delete(key), SILENT_ERROR_WINDOW_MS);
        silentErrorsRef.current.set(key, fresh);
        toast.error(event.message || `${providerLabel} background AI call failed`, {
          id: toastId, duration: 6000, icon: '✕'
        });
        return;
      }

      entry.count += 1;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => silentErrorsRef.current.delete(key), SILENT_ERROR_WINDOW_MS);
      toast.error(`${providerLabel} failed on ${entry.count} background AI calls`, {
        id: entry.toastId, duration: 6000, icon: '✕'
      });
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
        opsRef.current.delete(event.id);
        // User-triggered ops toast immediately, individually, with the real
        // reason — failures the user is waiting on matter and must not be
        // aggregated away. Silent-op failures (unattended background jobs) are
        // coalesced per-provider so a systematic failure yields one toast, not N.
        if (state.silent || event.silent) {
          coalesceSilentError(event);
        } else {
          toast.error(event.message || 'AI call failed', { id: event.id, duration: 6000, icon: '✕' });
        }
      }
    };

    socket.on('ai:status', handleStatus);
    return () => {
      socket.off('ai:status', handleStatus);
      for (const s of opsRef.current.values()) {
        if (s.slowTimer) clearTimeout(s.slowTimer);
      }
      opsRef.current.clear();
      for (const e of silentErrorsRef.current.values()) {
        if (e.timer) clearTimeout(e.timer);
      }
      silentErrorsRef.current.clear();
    };
  }, []);
}
