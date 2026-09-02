/**
 * Runtime installer modal for BYO local generation runtimes. Streams progress
 * from a setup endpoint (SSE) and shows raw bash output line-by-line so the
 * user sees git/uv/pip progress while scripts/setup-image-video.sh runs.
 *
 * Closing the modal mid-install terminates its EventSource or fetch stream,
 * which the server interprets as a cancel and SIGTERMs the underlying child.
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, AlertCircle, Download, X } from 'lucide-react';
import { useInstallStream } from '../../hooks/useInstallStream';
import Modal from '../ui/Modal';

const MAX_LOG_LINES = 1000;

export default function RuntimeInstallModal({
  open,
  runtime,
  label,
  // Heading + completion prose. Defaults read as an install because that is
  // what every original caller does; a caller whose action is "start this
  // daemon" passes its own so the modal doesn't claim an install that isn't
  // happening.
  title,
  onClose,
  onComplete,
  installUrlBase = '/api/video-gen/setup/runtime-install',
  description = 'Cloning repo and installing python packages (large download on first run)...',
  // Extra query params for installers that support modes beyond a first-time run
  // (e.g. TRELLIS.2's `repair=1`, which re-runs setup.sh over an existing install
  // to rebuild backends that failed to compile the first time — #2952).
  params,
  // EventSource is GET-only. Installers that mutate host state use POST via the
  // hook's fetch-stream mode so a dropped connection cannot auto-retry work.
  streamMethod = 'GET',
  // Chatty installers keep the rendered log stable by batching lines.
  flushMs = 100,
}) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const query = new URLSearchParams({ runtime: runtime ?? '', ...(params || {}) });
  const url = open && runtime ? `${installUrlBase}?${query}` : null;
  const { logs, done, error, streamStarted, logsEndRef, close } = useInstallStream(
    url,
    { enabled: open && !!runtime, onComplete, maxLogLines: MAX_LOG_LINES, flushMs, method: streamMethod },
  );

  useEffect(() => { if (!open || !runtime) setConfirmingCancel(false); }, [open, runtime]);

  const installRunning = streamStarted && !done && !error;

  const performClose = () => {
    close();
    setConfirmingCancel(false);
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
      panelClassName="bg-port-card rounded-xl border border-port-border shadow-2xl overflow-hidden flex flex-col"
    >
        <div className="flex items-center justify-between px-5 py-4 border-b border-port-border">
          <div className="flex items-center gap-2.5">
            {done ? <CheckCircle2 size={18} className="text-port-success" />
              : error ? <AlertCircle size={18} className="text-port-error" />
              : <Download size={18} className="text-port-accent" />}
            <h2 id="runtime-install-title" className="text-sm font-semibold text-white">
              {title || `Installing ${label || runtime}`}
            </h2>
          </div>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-white p-1 min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="Close installer"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto bg-port-bg px-4 py-3 font-mono text-[11px] leading-relaxed">
          {logs.length === 0 ? (
            <div className="text-gray-500 italic flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" />
              Connecting to installer...
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
                  ? `${label || runtime} is ready. You can close this window.`
                  : error
                    ? 'Installer hit an error - see logs above.'
                    : description}
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
