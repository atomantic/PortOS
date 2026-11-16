/**
 * Re-export of `server/lib/videoResolution.js` — `isLowResVideo({
 * width, height })`, the 720p floor the media card, lightbox and shot card flag a clip against.
 */

/** Re-export of `server/lib/videoResolution.js`, the one 720p low-res rule. */
export { isLowResVideo } from '../../../server/lib/videoResolution.js';
