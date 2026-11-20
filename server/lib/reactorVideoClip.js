/**
 * The reactor.inc `fast-h3` clip contract: what one enqueued clip may ask for.
 *
 * fast-h3 renders 24fps clips and `enqueue` accepts a CONTINUOUS `seconds` bounded to 5.167–14.375 (124–345 frames; `scripts/ml/reactor-render.py` re-checks them), with the prompt capped at 800 characters (rejected by the API, not truncated, so the form must stop it). Its own dependency-free module (the `grokVideoClip.js` reason) because the route schema, the FableLoom prompt compiler and the VideoGen picker all need these numbers (`routes/videoGen.js` once accepted 1–60 seconds for a backend rejecting everything outside the range). `REACTOR_CLIP_LENGTHS` is a PICKER list, not an API constraint: a free-text seconds box mostly invites values the API refuses, so it is the two exact endpoints plus every whole second between (frame-aligned at 24fps, each a real frame count).
 */

/** Longest prompt fast-h3 accepts, in characters. */
export const REACTOR_MAX_PROMPT_LENGTH = 800;

/** Frame rate fast-h3 delivers; the seconds bounds below are frame counts over it. */
export const REACTOR_CLIP_FPS = 24;

/** Shortest clip fast-h3 accepts (124 frames). */
export const REACTOR_MIN_CLIP_SECONDS = 5.167;

/** Longest clip fast-h3 accepts (345 frames). */
export const REACTOR_MAX_CLIP_SECONDS = 14.375;

/** Clip lengths the VideoGen picker offers, ascending. See the module note. */
export const REACTOR_CLIP_LENGTHS = Object.freeze([
  REACTOR_MIN_CLIP_SECONDS, 6, 7, 8, 9, 10, 11, 12, 13, 14, REACTOR_MAX_CLIP_SECONDS,
]);

/** Fallback when a caller omits a clip length. */
export const REACTOR_DEFAULT_CLIP_LENGTH = 6;

/** Longest `continue_from_clip_id` PortOS will forward, in characters. */
export const REACTOR_MAX_CLIP_ID_LENGTH = 200;

/** Human label for one picker entry — the endpoints are odd enough to need naming. */
export const reactorClipLengthLabel = (seconds) => (
  seconds === REACTOR_MIN_CLIP_SECONDS ? `${seconds} seconds (min)`
    : seconds === REACTOR_MAX_CLIP_SECONDS ? `${seconds} seconds (max)`
      : `${seconds} seconds`
);

/**
 * The canvases fast-h3 renders, in `set_canvas`'s `aspect` vocabulary, each with a 768px SHORT edge (the model's native resolution), so the aspect string is the whole choice. PortOS pinned `16:9` before #6336, so a portrait starting frame came back as a clip with audio and no usable picture
 * (reactor fits the frame to the SESSION canvas; a 9:16 photo squeezed into 1344×768 left almost nothing to animate). Ordered widest-first so a picker reads landscape → square → portrait.
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

/** The fast-h3 canvas closest to a starting frame's shape, compared in log space ("twice as wide" and "half as wide" score alike); ties keep the earlier (wider) canvas; anything unmeasurable (missing dimension, zero, NaN) answers the default. */
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
