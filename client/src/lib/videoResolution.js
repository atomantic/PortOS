/**
 * Re-export of `server/lib/videoResolution.js` — `LOW_RES_VIDEO_SHORT_SIDE` (720) and `isLowResVideo({
 * width, height })`, the 720p floor the media card, lightbox and shot card flag a clip against.
 */

/** Re-export of `server/lib/videoResolution.js`, the one 720p low-res rule. */
export { LOW_RES_VIDEO_SHORT_SIDE, isLowResVideo } from '../../../server/lib/videoResolution.js';
