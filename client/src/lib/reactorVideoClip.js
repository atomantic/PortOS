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
