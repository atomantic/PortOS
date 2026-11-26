import { Captions, Clapperboard, Scissors } from 'lucide-react';
import { formatDurationSec } from '../../utils/formatters.js';
import { sceneShotName } from '../../lib/musicVideoStages.js';
import { MUSIC_VIDEO_CUT_EFFECT_LABELS } from '../../../../server/lib/musicVideo/musicVideoCutEffects.js';
import ShotStepper from './ShotStepper.jsx';
import FrameStepper from './FrameStepper.jsx';
import PreviewFilmLook from './PreviewFilmLook.jsx';

/**
 * Transport controls below the animatic stage: shot stepper, cold-open/ending/look/lyrics toggles,
 * frame stepper with frame capture, and the master song & cold-open `<audio>` elements.
 */
export default function AnimaticTransportBar({ project, audioUrl, playback, captureFrame }) {
  const {
    audioRef, time, setTime, setPlaying, setTouched,
    lyricsOn, setLyricsOn, lookOn, toggleLook, lookAvailable,
    documentVariant, composite, film, fps,
    lyricsAvailable, cardOnly, cardOverWords, lyricLayer, cardLayer,
    outro, cold, seekTo, stepFrame, editShot,
    shot, picture, timed, index, filmGap, filmClip, filmCutEffect, label,
  } = playback;

  const cardInFrame = !lyricLayer.overlay;
  const songLabel = film ? 'Song for the film preview' : composite || documentVariant ? 'Song for the composition preview' : 'Song for the storyboard animatic';
  const showFallbackLabel = !film && !cardInFrame && shot && !picture?.referenceImageId && !picture?.videoHistoryId;

  return (
    <>
      <div data-preview-controls className="space-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="min-w-0 basis-full text-[11px] text-port-text-muted @min-[32rem]/mv-preview:flex-1 @min-[32rem]/mv-preview:basis-auto">
            {shot && cold.active && (
              <span className="tabular-nums">Before the song · shot {index + 1} of {timed.length} · {formatDurationSec(cold.time)}</span>
            )}
            {shot && !cold.active && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <ShotStepper scenes={timed} time={time} onSeek={seekTo} onEditShot={editShot} keys />
                <span className="tabular-nums">{formatDurationSec(shot.startSec)}</span>
                {film && (filmGap || filmClip) && (
                  <span>{filmGap ? 'No shot here' : `${filmClip.quality === 'final' ? 'Final' : 'Preview'} render${filmClip.stale ? ', out of date' : ''}`}</span>
                )}
                {filmCutEffect && (
                  <span>{`${MUSIC_VIDEO_CUT_EFFECT_LABELS[filmCutEffect.style]} (drawn in cuts)`}</span>
                )}
              </div>
            )}
            {showFallbackLabel && (
              <p className="line-clamp-2 break-words">
                <span className="font-medium text-port-text">{label}</span>{shot.visualIntent ? ` · ${shot.visualIntent}` : ''}
              </p>
            )}
            {(cardOnly || lyricsOn) && lyricLayer.failed && (
              <p className="text-port-error">{cardOnly ? 'The title card' : 'The lyrics'} could not be drawn over the animatic.</p>
            )}
            {cardOverWords && cardLayer.failed && !lyricLayer.failed && (
              <p className="text-port-error">The title card could not be drawn over the animatic.</p>
            )}
          </div>
          {cold.seconds > 0 && (
            <button
              type="button"
              onClick={() => {
                if (cold.active) { cold.stop(); return; }
                outro.stop();
                cold.start();
              }}
              aria-pressed={cold.active}
              title={`The ${formatDurationSec(cold.seconds)} before the song, then the song. Playing the song from its start plays this first too.`}
              className={`flex min-h-[44px] shrink-0 items-center gap-1 rounded border px-2 text-xs pointer-fine:sm:min-h-0 sm:py-1 ${cold.active ? 'border-port-accent text-port-accent' : 'border-port-border text-port-text-muted'}`}
            >
              <Clapperboard size={14} aria-hidden="true" /> Cold open
            </button>
          )}
          {outro.seconds > 0 && (
            <button
              type="button"
              onClick={() => {
                if (outro.active) { outro.stop(); return; }
                audioRef.current?.pause?.();
                outro.start();
              }}
              aria-pressed={outro.active}
              title={`The ending that plays for ${outro.seconds}s after the song`}
              className={`flex min-h-[44px] shrink-0 items-center gap-1 rounded border px-2 text-xs pointer-fine:sm:min-h-0 sm:py-1 ${outro.active ? 'border-port-accent text-port-accent' : 'border-port-border text-port-text-muted'}`}
            >
              <Scissors size={14} aria-hidden="true" /> Ending
            </button>
          )}
          {lookAvailable && <PreviewFilmLook enabled={lookOn} onToggle={toggleLook} />}
          {lyricsAvailable && (
            <button
              type="button"
              onClick={() => setLyricsOn((on) => !on)}
              aria-pressed={lyricsOn}
              className={`flex min-h-[44px] shrink-0 items-center gap-1 rounded border px-2 text-xs pointer-fine:sm:min-h-0 sm:py-1 ${lyricsOn ? 'border-port-accent text-port-accent' : 'border-port-border text-port-text-muted'}`}
            >
              <Captions size={14} aria-hidden="true" /> Lyrics
            </button>
          )}
        </div>
        {shot && !cold.active && (
          <FrameStepper
            time={time}
            fps={fps}
            maxSec={Number(project.audioAnalysis?.durationSec) || null}
            onSeek={stepFrame}
            capture={captureFrame}
            label={[project.name, shot ? sceneShotName(shot, { number: index + 1 }) : null].filter(Boolean).join(' · ')}
            keys
          />
        )}
      </div>
      <audio
        data-preview-scrub
        ref={audioRef}
        src={audioUrl}
        controls
        preload="metadata"
        data-song-clock="0"
        aria-label={songLabel}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onSeeked={(e) => { outro.stop(); setTouched(true); setTime(e.currentTarget.currentTime); }}
        onPlay={(e) => {
          outro.stop();
          setTouched(true);
          if (cold.claimsPlay(e.currentTarget)) return;
          cold.stop();
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        className="w-full"
      />
      {cold.audio}
    </>
  );
}
