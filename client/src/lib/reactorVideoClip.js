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
