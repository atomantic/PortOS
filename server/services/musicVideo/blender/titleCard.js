/**
 * The project's title card (lib/musicVideoTitleCard.js) on a Blender film.
 *
 * A Blender film has no page for the card's runtime to ride on: its picture is
 * shot videos joined by ffmpeg. So the card is captured the way a composed
 * render captures it (compositionRender.js: the same runtime, drawn on a
 * transparent page, one alpha clip per window it shows in) and laid over the
 * joined picture, after the grade and the shots' timed effects.
 *
 * A film look pass over that picture would weave, flicker and grain a card
 * baked into it, which is right for a card that sits in the film and wrong for
 * a steady one. `blenderTitleCardPlan` settles, once per assembly, whether the
 * join bakes the card or leaves it for the pass to draw over the look.
 */
import { normalizeTitleCard, titleCardSteady, titleCardWindows } from '../../../lib/musicVideoTitleCard.js';

/** The card's windows that reach into `[startSec, endSec)` of the film (song seconds). Pure. */
function blenderTitleCardWindows(project, { startSec = 0, endSec }) {
  return titleCardWindows(normalizeTitleCard(project?.titleCard)).filter((window) => window.startSec < endSec && window.endSec > startSec);
}

/**
 * Where an assembly's card is drawn. `lookPass` says a film look pass will
 * follow the join; `filmEndSec` is the film's length. Resolves
 * `{ bake, pass }`: `bake` is whether the join lays the card over the shots
 * (withBlenderTitleCard), and `pass` is what applyFilmLookFinish takes to draw
 * it instead (empty when the join bakes it). A steady card rides the pass
 * whenever there is one; any other card, and every card without a pass, is
 * baked. Pure.
 */
export function blenderTitleCardPlan(project, { lookPass, filmEndSec }) {
  const card = normalizeTitleCard(project?.titleCard);
  if (!lookPass || !titleCardSteady(card)) return { bake: true, pass: {} };
  // The pass also covers an ending joined after the song; the card stops where a baked one would.
  return { bake: false, pass: { titleCard: card, titleCardUntilSec: filmEndSec } };
}

/**
 * Run `work(overlays)` with the card captured for the window `[startSec, endSec)`
 * of a film `filmEndSec` long: `[{ path, startSec, durationSec }]`, each
 * `startSec` counted from the window's first frame. A project without a card
 * there, or one whose card the film look pass draws (`bake: false`), costs
 * nothing: `work([])` runs at once and no browser opens. The captures are
 * removed when `work` settles.
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
      window: { startFrame: Math.round(startSec * fps), endFrame: Math.round(endSec * fps) }, signal, onProgress,
    });
    return await work(captured.map((overlay) => ({ path: overlay.path, startSec: overlay.startSec - startSec, durationSec: overlay.durationSec })));
  } finally {
    await removeCompositionScratch(captureId).catch(() => {});
  }
}
