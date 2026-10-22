import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Pause, Play, Volume2, VolumeX } from 'lucide-react';
import FrameStepper, { frameAt } from '../musicVideo/FrameStepper';
import useMounted from '../../hooks/useMounted';
import { safeReadJsonStorage, safeWriteJsonStorage } from '../../lib/safeStorage';

// Mute and volume carry over between animations.
export const TRANSPORT_AUDIO_KEY = 'portos.codeAnimation.previewAudio';

const buttonCls = 'inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-lg border border-port-border bg-port-bg px-2 text-sm text-gray-200 hover:border-port-accent disabled:cursor-not-allowed disabled:opacity-40';

const readAudioPrefs = () => {
  const stored = safeReadJsonStorage(TRANSPORT_AUDIO_KEY, null);
  const volume = Number(stored?.volume);
  return { muted: stored?.muted === true, volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1 };
};

/**
 * Play, pause and scrub a Code Animation preview. The film is drawn by the
 * isolated worker at each requested time (`preview.seek`); the soundtrack plays
 * here, in this browser, and is the clock while it plays. Without audio a
 * wall clock drives the same frames.
 */
export default function CodeAnimationTransport({ preview, duration, fps = 24, audioUrl, disabled = false, label = '' }) {
  const ids = useId();
  const mounted = useMounted();
  const audioRef = useRef(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [prefs, setPrefs] = useState(readAudioPrefs);
  const clockRef = useRef(null); // { startedAt, from } for the silent clock
  const end = Math.max(0, duration - 1 / fps);
  const { seek: seekPreview } = preview;

  const now = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audioUrl) return audio.currentTime || 0;
    const clock = clockRef.current;
    return clock ? clock.from + (performance.now() - clock.startedAt) / 1000 : t;
  }, [audioUrl, t]);

  // Stops local playback only; `pause` also holds the film at that time.
  const stop = useCallback((time) => {
    const next = Math.min(Math.max(0, Number.isFinite(time) ? time : 0), end);
    audioRef.current?.pause?.();
    if (audioRef.current && audioUrl) audioRef.current.currentTime = next;
    clockRef.current = null;
    setPlaying(false);
    setT(next);
    return next;
  }, [end, audioUrl]);
  const pause = useCallback((time) => seekPreview(stop(time)), [stop, seekPreview]);

  // Effects below read the latest clock through this ref, so a tick or a new
  // session does not re-run them.
  const latest = useRef(null);
  latest.current = { now, stop, pause, end, duration, fps, seekPreview, playing };

  // A new session opens on the film's own loop; take it over at the start.
  useEffect(() => {
    if (preview.ready) latest.current.pause(0);
  }, [preview.ready, preview.sessionId]);

  // A real-time record runs on the film's own clock, so starting one stops
  // playback without a seek (which would hold the clock again); once it ends
  // the film is held back at the playhead.
  const wasDisabled = useRef(disabled);
  useEffect(() => {
    const clock = latest.current;
    if (disabled) clock.stop(clock.now());
    else if (wasDisabled.current) clock.pause(clock.now());
    wasDisabled.current = disabled;
  }, [disabled]);

  const play = async () => {
    const from = t >= end ? 0 : t;
    setAudioError('');
    const audio = audioRef.current;
    if (audio && audioUrl) {
      audio.currentTime = from;
      const started = await Promise.resolve(audio.play?.()).then(() => true).catch((error) => {
        if (mounted.current) setAudioError(error?.message ? `The soundtrack could not start: ${error.message}` : 'The soundtrack could not start.');
        return false;
      });
      if (!started || !mounted.current) return;
    } else {
      clockRef.current = { startedAt: performance.now(), from };
    }
    setT(from);
    setPlaying(true);
  };

  // Ask the worker for the picture once per film frame while playing.
  useEffect(() => {
    if (!playing) return undefined;
    let handle = 0;
    let posted = -1;
    const tick = () => {
      const clock = latest.current;
      const time = clock.now();
      if (time >= clock.duration) { clock.pause(clock.end); return; }
      const frame = frameAt(time, clock.fps);
      if (frame !== posted) {
        posted = frame;
        setT(time);
        clock.seekPreview(time, { playing: true });
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = prefs.muted;
    audio.volume = prefs.volume;
  }, [prefs, audioUrl]);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden' && latest.current.playing) latest.current.pause(latest.current.now());
    };
    const audio = audioRef.current;
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      audio?.pause?.();
    };
  }, []);

  const updatePrefs = (patch) => setPrefs((current) => {
    const next = { ...current, ...patch };
    safeWriteJsonStorage(TRANSPORT_AUDIO_KEY, next);
    return next;
  });

  const ready = preview.ready && duration > 0 && !disabled;
  const frame = frameAt(t, fps);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => (playing ? pause(now()) : play())} disabled={!ready} className={buttonCls}
          aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <label htmlFor={`${ids}-scrub`} className="sr-only">Playhead</label>
        <input id={`${ids}-scrub`} type="range" min={0} max={end || 0} step={1 / fps} value={Math.min(t, end || 0)}
          disabled={!ready} onChange={(event) => pause(Number(event.target.value))} className="min-h-[44px] min-w-0 flex-1" />
        <span className="text-xs tabular-nums text-gray-400">
          {t.toFixed(2)}s / {duration.toFixed(2)}s · f{frame}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {audioUrl ? (
          <>
            <button type="button" onClick={() => updatePrefs({ muted: !prefs.muted })} className={buttonCls}
              aria-label={prefs.muted ? 'Unmute' : 'Mute'} aria-pressed={prefs.muted}>
              {prefs.muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
            <label htmlFor={`${ids}-volume`} className="sr-only">Volume</label>
            <input id={`${ids}-volume`} type="range" min={0} max={1} step={0.05} value={prefs.volume}
              onChange={(event) => updatePrefs({ volume: Number(event.target.value), muted: false })}
              className="min-h-[44px] w-28" />
          </>
        ) : (
          <span className="text-xs text-gray-500">No soundtrack yet. Add one under Soundtrack below.</span>
        )}
        <FrameStepper time={t} fps={fps} maxSec={duration || null} onSeek={pause} disabled={!ready}
          capture={preview.captureFrame} label={label} />
      </div>
      {audioError && <p role="alert" className="text-xs text-port-error">{audioError}</p>}
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="none" className="hidden" onEnded={() => pause(end)} />}
    </div>
  );
}
