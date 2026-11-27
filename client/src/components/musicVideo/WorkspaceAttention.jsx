import { keepMusicVideoSongTiming } from '../../services/apiMusicVideo.js';
import NeedsAttentionBanner from './NeedsAttentionBanner.jsx';

export default function WorkspaceAttention({
  selected, prepareSong, replaceProject, autopilot, attentionItems, renderJob,
  productionReview, castSets, review, produce, plan, keepApproval,
}) {
  return (
    <>
    {produce.takes.reconcileError && <div role="alert" className="flex flex-wrap items-center gap-2 rounded border border-port-warning/40 p-2 text-xs"><p className="text-port-warning">Take changes could not be confirmed: {produce.takes.reconcileError.message}. Reload the saved decisions before relying on this selection.</p><button type="button" className="min-h-[44px] rounded border border-port-border px-2 disabled:opacity-50 pointer-fine:sm:min-h-0" disabled={produce.takes.reconciling} onClick={produce.takes.retryReconcile}>{produce.takes.reconciling ? 'Reloading saved takes…' : 'Retry saved takes'}</button></div>}
    <NeedsAttentionBanner
      // A parked autonomous or production run with nothing to resume, while the
      // header's Autopilot button reports that run, is that button (which opens it); no second row.
      items={autopilot.label === 'Autopilot' ? attentionItems
        : attentionItems.filter((item) => !(['autonomous', 'production'].includes(item.kind) && !item.canResume))}
      busy={produce.revisions.busy || castSets.busy || review.autoReview.busy || plan.autonomous.busy || produce.production.busy || renderJob.reattaching}
      actions={{
        onResumeRevision: produce.revisions.resume,
        onCancelRevision: produce.revisions.cancel,
        onResumeCastAndSets: () => castSets.resume(),
        onContinueAutoReview: (runId) => review.autoReview.resume(runId),
        onCancelAutoReview: (runId) => review.autoReview.cancel(runId),
        onReattachRender: () => renderJob.reattach(selected.id),
        onResumeAutonomous: () => plan.autonomous.resume(),
        onResumeProduction: (runId, opts) => produce.production.resume(runId, opts),
        onKeepApproval: keepApproval,
        onRevertApproval: productionReview.revert,
        onRefreshSong: () => prepareSong(selected.id, { refresh: true }),
        onKeepSongTiming: () => keepMusicVideoSongTiming(selected.id).then(replaceProject),
      }}
    />
    </>
  );
}
