import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FilmLookFrame from '../media/FilmLookFrame.jsx';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage.js';
import { uuidv4 } from '../../lib/uuid.js';
import { isFilmLookNeutral } from '../../lib/filmLook.js';
import { Captions, Clapperboard, Film, Scissors } from 'lucide-react';
import { formatDurationSec } from '../../utils/formatters.js';
import { getMusicVideoLyricOverlayPreview, mixMusicVideoColdOpenAudio, musicVideoColdOpenAudioUrl } from '../../services/apiMusicVideo.js';
import { coldOpenPlan, songScenes } from '../../../../server/lib/musicVideoColdOpen.js';
import toast from '../ui/Toast';
import useMusicVideoStatsOutro from '../../hooks/useMusicVideoStatsOutro.js';
import { playthroughVersion } from './CompositionPreviewPlayer.jsx';
import { useVideoFileSrc } from '../../hooks/useVideoFileSrc.js';
import { selectedPerformanceInstruction } from '../../lib/musicVideoShotTiming.js';
import { normalizeTitleCard } from '../../../../server/lib/musicVideoTitleCard.js';
import { endingParts } from '../../../../server/lib/musicVideoEnding.js';
import EndingCanvas from './EndingCanvas.jsx';
import ShotStepper from './ShotStepper.jsx';
import FrameStepper from './FrameStepper.jsx';
import { capturePreviewFrame, lyricFrameCaptureBridge } from '../../lib/musicVideoFrameCapture.js';
import PreviewVideo from './PreviewVideo.jsx';
import { sceneFrameFit } from './SceneFrameFit.jsx';
import TransitionGlitch from './TransitionGlitch.jsx';
import ImageEffectStill from './ImageEffectStill.jsx';
import { clipOffsetSec, clipReversed, clipSpeedRate, isLayeredComposition, sceneVisualLayer, stillFrameTransform } from '../../lib/musicVideoLayers.js';
import { sceneImageEffect, scenePhotoSequence } from '../../lib/musicVideoImageEffects.js';
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
  const captureRef = useRef(null);
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
    captureRef.current?.reject(new Error('Lyric preview changed'));
    setPreview(null);
    setFailed(false);
    seekState.current = { inFlight: false, pending: null, ready: false, sentAt: 0 };
    if (!version) return () => { active = false; };
    getMusicVideoLyricOverlayPreview(project.id, { silent: true })
      .then((next) => { if (active) setPreview(next); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; captureRef.current?.reject(new Error('Lyric preview changed')); };
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
        else if (captureRef.current?.t === message.t) {
          const capture = captureRef.current;
          event.source.postMessage({ type: 'portos-mv:capture-lyrics', id: capture.id, t: capture.t }, '*');
        }
      } else if (message.type === 'portos-mv:captured-lyrics') {
        const capture = captureRef.current;
        if (!capture || message.id !== capture.id || message.t !== capture.t) return;
        if (message.error || typeof message.png !== 'string' || message.png.length > 24000000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(message.png)) capture.reject(new Error('Lyric frame unavailable'));
        else capture.resolve(message.png);
      } else if (message.type === 'portos-mv:error') {
        captureRef.current?.reject(new Error('Lyric frame unavailable'));
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

  const capture = (t) => new Promise((resolve, reject) => {
    if (!seekState.current.ready || failed || !iframeRef.current) { reject(new Error('Lyric frame unavailable')); return; }
    const id = uuidv4();
    const finish = (done, result) => { clearTimeout(timer); captureRef.current = null; done(result); };
    const timer = setTimeout(() => finish(reject, new Error('Lyric capture timed out')), 5000);
    captureRef.current = { id, t, resolve: (png) => finish(resolve, png), reject: (error) => finish(reject, error) };
    // The existing serialized seek bridge finishes the requested song time first.
    seekState.current.pending = null;
    postSeek(t);
  });
  if (!preview?.html || failed) return { overlay: null, failed, capture };
  return {
    failed,
    capture,
    overlay: (
      <iframe
        ref={iframeRef}
        title="Lyrics over the storyboard animatic"
        sandbox="allow-scripts"
        srcDoc={`${preview.html}<script>(${lyricFrameCaptureBridge.toString()})();</script>`}
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
 * into it, whose window opens at `fromSec`), reading the footage before its
 * in-point; with less footage than that it plays on from the clip's first
 * frame, as the render does, rather than holding it.
 */
export function clipTimeAt(scene, t, clipSec = null, { early = false, fromSec = null } = {}) {
  const inSec = selectedPerformanceInstruction(scene)?.edit?.inSec ?? 0;
  const local = early ? t - (scene.startSec || 0) : Math.max(0, t - (scene.startSec || 0));
  const rate = clipSpeedRate(scene);
  const start = inSec + clipOffsetSec(scene);
  // A negative offset holds the first frame before the clip runs; otherwise it runs from `start`.
  const position = (l) => (start >= 0 ? Math.max(0, start + l * rate) : Math.max(0, l + start) * rate);
  const at = early && local < 0 && fromSec != null && fromSec <= t
    ? position(fromSec - (scene.startSec || 0)) + (t - fromSec) * rate
    : position(local);
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
    <PreviewVideo
      key={`${src}:${reload}`}
      videoRef={videoRef}
      audioRef={audioRef}
      active={current}
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

// Runs `apply(songTime)` on every animation frame while the song plays, and once more when it stops:
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
    audio.addEventListener('ended', stop);
    if (!audio.paused) start();
    return () => {
      cancelAnimationFrame(handle);
      audio.removeEventListener('play', start);
      audio.removeEventListener('pause', stop);
      audio.removeEventListener('ended', stop);
    };
  }, [audioRef, apply]);
}

function StillShot({ scene, audioRef, time, effect = null, fps, beats = [], startSec = scene.startSec, endSec = scene.endSec }) {
  const ref = useRef(null);
  const sequence = useMemo(() => scenePhotoSequence(scene, { fps, beats }), [scene, fps, beats]);
  const getTime = useCallback(() => audioRef.current?.currentTime || 0, [audioRef]);
  const apply = useCallback((t) => {
    if (ref.current) ref.current.style.transform = stillFrameTransform(scene, t, { fps, startSec, endSec });
  }, [scene, fps, startSec, endSec]);
  useEffect(() => { apply(time); }, [time, apply]);
  useSongFrames(audioRef, apply);
  return (
    <div className="h-full w-full overflow-hidden">
      <div ref={ref} data-testid="animatic-still" className="h-full w-full">
        {effect || sequence ? <ImageEffectStill src={`/data/images/${scene.referenceImageId}`} effect={effect} sequence={sequence}
          endSrc={scene.endImageId ? `/data/images/${scene.endImageId}` : null}
          startSec={startSec} time={time} playing={!!audioRef.current && !audioRef.current.paused} getTime={getTime} fps={fps} />
          : <img src={`/data/images/${scene.referenceImageId}`} alt="" className="h-full w-full object-cover" />}
      </div>
    </div>
  );
}

// How much of the incoming clip shows at song time `t`: on a toggle's flips, or a
// dissolve's ramp, which reaches full on the cut as the render's alpha fade does.
const incomingOpacity = (effect, t, fps) => {
  if (effect.style !== 'dissolve') return effect.incoming.some(([a, b]) => t >= a && t < b) ? 1 : 0;
  if (t < effect.windowStartSec || t >= effect.cutSec) return 0;
  return Math.min(1, (t - effect.windowStartSec) / (effect.cutSec - effect.windowStartSec + 1 / fps));
};

/**
 * The incoming shot of a beat toggle or dissolve (lib/musicVideoCutEffects.js)
 * over the outgoing one: its clip runs on the song's clock, reading the footage
 * before its in-point, and shows on the toggle's frames or fades in over the
 * dissolve's, as the final render overlays it. A shot without a clip shows its still.
 */
function ToggleClip({ scene, toggle, audioRef, time, layered, fps, beats = [] }) {
  const mediaRef = useRef(null);
  const still = sceneVisualLayer(scene, { layered }) === 'still';
  const file = useVideoFileSrc(!still ? scene.videoHistoryId || null : null);
  const src = !still && scene.videoHistoryId ? file.src || (file.resolving ? null : `/data/videos/${scene.videoHistoryId}.mp4`) : null;
  const apply = useCallback((t) => {
    const el = mediaRef.current;
    const audio = audioRef.current;
    if (!el) return;
    const surface = el.tagName === 'VIDEO' ? el.parentElement : el;
    surface.style.opacity = String(incomingOpacity(toggle, t, fps));
    if (el.tagName !== 'VIDEO' || el.readyState < 1) return;
    const duration = Number.isFinite(el.duration) ? el.duration : null;
    const target = clipTimeAt(scene, Math.min(Math.max(t, toggle.windowStartSec), toggle.cutSec), duration, { early: true, fromSec: toggle.windowStartSec });
    const tolerance = audio?.paused ? CLIP_PAUSED_DRIFT_SEC : CLIP_DRIFT_SEC;
    if (Math.abs((el.currentTime || 0) - target) > tolerance) el.currentTime = target;
    const running = !!audio && !audio.paused && t >= toggle.windowStartSec && t < toggle.cutSec;
    if (!running) el.pause?.();
    else if (el.paused) el.play?.()?.catch?.(() => {});
  }, [toggle, scene, audioRef, fps]);
  useEffect(() => { apply(time); }, [time, apply]);
  useEffect(() => {
    const el = mediaRef.current;
    return () => { if (el?.tagName === 'VIDEO') releaseVideo(el); };
  }, [src]);
  useSongFrames(audioRef, apply);
  const fit = sceneFrameFit(scene);
  const className = `pointer-events-none absolute inset-0 h-full w-full ${src && fit !== 'fill' ? 'object-contain' : 'object-cover'} ${fit === 'black' ? 'bg-black' : ''}`;
  if (src) {
    return <PreviewVideo key={src} videoRef={mediaRef} audioRef={audioRef} active={time >= toggle.windowStartSec && time < toggle.cutSec} src={src} muted playsInline preload="auto" onLoadedMetadata={() => apply(audioRef.current?.currentTime || 0)}
      data-testid="beat-toggle-clip" style={{ opacity: 0 }} className={className} />;
  }
  if (!scene.referenceImageId && !scenePhotoSequence(scene)?.imageIds.length) return null;
  if (layered) return <div ref={mediaRef} data-testid="beat-toggle-clip" style={{ opacity: 0 }} className={className}>
    <StillShot scene={scene} audioRef={audioRef} time={time} fps={fps} beats={beats} effect={sceneImageEffect(scene, { layered })}
      startSec={toggle.windowStartSec} endSec={toggle.cutSec} />
  </div>;
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
 * The cold open (shots before the song): its shots on a clock of their own,
 * laid out as `scenes` timed from 0, and the sound the final render mixes
 * under them, fetched when it is played. `start()` plays it and the song
 * starts from its first note when it ends; `stop()` leaves it. Returns
 * `{ scenes, seconds, active, time, audio, start, stop }` (`audio` is the
 * element to mount; null with no cold open).
 */
function useColdOpen({ project, songRef }) {
  const audioRef = useRef(null);
  const [active, setActive] = useState(false);
  const [time, setTime] = useState(0);
  const [src, setSrc] = useState(null);
  const plan = useMemo(() => coldOpenPlan(project), [project]);
  const scenes = useMemo(() => plan.map(({ scene, startSec, endSec }) => ({ ...scene, startSec, endSec })), [plan]);
  const seconds = plan.length ? plan[plan.length - 1].endSec : 0;
  // The mix follows the shots' lengths, sound and playback (speed, in-point, reverse, performance
  // edit); the whole shot is the key, and the server returns its cached WAV when nothing it uses changed.
  const mixKey = JSON.stringify(plan.map(({ scene, preMusic }) => [scene, preMusic]));
  // The mix is made ahead (ffmpeg, cached on the server) so Play can start it inside the tap,
  // which a phone requires before it plays sound.
  const mixing = useRef(null);
  const mix = useCallback(() => {
    if (mixing.current) return mixing.current;
    const request = mixMusicVideoColdOpenAudio(project.id, { silent: true })
      .then((mixed) => {
        const url = mixed?.name ? musicVideoColdOpenAudioUrl(project.id, mixed.name) : null;
        // A request superseded by a newer edit must not replace the newer mix.
        if (mixing.current === request) setSrc(url);
        return url;
      })
      .catch((err) => { if (mixing.current === request) mixing.current = null; throw err; });
    mixing.current = request;
    return request;
  }, [project.id]);
  useEffect(() => {
    setSrc(null);
    setActive(false);
    mixing.current = null;
    if (plan.length) mix().catch(() => {});
    // Mixed again only when what it plays changes.
  }, [project.id, mixKey, plan.length, mix]);
  const stop = useCallback(() => { audioRef.current?.pause?.(); setActive(false); }, []);
  const start = useCallback(async () => {
    if (!plan.length) return;
    songRef.current?.pause?.();
    setActive(true);
    setTime(0);
    const url = src || await mix().catch((err) => {
      toast.error(err?.message || 'The sound before the song could not be mixed');
      return null;
    });
    if (!url) { setActive(false); return; }
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.getAttribute('src') !== url) audio.src = url;
    audio.currentTime = 0;
    audio.play?.()?.catch?.(() => {});
  }, [plan.length, mix, songRef, src]);
  // The song's own play from its first note runs the cold open first, except the
  // play the cold open hands over with when it ends.
  const handingOver = useRef(false);
  const onEnded = () => {
    setActive(false);
    const song = songRef.current;
    if (!song) return;
    handingOver.current = true;
    song.currentTime = 0;
    song.play?.()?.catch?.(() => { handingOver.current = false; });
  };
  const claimsPlay = useCallback((song) => {
    if (handingOver.current) { handingOver.current = false; return false; }
    if (!plan.length || (song?.currentTime || 0) > 0.05) return false;
    start();
    return true;
  }, [plan.length, start]);
  const audio = plan.length ? (
    <audio ref={audioRef} preload="none" aria-label="Sound before the song" className="hidden"
      onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} onEnded={onEnded} />
  ) : null;
  return { audioRef, scenes, seconds, active, time, audio, start, stop, claimsPlay };
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
  const captureBasis = useRef(null);
  const lookAvailable = !isFilmLookNeutral(project.filmLook);
  const toggleLook = () => setLookOn((on) => { safeWriteStorage(ANIMATIC_LOOK_KEY, on ? 'off' : 'on'); return !on; });
  // The song's shots; shots before the song play on the cold open's clock (useColdOpen).
  const scenes = useMemo(() => songScenes(project), [project]);
  const layered = isLayeredComposition(project);
  // The first footage source sets the composed render's frame rate, even when the current shot is a still.
  const lead = scenes.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .find((scene) => scene.videoHistoryId && sceneVisualLayer(scene, { layered }) === 'footage');
  const leadFile = useVideoFileSrc(layered ? lead?.videoHistoryId : null, { geometry: true });
  const stillFps = project.composition?.mode === 'document' ? ANIMATIC_FPS : leadFile.fps || ANIMATIC_FPS;
  const lyricsAvailable = project.lyricOverlayEnabled !== false && hasTimedLyrics(project);
  const { overlay, failed, capture: captureLyrics } = useLyricOverlay({ project, enabled: lyricsAvailable && lyricsOn, audioRef, time });
  // The ending (cutting room floor, then credits): it plays when the song ends, and Ending plays it straight away; playing or seeking the song leaves it.
  const { statsOutro, creditsOutro } = project;
  const endingPlan = useMemo(() => endingParts({ statsOutro, creditsOutro }), [statsOutro, creditsOutro]);
  const outro = useMusicVideoStatsOutro({ projectId: project.id, seconds: endingPlan.reduce((sum, part) => sum + part.durationSec, 0), audioRef });
  const songEndSec = Number(project.audioAnalysis?.durationSec) || 0;
  const cold = useColdOpen({ project, songRef: audioRef });
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
  captureBasis.current = { project, lyricsOn, lookOn, outro: outro.active, outroTime: outro.t, outroStats: outro.stats };
  const captureFrame = async () => {
    const basis = captureBasis.current;
    const audio = audioRef.current;
    audio?.pause();
    outro.pause();
    const at = audio?.currentTime || 0;
    setTime(at);
    setPlaying(false);
    // Pause swaps the live film look for its exact filter and catches the shot up
    // to the audio clock. Effects/clip seeks then get a paint before freezing.
    await new Promise((resolve, reject) => {
      let handle;
      const timer = setTimeout(() => { cancelAnimationFrame(handle); reject(new Error('Preview did not settle')); }, 2000);
      let paints = 0;
      const settle = () => {
        const clips = [...(figureRef.current?.querySelectorAll('video[data-preview-video]') || [])]
          // A decoded current clip can still be transparent until loadeddata
          // reveals it. Its paused surface must settle before serialization.
          .filter((video) => Number(getComputedStyle(video.parentElement).opacity) > 0
            || (video.matches('[data-ready]:not([aria-hidden="true"])') && video.readyState >= 2));
        const failedClip = clips.find((video) => video.dataset.previewError);
        if (failedClip) { clearTimeout(timer); reject(new Error(failedClip.dataset.previewError)); return; }
        if (++paints >= 2 && clips.every((video) => !video.seeking && video.dataset.pausedFrame === String(video.currentTime))) {
          clearTimeout(timer); resolve(); return;
        }
        handle = requestAnimationFrame(settle);
      };
      handle = requestAnimationFrame(settle);
    });
    // The click can land before a tick's queued setT has rendered; pause() stops
    // further ticks, so the clock the settle wait observed is the one captured.
    // Later outro changes (late stats, a restart) still invalidate the capture.
    basis.outroTime = captureBasis.current.outroTime;
    basis.outroStats = captureBasis.current.outroStats;
    const unchanged = () => {
      const current = captureBasis.current;
      return current.project === basis.project && current.lyricsOn === basis.lyricsOn && current.lookOn === basis.lookOn
        && current.outro === basis.outro && current.outroTime === basis.outroTime && current.outroStats === basis.outroStats
        && audio?.paused && audio.currentTime === at;
    };
    if (!unchanged()) throw new Error('Preview changed during capture');
    const selected = shotAt(scenes, at);
    if (!basis.outro && selected?.videoHistoryId && sceneVisualLayer(selected, { layered }) === 'footage') {
      const figure = figureRef.current;
      const clip = figure?.querySelector('video[data-ready="true"]:not([aria-hidden="true"])');
      const fallback = [...(figure?.querySelectorAll('img') || [])].find((image) => image.getAttribute('src') === `/data/images/${selected.referenceImageId}` && image.complete && image.naturalWidth > 0);
      if (!clip && !fallback) throw new Error('Video frame is still loading');
    }
    if (lyricsAvailable && lyricsOn && !overlay) throw new Error('Lyric frame unavailable');
    const iframeImages = new Map();
    const iframe = figureRef.current?.querySelector('iframe');
    if (iframe) iframeImages.set(iframe, await captureLyrics(at));
    if (!unchanged()) throw new Error('Preview changed during capture');
    const blob = await capturePreviewFrame(figureRef.current?.firstElementChild, { iframeImages });
    if (!unchanged()) throw new Error('Preview changed during capture');
    const shotLabel = basis.outro ? 'Ending' : `Shot ${timedShots(scenes).indexOf(selected) + 1}`;
    return { blob, time: at, fps: ANIMATIC_FPS, label: [project.name, shotLabel].filter(Boolean).join(' · ') };
  };
  // Cut effects (beat toggles, dissolves, fades through black), on the frames the final
  // render paints them (lib/musicVideoCutEffects.js), storyboard-planned ones included.
  const beats = project.audioAnalysis?.beats;
  const storyboardRows = project.productionReview?.draft?.storyboard;
  const planned = useMemo(() => plannedTransitions(storyboardRows), [storyboardRows]);
  const cutEffects = useMemo(() => sceneCutEffects(scenes, { fps: stillFps, beats, endSec: songEndSec || null, planned }), [scenes, stillFps, beats, songEndSec, planned]);
  // A toggle or dissolve mounts its incoming clip a little ahead, so it has loaded when it starts showing.
  const nearToggles = cold.active ? [] : cutEffects.filter((t) => t.incoming && time >= t.windowStartSec - 3 && time < t.cutSec);
  const nearFades = cold.active ? [] : cutEffects.filter((t) => t.style === 'fade-black' && time >= t.outStartSec - 1 && time < t.inEndSec + 1);
  // While the cold open plays, its shots follow its own sound instead of the song.
  const clock = cold.active ? { ref: cold.audioRef, time: cold.time, scenes: cold.scenes } : { ref: audioRef, time, scenes };
  const shot = shotAt(clock.scenes, clock.time);
  const timed = timedShots(clock.scenes);
  const index = shot ? timed.indexOf(shot) : -1;
  // A still shot with an image effect plays the effect over its still, as the composed render does, not its clip.
  const shotEffect = shot ? sceneImageEffect(shot, { layered }) : null;
  const stillShot = shot && layered && (sceneVisualLayer(shot, { layered }) === 'still' || !shot.videoHistoryId);
  // The shot on screen and the next few: each keeps one mounted clip, so the cut to the
  // next shot shows a clip that has already loaded and sits on its first frame.
  const clipShots = timed.slice(Math.max(index, 0), Math.max(index, 0) + 1 + CLIP_PRELOAD_SHOTS)
    .filter((scene) => scene.videoHistoryId && sceneVisualLayer(scene, { layered }) === 'footage');
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
        <FilmLookFrame look={lookOn ? project.filmLook : null} frame={Math.round((outro.active ? songEndSec + outro.t : cold.active ? cold.time - cold.seconds : time) * ANIMATIC_FPS)}
          playing={playing || cold.active || (outro.active && !outro.paused && outro.t < outro.seconds)} className="h-full w-full">
        {(shot?.referenceImageId || scenePhotoSequence(shot)?.imageIds.length) && stillShot ? (
          <StillShot key={shot.sceneId} scene={shot} audioRef={clock.ref} time={clock.time} fps={stillFps} beats={beats} effect={shotEffect} />
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
          <ShotClip key={`${cold.active ? 'cold:' : ''}${scene.sceneId}:${scene.videoHistoryId}`} scene={scene} audioRef={clock.ref} time={clock.time} current={scene === shot}
            preload={timed.indexOf(scene) - Math.max(index, 0) <= 1 ? 'auto' : 'metadata'} />
        ))}
        {nearToggles.map((toggle) => {
          const incoming = scenes.find((scene) => scene.sceneId === toggle.toSceneId);
          return incoming ? <ToggleClip key={`toggle:${toggle.toSceneId}:${incoming.videoHistoryId || ''}`} scene={incoming} toggle={toggle} audioRef={audioRef} time={time} layered={layered} fps={stillFps} beats={beats} /> : null;
        })}
        {nearFades.map((fade) => <FadeBlack key={`fade:${fade.fromSceneId}`} fade={fade} audioRef={audioRef} time={time} />)}
        {/* The shots' VHS glitches on their cuts, on the frames the final render repaints. */}
        <TransitionGlitch scenes={clock.scenes} figureRef={figureRef} audioRef={clock.ref} time={clock.time} layered={layered}
          endSec={cold.active ? cold.seconds : Number(project.audioAnalysis?.durationSec) || null} fps={ANIMATIC_FPS} />
        {!cold.active && overlay}
        {outro.active && <EndingCanvas parts={endingPlan} stats={outro.stats} t={outro.t} />}
        </FilmLookFrame>
      </figure>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="min-w-0 basis-full text-[11px] text-port-text-muted @min-[32rem]/mv-preview:flex-1 @min-[32rem]/mv-preview:basis-auto">
          {shot && cold.active && (
            <span className="tabular-nums">Before the song · shot {index + 1} of {timed.length} · {formatDurationSec(cold.time)}</span>
          )}
          {shot && !cold.active && (
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
            className={`flex min-h-[44px] shrink-0 items-center gap-1 rounded border px-2 text-xs sm:min-h-0 sm:py-1 ${cold.active ? 'border-port-accent text-port-accent' : 'border-port-border text-port-text-muted'}`}
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
      {shot && !cold.active && (
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
        onPlay={(e) => {
          outro.stop();
          if (cold.claimsPlay(e.currentTarget)) return;
          cold.stop();
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        className="w-full"
      />
      {cold.audio}
    </div>
  );
}
