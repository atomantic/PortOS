import { useCallback, useEffect, useRef, useState } from 'react';
import socket from '../services/socket';
import toast from '../components/ui/Toast';
import useMounted from './useMounted';

const STATUS_TEXT = {
  'api-error': 'The provider API could not complete the sync',
  'no-browser': 'No browser tab available — open the Browser page and try again',
  'extraction-failed': 'Could not extract messages from the browser page',
  skipped: 'Sync skipped — no usable token is available; authenticate and try again',
  'push-only': 'This account receives pushed updates; use its provider sync control',
};

// HTTP and socket results share one terminal decision, including older frames
// with no status. An error body must never be mistaken for legacy success.
function outcome(result, label, successText) {
  const status = result?.status ?? (result?.error ? 'error' : 'success');
  const reason = result?.reason || result?.error || STATUS_TEXT[status] || status;
  if (status === 'success') return { type: 'success', text: successText(result ?? {}), refresh: true };
  if (status === 'auth-required') return {
    type: 'warning', auth: true, text: 'Login required — open Browser page to authenticate',
  };
  if (status === 'partial') return { type: 'warning', text: `${label} incomplete: ${reason}`, refresh: true };
  if (status === 'skipped' || status === 'push-only') return { type: 'warning', text: reason };
  return { type: 'error', text: `${label} failed: ${reason}` };
}

/** One per-account cycle joins manual HTTP and socket terminal notifications. */
export function useAccountSyncStatus({ eventPrefix, label, successText, onRefresh, onStart, onTerminal }) {
  const [syncing, setSyncing] = useState({});
  const mounted = useMounted();
  const cycles = useRef(new Map());
  const callbacks = useRef({});
  callbacks.current = { label, successText, onRefresh, onStart, onTerminal };

  const begin = useCallback((accountId, manual = false) => {
    const cycle = { awaitingStart: manual, settled: false };
    cycles.current.set(accountId, cycle);
    setSyncing(prev => ({ ...prev, [accountId]: 'syncing' }));
    callbacks.current.onStart?.(accountId);
    return cycle;
  }, []);

  const finish = useCallback((accountId, result, expectedCycle) => {
    if (!mounted.current) return;
    let cycle = cycles.current.get(accountId);
    if (expectedCycle && cycle !== expectedCycle) return;
    if (cycle?.settled) return;
    if (!cycle) {
      cycle = {};
      cycles.current.set(accountId, cycle);
    }
    cycle.settled = true;
    const current = callbacks.current;
    const terminal = outcome(result, current.label, current.successText);
    setSyncing(prev => ({ ...prev, [accountId]: terminal.auth ? 'auth-required' : null }));
    current.onTerminal?.(accountId);
    toast[terminal.type](terminal.text);
    if (terminal.refresh) current.onRefresh?.();
  }, [mounted]);

  useEffect(() => {
    const started = ({ accountId }) => {
      const cycle = cycles.current.get(accountId);
      // A server start acknowledges the manual cycle; it must not orphan its
      // pending HTTP response. Later starts open a fresh notification cycle.
      if (cycle?.awaitingStart && !cycle.settled) cycle.awaitingStart = false;
      else begin(accountId);
    };
    const completed = ({ accountId, ...result }) => finish(accountId, result);
    const failed = ({ accountId, error }) => finish(accountId, { status: 'error', error: error ?? 'unknown error' });
    const authRequired = ({ accountId }) => finish(accountId, { status: 'auth-required' });
    const handlers = { started, completed, failed, 'auth-required': authRequired };
    for (const [event, handler] of Object.entries(handlers)) socket.on(`${eventPrefix}:sync:${event}`, handler);
    return () => {
      for (const [event, handler] of Object.entries(handlers)) socket.off(`${eventPrefix}:sync:${event}`, handler);
      cycles.current.clear();
    };
  }, [eventPrefix, begin, finish]);

  const sync = useCallback(async (accountId, request) => {
    const cycle = begin(accountId, true);
    // Callers use silent API requests: this hook owns the single outcome toast.
    const result = await request().catch(error => ({
      status: 'error', error: error?.message || 'Sync request failed',
    }));
    finish(accountId, result, cycle);
  }, [begin, finish]);

  return { syncing, sync };
}
