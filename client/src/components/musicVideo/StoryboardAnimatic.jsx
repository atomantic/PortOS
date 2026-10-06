import { useEffect, useRef, useState } from 'react';
import { formatDurationSec } from '../../utils/formatters.js';

const timedShots = (scenes) => scenes.filter((scene) => Number.isFinite(scene?.startSec)).sort((a, b) => a.startSec - b.startSec);

/** The shot on screen at song time `t`: the last one that has started. */
export function shotAt(scenes, t) {
  const timed = timedShots(scenes);
  let current = timed[0] || null;
  for (const scene of timed) {
    if (scene.startSec <= t) current = scene;
    else break;
  }
  return current;
}

/**
 * Something to watch before anything is rendered: the master song under the
 * storyboard, showing each shot's selected frame (or, without one, its label,
 * time and intent) as the song reaches it. `seekRequest` (`{ t, n }`) is the
 * scene-card seek the other preview sources honour too.
 */
export default function StoryboardAnimatic({ project, audioUrl, seekRequest, collapsed }) {
  const audioRef = useRef(null);
  const applied = useRef(null);
  const [time, setTime] = useState(0);
  const scenes = project.scenes || [];
  useEffect(() => {
    if (!seekRequest || applied.current === seekRequest.n || !audioRef.current) return;
    applied.current = seekRequest.n;
    audioRef.current.currentTime = seekRequest.t;
    setTime(seekRequest.t);
    if (seekRequest.play) audioRef.current.play?.()?.catch?.(() => {});
  }, [seekRequest]);
  const shot = shotAt(scenes, time);
  const timed = timedShots(scenes);
  const index = shot ? timed.indexOf(shot) : -1;
  return (
    <div className={`space-y-2 ${collapsed ? 'max-xl:hidden' : ''}`}>
      <figure aria-label="Storyboard animatic" className="relative aspect-video w-full overflow-hidden rounded border border-port-border bg-black">
        {shot?.referenceImageId ? (
          <img src={`/data/images/${shot.referenceImageId}`} alt="" className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-4 text-center">
            <span className="text-sm font-medium text-port-text">{shot ? shot.label || `Shot ${index + 1}` : 'No shots yet'}</span>
            {shot?.visualIntent && <span className="line-clamp-3 text-xs text-port-text-muted">{shot.visualIntent}</span>}
          </div>
        )}
        {shot && (
          <figcaption className="port-media-overlay absolute bottom-1 left-1 rounded px-1.5 py-0.5 text-[11px]">
            Shot {index + 1} of {timed.length} · {formatDurationSec(shot.startSec)}
          </figcaption>
        )}
      </figure>
      <audio
        ref={audioRef}
        src={audioUrl}
        controls
        preload="metadata"
        aria-label="Song for the storyboard animatic"
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onSeeked={(e) => setTime(e.currentTarget.currentTime)}
        className="w-full"
      />
    </div>
  );
}
