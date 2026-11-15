/**
 * Re-export of `server/lib/musicVideoAspect.js`: `musicVideoAspect`, `musicVideoFrameGenSize`,
 * `matchesMusicVideoAspect`.
 *
 * Used by `hooks/useMusicVideoSceneMedia.js` so board frames match the project aspect.
 */

/** Music Video frame aspect — re-export of `server/lib/musicVideoAspect.js` so the board requests frames at the same size as the production run. */
export { MUSIC_VIDEO_ASPECTS, matchesMusicVideoAspect, musicVideoAspect, musicVideoFrameGenSize } from '../../../server/lib/musicVideoAspect.js';
