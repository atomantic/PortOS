// Display helpers shared by the Storyboards index, editor and panel drawer.

const enc = encodeURIComponent;

export const selectedTake = (panel) => panel?.takes?.find((take) => take.id === panel.selectedTakeId) || null;

// Staged render inputs (a correction's marked-up frame) live in image-refs.
const STAGED_REF = /^ref-[0-9a-f-]{36}\.png$/;

// A sketch's flattened PNG is served by the media sketch service; `nonce`
// busts the browser cache after a save (bumped on `media:sketch:updated`).
export function takeSrc(take, nonce = 0) {
  if (take?.sketchKey) return `/api/media/sketches/${enc(take.sketchKey)}/png?v=${nonce}`;
  if (take?.image && STAGED_REF.test(take.image)) return `/data/image-refs/${enc(take.image)}`;
  if (take?.image) return `/data/images/${enc(take.image)}`;
  return null;
}

export const ASPECT_CLASS = Object.freeze({
  '16:9': 'aspect-video',
  '9:16': 'aspect-[9/16]',
  '1:1': 'aspect-square',
  '4:5': 'aspect-[4/5]',
  '2.39:1': 'aspect-[239/100]',
});

export const aspectClass = (ratio) => ASPECT_CLASS[ratio] || ASPECT_CLASS['16:9'];

// Panel seconds are hundredths (the sanitizer rounds them).
export const formatPanelSeconds = (sec) => (Number.isFinite(sec) && sec > 0 ? `${sec.toFixed(2)}s` : null);

export const beatSeconds = (beat) => (beat?.panels || []).reduce((sum, panel) => sum + (panel.seconds || 0), 0);

export { STORYBOARD_MUSICAL_ROLE_LABELS as MUSICAL_ROLE_LABELS } from '../../../../server/lib/storyboardVocabulary.js';

/** Find a panel and its beat by id, or null. */
export function findPanel(board, panelId) {
  for (const [beatIndex, beat] of (board?.beats || []).entries()) {
    const index = beat.panels.findIndex((panel) => panel.id === panelId);
    if (index >= 0) return { beat, beatIndex, panel: beat.panels[index], index };
  }
  return null;
}
