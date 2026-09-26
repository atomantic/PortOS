import { useEffect, useRef, useState, useCallback } from 'react';
import * as api from '../services/api';
import socket from '../services/socket';
import { useSocketSubscription } from './useSocketSubscription.js';
import { useVisibilityEvent } from './useVisibilityEvent.js';

/** PM2 snapshots: one entry read, pushed updates, and reconnect/reshow recovery. */
export function useProcessSnapshot(appId, { enabled = true } = {}) {
  const [state, setState] = useState({ appId, data: null, loading: true, error: null });
  const refreshRef = useRef(null);
  const applyRef = useRef(null);
  const identityRef = useRef(appId);
  identityRef.current = appId;
  const applySnapshot = useCallback(data => {
    if (identityRef.current === appId) applyRef.current?.(data);
  }, [appId]);
  const refetch = useCallback(() => refreshRef.current?.(), []);

  useEffect(() => {
    let active = true;
    let pending = false;
    let trailing = false;
    let revision = 0;
    setState({ appId, data: null, loading: enabled, error: null });
    if (!enabled) return;

    const refresh = async () => {
      if (!active || document.visibilityState === 'hidden') return;
      if (pending) { trailing = true; return; }
      pending = true;
      const started = revision;
      await api.getProcessesList({ appId, silent: true }).then(data => {
        if (active && revision === started) setState({ appId, data, loading: false, error: null });
      }).catch(error => {
        if (active && revision === started) setState(prev => ({ ...prev, loading: false, error }));
      });
      pending = false;
      if (active && trailing) { trailing = false; void refresh(); }
    };
    const apply = data => {
      ++revision;
      if (Array.isArray(data)) setState({ appId, data, loading: false, error: null });
      else setState(prev => ({ ...prev, loading: false, error: new Error('PM2 status unavailable') }));
    };
    applyRef.current = apply;
    const onSnapshot = frame => {
      if (appId ? !frame?.appIds?.includes(appId) : !frame?.defaultHome) return;
      apply(frame.processes);
    };
    refreshRef.current = refresh;
    socket.on('processes:changed', onSnapshot);
    void refresh();
    return () => {
      active = false;
      refreshRef.current = null;
      applyRef.current = null;
      socket.off('processes:changed', onSnapshot);
    };
  }, [appId, enabled]);

  useSocketSubscription('processes', { enabled, onResubscribe: refetch });
  useVisibilityEvent(state => { if (state === 'visible') refetch(); });
  return { ...state, data: enabled && state.appId === appId ? state.data : null, refetch, applySnapshot };
}
