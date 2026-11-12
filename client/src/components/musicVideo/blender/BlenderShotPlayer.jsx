import { Music, VolumeX } from 'lucide-react';
import { useEffect } from 'react';
import useShotSongSync from '../../../hooks/useShotSongSync.js';
import useSoloPlayback from '../../../hooks/useSoloPlayback.js';
import { useLocalStorageBool } from '../../../hooks/useLocalStorageBool.js';
import { musicVideoBlenderMediaUrl } from '../../../services/apiMusicVideo.js';
import { buttonCls } from './blenderStyles.js';

const WITH_SONG_KEY = 'portos.musicVideo.blender.withSong';
const QUALITY_LABELS = { preview: 'Preview', final: 'Final' };

/**
 * One shot's newest render, looping, with the master song heard in sync under
 * it (the shot video itself is silent). `playable` is a
 * `blenderShotPlayable(…)` reading; with both a preview and a final rendered
 * the director picks which plays. `videoHandle` receives the `<video>` so the
 * shot actions can read the paused frame.
 *
 * The preview docked above the panel plays the same song, so the two take
 * turns: whichever starts pauses the other, and this one does not start by
 * itself (a new shot, a render that just landed) while the preview is playing.
 */
export default function BlenderShotPlayer({ projectId, shot, playable, audioUrl, aspect = null, onQuality, onTime, videoHandle }) {
  const [withSong, , toggleSong] = useLocalStorageBool(WITH_SONG_KEY, true);
  // A re-render writes the same file again: the finish time makes the element load the new one.
  const sourceKey = playable ? `${playable.render.file}:${playable.render.finishedAt || ''}` : null;
  const { videoRef, audioRef } = useShotSongSync({ startSec: shot.start || 0, enabled: withSong && !!audioUrl, sourceKey, onTime });
  const solo = useSoloPlayback(() => videoRef.current?.pause());
  // A video that is replaced or removed while playing fires no pause.
  useEffect(() => solo.stopped, [solo, sourceKey]);

  // The film's frame shape holds the player's place before the video loads, so the page does not jump.
  const frame = { aspectRatio: aspect || '16 / 9' };

  if (!playable) {
    return (
      <div style={frame} className="flex max-h-[42dvh] w-full items-center justify-center rounded border border-dashed border-port-border bg-port-bg p-3 text-center text-xs text-port-text-muted">
        Nothing rendered for this shot yet. Render a preview to watch it with the song.
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-1.5">
      <video
        key={sourceKey}
        ref={(node) => { videoRef.current = node; if (videoHandle) videoHandle.current = node; }}
        src={musicVideoBlenderMediaUrl(projectId, playable.render.file)}
        aria-label={`${QUALITY_LABELS[playable.quality]} render of ${shot.label || shot.id}`}
        style={frame}
        className="max-h-[42dvh] w-full rounded bg-black object-contain"
        controls loop autoPlay={!solo.busy()} muted playsInline preload="auto"
        onPlay={solo.started} onPause={solo.stopped}
      />
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {playable.qualities.length > 1 && (
          <div role="group" aria-label="Render to play" className="flex gap-1">
            {playable.qualities.map((quality) => (
              <button key={quality} type="button" aria-pressed={playable.quality === quality} onClick={() => onQuality(quality)}
                className={`${buttonCls} ${playable.quality === quality ? 'border-port-accent text-port-accent' : ''}`}>
                {QUALITY_LABELS[quality]}
              </button>
            ))}
          </div>
        )}
        {playable.qualities.length === 1 && <span className="text-port-text-muted">Playing the {playable.quality} render</span>}
        <button type="button" aria-pressed={withSong && !!audioUrl} disabled={!audioUrl} onClick={toggleSong}
          title={audioUrl ? 'Hear the master song under the shot, in sync' : 'Attach a track to hear the song under the shot'}
          className={`${buttonCls} ${withSong && audioUrl ? 'border-port-accent text-port-accent' : ''}`}>
          {withSong && audioUrl ? <Music size={14} aria-hidden="true" /> : <VolumeX size={14} aria-hidden="true" />}
          With song
        </button>
      </div>
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="metadata" className="hidden" />}
    </div>
  );
}
