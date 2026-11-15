/**
 * Re-export of `server/lib/grokVideoClip.js` — `GROK_VIDEO_DURATIONS` (`[6, 10, 15]`) +
 * `GROK_VIDEO_DEFAULT_DURATION`, the clip lengths grok's `image_to_video` actually delivers.
 */

/**
 * The clip lengths grok’s image_to_video actually delivers.
 *
 * Re-export of `server/lib/grokVideoClip.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/grokVideoClip` import path in the client is unchanged.
 */
export { GROK_VIDEO_DEFAULT_DURATION, GROK_VIDEO_DURATIONS } from '../../../server/lib/grokVideoClip.js';
