// Keeps the voice server's UI index in sync with the current page.
//
// Runs only when voice is enabled. Pushes a fresh index:
// - On route change (useLocation dependency).
// - On DOM mutations, debounced so burst renders only send one update.
// - Imperatively via pushUiIndex(delay) — used by ui_* action handlers in
//   VoiceWidget to emit right after a click/fill so the pipeline's in-turn
//   "wait for refresh" can chain the next action.
//
// LAZY visible-text payload. The index ships the lightweight structure
// (path/title/elements) but NOT the heavy visible-text blob — that runs
// extractVisibleText over the whole page and is only needed by the `ui_read`
// tool. Instead the index sets `textOnDemand: true`; when the server actually
// needs the text it emits `voice:ui:read-request`, and we compute
// extractVisibleText on the live DOM right then and reply with
// `voice:ui:read-response`. A legacy server that never sends the read-request
// still works because `ui_read` falls back to the eager-text path (an index
// that already carries `text`); the read-request handler here is purely
// additive.
//
// State lives on refs owned by the mounted hook, so StrictMode double-
// invocation and HMR remounts don't leave stale timers or signature caches.
// An escape-hatch module-level ref gives the post-action helper a handle
// without requiring every ui_* handler to thread through React context.

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import socket from '../services/socket.js';
import { buildIndex, clearRefs, extractVisibleText } from '../services/domIndex.js';

const DEBOUNCE_MS = 500;
const INITIAL_DELAY_MS = 250;
const POST_ACTION_DELAY_MS = 120;

// Reference to the currently-mounted hook's pushUiIndex function. VoiceWidget
// is a singleton in prod; this handle lets non-React callers (event handlers
// in VoiceWidget) fire an immediate push after a ui:* side effect.
let activePush = null;

// Cheap change-detection. Path/title/length rejects most non-mutations; the
// full per-element body runs only when the quick check matches.
const quickSig = (idx) => `${idx.path || ''}|${idx.title || ''}|${idx.elements.length}`;
const fullSig = (idx) => idx.elements
  .map((e) => `${e.ref}:${e.kind}:${e.label}:${e.active ?? ''}`)
  .join('|');

export const pushUiIndex = (delay = DEBOUNCE_MS) => activePush?.(delay);
export const pushUiIndexAfterAction = () => pushUiIndex(POST_ACTION_DELAY_MS);

export const useVoiceUiSync = (enabled) => {
  const location = useLocation();
  const timerRef = useRef(null);
  const quickSigRef = useRef(null);
  const fullSigRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      clearRefs();
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      quickSigRef.current = null;
      fullSigRef.current = null;
      if (activePush) activePush = null;
      return undefined;
    }

    const flush = () => {
      timerRef.current = null;
      if (document.hidden) return;
      const idx = buildIndex();
      const quick = quickSig(idx);
      if (quick === quickSigRef.current) {
        const full = fullSig(idx);
        if (full === fullSigRef.current) return;
        fullSigRef.current = full;
      } else {
        quickSigRef.current = quick;
        fullSigRef.current = fullSig(idx);
      }
      socket.emit('voice:ui:index', idx);
    };

    const schedule = (delay) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, delay);
    };

    activePush = schedule;

    // Server-driven lazy text read. The server emits voice:ui:read-request
    // when the ui_read tool needs the visible-text blob it deliberately
    // didn't ship in the index. Compute it on the live DOM right now and
    // reply. Echo back the request id (when present) so the server can
    // correlate the response with the awaiting tool call. Guard against a
    // hidden tab returning a stale snapshot — still reply (with whatever the
    // DOM holds) so the server's waiter doesn't hang on a missing response.
    const onReadRequest = (payload) => {
      const requestId = payload && typeof payload === 'object' ? payload.requestId : undefined;
      const text = extractVisibleText();
      socket.emit('voice:ui:read-response', { requestId, text });
    };
    socket.on('voice:ui:read-request', onReadRequest);

    // Reset sigs on route change so the first index for a new page always
    // emits, even if it happens to hash identically to the previous.
    quickSigRef.current = null;
    fullSigRef.current = null;
    schedule(INITIAL_DELAY_MS);

    // Scope to <main> so the voice widget's own transcript/history updates
    // don't trigger a re-index on every TTS delta. value/checked are
    // deliberately excluded from attributeFilter — they fire on every
    // keystroke into any text field and create a typing-starves-the-index
    // loop. Interactable SET changes via childList.
    const target = document.querySelector('main') || document.getElementById('root') || document.body;
    const observer = new MutationObserver(() => schedule(DEBOUNCE_MS));
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-selected', 'aria-expanded', 'disabled'],
    });

    return () => {
      observer.disconnect();
      socket.off('voice:ui:read-request', onReadRequest);
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      if (activePush === schedule) activePush = null;
    };
  }, [enabled, location.pathname, location.search]);
};
