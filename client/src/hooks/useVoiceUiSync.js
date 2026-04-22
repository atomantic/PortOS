// Keeps the voice server's UI index in sync with the current page.
//
// Runs only when voice is enabled. Pushes a fresh index:
// - On route change (useLocation dependency).
// - On DOM mutations, debounced so burst renders only send one update.
// - Imperatively via pushUiIndex(delay) — used by ui_* action handlers in
//   VoiceWidget to emit right after a click/fill so the pipeline's in-turn
//   "wait for refresh" can chain the next action.
//
// State lives on refs owned by the mounted hook, so StrictMode double-
// invocation and HMR remounts don't leave stale timers or signature caches.
// An escape-hatch module-level ref gives the post-action helper a handle
// without requiring every ui_* handler to thread through React context.

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import socket from '../services/socket.js';
import { buildIndex, clearRefs } from '../services/domIndex.js';

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
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      if (activePush === schedule) activePush = null;
    };
  }, [enabled, location.pathname, location.search]);
};
