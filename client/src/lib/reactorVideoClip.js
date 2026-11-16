/**
 * Client re-export of reactor video clip limits and helpers: `REACTOR_MAX_PROMPT_LENGTH`,
 * the clip-length picker list and the canvas list.
 *
 * Re-export of `server/lib/reactorVideoClip.js` — `REACTOR_MAX_PROMPT_LENGTH` (800, counted in the
 * VideoGen prompt field before submit), the
 * picker list `REACTOR_CLIP_LENGTHS` + `REACTOR_DEFAULT_CLIP_LENGTH` + `reactorClipLengthLabel()`, and
 * the canvas list `REACTOR_CANVASES`.
 */

/**
 * Reactor clip/canvas/aspect contract the VideoGen form builds from.
 *
 * Re-export of `server/lib/reactorVideoClip.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/reactorVideoClip` import path in the client is unchanged.
 */
export { REACTOR_CANVASES, REACTOR_CLIP_LENGTHS, REACTOR_DEFAULT_CLIP_LENGTH, REACTOR_MAX_PROMPT_LENGTH, reactorClipLengthLabel } from '../../../server/lib/reactorVideoClip.js';
