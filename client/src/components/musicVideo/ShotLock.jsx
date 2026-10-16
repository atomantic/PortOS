import { createContext, useContext } from 'react';
import { Lock, LockOpen } from 'lucide-react';

/**
 * Per-shot locks for the open project: `locks` maps a sceneId to its still's
 * lock — `locked`, `changed` (locked, then edited) or `open`; `clips` maps a
 * video shot to its clip's lock the same way (null for a shot with no video
 * step: a still, card or code shot locks once). `toggle(sceneId, lock, stage)`
 * locks or unlocks one shot's `still` or `video`; `lockAll(stills, videos)` locks
 * many at once. `unlocked` is `unlockedShots`
 * (the shots the Shots checklist counts as not locked yet). Null outside a
 * project, or for a document storyboard, which has no per-shot locks.
 */
export const ShotLockContext = createContext(null);

/** `'still'` or `'video'` when the Shots checklist counts this shot's still or video as not locked yet, else null. */
export function shotUnlocked(value, sceneId) {
  if (value?.unlocked?.stills?.includes(sceneId)) return 'still';
  return value?.unlocked?.videos?.includes(sceneId) ? 'video' : null;
}

export const SHOT_LOCK_LABELS = Object.freeze({ locked: 'Locked', still: 'Still locked, video not locked yet', changed: 'Changed since locked', open: 'Not locked' });

/**
 * A shot's lock as one state: `locked` once every step is (a video shot's
 * still and clip), `still` while only a video shot's still is, else the
 * still's own `changed` or `open`.
 */
export function overallShotLock(still, clip) {
  if (still !== 'locked') return still;
  if (clip == null || clip === 'locked') return 'locked';
  return clip === 'changed' ? 'changed' : 'still';
}

/** The lock state of one shot, or null when shots are not lockable here. */
export function useShotLock(sceneId) {
  const value = useContext(ShotLockContext);
  const still = sceneId && value?.locks ? value.locks[sceneId] : null;
  if (!still) return null;
  const clip = value.clips?.[sceneId] ?? null;
  return { state: overallShotLock(still, clip), still, clip, unlocked: shotUnlocked(value, sceneId), toggle: (lock, stage = 'still') => value.toggle(sceneId, lock, stage), busy: !!value.busy };
}

const baseCls = 'inline-flex min-h-[44px] shrink-0 items-center justify-center gap-1 rounded border px-2 text-xs disabled:opacity-50 sm:min-h-[28px]';
const toneCls = { locked: 'border-port-success/50 bg-port-success/10 text-port-success', changed: 'border-port-warning/50 bg-port-warning/10 text-port-warning', open: 'border-port-border text-port-text' };

function LockButton({ lock, locking, stage, tone, label, title, iconOnly = false, compact = false, className = '' }) {
  const Icon = locking ? LockOpen : Lock;
  return (
    <button type="button" onClick={() => lock.toggle(locking, stage)} disabled={lock.busy} aria-pressed={!locking}
      title={title} aria-label={iconOnly ? label : undefined} className={`${baseCls} ${toneCls[tone]} ${compact ? 'max-sm:min-w-[44px]' : ''} ${className}`}>
      <Icon size={14} aria-hidden="true" />
      {!iconOnly && (compact ? <span className="max-sm:sr-only">{label}</span> : label)}
    </button>
  );
}

/**
 * The tap that moves one shot through its locks. A still, card or code shot
 * locks once. A video shot locks its still (ready to render), then, once it
 * has a clip, its video; Unlock steps back one lock at a time. An edited lock
 * keeps its warning color and says so in its title. `compact` shows only the
 * icons on a phone, keeping each label as the accessible name.
 */
export function ShotLockButton({ scene, compact = false, className = '' }) {
  const lock = useShotLock(scene?.sceneId);
  if (!lock) return null;
  const { still, clip } = lock;
  const video = clip != null;
  if (still !== 'locked') {
    const changed = still === 'changed' ? 'Changed since locked. ' : '';
    return <LockButton compact={compact} lock={lock} locking stage="still" tone={still === 'changed' ? 'changed' : 'open'} className={className}
      label={video ? 'Lock still' : 'Lock'}
      title={`${changed}${video ? 'Approve this still so its clip can be rendered' : 'Lock this shot'}`} />;
  }
  if (!video) return <LockButton compact={compact} lock={lock} locking={false} stage="still" tone="locked" label="Unlock" title="Locked. Tap to unlock." className={className} />;
  if (clip === 'locked') return <LockButton compact={compact} lock={lock} locking={false} stage="video" tone="locked" label="Unlock video" title="Video locked: this shot can't change. Tap to unlock the video." className={className} />;
  if (!scene.videoHistoryId) return <LockButton compact={compact} lock={lock} locking={false} stage="still" tone="locked" label="Unlock still" title="Still locked: make its clip, then lock the video. Tap to unlock the still." className={className} />;
  return (
    <span className={`inline-flex shrink-0 gap-1 ${className}`}>
      <LockButton compact={compact} lock={lock} locking stage="video" tone={clip === 'changed' ? 'changed' : 'open'} label="Lock video" title={`${clip === 'changed' ? 'Changed since locked. ' : ''}Lock this clip so the shot can't change`} />
      <LockButton compact={compact} lock={lock} locking={false} stage="still" tone="locked" iconOnly label="Unlock still" title="Still locked. Tap to unlock the still." />
    </span>
  );
}
