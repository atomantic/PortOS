// Shared frame formats, renderer choices, and request bounds for Code Animation.

export const CODE_ANIMATION_ASPECT_RATIOS = Object.freeze({
  '16:9': { width: 16, height: 9 },
  '9:16': { width: 9, height: 16 },
  '1:1': { width: 1, height: 1 },
  '4:5': { width: 4, height: 5 },
  '4:3': { width: 4, height: 3 },
  '21:9': { width: 21, height: 9 },
});

// The SHORT side, in pixels. 1080p renders are the default; 720p keeps a heavy
// particle or oil-stroke style inside a real-time frame budget.
export const CODE_ANIMATION_RESOLUTIONS = Object.freeze({ '720p': 720, '1080p': 1080 });

export const CODE_ANIMATION_RENDERERS = Object.freeze(['auto', 'canvas2d', 'webgl', 'svg', 'three']);

export const CODE_ANIMATION_LIMITS = Object.freeze({
  durationMin: 3,
  durationMax: 180,
  fpsOptions: [24, 30, 60],
  titleMax: 200,
  seedIdeaMax: 2_000,
  conceptMax: 6_000,
  castMax: 4_000,
  textMax: 4_000,
  styleNotesMax: 2_000,
  referenceImagesMax: 8,
  // A reference video becomes a contact sheet plus two keyframes.
  referenceVideoImageSlots: 3,
  referenceNoteMax: 300,
  audioNotesMax: 1_500,
  // The forked animation's HTML rides the extend prompt whole; a larger file is refused, never cut.
  baseHtmlMax: 400_000,
});
