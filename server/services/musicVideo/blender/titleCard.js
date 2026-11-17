/**
 * The project's title card (lib/musicVideoTitleCard.js) on a Blender film: no page
 * carries the card's runtime, so it is captured as in compositionRender.js (alpha
 * clip per window) and laid over the joined picture after the grade and timed
 * effects. A film look pass would weave and grain a baked card, wrong for a steady
 * one, so `blenderTitleCardPlan` settles per assembly whether the join bakes it.
 */
import { normalizeTitleCard, titleCardSteady, titleCardWindows } from '../../../lib/musicVideoTitleCard.js';

/** The card's windows that reach into `[startSec, endSec)` of the film (song seconds). Pure. */
function blenderTitleCardWindows(project, { startSec = 0, endSec }) {
  return titleCardWindows(normalizeTitleCard(project?.titleCard)).filter((window) => window.startSec < endSec && window.endSec > startSec);
}

/**
 * Where an assembly's card is drawn: `{ bake, pass }`. `bake` is whether the join
 * lays the card over the shots (withBlenderTitleCard); `pass` is what
 * applyFilmLookFinish takes to draw it instead. A steady card rides the film look
 * pass when there is one; every other card is baked. Pure.
 */
export function blenderTitleCardPlan(project, { lookPass, filmEndSec }) {
  const card = normalizeTitleCard(project?.titleCard);
  if (!lookPass || !titleCardSteady(card)) return { bake: true, pass: {} };
  // The pass also covers an ending joined after the song; the card stops where a baked one would.
  return { bake: false, pass: { titleCard: card, titleCardUntilSec: filmEndSec } };
}

/**
 * Run `work(overlays)` with the card captured for `[startSec, endSec)` of a film
 * `filmEndSec` long: `[{ path, startSec, durationSec }]`, `startSec` counted from
 * the window's first frame. With no card there, or `bake: false`, `work([])` runs
 * at once and no browser opens. Captures are removed when `work` settles.
 */
export async function withBlenderTitleCard({ project, jobId, width, height, fps, startSec = 0, endSec, filmEndSec = endSec, bake = true, signal, onProgress }, work) {
  if (!bake || !blenderTitleCardWindows(project, { startSec, endSec }).length) return work([]);
  // The capture drags in the composition browser; only a film with a card pays for it.
  const [{ titleCardOverlayCues }, { removeCompositionScratch, renderTypographyOverlays }] = await Promise.all([
    import('../composition.js'), import('../compositionRender.js'),
  ]);
  const captureId = `blender-title-${jobId}`;
  try {
    const captured = await renderTypographyOverlays({
      jobId: captureId, cues: titleCardOverlayCues(project, filmEndSec), style: {}, width, height, fps, durationSec: filmEndSec,
      // A lead-in window starts below song frame 0; placement still subtracts the
      // original start so the card lands after the lead-in.
      window: { startFrame: Math.max(0, Math.round(startSec * fps)), endFrame: Math.round(endSec * fps) }, signal, onProgress,
    });
    return await work(captured.map((overlay) => ({ path: overlay.path, startSec: overlay.startSec - startSec, durationSec: overlay.durationSec })));
  } finally {
    await removeCompositionScratch(captureId).catch(() => {});
  }
}
