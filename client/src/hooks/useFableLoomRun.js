/**
 * Revisioned editorial/production snapshots, identity-safe mutation replies and entry/reconnect/reshow
 * recovery.
 *
 * Use when: FableLoom run views.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import socket from '../services/socket';
import { useSocketSubscription } from './useSocketSubscription';
import { useVisibilityEvent } from './useVisibilityEvent';

const INITIAL_STATUS = { run: null, readState: 'loading', readError: null };

const terminal = run => ['completed', 'paused', 'failed', 'canceled'].includes(run?.status);

/** Snapshot stream with entry/reconnect recovery and identity-safe mutation replies. */
export function useFableLoomRun({ loomId, episodeId = null, event, loadRun, onTerminal }) {
  const key = JSON.stringify([loomId, episodeId]);
  const [state, setState] = useState({ key, ...INITIAL_STATUS });
  const callbacks = useRef({ loadRun, onTerminal });
  callbacks.current = { loadRun, onTerminal };
  const controller = useRef(null);
  const currentKey = useRef(key);
  currentKey.current = key;
  useSocketSubscription('fableloom', { onResubscribe: () => controller.current?.read() });

  useEffect(() => {
    let disposed = false;
    let current = null;
    let pending = null;
    let revision = 0;
    let reconcileAgain = false;
    const retired = new Set();
    const handled = new Set();
    const active = () => !disposed && currentKey.current === key;
    const matchesScope = run => typeof run?.id === 'string' && run.loomId === loomId
      && (!episodeId || run.episodeId === episodeId);
    const publishReady = () => setState({ key, run: current, readState: 'ready', readError: null });
    const accept = run => {
      if (!active() || !matchesScope(run) || retired.has(run.id)) return false;
      if (current?.id === run.id && run.revision != null && current.revision >= run.revision) return false;
      if (current && current.id !== run.id) {
        if (run.createdAt < current.createdAt) return false;
        retired.add(current.id);
      }
      current = run;
      revision += 1;
      publishReady();
      const terminalKey = `${run.id}:${run.attempt || 1}`;
      if (terminal(run) && !handled.has(terminalKey)) {
        handled.add(terminalKey);
        callbacks.current.onTerminal?.(run, () => active() && current?.id === run.id);
      }
      return true;
    };
    const read = () => {
      if (!active() || document.visibilityState === 'hidden') return;
      if (pending) {
        reconcileAgain = true;
        return pending;
      }
      pending = Promise.resolve().then(async () => {
        if (!active()) return;
        do {
          reconcileAgain = false;
          const started = revision;
          setState(previous => ({ ...previous, readState: 'loading' }));
          try {
            const run = await callbacks.current.loadRun();
            if (!active() || revision !== started) continue;
            if (run !== null && !matchesScope(run)) throw new Error('Invalid run status response');
            if (run === null) {
              current = null;
              revision += 1;
            } else if (accept(run)) {
              continue;
            }
            // A successful read can return the same revision as the last good snapshot.
            publishReady();
          } catch (error) {
            if (!active() || revision !== started) continue;
            setState({ key, run: current, readState: 'error', readError: error instanceof Error ? error : new Error('Request failed') });
          }
        } while (reconcileAgain && active() && document.visibilityState !== 'hidden');
        pending = null;
      });
      return pending;
    };
    controller.current = { key, accept, read };
    setState({ key, ...INITIAL_STATUS });
    socket.on(event, accept);
    read();
    return () => {
      disposed = true;
      controller.current = null;
      socket.off(event, accept);
    };
  }, [key, loomId, episodeId, event]);

  const visibility = useRef(document.visibilityState);
  useVisibilityEvent(next => {
    const changed = next !== visibility.current;
    visibility.current = next;
    if (changed && next === 'visible') controller.current?.read();
  });
  const applyRun = useCallback(run => {
    if (controller.current?.key === key) controller.current.accept(run);
  }, [key]);
  const retry = useCallback(() => {
    if (controller.current?.key === key) return controller.current.read();
  }, [key]);
  const { run, readState, readError } = state.key === key ? state : INITIAL_STATUS;
  return { run, readState, readError, retry, applyRun };
}
