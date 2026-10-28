import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { normalizeTitleCard, titleCardVisible, titleCardWindows } from '../../../../server/lib/musicVideoTitleCard.js';
import useMounted from '../../hooks/useMounted.js';
import useGeneratedPreview from '../../hooks/useGeneratedPreview.js';
import { hashString } from '../../utils/hashString.js';
import ShotStepper, { shotSteps } from './ShotStepper.jsx';
import FrameStepper from './FrameStepper.jsx';

const buttonCls = 'flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';

// What the lyric playthrough page is built from: the song length, the word times,
// the sheet's sections, the shots' timing and text zones, and the title card's spot. A change rebuilds it.
// Hashed: the preview socket caps `revision` at 500 characters and a whole song's word times run far past it.
const playthroughKey = (project) => JSON.stringify([
  project.audioAnalysis?.durationSec ?? null,
  (project.lyricCues || []).map((cue) => [cue.text, cue.startSec, cue.endSec, (cue.words || []).map((w) => [w.startSec, w.endSec])]),
  (project.lyricMarkers || []).map((m) => [m.type, m.label, m.line]),
  (project.scenes || []).map((s) => [s.startSec, s.endSec, s.textZone, s.lyricRole, s.lyricSize]),
  // The lyrics step off the title card's corner while it shows.
  titleCardVisible(project.titleCard) ? [project.titleCard.position, titleCardWindows(project.titleCard)] : null,
]);
export const playthroughVersion = (project) => {
  const key = playthroughKey(project);
  return `pt-${key.length.toString(36)}-${hashString(key).toString(36)}`;
};

/** The lyric line sung at song time `t`, from the project's timed cues. */
const lyricAt = (cues, t) => {
  const line = (cues || []).find((cue) => typeof cue.startSec === 'number' && typeof cue.endSec === 'number' && t >= cue.startSec && t < cue.endSec);
  return line?.text || '';
};

// A phone's collapsed mini-player has no picture to show, so it must not start
// the isolated renderer up front. Without matchMedia, load eagerly.
const DESKTOP_QUERY = '(min-width: 1024px)';
const startsDeferred = (collapsed) => collapsed && window.matchMedia?.(DESKTOP_QUERY).matches === false;

/**
 * Live preview of a composition document or lyric playthrough. The generated
 * page runs in the OS-isolated preview worker. This component shows JPEG
 * frames only — it does not fetch private media and it does not mount an iframe.
 *
 * `seekRequest` (`{ t, n }`) moves the player from outside. `collapsed` hides
 * the picture below `lg` until the dock is expanded or the viewport is desktop.
 * `lyrics` previews timed lyrics instead of the document. `draft` previews the
 * candidate document. `shotNav` adds Back and Next shot buttons (and the arrow
 * keys) and frame-by-frame stepping for the docked player; `onEditShot(sceneId)`
 * there adds Edit shot, which pauses first.
 */
export default function CompositionPreviewPlayer({ project, audioUrl, seekRequest = null, collapsed = false, draft = false, lyrics = false, shotNav = false, onEditShot = null, scrubId: givenScrubId = null }) {
  const doc = lyrics ? { playthrough: true } : (draft ? project.composition?.documentDraft : project.composition?.document) || null;
  const scrubId = givenScrubId || (lyrics ? 'mv-lyrics-scrub' : draft ? 'mv-doc-draft-scrub' : 'mv-doc-scrub');
  const [wanted, setWanted] = useState(() => !startsDeferred(collapsed));
  useEffect(() => {
    if (!collapsed) { setWanted(true); return undefined; }
    const desktop = window.matchMedia?.(DESKTOP_QUERY);
    const reveal = () => { if (!desktop || desktop.matches) setWanted(true); };
    reveal();
    desktop?.addEventListener?.('change', reveal);
    return () => desktop?.removeEventListener?.('change', reveal);
  }, [collapsed]);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef(null);
  const mounted = useMounted();
  const intent = useRef(0);
  const wantsPlay = useRef(false);
  const nativePlaying = useRef(false);
  const playbackSession = useRef(null);
  const audioStartWait = useRef(null);
  const playFromRef = useRef(null);
  const resyncs = useRef([]);
  const [preparing, setPreparing] = useState(false);
  const [audioError, setAudioError] = useState('');
  const appliedSeek = useRef(null);
  const filmLook = lyrics ? null : (project.filmLook ?? null);
  const titleCard = useMemo(() => normalizeTitleCard(project.titleCard), [project.titleCard]);
  const revision = lyrics ? playthroughVersion(project) : doc ? `${doc.directory}|${doc.updatedAt || ''}${project.lyricOverlayEnabled === false ? '|lyrics-off' : ''}` : null;
  const request = useMemo(() => {
    if (!wanted || !revision || !doc) return null;
    return {
      kind: 'music-video', projectId: project.id, draft: !!draft, lyrics: !!lyrics, revision,
    };
  }, [wanted, revision, doc, project.id, draft, lyrics]);
  const controls = useMemo(() => ({ look: filmLook, card: titleCard }), [filmLook, titleCard]);
  const preview = useGeneratedPreview({ active: !!request, request, controls });

  const duration = preview.durationSec || 0;
  const fps = preview.fps || 24;
  const cancelAudioStart = useCallback(() => {
    const waiting = audioStartWait.current;
    if (!waiting) return;
    audioStartWait.current = null;
    cancelAnimationFrame(waiting.frame);
    clearTimeout(waiting.timer);
  }, []);
  const stopPlayback = useCallback((time = audioRef.current?.currentTime || 0) => {
    const next = Math.min(Math.max(0, time), Math.max(0, duration - 1 / fps));
    cancelAudioStart();
    intent.current += 1;
    wantsPlay.current = false;
    nativePlaying.current = false;
    audioRef.current?.pause?.();
    preview.pausePlayback(next);
    if (audioRef.current && audioRef.current.currentTime !== next) audioRef.current.currentTime = next;
    setPreparing(false);
    setPlaying(false);
    setT(next);
  }, [duration, fps, preview.pausePlayback, cancelAudioStart]);

  const playFrom = useCallback((time) => {
    const audio = audioRef.current;
    if (!audio || !preview.ready) return;
    cancelAudioStart();
    const generation = ++intent.current;
    const live = () => mounted.current && generation === intent.current && wantsPlay.current;
    wantsPlay.current = true;
    setAudioError('');
    const failed = (error) => {
      if (!live()) return;
      stopPlayback(audio.currentTime || time);
      setAudioError(error?.message || 'Audio playback could not start. Retry the preview.');
    };
    const startAudio = (native) => {
      if (!live()) return;
      const clockWindow = [];
      const waiting = native ? { frame: 0, timer: 0 } : null;
      if (waiting) {
        audioStartWait.current = waiting;
        waiting.timer = setTimeout(() => {
          if (audioStartWait.current !== waiting) return;
          cancelAudioStart();
          failed(new Error('The audio clock did not start. Retry the preview.'));
        }, 3000);
      }
      const started = audio.play?.();
      if (!native) { setPreparing(false); setPlaying(true); }
      Promise.resolve(started).then(() => {
        if (!live()) return;
        if (!native) { setPlaying(true); return; }
        // play() can resolve while the media clock is still held at startup.
        // Anchor only after its latest 100ms window advances steadily at 1x.
        if (audioStartWait.current !== waiting) return;
        const observe = () => {
          if (audioStartWait.current !== waiting) return;
          if (!live()) { cancelAudioStart(); return; }
          const actualTime = audio.currentTime;
          const observedAt = performance.now();
          const previous = clockWindow.at(-1);
          if (audio.paused || audio.seeking || !Number.isFinite(actualTime) || (previous && actualTime < previous.t)) {
            clockWindow.length = 0;
          } else {
            clockWindow.push({ t: actualTime, at: observedAt });
            // Retain the newest window that still spans at least 100ms.
            while (clockWindow.length > 1 && observedAt - clockWindow[1].at >= 100) clockWindow.shift();
            const spanMs = observedAt - clockWindow[0].at;
            if (spanMs >= 100) {
              let advances = 0;
              for (let i = 1; i < clockWindow.length; i += 1) {
                if (clockWindow[i].t > clockWindow[i - 1].t) advances += 1;
              }
              const slope = (actualTime - clockWindow[0].t) / (spanMs / 1000);
              if (advances >= 2 && slope >= 0.95 && slope <= 1.05) {
                cancelAudioStart();
                nativePlaying.current = true;
                preview.startPlayback(actualTime);
                setPreparing(false);
                setPlaying(true);
                return;
              }
            }
          }
          waiting.frame = requestAnimationFrame(observe);
        };
        observe();
      }).catch(failed);
    };
    if (preview.playback) {
      audio.pause?.();
      nativePlaying.current = false;
      setPlaying(false);
      setPreparing(true);
      preview.preparePlayback(time).then((native) => { if (live() && native !== null) startAudio(native); }).catch(failed);
    } else startAudio(false);
  }, [mounted, preview.ready, preview.playback, preview.preparePlayback, preview.startPlayback, stopPlayback, cancelAudioStart]);
  playFromRef.current = playFrom;

  const seek = useCallback((time) => {
    const next = Math.min(Math.max(0, time), Math.max(0, duration - 1 / fps));
    const restart = preview.playback && wantsPlay.current;
    if (restart) {
      intent.current += 1;
      audioRef.current?.pause?.();
      nativePlaying.current = false;
      setPlaying(false);
    }
    setT(next);
    preview.seek(next);
    if (audioRef.current && audioRef.current.currentTime !== next) audioRef.current.currentTime = next;
    if (restart) playFromRef.current?.(next);
  }, [duration, fps, preview.seek, preview.playback]);

  useEffect(() => {
    if (preview.ready && playbackSession.current === preview.sessionId) return;
    playbackSession.current = preview.sessionId;
    cancelAudioStart();
    intent.current += 1;
    wantsPlay.current = false;
    nativePlaying.current = false;
    audioRef.current?.pause?.();
    setPreparing(false);
    setPlaying(false);
  }, [preview.ready, preview.sessionId, cancelAudioStart]);

  useEffect(() => {
    if (!seekRequest || duration <= 0 || appliedSeek.current === seekRequest.n) return;
    appliedSeek.current = seekRequest.n;
    stopPlayback(seekRequest.t);
    if (seekRequest.play) playFromRef.current?.(audioRef.current?.currentTime || 0);
  }, [seekRequest, duration, stopPlayback]);

  useEffect(() => {
    if (!playing) return undefined;
    let handle = 0;
    let posted = -1;
    let anchored = performance.now();
    const tick = () => {
      if (!wantsPlay.current) return;
      const time = audioRef.current?.currentTime || 0;
      const frameIndex = Math.floor(time * fps + 1e-9);
      if (frameIndex !== posted) {
        posted = frameIndex;
        setT(time);
        if (!nativePlaying.current) preview.seek(time, { playing: true });
      }
      if (nativePlaying.current && performance.now() - anchored >= 250) {
        anchored = performance.now();
        preview.syncPlayback(time);
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, fps, preview.seek, preview.syncPlayback]);


  useEffect(() => {
    if (!preview.playbackResync || !wantsPlay.current) return;
    if (preview.playbackResyncReason !== 'controls') {
      const now = performance.now();
      resyncs.current = resyncs.current.filter((at) => now - at < 10000);
      if (resyncs.current.length >= 3) {
        stopPlayback();
        setAudioError('Native preview repeatedly lost synchronization. Retry the preview.');
        return;
      }
      resyncs.current.push(now);
    }
    playFromRef.current?.(audioRef.current?.currentTime || 0);
  }, [preview.playbackResync, preview.playbackResyncReason, stopPlayback]);

  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden' && wantsPlay.current) stopPlayback(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      cancelAudioStart();
      intent.current += 1;
      wantsPlay.current = false;
      audioRef.current?.pause?.();
    };
  }, [stopPlayback, cancelAudioStart]);

  const togglePlay = () => {
    if (playing || preparing) stopPlayback();
    else playFrom(audioRef.current?.currentTime || 0);
  };

  if (!doc) return null;
  const title = lyrics ? 'Lyric timing playthrough' : draft ? 'Composition candidate preview' : 'Composition document preview';
  const aspect = preview.width && preview.height ? `${preview.width} / ${preview.height}` : '16 / 9';
  const lyric = lyricAt(project.lyricCues, t);
  const shotIndex = shotNav ? shotSteps(project.scenes, t).index : 0;
  const failed = preview.status === 'error' || preview.status === 'unavailable' || !!audioError;
  const timeLabel = failed
    ? 'Preview unavailable'
    : preview.ready
      ? `${t.toFixed(2)}s / ${duration.toFixed(1)}s`
      : !wanted ? 'Expand to load preview' : preview.status === 'idle' ? 'Preview paused' : 'Loading preview…';
  return (
    <div className="space-y-2" aria-label={lyrics ? 'Lyric timing playthrough' : 'Composition preview'}>
      {failed && <p className="text-xs text-port-error" role="alert">{audioError || preview.reason || 'Preview unavailable'}</p>}
      {preview.playbackReason && <p className="text-xs text-port-text-muted" role="status">{preview.playbackReason}</p>}
      <div title={title} className={`overflow-hidden rounded border border-port-border bg-black mx-auto ${collapsed ? 'max-xl:hidden' : ''}`}
        style={{ aspectRatio: aspect, maxHeight: '70vh', maxWidth: '100%' }}>
        {preview.frameUrl ? (
          <img ref={preview.imageRef} onLoad={preview.onFrameLoad} alt="" src={preview.frameUrl} className="h-full w-full object-contain" />
        ) : (
          <p className="p-3 text-xs text-port-text-muted">{failed ? '' : wanted ? 'Building the preview…' : ''}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {request && (preview.status === 'idle' || failed) && <button type="button" className={buttonCls} onClick={() => { stopPlayback(); setAudioError(''); preview.resume(); }}>{failed ? 'Retry preview' : 'Resume preview'}</button>}
        <button type="button" className={buttonCls} onClick={togglePlay} disabled={!preview.ready || !audioUrl || (failed && !playing)}>
          {playing || preparing ? <Pause size={14} /> : <Play size={14} />} {playing || preparing ? 'Pause' : 'Play'}
        </button>
        <label htmlFor={scrubId} className="sr-only">{lyrics ? 'Scrub the lyric playthrough' : draft ? 'Scrub the composition candidate' : 'Scrub the composition preview'}</label>
        <input disabled={!preview.ready || failed} id={scrubId} type="range" min={0} max={duration || 0} step={1 / fps} value={Math.min(t, duration || 0)}
          onChange={(e) => stopPlayback(Number(e.target.value))}
          className="min-w-0 flex-1" />
        <span className="text-xs text-port-text-muted tabular-nums">{timeLabel}</span>
      </div>
      {shotNav && <ShotStepper scenes={project.scenes} time={t} onSeek={seek} onEditShot={onEditShot ? (sceneId) => { stopPlayback(); onEditShot(sceneId); } : null} disabled={!preview.ready || failed} keys />}
      {shotNav && (
        <FrameStepper
          time={t}
          fps={fps}
          maxSec={duration || null}
          onSeek={stopPlayback}
          disabled={!preview.ready || failed}
          capture={preview.captureFrame}
          label={[project.name, shotIndex ? `Shot ${shotIndex}` : null].filter(Boolean).join(' · ')}
          keys
        />
      )}
      {lyric && !lyrics && <p className="text-xs italic break-words" aria-live="off" data-testid="preview-lyric">♪ {lyric}</p>}
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="none" className="hidden" onEnded={() => stopPlayback()} />}
    </div>
  );
}
