import { AlertTriangle } from 'lucide-react';
import { formatDurationSec } from '../../utils/formatters.js';
import { meteredModelLabel } from '../../lib/musicVideoShotTiming.js';

/** Stateless provider plan for one shot's render, without wrapper DOM. Splitting and merging live in SceneShotCuts. */
export default function SceneTimingPlan({ timing, lipSyncBackend }) {
  const {
    performance, performanceBlocked, capability, plan, performanceCost,
    falTake, falCost, grokPlan, timedSpan,
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
          {capability.style === 'music' ? 'Music-driven' : 'Lip-sync'} via {capability.label} ({capability.modelId}) · song {formatDurationSec(plan.windowStartSec)}–{formatDurationSec(plan.windowEndSec)}
          {plan.editInSec > 0 ? ` · shot starts ${plan.editInSec.toFixed(2)}s into the take` : ''} · {performanceCost}
        </p>
      )}
      {falTake && !falTake.performance && (
        <p className="text-[11px] text-port-text-muted break-words" data-testid="fal-cutaway-plan">
          {lipSyncBackend === 'runway' ? 'Runway' : 'fal.ai'} renders {falTake.seconds != null ? `a ${falTake.seconds}s ` : 'a '}clip on {meteredModelLabel(falTake.modelId) || falTake.modelId}
          {' · '}{falCost || `cost unknown — billed to your ${lipSyncBackend === 'runway' ? 'Runway' : 'fal.ai'} account`}
        </p>
      )}
      {grokPlan && (
        <p className={`text-[11px] break-words ${grokPlan.needsSplit ? 'text-port-warning' : 'text-port-text-muted'}`}>
          Grok renders a {grokPlan.requestSec}s clip for this {timedSpan.toFixed(1)}s cutaway
          {grokPlan.needsSplit ? ` — ${grokPlan.uncoveredSec.toFixed(1)}s uncovered; split the scene rather than loop it` : ''}. Motion timing in the prompt is approximate.
        </p>
      )}
    </>
  );
}
