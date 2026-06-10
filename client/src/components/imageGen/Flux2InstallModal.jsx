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

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, AlertCircle, Download, X } from 'lucide-react';
import { useInstallStream } from '../../hooks/useInstallStream';
import Modal from '../ui/Modal';

const STAGES = [
  { id: 'detect',      label: 'Detect Python' },
  { id: 'venv',        label: 'Create venv' },
  { id: 'upgrade-pip', label: 'Upgrade pip' },
  { id: 'install',     label: 'Install packages' },
  { id: 'verify',      label: 'Verify' },
];

const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s.id, i]));

export default function Flux2InstallModal({ open, onClose, onComplete }) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  // The shared install-stream hook owns the EventSource lifecycle, log
  // accumulation, stage tracking, connection-lost handling and auto-scroll.
  // onComplete is ref-stashed inside the hook so ImageGen's frequent state
  // churn (gallery, generating, localProgress) can't kill the install
  // mid-stream by re-running the effect.
  const { logs, currentStage, done, error, logsEndRef, close } = useInstallStream(
    '/api/image-gen/setup/flux2-install',
    { enabled: open, onComplete },
  );

  // Reset the cancel-confirm prompt whenever the modal closes, so a reopen
  // never starts mid-confirmation. (The stream state itself resets inside the
  // hook when `enabled` flips false.)
  useEffect(() => { if (!open) setConfirmingCancel(false); }, [open]);

  const installRunning = !done && !error && currentStage && currentStage !== 'verify';

  const performClose = () => {
    close();
    setConfirmingCancel(false);
    onClose();
  };

  const handleClose = () => {
    if (installRunning) { setConfirmingCancel(true); return; }
    performClose();
  };

  const stageIdx = currentStage ? STAGE_INDEX[currentStage] ?? -1 : -1;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="lg"
      align="top"
      // installer needs to outrank every other overlay (incl. LayoutEditor)
      zIndexClassName="z-[9999]"
      // Esc-to-cancel was never wired pre-refactor (see file header comment:
      // install cancels via X button or backdrop click only). Keep that
      // contract so a stray Esc during a multi-GB torch download doesn't
      // SIGTERM pip mid-stream.
      closeOnEsc={false}
      // Bespoke backdrop: keep the existing blur. The pt-[10vh] from align=top
      // is fine here — the original was pt-[8vh] but the 2vh delta is
      // imperceptible (~16px) and not worth a custom override.
      backdropClassName="bg-black/70 backdrop-blur-sm"
      ariaLabelledBy="flux2-install-title"
      panelClassName="bg-port-card rounded-xl border border-port-border shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
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
    </Modal>
  );
}
