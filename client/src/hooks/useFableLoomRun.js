import { useCallback, useEffect, useRef, useState } from 'react';
import socket from '../services/socket';
import { useSocketSubscription } from './useSocketSubscription';
import { useVisibilityEvent } from './useVisibilityEvent';

const terminal = run => ['completed', 'paused', 'failed', 'canceled'].includes(run?.status);

/** Snapshot stream with entry/reconnect recovery and identity-safe mutation replies. */
export function useFableLoomRun({ loomId, episodeId = null, event, loadRun, onTerminal }) {
  const key = JSON.stringify([loomId, episodeId]);
  const [state, setState] = useState({ key, run: null });
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
    const accept = run => {
      if (!active() || !run || run.loomId !== loomId
        || (episodeId && run.episodeId !== episodeId) || retired.has(run.id)) return;
      if (current?.id === run.id && run.revision != null && current.revision >= run.revision) return;
      if (current && current.id !== run.id) {
        if (run.createdAt < current.createdAt) return;
        retired.add(current.id);
      }
      current = run;
      revision += 1;
      setState({ key, run });
      const terminalKey = `${run.id}:${run.attempt || 1}`;
      if (terminal(run) && !handled.has(terminalKey)) {
        handled.add(terminalKey);
        callbacks.current.onTerminal?.(run, () => active() && current?.id === run.id);
      }
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
          await Promise.resolve().then(() => callbacks.current.loadRun()).then(run => {
            if (active() && revision === started) {
              if (run) accept(run);
              else {
                current = null;
                revision += 1;
                setState({ key, run: null });
              }
            }
          }).catch(() => {});
        } while (reconcileAgain && active() && document.visibilityState !== 'hidden');
        pending = null;
      });
      return pending;
    };
    controller.current = { key, accept, read };
    setState({ key, run: null });
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
  return { run: state.key === key ? state.run : null, applyRun };
}
