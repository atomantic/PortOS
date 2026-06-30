/**
 * Live sample gallery for an in-flight training run.
 *
 * The trainer renders a preview image every `sampleEvery` steps (SAMPLE lines
 * on the wire). This surfaces that evolution as it happens: a large current
 * preview, a step-keyed thumbnail strip to scrub back through earlier samples,
 * a loss sparkline, and step/ETA metrics — so you can watch the LoRA learn (and
 * catch a late divergence) instead of waiting for the run to finish.
 *
 * Samples merge two sources so a mid-run reload still shows the full timeline:
 *   - a one-shot seed from GET /runs/:id/samples (every sample persisted so far)
 *   - live SSE frames carrying { currentImage, step } (samples since subscribe)
 * Live wins on a duplicate step. The loss series is live-only (the run record
 * keeps just the last step), so it builds up over the session.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff, Radio } from 'lucide-react';
import { formatDurationMs } from '../../utils/formatters';
import { useTimeTick } from '../../hooks/useTimeTick';
import { lossSparklineGeometry } from '../../lib/lossSparkline';
import { listLoraTrainingSamples } from '../../services/api';

const SPARK_W = 240;
const SPARK_H = 36;

function LossSparkline({ series }) {
  const { points, last } = lossSparklineGeometry(series, { width: SPARK_W, height: SPARK_H });
  if (!points) return null;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-gray-500 mb-0.5">
        <span>Loss</span>
        <span className="text-gray-400">{last.toFixed(4)}</span>
      </div>
      <svg
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        preserveAspectRatio="none"
        className="w-full h-9 bg-port-bg rounded border border-port-border"
        role="img"
        aria-label={`Training loss curve, latest ${last.toFixed(4)}`}
      >
        <polyline points={points} fill="none" stroke="#3b82f6" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

export default function LiveSampleGallery({ run, frames, progress, message }) {
  const [seed, setSeed] = useState([]);
  const [selectedStep, setSelectedStep] = useState(null);
  // Seconds-precision tick for the elapsed/ETA labels — shared, visibility-
  // aware timer (pauses when the tab is hidden) instead of a per-mount interval.
  const now = useTimeTick(1000);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // One-shot seed of every sample persisted so far (survives a mid-run reload).
  useEffect(() => {
    if (!run?.id) return;
    listLoraTrainingSamples(run.id)
      .then((res) => { if (mountedRef.current) setSeed(Array.isArray(res?.samples) ? res.samples : []); })
      .catch(err => console.warn('⚠️ Failed to load training samples: ' + err.message));
  }, [run?.id]);

  // Merge seed + live frames into a step-sorted, dedup'd sample list.
  const samples = useMemo(() => {
    const byStep = new Map();
    for (const s of seed) byStep.set(s.step, s.url);
    for (const f of frames) {
      if (typeof f.currentImage === 'string' && f.currentImage && typeof f.step === 'number') {
        byStep.set(f.step, f.currentImage);
      }
    }
    return [...byStep.entries()].map(([step, url]) => ({ step, url })).sort((a, b) => a.step - b.step);
  }, [seed, frames]);

  // Live loss series for the sparkline (progress frames carry numeric loss).
  const lossSeries = useMemo(() => {
    const out = [];
    for (const f of frames) {
      if (f.type === 'progress' && typeof f.loss === 'number' && typeof f.step === 'number') {
        out.push({ step: f.step, loss: f.loss });
      }
    }
    return out;
  }, [frames]);

  const latest = samples.length ? samples[samples.length - 1] : null;
  // `selectedStep == null` means "follow the latest sample"; a pinned step
  // shows that earlier sample until the user jumps back to live.
  const selected = (selectedStep != null && samples.find((s) => s.step === selectedStep)) || latest;

  const startedAt = run?.startedAt ? new Date(run.startedAt).getTime() : null;
  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : null;
  const pct = typeof progress === 'number' ? Math.max(0, Math.min(1, progress)) : 0;
  const etaMs = elapsedMs != null && pct > 0.01 && pct < 1 ? (elapsedMs / pct) * (1 - pct) : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-col sm:flex-row gap-3">
        {/* Current / selected preview */}
        <div className="sm:w-2/5 shrink-0">
          {selected ? (
            <div className="relative">
              <img
                src={selected.url}
                alt={`sample @ step ${selected.step}`}
                className="w-full aspect-square object-cover rounded border border-port-border"
              />
              <span className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-[11px] text-white">
                step {selected.step}
              </span>
            </div>
          ) : (
            <div className="w-full aspect-square rounded border border-port-border bg-port-bg flex flex-col items-center justify-center gap-1 text-gray-500">
              <ImageOff className="w-6 h-6" />
              <span className="text-[11px] text-center px-2">
                {(run?.params?.sampleEvery ?? 0) > 0
                  ? `First preview renders at step ${run.params.sampleEvery}`
                  : 'Sample previews disabled for this run'}
              </span>
            </div>
          )}
        </div>

        {/* Metrics + loss curve */}
        <div className="flex-1 min-w-0 space-y-2">
          <div className="text-xs text-gray-400 truncate">{message || 'Starting…'}</div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-port-bg rounded border border-port-border py-1">
              <div className="text-sm text-white font-medium">{Math.round(pct * 100)}%</div>
              <div className="text-[10px] text-gray-500">progress</div>
            </div>
            <div className="bg-port-bg rounded border border-port-border py-1">
              <div className="text-sm text-white font-medium">{elapsedMs != null ? formatDurationMs(elapsedMs) : '—'}</div>
              <div className="text-[10px] text-gray-500">elapsed</div>
            </div>
            <div className="bg-port-bg rounded border border-port-border py-1">
              <div className="text-sm text-white font-medium">{etaMs != null ? `~${formatDurationMs(etaMs)}` : '—'}</div>
              <div className="text-[10px] text-gray-500">eta</div>
            </div>
          </div>
          <LossSparkline series={lossSeries} />
        </div>
      </div>

      {/* Thumbnail strip — scrub back through earlier samples */}
      {samples.length > 1 && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] text-gray-500">{samples.length} samples</span>
            {selectedStep != null && (
              <button
                type="button"
                onClick={() => setSelectedStep(null)}
                className="text-[11px] text-port-accent hover:underline flex items-center gap-1"
              >
                <Radio className="w-3 h-3" /> Jump to latest
              </button>
            )}
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {samples.map((s) => {
              const active = selected && s.step === selected.step;
              return (
                <button
                  key={s.step}
                  type="button"
                  onClick={() => setSelectedStep(selectedStep === s.step ? null : s.step)}
                  title={`step ${s.step}`}
                  className={`shrink-0 rounded border overflow-hidden ${active ? 'border-port-accent' : 'border-port-border'}`}
                >
                  <img src={s.url} alt={`step ${s.step}`} className="w-14 h-14 object-cover" loading="lazy" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
