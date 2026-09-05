/**
 * The reactor.inc `fast-h3` clip contract: what one enqueued clip may ask for.
 *
 * fast-h3 renders 24fps clips and its `enqueue` command accepts a CONTINUOUS
 * `seconds` value bounded to 5.167–14.375 (124–345 frames at 24fps — the same
 * bounds `scripts/reactor-render.py` re-checks before it opens a session). The
 * prompt is capped at 800 characters; a longer one is rejected by the API, not
 * truncated, so PortOS has to stop it at the form.
 *
 * Its own dependency-free module rather than living inside
 * `services/videoGen/reactor.js` for the `grokVideoClip.js` reason: the route
 * schema, the FableLoom prompt compiler and the VideoGen picker all need these
 * numbers, and hand-copied literals in a schema are how a schema and its
 * service drift apart — `routes/videoGen.js` already accepted 1–60 seconds for
 * a backend that rejects everything outside 5.167–14.375.
 *
 * `REACTOR_CLIP_LENGTHS` is a PICKER list, not an API constraint: because the
 * accepted range is continuous but does not start or end on a round number, a
 * free-text seconds box mostly offers the user a way to type a value the API
 * refuses. The list is the two exact endpoints plus every whole second between
 * them — whole seconds are frame-aligned at 24fps, so each entry is a real
 * frame count.
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
