import { useState } from 'react';
import { AlertTriangle, Merge, Scissors } from 'lucide-react';
import { formatDurationSec } from '../../utils/formatters.js';
import { getFalVideoModel } from '../../lib/falVideoModels.js';

const SPLIT_BUTTON = 'inline-flex items-center gap-1 rounded bg-port-bg border border-port-border hover:bg-port-border/40 px-2 py-1 text-xs min-h-[44px] sm:min-h-0';
// The shortest piece the server leaves on either side of a split (projectsLogic MIN_SPLIT_PIECE_SEC).
const MIN_PIECE_SEC = 0.1;
const tenth = (sec) => Math.round(sec * 10) / 10;

/** Cut a shot in two at a time the director picks on a slider (default: its middle). */
function SplitAt({ sceneId, startSec, endSec, onSplit }) {
  const [open, setOpen] = useState(false);
  const min = tenth(startSec + MIN_PIECE_SEC);
  const max = tenth(endSec - MIN_PIECE_SEC);
  const [atSec, setAtSec] = useState(() => tenth((startSec + endSec) / 2));
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={SPLIT_BUTTON} title="Cut this shot in two at a time you pick">
        <Scissors size={13} /> Split shot
      </button>
    );
  }
  const inputId = `mv-scene-${sceneId}-split-at`;
  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-2 text-xs">
      <label htmlFor={inputId} className="shrink-0">Split at</label>
      <input id={inputId} type="range" min={min} max={max} step={0.1} value={Math.min(max, Math.max(min, atSec))}
        onChange={(e) => setAtSec(Number(e.target.value))} className="min-w-0 flex-1 basis-32" />
      <span className="shrink-0 tabular-nums text-port-text-muted">{(atSec - startSec).toFixed(1)}s in · {formatDurationSec(atSec)}</span>
      <button type="button" onClick={() => { onSplit(sceneId, null, atSec); setOpen(false); }} className={SPLIT_BUTTON}>
        <Scissors size={13} /> Split here
      </button>
      <button type="button" onClick={() => setOpen(false)} className={SPLIT_BUTTON}>Cancel</button>
    </div>
  );
}

/** Stateless provider plan and scene split/merge controls, without wrapper DOM. `span` (the shot's start and end) offers a manual split. */
export default function SceneTimingPlan({ timing, sceneId, lipSyncBackend, onSplit, onMergeNext, onMergePrevious = null, span = null }) {
  const {
    performance, performanceBlocked, capability, plan, performanceCost,
    falTake, falCost, grokPlan, timedSpan, canSplit, splitLimit, canMerge, canMergePrevious,
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
      {onSplit && span && span.endSec - span.startSec >= 2 * MIN_PIECE_SEC + 0.1 && (
        <SplitAt key={`${span.startSec}-${span.endSec}`} sceneId={sceneId} startSec={span.startSec} endSec={span.endSec} onSplit={onSplit} />
      )}
      {canMergePrevious && onMergePrevious && (
        <button type="button" onClick={() => onMergePrevious(sceneId, lipSyncBackend || null)}
          className="inline-flex items-center gap-1 rounded bg-port-bg border border-port-border hover:bg-port-border/40 px-2 py-1 text-xs min-h-[44px] sm:min-h-0"
          title="Remove the previous shot and start this one where it started">
          <Merge size={13} /> Merge over previous
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
