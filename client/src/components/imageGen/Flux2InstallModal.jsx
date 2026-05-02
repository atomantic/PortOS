/**
 * FLUX.2 venv installer modal. Streams progress from
 * GET /api/image-gen/setup/flux2-install (SSE) and animates a 5-stage pipeline
 * so the user sees something is happening during the multi-GB torch download.
 *
 * Stages match the events emitted by installFlux2Venv() in pythonSetup.js:
 *   detect → venv → upgrade-pip → install → verify → complete
 *
 * Closing the modal mid-install (X button or backdrop click) terminates the
 * EventSource, which the server interprets as a cancel and SIGTERMs pip.
 */

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, AlertCircle, Download, X } from 'lucide-react';
import { safeParseJSON } from '../../lib/genUtils';

// Cap on retained log lines. A torch install can emit hundreds of pip output
// lines; without this the array grows unbounded and re-renders cost more per
// append (slice copy is O(n) but n is bounded).
const MAX_LOG_LINES = 500;

const STAGES = [
  { id: 'detect',      label: 'Detect Python' },
  { id: 'venv',        label: 'Create venv' },
  { id: 'upgrade-pip', label: 'Upgrade pip' },
  { id: 'install',     label: 'Install packages' },
  { id: 'verify',      label: 'Verify' },
];

const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s.id, i]));

export default function Flux2InstallModal({ open, onClose, onComplete }) {
  const [currentStage, setCurrentStage] = useState(null);
  const [logs, setLogs] = useState([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const logsEndRef = useRef(null);
  const esRef = useRef(null);
  // Stash onComplete in a ref so the EventSource effect doesn't re-run (and
  // tear down the SSE connection) every time the parent re-renders with a
  // fresh inline arrow. Without this, ImageGen's frequent state churn
  // (gallery, generating, localProgress) would kill the install mid-stream.
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  const appendLog = (entry) => setLogs((prev) => {
    const next = prev.length >= MAX_LOG_LINES ? [...prev.slice(-(MAX_LOG_LINES - 1)), entry] : [...prev, entry];
    return next;
  });

  useEffect(() => {
    if (!open) {
      setCurrentStage(null);
      setLogs([]);
      setDone(false);
      setError(null);
      setConfirmingCancel(false);
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      return;
    }

    const es = new EventSource('/api/image-gen/setup/flux2-install');
    esRef.current = es;

    es.onmessage = (ev) => {
      const msg = safeParseJSON(ev.data);
      if (!msg) return;
      if (msg.type === 'stage') {
        setCurrentStage(msg.stage);
        appendLog({ kind: 'stage', text: msg.message || msg.stage });
      } else if (msg.type === 'log') {
        appendLog({ kind: 'log', text: msg.message });
      } else if (msg.type === 'complete') {
        setDone(true);
        appendLog({ kind: 'success', text: msg.message });
        es.close();
        esRef.current = null;
        onCompleteRef.current?.();
      } else if (msg.type === 'error') {
        setError(msg.message);
        appendLog({ kind: 'error', text: msg.message });
        es.close();
        esRef.current = null;
      }
    };

    es.onerror = () => {
      // Network drop or server killed the stream. If we already saw `complete`
      // this is harmless; otherwise surface it so the user isn't stuck on a
      // forever-spinning modal.
      setError((prev) => prev ?? (done ? null : 'Connection to installer lost. Restart PortOS or try again.'));
      es.close();
      esRef.current = null;
    };

    return () => {
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
    };
    // onComplete intentionally excluded — it lives in onCompleteRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Auto-scroll on every log line. `behavior: 'auto'` (instant) avoids
  // queueing hundreds of smooth-scroll animations during a chatty pip install.
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'auto', block: 'end' });
    }
  }, [logs.length]);

  if (!open) return null;

  const installRunning = !done && !error && currentStage && currentStage !== 'verify';

  const performClose = () => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    onClose();
  };

  const handleClose = () => {
    if (installRunning) { setConfirmingCancel(true); return; }
    performClose();
  };

  const stageIdx = currentStage ? STAGE_INDEX[currentStage] ?? -1 : -1;

  return (
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[8vh]">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={handleClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="flux2-install-title"
        className="relative w-full max-w-2xl mx-4 bg-port-card rounded-xl border border-port-border shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-port-border">
          <div className="flex items-center gap-2.5">
            <Download size={18} className="text-port-accent" />
            <h2 id="flux2-install-title" className="text-sm font-semibold text-white">
              Installing FLUX.2 Runtime
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

        {/* Stage pipeline */}
        <div className="px-5 py-4 border-b border-port-border bg-port-bg/40">
          <div className="flex items-center justify-between gap-2">
            {STAGES.map((s, i) => {
              const isDone = done || stageIdx > i;
              const isCurrent = !done && stageIdx === i && !error;
              const isFailed = error && stageIdx === i;
              return (
                <div key={s.id} className="flex-1 flex flex-col items-center">
                  <div className="flex items-center w-full">
                    <div
                      className={`flex items-center justify-center w-8 h-8 rounded-full border-2 transition-colors ${
                        isFailed
                          ? 'border-port-error bg-port-error/20 text-port-error'
                          : isDone
                            ? 'border-port-success bg-port-success/20 text-port-success'
                            : isCurrent
                              ? 'border-port-accent bg-port-accent/20 text-port-accent'
                              : 'border-port-border bg-port-bg text-gray-500'
                      }`}
                    >
                      {isFailed ? (
                        <AlertCircle size={16} />
                      ) : isDone ? (
                        <CheckCircle2 size={16} />
                      ) : isCurrent ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <span className="text-[10px] font-bold">{i + 1}</span>
                      )}
                    </div>
                    {i < STAGES.length - 1 && (
                      <div
                        className={`flex-1 h-0.5 mx-1 transition-colors ${
                          isDone ? 'bg-port-success' : 'bg-port-border'
                        }`}
                      />
                    )}
                  </div>
                  <span
                    className={`mt-2 text-[10px] text-center leading-tight ${
                      isCurrent ? 'text-port-accent font-medium' : 'text-gray-400'
                    }`}
                  >
                    {s.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Live log */}
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
                  entry.kind === 'stage'
                    ? 'text-port-accent font-semibold mt-1'
                    : entry.kind === 'success'
                      ? 'text-port-success font-semibold'
                      : entry.kind === 'error'
                        ? 'text-port-error'
                        : 'text-gray-400'
                }
              >
                {entry.kind === 'stage' && '▸ '}
                {entry.text}
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>

        {/* Footer */}
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
                  ? '✅ FLUX.2 is ready. You can close this window.'
                  : error
                    ? '⚠️ Installer hit an error — see logs above.'
                    : 'Downloading torch + diffusers from PyPI/git. ~3-10 minutes on first run.'}
              </span>
              <button
                onClick={handleClose}
                disabled={!done && !error && !currentStage}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  done
                    ? 'bg-port-success text-white hover:bg-port-success/80'
                    : error
                      ? 'bg-port-border text-white hover:bg-port-border/70'
                      : 'bg-port-border text-gray-300 hover:bg-port-border/70 disabled:opacity-50'
                }`}
              >
                {done ? 'Done' : error ? 'Close' : 'Cancel'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
