import { createContext, useContext } from 'react';
import { Lock, LockOpen } from 'lucide-react';

/**
 * Per-shot locks for the open project: `locks` maps a
 * sceneId to `locked`, `changed` (locked, then edited) or `open`; `toggle(sceneId, lock)`
 * locks or unlocks one shot. Null outside a project, or for a document
 * storyboard, which has no per-shot locks.
 */
export const ShotLockContext = createContext(null);

export const SHOT_LOCK_LABELS = Object.freeze({ locked: 'Locked', changed: 'Changed since locked', open: 'Not locked' });

/** The lock state of one shot, or null when shots are not lockable here. */
export function useShotLock(sceneId) {
  const value = useContext(ShotLockContext);
  const state = sceneId && value?.locks ? value.locks[sceneId] : null;
  return state ? { state, toggle: (lock) => value.toggle(sceneId, lock), busy: !!value.busy } : null;
}

const baseCls = 'inline-flex min-h-[44px] shrink-0 items-center justify-center gap-1 rounded border px-2 text-xs disabled:opacity-50 sm:min-h-[28px]';

/**
 * One tap to lock a shot (its clip can then be made) or to unlock it. A shot
 * edited since it was locked keeps its warning color and offers Lock.
 */
export function ShotLockButton({ sceneId, className = '' }) {
  const lock = useShotLock(sceneId);
  if (!lock) return null;
  const locked = lock.state === 'locked';
  const label = locked ? 'Unlock' : 'Lock';
  return (
    <button type="button" onClick={() => lock.toggle(!locked)} disabled={lock.busy} aria-pressed={locked}
      title={locked ? 'Locked: its clip can be made. Tap to unlock.' : lock.state === 'changed' ? 'Changed since locked. Lock this shot again so its clip can be made.' : 'Lock this shot so its clip can be made'}
      className={`${baseCls} ${locked ? 'border-port-success/50 bg-port-success/10 text-port-success' : lock.state === 'changed' ? 'border-port-warning/50 bg-port-warning/10 text-port-warning' : 'border-port-border text-port-text'} ${className}`}>
      {locked ? <Lock size={14} aria-hidden="true" /> : <LockOpen size={14} aria-hidden="true" />}
      {label}
    </button>
  );
}
