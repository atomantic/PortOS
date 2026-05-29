/**
 * BYOV video runtime installer modal. Streams progress from
 * GET /api/video-gen/setup/runtime-install?runtime=<id> (SSE) and shows the
 * raw bash output line-by-line so the user sees git-clone / uv venv / pip
 * progress as the script runs.
 *
 * Unlike Flux2InstallModal there's no animated stage pipeline — the underlying
 * scripts/setup-image-video.sh emits free-form log lines, not structured
 * stage events. Stage detection would require parsing bash echos, which
 * would rot every time the script's wording changes.
 *
 * Closing the modal mid-install (X button or Cancel) terminates the
 * EventSource, which the server interprets as a SIGTERM to the bash child.
 */

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, AlertCircle, Download, X } from 'lucide-react';
import { safeParseJSON } from '../../lib/genUtils';
import Modal from '../ui/Modal';

const MAX_LOG_LINES = 1000;

export default function RuntimeInstallModal({ open, runtime, label, onClose, onComplete }) {
  const [logs, setLogs] = useState([]);
  const [streamStarted, setStreamStarted] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const logsEndRef = useRef(null);
  const esRef = useRef(null);
  // Mirror `done` into a ref so es.onerror can read the latest value — the
  // effect's closure captures the initial `done=false` and never refreshes,
  // so without this the modal flashes "Connection to installer lost" when
  // the server cleanly closes the SSE socket right after sending `complete`.
  const doneRef = useRef(false);
  // Stash onComplete in a ref so the EventSource effect doesn't tear down
  // mid-install on every parent re-render with a fresh inline arrow.
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  // Pip and git can each emit hundreds of lines/sec. Per-line setState would
  // re-render the entire log list on every line — buffer into a ref and
  // flush on a short debounce so the React tree settles at ~10 Hz instead.
  const pendingRef = useRef([]);
  const flushTimerRef = useRef(null);
  const flush = () => {
    flushTimerRef.current = null;
    if (pendingRef.current.length === 0) return;
    const incoming = pendingRef.current;
    pendingRef.current = [];
    setLogs((prev) => {
      const combined = prev.length + incoming.length > MAX_LOG_LINES
        ? [...prev, ...incoming].slice(-MAX_LOG_LINES)
        : [...prev, ...incoming];
      return combined;
    });
  };
  const appendLog = (entry) => {
    pendingRef.current.push(entry);
    if (flushTimerRef.current == null) {
      flushTimerRef.current = setTimeout(flush, 100);
    }
  };

  useEffect(() => {
    if (!open || !runtime) {
      setLogs([]);
      setStreamStarted(false);
      setDone(false);
      doneRef.current = false;
      setError(null);
      setConfirmingCancel(false);
      pendingRef.current = [];
      if (flushTimerRef.current != null) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      return;
    }

    setStreamStarted(true);
    const es = new EventSource(`/api/video-gen/setup/runtime-install?runtime=${encodeURIComponent(runtime)}`);
    esRef.current = es;

    es.onmessage = (ev) => {
      const msg = safeParseJSON(ev.data);
      if (!msg) return;
      if (msg.type === 'log') {
        appendLog({ kind: 'log', text: msg.message });
      } else if (msg.type === 'complete') {
        setDone(true);
        doneRef.current = true;
        appendLog({ kind: 'success', text: msg.message });
        flush();
        es.close();
        esRef.current = null;
        onCompleteRef.current?.();
      } else if (msg.type === 'error') {
        setError(msg.message);
        appendLog({ kind: 'error', text: msg.message });
        flush();
        es.close();
        esRef.current = null;
      }
    };

    es.onerror = () => {
      setError((prev) => prev ?? (doneRef.current ? null : 'Connection to installer lost. Restart PortOS or try again.'));
      es.close();
      esRef.current = null;
    };

    return () => {
      if (flushTimerRef.current != null) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
    };
    // onComplete intentionally excluded — it lives in onCompleteRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runtime]);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'auto', block: 'end' });
    }
  }, [logs.length]);

  // True from the moment the EventSource opens — closing the modal between
  // the open and the first log line must still confirm before killing the
  // server-side bash child. Previously gated on `logs.length > 0`, which let
  // a quick X-click silently drop a just-started install.
  const installRunning = streamStarted && !done && !error;

  const performClose = () => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    onClose();
  };

  const handleClose = () => {
    if (installRunning) { setConfirmingCancel(true); return; }
    performClose();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="lg"
      align="top"
      zIndexClassName="z-[9999]"
      closeOnEsc={false}
      backdropClassName="bg-black/70 backdrop-blur-sm"
      ariaLabelledBy="runtime-install-title"
      panelClassName="bg-port-card rounded-xl border border-port-border shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
    >
        <div className="flex items-center justify-between px-5 py-4 border-b border-port-border">
          <div className="flex items-center gap-2.5">
            {done ? <CheckCircle2 size={18} className="text-port-success" />
              : error ? <AlertCircle size={18} className="text-port-error" />
              : <Download size={18} className="text-port-accent" />}
            <h2 id="runtime-install-title" className="text-sm font-semibold text-white">
              Installing {label || runtime}
            </h2>
          </div>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-white p-1"
            aria-label="Close installer"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto bg-port-bg px-4 py-3 font-mono text-[11px] leading-relaxed">
          {logs.length === 0 ? (
            <div className="text-gray-500 italic flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" />
              Connecting to installer…
            </div>
          ) : (
            logs.map((entry, i) => (
              <div
                key={i}
                className={
                  entry.kind === 'success' ? 'text-port-success font-semibold'
                  : entry.kind === 'error' ? 'text-port-error'
                  : 'text-gray-400'
                }
              >
                {entry.text}
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>

        <div className="px-5 py-3 border-t border-port-border flex items-center justify-between gap-3">
          {confirmingCancel ? (
            <>
              <span className="text-xs text-port-warning">
                Cancel the install? In-progress downloads will stop.
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmingCancel(false)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-port-border text-gray-300 hover:bg-port-border/70"
                >
                  Keep installing
                </button>
                <button
                  onClick={performClose}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-port-error text-white hover:bg-port-error/80"
                >
                  Yes, cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="text-xs text-gray-400">
                {done
                  ? `✅ ${label || runtime} is ready. You can close this window.`
                  : error
                    ? '⚠️ Installer hit an error — see logs above.'
                    : 'Cloning repo and installing python packages (large download on first run)…'}
              </span>
              <button
                onClick={handleClose}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  done
                    ? 'bg-port-success text-white hover:bg-port-success/80'
                    : error
                      ? 'bg-port-border text-white hover:bg-port-border/70'
                      : 'bg-port-border text-gray-300 hover:bg-port-border/70'
                }`}
              >
                {done ? 'Done' : error ? 'Close' : 'Cancel'}
              </button>
            </>
          )}
        </div>
    </Modal>
  );
}
