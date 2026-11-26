import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, SlidersHorizontal } from 'lucide-react';
import Drawer from '../../Drawer';
import BrailleSpinner from '../../BrailleSpinner';
import socket from '../../../services/socket';
import useMounted from '../../../hooks/useMounted';
import { formatContextTokens } from '../../../utils/formatters';
import { compactTuning } from './assessmentDetails';

/**
 * One runtime's tuning knobs as a form.
 *
 * Every field starts EMPTY, which means "leave the daemon on its own default" —
 * not zero. Pre-filling a number would silently pin a value the user never
 * chose and make two "default" readings incomparable.
 */
function TuningFields({ specs, draft, onChange, disabled }) {
  if (!specs.length) return null;
  const set = (id, value) => onChange({ ...draft, [id]: value });
  return (
    <div className="space-y-2">
      {specs.map((spec) => {
        const fieldId = `tuning-${spec.id}`;
        const value = draft[spec.id] ?? '';
        return (
          <div key={spec.id} className="grid grid-cols-[1fr_auto] gap-2 items-start">
            <div className="min-w-0">
              <label htmlFor={fieldId} className="text-xs text-gray-300">{spec.label}</label>
              <p className="text-[10px] text-gray-500 leading-snug">{spec.hint}</p>
              {/* What PortOS will DO with the knob, naming the flag or variable
                  it becomes. Derived server-side from the knob's transport
                  (server/lib/localModelTuning.js) and shipped on the spec, so
                  the UI cannot describe a transport differently from the code
                  that applies it. */}
              <p className="text-[10px] text-gray-600 leading-snug">{spec.note}</p>
            </div>
            {spec.type === 'boolean' ? (
              <input
                id={fieldId}
                type="checkbox"
                disabled={disabled}
                checked={value === true}
                onChange={(e) => set(spec.id, e.target.checked ? true : '')}
                className="mt-1 accent-port-accent"
              />
            ) : spec.type === 'enum' ? (
              <select
                id={fieldId}
                disabled={disabled}
                value={value}
                onChange={(e) => set(spec.id, e.target.value)}
                className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white w-28"
              >
                <option value="">default</option>
                {spec.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                id={fieldId}
                type="number"
                inputMode="decimal"
                disabled={disabled}
                min={spec.min}
                max={spec.max}
                step={spec.step || 1}
                placeholder="default"
                value={value}
                onChange={(e) => set(spec.id, e.target.value === '' ? '' : Number(e.target.value))}
                className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white w-28"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// Consent gate. PortOS never calls a provider the user didn't knowingly ask for,
// so this names the exact backend, model, and generation count before the first
// request goes out.
export default function AssessmentDrawer({
  target, unknownTarget, runtimeLabel, contextTokens, tuningSpecs, tuning, onTuningChange,
  onClose, onConfirm, running, activeTargetRef,
}) {
  const [showTuning, setShowTuning] = useState(false);

  // The progress listener stays mounted with the drawer so it can receive the
  // first frame as soon as a run starts, without updating the results page.
  const [progress, setProgress] = useState(null);
  const mountedRef = useMounted();

  // A run is one blocking POST, so without this the UI shows a spinner for
  // minutes. The server streams per-sample frames over the same
  // `localLlm:progress` event model pulls and migrations use — hence the strict
  // filtering below, or a background model download would drive this bar.
  useEffect(() => {
    const handleProgress = (frame) => {
      if (!mountedRef.current) return;
      if (frame?.scope !== 'assessment') return;
      const target = activeTargetRef.current;
      // Frames for a model this panel is not measuring (another tab measuring
      // something else, a run the user already cancelled) are dropped rather
      // than rendered — a stale message is worse than none.
      if (!target || frame.backend !== target.backend || frame.modelId !== target.modelId) return;
      if (frame.event === 'complete') { setProgress(null); return; }
      setProgress({
        message: frame.message || '',
        sampleIndex: Number.isFinite(frame.sampleIndex) ? frame.sampleIndex : null,
        sampleCount: Number.isFinite(frame.sampleCount) ? frame.sampleCount : null,
      });
    };
    socket.on('localLlm:progress', handleProgress);
    return () => socket.off('localLlm:progress', handleProgress);
  }, [activeTargetRef, mountedRef]);

  useEffect(() => {
    if (!running) setProgress(null);
  }, [running]);

  if (!target) return null;
  const tunedCount = Object.keys(compactTuning(tuning)).length;
  return (
    <Drawer
      open
      onClose={onClose}
      title="Measure this model"
      subtitle={target.modelId}
      size="md"
      // Closing IS stopping — the close button aborts the run in flight — so
      // both accidental-dismissal paths are shut off while one is working, and
      // the icon-only close button says what it will actually do.
      closeLabel={running ? 'Stop the assessment' : 'Close'}
      closeOnEsc={!running}
      closeOnBackdrop={!running}
    >
      <div className="space-y-4">
        {unknownTarget && (
          <p className="text-xs text-port-warning flex items-start gap-1.5" role="alert">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            This model is not in the current list — it may have been removed since the link was made.
            Running it will still ask {runtimeLabel} for it.
          </p>
        )}
        <p className="text-sm text-gray-400">
          PortOS will run <span className="text-gray-200 font-mono break-all">{target.modelId}</span> on{' '}
          <span className="text-gray-200">{runtimeLabel}</span>{' '}
          {contextTokens.length} time{contextTokens.length === 1 ? '' : 's'} — one short generation at each of{' '}
          {contextTokens.map(formatContextTokens).join(', ')} tokens of context — and record what it measured.
        </p>
        <p className="text-xs text-gray-500">
          Nothing else on this page calls a model. This can take several minutes on a large model, and it
          loads the model into memory. The result stays on this machine and is never synced to a peer.
        </p>

        {/* Tuning is opt-in and collapsed: the common case is "measure it as it
            is", and an expanded knob wall would make that click look risky. A
            tuned run is stored as its OWN record, so it never overwrites the
            defaults reading it should be compared against. */}
        {tuningSpecs.length > 0 && (
          <div className="border border-port-border rounded-lg">
            <button
              type="button"
              onClick={() => setShowTuning((v) => !v)}
              disabled={running}
              aria-expanded={showTuning}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs text-gray-300 hover:text-white transition-colors disabled:opacity-50"
            >
              <span className="flex items-center gap-1.5">
                <SlidersHorizontal size={12} />
                Tuning {tunedCount > 0 && <span className="text-port-accent">({tunedCount} set)</span>}
              </span>
              {showTuning ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {showTuning && (
              <div className="px-3 pb-3 space-y-2">
                <p className="text-[10px] text-gray-500">
                  Leave a field empty to use the runtime&apos;s own default. A tuned run is recorded
                  separately, so you can compare it against the untuned one instead of replacing it.
                  Setting a launch knob restarts that runtime&apos;s server before measuring, which
                  interrupts anything else using it.
                </p>
                <TuningFields specs={tuningSpecs} draft={tuning} onChange={onTuningChange} disabled={running} />
              </div>
            )}
          </div>
        )}
        {/* Live per-sample progress off the `localLlm:progress` socket event, so a
            multi-minute run reports which sample it is on instead of a bare spinner.
            Absent until the first frame arrives — never a fake 0%. */}
        {running && progress && (
          <div className="space-y-1" aria-live="polite">
            {Number.isFinite(progress.sampleCount) && progress.sampleCount > 0 && (
              <div className="h-1 rounded bg-port-border overflow-hidden">
                <div
                  className="h-full bg-port-accent transition-all"
                  style={{ width: `${Math.round((Math.min(progress.sampleIndex ?? 0, progress.sampleCount) / progress.sampleCount) * 100)}%` }}
                />
              </div>
            )}
            <p className="text-[11px] text-gray-400 break-words">{progress.message}</p>
          </div>
        )}
        <div className="flex gap-3 pt-1">
          {/* Stays enabled while the run is in flight — it aborts the request
              rather than merely closing the drawer, so the user is never stuck
              watching a multi-minute job they no longer want. */}
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-port-card border border-port-border hover:border-port-accent text-white text-sm font-medium rounded-lg transition-colors"
          >
            {running ? 'Stop' : 'Cancel'}
          </button>
          <button
            onClick={onConfirm}
            disabled={running}
            className="flex-1 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-port-on-accent text-sm font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {running ? <><BrailleSpinner /> Measuring…</> : <>Run assessment</>}
          </button>
        </div>
      </div>
    </Drawer>
  );
}
