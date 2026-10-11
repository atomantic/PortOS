import { AlertTriangle, Merge, Scissors } from 'lucide-react';
import { formatDurationSec } from '../../utils/formatters.js';
import { getFalVideoModel } from '../../lib/falVideoModels.js';

/** Stateless provider plan and scene split/merge controls, without wrapper DOM. */
export default function SceneTimingPlan({ timing, sceneId, lipSyncBackend, onSplit, onMergeNext }) {
  const {
    performance, performanceBlocked, capability, plan, performanceCost,
    falTake, falCost, grokPlan, timedSpan, canSplit, splitLimit, canMerge,
  } = timing;
  return (
    <>
      {performance && performanceBlocked && (
        <div role="alert" className="flex items-start gap-2 rounded border border-port-warning/40 bg-port-warning/10 px-2 py-1.5 text-xs text-port-warning">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          <span className="min-w-0 break-words">{performanceBlocked}</span>
        </div>
      )}
      {performance && !performanceBlocked && (
        <p className="text-[11px] text-port-text-muted break-words" data-testid="performance-plan">
          Lip-sync via {capability.label} ({capability.modelId}) · song {formatDurationSec(plan.windowStartSec)}–{formatDurationSec(plan.windowEndSec)}
          {plan.editInSec > 0 ? ` · shot starts ${plan.editInSec.toFixed(2)}s into the take` : ''} · {performanceCost}
        </p>
      )}
      {falTake && !falTake.performance && (
        <p className="text-[11px] text-port-text-muted break-words" data-testid="fal-cutaway-plan">
          fal.ai renders {falTake.seconds != null ? `a ${falTake.seconds}s ` : 'a '}clip on {getFalVideoModel(falTake.modelId)?.label || falTake.modelId}
          {' · '}{falCost || 'cost unknown — billed to your fal.ai account'}
        </p>
      )}
      {grokPlan && (
        <p className={`text-[11px] break-words ${grokPlan.needsSplit ? 'text-port-warning' : 'text-port-text-muted'}`}>
          Grok renders a {grokPlan.requestSec}s clip for this {timedSpan.toFixed(1)}s cutaway
          {grokPlan.needsSplit ? ` — ${grokPlan.uncoveredSec.toFixed(1)}s uncovered; split the scene rather than loop it` : ''}. Motion timing in the prompt is approximate.
        </p>
      )}
      {canSplit && onSplit && (
        <button type="button" onClick={() => onSplit(sceneId, lipSyncBackend || null)}
          className="inline-flex items-center gap-1 rounded bg-port-bg border border-port-border hover:bg-port-border/40 px-2 py-1 text-xs min-h-[44px] sm:min-h-0"
          title={`Cut this ${timedSpan.toFixed(1)}s shot into scenes of at most ${splitLimit.toFixed(2)}s at lyric pauses or phrase boundaries — nothing is looped or stretched`}>
          <Scissors size={13} /> Split on lyric boundaries
        </button>
      )}
      {canMerge && (
        <button type="button" onClick={() => onMergeNext(sceneId, lipSyncBackend || null)}
          className="inline-flex items-center gap-1 rounded bg-port-bg border border-port-border hover:bg-port-border/40 px-2 py-1 text-xs min-h-[44px] sm:min-h-0"
          title="Join this shot with the next one into a single shot — the inverse of split">
          <Merge size={13} /> Merge with next
        </button>
      )}
    </>
  );
}
