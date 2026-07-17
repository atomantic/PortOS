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
  // Per-provider silent-error coalescing: providerKey -> { toastId, count, firstReason, timer }
  const silentErrorsRef = useRef(new Map());
  // Monotonic window counter so each fresh coalescing window gets a unique toast
  // id (see coalesceSilentError) — a reused id would let a prior window's pending
  // auto-dismiss timer remove a successor window's toast.
  const windowSeqRef = useRef(0);

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
    // reason; subsequent failures update the SAME toast with a running count,
    // keeping that first reason visible so the toast stays actionable.
    const coalesceSilentError = (event) => {
      const key = event.providerId || event.providerName || '__unknown_provider__';
      const providerLabel = event.providerName || event.providerId || 'AI provider';
      const reason = event.message || `${providerLabel} background AI call failed`;
      const entry = silentErrorsRef.current.get(key);

      if (!entry) {
        // Fresh window. Give the toast a window-unique id: Toast schedules an
        // independent auto-dismiss timer per add() and never cancels it, so a
        // stable per-provider id would let a lapsed window's pending dismissal
        // remove the NEXT window's toast a second or two after it appeared.
        windowSeqRef.current += 1;
        const toastId = `ai-silent-error::${key}::${windowSeqRef.current}`;
        const fresh = { toastId, count: 1, firstReason: reason, timer: undefined };
        fresh.timer = setTimeout(() => silentErrorsRef.current.delete(key), SILENT_ERROR_WINDOW_MS);
        silentErrorsRef.current.set(key, fresh);
        toast.error(reason, { id: toastId, duration: 6000, icon: '✕' });
        return;
      }

      entry.count += 1;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => silentErrorsRef.current.delete(key), SILENT_ERROR_WINDOW_MS);
      // Retain the first real reason — the count alone doesn't tell the user
      // whether it was an expired key, a timeout, or a bad response, and these
      // events can all land before the browser paints, so the counted toast is
      // often the only one the user ever sees.
      toast.error(`${providerLabel} failed on ${entry.count} background AI calls — ${entry.firstReason}`, {
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
        // Silent-op failures (unattended background jobs) coalesce per-provider
        // so a systematic failure yields one counted toast, not N — and this
        // must hold for SLOW failures too (an unreachable endpoint / timeout,
        // where every parallel op has already opened its own spinner). Dismiss
        // that orphan-prone Infinity-duration spinner first, then coalesce, so
        // the goal-check-in flood collapses whether the provider fails fast or
        // slow. A user-triggered op always toasts immediately, individually,
        // with the real reason — load-bearing and never aggregated away.
        if (state.silent || event.silent) {
          if (state.opened) toast.dismiss(event.id);
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
