/**
 * The project's title card (lib/musicVideoTitleCard.js) on a Blender film.
 *
 * A Blender film has no page for the card's runtime to ride on: its picture is
 * shot videos joined by ffmpeg. So the card is captured the way a composed
 * render captures it (compositionRender.js: the same runtime, drawn on a
 * transparent page, one alpha clip per window it shows in) and laid over the
 * joined picture, under the film look pass that follows.
 */
import { normalizeTitleCard, titleCardWindows } from '../../../lib/musicVideoTitleCard.js';

/** The card's windows that reach into `[startSec, endSec)` of the film (song seconds). Pure. */
export function blenderTitleCardWindows(project, { startSec = 0, endSec }) {
  return titleCardWindows(normalizeTitleCard(project?.titleCard)).filter((window) => window.startSec < endSec && window.endSec > startSec);
}

/**
 * Run `work(overlays)` with the card captured for the window `[startSec, endSec)`
 * of a film `filmEndSec` long: `[{ path, startSec, durationSec }]`, each
 * `startSec` counted from the window's first frame. A project without a card
 * there costs nothing: `work([])` runs at once and no browser opens. The
 * captures are removed when `work` settles.
 */
export async function withBlenderTitleCard({ project, jobId, width, height, fps, startSec = 0, endSec, filmEndSec = endSec, signal, onProgress }, work) {
  if (!blenderTitleCardWindows(project, { startSec, endSec }).length) return work([]);
  // The capture drags in the composition browser; only a film with a card pays for it.
  const [{ titleCardOverlayCues }, { removeCompositionScratch, renderTypographyOverlays }] = await Promise.all([
    import('../composition.js'), import('../compositionRender.js'),
  ]);
  const captureId = `blender-title-${jobId}`;
  try {
    const captured = await renderTypographyOverlays({
      jobId: captureId, cues: titleCardOverlayCues(project, filmEndSec), style: {}, width, height, fps, durationSec: filmEndSec,
      window: { startFrame: Math.round(startSec * fps), endFrame: Math.round(endSec * fps) }, signal, onProgress,
    });
    return await work(captured.map((overlay) => ({ path: overlay.path, startSec: overlay.startSec - startSec, durationSec: overlay.durationSec })));
  } finally {
    await removeCompositionScratch(captureId).catch(() => {});
  }
}
