import { useCallback, useEffect, useRef, useState } from 'react';
import { getLocalLlmStatus, installLocalLlmBackend } from '../services/api';
import socket from '../services/socket';
import toast from '../components/ui/Toast';
import { localLlmBackendLabel } from '../lib/localLlmBackends.js';

/**
 * The installed-model status both local-LLM views read, plus the one
 * busy/toast/refresh path every action on either view routes through.
 *
 * The Runtimes and Model Library views never mount together (the tab renders
 * exactly one), so each mounted view owning this hook still leaves exactly ONE
 * subscriber on `localLlm:progress` — the single-subscriber rule holds without
 * threading status down as props from a parent that renders neither view.
 *
 * @param {object}   [options]
 * @param {Function} [options.onRefresh] Extra loads to fire alongside a status
 *   refresh (the Runtimes view pulls llama.cpp / MTPLX / Slotstream here).
 * @param {Function} [options.onReload]  Extra reload after an action or a
 *   `complete` progress frame (the Library view re-queries its catalog).
 *   BOTH must be stable (`useCallback`) — they are effect dependencies.
 */
export default function useLocalLlmStatus({ onRefresh, onReload } = {}) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState('ollama');
  const [actionInProgress, setActionInProgress] = useState(null);
  const [progressMsg, setProgressMsg] = useState('');
  const [confirmAction, setConfirmAction] = useState(null);
  const progressTimer = useRef(null);
  const statusRequestId = useRef(0);
  const selectedInitialized = useRef(false);

  const loadStatus = useCallback(() => {
    const requestId = ++statusRequestId.current;
    setLoading(true);
    onRefresh?.();
    return getLocalLlmStatus({ silent: true })
      .then((s) => {
        if (requestId !== statusRequestId.current) return;
        setStatus(s);
        // Default the model-management view to the active backend on first load.
        if (!selectedInitialized.current && s?.backend) {
          setSelected(s.backend);
          selectedInitialized.current = true;
        }
      })
      .catch(() => {
        if (requestId === statusRequestId.current) toast.error('Failed to load local LLM status');
      })
      .finally(() => {
        if (requestId === statusRequestId.current) setLoading(false);
      });
  }, [onRefresh]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  useEffect(() => {
    const handleProgress = (data) => {
      // `localLlm:progress` is a shared channel. Measurement frames (`assessment`,
      // `assessment-sweep`) belong to the Performance tab and say nothing about
      // what is installed here — and an overnight sweep emits a `complete` frame
      // per model, so answering them would reload the status AND re-query the
      // Hugging Face catalog once per measured model, all night. This tab owns
      // the unscoped install/migrate/upgrade frames only.
      if (data?.scope === 'assessment' || data?.scope === 'assessment-sweep' || data?.scope === 'security-guard') return;
      clearTimeout(progressTimer.current);
      setProgressMsg(data.message || '');
      if (data.event === 'complete') {
        progressTimer.current = setTimeout(() => setProgressMsg(''), 3000);
        loadStatus();
        onReload?.();
      }
      if (data.event === 'error') {
        progressTimer.current = setTimeout(() => setProgressMsg(''), 5000);
      }
    };
    socket.on('localLlm:progress', handleProgress);
    return () => {
      socket.off('localLlm:progress', handleProgress);
      clearTimeout(progressTimer.current);
    };
  }, [loadStatus, onReload]);

  const runAction = useCallback((key, fn, successMsg, options = {}) => {
    const { onError, clearConfirm = true, ollamaService = false } = options;
    if (clearConfirm) setConfirmAction(null);
    setActionInProgress(key);
    return fn()
      .then((result) => {
        if (successMsg) toast.success(typeof successMsg === 'function' ? successMsg(result) : successMsg);
        // Optimistic repaint for the Ollama service controls only. Every runtime
        // start/stop result carries `running` — llama-server's and MTPLX's too —
        // so the CALLER declares this, rather than it being inferred from the
        // response shape; otherwise stopping MTPLX would paint Ollama as stopped
        // until the refetch lands.
        if (ollamaService && typeof result?.running === 'boolean') {
          setStatus((prev) => prev ? ({
            ...prev,
            ollama: {
              ...prev.ollama,
              installed: true,
              available: result.running
            }
          }) : prev);
        }
        loadStatus();
        onReload?.();
        return result;
      })
      .catch((err) => {
        // Caller-handled errors (e.g. OLLAMA_OUTDATED → offer to upgrade) ask us
        // to skip the default toast and run their own handler instead. The error
        // toast from apiCore has already fired unless the caller passed {silent}
        // through fn — onError just gets to consume the structured code/context.
        if (typeof onError === 'function') onError(err);
      })
      .finally(() => setActionInProgress(null));
  }, [loadStatus, onReload]);

  // Both views offer "install the missing backend" — the Runtimes card as a row
  // action, the Library as the blocker on an empty catalog — so the action lives
  // here rather than as two copies that could drift on their toast or key.
  const installBackend = useCallback((backend) => runAction(
    `runtime-install-${backend}`,
    () => installLocalLlmBackend(backend),
    (r) => r?.note ? `Installed ${localLlmBackendLabel(backend)} — ${r.note}` : `Installed ${localLlmBackendLabel(backend)}`
  ), [runAction]);

  return {
    status,
    loading,
    selected,
    setSelected,
    loadStatus,
    runAction,
    installBackend,
    actionInProgress,
    busy: actionInProgress != null,
    progressMsg,
    setProgressMsg,
    confirmAction,
    setConfirmAction,
  };
}
