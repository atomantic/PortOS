import { capturePreviewFrame } from '../../lib/musicVideoFrameCapture.js';
import { sceneVisualLayer } from '../../lib/musicVideoLayers.js';
import { sceneShotName } from '../../lib/musicVideoStages.js';
import { ANIMATIC_FPS, playedScene, shotAt, timedShots } from './animaticTiming.js';

function waitForExactDocumentFrame({ exactRef, audio, at }) {
  return new Promise((resolve) => {
    const deadline = performance.now() + 5000;
    const wait = () => {
      if (exactRef.current?.shownTime() === at) { resolve(exactRef.current.capture(at)); return; }
      if (performance.now() > deadline || !audio?.paused || audio.currentTime !== at) { resolve(null); return; }
      requestAnimationFrame(wait);
    };
    requestAnimationFrame(wait);
  });
}

function waitForPreviewSettle(figureRef) {
  // Pause swaps the live film look for its exact filter and catches the shot up
  // to the audio clock. Effects/clip seeks then get a paint before freezing.
  // The deadline only arms the error: a frame must still observe an unsettled
  // preview after it. Frames can arrive over a second apart on a loaded host
  // rasterizing the film look, so expiring between them would reject a
  // preview that settled in time (#16180). A hidden tab gets no frames at
  // all, so once the deadline has passed, hiding rejects on its own.
  return new Promise((resolve, reject) => {
    let handle;
    let clips = [];
    let expired = false;
    const finish = (error) => {
      clearTimeout(timer);
      cancelAnimationFrame(handle);
      document.removeEventListener('visibilitychange', hidden);
      if (error) reject(error);
      else resolve();
    };
    const unsettled = () => new Error(clips.some((video) => video.readyState < 2) ? 'Video frame is still loading' : 'Preview did not settle');
    const hidden = () => { if (expired && document.hidden) finish(unsettled()); };
    const timer = setTimeout(() => { expired = true; hidden(); }, 2000);
    document.addEventListener('visibilitychange', hidden);
    let paints = 0;
    const settle = () => {
      clips = [...(figureRef.current?.querySelectorAll('video[data-preview-video]') || [])]
        // The current clip stays transparent until decoded. Include it even
        // at metadata readiness so it cannot appear after serialization.
        .filter((video) => Number(getComputedStyle(video.parentElement).opacity) > 0
          || video.matches('[data-ready]:not([aria-hidden="true"])'));
      const failedClip = clips.find((video) => video.dataset.previewError);
      if (failedClip) { finish(new Error(failedClip.dataset.previewError)); return; }
      const current = clips.every((video) => !video.seeking && video.dataset.pausedFrame === String(video.currentTime));
      if (++paints >= 2 && current) { finish(); return; }
      if (expired && !current) { finish(unsettled()); return; }
      handle = requestAnimationFrame(settle);
    };
    handle = requestAnimationFrame(settle);
  });
}

function ensureClipReadyForCapture({ basis, figureRef, film, filmClips, layered, selected, playedSelected, at }) {
  const clipExpected = film
    ? !!selected && filmClips.has(selected.sceneId) && !(at >= selected.endSec)
    : !!playedSelected?.videoHistoryId && sceneVisualLayer(playedSelected, { layered }) === 'footage';
  if (basis.outro || !clipExpected) return;
  const figure = figureRef.current;
  const clip = figure?.querySelector('video[data-ready="true"]:not([aria-hidden="true"])');
  // A film shot has no still under its render to stand in for it.
  const fallback = film ? null : [...(figure?.querySelectorAll('img') || [])]
    .find((image) => image.getAttribute('src') === `/data/images/${playedSelected.referenceImageId}` && image.complete && image.naturalWidth > 0);
  if (!clip && !fallback) throw new Error('Video frame is still loading');
}

/**
 * Captures the current paused animatic frame as a PNG blob, waiting for video
 * seeks/film-look settle and compositing any lyric or steady title-card iframes.
 */
export async function captureAnimaticFrame({
  captureBasis, audioRef, figureRef, exactRef, outro, cold,
  documentVariant, film, filmClips, layered, scenes, fps, project,
  lyricsAvailable, lyricsOn, cardOnly, cardOverWords, lyricLayer, cardLayer, lyricLayerSteady,
  setTime, setPlaying, setTouched,
}) {
  const basis = captureBasis.current;
  const audio = audioRef.current;
  audio?.pause();
  outro.pause();
  const at = audio?.currentTime || 0;
  setTime(at);
  setPlaying(false);
  // The exact frame never shows over the cold open or the ending, so those save the native picture.
  if (documentVariant && !basis.outro && !cold.active) {
    setTouched(true);
    // The saved frame is the document's own. Fall back to the native picture
    // only when no isolated worker answers.
    const exact = await waitForExactDocumentFrame({ exactRef, audio, at });
    if (exact) {
      const selected = shotAt(scenes, at);
      const number = selected ? timedShots(scenes).indexOf(selected) + 1 : 0;
      return { blob: exact, time: at, fps: ANIMATIC_FPS, label: [project.name, selected ? sceneShotName(selected, number ? { number } : {}) : null].filter(Boolean).join(' · ') };
    }
  }
  await waitForPreviewSettle(figureRef);
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
  const playedSelected = playedScene(selected, project.scenes || []);
  ensureClipReadyForCapture({ basis, figureRef, film, filmClips, layered, selected, playedSelected, at });
  if (((lyricsAvailable && lyricsOn) || cardOnly) && !lyricLayer.overlay) throw new Error('Lyric frame unavailable');
  if (cardOverWords && !cardLayer.overlay) throw new Error('Title card frame unavailable');
  // A layer inside the film look is frozen with the picture and takes the look; a steady card's
  // layer sits outside it and is laid over the finished picture, as the preview shows it.
  const iframeImages = new Map();
  const over = [];
  for (const [layer, inLook] of [[lyricLayer, !lyricLayerSteady], [cardLayer, false]]) {
    const iframe = layer.frameRef.current;
    if (!iframe) continue;
    const png = await layer.capture(at);
    if (inLook) iframeImages.set(iframe, png);
    else over.push(png);
  }
  if (!unchanged()) throw new Error('Preview changed during capture');
  const blob = await capturePreviewFrame(figureRef.current?.firstElementChild, { iframeImages, over });
  if (!unchanged()) throw new Error('Preview changed during capture');
  const selectedIndex = selected ? timedShots(scenes).indexOf(selected) : -1;
  const shotLabel = basis.outro ? 'Ending' : selected ? sceneShotName(selected, selectedIndex >= 0 ? { number: selectedIndex + 1 } : {}) : null;
  return { blob, time: at, fps, label: [project.name, shotLabel].filter(Boolean).join(' · ') };
}
