// Client mirror of `server/lib/reactorVideoClip.js` — the reactor.inc fast-h3
// clip contract the VideoGen form has to respect BEFORE it submits: the 800
// character prompt cap (fast-h3 rejects a longer prompt outright, so the form
// counts characters rather than letting the render 400) and the clip lengths
// its picker offers. Enforced by the "client mirror" suite in
// `server/lib/reactorVideoClip.test.js`: if this drifts from the server file,
// that test fails. Update the SERVER file first, then this one.

/** Longest prompt fast-h3 accepts, in characters. */
export const REACTOR_MAX_PROMPT_LENGTH = 800;

/** Shortest clip fast-h3 accepts (124 frames at 24fps). */
export const REACTOR_MIN_CLIP_SECONDS = 5.167;

/** Longest clip fast-h3 accepts (345 frames at 24fps). */
export const REACTOR_MAX_CLIP_SECONDS = 14.375;

/**
 * Clip lengths the picker offers, ascending — the two exact endpoints plus
 * every whole second between them. fast-h3 accepts a continuous value in that
 * range, so a free-text seconds box mostly offered a way to type one it
 * refuses; whole seconds are frame-aligned at 24fps.
 */
export const REACTOR_CLIP_LENGTHS = Object.freeze([
  REACTOR_MIN_CLIP_SECONDS, 6, 7, 8, 9, 10, 11, 12, 13, 14, REACTOR_MAX_CLIP_SECONDS,
]);

/** Fallback when no clip length is chosen. */
export const REACTOR_DEFAULT_CLIP_LENGTH = 6;

/** Human label for one picker entry — the endpoints are odd enough to need naming. */
export const reactorClipLengthLabel = (seconds) => (
  seconds === REACTOR_MIN_CLIP_SECONDS ? `${seconds} seconds (min)`
    : seconds === REACTOR_MAX_CLIP_SECONDS ? `${seconds} seconds (max)`
      : `${seconds} seconds`
);

/**
 * The canvases fast-h3 renders. The aspect string is the whole choice — every
 * canvas holds a 768px short edge, so the pixel size falls out of it. Reactor
 * FITS a starting frame to the session canvas, so picking the canvas that
 * matches the image is what keeps a portrait photo from being squeezed into a
 * landscape session. Widest-first so the picker reads landscape → portrait.
 */
export const REACTOR_CANVASES = Object.freeze([
  Object.freeze({ aspect: '16:9', width: 1344, height: 768, label: 'Landscape 16:9 · 1344×768' }),
  Object.freeze({ aspect: '4:3', width: 1024, height: 768, label: 'Standard 4:3 · 1024×768' }),
  Object.freeze({ aspect: '1:1', width: 768, height: 768, label: 'Square 1:1 · 768×768' }),
  Object.freeze({ aspect: '9:16', width: 768, height: 1344, label: 'Portrait 9:16 · 768×1344' }),
]);

/** Just the aspect strings — the closed set `set_canvas` accepts. */
export const REACTOR_ASPECTS = Object.freeze(REACTOR_CANVASES.map((c) => c.aspect));

/** Canvas a text-only render (or an unreadable starting frame) falls back to. */
export const REACTOR_DEFAULT_ASPECT = '16:9';

/** Canvas record for an aspect string; the default canvas for anything else. */
export const reactorCanvas = (aspect) => (
  REACTOR_CANVASES.find((c) => c.aspect === aspect)
  || REACTOR_CANVASES.find((c) => c.aspect === REACTOR_DEFAULT_ASPECT)
);

/**
 * The fast-h3 canvas closest to a starting frame's own shape, compared in log
 * space so twice-as-wide and half-as-wide score the same distance. Ties keep
 * the earlier (wider) canvas; anything unmeasurable answers the default.
 */
export const nearestReactorAspect = (width, height) => {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return REACTOR_DEFAULT_ASPECT;
  const target = Math.log(w / h);
  let best = null;
  for (const canvas of REACTOR_CANVASES) {
    const distance = Math.abs(Math.log(canvas.width / canvas.height) - target);
    if (best === null || distance < best.distance) best = { aspect: canvas.aspect, distance };
  }
  return best.aspect;
};
