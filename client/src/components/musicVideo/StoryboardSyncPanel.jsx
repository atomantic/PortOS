import { useContext, useMemo, useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { setMusicVideoShotSync, syncMusicVideoShots } from '../../services/api';
import { formatCount } from '../../utils/formatters';
import { ShotLockContext } from './ShotLock.jsx';
import { storyboardFitSong } from '../../../../server/lib/storyboardFit.js';
import { storyboardShotSyncPlan } from '../../../../server/lib/storyboardShotSync.js';

const actionButton = 'min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';
const plural = (n, word) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

/** What a sync does, in words: "2 shots move, 1 new, …" (only the parts that happen). */
function syncSummary(counts) {
  return [
    counts.retimed && `${plural(counts.retimed, 'shot')} move`,
    counts.added && `${formatCount(counts.added)} new`,
    counts.updated && `${formatCount(counts.updated)} take${counts.updated === 1 ? 's' : ''} the panel's new words`,
    counts.removed && `${formatCount(counts.removed)} removed`,
  ].filter(Boolean).join(', ');
}

/**
 * Sync shots: one shot per storyboard panel, at the panel's own time on the
 * song (lib/storyboardShotSync.js, the same plan the server writes). The
 * preview says what moves, what is new and what goes, and which locked shots
 * hold. Syncing once keeps the shots in sync after every board edit
 * (`project.storyboardSync`), which the switch turns off or on. A shot keeps
 * everything it owns (prompts, takes, transitions, effects).
 */
export default function StoryboardSyncPanel({ project, board, disabled, onSynced, onBoardStale }) {
  const lockValue = useContext(ShotLockContext);
  const [removeLocked, setRemoveLocked] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState(null);
  const song = useMemo(() => storyboardFitSong(project), [project]);
  const plan = useMemo(() => storyboardShotSyncPlan(board, project, {
    song, locks: lockValue?.locks || null, clipLocks: lockValue?.clips || null, removeLocked,
  }), [board, project, song, lockValue, removeLocked]);
  const on = project.storyboardSync === true;
  const { counts } = plan;
  const lockedRemovals = plan.removed.filter((shot) => shot.locked && !shot.videoLocked);
  const blocked = [...plan.shots.filter((shot) => shot.blocked), ...plan.removed.filter((shot) => shot.blocked)];
  const summary = syncSummary(counts);

  const write = async () => {
    setConfirming(false);
    setWriting(true);
    setError(null);
    const res = await syncMusicVideoShots(project.id, { boardUpdatedAt: board.updatedAt, projectUpdatedAt: project.updatedAt, removeLocked }, { silent: true })
      .catch((err) => {
        setError(err?.message || 'The shots could not be synced.');
        if (err?.code === 'STORYBOARD_CHANGED') onBoardStale();
        return null;
      });
    setWriting(false);
    if (res?.project) onSynced(res.project);
  };
  const toggle = async () => {
    setWriting(true);
    setError(null);
    const res = await setMusicVideoShotSync(project.id, !on, { silent: true })
      .catch((err) => { setError(err?.message || 'Could not change the sync.'); return null; });
    setWriting(false);
    if (res?.project) onSynced(res.project);
  };

  if (plan.problem) return <p className="text-xs text-port-warning">{plan.problem}</p>;
  return (
    <section aria-label="Sync shots" className="space-y-2">
      <p className="text-xs text-gray-400">
        One shot per panel, at the panel&apos;s own time on the song. {plan.inSync
          ? `The ${plural(plan.shots.length, 'shot')} match the storyboard.`
          : `${summary || 'Shots relabel and reorder'}.`}
        {counts.held > 0 && ` ${plural(counts.held, 'locked shot')} keep${counts.held === 1 ? 's' : ''} its words until you tap Update on Shots.`}
        {plan.spans.gapSec > 0 && ` The panels end ${plan.spans.gapSec.toFixed(2)} s before the song does.`}
      </p>
      {blocked.length > 0 && (
        <ul className="space-y-0.5 text-xs text-port-warning" aria-label="Shots the sync leaves">
          {blocked.slice(0, 8).map((shot) => (
            <li key={shot.sceneId}>{(project.scenes || []).find((scene) => scene.sceneId === shot.sceneId)?.label || 'A shot'}: {shot.blocked}</li>
          ))}
          {blocked.length > 8 && <li>and {formatCount(blocked.length - 8)} more</li>}
        </ul>
      )}
      {(lockedRemovals.length > 0 || removeLocked) && (
        <label className="flex min-h-[44px] items-center gap-2 text-xs text-gray-300">
          <input type="checkbox" checked={removeLocked} onChange={(e) => setRemoveLocked(e.target.checked)} className="h-4 w-4" />
          Also remove locked shots no panel keeps
        </label>
      )}
      {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
      {confirming ? (
        <InlineConfirmRow autoFocus aria-label="Sync the shots" tone="warning" confirmText="Sync shots"
          question={`${summary}? Removed shots' takes stay in the video's collection.`}
          onConfirm={write} onCancel={() => setConfirming(false)} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {!plan.inSync && (
            <button type="button" onClick={() => (counts.removed ? setConfirming(true) : write())} disabled={disabled || writing}
              className={`${actionButton} bg-port-accent/20 border-port-accent/50`}>
              {writing ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Link2 size={16} aria-hidden="true" />} Sync {plural(plan.shots.length, 'shot')}
            </button>
          )}
          <button type="button" role="switch" aria-checked={on} onClick={toggle} disabled={disabled || writing}
            className={`${actionButton} ${on ? 'border-port-accent text-port-accent' : ''}`}>
            Keep in sync after each edit
          </button>
        </div>
      )}
    </section>
  );
}
