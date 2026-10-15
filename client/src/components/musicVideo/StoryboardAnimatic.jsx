import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FilmLookFrame from '../media/FilmLookFrame.jsx';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage.js';
import { isFilmLookNeutral } from '../../lib/filmLook.js';
import { Captions, Film, Scissors } from 'lucide-react';
import { formatDurationSec } from '../../utils/formatters.js';
import { getMusicVideoLyricOverlayPreview } from '../../services/apiMusicVideo.js';
import useMusicVideoStatsOutro from '../../hooks/useMusicVideoStatsOutro.js';
import { playthroughVersion } from './CompositionPreviewPlayer.jsx';
import { useVideoFileSrc } from '../../hooks/useVideoFileSrc.js';
import { selectedPerformanceInstruction } from '../../lib/musicVideoShotTiming.js';
import { normalizeTitleCard } from '../../../../server/lib/musicVideoTitleCard.js';
import { statsOutroSeconds } from '../../../../server/lib/musicVideoStatsOutro.js';
import StatsOutroCanvas from './StatsOutroCanvas.jsx';
import ShotStepper from './ShotStepper.jsx';
import FrameStepper, { captureMediaFrame } from './FrameStepper.jsx';
import { sceneFrameFit } from './SceneFrameFit.jsx';
import TransitionGlitch from './TransitionGlitch.jsx';
import ImageEffectStill from './ImageEffectStill.jsx';
import { clipOffsetSec, clipReversed, clipSpeedRate, isLayeredComposition } from '../../lib/musicVideoLayers.js';
import { sceneImageEffect } from '../../lib/musicVideoImageEffects.js';
import { plannedTransitions, sceneCutEffects } from '../../lib/musicVideoCutEffects.js';

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
// A clip still fetching after a seek gets this long before it is moved again: each seek
// restarts its download, so on a slow phone link re-seeking on every time update never lets
// it catch up.
const CLIP_RESEEK_WAIT_MS = 1500;
// A clip that fails to load is tried again this many times, a little later each time.
const CLIP_LOAD_RETRIES = 2;
const CLIP_RETRY_MS = 1500;
// A playing shot's clip whose download stalls is restarted at most this often.
const CLIP_STALL_RELOAD_MS = 5000;

/**
 * Lets the browser drop a video's download and decoder. Removing the element
 * alone does not: iOS Safari keeps both until the element is collected, and
 * after a few dozen cuts it stops loading new clips at all.
 */
function releaseVideo(video) {
  if (!video) return;
  video.pause?.();
  video.removeAttribute('src');
  video.load?.();
}

/**
 * Where song time `t` lands in a shot's clip: the take's edit-in point (a
 * performance take trimmed to the sung window) plus the time into the shot. Past
 * the clip's end it loops (`loop`, the render's default) or holds the last frame.
 * A hand-set speed and offset (lib/musicVideoLayers.js) play as the render plays
 * them: the offset moves the in-point by whole frames, a negative one past the
 * clip's start holds its first frame that long, and the speed runs the clip faster
 * or slower, looping round the whole file as the render's looped input does.
 * `early` follows the song's clock before the shot starts too (a beat toggle
 * into it), reading the footage before its in-point back to the clip's start.
 */
export function clipTimeAt(scene, t, clipSec = null, { early = false } = {}) {
  const inSec = selectedPerformanceInstruction(scene)?.edit?.inSec ?? 0;
  const local = early ? t - (scene.startSec || 0) : Math.max(0, t - (scene.startSec || 0));
  const rate = clipSpeedRate(scene);
  const start = inSec + clipOffsetSec(scene);
  // A negative offset holds the first frame before the clip runs; otherwise it runs from `start`.
  const at = start >= 0 ? Math.max(0, start + local * rate) : Math.max(0, local + start) * rate;
  if (clipReversed(scene)) {
    // Backwards from the file's end, as the render reads it once: past its start it holds the first frame shown last.
    if (!(clipSec > 0)) return 0;
    return Math.min(clipSec - 0.05, Math.max(0, clipSec - at));
  }
  if (rate !== 1 || start !== inSec) {
    if (!(clipSec > 0) || at < clipSec) return at;
    return scene.loop !== false && !(inSec > 0) ? at % clipSec : Math.max(0, clipSec - 0.05);
  }
  if (local < 0) return at;
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
 * `preload` is 'auto' for the shot on screen and the next one, else 'metadata',
 * so a phone spends its bandwidth on the clip it needs first. A clip that fails
 * to load is retried, a stalled one restarted, and a removed one releases its
 * download and decoder.
 */
function ShotClip({ scene, audioRef, time, current, preload = 'auto' }) {
  const videoRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [reload, setReload] = useState(0);
  // -Infinity: no seek or restart yet, so the first one is never held back.
  const recovery = useRef({ errors: 0, timer: 0, lastSeekAt: -Infinity, lastReloadAt: -Infinity });
  const file = useVideoFileSrc(scene.videoHistoryId);
  const src = file.src || (file.resolving ? null : `/data/videos/${scene.videoHistoryId}.mp4`);
  const sync = useCallback(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio || video.readyState < 1) return;
    const duration = Number.isFinite(video.duration) ? video.duration : null;
    const target = clipTimeAt(scene, current ? audio.currentTime || 0 : scene.startSec || 0, duration);
    // A browser cannot play a clip backwards, so a reversed clip stays paused and is stepped to each frame.
    const reversed = clipReversed(scene);
    const tolerance = current && (audio.paused || reversed) ? CLIP_PAUSED_DRIFT_SEC : CLIP_DRIFT_SEC;
    // A clip still seeking is left to land; its `seeked` re-checks it. A clip playing forward
    // that is still fetching after its last seek gets a moment too. Paused or reversed, it must
    // show the exact frame, so it moves at once.
    const fetching = current && !audio.paused && !reversed && video.readyState < 3
      && performance.now() - recovery.current.lastSeekAt < CLIP_RESEEK_WAIT_MS;
    const settling = video.seeking || fetching;
    if (Math.abs((video.currentTime || 0) - target) > tolerance && !settling) {
      video.currentTime = target;
      recovery.current.lastSeekAt = performance.now();
    }
    // The shot's hand-set speed; a negative offset's lead holds the first frame.
    video.playbackRate = clipSpeedRate(scene);
    const leading = (scene.startSec || 0) - clipOffsetSec(scene) - (selectedPerformanceInstruction(scene)?.edit?.inSec ?? 0) > (audio.currentTime || 0);
    if (!current || audio.paused || leading || reversed) video.pause?.();
    else if (video.paused) video.play?.()?.catch?.(() => {});
  }, [scene, audioRef, current]);
  // Shown once a frame is decoded where the clip should be; kept from then on, since a
  // drift re-seek holds the last frame rather than going blank.
  const markReady = useCallback(() => {
    const video = videoRef.current;
    if (video && video.readyState >= 2 && !video.seeking) setReady(true);
  }, []);
  useEffect(() => { sync(); }, [time, sync]);
  // Each mounted element (a retry remounts it) lets go of its download when it leaves.
  useEffect(() => {
    const video = videoRef.current;
    return () => releaseVideo(video);
  }, [src, reload]);
  useEffect(() => () => clearTimeout(recovery.current.timer), []);
  const retryLoad = () => {
    const state = recovery.current;
    if (state.errors >= CLIP_LOAD_RETRIES) return;
    state.errors += 1;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { file.retry(); setReload((n) => n + 1); }, CLIP_RETRY_MS * state.errors);
  };
  // A download that stalls while its shot plays is restarted; its metadata re-seeks it.
  const restartStalled = () => {
    const video = videoRef.current;
    const state = recovery.current;
    if (!video || !current || audioRef.current?.paused || video.readyState >= 3) return;
    if (performance.now() - state.lastReloadAt < CLIP_STALL_RELOAD_MS) return;
    state.lastReloadAt = performance.now();
    video.load?.();
  };
  // The song's time updates are too coarse to step a reversed clip, so it follows every animation frame.
  const reversed = clipReversed(scene);
  useEffect(() => {
    if (!current || !reversed) return undefined;
    let handle = 0;
    const tick = () => { sync(); handle = requestAnimationFrame(tick); };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [current, reversed, sync]);
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
      key={reload}
      ref={videoRef}
      src={src}
      muted
      playsInline
      preload={preload}
      onLoadedMetadata={sync}
      onLoadedData={markReady}
      onSeeked={() => { markReady(); sync(); }}
      onPlaying={markReady}
      onError={retryLoad}
      onStalled={restartStalled}
      aria-label={`Clip for ${scene.label || 'this shot'}`}
      aria-hidden={current ? undefined : true}
      data-ready={ready ? 'true' : 'false'}
      className={`pointer-events-none absolute inset-0 h-full w-full ${fit === 'fill' ? 'object-cover' : 'object-contain'} ${fit === 'black' ? 'bg-black' : ''} ${current && ready ? 'opacity-100' : 'opacity-0'}`}
    />
  );
}

// Runs `apply(songTime)` on every animation frame while the song plays, and once more when it pauses:
// the song's timeupdate is far too coarse for a beat flip or a smooth fade.
function useSongFrames(audioRef, apply) {
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    let handle = 0;
    const tick = () => {
      apply(audio.currentTime || 0);
      handle = requestAnimationFrame(tick);
    };
    const start = () => { cancelAnimationFrame(handle); handle = requestAnimationFrame(tick); };
    const stop = () => { cancelAnimationFrame(handle); apply(audio.currentTime || 0); };
    audio.addEventListener('play', start);
    audio.addEventListener('pause', stop);
    if (!audio.paused) start();
    return () => {
      cancelAnimationFrame(handle);
      audio.removeEventListener('play', start);
      audio.removeEventListener('pause', stop);
    };
  }, [audioRef, apply]);
}

// How much of the incoming clip shows at song time `t`: on a toggle's flips, or a
// dissolve's ramp, which reaches full on the cut as the render's alpha fade does.
const incomingOpacity = (effect, t) => {
  if (effect.style !== 'dissolve') return effect.incoming.some(([a, b]) => t >= a && t < b) ? 1 : 0;
  if (t < effect.windowStartSec || t >= effect.cutSec) return 0;
  return Math.min(1, (t - effect.windowStartSec) / (effect.cutSec - effect.windowStartSec + 1 / ANIMATIC_FPS));
};

/**
 * The incoming shot of a beat toggle or dissolve (lib/musicVideoCutEffects.js)
 * over the outgoing one: its clip runs on the song's clock, reading the footage
 * before its in-point, and shows on the toggle's frames or fades in over the
 * dissolve's, as the final render overlays it. A shot without a clip shows its still.
 */
function ToggleClip({ scene, toggle, audioRef, time }) {
  const mediaRef = useRef(null);
  const file = useVideoFileSrc(scene.videoHistoryId || null);
  const src = scene.videoHistoryId ? file.src || (file.resolving ? null : `/data/videos/${scene.videoHistoryId}.mp4`) : null;
  const apply = useCallback((t) => {
    const el = mediaRef.current;
    const audio = audioRef.current;
    if (!el) return;
    el.style.opacity = String(incomingOpacity(toggle, t));
    if (el.tagName !== 'VIDEO' || el.readyState < 1) return;
    const duration = Number.isFinite(el.duration) ? el.duration : null;
    const target = clipTimeAt(scene, Math.min(Math.max(t, toggle.windowStartSec), toggle.cutSec), duration, { early: true });
    const tolerance = audio?.paused ? CLIP_PAUSED_DRIFT_SEC : CLIP_DRIFT_SEC;
    if (Math.abs((el.currentTime || 0) - target) > tolerance) el.currentTime = target;
    const running = !!audio && !audio.paused && t >= toggle.windowStartSec && t < toggle.cutSec;
    if (!running) el.pause?.();
    else if (el.paused) el.play?.()?.catch?.(() => {});
  }, [toggle, scene, audioRef]);
  useEffect(() => { apply(time); }, [time, apply]);
  useEffect(() => {
    const el = mediaRef.current;
    return () => { if (el?.tagName === 'VIDEO') releaseVideo(el); };
  }, [src]);
  useSongFrames(audioRef, apply);
  const fit = sceneFrameFit(scene);
  const className = `pointer-events-none absolute inset-0 h-full w-full ${src && fit !== 'fill' ? 'object-contain' : 'object-cover'} ${fit === 'black' ? 'bg-black' : ''}`;
  if (src) {
    return <video ref={mediaRef} src={src} muted playsInline preload="auto" onLoadedMetadata={() => apply(audioRef.current?.currentTime || 0)}
      data-testid="beat-toggle-clip" style={{ opacity: 0 }} className={className} />;
  }
  if (!scene.referenceImageId) return null;
  return <img ref={mediaRef} src={`/data/images/${scene.referenceImageId}`} alt="" data-testid="beat-toggle-clip" style={{ opacity: 0 }} className={className} />;
}

/**
 * A fade through black (lib/musicVideoCutEffects.js): black over the picture
 * that darkens into the cut and lifts after it, as the render fades the two shots.
 */
function FadeBlack({ fade, audioRef, time }) {
  const ref = useRef(null);
  const apply = useCallback((t) => {
    const el = ref.current;
    if (!el) return;
    const down = t >= fade.outStartSec && t < fade.cutSec ? (t - fade.outStartSec) / (fade.cutSec - fade.outStartSec) : 0;
    const up = t >= fade.cutSec && t < fade.inEndSec ? 1 - (t - fade.cutSec) / (fade.inEndSec - fade.cutSec) : 0;
    el.style.opacity = String(Math.min(1, Math.max(down, up)));
  }, [fade]);
  useEffect(() => { apply(time); }, [time, apply]);
  useSongFrames(audioRef, apply);
  return <div ref={ref} data-testid="fade-black" style={{ opacity: 0 }} className="pointer-events-none absolute inset-0 bg-black" />;
}

/**
 * Something to watch before anything is rendered: the master song under the
 * storyboard, showing each shot's selected video clip (muted, in step with the
 * song) or else its selected frame (or, without either, its label, time and
 * intent) as the song reaches it, with the aligned lyrics drawn over
 * it once the words are timed (a toggle hides them). `seekRequest`
 * (`{ t, n }`) is the scene-card seek the other preview sources honour too.
 */
export default function StoryboardAnimatic({ project, audioUrl, seekRequest, collapsed, onEditShot = null }) {
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
  const songTime = useCallback(() => audioRef.current?.currentTime || 0, []);
  const toggleLook = () => setLookOn((on) => { safeWriteStorage(ANIMATIC_LOOK_KEY, on ? 'off' : 'on'); return !on; });
  const scenes = project.scenes || [];
  const lyricsAvailable = hasTimedLyrics(project);
  const { overlay, failed } = useLyricOverlay({ project, enabled: lyricsAvailable && lyricsOn, audioRef, time });
  // The cutting room floor outro: it plays when the song ends, and Ending plays it straight away; playing or seeking the song leaves it.
  const outro = useMusicVideoStatsOutro({ projectId: project.id, seconds: statsOutroSeconds(project.statsOutro), audioRef });
  const songEndSec = Number(project.audioAnalysis?.durationSec) || 0;
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
  // Edit shot pauses the song so the shot stays on screen while its card opens.
  const editShot = onEditShot ? (sceneId) => { audioRef.current?.pause?.(); onEditShot(sceneId); } : null;
  // Save frame keeps the shot's picture: its clip's frame once that shows, else its still.
  const captureFrame = () => {
    const figure = figureRef.current;
    const media = figure?.querySelector('video[data-ready="true"]:not([aria-hidden="true"])') || figure?.querySelector('img');
    return captureMediaFrame(media);
  };
  // Cut effects (beat toggles, dissolves, fades through black), on the frames the final
  // render paints them (lib/musicVideoCutEffects.js), storyboard-planned ones included.
  const beats = project.audioAnalysis?.beats;
  const storyboardRows = project.productionReview?.draft?.storyboard;
  const planned = useMemo(() => plannedTransitions(storyboardRows), [storyboardRows]);
  const cutEffects = useMemo(() => sceneCutEffects(scenes, { fps: ANIMATIC_FPS, beats, endSec: songEndSec || null, planned }), [scenes, beats, songEndSec, planned]);
  // A toggle or dissolve mounts its incoming clip a little ahead, so it has loaded when it starts showing.
  const nearToggles = cutEffects.filter((t) => t.incoming && time >= t.windowStartSec - 3 && time < t.cutSec);
  const nearFades = cutEffects.filter((t) => t.style === 'fade-black' && time >= t.outStartSec - 1 && time < t.inEndSec + 1);
  const shot = shotAt(scenes, time);
  const timed = timedShots(scenes);
  const index = shot ? timed.indexOf(shot) : -1;
  // A still shot with an image effect plays the effect over its still, as the composed render does, not its clip.
  const layered = isLayeredComposition(project);
  const shotEffect = shot ? sceneImageEffect(shot, { layered }) : null;
  // The shot on screen and the next few: each keeps one mounted clip, so the cut to the
  // next shot shows a clip that has already loaded and sits on its first frame.
  const clipShots = timed.slice(Math.max(index, 0), Math.max(index, 0) + 1 + CLIP_PRELOAD_SHOTS)
    .filter((scene) => scene.videoHistoryId && !sceneImageEffect(scene, { layered }));
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
        <FilmLookFrame look={lookOn ? project.filmLook : null} frame={Math.round((outro.active ? songEndSec + outro.t : time) * ANIMATIC_FPS)}
          playing={playing || (outro.active && outro.t < outro.seconds)} className="h-full w-full">
        {shot?.referenceImageId && shotEffect ? (
          <ImageEffectStill key={shot.sceneId} src={`/data/images/${shot.referenceImageId}`} effect={shotEffect}
            endSrc={shot.endImageId ? `/data/images/${shot.endImageId}` : null}
            startSec={shot.startSec} time={time} playing={playing} getTime={songTime} fps={ANIMATIC_FPS} />
        ) : shot?.referenceImageId ? (
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
          <ShotClip key={`${scene.sceneId}:${scene.videoHistoryId}`} scene={scene} audioRef={audioRef} time={time} current={scene === shot}
            preload={timed.indexOf(scene) - Math.max(index, 0) <= 1 ? 'auto' : 'metadata'} />
        ))}
        {nearToggles.map((toggle) => {
          const incoming = scenes.find((scene) => scene.sceneId === toggle.toSceneId);
          return incoming ? <ToggleClip key={`toggle:${toggle.toSceneId}:${incoming.videoHistoryId || ''}`} scene={incoming} toggle={toggle} audioRef={audioRef} time={time} /> : null;
        })}
        {nearFades.map((fade) => <FadeBlack key={`fade:${fade.fromSceneId}`} fade={fade} audioRef={audioRef} time={time} />)}
        {/* The shots' VHS glitches on their cuts, on the frames the final render repaints. */}
        <TransitionGlitch scenes={scenes} figureRef={figureRef} audioRef={audioRef} time={time} layered={layered}
          endSec={Number(project.audioAnalysis?.durationSec) || null} fps={ANIMATIC_FPS} />
        {overlay}
        {outro.active && <StatsOutroCanvas stats={outro.stats} t={outro.t} durationSec={outro.seconds} />}
        </FilmLookFrame>
      </figure>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="min-w-0 basis-full text-[11px] text-port-text-muted @min-[32rem]/mv-preview:flex-1 @min-[32rem]/mv-preview:basis-auto">
          {shot && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ShotStepper scenes={timed} time={time} onSeek={seekTo} onEditShot={editShot} keys />
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
        {outro.seconds > 0 && (
          <button
            type="button"
            onClick={() => {
              if (outro.active) { outro.stop(); return; }
              audioRef.current?.pause?.();
              outro.start();
            }}
            aria-pressed={outro.active}
            title={`The cutting room floor scene that plays for ${outro.seconds}s after the song`}
            className={`flex min-h-[44px] shrink-0 items-center gap-1 rounded border px-2 text-xs sm:min-h-0 sm:py-1 ${outro.active ? 'border-port-accent text-port-accent' : 'border-port-border text-port-text-muted'}`}
          >
            <Scissors size={14} aria-hidden="true" /> Ending
          </button>
        )}
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
        onSeeked={(e) => { outro.stop(); setTime(e.currentTarget.currentTime); }}
        onPlay={() => { outro.stop(); setPlaying(true); }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        className="w-full"
      />
    </div>
  );
}
