import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FilmLookFrame from '../media/FilmLookFrame.jsx';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage.js';
import { isFilmLookNeutral } from '../../lib/filmLook.js';
import { Captions, Film } from 'lucide-react';
import { formatDurationSec } from '../../utils/formatters.js';
import { getMusicVideoLyricOverlayPreview } from '../../services/apiMusicVideo.js';
import { playthroughVersion } from './CompositionPreviewPlayer.jsx';
import { useVideoFileSrc } from '../../hooks/useVideoFileSrc.js';
import { selectedPerformanceInstruction } from '../../lib/musicVideoShotTiming.js';
import { normalizeTitleCard } from '../../../../server/lib/musicVideoTitleCard.js';
import ShotStepper from './ShotStepper.jsx';
import FrameStepper, { captureMediaFrame } from './FrameStepper.jsx';
import { sceneFrameFit } from './SceneFrameFit.jsx';
import TransitionGlitch from './TransitionGlitch.jsx';

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

// How long a seek may wait for its `portos-mv:seeked` reply before the next one goes anyway.
const SEEK_REPLY_MS = 1000;

// The overlay page needs the song's analysis and at least one timed line (else the server answers 409).
const hasTimedLyrics = (project) => Number(project.audioAnalysis?.durationSec) > 0
  && (project.lyricCues || []).some((cue) => Number.isFinite(cue?.startSec) && String(cue?.text || '').trim());

/**
 * The sung words over the animatic: the server's words-only page (the final
 * render's lyric type, in each shot's text zone, on a transparent frame) in a
 * sandboxed iframe laid over the picture. Like the composition preview it
 * answers the page's `portos-mv:*` bridge (it has no media to ask for) and
 * drives it with seek messages, one in flight at a time, every animation frame
 * while the song plays. Returns the overlay element, or null while there is
 * nothing to draw.
 */
function useLyricOverlay({ project, enabled, audioRef, time }) {
  const [preview, setPreview] = useState(null);
  const [failed, setFailed] = useState(false);
  const iframeRef = useRef(null);
  const seekState = useRef({ inFlight: false, pending: null, ready: false, sentAt: 0 });
  const version = enabled ? playthroughVersion(project) : null;
  // The opening title card rides on the lyric layer, posted live so its panel's edits show at once.
  const titleCard = useMemo(() => normalizeTitleCard(project.titleCard), [project.titleCard]);
  const titleCardRef = useRef(titleCard);
  useEffect(() => {
    titleCardRef.current = titleCard;
    if (seekState.current.ready) iframeRef.current?.contentWindow?.postMessage({ type: 'portos-mv:title-card', card: titleCard }, '*');
  }, [titleCard]);

  useEffect(() => {
    let active = true;
    setPreview(null);
    setFailed(false);
    seekState.current = { inFlight: false, pending: null, ready: false, sentAt: 0 };
    if (!version) return () => { active = false; };
    getMusicVideoLyricOverlayPreview(project.id, { silent: true })
      .then((next) => { if (active) setPreview(next); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [project.id, version]);

  const postSeek = useCallback((t) => {
    const frame = iframeRef.current?.contentWindow;
    const state = seekState.current;
    if (!frame || !state.ready) return;
    // A seek the page never answered stops holding the queue after a second.
    if (state.inFlight && performance.now() - state.sentAt < SEEK_REPLY_MS) { state.pending = t; return; }
    state.inFlight = true;
    state.sentAt = performance.now();
    frame.postMessage({ type: 'portos-mv:seek', t }, '*');
  }, []);

  useEffect(() => {
    if (!preview) return undefined;
    const onMessage = (event) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = event.data || {};
      const state = seekState.current;
      if (message.type === 'portos-mv:loaded') {
        event.source.postMessage({ type: 'portos-mv:manifest', keys: [] }, '*');
        event.source.postMessage({ type: 'portos-mv:title-card', card: titleCardRef.current }, '*');
        state.ready = true;
        postSeek(audioRef.current?.currentTime || 0);
      } else if (message.type === 'portos-mv:request') {
        event.source.postMessage({ type: 'portos-mv:asset', key: String(message.key), blob: null }, '*');
      } else if (message.type === 'portos-mv:seeked') {
        state.inFlight = false;
        if (state.pending != null) { const next = state.pending; state.pending = null; postSeek(next); }
      } else if (message.type === 'portos-mv:error') {
        setFailed(true);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [preview, postSeek, audioRef]);

  // A scrub, a seek or a pause lands through `time`; playback runs on animation frames,
  // since the audio's timeupdate is far too coarse for words landing on their onsets.
  useEffect(() => { postSeek(time); }, [time, postSeek]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!preview || !audio) return undefined;
    let handle = 0;
    const tick = () => {
      postSeek(audio.currentTime || 0);
      handle = requestAnimationFrame(tick);
    };
    const start = () => { cancelAnimationFrame(handle); handle = requestAnimationFrame(tick); };
    const stop = () => cancelAnimationFrame(handle);
    audio.addEventListener('play', start);
    audio.addEventListener('pause', stop);
    audio.addEventListener('ended', stop);
    if (!audio.paused) start();
    return () => {
      stop();
      audio.removeEventListener('play', start);
      audio.removeEventListener('pause', stop);
      audio.removeEventListener('ended', stop);
    };
  }, [preview, postSeek, audioRef]);

  if (!preview?.html || failed) return { overlay: null, failed };
  return {
    failed,
    overlay: (
      <iframe
        ref={iframeRef}
        title="Lyrics over the storyboard animatic"
        sandbox="allow-scripts"
        srcDoc={preview.html}
        // `color-scheme: normal` keeps the frame transparent under a dark parent page.
        style={{ colorScheme: 'normal' }}
        className="pointer-events-none absolute inset-0 h-full w-full border-0 bg-transparent"
        data-testid="animatic-lyrics"
      />
    ),
  };
}

// How far a playing shot's clip may drift from the song before it is put back in step.
// Paused (frame stepping, scrubbing), the clip must show the exact frame, so any gap
// wider than a fraction of a frame re-seeks it.
const CLIP_DRIFT_SEC = 0.25;
const CLIP_PAUSED_DRIFT_SEC = 0.01;

/**
 * Where song time `t` lands in a shot's clip: the take's edit-in point (a
 * performance take trimmed to the sung window) plus the time into the shot. Past
 * the clip's end it loops (`loop`, the render's default) or holds the last frame.
 */
export function clipTimeAt(scene, t, clipSec = null) {
  const inSec = selectedPerformanceInstruction(scene)?.edit?.inSec ?? 0;
  const local = Math.max(0, t - (scene.startSec || 0));
  if (!(clipSec > inSec)) return inSec + local;
  const span = clipSec - inSec;
  if (local < span) return inSec + local;
  return scene.loop !== false ? inSec + (local % span) : Math.max(inSec, clipSec - 0.05);
}

// How many shots past the one on screen get their clip loaded ahead, so a short shot is
// ready to show the moment the song reaches it.
const CLIP_PRELOAD_SHOTS = 2;
// The song frame the film look's grain and drift follow; footage renders run at 24 fps.
const ANIMATIC_FPS = 24;
// Remembers, per viewer, that the animatic plays without the project's film look.
const ANIMATIC_LOOK_KEY = 'portos-mv-animatic-look';

/**
 * A shot's selected video clip, muted under the master song and kept in step
 * with it while its shot is `current`: it plays and pauses with the song, and a
 * seek or drift puts it back at the song's place in the shot. A shot still to
 * come waits paused on its first frame. The clip stays transparent until it has
 * a frame to show, so the shot's still underneath covers the load and the seek.
 */
function ShotClip({ scene, audioRef, time, current }) {
  const videoRef = useRef(null);
  const [ready, setReady] = useState(false);
  const file = useVideoFileSrc(scene.videoHistoryId);
  const src = file.src || (file.resolving ? null : `/data/videos/${scene.videoHistoryId}.mp4`);
  const sync = useCallback(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio || video.readyState < 1) return;
    const duration = Number.isFinite(video.duration) ? video.duration : null;
    const target = clipTimeAt(scene, current ? audio.currentTime || 0 : scene.startSec || 0, duration);
    const tolerance = current && audio.paused ? CLIP_PAUSED_DRIFT_SEC : CLIP_DRIFT_SEC;
    if (Math.abs((video.currentTime || 0) - target) > tolerance) video.currentTime = target;
    if (!current || audio.paused) video.pause?.();
    else if (video.paused) video.play?.()?.catch?.(() => {});
  }, [scene, audioRef, current]);
  // Shown once a frame is decoded where the clip should be; kept from then on, since a
  // drift re-seek holds the last frame rather than going blank.
  const markReady = useCallback(() => {
    const video = videoRef.current;
    if (video && video.readyState >= 2 && !video.seeking) setReady(true);
  }, []);
  useEffect(() => { sync(); }, [time, sync]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    audio.addEventListener('play', sync);
    audio.addEventListener('pause', sync);
    return () => { audio.removeEventListener('play', sync); audio.removeEventListener('pause', sync); };
  }, [audioRef, sync]);
  if (!src) return null;
  // The final render's frame fit: zoomed to fill, or whole over the still, the VHS edge or black bars.
  const fit = sceneFrameFit(scene);
  return (
    <video
      ref={videoRef}
      src={src}
      muted
      playsInline
      preload="auto"
      onLoadedMetadata={sync}
      onLoadedData={markReady}
      onSeeked={markReady}
      onPlaying={markReady}
      aria-label={`Clip for ${scene.label || 'this shot'}`}
      aria-hidden={current ? undefined : true}
      data-ready={ready ? 'true' : 'false'}
      className={`pointer-events-none absolute inset-0 h-full w-full ${fit === 'fill' ? 'object-cover' : 'object-contain'} ${fit === 'black' ? 'bg-black' : ''} ${current && ready ? 'opacity-100' : 'opacity-0'}`}
    />
  );
}

/**
 * Something to watch before anything is rendered: the master song under the
 * storyboard, showing each shot's selected video clip (muted, in step with the
 * song) or else its selected frame (or, without either, its label, time and
 * intent) as the song reaches it, with the aligned lyrics drawn over
 * it once the words are timed (a toggle hides them). `seekRequest`
 * (`{ t, n }`) is the scene-card seek the other preview sources honour too.
 */
export default function StoryboardAnimatic({ project, audioUrl, seekRequest, collapsed }) {
  const audioRef = useRef(null);
  const figureRef = useRef(null);
  const applied = useRef(null);
  const [time, setTime] = useState(0);
  const [lyricsOn, setLyricsOn] = useState(true);
  // The look is the render's; a viewer whose phone struggles can watch without it.
  const [lookOn, setLookOn] = useState(() => safeReadStorage(ANIMATIC_LOOK_KEY) !== 'off');
  // While the song plays the look is the light playback version; paused, the exact render filter.
  const [playing, setPlaying] = useState(false);
  const lookAvailable = !isFilmLookNeutral(project.filmLook);
  const toggleLook = () => setLookOn((on) => { safeWriteStorage(ANIMATIC_LOOK_KEY, on ? 'off' : 'on'); return !on; });
  const scenes = project.scenes || [];
  const lyricsAvailable = hasTimedLyrics(project);
  const { overlay, failed } = useLyricOverlay({ project, enabled: lyricsAvailable && lyricsOn, audioRef, time });
  useEffect(() => {
    if (!seekRequest || applied.current === seekRequest.n || !audioRef.current) return;
    applied.current = seekRequest.n;
    audioRef.current.currentTime = seekRequest.t;
    setTime(seekRequest.t);
    if (seekRequest.play) audioRef.current.play?.()?.catch?.(() => {});
  }, [seekRequest]);
  // Back and Next move the song; it keeps playing or stays paused as it was.
  const seekTo = useCallback((t) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = t;
    setTime(t);
  }, []);
  // Frame steps pause the song first, so the frame stays on screen to check.
  const stepFrame = useCallback((t) => {
    audioRef.current?.pause?.();
    seekTo(t);
  }, [seekTo]);
  // Save frame keeps the shot's picture: its clip's frame once that shows, else its still.
  const captureFrame = () => {
    const figure = figureRef.current;
    const media = figure?.querySelector('video[data-ready="true"]:not([aria-hidden="true"])') || figure?.querySelector('img');
    return captureMediaFrame(media);
  };
  const shot = shotAt(scenes, time);
  const timed = timedShots(scenes);
  const index = shot ? timed.indexOf(shot) : -1;
  // The shot on screen and the next few: each keeps one mounted clip, so the cut to the
  // next shot shows a clip that has already loaded and sits on its first frame.
  const clipShots = timed.slice(Math.max(index, 0), Math.max(index, 0) + 1 + CLIP_PRELOAD_SHOTS).filter((scene) => scene.videoHistoryId);
  const label = shot ? shot.label || `Shot ${index + 1}` : 'No shots yet';
  // With the lyrics drawn over the picture, a shot without a frame keeps its label and
  // intent under the picture instead, so no stand-in text sits under the sung words.
  const cardInFrame = !overlay;
  const vhsEdges = !!shot?.videoHistoryId && sceneFrameFit(shot) === 'vhs';
  // The render cover-fits the still behind a still-edged clip; the preview matches it.
  const stillEdges = !!shot?.videoHistoryId && sceneFrameFit(shot) === 'still';
  return (
    <div className={`space-y-2 ${collapsed ? 'max-xl:hidden' : ''}`}>
      <figure ref={figureRef} aria-label="Storyboard animatic" className="relative aspect-video w-full overflow-hidden rounded border border-port-border bg-black">
        {/* The project's film look, as the final render applies it over the whole picture, lyrics included. */}
        <FilmLookFrame look={lookOn ? project.filmLook : null} frame={Math.round(time * ANIMATIC_FPS)} playing={playing} className="h-full w-full">
        {shot?.referenceImageId ? (
          // Behind a VHS-edged clip the still stands in, blurred and faded, for the render's blur of the clip.
          <img src={`/data/images/${shot.referenceImageId}`} alt=""
            className={`h-full w-full ${vhsEdges ? 'object-cover blur-md saturate-50 brightness-75' : stillEdges ? 'object-cover' : 'object-contain'}`} />
        ) : cardInFrame && !shot?.videoHistoryId ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-4 text-center">
            <span className="text-sm font-medium text-port-text">{label}</span>
            {shot?.visualIntent && <span className="line-clamp-3 text-xs text-port-text-muted">{shot.visualIntent}</span>}
          </div>
        ) : null}
        {clipShots.map((scene) => (
          <ShotClip key={`${scene.sceneId}:${scene.videoHistoryId}`} scene={scene} audioRef={audioRef} time={time} current={scene === shot} />
        ))}
        {/* The shots' VHS glitches on their cuts, on the frames the final render repaints. */}
        <TransitionGlitch scenes={scenes} figureRef={figureRef} audioRef={audioRef} time={time}
          endSec={Number(project.audioAnalysis?.durationSec) || null} fps={ANIMATIC_FPS} />
        {overlay}
        </FilmLookFrame>
      </figure>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="min-w-0 basis-full text-[11px] text-port-text-muted @min-[32rem]/mv-preview:flex-1 @min-[32rem]/mv-preview:basis-auto">
          {shot && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ShotStepper scenes={timed} time={time} onSeek={seekTo} keys />
              <span className="tabular-nums">{formatDurationSec(shot.startSec)}</span>
            </div>
          )}
          {!cardInFrame && shot && !shot.referenceImageId && !shot.videoHistoryId && (
            <p className="line-clamp-2 break-words">
              <span className="font-medium text-port-text">{label}</span>{shot.visualIntent ? ` · ${shot.visualIntent}` : ''}
            </p>
          )}
          {lyricsOn && failed && <p className="text-port-error">The lyrics could not be drawn over the animatic.</p>}
        </div>
        {lookAvailable && (
          <button
            type="button"
            onClick={toggleLook}
            aria-pressed={lookOn}
            title={lookOn ? 'Showing the project film look: a light version while playing, the exact render look when paused. Tap to watch without it.' : 'Film look hidden in the animatic; the render still applies it'}
            className={`flex min-h-[44px] shrink-0 items-center gap-1 rounded border px-2 text-xs sm:min-h-0 sm:py-1 ${lookOn ? 'border-port-accent text-port-accent' : 'border-port-border text-port-text-muted'}`}
          >
            <Film size={14} aria-hidden="true" /> Film look
          </button>
        )}
        {lyricsAvailable && (
          <button
            type="button"
            onClick={() => setLyricsOn((on) => !on)}
            aria-pressed={lyricsOn}
            className={`flex min-h-[44px] shrink-0 items-center gap-1 rounded border px-2 text-xs sm:min-h-0 sm:py-1 ${lyricsOn ? 'border-port-accent text-port-accent' : 'border-port-border text-port-text-muted'}`}
          >
            <Captions size={14} aria-hidden="true" /> Lyrics
          </button>
        )}
      </div>
      {shot && (
        <FrameStepper
          time={time}
          fps={ANIMATIC_FPS}
          maxSec={Number(project.audioAnalysis?.durationSec) || null}
          onSeek={stepFrame}
          capture={captureFrame}
          label={[project.name, `Shot ${index + 1}`].filter(Boolean).join(' · ')}
          keys
        />
      )}
      <audio
        ref={audioRef}
        src={audioUrl}
        controls
        preload="metadata"
        aria-label="Song for the storyboard animatic"
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onSeeked={(e) => setTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        className="w-full"
      />
    </div>
  );
}
