import { useContext, useState } from 'react';
import { Lock } from 'lucide-react';
import toast from '../ui/Toast';
import { ShotLockContext } from './ShotLock.jsx';
import { sceneMediaKind } from '../../lib/musicVideoSceneAttention.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * What one Lock all tap would lock: every shot whose still (with its picked
 * image, or a card/code shot) isn't locked, and every video shot whose picked
 * clip isn't locked once its still is (already, or in this same tap). Shots
 * with nothing picked stay open.
 */
export function lockAllTargets(scenes, value, { layered = false } = {}) {
  if (!value?.locks) return { stills: [], videos: [] };
  const stills = scenes.filter((scene) => value.locks[scene.sceneId] && value.locks[scene.sceneId] !== 'locked'
    && sceneMediaKind(scene, { layered })).map((scene) => scene.sceneId);
  const videos = scenes.filter((scene) => {
    const clip = value.clips?.[scene.sceneId];
    return clip != null && clip !== 'locked' && scene.videoHistoryId
      && (value.locks[scene.sceneId] === 'locked' || stills.includes(scene.sceneId));
  }).map((scene) => scene.sceneId);
  return { stills, videos };
}

/**
 * Locks every shot's picked still and clip in one tap. Locking a video rejects
 * that shot's unused takes, so the tap opens a confirm that says how many of
 * each it locks first.
 */
export default function LockAllShots({ scenes, layered = false }) {
  const value = useContext(ShotLockContext);
  const [open, setOpen] = useState(false);
  const { stills, videos } = lockAllTargets(scenes, value, { layered });
  if (!value?.lockAll || (!stills.length && !videos.length)) return null;
  const what = [stills.length && plural(stills.length, 'still'), videos.length && plural(videos.length, 'video')].filter(Boolean).join(' and ');
  const run = async () => {
    setOpen(false);
    const result = await value.lockAll(stills, videos);
    if (result) toast.success(`Locked ${what}`);
  };
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((was) => !was)} disabled={value.busy} aria-expanded={open}
        className="flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 py-1.5 text-sm disabled:opacity-50 sm:min-h-0">
        <Lock size={15} aria-hidden="true" /> Lock all
      </button>
      {open && (
        <div role="dialog" aria-label="Lock all shots"
          className="absolute right-0 top-full z-20 mt-1 w-72 max-w-[calc(100vw-1rem)] space-y-2 rounded border border-port-border bg-port-card p-3 text-sm shadow-lg">
          <p>Lock {what}?</p>
          {videos.length > 0 && <p className="text-xs text-port-warning">Locking a video rejects that shot&apos;s unused takes.</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="min-h-[44px] rounded border border-port-border px-2 py-1 sm:min-h-0">Cancel</button>
            <button type="button" onClick={run} className="min-h-[44px] rounded bg-port-accent px-2 py-1 text-white sm:min-h-0">Lock them</button>
          </div>
        </div>
      )}
    </div>
  );
}
