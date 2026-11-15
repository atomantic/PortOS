/**
 * Client re-export of reactor video clip limits and helpers: `REACTOR_MAX_PROMPT_LENGTH`,
 * `REACTOR_MIN_CLIP_SECONDS` and `REACTOR_MAX_CLIP_SECONDS`.
 *
 * Re-export of `server/lib/reactorVideoClip.js` — `REACTOR_MAX_PROMPT_LENGTH` (800, counted in the
 * VideoGen prompt field before submit), `REACTOR_MIN_CLIP_SECONDS` / `REACTOR_MAX_CLIP_SECONDS`, the
 * picker list `REACTOR_CLIP_LENGTHS` + `REACTOR_DEFAULT_CLIP_LENGTH` + `reactorClipLengthLabel()`, and
 * the canvas contract `REACTOR_CANVASES` / `REACTOR_ASPECTS` / `REACTOR_DEFAULT_ASPECT` /
 * `reactorCanvas()` / `nearestReactorAspect()`.
 */

/**
 * Reactor clip/canvas/aspect contract the VideoGen form builds from.
 *
 * Re-export of `server/lib/reactorVideoClip.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/reactorVideoClip` import path in the client is unchanged.
 */
export {
  REACTOR_ASPECTS,
  REACTOR_CANVASES,
  REACTOR_CLIP_LENGTHS,
  REACTOR_DEFAULT_ASPECT,
  REACTOR_DEFAULT_CLIP_LENGTH,
  REACTOR_MAX_CLIP_SECONDS,
  REACTOR_MAX_PROMPT_LENGTH,
  REACTOR_MIN_CLIP_SECONDS,
  nearestReactorAspect,
  reactorCanvas,
  reactorClipLengthLabel,
} from '../../../server/lib/reactorVideoClip.js';
