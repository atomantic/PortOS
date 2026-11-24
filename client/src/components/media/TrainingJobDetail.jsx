import { useSocketResource } from '../../hooks/useSocketResource';
import { listLoraTrainingCheckpoints } from '../../services/apiLoraTraining.js';
import { lossSparklineGeometry } from '../../lib/lossSparkline';

const CHECKPOINT_EVENTS = ['training:checkpoints:changed'];

// One-line training summary in place of the (absent) prompt: who's training,
// the LoRA rank, and the step budget.
export function trainingSummary(params) {
  if (!params) return 'training';
  const who = (params.characterName || '').trim();
  const bits = [
    who ? `Training "${who}"` : 'Training',
    Number.isFinite(params.rank) ? `rank ${params.rank}` : null,
    Number.isFinite(params.steps) ? `${params.steps} steps` : null,
  ].filter(Boolean);
  return bits.join(' · ');
}

// Training-specific row treatment: a loss sparkline over the run's checkpoints
// plus the latest sample thumbnails. The media-job record carries no loss /
// sample data, so fetch the run's checkpoint list (step + loss + previewUrl).
// Re-fetches while the run is live so the curve grows as checkpoints land.
export default function TrainingJobDetail({ runId }) {
  const { data: checkpoints, error } = useSocketResource(async () => {
    const res = await listLoraTrainingCheckpoints(runId);
    return Array.isArray(res?.checkpoints) ? res.checkpoints : [];
  }, {
    events: CHECKPOINT_EVENTS,
    resourceKey: runId,
    matchesEvent: event => event?.runId === runId,
  });

  if (error && checkpoints === null) {
    return <div className="mt-2 text-[11px] text-port-warning">Checkpoints unavailable.</div>;
  }
  if (checkpoints === null) {
    return <div className="mt-2 text-[11px] text-port-text-muted">Loading checkpoints…</div>;
  }
  if (!checkpoints.length) {
    return (
      <div className="mt-2 text-[11px] text-port-text-muted">
        No checkpoints yet — samples + loss appear once the first one is saved.
      </div>
    );
  }

  const series = checkpoints
    .filter((c) => Number.isFinite(c.loss))
    .map((c) => ({ step: c.step, loss: c.loss }));
  const geo = lossSparklineGeometry(series, { width: 240, height: 36 });
  const withPreview = checkpoints.filter((c) => c.previewUrl);

  return (
    <div className="mt-2 space-y-2">
      {geo.points && (
        <div>
          <div className="flex items-center justify-between text-[11px] text-port-text-muted mb-0.5">
            <span>Loss · {series.length} checkpoints</span>
            {geo.last != null && <span className="text-gray-400 font-mono">{geo.last.toFixed(4)}</span>}
          </div>
          <svg
            viewBox="0 0 240 36"
            preserveAspectRatio="none"
            className="w-full h-9 bg-port-bg rounded border border-port-border"
            role="img"
            aria-label={`Training loss curve over ${series.length} checkpoints${geo.last != null ? `, latest ${geo.last.toFixed(4)}` : ''}`}
          >
            <polyline points={geo.points} fill="none" stroke="#3b82f6" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
      )}
      {withPreview.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {withPreview.map((c) => (
            <div key={c.step} className="shrink-0 text-center">
              <img
                src={c.previewUrl}
                alt={`sample @ step ${c.step}`}
                loading="lazy"
                className={`w-14 h-14 object-cover rounded border ${c.deployed ? 'border-port-accent' : 'border-port-border'}`}
              />
              <div className="text-[10px] text-port-text-muted mt-0.5">{c.step}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
