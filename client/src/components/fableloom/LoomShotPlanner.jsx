import { useEffect, useState } from 'react';
import { Loader2, Scissors } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { applyLoomEpisodeShots, planLoomEpisodeShots } from '../../services/api';
import { analyzeEpisodeShots } from '../../../../server/lib/fableLoomShots.js';

export default function LoomShotPlanner({ loom, episode, route, guidance, disabled, onLoomUpdate, onRunningChange }) {
  const [plan, setPlan] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [run, running] = useAsyncAction(async (apply = false) => {
    const result = await planLoomEpisodeShots(loom.id, episode.id, { ...route, guidance, apply, maxRounds: 3 }, { silent: true });
    setPlan(result);
    if (result.loom) onLoomUpdate(result.loom);
  }, { errorMessage: 'Shot planning failed' });
  const [apply, applying] = useAsyncAction(async () => {
    const result = await applyLoomEpisodeShots(loom.id, episode.id, { sourceFingerprint: plan.sourceFingerprint, groups: plan.groups }, { silent: true });
    onLoomUpdate(result.loom);
    setPlan({ ...plan, ...result });
  }, { errorMessage: 'Could not apply shot plan' });
  useEffect(() => { onRunningChange?.(running || applying); }, [running, applying, onRunningChange]);
  const timing = analyzeEpisodeShots(episode);
  const busy = disabled || running || applying;
  return <section className="rounded border border-port-border p-3 space-y-3" aria-label="Timed shot planning">
    <h4 className="font-semibold text-sm flex items-center gap-2"><Scissors size={15} /> Split dramatic scenes into shots</h4>
    <p className="text-xs text-port-text-muted">One node becomes one 5–10 second render. The selected model drafts and reviews short shots before replacing scene nodes. Branches stay connected. Applying clears old scene media; preview first or let autopilot apply a passing plan.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={busy || !episode.nodes.length} onClick={() => run(false)} className="min-h-11 rounded border border-port-border px-3 text-sm disabled:opacity-50">{running ? <Loader2 size={14} className="inline animate-spin mr-2" /> : null}Preview shot split</button>
      <button type="button" disabled={busy || !episode.nodes.length} onClick={() => setConfirmation('autopilot')} className="min-h-11 rounded bg-port-accent px-3 text-sm text-white disabled:opacity-50">Run shot autopilot</button>
    </div>
    {confirmation && <ConfirmButtonPair
      prompt={`Replace ${episode.nodes.length} existing scene nodes and remove their rendered media bindings?`}
      confirmText={confirmation === 'autopilot' ? 'Replace with shot autopilot' : 'Replace with reviewed shots'}
      busy={busy}
      onConfirm={() => { const action = confirmation; setConfirmation(null); if (action === 'autopilot') run(true); else apply(); }}
      onCancel={() => setConfirmation(null)}
      largeTouchTargets
      className="flex-wrap"
    />}
    {timing.stats.shotCount > 0 ? <p className="text-xs">{timing.stats.dramaticSceneCount} dramatic scenes · {timing.stats.shotCount} shots · {timing.stats.totalAssetSeconds}s across all branches</p> : <p className="text-xs text-port-warning">This episode has not been planned as timed shots yet.</p>}
    {timing.issues.map((issue) => <p key={`${issue.nodeId}-${issue.code}`} className="text-xs text-port-error">{issue.message}</p>)}
    {plan ? <div className="space-y-2">
      <p className="text-xs">{plan.review.summary}</p>
      {!plan.loom ? <button type="button" disabled={busy} onClick={() => setConfirmation('apply')} className="min-h-11 rounded bg-port-accent px-3 text-sm text-white">Apply reviewed shots</button> : null}
      {plan.groups.map((group) => <details key={group.sceneId} className="rounded border border-port-border p-2">
        <summary className="cursor-pointer min-h-11 text-sm">{episode.nodes.find((node) => node.id === group.sceneId)?.shot?.dramaticSceneTitle || episode.nodes.find((node) => node.id === group.sceneId)?.title || 'Dramatic scene'} · {group.shots.length} shots</summary>
        {group.shots.map((shot, index) => <div key={`${group.sceneId}-${index}`} className="border-t border-port-border py-2 text-xs space-y-1">
          <p className="font-semibold">{index + 1}. {shot.title} · {shot.durationSeconds}s</p><p>{shot.framing}</p><p>{shot.action}</p>
          {shot.dialogue.map((line, lineIndex) => <p key={`${index}-${lineIndex}`}>{line.speaker}: {line.text}</p>)}
        </div>)}
      </details>)}
    </div> : null}
  </section>;
}
