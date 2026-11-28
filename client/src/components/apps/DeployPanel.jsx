import { useState, useRef, useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { Rocket, X, ChevronDown, Loader2 } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import Modal, { useEscLayer } from '../ui/Modal';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import usePopoverPosition from '../../hooks/usePopoverPosition';
import { useAppDeploy } from './useAppDeploy';

const FLAG_OPTIONS = [
  { value: '--ios', label: 'iOS' },
  { value: '--macos', label: 'macOS' },
  { value: '--watch', label: 'watchOS' },
  { value: '--all', label: 'All Platforms' },
  { value: '--skip-tests', label: 'Skip Tests' },
];

const PLATFORM_FLAGS = new Set(['--ios', '--macos', '--watch', '--all']);

export default function DeployPanel({ appId, appName }) {
  const { output, isDeploying, isCancelling, error, result, startDeploy, cancelDeploy, clearDeploy } = useAppDeploy(appId);
  const [popover, setPopover] = useState(null);
  const [selectedFlags, setSelectedFlags] = useState([]);
  const [dismissed, setDismissed] = useState(false);
  const outputRef = useRef(null);
  const rafRef = useRef(null);
  const hasState = isDeploying || output.length > 0 || error || result;
  const isOpen = hasState && !dismissed;
  let resultMessage;
  if (result?.success) resultMessage = 'Deploy completed successfully';
  else if (result?.cancelled) resultMessage = 'Deploy cancelled';
  else if (result?.timedOut) resultMessage = 'Deploy timed out';
  else if (result) resultMessage = `Deploy failed (exit code ${result.code})`;

  const deployRef = useRef(null);
  const optionsRef = useRef(null);
  const firstFlagRef = useRef(null);
  const popoverId = useId();
  const activePopover = isDeploying ? null : popover;
  const { triggerRef, popoverRef, style } = usePopoverPosition({
    open: Boolean(activePopover),
    position: 'below',
    align: 'start',
    width: activePopover === 'confirm' ? 280 : 208,
    minWidth: 0,
    constrainHeight: true,
    contentDeps: [activePopover],
  });

  const isPositioned = Boolean(style);

  useEscLayer(Boolean(activePopover), () => {
    if (popoverRef.current?.contains(document.activeElement)) {
      (activePopover === 'options' ? optionsRef : deployRef).current?.focus();
    }
    setPopover(null);
  });

  useEffect(() => {
    if (!activePopover) return undefined;
    const dismissOutside = event => {
      if (triggerRef.current?.contains(event.target) || popoverRef.current?.contains(event.target)) return;
      setPopover(null);
    };
    window.addEventListener('pointerdown', dismissOutside);
    return () => window.removeEventListener('pointerdown', dismissOutside);
  }, [activePopover, triggerRef, popoverRef]);

  useEffect(() => {
    if (isPositioned && activePopover === 'options') firstFlagRef.current?.focus({ preventScroll: true });
  }, [activePopover, isPositioned]);

  useEffect(() => {
    if (isDeploying) setPopover(null);
  }, [isDeploying]);

  // Throttled auto-scroll via rAF
  useEffect(() => {
    if (!outputRef.current) return;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
      rafRef.current = null;
    });
  }, [output]);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  // Pre-refactor, Esc always set dismissed=true (hide the modal, keep deploy
  // state intact so output reappears when re-opened). X / backdrop ran the
  // full handleClose which calls clearDeploy() once the deploy has finished.
  // The shared Modal dispatches Esc via onClose by default, which would call
  // clearDeploy after a finished deploy — losing the output. onEsc preserves
  // the original "Esc always hides, never clears" semantics.
  const handleEsc = () => setDismissed(true);

  const toggleFlag = (flag) => {
    setSelectedFlags(prev => {
      if (PLATFORM_FLAGS.has(flag)) {
        if (prev.includes(flag)) return prev.filter(f => f !== flag);
        return flag === '--all'
          ? [...prev.filter(f => !PLATFORM_FLAGS.has(f)), '--all']
          : [...prev.filter(f => f !== '--all'), flag];
      }
      return prev.includes(flag) ? prev.filter(f => f !== flag) : [...prev, flag];
    });
  };

  const handleDeploy = () => {
    if (isDeploying) {
      setDismissed(false);
    } else {
      setPopover('confirm');
    }
  };

  const confirmDeploy = () => {
    if (isDeploying) return;
    setPopover(null);
    setDismissed(false);
    startDeploy(selectedFlags);
  };

  const handleClose = () => {
    if (isDeploying) {
      // Hide the modal but keep state — deploy continues server-side.
      setDismissed(true);
    } else {
      // Deploy is finished; clear state so the panel resets.
      clearDeploy();
      setDismissed(false);
    }
  };

  return (
    <div ref={triggerRef} className="inline-flex">
      <div className="inline-flex rounded-lg overflow-hidden border border-port-border">
        <button
          ref={deployRef}
          onClick={handleDeploy}
          aria-expanded={isDeploying ? undefined : activePopover === 'confirm'}
          aria-controls={activePopover === 'confirm' ? popoverId : undefined}
          className="px-2 py-1 bg-port-accent-2/20 text-port-accent-2 hover:bg-port-accent-2/30 transition-colors flex items-center gap-1"
          title={isDeploying && dismissed ? 'Show deploy output' : undefined}
        >
          {isDeploying ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
          <span className="text-xs">
            {isDeploying ? (dismissed ? 'View deploy…' : 'Deploying…') : 'Deploy'}
          </span>
        </button>
        <button
          ref={optionsRef}
          onClick={() => setPopover(prev => prev === 'options' ? null : 'options')}
          aria-expanded={activePopover === 'options'}
          aria-controls={activePopover === 'options' ? popoverId : undefined}
          disabled={isDeploying}
          aria-label="Deploy options"
          className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 px-1 py-1 bg-port-accent-2/20 text-port-accent-2 hover:bg-port-accent-2/30 transition-colors disabled:opacity-50 border-l border-port-border"
        >
          <ChevronDown size={12} />
        </button>
      </div>

      {activePopover && createPortal(
        <div
          ref={popoverRef}
          id={popoverId}
          style={style ?? { visibility: 'hidden' }}
          className="fixed z-50 max-w-[calc(100vw-1rem)] overflow-auto rounded-lg border border-port-border bg-port-card shadow-xl"
        >
          {activePopover === 'options' ? (
            <div className="p-2">
              {FLAG_OPTIONS.map((opt, index) => (
                <label key={opt.value} className="flex items-center gap-2 px-2 py-1.5 hover:bg-port-border/50 rounded cursor-pointer">
                  <input
                    ref={index === 0 ? firstFlagRef : undefined}
                    type="checkbox"
                    checked={selectedFlags.includes(opt.value)}
                    onChange={() => toggleFlag(opt.value)}
                    className="accent-port-accent-2"
                  />
                  <span className="text-xs text-gray-300">{opt.label}</span>
                </label>
              ))}
              <div className="border-t border-port-border mt-1 pt-1">
                <button
                  onClick={handleDeploy}
                  className="w-full px-2 py-1.5 text-xs bg-port-accent-2/20 text-port-accent-2 hover:bg-port-accent-2/30 rounded transition-colors"
                >
                  Deploy{selectedFlags.length > 0 ? ` (${selectedFlags.join(' ')})` : ''}
                </button>
              </div>
            </div>
          ) : (
            <InlineConfirmRow
              question={<>Deploy {appName}?<br />{selectedFlags.length ? `Flags: ${selectedFlags.join(' ')}` : 'No flags selected (script defaults).'}</>}
              confirmText="Confirm deploy"
              tone="warning"
              className="wrap-anywhere"
              stacked
              autoFocus={isPositioned}
              returnFocusRef={deployRef}
              onConfirm={confirmDeploy}
              onCancel={() => setPopover(null)}
            />
          )}
        </div>,
        document.body,
      )}

      {isOpen && (
        <Modal
          open
          onClose={handleClose}
          onEsc={handleEsc}
          size="xl"
          backdropClassName="bg-black/60"
          panelClassName="bg-port-bg border border-port-border rounded-xl shadow-2xl flex flex-col"
          ariaLabelledBy="deploy-panel-title"
        >
          <div className="flex flex-wrap items-center justify-between gap-x-2 px-4 py-3 border-b border-port-border">
            <div className="flex items-center gap-2">
              <Rocket size={16} className="text-port-accent-2" />
              <span id="deploy-panel-title" className="min-w-0 wrap-anywhere text-sm font-medium text-white">Deploy: {appName}</span>
              {isDeploying && <BrailleSpinner text="" className="text-xs text-port-accent-2" />}
            </div>
            <div className="ml-auto flex items-center gap-2">
              {isDeploying && (
                <button
                  type="button"
                  onClick={cancelDeploy}
                  disabled={isCancelling}
                  className="min-h-11 rounded-lg border border-port-error/40 px-3 py-1 text-xs text-port-error hover:bg-port-error/10 disabled:opacity-60"
                >
                  {isCancelling ? 'Cancelling…' : 'Cancel deploy'}
                </button>
              )}
              <button
                onClick={handleClose}
                className="flex items-center justify-center min-h-[44px] min-w-[44px] text-gray-400 hover:text-white transition-colors"
                title={isDeploying ? 'Hide (deploy keeps running)' : 'Close'}
                aria-label={isDeploying ? 'Hide deploy output' : 'Close deploy panel'}
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div
            ref={outputRef}
            className="always-dark flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed bg-black/40"
          >
            {output.map((line, i) => (
              <div
                key={i}
                className={
                  line.stream === 'stderr' ? 'text-port-error whitespace-pre-wrap break-words' :
                  line.stream === 'status' ? 'text-port-accent-2 font-bold whitespace-pre-wrap break-words' :
                  'text-gray-300 whitespace-pre-wrap break-words'
                }
              >
                {line.text}
              </div>
            ))}
            {error && error !== resultMessage && <div role="alert" className="text-port-error mt-2 whitespace-pre-wrap break-words">Error: {error}</div>}
          </div>

          {result && (
            <div role="status" className={`px-4 py-2 border-t border-port-border text-xs ${result.success ? 'text-port-success' : 'text-port-error'}`}>
              {resultMessage}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
