import { useState, useEffect } from 'react';
import socket from '../services/socket';

// Shared sidebar-list fetch pattern: load once on mount, reload when the server
// announces a change to one of the list's records (`events`) or the socket
// reconnects, and refresh on window focus (debounced 30s so tab-switching
// doesn't hammer the API). Guards against re-rendering the consumer when the
// list is unchanged via an id|name signature compare. Sorts by name
// (case-insensitive) so the caller always receives a stable, display-ready array.
//
// `fetchFn` must accept `{ silent: true }` (it owns its own error handling via
// the warn below, so the API helper should not also toast) and resolve to an
// array. Pass a stable function reference (a module-level `api.*` export is
// stable) and a module-level `events` array; `label` is a plain string used
// only in the warn message.
const sigOf = (list) => list.map((item) => `${item.id}|${item.name}`).join('||');
const byName = (a, b) =>
  (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
const NO_EVENTS = [];
// Record events fire on every save of a record (a manuscript edit, a scene
// render landing), so a burst collapses into one names read.
const RECORD_EVENT_COALESCE_MS = 1000;

export function useFocusRefreshedList(fetchFn, label = 'list', events = NO_EVENTS) {
  const [items, setItems] = useState([]);
  useEffect(() => {
    let lastSuccessAt = 0;
    let cancelled = false;
    let coalesceTimer = null;
    // Mount, focus, reconnect and record-event reads can overlap. A response
    // older than one already applied is dropped, so a slow stale list never
    // restores a deleted row, while a newer read that FAILED doesn't discard it.
    let issuedRead = 0;
    let appliedRead = 0;
    const load = () => {
      const read = ++issuedRead;
      fetchFn({ silent: true })
        .then((result) => {
          if (cancelled || read < appliedRead) return;
          appliedRead = read;
          lastSuccessAt = Date.now();
          const next = (Array.isArray(result) ? result : []).slice().sort(byName);
          setItems((prev) => (sigOf(prev) === sigOf(next) ? prev : next));
        })
        .catch((err) => {
          console.warn(`⚠️ Sidebar ${label} fetch failed: ${err?.message || err}`);
        });
    };
    load();
    const onFocus = () => {
      if (Date.now() - lastSuccessAt < 30_000) return;
      load();
    };
    const onRecordChanged = () => {
      if (coalesceTimer) return;
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null;
        load();
      }, RECORD_EVENT_COALESCE_MS);
    };
    window.addEventListener('focus', onFocus);
    for (const event of events) socket.on(event, onRecordChanged);
    if (events.length) socket.on('connect', load);
    return () => {
      cancelled = true;
      clearTimeout(coalesceTimer);
      window.removeEventListener('focus', onFocus);
      for (const event of events) socket.off(event, onRecordChanged);
      if (events.length) socket.off('connect', load);
    };
  }, [fetchFn, label, events]);
  return items;
}
