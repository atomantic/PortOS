/**
 * Manual checkpoint picker for a completed training run.
 *
 * A LoRA run keeps every periodic checkpoint, but only one is registered as
 * the usable LoRA. The trainer's FINAL step is often NOT the best — late
 * divergence (loss still dropping while the sample collapses to a black frame)
 * is a recurring FLUX.2 failure, and loss is no guide (it was anti-correlated
 * with quality on the run this was built for). So the user picks by eye from
 * the preview thumbnails; the server re-extracts that step's adapter and
 * overwrites the deployed LoRA in place.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { Layers, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import toast from '../ui/Toast';
import {
  listLoraTrainingCheckpoints,
  promoteLoraTrainingCheckpoint,
} from '../../services/api';

export default function CheckpointPicker({ run, onPromoted }) {
  const [expanded, setExpanded] = useState(false);
  const [checkpoints, setCheckpoints] = useState(null);
  const [loading, setLoading] = useState(false);
  const [promotingStep, setPromotingStep] = useState(null);
  // Guards the background preview-poll setTimeout chain from firing after the
  // component unmounts (deferred-work-respects-unmount rule). Not reset to true
  // so dev-mode double-mount can't re-arm a stale chain.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const load = useCallback(() => {
    setLoading(true);
    listLoraTrainingCheckpoints(run.id)
      .then((res) => setCheckpoints(Array.isArray(res?.checkpoints) ? res.checkpoints : []))
      .catch(err => { console.warn('⚠️ Failed to load checkpoints: ' + err.message); setCheckpoints([]); })
      .finally(() => setLoading(false));
  }, [run.id]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && checkpoints === null) load();
  };

  const promote = async (step) => {
    setPromotingStep(step);
    // If the promoted checkpoint has no thumbnail, the server renders one in the
    // background (its step wasn't on the sample cadence — e.g. the final step).
    // That render takes minutes, so poll a few times to surface it once ready
    // without a full page reload. (No socket event for this; bounded polling.)
    const lacksPreview = !checkpoints?.find((c) => c.step === step)?.hasPreview;
    try {
      await promoteLoraTrainingCheckpoint(run.id, step, { silent: true });
      toast.success(`Promoted checkpoint @ step ${step}`);
      // Reactive: mark the chosen step deployed locally, then refetch + bubble
      // up so the parent's run record (loraFilename, selected step) refreshes.
      setCheckpoints((prev) => prev?.map((c) => ({ ...c, deployed: c.step === step })) ?? prev);
      load();
      onPromoted?.();
      if (lacksPreview) {
        // Backstop poll for the background-rendered preview (~5 min on 9B).
        // Each tick re-lists; stop once the step has a preview or attempts run out.
        let attempts = 0;
        const tick = () => {
          if (!mountedRef.current) return;
          attempts += 1;
          listLoraTrainingCheckpoints(run.id)
            .then((res) => {
              if (!mountedRef.current) return;
              const list = Array.isArray(res?.checkpoints) ? res.checkpoints : [];
              setCheckpoints(list);
              const ready = list.find((c) => c.step === step)?.hasPreview;
              if (!ready && attempts < 12) setTimeout(tick, 30000);
            })
            .catch(() => { if (mountedRef.current && attempts < 12) setTimeout(tick, 30000); });
        };
        setTimeout(tick, 30000);
      }
    } catch (err) {
      toast.error(`Promote failed: ${err?.message || 'unknown error'}`);
    } finally {
      setPromotingStep(null);
    }
  };

  const autoSelected = run.output?.autoSelectedCheckpoint;

  return (
    <div className="border-t border-port-border pt-2 mt-1">
      <button
        type="button"
        onClick={toggle}
        className="text-xs text-gray-300 hover:text-white flex items-center gap-1.5"
        aria-expanded={expanded}
      >
        <Layers className="w-3.5 h-3.5 text-port-accent" />
        Checkpoints{checkpoints ? ` (${checkpoints.length})` : ''}
        <span className="text-gray-500">{expanded ? '▲' : '▼'}</span>
      </button>

      {autoSelected && (
        <div className="mt-1.5 text-[11px] text-port-warning flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          Final step diverged — auto-selected an earlier checkpoint. Review the previews and promote a better one if needed.
        </div>
      )}

      {expanded && (
        <div className="mt-2">
          {loading && (
            <div className="text-xs text-gray-400 flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading checkpoints…
            </div>
          )}
          {!loading && checkpoints?.length === 0 && (
            <div className="text-xs text-gray-500">No checkpoints recorded for this run.</div>
          )}
          {!loading && !!checkpoints?.length && (
            <>
              <div className="text-[11px] text-gray-500 mb-1.5">
                Pick by the preview — loss is shown but is not a quality ranking.
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {checkpoints.map((c) => (
                  <div
                    key={c.step}
                    className={`rounded border p-1.5 flex flex-col gap-1 ${
                      c.deployed ? 'border-port-success bg-port-success/10' : 'border-port-border bg-port-bg'
                    }`}
                  >
                    {c.previewUrl ? (
                      <img
                        src={c.previewUrl}
                        alt={`step ${c.step} preview`}
                        className="w-full aspect-square object-cover rounded"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full aspect-square rounded bg-port-card flex items-center justify-center text-[10px] text-gray-500">
                        no preview
                      </div>
                    )}
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-gray-300">step {c.step}</span>
                      {c.loss != null && <span className="text-gray-500" title="training loss (not a quality score)">L {c.loss.toFixed(3)}</span>}
                    </div>
                    {c.deployed ? (
                      <span className="text-[11px] text-port-success flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> Deployed
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => promote(c.step)}
                        disabled={promotingStep != null}
                        className="text-[11px] px-1.5 py-1 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 disabled:opacity-50 flex items-center justify-center gap-1"
                      >
                        {promotingStep === c.step ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                        Use this
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
