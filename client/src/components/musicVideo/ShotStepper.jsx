import { useEffect, useRef } from 'react';
import { Pencil, SkipBack, SkipForward } from 'lucide-react';
import { shouldIgnoreGlobalKey } from '../../lib/a11yKeyboard.js';
import { isPreMusicShot } from '../../../../server/lib/musicVideoColdOpen.js';

// Back within this far into a shot goes to the shot before it; further in, to its own start.
const RESTART_SEC = 1;
// A seek lands a hair off the start it aimed at; this much counts as being on it.
const ON_START_SEC = 0.05;

// A shot before the song (the cold open) keeps no place on the song's clock.
const onSongClock = (scene) => Number.isFinite(scene?.startSec) && !isPreMusicShot(scene);

const startsIn = (scenes, range) => (scenes || [])
  .filter(onSongClock)
  .map((scene) => scene.startSec)
  .filter((start) => Number.isFinite(start)
    && (!range || (start >= range.startSec - ON_START_SEC && (range.endSec == null || start < range.endSec))))
  .sort((a, b) => a - b);

/**
 * Where Back and Next go from song time `t`: Back to the current shot's start
 * when more than a second into it, else to the shot before; Next to the next
 * shot's start. `range` (`{ startSec, endSec }`) keeps both inside a rendered
 * excerpt. `index`/`count` name the shot on screen (1-based; 0 before the first).
 */
export function shotSteps(scenes, t, range = null) {
  const starts = startsIn(scenes, range);
  let current = -1;
  starts.forEach((start, i) => { if (start <= t + ON_START_SEC) current = i; });
  const back = current < 0
    ? null
    : t - starts[current] > RESTART_SEC || current === 0 ? starts[current] : starts[current - 1];
  const next = starts[current + 1] ?? null;
  return { back, next, index: current + 1, count: starts.length };
}

/**
 * Each shot's number as the player counts it ("Shot n / N"): its place in song
 * order. A shot with no start time, or one before the song, has no number.
 */
export function shotNumbers(scenes) {
  const timed = (scenes || []).filter(onSongClock);
  return new Map([...timed].sort((a, b) => a.startSec - b.startSec).map((scene, i) => [scene.sceneId, i + 1]));
}

/** The shot playing at song time `t`: the last one that has started. */
function shotOnScreen(scenes, t) {
  let current = null;
  for (const scene of scenes || []) {
    if (onSongClock(scene) && scene.startSec <= t + ON_START_SEC && (!current || scene.startSec >= current.startSec)) current = scene;
  }
  return current;
}

const buttonCls = 'flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded border border-port-border bg-port-bg text-port-text disabled:opacity-40 sm:min-h-[28px] sm:min-w-[28px]';

/**
 * Back and Next buttons that jump the player to a shot's start, with the shot
 * number between them. `onSeek(songSec)` moves the player and leaves it playing
 * or paused as it was. `keys` also binds the left and right arrows on the page.
 * With `onEditShot(sceneId)`, an Edit shot button opens the shot on screen.
 */
export default function ShotStepper({ scenes, time, onSeek, onEditShot = null, range = null, disabled = false, keys = false, className = '' }) {
  const { back, next, index, count } = shotSteps(scenes, time, range);
  const onScreen = shotOnScreen(scenes, time);
  const latest = useRef({ back, next, onSeek, disabled });
  latest.current = { back, next, onSeek, disabled };
  useEffect(() => {
    if (!keys) return undefined;
    const onKey = (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      // A focused player or slider already moves by itself on the arrows.
      if (shouldIgnoreGlobalKey(event) || event.target?.closest?.('audio, video, input')) return;
      const { back: to, next: forward, onSeek: seek, disabled: off } = latest.current;
      const target = event.key === 'ArrowLeft' ? to : forward;
      if (off || target == null) return;
      event.preventDefault();
      seek(target);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys]);
  if (!count) return null;
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-port-text-muted ${className}`}>
      <button type="button" onClick={() => onSeek(back)} disabled={disabled || back == null} aria-label="Previous shot" title="Previous shot" className={buttonCls}>
        <SkipBack size={14} aria-hidden="true" />
      </button>
      <span className="whitespace-nowrap tabular-nums" aria-live="off">Shot {index || '–'} / {count}</span>
      <button type="button" onClick={() => onSeek(next)} disabled={disabled || next == null} aria-label="Next shot" title="Next shot" className={buttonCls}>
        <SkipForward size={14} aria-hidden="true" />
      </button>
      {onScreen && onEditShot && (
        <button type="button" onClick={() => onEditShot(onScreen.sceneId)} title="Pause and open this shot's card" className={`${buttonCls} gap-1 px-2`}>
          <Pencil size={14} aria-hidden="true" /> Edit shot
        </button>
      )}
    </div>
  );
}
